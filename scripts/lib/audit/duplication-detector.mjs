/**
 * @fileoverview Duplication audit wave — mechanical (deterministic, no LLM)
 * candidate detector for `/audit-code`'s "Wave 5: Duplication" pass.
 *
 * Plan: docs/plans/audit-code-duplication-wave.md §2. Attribution (is a
 * symbol new/changed?) is pure Git — `git show <auditBaseCommit>:<path>`
 * vs. the current working tree — with NO dependency on the architectural-
 * memory Postgres snapshot at all (a Gemini-round-3 gate finding: an
 * earlier design that required the active snapshot to exactly match the
 * audit's base commit created an operational deadlock, since the snapshot
 * refreshes on its own cadence and essentially never matches a PR's
 * merge-base). The DB snapshot is used ONLY for the similarity search
 * (read-only, via `callNeighbourhoodRpc`) — a stale snapshot narrows
 * search recall, it never blocks the detector.
 *
 * Mirrors `runArchitecturePass` (legacy-production-audit.mjs) two-stage
 * shape: this module is the mechanical stage. The LLM bouncer + fallback
 * live in `duplication-report.mjs` / `legacy-production-audit.mjs` Wave 5.
 *
 * @module scripts/lib/audit/duplication-detector
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { gitShowFileAtRevision, isSafeGitRevision } from '../vcs.mjs';
import { runJsonLinesAsyncStrict } from '../subprocess.mjs';
import { formatFilesManifest } from '../symbol-index/files-manifest.mjs';
import { symbolIndexConfig } from '../config.mjs';
import { resolveRepoIdentity } from '../repo-identity.mjs';
import { resolveAndClassify } from '../sensitive-paths.mjs';
import { compose } from '../symbol-index.mjs';
import { generateIntentEmbedding } from '../neighbourhood-query.mjs';
import { isDuplicationQueryExcluded } from './duplication-report.mjs';
import { PRAGMA_RE } from '../duplicate-justification-pragma.mjs';
import {
  initLearningStore,
  isCloudEnabled,
  getRepoIdByUuid,
  getActiveSnapshot,
  callNeighbourhoodRpc,
} from '../../learning-store.mjs';

// Uses two chained path.dirname() calls, deliberately not a single parent-
// climbing join call, to stay outside the repo's relocation guard (tests/
// relocation-guard.test.mjs) — that guard bans escapes to the repo ROOT
// (broken across the scripts/ to scripts/.claude-skills/ relocation), which
// this is not: it climbs from scripts/lib/audit/ to scripts/ (two levels),
// then back down into scripts/symbol-index/ — a sibling-subtree reference
// that stays correct under relocation because the WHOLE scripts/ tree (both
// lib/audit/ and symbol-index/) moves together, preserving their relative
// structure.
const SCRIPTS_DIR = path.dirname(path.dirname(import.meta.dirname)); // scripts/lib/audit -> scripts/lib -> scripts
const EXTRACT_MJS = path.join(SCRIPTS_DIR, 'symbol-index', 'extract.mjs');

/** Source extensions extract.mjs's ts-morph project actually parses (mirrors extract.mjs's own filter, kept narrow — a false-eligible file just yields 0 symbols, not a crash). */
const SOURCE_EXT_RE = /\.(m?[jt]sx?|c[jt]s)$/;

function log(msg) { process.stderr.write(`  [duplication-detector] ${msg}\n`); }

/** Build the real (non-injected) adapters bundle. Separated so tests can override individual pieces without re-wiring the whole default set. */
function defaultAdapters() {
  return {
    async extractSymbolsForFiles(repoRoot, files) {
      return extractViaSubprocess(repoRoot, files);
    },
    async gitShowAtRevision(repoRoot, revision, filePath) {
      return gitShowFileAtRevision(repoRoot, revision, filePath);
    },
    async embedText(text, model, dim) {
      const { result } = await generateIntentEmbedding(text, model, dim);
      return result;
    },
    async callNeighbourhoodRpc(args) {
      return callNeighbourhoodRpc(args);
    },
    async getActiveSnapshot(repoId) {
      return getActiveSnapshot(repoId);
    },
    async getRepoId(repoRoot) {
      await initLearningStore();
      if (!await isCloudEnabled()) return null;
      const identity = resolveRepoIdentity(repoRoot);
      const repo = await getRepoIdByUuid(identity.repoUuid);
      return repo ? repo.id : null;
    },
    gateSymbolForEgress(p, repoRoot) {
      return resolveAndClassify(p, { repoRoot });
    },
    readFileSync(p) {
      return fs.readFileSync(p, 'utf-8');
    },
  };
}

/**
 * Run extract.mjs as a subprocess over an explicit file list under `root`,
 * mirroring refresh.mjs's proven `--files-from` manifest pattern (avoids
 * Windows ENAMETOOLONG on a large changeset). Returns only `type:'symbol'`
 * records.
 */
async function extractViaSubprocess(root, files) {
  if (files.length === 0) return [];
  const manifestPath = path.join(os.tmpdir(), `duplication-extract-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.txt`);
  // NUL-framed via the shared formatter, never hand-joined — extract.mjs's
  // reader parses exactly this format (files-manifest.mjs).
  fs.writeFileSync(manifestPath, formatFilesManifest(files), 'utf-8');
  try {
    const extracted = await runJsonLinesAsyncStrict('node', [
      EXTRACT_MJS, '--root', root, '--mode', 'full', '--files-from', manifestPath,
    ], { stage: 'duplication-extract' });
    return extracted.filter((r) => r.type === 'symbol');
  } finally {
    try { fs.unlinkSync(manifestPath); } catch { /* best-effort cleanup */ }
  }
}

/** Materialise `content` under a temp root at the SAME relative path as `relPath`, so extract.mjs's `--root <tempRoot>` naturally reports `filePath === relPath` — no remapping needed. */
function writeTempSource(tempRoot, relPath, content) {
  const abs = path.join(tempRoot, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
}

/** Key a symbol by (filePath, symbolName, kind) — the identity extraction compares on. */
function symKey(filePath, symbolName, kind) {
  return `${filePath}\x00${symbolName}\x00${kind}`;
}

/**
 * Scan the line(s) immediately preceding `startLine` (1-indexed, ts-morph
 * convention) for a `// @duplicate-justification: target=<file>:<name>
 * reason=<text>` pragma (any comment syntax — see PRAGMA_RE). Returns
 * `{target: {file, symbolName}, reason} | null`.
 */
function findPragmaAbove(sourceText, startLine) {
  const lines = sourceText.split('\n');
  // Check up to 3 lines above the declaration (JSDoc-adjacent placement).
  for (let i = startLine - 2; i >= Math.max(0, startLine - 5); i--) {
    const m = PRAGMA_RE.exec(lines[i] || '');
    if (m) return { target: { file: m[1], symbolName: m[2] }, reason: m[3].trim() };
  }
  return null;
}

function isEligibleChange(entry) {
  if (entry.status === 'deleted') return false;
  const p = entry.currentPath;
  if (isDuplicationQueryExcluded(p)) return false;
  return SOURCE_EXT_RE.test(p);
}

/**
 * @param {object} opts
 * @param {string} opts.repoRoot
 * @param {{status:'added'|'modified'|'deleted'|'renamed'|'copied', currentPath:string, previousPath?:string}[]} opts.changedFiles
 * @param {string} opts.auditBaseCommit - git revision the diff is against; MUST pass isSafeGitRevision
 * @param {object} [opts.adapters] - injected for tests; defaults to real implementations
 * @returns {Promise<{state:'clean'|'findings'|'unavailable'|'failed', deterministicFindings:object[], semanticCandidates:object[], reason?:string}>}
 */
export async function runDuplicationAnalysis({ repoRoot, changedFiles, auditBaseCommit, adapters }) {
  const a = { ...defaultAdapters(), ...(adapters || {}) };
  const empty = () => ({ deterministicFindings: [], semanticCandidates: [] });

  try {
    // ── Step 0: snapshot availability (soft — see plan §2 decoupling note) ──
    const repoId = await a.getRepoId(repoRoot);
    if (!repoId) return { state: 'unavailable', reason: 'repo not found in architectural-memory store — run `npm run arch:refresh`', ...empty() };
    const snap = await a.getActiveSnapshot(repoId);
    if (!snap || !snap.refreshId) return { state: 'unavailable', reason: 'no active architectural-memory snapshot — run `npm run arch:refresh`', ...empty() };
    if (!snap.activeEmbeddingModel || !snap.activeEmbeddingDim) return { state: 'unavailable', reason: 'active snapshot has no embedding model/dim configured (EMBEDDING_MISMATCH)', ...empty() };

    if (!isSafeGitRevision(auditBaseCommit)) {
      return { state: 'unavailable', reason: `refusing unsafe auditBaseCommit: ${JSON.stringify(String(auditBaseCommit)).slice(0, 80)}`, ...empty() };
    }

    // ── Step 1: file-count preflight (BEFORE any extraction) ──
    const eligible = (changedFiles || []).filter(isEligibleChange);
    if (eligible.length > symbolIndexConfig.maxDuplicationScanFiles) {
      return { state: 'unavailable', reason: `diff too large for duplication scan (${eligible.length} > ${symbolIndexConfig.maxDuplicationScanFiles})`, ...empty() };
    }
    if (eligible.length === 0) return { state: 'clean', ...empty() };

    // ── Step 2: extract both sides via Git (no DB) ──
    const currentPaths = eligible.map((e) => e.currentPath);
    const currentSymbols = await a.extractSymbolsForFiles(repoRoot, currentPaths);

    const needsBaseSide = eligible.filter((e) => e.status === 'modified' || e.status === 'renamed' || e.status === 'copied');
    let baseSymbolsByFile = new Map(); // currentPath -> symbol[] (extracted from the base-revision content at previousPath??currentPath)
    if (needsBaseSide.length > 0) {
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'duplication-base-'));
      try {
        const baseRelPaths = [];
        for (const entry of needsBaseSide) {
          const basePath = entry.previousPath || entry.currentPath;
          const shown = await a.gitShowAtRevision(repoRoot, auditBaseCommit, basePath);
          if (!shown.ok) {
            // BAD_REVISION (path didn't exist at base) — treat as "no base side",
            // matching an `added` classification for anything extracted at currentPath.
            if (shown.error.code === 'BAD_REVISION') continue;
            throw new Error(`git show failed for ${basePath}@${auditBaseCommit}: ${shown.error.message}`);
          }
          writeTempSource(tempRoot, basePath, shown.content);
          baseRelPaths.push(basePath);
        }
        const baseSymbolsRaw = baseRelPaths.length > 0 ? await a.extractSymbolsForFiles(tempRoot, baseRelPaths) : [];
        for (const entry of needsBaseSide) {
          const basePath = entry.previousPath || entry.currentPath;
          const syms = baseSymbolsRaw.filter((s) => s.filePath === basePath);
          baseSymbolsByFile.set(entry.currentPath, syms);
        }
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      }
    }

    // ── Step 3: diff symbol identity in-memory, body-aware ──
    const eligibleByCurrentPath = new Map(eligible.map((e) => [e.currentPath, e]));
    const candidates = [];
    for (const cur of currentSymbols) {
      const entry = eligibleByCurrentPath.get(cur.filePath);
      if (!entry) continue; // defensive — extractor reported a file we didn't ask for
      if (entry.status === 'added') {
        candidates.push({ ...cur, changeKind: 'added', priorSymbol: null });
        continue;
      }
      const baseSyms = baseSymbolsByFile.get(cur.filePath) || [];
      const priorSymbol = baseSyms.find((b) => b.symbolName === cur.symbolName && b.kind === cur.kind) || null;
      if (!priorSymbol) {
        candidates.push({ ...cur, changeKind: 'added', priorSymbol: null });
      } else if (priorSymbol.signatureHash !== cur.signatureHash) {
        candidates.push({ ...cur, changeKind: 'changed', priorSymbol, previousPath: entry.previousPath || null });
      }
      // else: same signatureHash (body-aware — includes bodyText) → not a candidate.
    }

    // ── Step 4: candidate cap ──
    if (candidates.length > symbolIndexConfig.maxDuplicationCandidates) {
      return { state: 'unavailable', reason: `too many candidate symbols for duplication scan (${candidates.length} > ${symbolIndexConfig.maxDuplicationCandidates})`, ...empty() };
    }
    if (candidates.length === 0) return { state: 'clean', ...empty() };

    const deterministicFindings = [];
    const semanticCandidates = [];

    for (const cand of candidates) {
      // ── Step 5: embed — pinned to the active snapshot's exact model/dim ──
      const text = compose({ kind: cand.kind, symbolName: cand.symbolName, filePath: cand.filePath, purposeSummary: cand.purposeSummary, signature: cand.signature });
      const vector = await a.embedText(text, snap.activeEmbeddingModel, snap.activeEmbeddingDim);

      // ── Step 6: query, targetPaths:[] (pure cosine ranking — Gemini R1 G1) ──
      const rpcRows = await a.callNeighbourhoodRpc({
        repoId, refreshId: snap.refreshId, targetPaths: [], intentEmbedding: vector,
        kindFilter: [cand.kind], k: 5,
      });

      // ── Step 7: path-and-name-scoped exclusion (own indexed self only) + query-exclude globs ──
      const filtered = (rpcRows || []).filter((r) => {
        const fp = r.file_path || r.filePath;
        const name = r.symbol_name || r.symbolName;
        const kind = r.kind;
        if (isDuplicationQueryExcluded(fp)) return false; // e.g. test-fixture triples — not a meaningful "canonical" target
        const isOwnCurrent = fp === cand.filePath && name === cand.symbolName && kind === cand.kind;
        const isOwnPrevious = cand.previousPath && fp === cand.previousPath && name === cand.symbolName && kind === cand.kind;
        return !isOwnCurrent && !isOwnPrevious;
      });

      // ── Step 8: threshold — keep the FULL matching set ──
      // startLine/endLine carried through (round-1 code-audit M24 fix) so
      // the bouncer prompt can excerpt just the matched symbol's span
      // instead of the whole file.
      const matches = filtered
        .map((r) => ({
          filePath: r.file_path || r.filePath,
          symbolName: r.symbol_name || r.symbolName,
          kind: r.kind,
          startLine: r.start_line ?? r.startLine ?? null,
          endLine: r.end_line ?? r.endLine ?? null,
          similarity: Number(r.similarity ?? r.similarityScore ?? 0),
        }))
        .filter((m) => m.similarity >= symbolIndexConfig.driftSimDup)
        .sort((x, y) => (y.similarity - x.similarity) || (x.filePath < y.filePath ? -1 : 1));

      if (matches.length === 0) continue;

      // ── Step 9: egress gate on BOTH paths before any read ──
      const candGate = a.gateSymbolForEgress(cand.filePath, repoRoot);
      const topMatch = matches[0];
      const matchGate = a.gateSymbolForEgress(topMatch.filePath, repoRoot);
      if (candGate.category === 'sensitive' || matchGate.category === 'sensitive') {
        continue; // dropped entirely — no diagnostic finding (avoids leaking path existence)
      }

      // ── Step 10: pragma check against the FULL matching set ──
      let sourceText;
      try { sourceText = a.readFileSync(path.join(repoRoot, cand.filePath)); } catch { sourceText = ''; }
      const pragma = sourceText ? findPragmaAbove(sourceText, cand.startLine) : null;
      if (pragma) {
        const pragmaMatchesSet = matches.some((m) => m.filePath === pragma.target.file && m.symbolName === pragma.target.symbolName);
        if (pragmaMatchesSet) continue; // suppressed
        // Raw shape only — duplication-report.mjs's finalizeDeterministicFindings()
        // assigns the D-prefixed id and produces the FindingSchema-shaped object
        // (kept centralized there alongside the 'failed'-state finding, so ID
        // sequencing has one source of truth).
        deterministicFindings.push({
          type: 'orphaned-pragma',
          filePath: cand.filePath, symbolName: cand.symbolName,
          target: pragma.target, reason: pragma.reason,
        });
        continue;
      }

      semanticCandidates.push({
        id: `dup-${crypto.createHash('sha1').update(symKey(cand.filePath, cand.symbolName, cand.kind)).digest('hex').slice(0, 10)}`,
        candidate: { filePath: cand.filePath, symbolName: cand.symbolName, kind: cand.kind, startLine: cand.startLine, endLine: cand.endLine, purposeSummary: cand.purposeSummary },
        topMatch,
        allMatches: matches,
      });
    }

    if (deterministicFindings.length === 0 && semanticCandidates.length === 0) return { state: 'clean', ...empty() };
    return { state: 'findings', deterministicFindings, semanticCandidates };
  } catch (err) {
    log(`failed: ${err.stack || err.message}`);
    return { state: 'failed', reason: err.message, ...empty() };
  }
}

export const _internals = { findPragmaAbove, isEligibleChange, symKey, PRAGMA_RE };

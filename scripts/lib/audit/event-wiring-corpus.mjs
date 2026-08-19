/**
 * @fileoverview Orchestration-side corpus builder + config loader + the
 * Wave-1.5c production entry point for the event-wiring-symmetry detector.
 * Impure by design — this is the seam that keeps event-wiring.mjs pure.
 *
 * Design: docs/plans/event-wiring-symmetry.md §2 (D2d, D11, D12).
 *
 * @module scripts/lib/audit/event-wiring-corpus
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import {
  extractEventSites, diffSites, resolveSymmetry, lookupEventStatus, EXTRACTOR_VERSION,
} from './event-wiring.mjs';
import { isTestFile, isDocExampleFile, PATH_CLASSIFIER_VERSION } from './path-classifiers.mjs';
import { resolveAndClassify } from '../sensitive-paths.mjs';
import { listOpenLifecycle, readLifecycle, reconcileLifecycle } from '../ledger.mjs';
// Cluster-B audit-code R1/M15 fix (GPT deliberation, "compromise" ruling):
// listOpenLifecycle/reconcileLifecycle were imported LAZILY (inside
// detectEventWiringAsymmetry) while this file was Cluster A/Phase 0 and the
// D12 lifecycle host in ledger.mjs didn't exist yet — deferred import timing
// standing in for a real dependency-cycle boundary that was never actually
// at risk (ledger.mjs has no audit/ import of its own; verified no cycle).
// Both clusters now ship in the same commit, so the sequencing rationale has
// expired — a static import describes the real dependency and fails at
// module load if the export is ever missing, instead of mid-run.

// Cluster-B audit-code R2/M2 fix: `.jsx` was missing — a React app's JSX
// components (exactly the shape of the wine-oracle fixture's own source
// tree) were silently excluded from corpus selection entirely.
const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.html', '.template']);
const PER_FILE_BYTE_CAP = 1 * 1024 * 1024; // 1 MiB, matches this repo's spawnSync maxBuffer convention
const DEFAULT_TOTAL_BUDGET_MB = 200;

// ---------------------------------------------------------------------------
// Config loader/validator (R5/M2) — the single owner for both the Phase-0
// CLI and the production entry point below.
// ---------------------------------------------------------------------------
const WrapperEntrySchema = z.object({
  direction: z.enum(['listen', 'dispatch']),
  callee: z.string().regex(/^\*?[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)?$/),
  eventArgIndex: z.number().int().nonnegative(),
  targetArgIndex: z.number().int().nonnegative().optional(),
}).strict() // Cluster-B audit-code R2/M8 fix: the outer ConfigFileSchema is
  // already .strict(), but a non-strict nested object schema silently drops
  // unknown keys by default — a misspelled wrapper field (e.g.
  // `eventArgIdnex`) was accepted as a valid, empty-of-that-field entry
  // instead of being rejected. Verified live: a top-level typo already threw
  // (unrecognized_keys), a nested one did not, before this fix.
  .refine(w => w.targetArgIndex === undefined || w.targetArgIndex !== w.eventArgIndex, {
    message: 'eventArgIndex and targetArgIndex must differ',
  });

const ConfigFileSchema = z.object({
  version: z.literal(1),
  wrappers: z.array(WrapperEntrySchema).max(32).default([]),
  totalByteBudgetMb: z.number().int().nonnegative().default(DEFAULT_TOTAL_BUDGET_MB),
}).strict();

function assertNoDuplicateWrappers(wrappers) {
  const seen = new Set();
  for (const w of wrappers) {
    const key = `${w.direction}|${w.callee}`;
    if (seen.has(key)) {
      throw new Error(`event-wiring config: duplicate wrapper (direction, callee) = (${w.direction}, ${w.callee})`);
    }
    seen.add(key);
  }
}

/**
 * @param {string} repoPath
 * @returns {{wrappers: Array, totalByteBudgetMb: number}}
 * @throws on a present-but-invalid config — callers convert to their own
 *   exit-2/hard-fail contract (Phase-0 CLI: exit 2; production: skip the run).
 */
export function loadEventWiringConfig(repoPath) {
  const configPath = path.join(repoPath, '.audit-loop', 'event-wiring.json');
  if (!fs.existsSync(configPath)) {
    return { wrappers: [], totalByteBudgetMb: DEFAULT_TOTAL_BUDGET_MB };
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    throw new Error(`event-wiring config at ${configPath} is not valid JSON: ${err.message}`);
  }
  const parsed = ConfigFileSchema.parse(raw);
  assertNoDuplicateWrappers(parsed.wrappers);
  return { wrappers: parsed.wrappers, totalByteBudgetMb: parsed.totalByteBudgetMb };
}

// ---------------------------------------------------------------------------
// Corpus builder (D11) — repo-wide (ref-less) or ref-anchored (D2d/R3-H3).
// ---------------------------------------------------------------------------
/**
 * Lists tracked files — from the CURRENT index/worktree when `ref` is
 * omitted (the repo-wide diagnostic mode), or from the ref's own tree when
 * given (audit-code R1/M1 fix). `git ls-files` always describes the current
 * index regardless of any `ref` the CALLER intends to read content from —
 * using it unconditionally meant a ref-anchored build could enumerate a
 * file list from a different repo state than the content it reads, silently
 * missing files that existed at `ref` but were since deleted, or including
 * ones that didn't exist there yet.
 */
function gitLsFiles(repoPath, ref, env) {
  const args = ref ? ['ls-tree', '-r', '--name-only', '-z', ref] : ['ls-files', '-z'];
  const buf = execFileSync('git', args, {
    cwd: repoPath, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, ...(env ? { env } : {}),
  });
  return buf.toString('utf8').split('\0').filter(Boolean);
}

/**
 * Strips ASCII control characters (including newlines/carriage-returns) from
 * a value before it's interpolated into a terminal diagnostic — audit-code
 * R4/M4 fix. Tracked git paths CAN legally contain control characters, and
 * writing one raw could forge extra log lines or terminal escape sequences.
 */
function sanitizeForTerminal(s) {
  // eslint-disable-next-line no-control-regex
  return String(s).replace(/[\x00-\x1f\x7f]/g, '·');
}

function isGenerated(relPath) {
  return relPath.includes('.min.') || relPath.includes('.generated.');
}

function isAllowedExtension(relPath) {
  const ext = path.extname(relPath).toLowerCase();
  return SOURCE_EXTENSIONS.has(ext);
}

/**
 * Reads MANY files at one ref in ONE subprocess, via `git cat-file --batch`
 * — audit-code performance fix, found live: `buildCorpus`'s ref-anchored
 * mode originally called `readAtRef` (one `git show` subprocess) per tracked
 * file, which is 1000+ subprocess spawns on this repo alone and hung a
 * direct end-to-end smoke test past 60 seconds. `git cat-file --batch`
 * accepts every `<ref>:<path>` spec on ONE stdin stream and returns all
 * blobs in order over ONE stdout stream — O(1) subprocess spawns instead of
 * O(files).
 *
 * @param {string} repoPath
 * @param {string} ref
 * @param {string[]} relPaths
 * @param {NodeJS.ProcessEnv} [env]
 * @param {number} [maxBuffer] - Cluster-B audit-code R2/M10 fix: the config
 *   schema allows `totalByteBudgetMb` to be ANY non-negative integer, but this
 *   call's `maxBuffer` was a hardcoded 512 MiB constant — a schema-valid
 *   budget above that (e.g. `totalByteBudgetMb: 1000`) would throw ENOBUFS on
 *   a fetch `buildCorpus` had already size-checked as within budget (the
 *   M6/M11 fix). Callers now derive this from the SAME budget the fetch set
 *   was trimmed to, so the execution ceiling and the configured policy are
 *   one coherent number instead of two independent constants that can
 *   silently disagree. Defaults to the prior 512 MiB for callers that don't
 *   pass one explicitly (Phase-0 CLI probe path).
 * @returns {Map<string, Buffer|null>} relPath -> content, or null if absent at ref
 */
function batchReadBlobsAtRef(repoPath, ref, relPaths, env, maxBuffer = 512 * 1024 * 1024) {
  const result = new Map(); // relPath -> {oid, content: Buffer} | null
  if (relPaths.length === 0) return result;
  // Cluster-B audit-code R1/M3 fix: `git cat-file --batch` reads one
  // NEWLINE-delimited `<ref>:<path>` selector per line — git tracks paths as
  // arbitrary byte strings (only NUL is forbidden), so a path containing a
  // literal `\n` (reachable here: `gitLsFiles` reads `-z`-delimited output,
  // which preserves an embedded newline intact) would inject an extra
  // selector into the stream, misaligning every subsequent response this
  // loop parses by position. Filtered out and reported missing, same as any
  // other unreadable path — not a live security exploit in a single-tenant
  // trusted-tree run, but a real correctness gap once this repo is ever
  // pointed at an untrusted or adversarial tree.
  const batchable = [];
  for (const p of relPaths) {
    if (p.includes('\n')) { result.set(p, null); continue; }
    batchable.push(p);
  }
  if (batchable.length === 0) return result;
  const stdin = batchable.map(p => `${ref}:./${p}`).join('\n') + '\n';
  const out = execFileSync('git', ['cat-file', '--batch'], {
    cwd: repoPath, input: stdin, maxBuffer, ...(env ? { env } : {}),
  });
  let offset = 0;
  for (const relPath of batchable) {
    const lineEnd = out.indexOf(0x0a, offset); // '\n'
    if (lineEnd === -1) { result.set(relPath, null); break; } // truncated output — treat rest as missing
    const header = out.slice(offset, lineEnd).toString('utf8');
    offset = lineEnd + 1;
    if (header.endsWith('missing')) {
      result.set(relPath, null);
      continue;
    }
    // "<oid> blob <size>"
    const parts = header.split(' ');
    const oid = parts[0];
    const size = parseInt(parts[2], 10);
    if (!Number.isFinite(size) || size < 0) { result.set(relPath, null); continue; }
    result.set(relPath, { oid, content: out.slice(offset, offset + size) });
    offset += size + 1; // +1 consumes the trailing '\n' after the blob content
  }
  return result;
}

/**
 * Cheap sibling of `batchReadBlobsAtRef`: one `git cat-file --batch-check`
 * subprocess returns `{oid, size}` per path with NO blob content — used to
 * decide the budget-respecting fetch set before spending the (potentially
 * large) `--batch` read. Cluster-B audit-code R1/M6+M11 fix: `buildCorpus`
 * originally batch-READ every eligible file's full content unconditionally,
 * before its per-file/total-byte budget checks ran — so the budget only
 * limited what was RETAINED, not what was fetched from git, undoing the very
 * short-circuit the pre-batching per-file loop had (budget-exhausted files
 * were never read at all). `--batch-check` output has no embedded content,
 * so plain newline-splitting is safe here (unlike `--batch`, where blob
 * bytes can themselves contain '\n' and byte-offset tracking is required).
 *
 * @param {string} repoPath
 * @param {string} ref
 * @param {string[]} relPaths
 * @returns {Map<string, {oid: string, size: number}|null>}
 */
function batchCheckSizesAtRef(repoPath, ref, relPaths, env) {
  const result = new Map();
  if (relPaths.length === 0) return result;
  const batchable = [];
  for (const p of relPaths) {
    if (p.includes('\n')) { result.set(p, null); continue; } // same M3 guard as batchReadBlobsAtRef
    batchable.push(p);
  }
  if (batchable.length === 0) return result;
  const stdin = batchable.map(p => `${ref}:./${p}`).join('\n') + '\n';
  const out = execFileSync('git', ['cat-file', '--batch-check'], {
    cwd: repoPath, input: stdin, maxBuffer: 512 * 1024 * 1024, ...(env ? { env } : {}),
  }).toString('utf8');
  const lines = out.split('\n');
  for (let i = 0; i < batchable.length; i++) {
    const line = lines[i];
    const relPath = batchable[i];
    if (!line || line.endsWith('missing')) { result.set(relPath, null); continue; }
    const parts = line.split(' ');
    const size = parseInt(parts[2], 10);
    if (!Number.isFinite(size) || size < 0) { result.set(relPath, null); continue; }
    result.set(relPath, { oid: parts[0], size });
  }
  return result;
}

function readAtRef(repoPath, ref, relPath, env) {
  // git show <ref>:<path> — every file becomes git-object-addressed under a
  // ref-anchored build, so no dirty/clean special case is needed here.
  // `<ref>:<path>` notation is REPO-ROOT-relative unless `<path>` is
  // explicitly `./`-prefixed (unlike `git ls-files`/`ls-tree`, which are
  // cwd-relative) — found live: `buildCorpus` scoped to a subdirectory of a
  // larger repo (this repo's own oracle fixture pack) resolved every clean
  // file's blob OID against the wrong tree entry once M1's fix made this
  // codepath reachable for the first time.
  return execFileSync('git', ['show', `${ref}:./${relPath}`], {
    cwd: repoPath, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: PER_FILE_BYTE_CAP + 4096, ...(env ? { env } : {}),
  });
}

function blobOidAtRef(repoPath, ref, relPath, env) {
  const out = execFileSync('git', ['rev-parse', `${ref}:./${relPath}`], {
    cwd: repoPath, stdio: ['ignore', 'pipe', 'pipe'], ...(env ? { env } : {}),
  });
  return out.toString('utf8').trim();
}

function gitStatusForFile(repoPath, relPath, env) {
  // Clean iff `git status --porcelain -- <path>` is empty.
  const out = execFileSync('git', ['status', '--porcelain', '--', relPath], {
    cwd: repoPath, stdio: ['ignore', 'pipe', 'pipe'], ...(env ? { env } : {}),
  });
  return out.toString('utf8').trim() === '';
}

/**
 * @param {{repoPath: string, wrappers: Array, ref?: string, totalByteBudgetMb?: number, env?: NodeJS.ProcessEnv}} args
 * @param {NodeJS.ProcessEnv} [args.env] - Cluster-B audit-code R1 fix (git-env-sanitize.mjs
 *   precedent, `diff-scope-resolver.mjs`'s own `env` param) — every git subprocess this module
 *   spawns takes an optional env override, spread in only when provided (`execFileSync`
 *   otherwise inherits `process.env` unchanged, same default as before this param existed).
 *   Omitted in production (the pre-push hook boundary, `prepush-check.mjs`, already sanitizes
 *   GIT_DIR/GIT_WORK_TREE before spawning the whole `npm run check` chain this runs inside).
 *   REQUIRED for any test creating an isolated scratch git repo — pass `gitFixtureEnv()`
 *   (`tests/helpers/fixtures.mjs`), or a leaked GIT_DIR from the calling process silently
 *   redirects `git init`/`git commit` onto the real repository (six live incidents, 2026-07-23,
 *   documented in `scripts/lib/git-env-sanitize.mjs`'s module docblock).
 * @returns {{sites: {dispatches: object[], listens: object[]}, orphanedPragmas: object[], counters: object, cacheKey: string}}
 */
export function buildCorpus({ repoPath, wrappers = [], ref, totalByteBudgetMb = DEFAULT_TOTAL_BUDGET_MB, env } = {}) {
  const trackedFiles = gitLsFiles(repoPath, ref, env);
  const dispatches = [];
  const listens = [];
  const orphanedPragmas = [];
  let skippedFiles = 0;
  let excludedFiles = 0;
  let totalBytesRead = 0;
  const totalBudgetBytes = totalByteBudgetMb > 0 ? totalByteBudgetMb * 1024 * 1024 : Infinity;
  const hashParts = [];
  let budgetExhausted = false;

  // Filter to eligible paths FIRST, then batch-read them all in ONE
  // subprocess when ref-anchored (audit-code performance fix, found live: a
  // per-file `git show` in this loop is 1000+ subprocess spawns on a real
  // repo — a direct end-to-end smoke test hung past 60s before this fix).
  const eligiblePaths = [];
  const excludedByPolicy = new Set();
  for (const relPath of trackedFiles) {
    if (!isAllowedExtension(relPath) || isGenerated(relPath)) { excludedByPolicy.add(relPath); continue; }
    const classification = resolveAndClassify(relPath, { repoRoot: repoPath });
    if (classification.category === 'sensitive') { excludedByPolicy.add(relPath); continue; }
    eligiblePaths.push(relPath);
  }
  excludedFiles += excludedByPolicy.size;

  // Budget-respecting fetch set (Cluster-B audit-code R1/M6+M11 fix): a
  // cheap `--batch-check` size pass decides, in tracked-file order, which
  // paths fit the per-file cap AND the running total budget — THEN
  // `batchReadBlobsAtRef` fetches content for ONLY that trimmed set. Content
  // for a file the budget would have skipped is never pulled from git at
  // all, matching the non-ref (working-tree) branch's own stat-before-read
  // discipline below and the per-file loop's pre-batching precedent.
  let pathsToFetch = eligiblePaths;
  let sizeChecks = null;
  let plannedFetchBytes = 0;
  if (ref) {
    sizeChecks = batchCheckSizesAtRef(repoPath, ref, eligiblePaths, env);
    pathsToFetch = [];
    let runningBytes = 0;
    let sizeBudgetExhausted = false;
    for (const relPath of eligiblePaths) {
      if (sizeBudgetExhausted) { skippedFiles++; continue; }
      const check = sizeChecks.get(relPath);
      // Missing/unreadable at this size-check stage still needs to reach the
      // fetch loop below — its existing catch block is what counts it into
      // `skippedFiles` with a logged reason (mirrors the non-ref branch's own
      // stat-then-read error handling). Dropping it silently here would
      // undercount skips relative to the pre-batching behaviour.
      if (!check) { pathsToFetch.push(relPath); continue; }
      if (check.size > PER_FILE_BYTE_CAP) { skippedFiles++; continue; }
      runningBytes += check.size;
      if (runningBytes > totalBudgetBytes) { sizeBudgetExhausted = true; skippedFiles++; continue; }
      pathsToFetch.push(relPath);
    }
    plannedFetchBytes = runningBytes;
  }
  // Cluster-B audit-code R2/M10 fix, refined R3/M2: derive the execution
  // ceiling from the SAME budget the fetch set above was trimmed to, instead
  // of a hardcoded 512 MiB constant that could silently disagree with a
  // schema-valid larger `totalByteBudgetMb`. Header overhead for `git
  // cat-file --batch`'s per-blob "<oid> blob <size>\n" response line scales
  // with FILE COUNT, not a percentage of content bytes — a flat multiplier
  // undercounts a large-budget, many-tiny-files corpus (thousands of files
  // at a few hundred bytes each, header lines a large fraction of the total)
  // while over-allocating a few-huge-files one. 128 bytes/entry is generous
  // (a real header line is well under 80 bytes even for a 40-hex-char oid);
  // floored at the historical 512 MiB so a small-budget config is unaffected.
  const headerOverheadBytes = pathsToFetch.length * 128;
  const batchMaxBuffer = Math.max(512 * 1024 * 1024, plannedFetchBytes + headerOverheadBytes + 1024 * 1024);
  const batchBlobs = ref ? batchReadBlobsAtRef(repoPath, ref, pathsToFetch, env, batchMaxBuffer) : null;

  for (const relPath of pathsToFetch) {
    if (budgetExhausted) { skippedFiles++; continue; }

    let source;
    let contentHash;
    try {
      if (ref) {
        const entry = batchBlobs.get(relPath);
        if (!entry) throw new Error(`missing at ${ref}`);
        source = entry.content.toString('utf8');
        contentHash = entry.oid;
      } else {
        const abs = path.join(repoPath, relPath);
        // audit-code R4/H2 fix: stat BEFORE reading — the prior version read
        // the whole file into memory unconditionally, then discarded it if
        // over the cap, so a very large tracked file paid the full read cost
        // (and its memory) before the limit that exists to bound exactly
        // that ever applied.
        const st = fs.statSync(abs);
        if (st.size > PER_FILE_BYTE_CAP) {
          skippedFiles++;
          process.stderr.write(`  [event-wiring] skip (oversize): ${sanitizeForTerminal(relPath)}\n`);
          continue;
        }
        const buf = fs.readFileSync(abs);
        source = buf.toString('utf8');
        contentHash = gitStatusForFile(repoPath, relPath, env)
          ? blobOidAtRef(repoPath, 'HEAD', relPath, env)
          : crypto.createHash('sha256').update(buf).digest('hex');
      }
    } catch (err) {
      // audit-code L2 fix: a bare aggregate count can't distinguish "expected
      // unsupported file" from "operational failure" — log path + reason
      // (mirrors diff-scope-resolver.mjs's precedent). The path itself is
      // never sensitive here (resolveAndClassify already excluded those
      // above); only the error message is truncated, since it could echo
      // file content in a read-error edge case.
      skippedFiles++;
      process.stderr.write(`  [event-wiring] skip (read failed): ${sanitizeForTerminal(relPath)} — ${sanitizeForTerminal(String(err.message || err)).slice(0, 200)}\n`);
      continue;
    }

    if (Buffer.byteLength(source, 'utf8') > PER_FILE_BYTE_CAP) { skippedFiles++; continue; }
    totalBytesRead += Buffer.byteLength(source, 'utf8');
    if (totalBytesRead > totalBudgetBytes) { budgetExhausted = true; skippedFiles++; continue; }

    hashParts.push(`${relPath}:${contentHash}`);

    const runtime = isTestFile(relPath) ? 'test' : isDocExampleFile(relPath) ? 'doc-example' : 'production';
    const sites = extractEventSites(source, { path: relPath, wrappers, runtime });
    dispatches.push(...sites.dispatches);
    listens.push(...sites.listens);
    // Cluster-B audit-code R1/M22 fix: `extractEventSites` has always
    // returned `orphanedPragmas` (a pragma bound to no dispatch site in this
    // file), but nothing downstream ever read it — the `EventWiringOrphanedPragmaFindingSchema`,
    // its fingerprint intercept, and its standard-finding converter all
    // existed with no producer, so the finding kind was dead on arrival.
    // Corpus-wide, like symmetry findings (`resolveSymmetry`) — an orphaned
    // pragma is a static per-file property, not a diff-scoped one; it can go
    // stale from a dispatch removed anywhere, not just in a changed file.
    // `p.locus.path` is already set (extractEventSites's `localeOf` closes
    // over the `path` param passed above) — no extra field needed here.
    orphanedPragmas.push(...sites.orphanedPragmas);
  }

  hashParts.sort();
  const wrapperConfigHash = crypto.createHash('sha256').update(JSON.stringify(wrappers)).digest('hex').slice(0, 16);
  const cacheKey = crypto.createHash('sha256')
    .update(`${EXTRACTOR_VERSION}|${PATH_CLASSIFIER_VERSION}|${wrapperConfigHash}|${PER_FILE_BYTE_CAP}|${totalByteBudgetMb}|${hashParts.join(',')}`)
    .digest('hex');

  return {
    sites: { dispatches, listens },
    orphanedPragmas,
    counters: { skippedFiles, excludedFiles, filesConsidered: trackedFiles.length },
    cacheKey,
  };
}

// ---------------------------------------------------------------------------
// Wave-1.5c diff-scope materialiser — Cluster B fix, found during Wave-1.5c
// wiring: the plan's D2 step 1 said "diff-scope-resolver already
// materialises preimages via git worktree — reused", but
// `diff-scope-resolver.mjs`'s exported `resolveDiffScope` returns an
// IMPORT-GRAPH-shaped scope (paths/status/edges) for the orphan detector —
// it never exposes before/after SOURCE CONTENT to a caller. Event-wiring
// needs actual file content, so this is a dedicated, self-contained
// materialiser reusing the same `git show <ref>:./<path>` primitive
// `buildCorpus` already established (`readAtRef`).
//
// **Scope decision, deliberately narrower than orphan's**: always a
// COMMITTED range (`baseRef..headRef`), never dirty-working-tree mode. D12's
// lifecycle/ancestry tracking (`git merge-base --is-ancestor`) fundamentally
// needs a resolvable commit ref — "is the dirty working tree an ancestor of
// X" has no answer. An uncommitted dispatch/listener change is therefore not
// analysed by this wave until it's committed; the standalone CLI's
// repo-wide diagnostic mode (D2d) has no such restriction, since it never
// writes to the lifecycle ledger.
// ---------------------------------------------------------------------------

/**
 * @param {{auditBaseCommit?: string}} args
 * @returns {{baseRef: string, headRef: string}}
 */
export function resolveEventWiringScopeRefs({ auditBaseCommit } = {}) {
  return { baseRef: auditBaseCommit ?? 'HEAD~1', headRef: 'HEAD' };
}

/**
 * Builds the `diffScope` shape `detectEventWiringAsymmetry` needs, for a
 * COMMITTED range only (see the scope decision above).
 * @param {{repoPath: string, baseRef: string, headRef: string}} args
 * @returns {{headRef: string, changedFiles: Array<{path:string, status:string, beforeSource?:string, afterSource?:string}>}}
 */
export function buildEventWiringDiffScope({ repoPath, baseRef, headRef, env }) {
  const buf = execFileSync('git', ['diff', '--name-status', '-z', baseRef, headRef], {
    cwd: repoPath, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, ...(env ? { env } : {}),
  });
  const tokens = buf.toString('utf8').split('\0').filter(Boolean);
  const changedFiles = [];
  for (let i = 0; i < tokens.length; i++) {
    const raw = tokens[i];
    const status = raw[0];
    if (status === 'R' || status === 'C') {
      // `git diff --name-status` emits "R100\0old\0new\0" — two path tokens follow.
      const oldPath = tokens[++i];
      const newPath = tokens[++i];
      changedFiles.push(buildOneChangedFile(repoPath, baseRef, headRef, status, oldPath, newPath, env));
      continue;
    }
    const relPath = tokens[++i];
    changedFiles.push(buildOneChangedFile(repoPath, baseRef, headRef, status, relPath, relPath, env));
  }
  return { headRef, changedFiles };
}

function buildOneChangedFile(repoPath, baseRef, headRef, status, beforePath, afterPath, env) {
  if (!isAllowedExtension(afterPath) && !isAllowedExtension(beforePath)) {
    return { path: afterPath, status, beforeSource: undefined, afterSource: undefined };
  }
  let beforeSource;
  let afterSource;
  try {
    if (status !== 'A' && status !== 'C') beforeSource = readAtRef(repoPath, baseRef, beforePath, env).toString('utf8');
  } catch { /* file didn't exist at baseRef, or unreadable — leave undefined, D2 rule 6 fail-closed */ }
  try {
    if (status !== 'D') afterSource = readAtRef(repoPath, headRef, afterPath, env).toString('utf8');
  } catch { /* file doesn't exist at headRef, or unreadable — leave undefined */ }
  return { path: afterPath, status, beforeSource, afterSource };
}

/**
 * Convert `buildCorpus`'s raw `{locus, pragmaText}` orphaned-pragma entries
 * into `event-wiring-orphaned-pragma`-kind findings.
 *
 * Cluster-B audit-code R1/L2 fix: `findingFingerprint`'s intercept for this
 * kind hashes `(kind, path, pragmaTextHash)` — a pure per-finding function
 * with no batch context, so two pragmas with byte-identical text in the SAME
 * file would collide to one fingerprint, and R2+ ledger suppression (which
 * matches on fingerprint) would then apply one ruling to both, silently
 * dropping a genuinely separate occurrence from a later round. Fixed here,
 * at construction time, with a 0-based `dedupeOrdinal` per (path, text)
 * duplicate group — `findingFingerprint` folds it into the hash. An ordinal
 * (not a line number) so a reformat that doesn't change the SET of
 * identical-text pragmas in a file doesn't reshuffle existing fingerprints;
 * a raw line number was rejected for the same reason `dispatchSignature`
 * excludes line, in event-wiring.mjs's `diffSites`.
 *
 * @param {Array<{locus: object, pragmaText: string}>} raw
 * @returns {object[]}
 */
function orphanedPragmasToFindings(raw) {
  const seen = new Map(); // `${path}|${pragmaText}` -> next ordinal
  return raw.map((p) => {
    const key = `${p.locus.path}|${p.pragmaText}`;
    const dedupeOrdinal = seen.get(key) ?? 0;
    seen.set(key, dedupeOrdinal + 1);
    return {
      kind: 'event-wiring-orphaned-pragma',
      severity: 'MEDIUM',
      enforcement: 'advisory',
      locus: p.locus,
      pragmaText: p.pragmaText,
      dedupeOrdinal,
      rationale: 'This suppression pragma binds to no dispatch site in this file — the dispatch it was meant to suppress has been removed, moved out of binding range, or the pragma was never correctly positioned.',
    };
  });
}

// ---------------------------------------------------------------------------
// Production entry point (Wave-1.5c) — R2/H1, corrected R3/H2, R3/H3, R5/H1.
// ---------------------------------------------------------------------------

/**
 * @param {{diffScope: {headRef: string, changedFiles: Array<{path:string, status:string, beforeSource?:string, afterSource?:string}>}, repoPath: string, wrappers: Array, ledgerPath: string, metricsSinkPath?: string, runId?: string, learningWritesAllowed?: boolean}} args
 */
export async function detectEventWiringAsymmetry({
  diffScope, repoPath, wrappers = [], totalByteBudgetMb, ledgerPath, metricsSinkPath, runId, learningWritesAllowed = true, env,
} = {}) {
  // Cluster-B fix: use the real, lock-safe, parameterised writer
  // (orphan-metrics.mjs, now generalised) instead of the Cluster-A
  // placeholder — see the plan's Phase 1 file list correction.
  const { emitOrphanRunMetrics } = await import('./orphan-metrics.mjs');
  // (1) After-state repo-wide corpus, ref-anchored to headRef — reused by
  // both the site-diff below and D12 reconciliation, never built twice.
  // `totalByteBudgetMb` is threaded through explicitly (audit-code R1/M6 fix
  // — a prior draft loaded the config's budget but never passed it here,
  // so the production path silently always used buildCorpus's default).
  const { sites: corpus, orphanedPragmas: corpusOrphanedPragmas, counters: corpusCounters } = buildCorpus({ repoPath, wrappers, ref: diffScope.headRef, totalByteBudgetMb, env });

  // (2) Per-changed-file before/after extraction.
  let readSkips = 0;
  const perFile = [];
  for (const f of diffScope.changedFiles) {
    try {
      const before = f.beforeSource !== undefined
        ? extractEventSites(f.beforeSource, { path: f.path, wrappers, runtime: isTestFile(f.path) ? 'test' : isDocExampleFile(f.path) ? 'doc-example' : 'production' })
        : { dispatches: [], listens: [] };
      const after = f.afterSource !== undefined
        ? extractEventSites(f.afterSource, { path: f.path, wrappers, runtime: isTestFile(f.path) ? 'test' : isDocExampleFile(f.path) ? 'doc-example' : 'production' })
        : { dispatches: [], listens: [] };
      perFile.push({ status: f.status, before, after });
    } catch (err) {
      readSkips++;
      process.stderr.write(`  [event-wiring] skip changed-file (extraction failed): ${sanitizeForTerminal(f.path)} — ${sanitizeForTerminal(String(err.message || err)).slice(0, 200)}\n`);
    }
  }

  // (2.5) partial decided BEFORE any side effect (R5/H1).
  const skippedFiles = corpusCounters.skippedFiles + readSkips;
  const counters = { ...corpusCounters, skippedFiles };
  if (skippedFiles > 0) {
    // Gated on learningWritesAllowed (mirrors orphan-introduced's own
    // short-circuit emit, legacy-production-audit.mjs) — this metrics file
    // is durable local telemetry shared with the real run; an
    // observation-only shadow (tiered-shadow-compare, verify-anchor-contract)
    // appending to it double-counts the same commit.
    if (metricsSinkPath && learningWritesAllowed) {
      await emitOrphanRunMetrics({
        runId: runId || `event-wiring-${Date.now()}`, passState: 'ANALYZED_PARTIAL',
        rawFindings: [], survivors: [], suppressed: [], _meta: counters, repoPath,
        sinkPath: metricsSinkPath, summaryKind: 'event-wiring-run-summary',
      });
    }
    return { findings: [], counters, partial: true };
  }

  // (3) Diff-wide union, then diffSites per changed-file pair, unioned.
  let addedDispatches = [];
  let removedListeners = [];
  for (const { before, after } of perFile) {
    const d = diffSites(before, after);
    addedDispatches = addedDispatches.concat(d.addedDispatches);
    removedListeners = removedListeners.concat(d.removedListeners);
  }

  // (4) resolveSymmetry, plus corpus-wide orphaned-pragma findings (D5,
  // Cluster-B audit-code R1/M22 fix — see orphanedPragmasToFindings' own
  // docstring: this kind previously had a schema, a fingerprint intercept
  // and a standard-finding converter but no producer anywhere in the
  // pipeline). Corpus-wide, not diff-scoped, for the same reason symmetry
  // findings are: a pragma can go stale from a dispatch removed anywhere in
  // the repo, not just in a file this run's diff touched.
  const { findings: symmetryFindings, coverage, counters: symCounters } = resolveSymmetry({ corpus, addedDispatches, removedListeners });
  const findings = [...symmetryFindings, ...orphanedPragmasToFindings(corpusOrphanedPragmas)];

  // (5) D12 reconciliation — one locked transaction, ancestry precomputed
  // outside the lock (R4/M1, corrected R5/H2, Gemini round-3 G1/G2).
  // Gated on learningWritesAllowed for the same reason as the metrics
  // emits below: this is durable shared state (.audit/event-wiring-ledger.json),
  // not per-run output — an observation-only shadow run reconciling it would
  // apply the same commit's transitions twice (double-counted occurrences,
  // or a same-ref reopen/close cycle the real run never asked for).
  if (learningWritesAllowed) {
    const openRecords = listOpenLifecycle(ledgerPath, { kind: 'event-wiring-symmetry' });
    const coveredNames = new Set(coverage.map(c => c.eventName));
    const observations = coverage.map(c => ({ eventName: c.eventName, ref: diffScope.headRef, coverage: c }));
    for (const rec of openRecords) {
      if (coveredNames.has(rec.eventName)) continue;
      const status = lookupEventStatus(corpus, rec.eventName);
      observations.push({ eventName: rec.eventName, ref: diffScope.headRef, status });
    }
    // R2/H1 fix: ancestry must be computed for every EXISTING record an
    // observation this run could touch, not just OPEN ones. `observations`
    // is built from `coverage` (repo-wide dispatch-only events, regardless
    // of ledger state) — a `coverage`-derived observation can legitimately
    // target an event with a TERMINAL (already-closed) ledger record (a
    // genuine reopen). `computeAncestryDecisions(..., openRecords)` alone
    // never computes ancestry for a terminal record's `lastObservedRef`, so
    // `reconcileLifecycle`'s stale-observation guard (which runs for ANY
    // existing record, terminal or open) would find no map entry, fail its
    // `=== true` check, and silently drop a real reopen. Fixed by resolving
    // the actual existing record (open or terminal) for every observed
    // eventName and feeding ALL of those into the ancestry computation.
    const observedNames = new Set(observations.map(o => o.eventName));
    const recordsNeedingAncestry = [];
    for (const name of observedNames) {
      const existing = readLifecycle(ledgerPath, `event-wiring-symmetry|${name}`);
      if (existing) recordsNeedingAncestry.push(existing);
    }
    const ancestryDecisions = computeAncestryDecisions(repoPath, diffScope.headRef, recordsNeedingAncestry, env);
    reconcileLifecycle(ledgerPath, { kind: 'event-wiring-symmetry', observations, now: Date.now(), ancestryDecisions });
  }

  // (6) merge counters, write metrics, return.
  const merged = { ...counters, ...symCounters };
  if (metricsSinkPath && learningWritesAllowed) {
    // At this layer `findings` are already post-pragma-suppression (D5, inside
    // resolveSymmetry) but PRE-ledger-suppression (which happens later, in the
    // shared findings-pipeline this wave's caller feeds into) — so every
    // current finding is reported as a survivor here; ledger-level suppression
    // gets its own record when the shared pipeline processes it.
    const passState = findings.length > 0 ? 'ANALYZED_WITH_FINDINGS' : 'ANALYZED_CLEAN';
    await emitOrphanRunMetrics({
      runId: runId || `event-wiring-${Date.now()}`, passState,
      rawFindings: findings, survivors: findings, suppressed: [], _meta: merged, repoPath,
      sinkPath: metricsSinkPath, summaryKind: 'event-wiring-run-summary',
    });
  }

  return { findings, counters: merged, partial: false };
}

function computeAncestryDecisions(repoPath, headRef, openRecords, env) {
  const decisions = new Map();
  const distinctStoredRefs = new Set(openRecords.map(r => r.lastObservedRef).filter(Boolean));
  for (const storedRef of distinctStoredRefs) {
    if (storedRef === headRef) { decisions.set(storedRef, true); continue; }
    try {
      // "is storedRef an ancestor of headRef" — i.e. is headRef newer-or-equal.
      execFileSync('git', ['merge-base', '--is-ancestor', storedRef, headRef], {
        cwd: repoPath, stdio: ['ignore', 'pipe', 'pipe'], ...(env ? { env } : {}),
      });
      decisions.set(storedRef, true);
    } catch (err) {
      // Fail closed on ANY failure — a real "not an ancestor" (exit 1) and an
      // unreachable-commit error (exit 128, shallow clone / gc / force-push)
      // are handled identically: drop the observation, never throw
      // (Gemini round-3 G2).
      decisions.set(storedRef, false);
      void err;
    }
  }
  return decisions;
}


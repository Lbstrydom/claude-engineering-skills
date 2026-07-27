#!/usr/bin/env node
/**
 * @fileoverview Phase B.1 — symbol extractor.
 *
 * Uses **ts-morph** for intra-file symbol extraction (functions, classes,
 * components, hooks) per spike S1; **dependency-cruiser** for the file-to-file
 * import graph + layering rules.
 *
 * Routes every candidate through `sensitive-egress-gate.mjs` BEFORE capturing
 * body text. Sensitive-by-path files are skipped; non-allowlisted-extension
 * files emit no symbol records.
 *
 * Emits:
 *   - One `{type: "symbol", ...}` JSON line per extracted symbol on stdout
 *   - One `{type: "violation", ...}` JSON line per dep-cruiser layering violation
 *   - One `{type: "summary", counts: {...}}` line at end
 *
 * @module scripts/symbol-index/extract
 */

import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Project } from 'ts-morph';
import { cruise } from 'dependency-cruiser';
import { signatureHash } from '../lib/symbol-index.mjs';
import {
  // gateSymbolForEgress no longer needed at call sites — file-level
  // enforcement is hoisted via resolveAndClassify (Gemini-G2 WS-CANON
  // fix). The gate remains the single seam other callers can use.
  isExtensionAllowlisted,
  containsSecrets,
  redactSecrets,
  SECRET_REDACTED,
} from '../lib/sensitive-egress-gate.mjs';
import { shouldSkipForIndexing, formatSkipLog, resolveAndClassify } from '../lib/sensitive-paths.mjs';
import { isThinDelegate } from '../lib/symbol-index/thin-delegate.mjs';
import {
  eligibleFiles,
  assessExtractionCoverage,
  assertExtractionExhaustive,
} from '../lib/symbol-index/graph-coverage.mjs';
import { COVERAGE_DEFAULTS } from '../lib/symbol-index/graph-verdict.mjs';
import { emit } from '../lib/cli-io.mjs';

function parseArgs(argv) {
  const args = { root: process.cwd(), files: null, mode: 'full', sinceCommit: null, includeDelegates: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') args.root = argv[++i];
    else if (a === '--files') args.files = argv[++i].split(',').filter(Boolean);
    // --files-from <path>: read a newline-delimited manifest of files. Used by
    // refresh.mjs for incremental runs so a large touched-file list never hits
    // the OS argv length limit (Windows ENAMETOOLONG at ~1600+ files). Newline-
    // delimited (not comma) so any filename is safe. Takes precedence over --files.
    // ACCEPTED DEBT (code-audit 2026-07-21, H1/M4 — pre-existing, independent of
    // the idle-timeout change): the newline-delimited format + `.trim()` cannot
    // faithfully carry a POSIX filename with an embedded newline or leading/
    // trailing whitespace. Harmless for this tool (it indexes source files, whose
    // names never contain those); a real fix is a NUL-delimited manifest (git -z
    // style). Deferred, not fixed here — see .audit/tech-debt.json.
    else if (a === '--files-from') {
      const manifestPath = argv[++i];
      args.files = fs.readFileSync(manifestPath, 'utf-8').split('\n').map(s => s.trim()).filter(Boolean);
    }
    else if (a === '--mode') args.mode = argv[++i];
    else if (a === '--since-commit') args.sinceCommit = argv[++i];
    else if (a === '--include-delegates') args.includeDelegates = true;
  }
  return args;
}


function emitProgress(msg) {
  process.stderr.write(`  [extract] ${msg}\n`);
}

/**
 * Walk the repo (or a subset of files) and emit symbol records.
 *
 * @param {string[]} filePaths - absolute paths
 * @param {string} repoRoot - absolute path
 * @param {{includeDelegates?: boolean}} [opts] - opts.includeDelegates skips the thin-delegate filter (debug/visibility)
 * @returns {{symbolCount: number, skippedPath: number, skippedExt: number, skippedSize: number, skippedDelegate: number, redacted: number, statFailures: number, parseFailures: number}}
 */
export function extractSymbols(filePaths, repoRoot, opts = {}) {
  // statFailures/parseFailures (audit 9cc6f93b, 2026-07-17): both catches
  // below used to swallow the failure with no counter and no result-shape
  // signal — a run could report a clean summary while silently omitting
  // files. Additive only: does NOT change what's read, skipped, or how a
  // sensitive/symlink path is classified (INC-001) — counting only.
  const stats = { symbolCount: 0, skippedPath: 0, skippedExt: 0, skippedSize: 0, skippedDelegate: 0, redacted: 0, statFailures: 0, parseFailures: 0 };
  // Aggregate sensitive-path skips and emit ONE redacted log block at end
  // (plan: docs/plans/sustainability-cleanup-batch.md WS3, Gemini-r2-G3).
  const skippedSensitive = [];
  // skipAddingFilesFromTsConfig + skipFileDependencyResolution prevent ts-morph
  // from auto-loading imported modules (vendored types, monorepo siblings, etc.)
  // which is what ballooned the wine-cellar refresh to 4.3GB heap.
  const project = new Project({
    useInMemoryFileSystem: false,
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    compilerOptions: {
      allowJs: true,
      checkJs: false,
      target: 99,
      module: 99,
      moduleResolution: 100,
    },
  });

  for (const abs of filePaths) {
    const rel = path.relative(repoRoot, abs).replace(/\\/g, '/');
    // Liveness heartbeat (docs/plans/extract-idle-timeout.md). This
    // synchronous loop is bounded by the parent's IDLE timeout, which resets on
    // any stdout record. A file yields no `symbol` records if it is skipped or
    // contains no extractable declarations, so symbol output alone is NOT a
    // reliable liveness signal — emit a `progress` beat at the TOP of every
    // iteration, BEFORE this file's ts-morph work, so the max silent interval is
    // exactly one file's processing time. Goes to stdout via `emit` (NOT
    // `emitProgress`, which is stderr and invisible to the parent's timer).
    // refresh.mjs's record filters ignore the `progress` type, so the published
    // snapshot is unchanged; the file path lets a wedge kill name the culprit.
    emit({ type: 'progress', file: rel });
    // Skip filter covers BOTH categories. In incremental mode this is
    // defence-in-depth (refresh.mjs already filtered the diff). In full
    // mode (refresh.mjs passes no `--files`) this IS the discovery filter
    // — so the same skip policy applies to both modes (plan §6 WS3 R3-H3).
    // Sensitive entries aggregate; generatedNoise/driftExempt stay per-path (visible).
    const skip = shouldSkipForIndexing(rel, ['sensitive', 'generatedNoise', 'driftExempt']);
    if (skip.skip) {
      stats.skippedPath++;
      skippedSensitive.push({ path: rel, category: skip.category, pattern: skip.pattern, action: 'dropped' });
      continue;
    }
    if (!isExtensionAllowlisted(rel)) {
      stats.skippedExt++;
      continue;
    }
    // WS-CANON (Gemini-G2 fix): canonical-path resolution happens ONCE
    // per file, BEFORE ts-morph reads the file into memory. The previous
    // implementation called gateSymbolForEgress (and therefore
    // fs.realpathSync) inside the inner per-candidate loop — dozens of
    // syscalls per file, AND the file was already in ts-morph's memory
    // via the unresolved path before any canonical check could run.
    // Now: resolve once, skip the entire file if sensitive / escaped /
    // unresolvable, AND feed ts-morph the canonical path so we read
    // exactly what the gate approved.
    const cls = resolveAndClassify(rel, { repoRoot });
    if (cls.escapedRepo) {
      stats.skippedPath++;
      skippedSensitive.push({ path: rel, category: 'sensitive', pattern: null, action: 'skip-symlink-escape' });
      continue;
    }
    if (cls.category === 'sensitive') {
      stats.skippedPath++;
      const action = cls.resolutionFailed ? 'skip-resolution-failed'
                   : (cls.lexical === 'sensitive' ? 'dropped' : 'skip-canonical-sensitive');
      skippedSensitive.push({ path: rel, category: 'sensitive', pattern: null, action });
      continue;
    }
    // Size cap — skip generated/bundled monsters before they OOM ts-morph.
    // Use the canonical path so a symlink to a huge real file is still caught.
    const readPath = cls.canonical || abs;
    try {
      const size = fs.statSync(readPath).size;
      if (size > MAX_FILE_BYTES) {
        stats.skippedSize++;
        emitProgress(`skip-size: ${rel} (${Math.round(size/1024)}KB > ${MAX_FILE_BYTES/1024}KB)`);
        continue;
      }
    } catch (err) {
      stats.statFailures++;
      emitProgress(`stat-error: ${rel} — ${err.message}`);
      continue;
    }
    let sf;
    try {
      sf = project.addSourceFileAtPathIfExists(readPath);
    } catch (err) {
      stats.parseFailures++;
      emitProgress(`parse-error: ${rel} — ${err.message}`);
      continue;
    }
    if (!sf) {
      // ts-morph's `*IfExists` APIs return undefined instead of throwing on
      // failure — a non-exception failure the try/catch above can't see
      // (audit M5, 2026-07-24: the exception path was counted, this one
      // wasn't, so a file could fail to load without appearing anywhere in
      // failure accounting).
      stats.parseFailures++;
      emitProgress(`parse-error: ${rel} — addSourceFileAtPathIfExists returned no source file`);
      continue;
    }

    const candidates = [];

    for (const fn of sf.getFunctions()) {
      candidates.push({
        symbolName: fn.getName() || '(anonymous)',
        kind: 'function',
        startLine: fn.getStartLineNumber(),
        endLine: fn.getEndLineNumber(),
        signature: `function ${fn.getName() || ''}(${fn.getParameters().map(p => p.getText()).join(',')})`,
        bodyText: fn.getBodyText() || '',
        isExported: fn.isExported(),
      });
    }
    for (const cls of sf.getClasses()) {
      candidates.push({
        symbolName: cls.getName() || '(anonymous)',
        kind: 'class',
        startLine: cls.getStartLineNumber(),
        endLine: cls.getEndLineNumber(),
        signature: `class ${cls.getName() || ''}`,
        bodyText: cls.getText() || '',
        isExported: cls.isExported(),
      });
    }
    for (const v of sf.getVariableDeclarations()) {
      const init = v.getInitializer();
      if (!init) continue;
      const initKind = init.getKindName();
      if (initKind === 'ArrowFunction' || initKind === 'FunctionExpression') {
        candidates.push({
          symbolName: v.getName(),
          kind: 'function',
          startLine: v.getStartLineNumber(),
          endLine: v.getEndLineNumber(),
          signature: `const ${v.getName()} = ${initKind}`,
          bodyText: v.getText() || '',
          isExported: v.isExported() || v.getVariableStatement()?.isExported() || false,
        });
      }
    }

    for (const c of candidates) {
      // Thin-delegate filter: skip 1-line facades like
      //   const addListener = (...args) => target.method(...args);
      // before they enter the cluster index. See isThinDelegate().
      // --include-delegates flag (opts.includeDelegates) disables the filter
      // for operators who want the full per-module view in arch:render.
      if (!opts.includeDelegates && isThinDelegate(c.bodyText)) {
        stats.skippedDelegate++;
        continue;
      }
      // WS-CANON (Gemini-G2 fix): path-level enforcement (sensitive,
      // extension, symlink-escape) is done ONCE per file above — we
      // know this file already passed. Inner loop only needs the
      // body-secret check to decide whether to redact this specific
      // candidate's body before egress.
      const willRedact = containsSecrets(c.bodyText);
      if (willRedact) stats.redacted++;

      // R1 H3: signature can carry default-arg literals that contain secrets
      // (e.g. `function f(key="AKIA...")`). When the body fired the secret
      // gate, redact the signature too so no field leaks to summarise/embed.
      // Also defensive-check signature even when body looked clean — a parser
      // edge case could put the secret only in the signature.
      const safeSignature = (willRedact || containsSecrets(c.signature))
        ? redactSecrets(c.signature)
        : c.signature;

      const record = {
        type: 'symbol',
        filePath: rel,
        symbolName: c.symbolName,
        kind: c.kind,
        startLine: c.startLine,
        endLine: c.endLine,
        signature: safeSignature,
        bodyText: willRedact ? '' : c.bodyText,
        signatureHash: signatureHash({
          symbolName: c.symbolName,
          // hash always uses the ORIGINAL signature/body so cache identity
          // tracks the real artifact, not the redacted display copy
          signature: c.signature,
          bodyText: c.bodyText,
        }),
        isExported: c.isExported,
        purposeSummary: willRedact ? SECRET_REDACTED : null,
        embedding: null,
        redacted: willRedact,
      };
      emit(record);
      stats.symbolCount++;
    }
    // Release SourceFile after we're done with it so the project doesn't
    // accumulate 800+ in-memory ASTs (memory growth was a contributor to
    // the 4.3GB heap in wine-cellar's hung run).
    try { project.removeSourceFile(sf); } catch { /* ignore */ }
  }

  for (const line of formatSkipLog(skippedSensitive, { logger: 'extract' })) {
    process.stderr.write(`  ${line}\n`);
  }

  return stats;
}

/**
 * Walk the file-to-file graph + emit any layering violations.
 * Violations come from `.dependency-cruiser.cjs` config if present in repo,
 * else default heuristics.
 *
 * Also MEASURES its own blindness (plan §2.1, Phase 2). This is the only place
 * that holds both layers' views of the repo — `enumerateFiles`' whole-repo
 * inventory and the cruise result — so it is the only place the two can be
 * compared without re-deriving one of them and reintroducing the very
 * disagreement being measured.
 *
 * @param {string} repoRoot
 * @param {{eligible?: string[]|null, sampleCap?: number}} [opts]
 *   opts.eligible — the coverage DENOMINATOR (§2.1.1). `null` on an incremental
 *   run: coverage is a full-run measurement, so a partial run emits no coverage
 *   line at all and `refresh.mjs` copies the prior row forward as stale (§2.1.3
 *   row 4) rather than choosing between a fresh partial number and a stale
 *   whole one.
 * @returns {{violationCount: number, importCount?: number, coverage?: object}}
 */
async function extractGraphAndViolations(repoRoot, opts = {}) {
  const { eligible = null, sampleCap = COVERAGE_DEFAULTS.sampleCap } = opts;
  const measure = Array.isArray(eligible);
  // R1 audit Gemini-G1: don't hardcode ['scripts', 'src'] — many repos use
  // lib/, app/, components/, pages/, api/, etc. Auto-detect any top-level
  // source-looking directory, then fall back to repo root if nothing matches.
  // dep-cruiser respects the exclude pattern below to skip junk.
  const localConfig = path.join(repoRoot, '.dependency-cruiser.cjs');
  const cruiseOpts = {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(node_modules|\\.git|\\.audit-loop|dist|build|coverage|out|\\.next|\\.nuxt|\\.cache)(/|$)' },
  };
  if (fs.existsSync(localConfig)) {
    // pathToFileURL, not a bare path: `await import('C:\repo\.dependency-
    // cruiser.cjs')` throws ERR_UNSUPPORTED_ESM_URL_SCHEME on Windows, and a
    // hand-built `file://${p}` is malformed there too (backslashes). This repo
    // has no local config so the branch never fired here — but a CONSUMER with
    // one would have died before the cruise, and this ships to adopter repos we
    // never see. Found by following a final-gate LOW about the sibling spike.
    //
    // Wrapped because this sits OUTSIDE the cruise try/catch: an unreadable or
    // malformed local config used to kill extract outright, taking the symbol
    // index with it. Degrade to the default ruleset instead (#16) — a missing
    // layering ruleset costs violations, not the whole index.
    try {
      cruiseOpts.ruleSet = (await import(pathToFileURL(localConfig).href)).default;
    } catch (err) {
      emitProgress(`WARNING: could not load .dependency-cruiser.cjs (${err.message}); `
        + `continuing with default rules — layering violations will not be reported`);
    }
  }

  // Common JS/TS source-dir conventions, plus a fallback to the repo root
  // (dep-cruiser will then walk everything not excluded above).
  //
  // KNOWN LIMITATION — this allowlist is a silent-blindness generator. The
  // `targets.length === 0` fallback below only fires when a repo matches
  // NOTHING here, so a repo using a dir name absent from this list gets a
  // SMALLER import graph. That is exactly how `tests/` went unseen: only
  // `scripts/` matched, so the largest domain in this repo (380 files)
  // produced zero observed edges for months while being fully symbol-indexed
  // by enumerateFiles(), which walks the whole repo. Two layers of one
  // pipeline disagreeing about what the repo contains.
  //
  // It is no longer SILENT (2026-07-18, plan §2.1.1): the coverage measurement
  // below holds the cruise result against the whole-repo eligible universe, so
  // an unlisted layout now surfaces as a number and a `degraded` verdict. The
  // allowlist deliberately still selects targets unchanged — measuring the
  // blindness is this plan's scope; removing it is unified discovery, which
  // stays out of scope precisely because it cannot fix a resolution defect:
  // docs/plans/observed-graph-discovery-unification.md §3.1
  const COMMON_SOURCE_DIRS = [
    'scripts', 'src', 'lib', 'app', 'apps', 'packages',
    'components', 'pages', 'server', 'api', 'routes',
    'frontend', 'backend', 'client',
    'tests',
  ];
  let targets = COMMON_SOURCE_DIRS
    .map(d => path.join(repoRoot, d))
    .filter(p => fs.existsSync(p));
  if (targets.length === 0) targets = [repoRoot];

  let result;
  const startedAt = Date.now();
  try {
    result = await cruise(targets, cruiseOpts);
  } catch (err) {
    emitProgress(`dep-cruiser failed: ${err.message}`);
    // A failed cruise used to be indistinguishable from a repo with no
    // imports — same `{violationCount: 0}`, `importCount` undefined. Now it
    // says so: `outcome: 'failed'` carries null counts (NOT zero; zero is a
    // measurement, null is the absence of one) and the verdict oracle maps it
    // to `unverified` / `extraction_failed` at precedence row 1.
    if (measure) {
      const coverage = assessExtractionCoverage({
        outcome: 'failed', elapsedMs: Date.now() - startedAt,
      });
      emitCoverage(coverage);
      emitProgress('coverage: unverified (extraction_failed)');
      return { violationCount: 0, coverage };
    }
    return { violationCount: 0 };
  }
  const elapsedMs = Date.now() - startedAt;

  const violations = (result.output?.summary?.violations || []);
  for (const v of violations) {
    emit({
      type: 'violation',
      ruleName: v.rule?.name || 'unknown',
      fromPath: path.relative(repoRoot, v.from || '').replace(/\\/g, '/'),
      toPath: path.relative(repoRoot, v.to || '').replace(/\\/g, '/'),
      severity: v.rule?.severity || 'warn',
      comment: v.rule?.comment || null,
    });
  }

  // Plan §2.6 — emit file-level import edges for "Where used" rendering
  // and /explain caller-domain analysis. Filter out external deps via
  // cruiser-emitted metadata (Gemini-R1-G3, Gemini-R2-G1).
  const modules = result.output?.modules || [];
  let importCount = 0;
  // Every dependency the cruise offered lands in exactly ONE bucket. Each of
  // these three drops is individually defensible and none was ever counted —
  // that silence is the defect (plan §2.1.2). `cruisedEdges` is the total the
  // exhaustivity assertion holds them to.
  const edges = { external: 0, selfEdge: 0, escaping: 0, persisted: 0 };
  let cruisedEdges = 0;
  for (const m of modules) {
    if (!m.source) continue;
    const importer = path.relative(repoRoot, m.source).replace(/\\/g, '/');
    for (const d of (m.dependencies || [])) {
      cruisedEdges++;
      if (!isInternalEdge(d)) { edges.external++; continue; }
      const imported = path.relative(repoRoot, d.resolved).replace(/\\/g, '/');
      // Skip self-edges and edges that escape the repo (..)
      if (imported === importer) { edges.selfEdge++; continue; }
      if (imported.startsWith('..')) { edges.escaping++; continue; }
      emit({ type: 'import', importer, imported });
      edges.persisted++;
      importCount++;
    }
  }

  if (!measure) return { violationCount: violations.length, importCount };

  const coverage = assessExtractionCoverage({
    outcome: 'ok',
    eligible,
    cruisedSources: modules.map(m => m.source).filter(Boolean),
    repoRoot,
    // dep-cruiser emits `source` relative to ITS process CWD, which is not
    // necessarily repoRoot. Resolving against repoRoot is correct only when
    // the two coincide — the assumption normalizeRepoPath exists to remove.
    cruisedBase: process.cwd(),
    elapsedMs,
    edges,
    sampleCap,
  });

  const exhaustive = assertExtractionExhaustive(coverage, cruisedEdges);
  if (!exhaustive.ok) {
    // Loud, but never fatal (#16): a bucket that stops adding up is a NEW
    // silent loss site, which is worth shouting about — and is still better
    // information than a failed refresh.
    emitProgress(`WARNING: edge buckets do not account for every cruised edge `
      + `(counted ${exhaustive.actual}, cruise offered ${exhaustive.expected}). `
      + `A filter was likely added without a bucket — see plan §2.1.2.`);
  }

  emitCoverage(coverage);
  const pct = coverage.ratio == null ? 'n/a' : `${(coverage.ratio * 100).toFixed(1)}%`;
  emitProgress(`coverage: ${coverage.cruised}/${coverage.eligible} eligible source files `
    + `cruised (${pct}) in ${elapsedMs}ms — edges: ${edges.persisted} persisted, `
    + `${edges.external} external, ${edges.selfEdge} self, ${edges.escaping} escaping`);

  return { violationCount: violations.length, importCount, coverage };
}

/**
 * Emit the extraction-layer coverage record for `refresh.mjs` to persist
 * (plan §2.1.7). Extract owns ONLY the extraction layer — the verdict,
 * `measuredAt`, and the `refreshId` it is keyed on all belong to the parent
 * process, which is the one that knows the snapshot identity. Emitting a
 * verdict here would create a second oracle.
 *
 * `schemaVersion` ships from day one so a future shape change is a version
 * bump rather than a guess at the reader.
 */
function emitCoverage(extraction) {
  emit({ type: 'coverage', schemaVersion: 1, extraction });
}

/**
 * Determine whether a dep-cruiser dependency edge points at an internal
 * file (worth persisting) versus an external dep (node_modules, Node
 * builtin) we should skip.
 *
 * Plan v6 §2.6 — uses dep-cruiser's `coreModule` flag and
 * `dependencyTypes` array as primary signals (Gemini-R2-G1: string
 * matching alone misses `fs/promises`, `util/types`, `stream/web` —
 * core modules with slashes). String checks are defence-in-depth.
 *
 * Exported for unit testing.
 */
export function isInternalEdge(dep) {
  if (!dep || typeof dep.resolved !== 'string') return false;
  // Authoritative dep-cruiser metadata
  if (dep.coreModule === true) return false;
  const types = dep.dependencyTypes || [];
  if (types.includes('core')) return false;
  if (types.includes('npm')) return false;
  if (types.includes('npm-dev')) return false;
  if (types.includes('npm-optional')) return false;
  if (types.includes('npm-peer')) return false;
  if (types.includes('npm-bundled')) return false;
  // Defence-in-depth string checks
  const r = dep.resolved;
  if (r.includes('node_modules/') || r.includes('node_modules\\')) return false;
  if (r.startsWith('node:')) return false;
  return true;
}

/**
 * @param {string} repoRoot
 * @param {string[]|null} restrictFiles
 * @returns {string[]} absolute file paths
 */
// Directory names skipped during enumeration. Found live: wine-cellar-app
// hung in ts-morph for 30+ min when walking `dist/` (bundled minified JS).
// Build outputs, caches, and generated artifacts are noise for symbol
// extraction and would also fire the dep-cruiser exclude regex anyway.
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.audit-loop',
  'dist', 'build', 'out', 'coverage',
  '.next', '.nuxt', '.cache', '.parcel-cache', '.turbo', '.svelte-kit',
  '.vite', '.vercel', '.netlify', '.serverless',
  'public/build', // common Remix/RR pattern; real bundled output
  // .claude is Claude Code's per-repo state. Worktrees inside (.claude/worktrees/*)
  // duplicate the full source tree N times — found live: wine-cellar had 5
  // worktrees inflating its file count from ~1500 to 7635, OOM'ing ts-morph.
  '.claude',
]);

// Files larger than this are skipped entirely. Found live: wine-cellar-app
// hung in ts-morph at 4.3GB heap, almost certainly parsing a generated /
// bundled file of multiple MB. Real source files (functions, components)
// rarely exceed 100KB; 500KB is a generous cap that preserves all real code.
const MAX_FILE_BYTES = 500 * 1024;

// Exported for MEASUREMENT ONLY (2026-07-18) — `scripts/spikes/observed-graph-
// discovery-spike.mjs` must measure the REAL symbol-layer enumerator, because
// the whole question it answers is whether this walker's inventory can be fed
// to dep-cruiser. Measuring a re-implementation would reproduce the exact
// layers-disagree bug the spike exists to investigate. Exporting a pure,
// side-effect-free walker is not an implementation of
// docs/plans/observed-graph-discovery-unification.md design (e) — that plan
// remains blocked on the measurements this export enables.
/**
 * Pure gate for the coverage-measurement "was this a full run" decision
 * (b021576b). `null` means no restriction was ever passed (--files/
 * --files-from absent) — the only genuine full-run case. `[]` means a
 * restriction WAS passed and resolved to zero files (e.g. an incremental
 * diff touching only docs/config) — a real, valid, ZERO-file incremental
 * run, not a full one; measuring it as full would compute the coverage
 * ratio against the wrong denominator (plan §2.1.3 row 4).
 *
 * @param {string[]|null} files - `args.files` as parsed by parseArgs
 * @returns {boolean}
 */
export function isFullRunFromFiles(files) {
  return files === null;
}

export function enumerateFiles(repoRoot, restrictFiles) {
  // b021576b: `null` means "no restriction, full walk"; `[]` means "a valid
  // incremental scope of ZERO files" (e.g. a diff touching only docs/config).
  // The old `.length > 0` check treated both the same, silently falling back
  // to a full repo walk when the caller's resolved scope was legitimately
  // empty. `!== null` is the correct test.
  if (restrictFiles !== null) {
    return restrictFiles.map(f => path.isAbsolute(f) ? f : path.join(repoRoot, f));
  }
  // Default: walk repo for source files. Keep the walk small + fast.
  const out = [];
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) out.push(full);
    }
  }
  walk(repoRoot);
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  const repoRoot = path.resolve(args.root);
  const files = enumerateFiles(repoRoot, args.files);
  if (args.includeDelegates) {
    emitProgress('WARNING: --include-delegates is a debug/visibility flag. The resulting index includes thin-facade duplicates and should not be used as a baseline snapshot — re-run without the flag for normal operations.');
  }
  emitProgress(`scanning ${files.length} files (mode=${args.mode})`);
  const stats = extractSymbols(files, repoRoot, { includeDelegates: args.includeDelegates });
  // Coverage is a FULL-RUN measurement (plan §2.1.3 row 4). On an incremental
  // run `files` is the caller's restricted list, not the repo's universe, so
  // measuring against it would produce a real-looking ratio computed from the
  // wrong denominator. Pass null and let refresh.mjs copy the prior row
  // forward as stale instead.
  const isFullRun = isFullRunFromFiles(args.files);
  // §2.1.1's third clause: a file this pipeline refuses to read must not count
  // against the denominator. An unreadable file is excluded for the same
  // reason — it is not a coverage failure, and failing closed here would
  // understate coverage on precisely the repos with generated monsters.
  //
  // A file whose size cannot be read is excluded too — but note the direction:
  // excluding SHRINKS the denominator and RAISES the reported ratio. That is
  // the optimistic direction, so it must never be silent (final-gate M6). It
  // is counted and warned about; a repo where this fires often is a repo whose
  // coverage number deserves suspicion.
  let statFailures = 0;
  const isTooLarge = (abs) => {
    try {
      return fs.statSync(abs).size > MAX_FILE_BYTES;
    } catch {
      statFailures++;
      return true;
    }
  };
  const eligible = isFullRun ? eligibleFiles(files, { repoRoot, isTooLarge }) : null;
  if (statFailures > 0) {
    emitProgress(`WARNING: ${statFailures} file(s) excluded from the coverage `
      + `denominator because their size could not be read — the reported ratio `
      + `is optimistic by that much.`);
  }
  const graphStats = await extractGraphAndViolations(repoRoot, { eligible });
  // `coverage` travels on its own `{type:'coverage'}` line, not inside
  // `counts` — that field is a flat scalar bag and consumers treat it as one.
  const { coverage: _coverage, ...graphCounts } = graphStats;
  emit({ type: 'summary', counts: { ...stats, ...graphCounts } });
  emitProgress(`done — symbols=${stats.symbolCount} violations=${graphStats.violationCount} skipped-path=${stats.skippedPath} skipped-ext=${stats.skippedExt} skipped-size=${stats.skippedSize} skipped-delegate=${stats.skippedDelegate} redacted=${stats.redacted} stat-failures=${stats.statFailures} parse-failures=${stats.parseFailures}`);
}

// CLI-only entry guard (2026-07-18). `main()` used to run unconditionally at
// module scope, so ANY `import` of this file kicked off a full symbol
// extraction — minutes of work, plus JSON-lines spraying onto the importer's
// stdout. That made the module effectively un-importable, which is very likely
// why `enumerateFiles` had no export and no direct test despite being a pure,
// obviously-testable walker. Found while writing
// `scripts/spikes/observed-graph-discovery-spike.mjs`, which needs the real
// enumerator. Same idiom as gemini-review.mjs / cache-hitrate-check.mjs;
// `node scripts/symbol-index/extract.mjs ...` behaves exactly as before.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    process.stderr.write(`extract: fatal: ${err.stack || err.message}\n`);
    process.exit(1);
  });
}

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
import { Project } from 'ts-morph';
import { cruise } from 'dependency-cruiser';
import { signatureHash } from '../lib/symbol-index.mjs';
import {
  gateSymbolForEgress,
  isPathSensitive,
  isExtensionAllowlisted,
  containsSecrets,
  redactSecrets,
  SECRET_REDACTED,
} from '../lib/sensitive-egress-gate.mjs';
import { isThinDelegate } from '../lib/symbol-index/thin-delegate.mjs';

function parseArgs(argv) {
  const args = { root: process.cwd(), files: null, mode: 'full', sinceCommit: null, includeDelegates: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') args.root = argv[++i];
    else if (a === '--files') args.files = argv[++i].split(',').filter(Boolean);
    else if (a === '--mode') args.mode = argv[++i];
    else if (a === '--since-commit') args.sinceCommit = argv[++i];
    else if (a === '--include-delegates') args.includeDelegates = true;
  }
  return args;
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
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
 * @returns {{symbolCount: number, skippedPath: number, skippedExt: number, skippedSize: number, skippedDelegate: number, redacted: number}}
 */
function extractSymbols(filePaths, repoRoot, opts = {}) {
  const stats = { symbolCount: 0, skippedPath: 0, skippedExt: 0, skippedSize: 0, skippedDelegate: 0, redacted: 0 };
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
    if (isPathSensitive(rel)) {
      stats.skippedPath++;
      emitProgress(`skip-path: ${rel}`);
      continue;
    }
    if (!isExtensionAllowlisted(rel)) {
      stats.skippedExt++;
      continue;
    }
    // Size cap — skip generated/bundled monsters before they OOM ts-morph
    try {
      const size = fs.statSync(abs).size;
      if (size > MAX_FILE_BYTES) {
        stats.skippedSize++;
        emitProgress(`skip-size: ${rel} (${Math.round(size/1024)}KB > ${MAX_FILE_BYTES/1024}KB)`);
        continue;
      }
    } catch { /* stat fail → skip */ continue; }
    let sf;
    try {
      sf = project.addSourceFileAtPathIfExists(abs);
    } catch (err) {
      emitProgress(`parse-error: ${rel} — ${err.message}`);
      continue;
    }
    if (!sf) continue;

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
      const decision = gateSymbolForEgress({ filePath: rel, bodyText: c.bodyText });
      if (decision.action === 'skip-path' || decision.action === 'skip-extension') {
        // Already filtered above; defensive
        continue;
      }
      const willRedact = decision.action === 'redact-content';
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

  return stats;
}

/**
 * Walk the file-to-file graph + emit any layering violations.
 * Violations come from `.dependency-cruiser.cjs` config if present in repo,
 * else default heuristics.
 */
async function extractGraphAndViolations(repoRoot) {
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
    cruiseOpts.ruleSet = (await import(localConfig)).default;
  }

  // Common JS/TS source-dir conventions, plus a fallback to the repo root
  // (dep-cruiser will then walk everything not excluded above).
  const COMMON_SOURCE_DIRS = [
    'scripts', 'src', 'lib', 'app', 'apps', 'packages',
    'components', 'pages', 'server', 'api', 'routes',
    'frontend', 'backend', 'client',
  ];
  let targets = COMMON_SOURCE_DIRS
    .map(d => path.join(repoRoot, d))
    .filter(p => fs.existsSync(p));
  if (targets.length === 0) targets = [repoRoot];

  let result;
  try {
    result = await cruise(targets, cruiseOpts);
  } catch (err) {
    emitProgress(`dep-cruiser failed: ${err.message}`);
    return { violationCount: 0 };
  }

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
  for (const m of modules) {
    if (!m.source) continue;
    const importer = path.relative(repoRoot, m.source).replace(/\\/g, '/');
    for (const d of (m.dependencies || [])) {
      if (!isInternalEdge(d)) continue;
      const imported = path.relative(repoRoot, d.resolved).replace(/\\/g, '/');
      // Skip self-edges and edges that escape the repo (..)
      if (imported === importer) continue;
      if (imported.startsWith('..')) continue;
      emit({ type: 'import', importer, imported });
      importCount++;
    }
  }

  return { violationCount: violations.length, importCount };
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

function enumerateFiles(repoRoot, restrictFiles) {
  if (restrictFiles && restrictFiles.length > 0) {
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
  const graphStats = await extractGraphAndViolations(repoRoot);
  emit({ type: 'summary', counts: { ...stats, ...graphStats } });
  emitProgress(`done — symbols=${stats.symbolCount} violations=${graphStats.violationCount} skipped-path=${stats.skippedPath} skipped-ext=${stats.skippedExt} skipped-size=${stats.skippedSize} skipped-delegate=${stats.skippedDelegate} redacted=${stats.redacted}`);
}

main().catch(err => {
  process.stderr.write(`extract: fatal: ${err.stack || err.message}\n`);
  process.exit(1);
});

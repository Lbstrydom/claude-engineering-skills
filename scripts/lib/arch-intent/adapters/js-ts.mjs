/**
 * @fileoverview JS/TS adapter for the architecture-intent framework.
 *
 * Uses `dependency-cruiser` to extract the import graph.  Given the
 * pre-mapped files from Phase 1 (orchestrator owns inventory), this
 * adapter ONLY does edge analysis: for each edge (fromFile → toFile),
 * resolve domains via the map, check `allowedDeps`, emit violations.
 *
 * Canonical edge-kind taxonomy (plan §2 decision via R2/M5 fix):
 *   - local-file              → resolved relative import; check allowedDeps
 *   - vendor-npm              → node_modules dep; mapped to `vendor` (always-allowed)
 *   - vendor-node-builtin     → node:fs etc.; mapped to `vendor`
 *   - vendor-typescript-alias → resolves through tsconfig paths → treat as local-file
 *   - unresolved              → dep-cruiser couldn't resolve; recorded in _meta, NOT flagged
 *   - dynamic                 → await import(...); recorded in _meta, NOT flagged for
 *                               allowedDeps violations. When dep-cruiser DOES resolve it
 *                               (a literal specifier, e.g. await import('./x.mjs')) it also
 *                               counts as a caller in the orphan-graph track, same as
 *                               type-only — a variable specifier stays unresolvable either way.
 *   - type-only               → TS `import type`; EXCLUDED from the violations graph
 *
 * @module scripts/lib/arch-intent/adapters/js-ts
 */

import path from 'node:path';
import { cruise } from 'dependency-cruiser';
import { resolveFileToDomain, checkDepAllowed, VENDOR_DOMAIN } from '../domain-resolver.mjs';

const VERSION = 'js-ts-1.0.0';

/**
 * Classify a dependency-cruiser edge into one of the canonical edge kinds.
 *
 * @param {object} dep - one entry from cruise() output's `modules[].dependencies[]`
 * @returns {'local-file'|'vendor-npm'|'vendor-node-builtin'|'vendor-typescript-alias'|'unresolved'|'dynamic'|'type-only'}
 */
function classifyEdge(dep) {
  if (dep.dependencyTypes?.includes('type-only')) return 'type-only';
  if (dep.dynamic) return 'dynamic';
  if (dep.couldNotResolve) return 'unresolved';
  // Node built-in: dependencyTypes includes 'core' or 'node-internal'
  if (dep.dependencyTypes?.some(t => t === 'core' || t === 'node_internal' || t === 'node-internal')) {
    return 'vendor-node-builtin';
  }
  // npm package: dependencyTypes has 'npm' / 'npm-dev' / 'npm-peer' / etc
  if (dep.dependencyTypes?.some(t => t.startsWith('npm'))) return 'vendor-npm';
  // TS path alias: dep.module starts with non-relative + resolved is a real file → typescript-alias
  if (dep.dependencyTypes?.includes('aliased') || dep.dependencyTypes?.includes('aliased-tsconfig')) {
    return 'vendor-typescript-alias';
  }
  // Otherwise: local file
  return 'local-file';
}

/**
 * Normalise paths for domain resolution (forward-slash, repo-relative).
 *
 * @param {string} p
 * @param {string} repoPath
 * @returns {string}
 */
function normalisePath(p, repoPath) {
  if (!p) return p;
  let abs = p;
  if (!path.isAbsolute(abs)) abs = path.join(repoPath, abs);
  return path.relative(repoPath, abs).replaceAll('\\', '/');
}

/**
 * Run the import-graph analysis.
 *
 * @param {object} opts
 * @param {Map<string, string>} opts.mapped - filePath → domain (from Phase 1)
 * @param {object} opts.domainMap - typed config with rules + allowedDeps
 * @param {string} opts.repoPath
 * @returns {Promise<{ violations: Array, _meta: object, analyzerVersion: string }>}
 */
export default async function analyseImports({ mapped, domainMap, repoPath }) {
  // Cruise against the mapped files (rooted at repoPath).  dependency-cruiser
  // wants absolute paths or paths relative to cwd; we pass the repo paths and
  // include `tsConfig`-style aliases if present.
  const targets = Array.from(mapped.keys()).map(p => path.join(repoPath, p));
  if (targets.length === 0) {
    // audit-code R2/M3 — early-return must produce the SAME _meta shape as
    // the full path so downstream consumers (orphan-introduced detector,
    // schema validators) never see partial keys.
    return {
      violations: [],
      _meta: {
        edgeCount: 0,
        localFileEdges: 0,
        vendorEdges: 0,
        unresolvedEdges: [],
        dynamicEdges: [],
        typeOnlyEdges: 0,
        callersByTarget: {},
        targetsByCaller: {},
        allFiles: [],
      },
      analyzerVersion: VERSION,
    };
  }

  const cruiseOpts = {
    doNotFollow: { path: 'node_modules' },
    exclude: 'node_modules',
    tsConfig: { fileName: path.join(repoPath, 'tsconfig.json') },
  };

  let result;
  try {
    result = await cruise(targets, cruiseOpts);
  } catch (err) {
    // dependency-cruiser sometimes throws on a missing tsconfig — retry without it
    if (/tsconfig/.test(err.message)) {
      delete cruiseOpts.tsConfig;
      result = await cruise(targets, cruiseOpts);
    } else {
      throw err;
    }
  }

  const violations = [];
  const meta = {
    edgeCount: 0,
    localFileEdges: 0,
    vendorEdges: 0,
    unresolvedEdges: [],
    dynamicEdges: [],
    typeOnlyEdges: 0,
    // Two-track graph exposed for the orphan-introduced detector
    // (Gemini-R3/H1 + R1/M1 fix). Violations track skips type-only;
    // orphan-graph track INCLUDES type-only edges (type imports keep
    // files alive structurally). Stored as plain objects so they
    // serialise through the schema-validated _meta record.
    callersByTarget: {}, // Map<targetPath, callerPath[]> — includes type-only
    targetsByCaller: {}, // Map<callerPath, targetPath[]> — includes type-only
    allFiles: [],        // sorted unique repo-relative paths
  };

  // Working maps that we serialise into meta at the end.
  const callersByTarget = new Map();
  const targetsByCaller = new Map();
  const allFilesSet = new Set();

  function recordGraphEdge(fromRel, toFile) {
    if (!callersByTarget.has(toFile)) callersByTarget.set(toFile, new Set());
    callersByTarget.get(toFile).add(fromRel);
    if (!targetsByCaller.has(fromRel)) targetsByCaller.set(fromRel, new Set());
    targetsByCaller.get(fromRel).add(toFile);
  }

  for (const mod of (result.output?.modules ?? [])) {
    const fromRel = normalisePath(mod.source, repoPath);
    allFilesSet.add(fromRel);
    const fromDomain = mapped.get(fromRel) ?? resolveFileToDomain(fromRel, domainMap.rules);
    if (!fromDomain) continue; // file isn't in our mapped set — skip violations check

    for (const dep of (mod.dependencies ?? [])) {
      meta.edgeCount += 1;
      const kind = classifyEdge(dep);

      // Record into orphan-graph for ALL edges that resolve to a local file
      // (type-only INCLUDED — Gemini-R3/H1). A literal `await import('./x.mjs')`
      // is dep-cruiser-resolvable exactly like a static import (dep.resolved is
      // populated even though dep.dynamic is true) — dead-code-phase-1-followup
      // fix: count it as "has a caller" too, or the orphan detector flags the
      // dynamically-imported file as a false-positive born-orphan. Skip
      // unresolved/vendor — those aren't local-file structural dependencies.
      // A dynamic import whose specifier is a variable (dep.resolved absent)
      // still can't be counted — that's the genuinely unresolvable case.
      if (kind === 'local-file' || kind === 'vendor-typescript-alias' || kind === 'type-only' || kind === 'dynamic') {
        if (dep.resolved && !dep.couldNotResolve) {
          const toFileForGraph = normalisePath(dep.resolved, repoPath);
          if (toFileForGraph && !toFileForGraph.startsWith('..')) {
            allFilesSet.add(toFileForGraph);
            recordGraphEdge(fromRel, toFileForGraph);
          }
        }
      }

      // Continue with violations-track (existing behaviour — type-only excluded).
      if (kind === 'type-only') { meta.typeOnlyEdges += 1; continue; }
      if (kind === 'unresolved') { meta.unresolvedEdges.push({ from: fromRel, to: dep.module }); continue; }
      if (kind === 'dynamic') { meta.dynamicEdges.push({ from: fromRel, to: dep.module }); continue; }

      let toDomain;
      let toFile;
      if (kind === 'vendor-npm' || kind === 'vendor-node-builtin') {
        toDomain = VENDOR_DOMAIN;
        toFile = dep.module; // package name, not a file
        meta.vendorEdges += 1;
      } else {
        // local-file OR vendor-typescript-alias (resolved to a local file)
        toFile = normalisePath(dep.resolved, repoPath);
        toDomain = mapped.get(toFile) ?? resolveFileToDomain(toFile, domainMap.rules);
        if (!toDomain) {
          // To-file isn't in our mapping — could be a test-fixture or unmapped utility.
          // Treat as a soft signal: skip; the file shows up in unmappedFiles anyway.
          continue;
        }
        meta.localFileEdges += 1;
      }

      if (!checkDepAllowed(fromDomain, toDomain, domainMap.allowedDeps)) {
        violations.push({
          fromFile: fromRel,
          toFile,
          fromDomain,
          toDomain,
          ruleViolated: 'not-in-allowedDeps',
        });
      }
    }
  }

  // Serialise orphan-graph maps into meta as plain JSON-friendly objects.
  const cmp = (a, b) => a.localeCompare(b);
  for (const [k, v] of callersByTarget) meta.callersByTarget[k] = Array.from(v).sort(cmp);
  for (const [k, v] of targetsByCaller) meta.targetsByCaller[k] = Array.from(v).sort(cmp);
  meta.allFiles = Array.from(allFilesSet).sort(cmp);

  return { violations, _meta: meta, analyzerVersion: VERSION };
}

/**
 * @fileoverview The finalization-split dependency-direction oracle
 * (docs/plans/legacy-production-audit-decomposition.md §4): asserts the
 * exact allow-list the plan declares for the coordinator + its 3 stage
 * modules, DERIVED from each file's own import statements — not a hand-kept
 * list of "the edges we remember adding" (same reasoning as
 * tests/arm-vocabulary-layering.test.mjs's docblock: a derived oracle can see
 * an edge nobody told it about; a hand-listed one only proves someone updated
 * it).
 *
 * Allow-list (plan §4, "dependency direction"): `legacy-production-audit.mjs`
 * may import the pass modules + pass-result-cache.mjs + map-reduce-
 * scheduler.mjs + run-finalization.mjs; `run-finalization.mjs` may import
 * `finalization-contract.mjs` + the 3 stage modules; each stage module may
 * import `finalization-contract.mjs` + pre-existing domain primitives.
 * PROHIBITED: stage-to-stage imports (4b importing 4c, etc.), any new module
 * importing back into `legacy-production-audit.mjs`, and any cycle.
 *
 * Three DOCUMENTED, narrow exceptions to the plan's literal text, each found
 * during implementation and asserted explicitly below rather than silently
 * allowed or silently missed: the spine importing `validateLedgerForR2`/
 * `buildSuppressionStats` from `run-persistence.mjs` (the R2+ ledger
 * preflight runs before any wave, genuinely earlier than the coordinator);
 * the coordinator importing `collectReducePassStatuses` from
 * `pass-result-cache.mjs`; and `finding-assembly.mjs` importing
 * `getSeedTelemetry` from `map-reduce-scheduler.mjs`. All three surfaced
 * from a union-diff final-review pass, not from the plan's own audit rounds.
 *
 * @module tests/finalization-module-layering.test
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AUDIT_DIR = path.join(REPO, 'scripts', 'lib', 'audit');

const STAGE_MODULES = ['finding-assembly.mjs', 'run-telemetry.mjs', 'run-persistence.mjs'];
const COORDINATOR = 'run-finalization.mjs';
const SPINE = 'legacy-production-audit.mjs';
const CONTRACT = 'finalization-contract.mjs';
// Every module this whole decomposition (Clusters A/B/C) created — the set
// the "pre-existing domain primitives" exemption does NOT cover. A sibling
// import outside this set (findings-pipeline.mjs, finding-verification.mjs,
// llm-helpers.mjs, ledger.mjs, ...) is a pre-existing primitive the plan
// always allowed and this suite has no opinion on.
const NEW_AUDIT_MODULES = new Set([
  ...STAGE_MODULES, COORDINATOR, CONTRACT, 'pass-result-cache.mjs', 'map-reduce-scheduler.mjs',
  'architecture-pass.mjs', 'orphan-pass.mjs', 'event-wiring-pass.mjs', 'duplication-pass.mjs', 'adjacency-pass.mjs',
]);

/** Local-relative specifiers this module's static + dynamic imports name. */
function importedLocalSpecifiers(filename) {
  const src = fs.readFileSync(path.join(AUDIT_DIR, filename), 'utf8');
  const specifiers = [];
  for (const m of src.matchAll(/from\s+'(\.[^']+)'/g)) specifiers.push(m[1]);
  for (const m of src.matchAll(/import\(\s*'(\.[^']+)'\s*\)/g)) specifiers.push(m[1]);
  return specifiers;
}

/** Names this module imports FROM a given local specifier (both `import {...} from` and `export {...} from`). */
function namedBindingsFrom(filename, specifier) {
  const src = fs.readFileSync(path.join(AUDIT_DIR, filename), 'utf8');
  const names = [];
  const re = new RegExp(String.raw`(?:import|export)\s*\{([^}]*)\}\s*from\s*'${specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`, 'g');
  for (const m of src.matchAll(re)) {
    for (const raw of m[1].split(',')) {
      const name = raw.split(' as ')[0].trim();
      if (name) names.push(name);
    }
  }
  return names;
}

/** Basename of a same-directory ('./x.mjs') specifier, or null if it isn't one. */
function sameDirBasename(specifier) {
  if (!specifier.startsWith('./')) return null;
  return specifier.slice(2);
}

describe('finalization-split module layering (derived from real imports)', () => {
  it('precondition: the 4 new modules + the spine all exist and are non-trivial', () => {
    for (const f of [...STAGE_MODULES, COORDINATOR, SPINE]) {
      const p = path.join(AUDIT_DIR, f);
      assert.ok(fs.existsSync(p), `expected ${f} to exist at ${p}`);
      assert.ok(fs.statSync(p).size > 500, `${f} is implausibly small — the oracle would pass vacuously`);
    }
  });

  it('no stage module imports another stage module (4b/4c/4d never import each other)', () => {
    const violations = [];
    for (const stage of STAGE_MODULES) {
      const localImports = importedLocalSpecifiers(stage).map(sameDirBasename).filter(Boolean);
      for (const target of STAGE_MODULES) {
        if (target === stage) continue;
        if (localImports.includes(target)) violations.push(`${stage} -> ${target}`);
      }
    }
    assert.deepEqual(violations, [], `stage-to-stage import(s) found (prohibited by the plan's dependency direction): ${violations.join(', ')}`);
  });

  it('no stage module, and the coordinator, import back into the spine', () => {
    const violations = [];
    for (const f of [...STAGE_MODULES, COORDINATOR]) {
      const localImports = importedLocalSpecifiers(f).map(sameDirBasename).filter(Boolean);
      if (localImports.includes(SPINE)) violations.push(f);
    }
    assert.deepEqual(violations, [], `module(s) importing back into ${SPINE} (prohibited — this is the cycle the plan's dependency direction forbids): ${violations.join(', ')}`);
  });

  it('the spine imports the coordinator for finalization, and never the finding-assembly/telemetry stage modules directly', () => {
    const spineLocalImports = importedLocalSpecifiers(SPINE).map(sameDirBasename).filter(Boolean);
    assert.ok(spineLocalImports.includes(COORDINATOR), `${SPINE} must import ${COORDINATOR} — the finalization call site`);
    // finding-assembly.mjs and run-telemetry.mjs are reached ONLY through the
    // coordinator — a direct spine import of either would bypass the 4b-4d-4c
    // sequencing the coordinator exists to own.
    const forbidden = ['finding-assembly.mjs', 'run-telemetry.mjs'].filter((s) => spineLocalImports.includes(s));
    assert.deepEqual(forbidden, [], `${SPINE} imports a stage module directly, bypassing the coordinator: ${forbidden.join(', ')}`);
  });

  it('the spine\'s run-persistence.mjs import is the documented pre-finalization exception (ledger preflight), never the stage function', () => {
    // validateLedgerForR2/buildSuppressionStats run BEFORE any wave executes
    // (R2+ ledger preflight, and a re-export kept for Phase-5-close-out
    // backwards compatibility) — genuinely earlier than the coordinator, which
    // only runs once every wave has completed, so this is not a finalization
    // bypass. What WOULD be a bypass: importing `runPersistence` itself
    // (the stage function the coordinator calls) directly into the spine.
    const spineLocalImports = importedLocalSpecifiers(SPINE).map(sameDirBasename).filter(Boolean);
    if (!spineLocalImports.includes('run-persistence.mjs')) return; // nothing to check
    const bound = namedBindingsFrom(SPINE, './run-persistence.mjs');
    assert.ok(bound.length > 0, 'run-persistence.mjs is imported but no named bindings were parsed — the regex may have rotted');
    assert.deepEqual(
      bound.filter((n) => !['validateLedgerForR2', 'buildSuppressionStats'].includes(n)),
      [],
      `unexpected binding(s) imported from run-persistence.mjs into the spine — only the documented pre-finalization exception is allowed: ${bound.join(', ')}`,
    );
    assert.ok(!bound.includes('runPersistence'), 'the spine must never import runPersistence directly — that IS the coordinator bypass this suite exists to catch');
  });

  it('the coordinator imports all 3 stage modules', () => {
    const coordLocalImports = importedLocalSpecifiers(COORDINATOR).map(sameDirBasename).filter(Boolean);
    for (const stage of STAGE_MODULES) {
      assert.ok(coordLocalImports.includes(stage), `${COORDINATOR} must import ${stage}`);
    }
  });

  it('the coordinator\'s pass-result-cache.mjs import is the documented allow-list exception, nothing else', () => {
    // Final-review finding (union-diff gate): the plan's literal text says
    // run-finalization.mjs "may import finalization-contract.mjs and the 3
    // stage modules" — collectReducePassStatuses (pass-result-cache.mjs, a
    // pre-existing Phase-1 module) is a genuine, narrow exception the
    // coordinator needs to build `_executionMeta` from `passRegistry`
    // (4b's own output) without duplicating that one aggregation. Documented
    // here rather than silently allowed: any OTHER binding pulled from
    // pass-result-cache.mjs, or a binding from any audit-local sibling not on
    // this list, is exactly the kind of import-graph drift this suite exists
    // to catch.
    const coordLocalImports = importedLocalSpecifiers(COORDINATOR).map(sameDirBasename).filter(Boolean);
    const ALLOWED_NEW_SIBLINGS = new Set([...STAGE_MODULES, CONTRACT, 'pass-result-cache.mjs']);
    const unexpected = coordLocalImports.filter((b) => NEW_AUDIT_MODULES.has(b) && !ALLOWED_NEW_SIBLINGS.has(b));
    assert.deepEqual(unexpected, [], `${COORDINATOR} imports an undocumented new-module sibling: ${unexpected.join(', ')}`);
    if (!coordLocalImports.includes('pass-result-cache.mjs')) return; // nothing further to check
    const bound = namedBindingsFrom(COORDINATOR, './pass-result-cache.mjs');
    assert.deepEqual(bound, ['collectReducePassStatuses'], `unexpected binding(s) imported from pass-result-cache.mjs into the coordinator: ${bound.join(', ')}`);
  });

  it('finding-assembly.mjs\'s map-reduce-scheduler.mjs import is the documented allow-list exception, nothing else', () => {
    // Final-review finding (union-diff gate): the plan's literal text says a
    // stage module may import only finalization-contract.mjs and
    // "pre-existing domain primitives (ledger.mjs, findings-pipeline.mjs,
    // etc.)" — map-reduce-scheduler.mjs is itself a NEW Phase-2 module of
    // this same decomposition, not a pre-existing primitive. getSeedTelemetry
    // is a genuine, narrow exception: 4b's cache-metrics computation (moved
    // here because it is a direct continuation of pass-registry assembly)
    // needs the run-scoped cache-seed state map-reduce-scheduler.mjs already
    // owns. Documented rather than silently allowed, same reasoning as the
    // coordinator's pass-result-cache.mjs exception above.
    const stageLocalImports = importedLocalSpecifiers('finding-assembly.mjs').map(sameDirBasename).filter(Boolean);
    const ALLOWED_NEW_SIBLINGS = new Set([CONTRACT, 'map-reduce-scheduler.mjs']);
    const unexpected = stageLocalImports.filter((b) => NEW_AUDIT_MODULES.has(b) && !ALLOWED_NEW_SIBLINGS.has(b));
    assert.deepEqual(unexpected, [], `finding-assembly.mjs imports an undocumented new-module sibling: ${unexpected.join(', ')}`);
    if (!stageLocalImports.includes('map-reduce-scheduler.mjs')) return; // nothing further to check
    const bound = namedBindingsFrom('finding-assembly.mjs', './map-reduce-scheduler.mjs');
    assert.deepEqual(bound, ['getSeedTelemetry'], `unexpected binding(s) imported from map-reduce-scheduler.mjs into finding-assembly.mjs: ${bound.join(', ')}`);
  });

  it('no import cycle exists among the coordinator + stage modules (derived, transitive)', () => {
    const NODES = [...STAGE_MODULES, COORDINATOR];
    const graph = new Map(NODES.map((f) => [f, importedLocalSpecifiers(f).map(sameDirBasename).filter((b) => b && NODES.includes(b))]));
    const visiting = new Set();
    const visited = new Set();
    const cyclePath = [];
    function dfs(node) {
      if (visited.has(node)) return false;
      if (visiting.has(node)) { cyclePath.push(node); return true; }
      visiting.add(node);
      cyclePath.push(node);
      for (const dep of graph.get(node) ?? []) {
        if (dfs(dep)) return true;
      }
      cyclePath.pop();
      visiting.delete(node);
      visited.add(node);
      return false;
    }
    let found = false;
    for (const n of NODES) {
      if (dfs(n)) { found = true; break; }
    }
    assert.equal(found, false, `import cycle detected: ${cyclePath.join(' -> ')}`);
  });
});

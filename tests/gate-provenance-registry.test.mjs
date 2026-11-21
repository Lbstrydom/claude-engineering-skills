/**
 * Registry tests: schema strictness, glob semantics, and the FILESYSTEM CENSUS - every gate-defining file that git tracks
 * must be registered. The census iterates the tracked tree, the only side that can see a file no list mentions.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { collectImportClosure } from '../scripts/lib/module-graph.mjs';
import {
  parseRegistry, globToRegExp, matchEntry, expandRegistry, gateEntryPoints, CLASSIFIER_KINDS, REGISTRY_PATH,
} from '../scripts/lib/gate-provenance/registry.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean);
const loaded = parseRegistry(fs.readFileSync(path.join(ROOT, REGISTRY_PATH), 'utf8'));

/** Candidate gate-defining files, derived from the tracked tree by shape - never from the registry. */
function candidates(files) {
  return files.filter((f) => !f.startsWith('docs/') && !f.startsWith('tests/') && (
    /(^|\/)[^/]*baseline\.json$/.test(f)
    || /^scripts\/gate-contracts\/[^/]+\.json$/.test(f)
    || /^skills\/[^/]+\/gate-contract\.json$/.test(f)
    || f === '.anthropic-pin-census.json'
  ));
}
const unregistered = (registry, files) => candidates(files).filter((f) => !matchEntry(registry, f));

test('the committed registry parses', () => {
  assert.ok(loaded.ok, loaded.ok ? '' : loaded.error);
  assert.ok(loaded.registry.files.every((e) => CLASSIFIER_KINDS.includes(e.kind)));
});

test('schema is strict: an unknown field or kind fails to parse', () => {
  assert.equal(parseRegistry(JSON.stringify({ version: 1, files: [], gates: [], extra: 1 })).ok, false);
  assert.equal(parseRegistry(JSON.stringify({ version: 1, files: [{ path: 'a', kind: 'mystery' }], gates: [] })).ok, false);
  assert.equal(parseRegistry(JSON.stringify({ version: 2, files: [], gates: [] })).ok, false);
  assert.equal(parseRegistry(null).ok, false);
  assert.equal(parseRegistry('{nope').ok, false);
});

test('glob: * stays in a segment, ** crosses segments, regex metacharacters are literal', () => {
  assert.ok(globToRegExp('skills/*/gate-contract.json').test('skills/plan/gate-contract.json'));
  assert.ok(!globToRegExp('skills/*/gate-contract.json').test('skills/a/b/gate-contract.json'));
  assert.ok(globToRegExp('scripts/lib/gate-honesty/**').test('scripts/lib/gate-honesty/x/y.mjs'));
  assert.ok(!globToRegExp('a.json').test('aXjson'));
});

test('an exact entry beats a glob', () => {
  const r = parseRegistry(JSON.stringify({ version: 1, gates: [], files: [{ path: 'g/*.json', kind: 'contract-set' }, { path: 'g/_x.json', kind: 'set-of-allowances' }] })).registry;
  assert.equal(matchEntry(r, 'g/_x.json').kind, 'set-of-allowances');
  assert.equal(matchEntry(r, 'g/y.json').kind, 'contract-set');
  assert.equal(matchEntry(r, 'other.json'), null);
});

test('CENSUS: every tracked baseline / contract file is registered', () => {
  const missing = unregistered(loaded.registry, tracked);
  assert.deepEqual(missing, [], `unregistered gate-defining files: ${missing.join(', ')} - add them to ${REGISTRY_PATH}`);
  assert.ok(candidates(tracked).length >= 40, 'the census must actually see the gate files (vacuous-pass guard)');
});

test('CENSUS negative control: an unregistered baseline fixture IS caught', () => {
  const fake = [...tracked, '.brand-new-baseline.json', 'scripts/gate-contracts/zzz-new.json', 'skills/zzz/gate-contract.json'];
  // The glob entries cover the two contract paths; the root baseline has no entry, so exactly it is reported.
  assert.deepEqual(unregistered(loaded.registry, fake), ['.brand-new-baseline.json']);
  const emptied = { ...loaded.registry, files: [] };
  assert.ok(unregistered(emptied, tracked).length >= 40, 'with an empty registry everything is unregistered');
});

test('the plan-mandated paths and install inputs are all covered', () => {
  const must = [
    'scripts/check-gate-contracts.mjs', 'scripts/lib/prompt-seeds.mjs', 'scripts/lib/audit/round-cap.mjs', '.test-tiers.json',
    '.windowed-views.json', '.own-model-coverage.json', 'package.json', 'package-lock.json', '.npmrc',
    'scripts/gate-provenance.mjs', 'scripts/lib/gate-provenance/classify.mjs', 'scripts/lib/gate-provenance/registry.mjs',
    '.github/workflows/full-suite.yml', REGISTRY_PATH, 'scripts/lib/gate-honesty/schema.mjs',
  ];
  for (const f of must) assert.ok(matchEntry(loaded.registry, f), `not registered: ${f}`);
});

test('every gate entry point is tracked and its import closure fully resolves', () => {
  const set = new Set(tracked);
  const entries = gateEntryPoints(loaded.registry);
  assert.ok(entries.length >= 5);
  for (const e of entries) assert.ok(set.has(e), `gate entry point not tracked: ${e}`);
  const closure = collectImportClosure({ entryPoints: entries, repoFiles: set, readFile: (p) => (set.has(p) ? fs.readFileSync(path.join(ROOT, p), 'utf8') : null) });
  assert.deepEqual(closure.unresolved, [], 'unresolved imports in a gate closure would be silently left on PR code');
  assert.ok(closure.files.length > entries.length);
});

test('expandRegistry returns exactly the tracked files an entry covers', () => {
  const m = expandRegistry(loaded.registry, tracked);
  assert.ok(m.has('.file-size-baseline.json'));
  assert.equal(m.get('.file-size-baseline.json').kind, 'numeric-cap');
  assert.ok(![...m.keys()].some((f) => f.startsWith('docs/')));
});

test('glob: ** is segment-aware - a/**/b matches zero, one and many middle segments and never a/foob', () => {
  const re = globToRegExp('a/**/b');
  assert.ok(re.test('a/b'), 'zero middle segments');
  assert.ok(re.test('a/x/b'), 'one');
  assert.ok(re.test('a/x/y/z/b'), 'many');
  assert.ok(!re.test('a/foob'), 'a/foob is not a/**/b');
  assert.ok(!re.test('a/xb'));
  assert.ok(!re.test('ab'));
  assert.ok(globToRegExp('**/x.json').test('x.json'));
  assert.ok(globToRegExp('**/x.json').test('p/q/x.json'));
  assert.ok(!globToRegExp('**/x.json').test('p/qx.json'));
  assert.ok(globToRegExp('a/**').test('a/b/c'));
});

// ── census: gate entry points and contract implementations ──────────────────────────────────────────────────────────
import { protectedClosure } from '../scripts/lib/gate-provenance/protected-set.mjs';

const trackedSet = new Set(tracked);
const readTracked = (p) => (trackedSet.has(p) ? fs.readFileSync(path.join(ROOT, p), 'utf8') : null);

/** Registry gate entry points that are not tracked files. */
const missingEntryPoints = (registry, files) => gateEntryPoints(registry).filter((p) => !files.has(p));

/** Contract implementation paths neither registered nor in the protected closure of the gate entry points. */
function uncoveredImplementations(registry, files, read, contracts) {
  const closure = new Set(protectedClosure({ entryPoints: gateEntryPoints(registry).filter((p) => files.has(p)), repoFiles: files, readFile: read }).files);
  const out = new Set();
  for (const doc of contracts) for (const g of doc.gates ?? []) {
    if (typeof g.implementation === 'string' && !matchEntry(registry, g.implementation) && !closure.has(g.implementation)) out.add(g.implementation);
  }
  return [...out].sort();
}
const realContracts = () => tracked
  .filter((f) => /^scripts\/gate-contracts\/[^/]+\.json$|^skills\/[^/]+\/gate-contract\.json$/.test(f))
  .map((f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8')));

test('CENSUS: every gate entry point named in the registry gate list exists; a fixture with a ghost entry fails', () => {
  assert.deepEqual(missingEntryPoints(loaded.registry, trackedSet), []);
  const ghost = { ...loaded.registry, gates: [...loaded.registry.gates, { id: 'ghost', argv: ['scripts/no-such-gate.mjs'] }] };
  assert.deepEqual(missingEntryPoints(ghost, trackedSet), ['scripts/no-such-gate.mjs']);
});

test('CENSUS: every contract implementation path is registered or inside the protected closure; a fixture fails', () => {
  const contracts = realContracts();
  assert.ok(contracts.length >= 20, 'the census must actually read the contracts (vacuous-pass guard)');
  assert.deepEqual(uncoveredImplementations(loaded.registry, trackedSet, readTracked, contracts), []);
  const fixture = [...contracts, { gates: [{ id: 'new', implementation: 'scripts/brand-new-gate.mjs' }] }];
  assert.deepEqual(uncoveredImplementations(loaded.registry, trackedSet, readTracked, fixture), ['scripts/brand-new-gate.mjs']);
  assert.ok(uncoveredImplementations({ ...loaded.registry, files: [] }, trackedSet, readTracked, contracts).length > 0, 'an empty registry leaves implementations uncovered');
});

test('protected closure follows spawned helper scripts (literal paths in a spawn-calling module), recursively', () => {
  const files = new Set(['scripts/g.mjs', 'scripts/h.mjs', 'scripts/lib/dep.mjs', 'scripts/unrelated.mjs']);
  const src = {
    'scripts/g.mjs': 'import { spawnSync } from "node:child_process";\nspawnSync(process.execPath, ["scripts/h.mjs"]);\n',
    'scripts/h.mjs': 'import "./lib/dep.mjs";\n',
    'scripts/lib/dep.mjs': 'export const d = 1;\n',
    'scripts/unrelated.mjs': 'export const u = 1;\n',
  };
  const c = protectedClosure({ entryPoints: ['scripts/g.mjs'], repoFiles: files, readFile: (p) => src[p] ?? null });
  assert.deepEqual(c.files, ['scripts/g.mjs', 'scripts/h.mjs', 'scripts/lib/dep.mjs']);
  assert.deepEqual(c.helpers, ['scripts/h.mjs']);
  // A literal in a module that does NOT spawn anything is not a helper (no process-spawning call in sight).
  const quiet = { ...src, 'scripts/g.mjs': 'export const p = "scripts/h.mjs";\n' };
  assert.deepEqual(protectedClosure({ entryPoints: ['scripts/g.mjs'], repoFiles: files, readFile: (p) => quiet[p] ?? null }).helpers, []);
});

/**
 * Classifier table tests: every precedence row and kind rule of the verification-lessons plan, section 2.2.
 * Negative control: a raised cap MUST read loosening, so the table cannot pass by classifying everything tightening.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GATE_DIFF_CONTRACT_VERSION, VERDICT_ORDER, worstOf, needsAuthorization, classifyFile, classifyGateDiff,
} from '../scripts/lib/gate-provenance/classify.mjs';
import { parseRegistry, REGISTRY_PATH } from '../scripts/lib/gate-provenance/registry.mjs';

const j = (o) => JSON.stringify(o, null, 2);
const cap = { path: 'b.json', kind: 'numeric-cap' };
const allow = { path: 'a.json', kind: 'set-of-allowances' };
const contract = { path: 'c.json', kind: 'contract-set' };
const opaque = { path: 'o.mjs', kind: 'opaque' };
const run = (entry, base, head) => classifyFile({ path: entry.path, entry, baseText: base, headText: head });
const verdict = (entry, base, head) => run(entry, base === null ? null : j(base), head === null ? null : j(head)).verdict;

test('contract version is pinned at 1', () => assert.equal(GATE_DIFF_CONTRACT_VERSION, 1));

test('precedence: loosening > unknown > tightening > unchanged', () => {
  assert.deepEqual([...VERDICT_ORDER], ['unchanged', 'tightening', 'unknown', 'loosening']);
  assert.equal(worstOf('tightening', 'unchanged'), 'tightening');
  assert.equal(worstOf('unknown', 'tightening'), 'unknown');
  assert.equal(worstOf('loosening', 'unknown'), 'loosening');
  assert.equal(worstOf('unknown', 'loosening'), 'loosening');
  assert.equal(needsAuthorization('unknown'), true);
  assert.equal(needsAuthorization('loosening'), true);
  assert.equal(needsAuthorization('tightening'), false);
  assert.equal(needsAuthorization('unchanged'), false);
});

test('identical content (even CRLF vs LF) is unchanged', () => {
  assert.equal(run(cap, '{"x": 1}\n', '{"x": 1}\r\n').verdict, 'unchanged');
});

test('NEGATIVE CONTROL: a raised cap reads loosening, a lowered one tightening', () => {
  assert.equal(verdict(cap, { limit: 1000 }, { limit: 1500 }), 'loosening');
  assert.equal(verdict(cap, { limit: 1000 }, { limit: 900 }), 'tightening');
});

test('fixed row: file deleted is loosening, for every kind', () => {
  for (const e of [cap, allow, contract, opaque]) assert.equal(run(e, '{}', null).verdict, 'loosening', e.kind);
});

test('fixed row: file added is tightening only for contract-set, else unknown', () => {
  assert.equal(run(contract, null, j({ gates: [] })).verdict, 'tightening');
  assert.equal(run(contract, null, '{not json').verdict, 'unknown');
  assert.equal(run(cap, null, j({ a: 1 })).verdict, 'unknown');
  assert.equal(run(allow, null, j({ a: [] })).verdict, 'unknown');
  assert.equal(run(opaque, null, 'x').verdict, 'unknown');
});

test('fixed row: unparseable base or head is unknown', () => {
  assert.equal(run(cap, '{broken', j({ a: 1 })).verdict, 'unknown');
  assert.equal(run(cap, j({ a: 1 }), '{broken').verdict, 'unknown');
  assert.equal(run(contract, j({ gates: [] }), 'nope').verdict, 'unknown');
});

test('fixed row: an unknown top-level field is unknown', () => {
  const e = { ...cap, knownFields: ['limit'] };
  assert.equal(verdict(e, { limit: 1 }, { limit: 1, surprise: 2 }), 'unknown');
  assert.equal(verdict(e, { limit: 2 }, { limit: 1 }), 'tightening');
});

test('opaque: any change is unknown', () => assert.equal(run(opaque, 'a', 'b').verdict, 'unknown'));

test('numeric-cap: entry removed and entry added both loosen when no allowance keys are declared', () => {
  assert.equal(verdict(cap, { files: { a: 5, b: 6 } }, { files: { a: 5 } }), 'loosening');
  assert.equal(verdict(cap, { files: { a: 5 } }, { files: { a: 5, b: 6 } }), 'loosening');
});

test('numeric-cap: removing a per-site exception under allowanceKeys tightens (the default cap applies again); adding one loosens', () => {
  const capA = { ...cap, allowanceKeys: ['files', 'ids'] };
  assert.equal(verdict(capA, { files: { a: 5, b: 6 } }, { files: { a: 5 } }), 'tightening');
  assert.equal(verdict(capA, { ids: ['x', 'y'] }, { ids: ['x'] }), 'tightening');
  assert.equal(verdict(capA, { files: { a: 5 } }, { files: { a: 5, b: 6 } }), 'loosening');
  // negative control: a removed key OUTSIDE the allowance keys still loosens
  assert.equal(verdict(capA, { limit: 1000, files: {} }, { files: {} }), 'loosening');
});

test('numeric-cap: worst of per-entry verdicts (one raise among many lowerings)', () => {
  assert.equal(verdict(cap, { files: { a: 5, b: 6 } }, { files: { a: 1, b: 7 } }), 'loosening');
  assert.equal(verdict(cap, { files: { a: 5, b: 6 } }, { files: { a: 1, b: 2 } }), 'tightening');
});

test('numeric-cap: documentation fields are not a gate change; other non-numeric change is unknown', () => {
  assert.equal(run(cap, j({ _description: 'a', n: 1 }), j({ _description: 'b', n: 1 })).verdict, 'unchanged');
  assert.equal(verdict(cap, { mode: 'x', n: 1 }, { mode: 'y', n: 1 }), 'unknown');
});

test('set-of-allowances: removal tightens, addition loosens, mixed is loosening', () => {
  assert.equal(verdict(allow, { keys: ['a', 'b'] }, { keys: ['a'] }), 'tightening');
  assert.equal(verdict(allow, { keys: ['a'] }, { keys: ['a', 'b'] }), 'loosening');
  assert.equal(verdict(allow, { keys: ['a', 'b'] }, { keys: ['a', 'c'] }), 'loosening');
  assert.equal(verdict(allow, { keys: ['a', 'b'] }, { keys: ['b', 'a'] }), 'unchanged');
});

test('set-of-allowances: a numeric leaf is still a cap', () => {
  assert.equal(verdict(allow, { total: 5, refs: { a: { n: 2 } } }, { total: 4, refs: { a: { n: 2 } } }), 'tightening');
  assert.equal(verdict(allow, { total: 5 }, { total: 6 }), 'loosening');
});

const gate = (over = {}) => ({ id: 'g1', kind: 'executable', stated: 'S', implementation: 'x.mjs', oracle: 'poison-pill', tests: ['t1.mjs'], poisonPill: { expectExit: 1 }, ...over });
const doc = (...gates) => ({ version: 1, gate: 'g', gates });

test('contract-set: gate added tightens, gate removed loosens', () => {
  assert.equal(verdict(contract, doc(gate()), doc(gate(), gate({ id: 'g2' }))), 'tightening');
  assert.equal(verdict(contract, doc(gate(), gate({ id: 'g2' })), doc(gate())), 'loosening');
});

test('contract-set: each weakening field changed loosens', () => {
  for (const [f, v] of [['stated', 'T'], ['implementation', 'y.mjs'], ['oracle', 'cli-exit'], ['poisonPill', { expectExit: 0 }], ['expectExit', 0]]) {
    assert.equal(verdict(contract, doc(gate()), doc(gate({ [f]: v }))), 'loosening', f);
  }
});

test('contract-set: tests dropped loosens, tests added tightens, both is loosening', () => {
  assert.equal(verdict(contract, doc(gate()), doc(gate({ tests: [] }))), 'loosening');
  assert.equal(verdict(contract, doc(gate()), doc(gate({ tests: ['t1.mjs', 't2.mjs'] }))), 'tightening');
  assert.equal(verdict(contract, doc(gate()), doc(gate({ tests: ['t2.mjs'] }))), 'loosening');
});

test('contract-set: any other field is unknown; a changed top-level field is unknown', () => {
  assert.equal(verdict(contract, doc(gate()), doc(gate({ proof: 'process' }))), 'unknown');
  assert.equal(verdict(contract, doc(gate()), { ...doc(gate()), guards: 'new' }), 'unknown');
  assert.equal(verdict(contract, { version: 1 }, { version: 1, x: 1 }), 'unknown');
});

test('contract-set: reasons name the gate and the field', () => {
  const r = run(contract, j(doc(gate())), j(doc(gate({ stated: 'T' }))));
  assert.match(r.reasons.join('\n'), /gate g1: stated changed/);
});

const reg = (files, gates = []) => j({ version: 1, files, gates });
const F = (path, kind = 'opaque') => ({ path, kind });

test('registry itself: removed entry and changed classifier loosen, added entry tightens', () => {
  const entry = { path: REGISTRY_PATH, kind: 'opaque' };
  assert.equal(run(entry, reg([F('a'), F('b')]), reg([F('a')])).verdict, 'loosening');
  assert.equal(run(entry, reg([F('a', 'numeric-cap')]), reg([F('a', 'opaque')])).verdict, 'loosening');
  assert.equal(run(entry, reg([F('a')]), reg([F('a'), F('b')])).verdict, 'tightening');
  assert.equal(run(entry, reg([F('a')], [{ id: 'g', argv: ['x.mjs'] }]), reg([F('a')], [])).verdict, 'loosening');
  assert.equal(run(entry, reg([F('a')], []), reg([F('a')], [{ id: 'g', argv: ['x.mjs'] }])).verdict, 'tightening');
  assert.equal(run(entry, reg([F('a')]), '{broken').verdict, 'unknown');
  assert.equal(run(entry, reg([F('a')]), j({ version: 1, files: [], gates: [], extra: 1 })).verdict, 'unknown');
});

function diff({ baseReg, headReg, base = {}, head = {} }) {
  const parse = (r) => parseRegistry(r).registry;
  const B = { ...base, [REGISTRY_PATH]: baseReg };
  const H = { ...head, [REGISTRY_PATH]: headReg };
  return classifyGateDiff({
    baseRegistry: parse(baseReg), headRegistry: parse(headReg),
    baseFiles: Object.keys(B), headFiles: Object.keys(H), readBase: (p) => B[p] ?? null, readHead: (p) => H[p] ?? null,
  });
}

test('PR verdict is the worst over files, and unregistered files are ignored', () => {
  const r = reg([F('b.json', 'numeric-cap'), F('a.json', 'set-of-allowances')]);
  const out = diff({
    baseReg: r, headReg: r,
    base: { 'b.json': j({ n: 5 }), 'a.json': j({ k: ['x', 'y'] }), 'free.txt': 'a' },
    head: { 'b.json': j({ n: 4 }), 'a.json': j({ k: ['x'] }), 'free.txt': 'b' },
  });
  assert.equal(out.verdict, 'tightening');
  assert.deepEqual(out.files.map((f) => f.path), ['a.json', 'b.json']);
  const worse = diff({ baseReg: r, headReg: r, base: { 'b.json': j({ n: 5 }) }, head: { 'b.json': j({ n: 9 }) } });
  assert.equal(worse.verdict, 'loosening');
});

test('a PR cannot escape by shrinking the registry: the BASE registry still governs the path', () => {
  const baseReg = reg([F('b.json', 'numeric-cap')]);
  const out = diff({ baseReg, headReg: reg([]), base: { 'b.json': j({ n: 5 }) }, head: { 'b.json': j({ n: 9 }) } });
  assert.equal(out.verdict, 'loosening');
  assert.ok(out.files.some((f) => f.path === 'b.json' && f.verdict === 'loosening'));
  assert.ok(out.files.some((f) => f.path === REGISTRY_PATH && f.verdict === 'loosening'));
});

test('a file added under a registered glob is judged by the glob kind', () => {
  const r = reg([F('gc/*.json', 'contract-set')]);
  assert.equal(diff({ baseReg: r, headReg: r, head: { 'gc/new.json': j(doc(gate())) } }).verdict, 'tightening');
});

test('a file deleted from a registered glob is loosening', () => {
  const r = reg([F('gc/*.json', 'contract-set')]);
  assert.equal(diff({ baseReg: r, headReg: r, base: { 'gc/old.json': j(doc(gate())) } }).verdict, 'loosening');
});

test('nothing registered changed: unchanged', () => {
  const r = reg([F('b.json', 'numeric-cap')]);
  assert.equal(diff({ baseReg: r, headReg: r, base: { 'b.json': j({ n: 1 }) }, head: { 'b.json': j({ n: 1 }) } }).verdict, 'unchanged');
});

test('registry diff compares the WHOLE entry minus note: knownFields/allowanceKeys loosen, an unrecognised field is unknown, note is free', () => {
  const entry = { path: REGISTRY_PATH, kind: 'opaque' };
  const mk = (e) => j({ version: 1, files: [e], gates: [] });
  const base = { path: 'a.json', kind: 'numeric-cap', knownFields: ['n'], allowanceKeys: ['files'] };
  assert.equal(run(entry, mk(base), mk({ ...base, note: 'reworded' })).reasons.length, 0, 'a note change alone is not a change');
  assert.equal(run(entry, mk(base), mk({ ...base, allowanceKeys: ['files', 'ids'] })).verdict, 'loosening');
  assert.equal(run(entry, mk(base), mk({ ...base, allowanceKeys: [] })).verdict, 'loosening');
  assert.equal(run(entry, mk(base), mk({ ...base, knownFields: ['n', 'm'] })).verdict, 'loosening');
  assert.equal(run(entry, mk(base), mk({ ...base, kind: 'opaque' })).verdict, 'loosening');
});

test('an unregistered module in the protected closure classifies opaque (unknown), and an unprotected file stays out', () => {
  const r = reg([F('b.json', 'numeric-cap')]);
  const parse = (x) => parseRegistry(x).registry;
  const out = classifyGateDiff({
    baseRegistry: parse(r), headRegistry: parse(r),
    baseFiles: ['scripts/lib/dep.mjs', 'src/x.mjs'], headFiles: ['scripts/lib/dep.mjs', 'src/x.mjs'],
    readBase: (p) => (p === REGISTRY_PATH ? r : 'a'), readHead: (p) => (p === REGISTRY_PATH ? r : 'b'),
    protectedPaths: new Set(['scripts/lib/dep.mjs']),
  });
  assert.equal(out.verdict, 'unknown');
  assert.deepEqual(out.files.map((f) => [f.path, f.kind]), [['scripts/lib/dep.mjs', 'opaque']]);
});

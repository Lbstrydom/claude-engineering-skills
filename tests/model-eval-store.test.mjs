/**
 * @fileoverview `store/model-eval.mjs` — persisted verdict/nextAction
 * bounded to the reachable vocabulary (round-7 M3 regression guard).
 *
 * Split out of `tests/model-eval-core.test.mjs` (Phase 5, plan:
 * comparison-tooling-consolidation.md, D3) — assertions moved verbatim.
 *
 * @module tests/model-eval-store
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { _internals as storeModelEvalInternals } from '../scripts/lib/store/model-eval.mjs';

describe('store/model-eval.mjs — persisted verdict/nextAction bounded to the reachable vocabulary (round-7 M3 regression guard)', () => {
  test('an arbitrary string verdict/nextAction is rejected at the persistence boundary', () => {
    // Round-12 audit M9 fix — createEvalRun only ever starts a NON-terminal
    // run now (updateEvalRunTerminal is the sole path to 'completed'), so a
    // verdict/nextAction pair can only legitimately appear in a
    // terminalBundle; test through that surface.
    const base = { repoId: 'r1', runId: 'run-x', expectedStatus: 'running', terminalBundle: { status: 'completed' } };
    assert.equal(storeModelEvalInternals.UpdateEvalRunTerminalArgsSchema.safeParse({ ...base, terminalBundle: { ...base.terminalBundle, verdict: 'not-a-real-verdict', nextAction: 'none' } }).success, false);
    assert.equal(storeModelEvalInternals.UpdateEvalRunTerminalArgsSchema.safeParse({ ...base, terminalBundle: { ...base.terminalBundle, verdict: 'keep', nextAction: 'not-a-real-action' } }).success, false);
    assert.equal(storeModelEvalInternals.UpdateEvalRunTerminalArgsSchema.safeParse({ ...base, terminalBundle: { ...base.terminalBundle, verdict: 'keep', nextAction: 'none' } }).success, true);
  });

  test('createEvalRun only accepts a NON-terminal status — completed/failed_* must go through updateEvalRunTerminal (round-12 M9 regression guard)', () => {
    const base = { repoId: 'r1', role: 'auditor', tier: 'screen', candidateRef: { spec: 'x' } };
    assert.equal(storeModelEvalInternals.CreateEvalRunBundleSchema.safeParse({ ...base, status: 'completed' }).success, false);
    assert.equal(storeModelEvalInternals.CreateEvalRunBundleSchema.safeParse({ ...base, status: 'failed_provider' }).success, false);
    assert.equal(storeModelEvalInternals.CreateEvalRunBundleSchema.safeParse({ ...base, status: 'running' }).success, true);
  });

  test('status:"pending_shadow" is rejected for a non-adjudicator role (round-14 M1 regression guard)', () => {
    const base = { repoId: 'r1', tier: 'screen', candidateRef: { spec: 'x' }, status: 'pending_shadow' };
    assert.equal(storeModelEvalInternals.CreateEvalRunBundleSchema.safeParse({ ...base, role: 'auditor' }).success, false);
    assert.equal(storeModelEvalInternals.CreateEvalRunBundleSchema.safeParse({ ...base, role: 'adjudicator' }).success, true);
  });

  test('a non-JSON-serializable candidateRef/metrics/cost/evidence value is rejected — jsonb columns can\'t safely hold it (round-14 H1/M10 regression guard)', () => {
    const base = { repoId: 'r1', role: 'auditor', tier: 'screen', status: 'running' };
    const circular = {}; circular.self = circular;
    assert.equal(storeModelEvalInternals.CreateEvalRunBundleSchema.safeParse({ ...base, candidateRef: circular }).success, false);
    assert.equal(storeModelEvalInternals.CreateEvalRunBundleSchema.safeParse({ ...base, candidateRef: { fn: () => {} } }).success, false);
    assert.equal(storeModelEvalInternals.CreateEvalRunBundleSchema.safeParse({ ...base, candidateRef: { spec: 'x', nested: { a: 1 } } }).success, true);
  });

  test('NaN/Infinity are rejected — jsonb has no representation for them and JSON.stringify silently emits null (r15h1jsonbfinite)', () => {
    const base = { repoId: 'r1', role: 'auditor', tier: 'screen', status: 'running' };
    // `typeof NaN === 'number'`, so isJsonbSafeValue used to wave both through;
    // JSON.stringify(NaN) then returns the STRING "null" without throwing, so
    // the value was silently CHANGED on the way to the column rather than
    // rejected — the same silent-data-loss class this seam already catches for
    // function-valued keys.
    assert.equal(JSON.stringify({ v: NaN }), '{"v":null}', 'negative control: stringify does not throw, it corrupts');
    for (const bad of [NaN, Infinity, -Infinity]) {
      assert.equal(storeModelEvalInternals.CreateEvalRunBundleSchema.safeParse({ ...base, candidateRef: { v: bad } }).success, false, `${bad} must be rejected`);
      assert.equal(storeModelEvalInternals.CreateEvalRunBundleSchema.safeParse({ ...base, candidateRef: { nested: { deep: [1, bad] } } }).success, false, `${bad} must be rejected when nested`);
    }
    // finite numbers, including 0 and negatives, are still fine
    assert.equal(storeModelEvalInternals.CreateEvalRunBundleSchema.safeParse({ ...base, candidateRef: { a: 0, b: -1.5, c: 1e308 } }).success, true);
  });

  test('sparse-array holes and Map/Set are rejected — every()/Object.values() are blind to both (audit R1 H1)', () => {
    const base = { repoId: 'r1', role: 'auditor', tier: 'screen', status: 'running' };
    // Negative controls: this is what the validator was failing to notice.
    assert.equal(JSON.stringify({ v: new Array(2) }), '{"v":[null,null]}', 'holes become nulls, silently');
    assert.equal(JSON.stringify({ v: new Map([[1, 2]]) }), '{"v":{}}', 'a Map stringifies to TOTAL data loss');
    assert.equal(new Array(2).every(() => false), true, 'Array#every skips holes entirely');
    assert.equal(Object.values(new Set([1, 2])).length, 0, 'a Set has no own enumerable values');

    // audit R2 H2/H3 — Map/Set was a denylist of the two kinds that had been
    // NAMED; these all share the same property (own enumerable string keys do
    // not describe them) and all lose data.
    assert.equal(JSON.stringify({ v: /x/g }), '{"v":{}}', 'RegExp too');
    assert.equal(JSON.stringify({ v: new Error('boom') }), '{"v":{}}', 'Error too');
    const symbolKeyed = { a: 1, [Symbol('s')]: 2 };
    Object.defineProperty(symbolKeyed, 'hidden', { value: 3, enumerable: false });
    assert.equal(JSON.stringify(symbolKeyed), '{"a":1}', 'symbol-keyed and non-enumerable props vanish');

    for (const [label, bad] of [
      ['empty holes', new Array(2)],
      ['interior hole', [1, , 3]],
      ['Map', new Map([['a', 1]])],
      ['Set', new Set([1, 2])],
      ['nested Map', { deep: { inner: new Map() } }],
      ['RegExp', /x/g],
      ['Error', new Error('boom')],
      ['WeakMap', new WeakMap()],
      ['Promise', Promise.resolve(1)],
      ['TypedArray', new Uint8Array([1, 2])],
      ['symbol-keyed / non-enumerable', symbolKeyed],
    ]) {
      assert.equal(storeModelEvalInternals.CreateEvalRunBundleSchema.safeParse({ ...base, candidateRef: { v: bad } }).success, false, `${label} must be rejected`);
    }
    // Dense arrays and plain nested objects are unaffected; a Date has a
    // defined toJSON and is deliberately still allowed.
    assert.equal(storeModelEvalInternals.CreateEvalRunBundleSchema.safeParse({ ...base, candidateRef: { v: [1, 2, 3], o: { a: [true, null] } } }).success, true);
    assert.equal(storeModelEvalInternals.CreateEvalRunBundleSchema.safeParse({ ...base, candidateRef: { at: new Date(0) } }).success, true);
    // a null-prototype bag is still a plain data bag
    const bare = Object.create(null); bare.a = 1;
    assert.equal(storeModelEvalInternals.CreateEvalRunBundleSchema.safeParse({ ...base, candidateRef: { bare } }).success, true);
  });

  test('an array with a NON-INDEX own property is rejected — JSON.stringify drops the property silently (Cluster B fix-gate)', () => {
    const base = { repoId: 'r1', role: 'auditor', tier: 'screen', status: 'running' };
    // Negative control: the loop above this fix only ever walked index keys
    // (0..length-1), so a property attached to the array itself was invisible
    // to it — and JSON.stringify drops it with no error, same silent-loss class
    // as every other case in this file.
    const withMetadata = [1, 2, 3]; withMetadata.extra = 'dropped-silently';
    assert.equal(JSON.stringify({ v: withMetadata }), '{"v":[1,2,3]}', 'the extra property vanishes with no error');
    assert.equal(
      storeModelEvalInternals.CreateEvalRunBundleSchema.safeParse({ ...base, candidateRef: { v: withMetadata } }).success,
      false,
    );
    // Nested, matching the file's own convention for these regression cases.
    assert.equal(
      storeModelEvalInternals.CreateEvalRunBundleSchema.safeParse({ ...base, candidateRef: { nested: { deep: withMetadata } } }).success,
      false,
    );
    // A dense array with ONLY index keys — same length, no extras — must still
    // pass; this is the case the fix must not collaterally break.
    assert.equal(storeModelEvalInternals.CreateEvalRunBundleSchema.safeParse({ ...base, candidateRef: { v: [1, 2, 3] } }).success, true);
  });

  test('an array with a NON-ENUMERABLE extra property or an ACCESSOR at an index is rejected too (Cluster B fix-gate, round 2)', () => {
    // The FIRST array fix (above) used `Object.keys(v).length !== v.length`,
    // which repeated — inside the very function fixing this bug class — the
    // same two mistakes that had already been fixed for plain objects two
    // audits earlier (R1 H1 and R5 H3), because it borrowed a shortcut rather
    // than the object branch's own descriptor-walk approach:
    const base = { repoId: 'r1', role: 'auditor', tier: 'screen', status: 'running' };

    // Gap (a): Object.keys() sees only ENUMERABLE own keys, so a
    // non-enumerable extra property left both sides of that length
    // comparison equal — invisible.
    const withHiddenProp = [1, 2, 3];
    Object.defineProperty(withHiddenProp, 'hidden', { value: 'x', enumerable: false, configurable: true });
    assert.equal(Object.keys(withHiddenProp).length, withHiddenProp.length, 'negative control: the OLD check saw these as equal — that IS the bug');
    assert.equal(JSON.stringify({ v: withHiddenProp }), '{"v":[1,2,3]}', 'the hidden property vanishes with no error');
    assert.equal(
      storeModelEvalInternals.CreateEvalRunBundleSchema.safeParse({ ...base, candidateRef: { v: withHiddenProp } }).success,
      false,
    );

    // Gap (b): reading `v[i]` directly INVOKES a getter rather than
    // inspecting it — the same two-invocations problem R5 H3 fixed for
    // `Object.values()` on plain objects (one read here, a DIFFERENT read at
    // persistence time; nothing guarantees the two agree).
    const withGetterIndex = [1, 2, 3];
    Object.defineProperty(withGetterIndex, 0, { get: () => 99, enumerable: true, configurable: true });
    assert.equal(
      storeModelEvalInternals.CreateEvalRunBundleSchema.safeParse({ ...base, candidateRef: { v: withGetterIndex } }).success,
      false,
    );

    // NEGATIVE CONTROLS this fix must not collaterally break: the array's own
    // `length` property (every array has one, non-enumerable) must not itself
    // be counted as an "extra" — and ordinary, empty, and nested arrays all
    // still pass.
    assert.equal(
      storeModelEvalInternals.CreateEvalRunBundleSchema.safeParse({ ...base, candidateRef: { v: [1, 2, 3] } }).success,
      true,
    );
    assert.equal(storeModelEvalInternals.CreateEvalRunBundleSchema.safeParse({ ...base, candidateRef: { v: [] } }).success, true);
    assert.equal(
      storeModelEvalInternals.CreateEvalRunBundleSchema.safeParse({ ...base, candidateRef: { v: [[1, 2], [3, 4]] } }).success,
      true,
    );
  });

  test('a cyclic object/array is rejected cleanly, never stack-overflows the validator (Cluster B fix-gate, round 3, raised a third time)', () => {
    const base = { repoId: 'r1', role: 'auditor', tier: 'screen', status: 'running' };

    const cyclicObject = {}; cyclicObject.self = cyclicObject;
    assert.equal(storeModelEvalInternals.CreateEvalRunBundleSchema.safeParse({ ...base, candidateRef: { v: cyclicObject } }).success, false);

    const cyclicArray = []; cyclicArray.push(cyclicArray);
    assert.equal(storeModelEvalInternals.CreateEvalRunBundleSchema.safeParse({ ...base, candidateRef: { v: cyclicArray } }).success, false);

    const deepCycle = { a: { b: { c: {} } } }; deepCycle.a.b.c.back = deepCycle;
    assert.equal(storeModelEvalInternals.CreateEvalRunBundleSchema.safeParse({ ...base, candidateRef: deepCycle }).success, false);

    // NEGATIVE CONTROL: the SAME object reached via two DIFFERENT, non-cyclic
    // paths is valid JSON (JSON.stringify duplicates it rather than emitting
    // a $ref) and must still pass — the ancestor-chain tracker must forget an
    // object once its own subtree finishes, not remember every value ever
    // visited across the whole call.
    const shared = { x: 1 };
    assert.equal(storeModelEvalInternals.CreateEvalRunBundleSchema.safeParse({ ...base, candidateRef: { a: shared, b: shared } }).success, true);
  });

  test('a custom toJSON is never invoked, so it cannot pass once and persist otherwise (audit R3 H1/H2, R4 H1/H2)', () => {
    const base = { repoId: 'r1', role: 'auditor', tier: 'screen', status: 'running' };
    // Negative control: the key vanishes and stringify never complains.
    assert.equal(JSON.stringify({ v: { toJSON: () => undefined } }), '{}', 'a toJSON returning undefined erases its key');

    // The load-bearing case: a STATEFUL serializer. Validating its output would
    // check the first invocation while persistence gets the second. Rejecting
    // outright is what makes that unconstructable — and the counter proves the
    // validator never called it.
    let calls = 0;
    const stateful = { toJSON: () => { calls += 1; return calls === 1 ? { ok: 1 } : { fn: () => {} }; } };
    assert.equal(storeModelEvalInternals.CreateEvalRunBundleSchema.safeParse({ ...base, candidateRef: { v: stateful } }).success, false);

    for (const [label, bad] of [
      ['toJSON -> undefined', { toJSON: () => undefined }],
      ['toJSON -> safe-looking object', { toJSON: () => ({ ok: 1 }) }],
      ['toJSON -> itself', (() => { const o = {}; o.toJSON = () => o; return o; })()],
      ['toJSON throws', { toJSON() { throw new Error('nope'); } }],
      ['Invalid Date', new Date(NaN)],
    ]) {
      assert.equal(storeModelEvalInternals.CreateEvalRunBundleSchema.safeParse({ ...base, candidateRef: { v: bad } }).success, false, `${label} must be rejected`);
    }
    // A real Date — the one case the exemption exists for — still passes.
    assert.equal(storeModelEvalInternals.CreateEvalRunBundleSchema.safeParse({ ...base, candidateRef: { at: new Date(0) } }).success, true);
  });

  test('a Date with an overridden toJSON, and accessor properties, are rejected (audit R5 H1/H3)', () => {
    const base = { repoId: 'r1', role: 'auditor', tier: 'screen', status: 'running' };
    // A Date whose serializer was replaced: `instanceof Date` still true, but
    // what reaches the column is whatever the override returns.
    const hijacked = new Date(0);
    hijacked.toJSON = () => ({ fn: () => {} });
    assert.equal(storeModelEvalInternals.CreateEvalRunBundleSchema.safeParse({ ...base, candidateRef: { at: hijacked } }).success, false);

    // audit R6 H2 — attached data with the STOCK serializer still in place:
    // Date#toJSON returns only the ISO string, so `extra` vanishes on write.
    const decorated = new Date(0);
    decorated.extra = { keep: 'me' };
    assert.equal(JSON.stringify({ v: decorated }), '{"v":"1970-01-01T00:00:00.000Z"}', 'negative control: the attached property is dropped');
    assert.equal(storeModelEvalInternals.CreateEvalRunBundleSchema.safeParse({ ...base, candidateRef: { at: decorated } }).success, false);
    // a Date SUBCLASS is not the stock case either
    class MyDate extends Date {}
    assert.equal(storeModelEvalInternals.CreateEvalRunBundleSchema.safeParse({ ...base, candidateRef: { at: new MyDate(0) } }).success, false);

    // An accessor is invoked once by validation and again at write time, so a
    // stateful getter can be checked in one state and persisted in another.
    // The counter proves the validator no longer calls it at all.
    let reads = 0;
    const withGetter = {};
    Object.defineProperty(withGetter, 'v', { enumerable: true, get() { reads += 1; return reads === 1 ? 1 : { fn: () => {} }; } });
    assert.equal(storeModelEvalInternals.CreateEvalRunBundleSchema.safeParse({ ...base, candidateRef: { withGetter } }).success, false);
    // Exactly one read, and it is NOT the guard's: jsonbSafeRecord's
    // circular-reference probe runs `JSON.stringify` first and that walk
    // invokes the getter. The descriptor walk adds no second invocation — an
    // `Object.values()`-based guard would have made it 2.
    assert.equal(reads, 1, 'only the stringify probe reads it; the guard itself must not');
  });

  test('updateEvalRunTerminal args reject the same out-of-vocabulary verdict/nextAction', () => {
    const args = {
      repoId: 'r1', runId: 'run-1', expectedStatus: 'running',
      terminalBundle: { status: 'completed', verdict: 'bogus', nextAction: 'none' },
    };
    assert.equal(storeModelEvalInternals.UpdateEvalRunTerminalArgsSchema.safeParse(args).success, false);
  });

  test('a syntactically-valid but never-produced (verdict, nextAction) pair is rejected (round-8 M5 regression guard)', () => {
    const base = { repoId: 'r1', runId: 'run-x', expectedStatus: 'running', terminalBundle: { status: 'completed' } };
    // "switch" only ever pairs with "promote_to_full" in DECISION_TABLE.
    assert.equal(storeModelEvalInternals.UpdateEvalRunTerminalArgsSchema.safeParse({ ...base, terminalBundle: { ...base.terminalBundle, verdict: 'switch', nextAction: 'reject' } }).success, false);
    assert.equal(storeModelEvalInternals.UpdateEvalRunTerminalArgsSchema.safeParse({ ...base, terminalBundle: { ...base.terminalBundle, verdict: 'switch', nextAction: 'promote_to_full' } }).success, true);
  });

  test('a half-populated verdict/nextAction (one set, one null) is rejected (round-9 H7 regression guard)', () => {
    const base = { repoId: 'r1', runId: 'run-x', expectedStatus: 'running', terminalBundle: { status: 'completed' } };
    assert.equal(storeModelEvalInternals.UpdateEvalRunTerminalArgsSchema.safeParse({ ...base, terminalBundle: { ...base.terminalBundle, verdict: 'keep', nextAction: null } }).success, false);
    assert.equal(storeModelEvalInternals.UpdateEvalRunTerminalArgsSchema.safeParse({ ...base, terminalBundle: { ...base.terminalBundle, verdict: null, nextAction: 'none' } }).success, false);
  });

  test('a non-completed status must not carry a verdict/nextAction, and completed must (round-9 H10 regression guard)', () => {
    const base = { repoId: 'r1', role: 'auditor', tier: 'screen', candidateRef: { spec: 'x' } };
    // Non-terminal, in-flight run with a decision already attached — invalid.
    assert.equal(storeModelEvalInternals.CreateEvalRunBundleSchema.safeParse({ ...base, status: 'running', verdict: 'keep', nextAction: 'none' }).success, false);
    // A failed terminal status persisting a success-shaped decision — invalid.
    assert.equal(storeModelEvalInternals.UpdateEvalRunTerminalArgsSchema.safeParse({
      repoId: 'r1', runId: 'run-1', expectedStatus: 'running',
      terminalBundle: { status: 'failed_provider', verdict: 'keep', nextAction: 'none' },
    }).success, false);
    // completed with no decision at all — invalid.
    assert.equal(storeModelEvalInternals.UpdateEvalRunTerminalArgsSchema.safeParse({
      repoId: 'r1', runId: 'run-1', expectedStatus: 'running',
      terminalBundle: { status: 'completed' },
    }).success, false);
    // The legitimate shapes both pass.
    assert.equal(storeModelEvalInternals.CreateEvalRunBundleSchema.safeParse({ ...base, status: 'running' }).success, true);
    assert.equal(storeModelEvalInternals.UpdateEvalRunTerminalArgsSchema.safeParse({
      repoId: 'r1', runId: 'run-1', expectedStatus: 'running',
      terminalBundle: { status: 'failed_provider' },
    }).success, true);
  });
});

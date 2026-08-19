/**
 * @fileoverview Unit tests for the event-wiring-symmetry pure module + the
 * wine-oracle fixture (the plan's precision claim made executable).
 *
 * Design: docs/plans/event-wiring-symmetry.md §9.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  extractEventSites, diffSites, resolveSymmetry, lookupEventStatus, NATIVE_EVENTS,
} from '../scripts/lib/audit/event-wiring.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const ORACLE_DIR = path.join(REPO_ROOT, 'tests', 'fixtures', 'event-wiring', 'wine-oracle');

// ---------------------------------------------------------------------------
// Grammar (D7)
// ---------------------------------------------------------------------------
test('extractEventSites — dispatchEvent(new CustomEvent(<static>)) is a named dispatch', () => {
  const src = `function f() { el.dispatchEvent(new CustomEvent('a:b')); }`;
  const { dispatches } = extractEventSites(src, { path: 'x.js' });
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].eventName, 'a:b');
  assert.equal(dispatches[0].enclosingSymbol, 'f');
});

test('extractEventSites — bare `new CustomEvent(...)` never inside dispatchEvent() emits nothing', () => {
  const src = `function f() { const x = new CustomEvent('a:b'); log(x); }`;
  const { dispatches, indirectDispatch } = extractEventSites(src, { path: 'x.js' });
  assert.equal(dispatches.length, 0);
  assert.equal(indirectDispatch, 0); // never referenced by a dispatchEvent call at all
});

test('extractEventSites — assign-then-dispatch resolves through the local binding', () => {
  const src = `function f() { const evt = new CustomEvent('a:b'); el.dispatchEvent(evt); }`;
  const { dispatches, indirectDispatch } = extractEventSites(src, { path: 'x.js' });
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].eventName, 'a:b');
  assert.equal(indirectDispatch, 0);
});

test('extractEventSites — dispatchEvent(<unresolved identifier>) counts as indirectDispatch, not a named dispatch', () => {
  const src = `function f(evt) { el.dispatchEvent(evt); }`;
  const { dispatches, indirectDispatch } = extractEventSites(src, { path: 'x.js' });
  assert.equal(dispatches.length, 0);
  assert.equal(indirectDispatch, 1);
});

test('extractEventSites — zero-substitution template literal is static; substituted template is dynamic', () => {
  const staticSrc = "el.dispatchEvent(new CustomEvent(`a:b`));";
  assert.equal(extractEventSites(staticSrc, { path: 'x.js' }).dispatches[0].eventName, 'a:b');
  const dynSrc = "el.dispatchEvent(new CustomEvent(`a:${x}`));";
  const dyn = extractEventSites(dynSrc, { path: 'x.js' });
  assert.equal(dyn.dispatches.length, 0);
  assert.equal(dyn.dynamicDispatch, 1);
});

test('extractEventSites — addEventListener with a variable name is dynamicListen', () => {
  const src = `el.addEventListener(name, handler);`;
  const { listens, dynamicListen } = extractEventSites(src, { path: 'x.js' });
  assert.equal(listens.length, 0);
  assert.equal(dynamicListen, 1);
});

test('extractEventSites — native blocklist rejects click/change/submit', () => {
  assert.ok(NATIVE_EVENTS.has('click'));
  assert.ok(NATIVE_EVENTS.has('change'));
  assert.ok(NATIVE_EVENTS.has('submit'));
  const src = `el.addEventListener('click', h); el.dispatchEvent(new CustomEvent('click'));`;
  const { dispatches, listens } = extractEventSites(src, { path: 'x.js' });
  assert.equal(dispatches.length, 0);
  assert.equal(listens.length, 0);
});

test('extractEventSites — a kebab/colon name is always custom, even if it collides with nothing native', () => {
  const src = `el.dispatchEvent(new CustomEvent('my-app:custom'));`;
  const { dispatches } = extractEventSites(src, { path: 'x.js' });
  assert.equal(dispatches[0].eventName, 'my-app:custom');
});

test('extractEventSites — configured wrappers, listen and dispatch direction', () => {
  const wrappers = [
    { direction: 'listen', callee: 'addTrackedListener', eventArgIndex: 2 },
    { direction: 'dispatch', callee: 'fireTracked', eventArgIndex: 0 },
  ];
  const src = `
    function f() {
      addTrackedListener('ns', el, 'x:y', handler);
      fireTracked('a:added', { detail: 1 });
    }
  `;
  const { listens, dispatches } = extractEventSites(src, { path: 'x.js', wrappers });
  assert.equal(listens.length, 1);
  assert.equal(listens[0].eventName, 'x:y');
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].eventName, 'a:added');
  assert.equal(dispatches[0].dispatchForm, 'wrapper:fireTracked');
});

test('extractEventSites — *Registry.add glob wrapper matches any prefix', () => {
  const wrappers = [{ direction: 'listen', callee: '*Registry.add', eventArgIndex: 1 }];
  const src = `restaurantPairingRegistry.add(el, 'restaurant:refine', handler);`;
  const { listens } = extractEventSites(src, { path: 'x.js', wrappers });
  assert.equal(listens.length, 1);
  assert.equal(listens[0].eventName, 'restaurant:refine');
});

test('extractEventSites — an event name inside a comment or unrelated string is never evidence', () => {
  const src = `
    // this used to dispatch 'ghost:event' but no longer does
    const label = 'ghost:event seen in logs';
    log(label);
  `;
  const { dispatches, listens } = extractEventSites(src, { path: 'x.js' });
  assert.equal(dispatches.length, 0);
  assert.equal(listens.length, 0);
});

// ---------------------------------------------------------------------------
// D2c — locus vs signature
// ---------------------------------------------------------------------------
test('locus (D2c) — a reformatted file changes locus.startLine but the signature stays identical', () => {
  const before = `function f() {\n  el.dispatchEvent(new CustomEvent('a:b'));\n}`;
  const after = `function f() {\n\n  el.dispatchEvent(new CustomEvent('a:b'));\n}`; // blank line inserted
  const beforeSite = extractEventSites(before, { path: 'x.js' }).dispatches[0];
  const afterSite = extractEventSites(after, { path: 'x.js' }).dispatches[0];
  assert.notEqual(beforeSite.locus.startLine, afterSite.locus.startLine);
  assert.equal(beforeSite.eventName, afterSite.eventName);
  assert.equal(beforeSite.enclosingSymbol, afterSite.enclosingSymbol);
  const { addedDispatches } = diffSites(
    { dispatches: [beforeSite], listens: [] },
    { dispatches: [afterSite], listens: [] },
  );
  assert.equal(addedDispatches.length, 0, 'reformatting alone must not manufacture an added site');
});

// ---------------------------------------------------------------------------
// D2/D2b — diffSites
// ---------------------------------------------------------------------------
test('diffSites — a dispatch present in both before and after is not added', () => {
  const before = extractEventSites(`el.dispatchEvent(new CustomEvent('a:b'));`, { path: 'x.js' });
  const after = extractEventSites(`el.dispatchEvent(new CustomEvent('a:b'));`, { path: 'x.js' });
  const { addedDispatches } = diffSites(before, after);
  assert.equal(addedDispatches.length, 0);
});

test('diffSites — a dispatch present only in after is added', () => {
  const before = extractEventSites(``, { path: 'x.js' });
  const after = extractEventSites(`el.dispatchEvent(new CustomEvent('a:b'));`, { path: 'x.js' });
  const { addedDispatches } = diffSites(before, after);
  assert.equal(addedDispatches.length, 1);
});

test('diffSites — a same-diff file split (D+A of the same signature) nets to zero (R2/H2)', () => {
  const before = extractEventSites(`el.dispatchEvent(new CustomEvent('a:b'));`, { path: 'a.js' });
  const after = extractEventSites(`el.dispatchEvent(new CustomEvent('a:b'));`, { path: 'b.js' });
  // diff-wide union means both files' before/after are combined by the caller
  // (event-wiring-corpus.mjs); at the pure-module level, simulate that union:
  const unionBefore = { dispatches: before.dispatches, listens: [] };
  const unionAfter = { dispatches: after.dispatches, listens: [] };
  const { addedDispatches } = diffSites(unionBefore, unionAfter);
  assert.equal(addedDispatches.length, 0, 'the moved dispatch must not read as newly added');
});

test('diffSites — enclosingSymbol change alone (rename/move) does not manufacture an added site (Gemini round-2 G1)', () => {
  const before = extractEventSites(`function oldName() { el.dispatchEvent(new CustomEvent('a:b')); }`, { path: 'x.js' });
  const after = extractEventSites(`function newName() { el.dispatchEvent(new CustomEvent('a:b')); }`, { path: 'x.js' });
  const { addedDispatches } = diffSites(before, after);
  assert.equal(addedDispatches.length, 0);
});

test('diffSites — a test-to-production runtime promotion of the same signature IS added (R4/H2)', () => {
  const before = extractEventSites(`el.dispatchEvent(new CustomEvent('a:b'));`, { path: 'x.test.js', runtime: 'test' });
  const after = extractEventSites(`el.dispatchEvent(new CustomEvent('a:b'));`, { path: 'x.js', runtime: 'production' });
  const { addedDispatches } = diffSites(before, after);
  assert.equal(addedDispatches.length, 1, 'runtime is part of the signature, so promotion is a real candidacy change');
});

test('diffSites — losing a pragma on an otherwise-identical dispatch IS added (R4/H2)', () => {
  const before = extractEventSites(
    `function f() {\n  // @event-consumer-external: legacy fallback\n  el.dispatchEvent(new CustomEvent('a:b'));\n}`,
    { path: 'x.js' },
  );
  const after = extractEventSites(`function f() { el.dispatchEvent(new CustomEvent('a:b')); }`, { path: 'x.js' });
  assert.equal(before.dispatches[0].pragmaSuppressed, true);
  assert.equal(after.dispatches[0].pragmaSuppressed, false);
  const { addedDispatches } = diffSites(before, after);
  assert.equal(addedDispatches.length, 1);
});

test('diffSites — a removed production listener with a surviving production dispatch is a removed-listener candidate', () => {
  const before = extractEventSites(`el.addEventListener('a:b', h);`, { path: 'x.js' });
  const after = extractEventSites(``, { path: 'x.js' });
  const { removedListeners } = diffSites(before, after);
  assert.equal(removedListeners.length, 1);
  assert.equal(removedListeners[0].eventName, 'a:b');
});

test('diffSites — a removed TEST listener is never a candidate (removedListeners only records what left; resolveSymmetry filters runtime)', () => {
  const before = extractEventSites(`el.addEventListener('a:b', h);`, { path: 'x.test.js', runtime: 'test' });
  const after = extractEventSites(``, { path: 'x.test.js', runtime: 'test' });
  const { removedListeners } = diffSites(before, after);
  assert.equal(removedListeners.length, 1);
  assert.equal(removedListeners[0].runtime, 'test');
});

// ---------------------------------------------------------------------------
// resolveSymmetry — D8/D9/D10/D2b/R3-M2/R4-H1
// ---------------------------------------------------------------------------
test('resolveSymmetry — added dispatch + production listener elsewhere → no finding', () => {
  const dispatchSite = extractEventSites(`el.dispatchEvent(new CustomEvent('a:b'));`, { path: 'a.js' }).dispatches[0];
  const listenSite = extractEventSites(`el.addEventListener('a:b', h);`, { path: 'b.js' }).listens[0];
  const corpus = { dispatches: [dispatchSite], listens: [listenSite] };
  const { findings } = resolveSymmetry({ corpus, addedDispatches: [dispatchSite], removedListeners: [] });
  assert.equal(findings.length, 0);
});

test('resolveSymmetry — added dispatch + no listener anywhere → finding, advisory, name-presence', () => {
  const dispatchSite = extractEventSites(`el.dispatchEvent(new CustomEvent('a:b'));`, { path: 'a.js' }).dispatches[0];
  const corpus = { dispatches: [dispatchSite], listens: [] };
  const { findings } = resolveSymmetry({ corpus, addedDispatches: [dispatchSite], removedListeners: [] });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].enforcement, 'advisory');
  assert.equal(findings[0].evidence, 'name-presence');
  assert.deepEqual(findings[0].triggers, ['added-dispatch']);
});

test('resolveSymmetry — added dispatch + test-only listener → LOW, not suppressed (D8 reversal)', () => {
  const dispatchSite = extractEventSites(`el.dispatchEvent(new CustomEvent('a:b'));`, { path: 'a.js' }).dispatches[0];
  const testListen = extractEventSites(`el.addEventListener('a:b', h);`, { path: 'a.test.js', runtime: 'test' }).listens[0];
  const corpus = { dispatches: [dispatchSite], listens: [testListen] };
  const { findings } = resolveSymmetry({ corpus, addedDispatches: [dispatchSite], removedListeners: [] });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'LOW');
  assert.equal(findings[0].testOnlyConsumer, true);
});

test('resolveSymmetry — pragma-suppressed dispatch with no other sites never surfaces as a finding', () => {
  const src = `function f() {\n  // @event-consumer-external: browser extension\n  el.dispatchEvent(new CustomEvent('a:b'));\n}`;
  const dispatchSite = extractEventSites(src, { path: 'a.js' }).dispatches[0];
  assert.equal(dispatchSite.pragmaSuppressed, true);
  const corpus = { dispatches: [dispatchSite], listens: [] };
  const { findings, coverage } = resolveSymmetry({ corpus, addedDispatches: [dispatchSite], removedListeners: [] });
  assert.equal(findings.length, 0);
  assert.equal(coverage.length, 1);
  assert.equal(coverage[0].pragmaSuppressedSites, coverage[0].totalDispatchSites);
});

test('resolveSymmetry — D2b: same event via added-dispatch AND removed-listener in one diff merges into ONE record (R3/M2, corrected R4/H1)', () => {
  const dispatchSite = extractEventSites(`el.dispatchEvent(new CustomEvent('a:b'));`, { path: 'a.js' }).dispatches[0];
  const removedListenSite = extractEventSites(`el.addEventListener('a:b', h);`, { path: 'b.js' }).listens[0];
  const corpus = { dispatches: [dispatchSite], listens: [] }; // listener removed, none remain
  const { findings } = resolveSymmetry({
    corpus, addedDispatches: [dispatchSite], removedListeners: [removedListenSite],
  });
  assert.equal(findings.length, 1, 'must be ONE merged record, not two');
  assert.deepEqual(findings[0].triggers.slice().sort(), ['added-dispatch', 'removed-listener']);
  assert.ok(findings[0].removedListenerLocus, 'supplementary evidence for the removed-listener half');
});

test('resolveSymmetry — deletes the listener AND the last dispatch → no finding (nothing fired)', () => {
  const removedListenSite = extractEventSites(`el.addEventListener('a:b', h);`, { path: 'b.js' }).listens[0];
  const corpus = { dispatches: [], listens: [] }; // dispatch also gone
  const { findings } = resolveSymmetry({ corpus, addedDispatches: [], removedListeners: [removedListenSite] });
  assert.equal(findings.length, 0);
});

test('resolveSymmetry — deletes one of two listeners → no finding (still resolved)', () => {
  const dispatchSite = extractEventSites(`el.dispatchEvent(new CustomEvent('a:b'));`, { path: 'a.js' }).dispatches[0];
  const survivingListen = extractEventSites(`el.addEventListener('a:b', h);`, { path: 'b.js' }).listens[0];
  const removedListen = extractEventSites(`el.addEventListener('a:b', h2);`, { path: 'c.js' }).listens[0];
  const corpus = { dispatches: [dispatchSite], listens: [survivingListen] };
  const { findings } = resolveSymmetry({ corpus, addedDispatches: [], removedListeners: [removedListen] });
  assert.equal(findings.length, 0);
});

// ---------------------------------------------------------------------------
// lookupEventStatus — D12 reconciliation primitive
// ---------------------------------------------------------------------------
test('lookupEventStatus — event with a production listener', () => {
  const listenSite = extractEventSites(`el.addEventListener('a:b', h);`, { path: 'a.js' }).listens[0];
  const corpus = { dispatches: [], listens: [listenSite] };
  const status = lookupEventStatus(corpus, 'a:b');
  assert.equal(status.hasProductionListener, true);
});

test('lookupEventStatus — event absent from the entire corpus', () => {
  const status = lookupEventStatus({ dispatches: [], listens: [] }, 'a:b');
  assert.equal(status.hasProductionListener, false);
  assert.equal(status.hasAnyDispatch, false);
});

test('lookupEventStatus — pragma-suppression counters mirror coverage[] (R3/H1 widened shape)', () => {
  const src = `function f() {\n  // @event-consumer-external: reason\n  el.dispatchEvent(new CustomEvent('a:b'));\n}`;
  const dispatchSite = extractEventSites(src, { path: 'a.js' }).dispatches[0];
  const status = lookupEventStatus({ dispatches: [dispatchSite], listens: [] }, 'a:b');
  assert.equal(status.totalDispatchSites, 1);
  assert.equal(status.pragmaSuppressedSites, 1);
});

// ---------------------------------------------------------------------------
// Orphaned pragma (D5 / Gemini round-4 G1)
// ---------------------------------------------------------------------------
test('extractEventSites — a pragma matching no dispatch site is reported as orphaned', () => {
  const src = `function f() {\n  // @event-consumer-external: stale, dispatch moved away\n  doSomethingElse();\n}`;
  const { orphanedPragmas } = extractEventSites(src, { path: 'x.js' });
  assert.equal(orphanedPragmas.length, 1);
});

test('extractEventSites — a pragma that binds to a real dispatch is not orphaned', () => {
  const src = `function f() {\n  // @event-consumer-external: reason\n  el.dispatchEvent(new CustomEvent('a:b'));\n}`;
  const { orphanedPragmas } = extractEventSites(src, { path: 'x.js' });
  assert.equal(orphanedPragmas.length, 0);
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------
test('extractEventSites — same source produces byte-identical results across two calls', () => {
  const src = `function f() { el.dispatchEvent(new CustomEvent('a:b')); }`;
  const a = extractEventSites(src, { path: 'x.js' });
  const b = extractEventSites(src, { path: 'x.js' });
  assert.deepEqual(a, b);
});

// ---------------------------------------------------------------------------
// Oracle fixture — the plan's precision claim made executable (§7b)
// ---------------------------------------------------------------------------
test('wine-oracle — repo-wide mode reproduces all 7 field events as dispatch-only, 5 actionable post-suppression', () => {
  const expected = JSON.parse(fs.readFileSync(path.join(ORACLE_DIR, 'expected.json'), 'utf8'));
  let dispatches = [];
  let listens = [];
  for (const ev of expected.events) {
    const src = fs.readFileSync(path.join(ORACLE_DIR, ev.fixtureFile), 'utf8');
    const sites = extractEventSites(src, { path: ev.fixtureFile, runtime: 'production' });
    dispatches.push(...sites.dispatches);
    listens.push(...sites.listens);
  }
  const corpus = { dispatches, listens };
  const productionDispatches = corpus.dispatches.filter(d => d.runtime === 'production');
  const { findings, coverage } = resolveSymmetry({ corpus, addedDispatches: productionDispatches, removedListeners: [] });

  const coverageNames = coverage.map(c => c.eventName).sort();
  assert.deepEqual(coverageNames, expected.events.map(e => e.name).sort());

  const findingNames = findings.map(f => f.eventName).sort();
  const expectedActionable = expected.events.filter(e => e.disposition !== 'FP').map(e => e.name).sort();
  assert.deepEqual(findingNames, expectedActionable);
  assert.equal(findings.length, expected.actionableCount);
});

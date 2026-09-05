/**
 * @fileoverview Why is a terminal DB row missing from the ledger — and does the
 * report say what it measured?
 *
 * THE INCIDENT (2026-09-05). `upstream:reconcile:gate` reported three such rows
 * as *"the accepted crash-window gap, now surfaced"* — its only explanation. The
 * real cause was a checkout **16 commits behind `origin/main`**, where all three
 * entries already existed. The two causes take OPPOSITE remedies — write the
 * ledger, versus `git pull` — so acting on the printed attribution would have
 * hand-written duplicates of entries already pushed. It came within one step of
 * happening.
 *
 * Separately the passing verdict read `clean` while 20 of 43 ledger entries
 * belonged to another store and were never compared: true of the rows it saw,
 * silent about its own scope.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyMissingCause, computeLedgerReconciliation, MISSING_CAUSE,
} from '../scripts/lib/upstream/dispositions.mjs';
import { renderReconciliationReport } from '../scripts/lib/upstream/commands.mjs';

const behind = (n = 3) => ({ state: 'behind', behindBy: n, upstream: 'origin/main', reason: null });
const current = () => ({ state: 'current', behindBy: 0, upstream: 'origin/main', reason: null });
const unknownFresh = (reason = 'not-a-work-tree') => ({ state: 'unknown', behindBy: null, upstream: null, reason });

const evidence = (status, ids = null) => ({ status, issueIds: ids ? new Set(ids) : null });

describe('classifyMissingCause — the table is TOTAL', () => {
  it('behind + all ids upstream ⇒ stale, with the ids named', () => {
    const r = classifyMissingCause({
      missingIds: ['a', 'b'], freshness: behind(16), upstreamEvidence: evidence('read', ['a', 'b', 'z']),
    });
    assert.equal(r.cause, MISSING_CAUSE.STALE);
    assert.deepEqual(r.presentUpstream, ['a', 'b']);
    assert.deepEqual(r.absentUpstream, []);
  });

  it('behind + SOME ids upstream ⇒ mixed, naming both sets', () => {
    const r = classifyMissingCause({
      missingIds: ['a', 'b'], freshness: behind(), upstreamEvidence: evidence('read', ['a']),
    });
    assert.equal(r.cause, MISSING_CAUSE.MIXED);
    assert.deepEqual(r.presentUpstream, ['a']);
    assert.deepEqual(r.absentUpstream, ['b']);
  });

  it('behind + NONE upstream ⇒ not-explained-by-staleness (pulling cannot add them)', () => {
    // The row the first draft had no branch for at all.
    const r = classifyMissingCause({
      missingIds: ['a'], freshness: behind(), upstreamEvidence: evidence('read', ['z']),
    });
    assert.equal(r.cause, MISSING_CAUSE.NOT_STALENESS);
  });

  it('current ⇒ not-explained-by-staleness', () => {
    const r = classifyMissingCause({
      missingIds: ['a'], freshness: current(), upstreamEvidence: evidence('read', ['a']),
    });
    assert.equal(r.cause, MISSING_CAUSE.NOT_STALENESS);
  });

  it('unknown freshness + ids ARE upstream ⇒ unknown (cannot tell if pull is the remedy)', () => {
    const r = classifyMissingCause({
      missingIds: ['a'], freshness: unknownFresh(), upstreamEvidence: evidence('read', ['a']),
    });
    assert.equal(r.cause, MISSING_CAUSE.UNKNOWN);
  });

  it('unknown freshness + ids NOT upstream ⇒ not-explained-by-staleness', () => {
    // Fail closed when the evidence cannot SETTLE the question — not whenever
    // an input is unknown. Upstream not having them decides it either way, so
    // demanding the freshness answer would refuse a repair on sufficient
    // evidence.
    const r = classifyMissingCause({
      missingIds: ['a'], freshness: unknownFresh(), upstreamEvidence: evidence('read', ['z']),
    });
    assert.equal(r.cause, MISSING_CAUSE.NOT_STALENESS);
  });

  it('absent upstream ledger ⇒ not-explained-by-staleness', () => {
    for (const f of [behind(), current(), unknownFresh()]) {
      assert.equal(classifyMissingCause({
        missingIds: ['a'], freshness: f, upstreamEvidence: evidence('absent'),
      }).cause, MISSING_CAUSE.NOT_STALENESS);
    }
  });

  it('NO upstream configured ⇒ not-explained-by-staleness, NOT unknown', () => {
    // The branch this was developed on has no upstream. Folding this into
    // `unreadable` would make repair permanently impossible in every
    // local-only repo — a gate that cannot be satisfied by doing the work
    // correctly.
    assert.equal(classifyMissingCause({
      missingIds: ['a'], freshness: unknownFresh('no-upstream'), upstreamEvidence: evidence('no-upstream'),
    }).cause, MISSING_CAUSE.NOT_STALENESS);
  });

  it('UNREADABLE upstream ⇒ unknown — the direction that must fail closed', () => {
    // An empty result from a FAILED read looks exactly like a clean upstream.
    // Collapsing the two would route an operator into a repair they must not
    // run (INC-001's lesson one level down).
    for (const f of [behind(), current(), unknownFresh()]) {
      assert.equal(classifyMissingCause({
        missingIds: ['a'], freshness: f, upstreamEvidence: evidence('unreadable'),
      }).cause, MISSING_CAUSE.UNKNOWN);
    }
  });

  it('TOTALITY — every freshness × evidence combination returns a known cause', () => {
    // The guard against the exact gap the final gate found: an undefined
    // fall-through in a decision that must always answer.
    const causes = new Set(Object.values(MISSING_CAUSE));
    let checked = 0;
    for (const f of [behind(), current(), unknownFresh()]) {
      for (const status of ['read', 'absent', 'no-upstream', 'unreadable']) {
        for (const ids of [['a'], ['z'], []]) {
          const r = classifyMissingCause({
            missingIds: ['a'], freshness: f, upstreamEvidence: evidence(status, ids),
          });
          checked++;
          assert.ok(causes.has(r.cause),
            `freshness=${f.state} evidence=${status} ids=${JSON.stringify(ids)} → ${r.cause}`);
          assert.ok(Array.isArray(r.presentUpstream) && Array.isArray(r.absentUpstream));
        }
      }
    }
    // Vacuous-pass guard: a loop that stopped iterating would assert nothing.
    assert.equal(checked, 36, 'the totality sweep must cover every combination');
  });
});

describe('coverage — the verdict says what it checked', () => {
  const entry = (id, store) => ({ issueId: id, state: 'fixed', storeFingerprint: store, disposition: { kind: 'test', value: 't' } });

  it('counts checked / total / foreign', () => {
    const r = computeLedgerReconciliation({
      dbRows: [],
      ledgerEntries: [entry('a', 'MINE'), entry('b', 'OTHER'), entry('c', 'OTHER')],
      currentStore: 'MINE',
    });
    assert.deepEqual(r.coverage, { total: 3, checked: 1, foreign: 2, storeScoped: true });
  });

  it('an UNKNOWN store identity makes `checked` a ceiling, not a measurement', () => {
    // Code-audit R1 H6. `currentStoreFingerprint` catches every failure, warns,
    // and returns null so entries are written UNSTAMPED. With no store,
    // `isForeign` is false for everything — so `checked` equals `total` and the
    // verdict would claim it scoped entries it had no way to scope: this very
    // field reproducing the false-completeness it was added to remove.
    const r = computeLedgerReconciliation({
      dbRows: [], ledgerEntries: [entry('a', 'MINE'), entry('b', 'OTHER')], currentStore: null,
    });
    assert.equal(r.coverage.storeScoped, false);
    assert.equal(r.coverage.checked, 2, 'nothing can be scoped out without a store identity');
    const out = renderReconciliationReport({
      missingFromLedger: [], ledgerOnly: [], stateMismatch: [], dispositionMismatch: [],
      needsReview: [], otherStore: [], coverage: r.coverage,
    });
    assert.match(out, /store identity unknown — at most 2 of 2/);
    assert.ok(!/2 of 2 ledger entries checked/.test(out),
      'must not state a scoped count it could not compute');
  });

  it('a CLEAN verdict carries the fraction and names the unchecked', () => {
    // The defect: `clean` was true of the rows it saw while 20 of 43 entries
    // were never compared, with the fraction only derivable by counting a list.
    const out = renderReconciliationReport({
      missingFromLedger: [], ledgerOnly: [], stateMismatch: [], dispositionMismatch: [],
      needsReview: [], otherStore: ['x (store OTHER, this run is MINE)'],
      coverage: { total: 43, checked: 23, foreign: 20 },
    });
    assert.match(out, /clean — 23 of 43 ledger entries checked/);
    assert.match(out, /20 entr\(y\/ies\) belong to another store and were NOT checked/);
  });

  it('a DIVERGENT verdict carries it too', () => {
    const out = renderReconciliationReport({
      missingFromLedger: ['a'], ledgerOnly: [], stateMismatch: [], dispositionMismatch: [],
      needsReview: [], otherStore: [], coverage: { total: 10, checked: 10, foreign: 0 },
      missingCause: { cause: MISSING_CAUSE.NOT_STALENESS, presentUpstream: [], freshness: current() },
    });
    assert.match(out, /divergence found \(10 of 10 ledger entries checked\)/);
  });

  it('renders without coverage — an un-updated caller must not crash', () => {
    const out = renderReconciliationReport({
      missingFromLedger: [], ledgerOnly: [], stateMismatch: [], dispositionMismatch: [],
      needsReview: [], otherStore: [],
    });
    assert.match(out, /clean/);
  });
});

describe('the report names the CAUSE, not one guess', () => {
  const base = {
    missingFromLedger: ['a', 'b', 'c'], ledgerOnly: [], stateMismatch: [],
    dispositionMismatch: [], needsReview: [], otherStore: [],
    coverage: { total: 3, checked: 3, foreign: 0 },
  };

  it('STALE says pull, and says NOT to hand-write', () => {
    const out = renderReconciliationReport({
      ...base,
      missingCause: { cause: MISSING_CAUSE.STALE, presentUpstream: ['a', 'b', 'c'], freshness: behind(16) },
    });
    assert.match(out, /YOUR CHECKOUT IS STALE/);
    assert.match(out, /16 commit\(s\) behind origin\/main/);
    assert.match(out, /git pull/);
    assert.match(out, /do NOT hand-write/, 'the near-miss this whole change exists to prevent');
    assert.ok(!/crash-window/.test(out), 'must not offer the crash-window explanation here');
  });

  it('MIXED says pull FIRST, then re-run', () => {
    const out = renderReconciliationReport({
      ...base,
      missingCause: { cause: MISSING_CAUSE.MIXED, presentUpstream: ['a'], freshness: behind(2) },
    });
    assert.match(out, /PARTLY staleness/);
    assert.match(out, /1 of 3/);
    assert.match(out, /then re-run/);
  });

  it('UNKNOWN refuses to attribute, and says repair is refused', () => {
    const out = renderReconciliationReport({
      ...base,
      missingCause: {
        cause: MISSING_CAUSE.UNKNOWN, presentUpstream: [],
        freshness: unknownFresh('not-a-work-tree'), evidenceStatus: 'unreadable',
      },
    });
    assert.match(out, /CAUSE UNDETERMINED/);
    assert.match(out, /Repair is refused/);
  });

  it('NOT-STALENESS states what was RULED OUT and lists what remains', () => {
    // It must not name a single cause — that is the original defect wearing a
    // different label.
    const out = renderReconciliationReport({
      ...base,
      missingCause: { cause: MISSING_CAUSE.NOT_STALENESS, presentUpstream: [], freshness: current() },
    });
    assert.match(out, /staleness does NOT explain it/);
    assert.match(out, /Remaining causes:/);
    assert.match(out, /lost between the local write and the DB/);
    assert.match(out, /deleted locally/);
    assert.match(out, /remote-tracking ref is itself/);
  });

  it('with NO cause computed it falls back to a bare heading, inventing nothing', () => {
    const out = renderReconciliationReport({ ...base, missingCause: null });
    assert.match(out, /Terminal db row\(s\) with NO ledger entry \(3\):/);
    assert.ok(!/STALE|crash-window|does NOT explain/.test(out));
  });
});

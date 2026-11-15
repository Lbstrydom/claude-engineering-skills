/**
 * Work-consumer feedback 2026-11-15, item 4: plan audits capped at 100%
 * acceptance with HIGH 7→5→5. The cap policy is unchanged; the card now states
 * capped-while-productive, and the stop is recorded as telemetry.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assessCapProductivity, readLedgerEntries, recordCapStop, renderCapProductivity, roundAcceptance,
  CAP_STOP_DECISION_TYPE, PRODUCTIVE_ACCEPTANCE,
} from '../scripts/lib/audit/cap-productivity.mjs';
import { buildStructuralCard } from '../scripts/lib/audit/structural-card.mjs';
import { gateRoundCap } from '../scripts/lib/audit/round-cap-gate.mjs';
import { recordDecision, _resetForTest } from '../scripts/lib/learning/decision-logger.mjs';

const highs = (n, round) => Array.from({ length: n }, (_, i) => ({ id: `H${round}-${i}`, severity: 'HIGH', category: `c${i}`, section: 's' }));
const consumerRounds = [{ round: 1, findings: highs(7, 1), runId: 'run-1' }, { round: 2, findings: highs(5, 2), runId: 'run-2' }, { round: 3, findings: highs(5, 3), runId: 'run-3' }];
const ruledAt = (round, outcomes) => outcomes.map((o, i) => ({ topicId: `t${round}-${i}`, resolvedRound: round, adjudicationOutcome: o, ruling: o === 'dismissed' ? 'dismiss' : 'fix' }));

describe('assessCapProductivity', () => {
  test('the reported case: last round 100% accepted, HIGH 7→5→5 → still productive', () => {
    const ledger = [...ruledAt(2, ['accepted', 'dismissed']), ...ruledAt(3, Array(5).fill('accepted'))];
    const p = assessCapProductivity({ rounds: consumerRounds, ledgerEntries: ledger });
    assert.deepEqual(p.highByRound, [7, 5, 5]);
    assert.equal(p.lastRound, 3);
    assert.equal(p.lastRunId, 'run-3');
    assert.equal(p.acceptanceRate, 1);
    assert.equal(p.stillProductive, true);
    const line = renderCapProductivity(p);
    assert.match(line, /CAPPED WHILE PRODUCTIVE — round 3 acceptance 100% of 5 ruled · HIGH 7→5→5/);
    assert.match(line, /the cap policy is unchanged/);
  });

  test('a low-acceptance last round is not productive', () => {
    const p = assessCapProductivity({ rounds: consumerRounds, ledgerEntries: ruledAt(3, ['dismissed', 'dismissed', 'accepted']) });
    assert.equal(p.stillProductive, false);
    assert.doesNotMatch(renderCapProductivity(p), /CAPPED WHILE PRODUCTIVE/);
  });

  test('no ledger / untriaged last round is UNMEASURED, never "not productive"', () => {
    const a = assessCapProductivity({ rounds: consumerRounds, ledgerEntries: null, ledgerUnmeasured: 'no ledger at s-ledger.json' });
    assert.equal(a.stillProductive, null);
    assert.match(renderCapProductivity(a), /UNMEASURED \(no ledger at s-ledger\.json\)/);
    const b = assessCapProductivity({ rounds: consumerRounds, ledgerEntries: ruledAt(2, ['accepted']) });
    assert.equal(b.stillProductive, null);
    assert.match(b.unmeasured, /round 3 has no rulings/);
  });

  test('one acceptance formula: defer is never acceptance; threshold is the convergence table\'s ⅔', () => {
    const a = roundAcceptance([{ outcome: 'accepted', ruling: 'defer' }, { outcome: 'accepted', ruling: 'fix' }, { outcome: 'severity_adjusted' }]);
    assert.equal(a.acceptanceRate, 2 / 3);
    assert.equal(a.deferred, 1);
    assert.equal(PRODUCTIVE_ACCEPTANCE, 2 / 3);
  });
});

describe('the card carries it', () => {
  const okSrc = { status: 'measured', items: [], detail: null };
  test('buildStructuralCard reads the ledger and renders the line', async () => {
    const { card, text } = await buildStructuralCard({
      sid: 's', mode: 'plan', round: 4, caps: { soft: 3, absolute: 5 }, env: { AUDIT_CARD_NO_ARCH: '1' },
      deps: {
        readRounds: () => ({ rounds: consumerRounds, unmeasured: null }),
        readLedger: () => ({ entries: ruledAt(3, Array(5).fill('accepted')), unmeasured: null }),
        readStore: async () => ({ debt: okSrc, recurring: okSrc, triage: okSrc }),
        readProposals: async () => okSrc, gatherBacklog: async () => ({ upstream: okSrc, q2: okSrc }),
        fileIndex: () => null,
      },
    });
    assert.equal(card.productivity.stillProductive, true);
    assert.match(text, /CAPPED WHILE PRODUCTIVE/);
  });

  test('readLedgerEntries reads <sid>-ledger.json and names an absent one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-prod-'));
    try {
      assert.match(readLedgerEntries({ sid: 's', auditDir: dir }).unmeasured, /no ledger/);
      fs.writeFileSync(path.join(dir, 's-ledger.json'), JSON.stringify({ version: 1, entries: ruledAt(3, ['accepted']) }));
      assert.equal(readLedgerEntries({ sid: 's', auditDir: dir }).entries.length, 1);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('telemetry: round_cap_stop', () => {
  test('the decision type is admitted by the logger (no migration: free-text type)', () => {
    _resetForTest();
    const key = recordDecision({ decisionType: CAP_STOP_DECISION_TYPE, externalId: 'probe-r4-cap', context: {}, choice: { chose: 'stop_at_cap' } });
    assert.ok(key, 'admitted');
    _resetForTest();
  });

  test('recordCapStop keys on the last round\'s run id and carries the productivity verdict', async () => {
    const calls = [];
    const p = assessCapProductivity({ rounds: consumerRounds, ledgerEntries: ruledAt(3, Array(5).fill('accepted')) });
    const res = await recordCapStop({ sid: 's', mode: 'plan', round: 4, caps: { soft: 3, absolute: 5 }, productivity: p, runId: p.lastRunId },
      { record: (d) => { calls.push(d); return 'k'; }, flush: async () => {} });
    assert.deepEqual(res, { recorded: true, reason: null });
    assert.equal(calls[0].decisionType, 'round_cap_stop');
    assert.equal(calls[0].auditRunId, 'run-3');
    assert.equal(calls[0].round, 4);
    assert.equal(calls[0].choice.stillProductive, true);
    assert.deepEqual(calls[0].context.highByRound, [7, 5, 5]);
  });

  test('a refused round-4 plan audit records the stop (and still refuses)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-gate-'));
    try {
      const recorded = [];
      const res = await gateRoundCap(['plan', 'plan.md', '--round', '4', '--out', path.join(dir, 's-r4-result.json')], {
        cwd: dir, auditDir: dir, env: {}, write: () => {},
        build: async () => ({ card: { productivity: assessCapProductivity({ rounds: consumerRounds, ledgerEntries: ruledAt(3, ['accepted']) }) }, text: 'card' }),
        recordCap: async (x) => { recorded.push(x); return { recorded: true, reason: null }; },
      });
      assert.equal(res.ok, false, 'the cap policy is unchanged');
      assert.equal(recorded.length, 1);
      assert.equal(recorded[0].productivity.stillProductive, true);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

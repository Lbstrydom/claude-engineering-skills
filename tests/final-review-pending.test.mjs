/**
 * @fileoverview Contract tests for the final-review credit classifier + counts.
 *
 * The load-bearing test is `classifyFinalReviewOutcome` over its ENTIRE input
 * product. An earlier draft of the plan presented the rules as an unordered
 * table whose rows overlapped — `dismissed + regressed` matched two of them, so
 * the mapping was not a function (audit R3-H1). Enumerating the product is what
 * makes "total, first-match-wins" a checked property rather than a claim, and it
 * is what fails if the `user_action` CHECK constraint is widened again without
 * this classifier being updated (it already was once: migration
 * 20260722120000 added `auto_dismissed`).
 *
 * Plan: docs/plans/final-review-credit-and-cheap-shadow.md §2.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyFinalReviewOutcome, summariseCounts, orderItems, isActionable,
  KNOWN_USER_ACTIONS, ACTIONABLE,
} from '../scripts/lib/final-review-credit.mjs';
import {
  CREDIT_BRANCH_SHADOW_WHERE, CREDIT_BRANCH_PRIMARY_LABEL_GAP_WHERE,
} from '../scripts/lib/store/runs-findings.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const REMEDIATION_DOMAIN = [null, 'fixed', 'verified', 'regressed', 'wat'];
const ACTION_DOMAIN = [null, ...KNOWN_USER_ACTIONS, 'some-future-value'];

describe('classifyFinalReviewOutcome — total over the input product', () => {
  it('every (user_action × remediation_state) pair yields exactly one known classification', () => {
    const known = new Set([...ACTIONABLE, 'closed', 'deferred']);
    let pairs = 0;
    for (const ua of ACTION_DOMAIN) {
      for (const rs of REMEDIATION_DOMAIN) {
        const cls = classifyFinalReviewOutcome({ user_action: ua, remediation_state: rs });
        assert.equal(typeof cls, 'string', `${ua}/${rs} produced a non-string`);
        assert.ok(known.has(cls), `${ua}/${rs} → unknown classification "${cls}"`);
        pairs++;
      }
    }
    assert.equal(pairs, ACTION_DOMAIN.length * REMEDIATION_DOMAIN.length);
  });

  it('is deterministic — the same pair always classifies identically', () => {
    for (const ua of ACTION_DOMAIN) {
      for (const rs of REMEDIATION_DOMAIN) {
        const a = classifyFinalReviewOutcome({ user_action: ua, remediation_state: rs });
        const b = classifyFinalReviewOutcome({ user_action: ua, remediation_state: rs });
        assert.equal(a, b);
      }
    }
  });

  it('rule 1 — an action outside the CHECK set degrades LOUDLY to `unknown`, never to closed', () => {
    for (const rs of REMEDIATION_DOMAIN) {
      assert.equal(classifyFinalReviewOutcome({ user_action: 'some-future-value', remediation_state: rs }), 'unknown');
    }
  });

  it('rule 2 — dismissed/auto_dismissed/deferred + regressed is a surfaced contradiction, not an arbitrary winner', () => {
    for (const ua of ['dismissed', 'auto_dismissed', 'deferred']) {
      assert.equal(
        classifyFinalReviewOutcome({ user_action: ua, remediation_state: 'regressed' }),
        'integrity-warning',
        `${ua} + regressed must not silently resolve either way`,
      );
    }
  });

  it('rule 3 — a genuine re-opened defect is `regressed`', () => {
    for (const ua of [null, 'needs_triage', 'fix-now', 'accepted-permanent']) {
      assert.equal(classifyFinalReviewOutcome({ user_action: ua, remediation_state: 'regressed' }), 'regressed');
    }
  });

  it('rules 4/5 — dismissal is closed; deferral is its own non-actionable state', () => {
    assert.equal(classifyFinalReviewOutcome({ user_action: 'dismissed' }), 'closed');
    assert.equal(classifyFinalReviewOutcome({ user_action: 'auto_dismissed' }), 'closed');
    assert.equal(classifyFinalReviewOutcome({ user_action: 'deferred' }), 'deferred');
    assert.equal(isActionable('closed'), false);
    assert.equal(isActionable('deferred'), false);
  });

  it('rules 6/7 — THE defect this plan exists for: a fix with no label is its own state, not "unadjudicated"', () => {
    // recordFinalReviewFix writes remediation_state and NEVER user_action, so
    // this pair is reachable in production. A `!user_action` queue would nag
    // about it forever; collapsing it into `closed` would hide a missing label.
    assert.equal(classifyFinalReviewOutcome({ user_action: null, remediation_state: 'fixed' }), 'fixed-unlabelled');
    assert.equal(classifyFinalReviewOutcome({ user_action: null, remediation_state: 'verified' }), 'fixed-unlabelled');
    assert.equal(classifyFinalReviewOutcome({ user_action: null, remediation_state: null }), 'unadjudicated');
    // needs_triage means "not yet decided"; a shipped fix is the stronger signal.
    assert.equal(classifyFinalReviewOutcome({ user_action: 'needs_triage', remediation_state: 'fixed' }), 'fixed-unlabelled');
    assert.equal(classifyFinalReviewOutcome({ user_action: 'needs_triage', remediation_state: null }), 'unadjudicated');
  });

  it('rules 8/9 — accepted splits on whether a fix landed', () => {
    for (const ua of ['fix-now', 'accepted-permanent']) {
      assert.equal(classifyFinalReviewOutcome({ user_action: ua, remediation_state: 'fixed' }), 'closed');
      assert.equal(classifyFinalReviewOutcome({ user_action: ua, remediation_state: 'verified' }), 'closed');
      assert.equal(classifyFinalReviewOutcome({ user_action: ua, remediation_state: null }), 'accepted-unfixed');
    }
  });

  it('an unrecognised remediation_state never fabricates a fix', () => {
    assert.equal(classifyFinalReviewOutcome({ user_action: null, remediation_state: 'wat' }), 'unadjudicated');
    assert.equal(classifyFinalReviewOutcome({ user_action: 'fix-now', remediation_state: 'wat' }), 'accepted-unfixed');
  });

  it('a missing/empty row does not throw', () => {
    assert.equal(classifyFinalReviewOutcome(), 'unadjudicated');
    assert.equal(classifyFinalReviewOutcome({}), 'unadjudicated');
  });
});

describe('KNOWN_USER_ACTIONS is bound to the DATABASE domain, not just to itself', () => {
  // Code-audit R2-M6: the exhaustive-product test above enumerates
  // KNOWN_USER_ACTIONS, so it passes by construction when the DB CHECK gains a
  // value the classifier has never heard of — the drift that already happened
  // once (auto_dismissed, migration 20260722120000). A CHECK constraint cannot
  // import JS, but the committed schema baseline records its definition, so the
  // two CAN be compared without a live database.
  it('matches audit_findings_user_action_check in the committed schema baseline', () => {
    const schemaPath = path.join(REPO_ROOT, 'tests/fixtures/expected-schema.json');
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
    const check = (schema.constraints || []).find(
      (c) => c.constraint_name === 'audit_findings_user_action_check',
    );
    assert.ok(check, 'the user_action CHECK constraint vanished from the baseline — regenerate or investigate');

    // Pull every quoted literal out of the ARRAY[...] definition.
    const sqlValues = [...String(check.definition).matchAll(/'([^']+)'::text/g)].map((m) => m[1]).sort();
    assert.ok(sqlValues.length > 0, 'could not parse any literal out of the CHECK definition');
    assert.deepEqual(
      [...KNOWN_USER_ACTIONS].sort(),
      sqlValues,
      'KNOWN_USER_ACTIONS drifted from the DB CHECK domain — a new value classifies as `unknown` (safe, but unhandled). Update the classifier deliberately.',
    );
  });
});

describe('summariseCounts — exact totals, independent of any page limit', () => {
  it('sums pg COUNT(*) STRINGS numerically (a raw += would concatenate)', () => {
    const counts = summariseCounts([
      { user_action: null, remediation_state: null, n: '30' },
      { user_action: null, remediation_state: null, n: '12' },
    ]);
    assert.equal(counts.unadjudicated, 42, 'string counts must add, not concatenate');
    assert.equal(counts.totalActionable, 42);
  });

  it('excludes non-actionable classifications from every total', () => {
    const counts = summariseCounts([
      { user_action: 'dismissed', remediation_state: null, n: 100 },
      { user_action: 'deferred', remediation_state: null, n: 100 },
      { user_action: 'accepted-permanent', remediation_state: 'fixed', n: 100 },
      { user_action: null, remediation_state: null, n: 3 },
    ]);
    assert.equal(counts.totalActionable, 3);
    assert.equal(counts.unadjudicated, 3);
  });

  it('buckets each actionable class separately', () => {
    const counts = summariseCounts([
      { user_action: null, remediation_state: null, n: 5 },
      { user_action: null, remediation_state: 'fixed', n: 2 },
      { user_action: 'accepted-permanent', remediation_state: null, n: 10 },
      { user_action: null, remediation_state: 'regressed', n: 1 },
      { user_action: 'dismissed', remediation_state: 'regressed', n: 4 },
      { user_action: 'nope', remediation_state: null, n: 7 },
    ]);
    assert.deepEqual(counts, {
      unadjudicated: 5, fixedUnlabelled: 2, acceptedUnfixed: 10,
      regressed: 1, integrityWarning: 4, unknown: 7, totalActionable: 29,
    });
  });

  it('is empty-safe and ignores zero/garbage group counts', () => {
    assert.equal(summariseCounts().totalActionable, 0);
    assert.equal(summariseCounts([]).totalActionable, 0);
    assert.equal(summariseCounts([{ user_action: null, n: 0 }, { user_action: null, n: 'x' }]).totalActionable, 0);
  });
});

describe('orderItems — a deterministic total order', () => {
  const rows = [
    { severity: 'LOW', created_at: '2026-07-01', finding_fingerprint: 'ccc' },
    { severity: 'HIGH', created_at: '2026-07-01', finding_fingerprint: 'bbb' },
    { severity: 'HIGH', created_at: '2026-07-02', finding_fingerprint: 'aaa' },
    { severity: 'MEDIUM', created_at: '2026-07-05', finding_fingerprint: 'ddd' },
  ];

  it('orders by severity, then newest first', () => {
    assert.deepEqual(orderItems(rows).map((r) => r.finding_fingerprint), ['aaa', 'bbb', 'ddd', 'ccc']);
  });

  it('breaks exact ties on fingerprint so the order is TOTAL (no input-order dependence)', () => {
    const tied = [
      { severity: 'HIGH', created_at: '2026-07-01', finding_fingerprint: 'zzz' },
      { severity: 'HIGH', created_at: '2026-07-01', finding_fingerprint: 'aaa' },
    ];
    assert.deepEqual(orderItems(tied).map((r) => r.finding_fingerprint), ['aaa', 'zzz']);
    assert.deepEqual(orderItems([...tied].reverse()).map((r) => r.finding_fingerprint), ['aaa', 'zzz']);
  });

  it('does not mutate its input, and tolerates unknown severities', () => {
    const input = [{ severity: 'WAT', finding_fingerprint: 'x' }, { severity: 'HIGH', finding_fingerprint: 'y' }];
    const snapshot = JSON.stringify(input);
    assert.deepEqual(orderItems(input).map((r) => r.finding_fingerprint), ['y', 'x']);
    assert.equal(JSON.stringify(input), snapshot, 'orderItems must not sort in place');
  });
});

describe('the credit card\'s totals and its list describe ONE population', () => {
  // The defect this pins (found 2026-09-04 while working the credit queue):
  // `getFinalReviewStats` builds the LIST (`pendingQueue`) and the exact TOTALS
  // (`actionablePairs`) as two separate SQL statements. The card prints the
  // totals as a header over the list, so the two must cover the same findings.
  // `docs/plans/skill-efficacy-census.md` Phase 1 widened the LIST from
  // shadow-only to `shadow-only ∪ primary-bucket-label-gap` and left the TOTALS
  // on the narrow half. Live measurement before the fix: the header read
  // `486 … 3 fixed-but-unlabelled` above ten listed rows that ALL carried
  // `bucket: null` — ten members of a class counted as three. True totals:
  // 2,175 actionable and 1,692 fixed-unlabelled, a 563x under-report of the
  // exact class the queue exists to surface.
  //
  // This is a SOURCE scan, not a behavioural test, and deliberately so: the
  // behaviour needs a live Postgres, but the failure was never a wrong row — it
  // was two queries that stopped describing the same set. Binding both to the
  // shared predicate makes one-sided widening the thing that fails here.
  const SOURCE = fs.readFileSync(
    path.join(REPO_ROOT, 'scripts/lib/store/runs-findings.mjs'), 'utf-8',
  );

  /** Body of a `const <name> = await many(\`…\`, […]);` assignment. */
  function queryLiteral(name) {
    const start = SOURCE.indexOf(`const ${name} = await many(`);
    assert.notEqual(start, -1, `could not find the ${name} query — was it renamed?`);
    const open = SOURCE.indexOf('`', start);
    const close = SOURCE.indexOf('`', open + 1);
    assert.ok(open !== -1 && close !== -1, `could not delimit the ${name} SQL literal`);
    return SOURCE.slice(open + 1, close);
  }

  it('exports the two branch predicates, and they partition on bucket', () => {
    assert.ok(CREDIT_BRANCH_SHADOW_WHERE.includes(`f.bucket = 'shadow-only'`));
    assert.ok(CREDIT_BRANCH_PRIMARY_LABEL_GAP_WHERE.includes('f.bucket IS NULL'));
    // Mutually exclusive by construction — what makes the queue's UNION ALL safe.
    assert.ok(!CREDIT_BRANCH_SHADOW_WHERE.includes('f.bucket IS NULL'));
    assert.ok(!CREDIT_BRANCH_PRIMARY_LABEL_GAP_WHERE.includes(`f.bucket = 'shadow-only'`));
    // Both bind the repo as $1, so either can be dropped into either query.
    assert.ok(CREDIT_BRANCH_SHADOW_WHERE.includes('r.repo_id = $1'));
    assert.ok(CREDIT_BRANCH_PRIMARY_LABEL_GAP_WHERE.includes('r.repo_id = $1'));
  });

  for (const q of ['pendingQueue', 'actionablePairs']) {
    it(`${q} is built from BOTH shared branch predicates, not an inlined clause`, () => {
      const sql = queryLiteral(q);
      assert.ok(
        sql.includes('${CREDIT_BRANCH_SHADOW_WHERE}'),
        `${q} no longer interpolates CREDIT_BRANCH_SHADOW_WHERE — an inlined clause is how the two queries drifted apart before`,
      );
      assert.ok(
        sql.includes('${CREDIT_BRANCH_PRIMARY_LABEL_GAP_WHERE}'),
        `${q} no longer interpolates CREDIT_BRANCH_PRIMARY_LABEL_GAP_WHERE — this is the exact one-sided narrowing that under-reported the queue 563x`,
      );
    });
  }
});

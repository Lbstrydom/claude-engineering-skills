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
} from '../scripts/lib/store/final-review-credit-population.mjs';
import { finalReviewPendingCmd, encodeQueueCursor, decodeQueueCursor } from '../scripts/lib/cross-skill/commands/final-review.mjs';
import { CommandError } from '../scripts/lib/cross-skill/dispatch.mjs';

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
  const POPULATION_SOURCE = fs.readFileSync(
    path.join(REPO_ROOT, 'scripts/lib/store/final-review-credit-population.mjs'), 'utf-8',
  );

  // Where each query's SQL literal lives. `pendingQueue` moved beside its
  // predicates (`pendingQueueSql`) when it became keyset-paged (2026-09-13);
  // `actionablePairs` stays inline in runs-findings.mjs.
  const LITERALS = {
    pendingQueue: { source: POPULATION_SOURCE, anchor: 'export function pendingQueueSql(' , skipLiterals: 1 },
    actionablePairs: { source: SOURCE, anchor: 'const actionablePairs = await many(', skipLiterals: 0 },
  };

  /** The FINAL template literal after `anchor` (skipping `skipLiterals` earlier ones, e.g. the cursor WHERE). */
  function queryLiteral(name) {
    const { source, anchor, skipLiterals } = LITERALS[name];
    const start = source.indexOf(anchor);
    assert.notEqual(start, -1, `could not find the ${name} query — was it renamed?`);
    let open = source.indexOf('`', start);
    let close = source.indexOf('`', open + 1);
    for (let i = 0; i < skipLiterals; i += 1) {
      open = source.indexOf('`', close + 1);
      close = source.indexOf('`', open + 1);
    }
    assert.ok(open !== -1 && close !== -1, `could not delimit the ${name} SQL literal`);
    return source.slice(open + 1, close);
  }

  it('defines the two branch predicates, and they partition on bucket', () => {
    assert.ok(CREDIT_BRANCH_SHADOW_WHERE.includes("f.bucket = 'shadow-only'"));
    assert.ok(CREDIT_BRANCH_PRIMARY_LABEL_GAP_WHERE.includes('f.bucket IS NULL'));
    // Mutually exclusive by construction - what makes the queue's UNION ALL safe.
    assert.ok(!CREDIT_BRANCH_SHADOW_WHERE.includes('f.bucket IS NULL'));
    assert.ok(!CREDIT_BRANCH_PRIMARY_LABEL_GAP_WHERE.includes("f.bucket = 'shadow-only'"));
    // Both bind the repo as $1, so either can drop into either query.
    assert.ok(CREDIT_BRANCH_SHADOW_WHERE.includes('r.repo_id = $1'));
    assert.ok(CREDIT_BRANCH_PRIMARY_LABEL_GAP_WHERE.includes('r.repo_id = $1'));
  });

  it('never reaches the learning-store barrel, whose surface is pinned functions-only', async () => {
    // These live in their own module precisely so they can be shared without
    // this happening: `scripts/learning-store.mjs` does `export *` from
    // runs-findings.mjs, and `tests/learning-store-exports.test.mjs` pins that
    // surface to callable functions. An earlier version of this fix declared
    // them IN runs-findings.mjs and exported them, which failed that pin with
    // `extra: [CREDIT_BRANCH_PRIMARY_LABEL_GAP_WHERE, CREDIT_BRANCH_SHADOW_WHERE]`.
    // Asserted against the barrel itself, not against source text, because the
    // barrel is what the pin actually reads.
    // Line-anchored, and NOT a loose `export[^;]*CREDIT_BRANCH_` scan: the
    // import above is preceded by a comment containing the words `export *`,
    // with no semicolon between it and the imported names, so the loose form
    // matched its own explanatory comment.
    const reExports = SOURCE.split(/\r?\n/).filter(
      (l) => /^\s*export\b/.test(l) && l.includes('CREDIT_BRANCH_'),
    );
    assert.deepEqual(reExports, [], 'runs-findings.mjs must IMPORT these, never re-export them');
    const barrel = await import('../scripts/learning-store.mjs');
    for (const name of ['CREDIT_BRANCH_SHADOW_WHERE', 'CREDIT_BRANCH_PRIMARY_LABEL_GAP_WHERE']) {
      assert.ok(!(name in barrel), `${name} leaked onto the learning-store public surface`);
    }
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


// ═══════════════════════════════════════════════════════════════════════
// Keyset paging (docs/plans/backlog-tooling-honesty.md §2, audit-plan R1 H2).
// The queue is drained by the adjudication that walks it, so the contract is a
// cursor from the last RAW row, never an offset.
// ═══════════════════════════════════════════════════════════════════════

const CURSOR = { severityRank: 3, createdAt: '2026-09-13 10:00:00.123456+00', fingerprint: 'abcd1234', runId: '00000000-0000-4000-8000-000000000001', findingId: '00000000-0000-4000-8000-0000000000f1' };

describe('encodeQueueCursor / decodeQueueCursor', () => {
  it('round-trips, and carries createdAt as TEXT (microsecond-exact), never a Date', () => {
    const c = encodeQueueCursor(CURSOR);
    assert.match(c, /^[A-Za-z0-9_-]+$/, 'base64url — safe on a command line');
    assert.deepEqual(decodeQueueCursor(c), CURSOR);
    assert.equal(typeof decodeQueueCursor(c).createdAt, 'string');
  });

  it('accepts real calendar boundaries in the store shape (leap day, end of month, negative offset late at night)', () => {
    for (const good of ['2028-02-29 10:00:00.000001+00', '2026-04-30 23:59:59.999999+00', '2026-09-13 23:30:00-05', '2026-09-13T00:00:00Z']) {
      assert.deepEqual(decodeQueueCursor(encodeQueueCursor({ ...CURSOR, createdAt: good })).createdAt, good, `must accept ${good}`);
    }
  });

  it('refuses a malformed cursor as BAD_INPUT rather than silently starting over', () => {
    const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    for (const bad of [
      'not-a-cursor', enc({ v: 1 }), enc([]), '',
      enc({ ...CURSOR, createdAt: 'not-a-timestamp' }),
      enc({ ...CURSOR, runId: 'not-a-uuid' }),
      enc({ ...CURSOR, severityRank: 9 }),
      enc({ ...CURSOR, fingerprint: 'has spaces; DROP' }),
      enc({ ...CURSOR, createdAt: '2026-13-01 10:00:00.000001+00' }),
      enc({ ...CURSOR, createdAt: '2026-02-30 10:00:00.000001+00' }),
      enc({ ...CURSOR, createdAt: '2026-04-31 23:59:59+02' }),
      enc({ ...CURSOR, findingId: 'not-a-uuid' }),
      enc({ ...CURSOR, v: 1 }),
    ]) {
      assert.throws(() => decodeQueueCursor(bad), (e) => e instanceof CommandError && e.code === 'BAD_INPUT', `must refuse ${JSON.stringify(bad)}`);
    }
  });
});

/** A raw pendingQueue row in the store's total order. */
function queueRow(i, { severity = 'HIGH', actionable = true } = {}) {
  return {
    audit_finding_id: `00000000-0000-4000-8000-0000000000${String(i).padStart(2, '0')}`, run_id: '00000000-0000-4000-8000-000000000001', finding_fingerprint: `ab${String(i).padStart(6, '0')}`,
    severity, category: 'test', primary_file: `src/${i}.mjs`, detail_snapshot: 'prose',
    source_model: 'm', bucket: 'shadow-only',
    // a shadow-only row already labelled dismissed is NOT actionable
    user_action: actionable ? null : 'dismissed', remediation_state: null,
    created_at: new Date(Date.UTC(2026, 8, 13, 10, 0, 0, 0)), created_at_cursor: `2026-09-13 10:00:00.0000${String(9 - i).padStart(2, '0')}+00`.replace(/.(d{6})d+/, '.$1'),
    severity_rank: severity === 'HIGH' ? 3 : 2,
  };
}

function pendingCtx({ flags = {}, queue = [], pairs = [], onCall = () => {} } = {}) {
  return {
    cloud: { enabled: true },
    flag: (name) => flags[name] ?? null,
    hasFlag: (name) => flags[name] === true,
    payload: () => ({}),
    deps: {
      getFinalReviewStats: async (repo, opts) => { onCall(repo, opts); return { ok: true, pendingQueue: queue, actionablePairs: pairs }; },
      resolveNudgePage: (o) => ({ limit: Math.min(Math.max(Number(o.limit) || 20, 1), 200), offset: 0 }),
      getFindingEmbeddings: async () => new Map(),
    },
  };
}

describe('final-review-pending — cursor paging', () => {
  it('passes the resolved limit and the DECODED cursor to the store; --page-size is the alias of --limit', async () => {
    const calls = [];
    const ctx = pendingCtx({ flags: { repo: 'owner/repo', 'page-size': '10', after: encodeQueueCursor(CURSOR) }, onCall: (r, o) => calls.push([r, o]) });
    const out = await finalReviewPendingCmd(ctx);
    assert.deepEqual(calls, [['owner/repo', { queueLimit: 10, after: CURSOR }]]);
    assert.equal(out.limit, 10);
    assert.equal(out.after, encodeQueueCursor(CURSOR));
  });

  it('nextCursor comes from the last RAW row and is present even when every row on the page was filtered out', async () => {
    const queue = [queueRow(1, { actionable: false }), queueRow(2, { actionable: false })];
    const out = await finalReviewPendingCmd(pendingCtx({ flags: { repo: 'owner/repo', limit: '2' }, queue }));
    assert.equal(out.state, 'ready');
    assert.deepEqual(out.items, [], 'nothing actionable on this page');
    assert.equal(out.pageFilteredOut, 2);
    assert.ok(out.nextCursor, 'the walk must continue past a fully filtered page');
    assert.deepEqual(decodeQueueCursor(out.nextCursor), {
      severityRank: 3, createdAt: queue[1].created_at_cursor, fingerprint: 'ab000002', runId: queue[1].run_id, findingId: queue[1].audit_finding_id,
    });
  });

  it('nextCursor is null when the store returned a SHORT page (fewer raw rows than limit) — that is exhaustion', async () => {
    const out = await finalReviewPendingCmd(pendingCtx({ flags: { repo: 'owner/repo', limit: '5' }, queue: [queueRow(1), queueRow(2)] }));
    assert.equal(out.shownCount, 2);
    assert.equal(out.pageFilteredOut, 0);
    assert.equal(out.nextCursor, null);
  });

  it('a cursor past the end yields an empty page, null nextCursor, and totals untouched', async () => {
    const pairs = [{ user_action: null, remediation_state: null, n: 7 }];
    const out = await finalReviewPendingCmd(pendingCtx({ flags: { repo: 'owner/repo', after: encodeQueueCursor(CURSOR) }, queue: [], pairs }));
    assert.deepEqual(out.items, []);
    assert.equal(out.nextCursor, null);
    assert.equal(out.counts.totalActionable, 7, 'counts are page-independent');
  });

  it('a malformed --after is BAD_INPUT', async () => {
    await assert.rejects(() => finalReviewPendingCmd(pendingCtx({ flags: { repo: 'owner/repo', after: 'garbage' } })),
      (e) => e instanceof CommandError && e.code === 'BAD_INPUT');
  });

  it('the cursor is the STORE order\'s last row, even when the display re-sort would put a different row last', async () => {
    // Two rows the store orders [1, 2] but whose display sort (fingerprint ASC within a tie) would flip.
    const a = { ...queueRow(1), finding_fingerprint: 'ab000009' };
    const b = { ...queueRow(2), finding_fingerprint: 'ab000001', created_at_cursor: a.created_at_cursor };
    const out = await finalReviewPendingCmd(pendingCtx({ flags: { repo: 'owner/repo', limit: '2' }, queue: [a, b] }));
    assert.equal(decodeQueueCursor(out.nextCursor).findingId, b.audit_finding_id, 'cursor = store-last (b), not display-last');
  });

  it('items carry audit_finding_id (the grouper key) and still drop detail_snapshot', async () => {
    const out = await finalReviewPendingCmd(pendingCtx({ flags: { repo: 'owner/repo' }, queue: [queueRow(1)] }));
    assert.equal(out.items[0].audit_finding_id, '00000000-0000-4000-8000-000000000001');
    assert.equal('detail_snapshot' in out.items[0], false);
  });
});

/**
 * @fileoverview Tier 1 (pure): the Home decision core — the chip grading table, the
 * Needs-you rule table and ranker, the truncation helper and the card composition.
 * No git, no store, no clock.
 *
 * The honesty rules each have a NEGATIVE CONTROL: `violationsOfNeverOkWhenUnmeasured`
 * is run against a deliberately wrong grader and must report the violation, so a
 * check that cannot fail is caught here, and the same predicate then holds the real
 * grader to the rule.
 *
 * Plan: docs/plans/dashboard-home-summary.md §2, §9.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  HEALTH_RULES, NEEDS_RULES, gradeHealth, rankNeedsYou, buildHomeModel, makeMeasurement, bound, clip,
  LIMITS, MAX_NEEDS_ROWS, NOTHING_NEEDS_YOU, staleInProgress,
} from '../scripts/lib/dashboard/home-model.mjs';

const NOW = '2026-10-06T12:00:00.000Z';
let seq = 0;
/** One measurement with sensible defaults; `status` defaults to ok. */
function m(id, value, extra = {}) {
  seq += 1;
  return makeMeasurement({ id, label: extra.label ?? id, card: extra.card ?? 'queues', value, status: 'ok', asOf: NOW, source: `src-${seq}`, ...extra });
}
const q = (id, value, previous = null, previousAt = null, extra = {}) => m(id, value, { previous, previousAt, ...extra });

const Q1 = (code, plan = 0) => ({ total: code + plan, code, plan, aged: null });
const Q2 = (code, plan = 0) => ({ total: code + plan, code, plan, perm: null });
const agents = (chars, cap = 1000) => m('agents-size', { chars, cap }, { card: 'vitals' });
const consumers = (over = {}) => m('consumers', {
  mode: 'source', total: 2, inspected: 2, omitted: 0, current: 2, behind: 0, notComparable: 0, unreadable: 0, rows: [], ...over,
}, { card: 'consumers' });

/** A full set of ok measurements, every rule quiet. */
function quietSet() {
  return [
    q('queue-q1', Q1(0, 3), { total: 5, code: 2 }, '2026-10-05T10:00:00Z'),
    q('queue-q2', Q2(0)),
    q('queue-q3', { total: 0 }, null, null, { repo: 'owner/repo' }),
    q('queue-debt', { total: 0, cloud: 0, local: 0, spilled: 0 }),
    q('queue-upstream', { total: 0, partial: false, oldestAt: null }),
    agents(500),
    m('plans', { inProgress: 1, total: 4, plans: [] }, { card: 'vitals' }),
    m('skills', { count: 17, roster: 17 }, { card: 'vitals' }),
    m('maintenance', { lastRunAt: '2026-10-05T00:00:00Z', windowDays: 7, overdueDays: 0 }, { card: 'vitals' }),
    consumers(),
    m('shipped-log', { entries: [], skippedHeadings: 0 }, { card: 'shipped' }),
    m('shipped-merges', { branch: 'main', subjects: [] }, { card: 'shipped' }),
    m('inflight', { rows: [], more: 0, total: 0 }, { card: 'inflight' }),
  ];
}
const withOverride = (id, replacement) => quietSet().map((x) => (x.id === id ? replacement : x));
const chip = (ms, id) => gradeHealth(ms).find((c) => c.id === id);

describe('HEALTH_RULES — every row, both ways', () => {
  test('the table covers exactly the ten chips, each with a stated rule', () => {
    assert.deepEqual(HEALTH_RULES.map((r) => r.id), ['queue-q1', 'queue-q2', 'queue-q3', 'queue-debt', 'queue-upstream', 'agents-size', 'plans', 'consumers', 'maintenance', 'skills']);
    assert.ok(HEALTH_RULES.every((r) => r.rule.length > 10 && typeof r.grade === 'function'));
  });

  test('queues: ok when not above previous, warn when grew, neutral with no baseline', () => {
    const mk = (cur, prev) => q('queue-q2', Q2(cur), prev === null ? null : { total: prev, code: prev }, prev === null ? null : '2026-10-05T10:00:00Z');
    assert.equal(chip([mk(4, 5)], 'queue-q2').state, 'ok');
    assert.equal(chip([mk(5, 5)], 'queue-q2').state, 'ok', 'equal to previous is ok (<=)');
    assert.equal(chip([mk(6, 5)], 'queue-q2').state, 'warn');
    assert.equal(chip([mk(6, null)], 'queue-q2').state, 'neutral', 'measured with no baseline is neutral, never green');
    assert.equal(chip([q('queue-q2', Q2(3), { total: NaN })], 'queue-q2').state, 'neutral');
    assert.equal(chip([mk(4, 5)], 'queue-q2').value, '4c/0p');
  });

  test('M1: a paginated (partial) count is a LOWER BOUND: current or previous partial => neutral, never ok/warn', () => {
    const up = (cur, prev) => q('queue-upstream', { total: cur.total, partial: cur.partial, oldestAt: null }, prev, '2026-10-05T10:00:00Z');
    assert.equal(chip([up({ total: 5, partial: true }, { total: 9, partial: false })], 'queue-upstream').state, 'neutral', 'current partial');
    assert.equal(chip([up({ total: 5, partial: false }, { total: 3, partial: true })], 'queue-upstream').state, 'neutral', 'previous partial: 5 vs "3+" is not "grew"');
    assert.equal(chip([up({ total: 2, partial: false }, { total: 3, partial: true })], 'queue-upstream').state, 'neutral', 'and 2 vs "3+" is not "ok"');
    assert.match(chip([up({ total: 5, partial: true }, { total: 9, partial: false })], 'queue-upstream').detail, /lower bound/);
    assert.equal(chip([up({ total: 5, partial: false }, { total: 3, partial: false })], 'queue-upstream').state, 'warn', 'exact vs exact still compares');
  });

  test('queue chips never reach bad (no threshold without a baseline)', () => {
    for (const cur of [0, 5, 10_000]) assert.notEqual(chip([q('queue-q3', { total: cur }, { total: 1 })], 'queue-q3').state, 'bad');
  });

  test('AGENTS.md size: 94 ok, 95 warn, 100 warn, 101 bad (percent of the cap, integer-exact)', () => {
    assert.equal(chip([agents(940)], 'agents-size').state, 'ok');
    assert.equal(chip([agents(949)], 'agents-size').state, 'ok');
    assert.equal(chip([agents(950)], 'agents-size').state, 'warn');
    assert.equal(chip([agents(1000)], 'agents-size').state, 'warn');
    assert.equal(chip([agents(1001)], 'agents-size').state, 'bad');
    assert.equal(chip([agents(1010)], 'agents-size').state, 'bad');
  });

  test('plans: ok with none stale, warn with at least one (the staleness policy lives HERE, from raw dates and asOf)', () => {
    const plan = (date) => ({ slug: 'a', path: 'docs/plans/a.md', date });
    const at = (plans) => chip([m('plans', { inProgress: plans.length, total: 9, plans })], 'plans');
    assert.equal(at([]).state, 'ok');
    assert.equal(at([plan('2026-09-22T12:00:00.000Z')]).state, 'ok', 'exactly 14 days is not older than 14');
    assert.equal(at([plan('2026-09-22T11:00:00.000Z')]).state, 'warn', 'older than 14 days by an hour');
    assert.equal(at([plan('2026-09-21T11:00:00.000Z')]).state, 'warn', '15 days');
    assert.equal(at([plan(null)]).state, 'ok', 'an undated plan cannot be called stale');
    assert.deepEqual(staleInProgress(m('plans', { plans: [plan('2026-09-01T12:00:00.000Z'), plan('2026-10-05T12:00:00.000Z')] })).map((p) => p.days), [35]);
    assert.deepEqual(staleInProgress({ value: { plans: [plan('2026-09-01T00:00:00Z')] }, asOf: null }), [], 'no asOf, no claim');
  });

  test('consumers: ok only when all inspected AND every one current', () => {
    assert.equal(chip([consumers()], 'consumers').state, 'ok');
    assert.equal(chip([consumers({ current: 1, behind: 1 })], 'consumers').state, 'warn');
    const nc = chip([consumers({ current: 1, notComparable: 1 })], 'consumers');
    assert.equal(nc.state, 'neutral', 'not comparable is a limit of the evidence, not a defect: never a permanent warn');
    assert.match(nc.detail, /typical after a squash-merge.*no bundle hash/);
    assert.equal(chip([consumers({ current: 0, notComparable: 2 })], 'consumers').state, 'neutral');
    assert.equal(chip([consumers({ current: 0, notComparable: 1, behind: 1 })], 'consumers').state, 'warn', 'behind still warns beside a not-comparable one');
    assert.equal(chip([consumers({ current: 1, unreadable: 1 })], 'consumers').state, 'warn');
    assert.equal(chip([consumers({ total: 0, inspected: 0, current: 0 })], 'consumers').state, 'warn', 'no consumers is not "all current"');
  });

  test('consumers: omitted > 0 can NEVER be ok, even when every inspected one is current', () => {
    const c = chip([consumers({ total: 25, inspected: 20, omitted: 5, current: 20 })], 'consumers');
    assert.equal(c.state, 'warn');
    assert.match(c.value, /\+5 not inspected/);
  });

  test('consumers in a consumer repo: a neutral fact, not a judgement', () => {
    const c = chip([m('consumers', { mode: 'consumer', syncedAt: '2026-10-01T00:00:00.000Z', sha7: 'abc1234' }, { card: 'consumers' })], 'consumers');
    assert.equal(c.state, 'neutral');
    assert.match(c.value, /last synced 2026-10-01.* from abc1234/);
  });

  test('maintenance: ok within the window, warn when overdue', () => {
    assert.equal(chip([m('maintenance', { lastRunAt: 'x', windowDays: 7, overdueDays: 0 })], 'maintenance').state, 'ok');
    assert.equal(chip([m('maintenance', { lastRunAt: 'x', windowDays: 7, overdueDays: 3 })], 'maintenance').state, 'warn');
  });

  test('skills: equal is a neutral count, unequal is bad (the census roster is stale)', () => {
    assert.deepEqual([chip([m('skills', { count: 17, roster: 17 })], 'skills').state, chip([m('skills', { count: 17, roster: 17 })], 'skills').value], ['neutral', '17']);
    assert.equal(chip([m('skills', { count: 16, roster: 17 })], 'skills').state, 'bad');
  });
});

/**
 * The honesty rule as a PREDICATE over a grader: no measurement whose status is not
 * `ok` (or that is absent) may yield any state but `unmeasured`.
 */
function violationsOfNeverOkWhenUnmeasured(grade) {
  const bad = [];
  for (const status of ['missing-optional', 'invalid', 'unexpected-error']) {
    const ms = quietSet().map((x) => ({ ...x, status }));
    for (const c of grade(ms)) if (c.state !== 'unmeasured' || c.measured !== false) bad.push(`${c.id} with status ${status} graded ${c.state}`);
  }
  for (const c of grade([])) if (c.state !== 'unmeasured') bad.push(`${c.id} with NO measurement graded ${c.state}`);
  return bad;
}

describe('unmeasured is never ok (negative control + the real grader)', () => {
  test('NEGATIVE CONTROL: the predicate catches a grader that returns ok for unexpected-error', () => {
    const wrong = (ms) => gradeHealth(ms).map((c) => (c.state === 'unmeasured' ? { ...c, state: 'ok', measured: true } : c));
    const found = violationsOfNeverOkWhenUnmeasured(wrong);
    assert.ok(found.length >= HEALTH_RULES.length, `the instrument must see the mutant fail; found ${found.length}`);
  });

  test('the real gradeHealth has no violation', () => {
    assert.deepEqual(violationsOfNeverOkWhenUnmeasured(gradeHealth), []);
  });

  test('an unmeasured chip shows the reason, not a number', () => {
    const c = chip([makeMeasurement({ id: 'agents-size', label: 'AGENTS.md size', card: 'vitals', value: { chars: 1, cap: 100 }, status: 'unexpected-error', detail: 'cannot read AGENTS.md (EIO)', source: 's' })], 'agents-size');
    assert.equal(c.state, 'unmeasured');
    assert.equal(c.value, '—');
    assert.match(c.detail, /cannot read AGENTS\.md/);
  });

  test('a degraded source degrades ONE chip: the Plans chip stays measured when maintenance is unreadable', () => {
    const ms = withOverride('maintenance', makeMeasurement({ id: 'maintenance', label: 'Maintenance', card: 'vitals', status: 'missing-optional', detail: 'no heartbeat', source: 's' }));
    const chips = gradeHealth(ms);
    assert.equal(chips.find((c) => c.id === 'maintenance').state, 'unmeasured');
    assert.equal(chips.find((c) => c.id === 'plans').state, 'ok');
    assert.equal(chips.filter((c) => c.state === 'unmeasured').length, 1);
  });

  test('makeMeasurement refuses a status it does not know (a typo must not become "ok" or silently "not ok")', () => {
    assert.throws(() => makeMeasurement({ id: 'x', label: 'x', card: 'queues', status: 'okay', source: 's' }), /invalid status/);
  });
});

describe('NEEDS_RULES — each rule fires and stays quiet', () => {
  const fired = (ms) => rankNeedsYou(ms).rows.map((r) => r.ruleId);

  test('the quiet fixture fires nothing and says so', () => {
    const n = rankNeedsYou(quietSet());
    assert.deepEqual(n.rows, []);
    assert.equal(n.headline, NOTHING_NEEDS_YOU);
    assert.equal(n.more, 0);
  });

  test('the table is the eleven committed rules in id order', () => {
    assert.deepEqual(NEEDS_RULES.map((r) => r.id), ['N01', 'N02', 'N03', 'N04', 'N05', 'N06', 'N07', 'N08', 'N09', 'N10', 'N11']);
    assert.deepEqual(NEEDS_RULES.map((r) => r.severity), [3, 3, 3, 2, 2, 2, 2, 2, 2, 1, 1]);
  });

  test('N02 skills roster differs', () => {
    assert.deepEqual(fired(withOverride('skills', m('skills', { count: 16, roster: 17 }))), ['N02']);
    assert.match(rankNeedsYou(withOverride('skills', m('skills', { count: 16, roster: 17 }))).rows[0].text, /Census roster is stale \(16 skills vs 17\)/);
  });

  test('N03 upstream open > 0 (anchored by the oldest report)', () => {
    const ms = withOverride('queue-upstream', q('queue-upstream', { total: 2, partial: false, oldestAt: '2026-09-01T00:00:00.000Z' }));
    const r = rankNeedsYou(ms).rows[0];
    assert.equal(r.ruleId, 'N03');
    assert.equal(r.anchor, '2026-09-01T00:00:00.000Z');
    assert.equal(r.command, 'npm run upstream:queues');
  });

  test('N04 Q2 total > 0 and not below previous: fires equal/grew/no-baseline, quiet when below', () => {
    const mk = (cur, prev) => withOverride('queue-q2', q('queue-q2', Q2(cur), prev === null ? null : { total: prev, code: prev }, prev === null ? null : '2026-10-05T10:00:00Z'));
    assert.deepEqual(fired(mk(5, 5)), ['N04']);
    assert.deepEqual(fired(mk(6, 5)), ['N04']);
    assert.deepEqual(fired(mk(6, null)), ['N04']);
    assert.deepEqual(fired(mk(4, 5)), [], 'below the previous line is progress, not a nag');
    assert.deepEqual(fired(mk(0, null)), []);
  });

  test('N05 Q1 code > 0 and not below previous (plan-mode counts do not trigger it)', () => {
    const mk = (code, prevCode) => withOverride('queue-q1', q('queue-q1', Q1(code, 9), prevCode === null ? null : { total: prevCode + 9, code: prevCode }, '2026-10-05T10:00:00Z'));
    assert.deepEqual(fired(mk(3, 3)), ['N05']);
    assert.deepEqual(fired(mk(2, 3)), []);
    assert.deepEqual(fired(withOverride('queue-q1', q('queue-q1', Q1(0, 40)))), [], 'plan-mode items alone are not "code fixes without a lock"');
  });

  test('N06 one row per stale plan, anchored by the plan date', () => {
    const plans = [{ slug: 'alpha', path: 'docs/plans/alpha.md', date: '2026-09-06T00:00:00.000Z' }, { slug: 'beta', path: 'docs/plans/beta.md', date: '2026-09-21T00:00:00.000Z' }, { slug: 'gamma', path: 'docs/plans/gamma.md', date: '2026-10-01T00:00:00.000Z' }];
    const rows = rankNeedsYou(withOverride('plans', m('plans', { inProgress: 3, total: 3, plans }))).rows;
    assert.deepEqual(rows.map((r) => r.text), ['Plan alpha In Progress for 30 days', 'Plan beta In Progress for 15 days']);
    assert.ok(rows.every((r) => r.command === null && r.tab === 'plans'));
  });

  test('N07 behind consumers: the command carries the VALIDATED name only', () => {
    const rows = [
      { name: 'consumer-one', state: 'behind', behind: 3, syncedAt: '2026-10-01T00:00:00.000Z' },
      { name: 'evil; rm -rf /', state: 'behind', behind: 1, syncedAt: null },
      { name: 'fine', state: 'current', behind: null, syncedAt: null },
    ];
    const out = rankNeedsYou(withOverride('consumers', consumers({ total: 3, inspected: 3, current: 1, behind: 2, rows }))).rows;
    assert.equal(out.length, 2);
    assert.equal(out[0].command, 'npm run sync -- --target consumer-one');
    assert.equal(out[1].command, null);
    assert.equal(out[1].commandNote, 'command unavailable');
    assert.doesNotMatch(JSON.stringify(out), /rm -rf/, 'an unvalidated name is never interpolated, nor echoed');
  });

  test('N08 maintenance overdue', () => {
    const r = rankNeedsYou(withOverride('maintenance', m('maintenance', { lastRunAt: '2026-09-20T00:00:00.000Z', windowDays: 7, overdueDays: 9 }))).rows[0];
    assert.equal(r.ruleId, 'N08');
    assert.equal(r.text, 'Weekly maintenance overdue by 9 day(s)');
    assert.equal(r.command, 'node scripts/maintenance-checks.mjs');
  });

  test('N09 AGENTS.md at or above 95% (integer-exact), not at 94%', () => {
    assert.deepEqual(fired(withOverride('agents-size', agents(949))), []);
    assert.deepEqual(fired(withOverride('agents-size', agents(950))), ['N09']);
    assert.match(rankNeedsYou(withOverride('agents-size', agents(1100))).rows[0].text, /AGENTS\.md at 110 % of its cap/);
  });

  test('N10 Q3 actionable > 0; the command uses the slug the card used, and only a valid one', () => {
    const ok = rankNeedsYou(withOverride('queue-q3', q('queue-q3', { total: 12 }, null, null, { repo: 'owner/repo' }))).rows[0];
    assert.equal(ok.command, 'node scripts/cross-skill.mjs final-review-pending --repo owner/repo');
    for (const repo of ['bad slug', '../x', 'a/b/c', null, 'owner/repo; x']) {
      const r = rankNeedsYou(withOverride('queue-q3', q('queue-q3', { total: 12 }, null, null, { repo }))).rows[0];
      assert.equal(r.command, null, String(repo));
      assert.equal(r.commandNote, 'command unavailable');
    }
  });

  test('N11 debt (cloud) > 0 and not below previous', () => {
    const mk = (cur, prev) => withOverride('queue-debt', q('queue-debt', { total: cur, cloud: cur, local: 0, spilled: 0 }, prev === null ? null : { total: prev }, '2026-10-05T10:00:00Z'));
    assert.deepEqual(fired(mk(10, 10)), ['N11']);
    assert.deepEqual(fired(mk(9, 10)), []);
  });
});

describe('N01 — unmeasured is an item; one row per CAUSE (card + detail + remedy)', () => {
  // The default detail is unique per id, so these rows are distinct causes and stay separate.
  const degraded = (id, status = 'unexpected-error', detail = `boom-${id}`) => makeMeasurement({ id, label: `L-${id}`, card: id.startsWith('queue') ? 'queues' : 'vitals', status, detail, source: 's' });

  test('measurements sharing (card, detail, command) collapse into ONE row; differing causes keep their own', () => {
    const off = (id) => degraded(id, 'missing-optional', 'store not configured (cloud off)');
    const ids = ['queue-q1', 'queue-q2', 'queue-q3', 'queue-debt', 'queue-upstream'];
    let ms = quietSet();
    for (const id of ids) ms = ms.map((x) => (x.id === id ? off(id) : x));
    ms = ms.map((x) => (x.id === 'agents-size' ? degraded('agents-size') : x));
    const n = rankNeedsYou(ms);
    assert.equal(n.unmeasured, 6, 'unmeasured still counts MEASUREMENTS');
    assert.equal(n.total, 2, 'five queue readings with one cause are one row; the AGENTS.md one is another');
    const g = n.rows.find((r) => r.card === 'queues');
    assert.equal(g.text, 'QUEUES: 5 readings unmeasured — store not configured (cloud off)');
    assert.equal(g.command, 'node scripts/cross-skill.mjs whoami');
    assert.deepEqual(g.measurementIds, ids);
    assert.equal(n.rows.find((r) => r.card === 'vitals').text, 'L-agents-size unmeasured — boom-agents-size');
    assert.equal(n.headline, null);
  });

  test('a differing detail splits the group', () => {
    let ms = quietSet();
    ms = ms.map((x) => (x.id === 'queue-q1' ? degraded('queue-q1', 'missing-optional', 'store not configured') : x.id === 'queue-q2' ? degraded('queue-q2', 'missing-optional', 'timed out after 20s') : x));
    assert.equal(rankNeedsYou(ms).total, 2, 'same card, different causes: two rows');
  });

  test('"+N more" stays the true count when groups overflow the cap', () => {
    const ms = quietSet().map((x) => makeMeasurement({ id: x.id, label: x.id, card: x.card, status: 'unexpected-error', detail: `d-${x.id}`, source: 's' }));
    const n = rankNeedsYou(ms);
    assert.equal(n.total, ms.length, 'unique details: no grouping');
    assert.equal(n.rows.length + n.more, n.total);
  });

  test('one row per unmeasured measurement (distinct causes), each with its own literal command', () => {
    const ids = ['queue-q1', 'queue-q3', 'consumers', 'maintenance', 'agents-size', 'skills', 'plans', 'shipped-log', 'shipped-merges', 'inflight'];
    let ms = quietSet();
    for (const id of ids) ms = ms.map((x) => (x.id === id ? degraded(id) : x));
    const rows = rankNeedsYou(ms).rows.filter((r) => r.ruleId === 'N01');
    // top-8 cap applies, so ask for the whole table via the unmeasured count
    const n = rankNeedsYou(ms);
    assert.equal(n.unmeasured, ids.length);
    assert.equal(n.total, ids.length, 'only N01 fires: every other rule reads "unmeasured" and is covered by N01');
    assert.equal(rows.length, MAX_NEEDS_ROWS);
    assert.equal(n.more, ids.length - MAX_NEEDS_ROWS, 'the overflow is counted, not dropped');
    const byId = Object.fromEntries(rows.map((r) => [r.measurementId, r.command]));
    assert.equal(byId['queue-q1'], 'node scripts/cross-skill.mjs whoami');
    assert.equal(byId.consumers, 'node scripts/sync-status.mjs');
    assert.equal(byId.maintenance, 'node scripts/maintenance-checks.mjs --status');
    assert.equal(byId['agents-size'], 'npm run context:check');
    assert.equal(byId.skills, 'npm run skills:check');
  });

  test('plans is a link to the Plans tab (no command); log and in-flight point at the build stderr', () => {
    const ms = quietSet().map((x) => (['plans', 'shipped-log', 'inflight'].includes(x.id) ? degraded(x.id) : x));
    const rows = rankNeedsYou(ms).rows;
    const plans = rows.find((r) => r.measurementId === 'plans');
    assert.deepEqual([plans.command, plans.tab], [null, 'plans']);
    assert.equal(rows.find((r) => r.measurementId === 'shipped-log').command, 'node scripts/build-dashboard.mjs reference');
    assert.equal(rows.find((r) => r.measurementId === 'inflight').command, 'node scripts/build-dashboard.mjs reference');
  });

  test('N01 text is "<label> unmeasured — <detail>"', () => {
    const r = rankNeedsYou(withOverride('skills', degraded('skills', 'missing-optional', 'no skills found'))).rows[0];
    assert.equal(r.text, 'L-skills unmeasured — no skills found');
  });
});

describe('"Nothing needs you" is only honest when nothing is unmeasured (negative control)', () => {
  test('quiet + one unmeasured measurement: no headline, and the unmeasured source is listed', () => {
    for (const id of ['queue-q2', 'maintenance', 'shipped-merges', 'inflight', 'plans']) {
      const ms = quietSet().map((x) => (x.id === id ? makeMeasurement({ id, label: id, card: x.card, status: 'missing-optional', detail: 'd', source: 's' }) : x));
      const n = rankNeedsYou(ms);
      assert.equal(n.headline, null, `${id} unmeasured must suppress the sentence`);
      assert.equal(n.rows.length >= 1, true);
      assert.ok(n.rows.some((r) => r.measurementId === id));
    }
  });
  test('a fired rule also suppresses it', () => {
    assert.equal(rankNeedsYou(withOverride('queue-upstream', q('queue-upstream', { total: 1, partial: false, oldestAt: null }))).headline, null);
  });
  test('every measurement unmeasured: all are listed, none hidden', () => {
    const ms = quietSet().map((x) => makeMeasurement({ id: x.id, label: x.id, card: x.card, status: 'unexpected-error', detail: `d-${x.id}`, source: 's' }));
    const n = rankNeedsYou(ms);
    assert.equal(n.total, ms.length);
    assert.equal(n.headline, null);
    assert.equal(n.rows.length + n.more, ms.length);
  });
});

describe('ranking', () => {
  test('severity first, then older anchor first, then no anchor, then rule id', () => {
    let ms = quietSet();
    ms = ms.map((x) => {
      if (x.id === 'queue-upstream') return q('queue-upstream', { total: 1, partial: false, oldestAt: '2026-09-01T00:00:00.000Z' });          // N03 sev 3
      if (x.id === 'queue-q2') return q('queue-q2', Q2(2), { total: 2, code: 2 }, '2026-09-10T00:00:00Z');                                      // N04 sev 2, anchored
      if (x.id === 'queue-q1') return q('queue-q1', Q1(2), { total: 2, code: 2 }, '2026-09-20T00:00:00Z');                                      // N05 sev 2, younger anchor
      if (x.id === 'agents-size') return agents(990);                                                                                           // N09 sev 2, no anchor
      if (x.id === 'queue-debt') return q('queue-debt', { total: 4, cloud: 4, local: 0, spilled: 0 }, { total: 4 }, '2026-09-01T00:00:00Z');   // N11 sev 1
      return x;
    });
    assert.deepEqual(rankNeedsYou(ms).rows.map((r) => r.ruleId), ['N03', 'N04', 'N05', 'N09', 'N11']);
  });

  test('deterministic: any input order yields the same rows', () => {
    const ms = [
      ...withOverride('queue-upstream', q('queue-upstream', { total: 1, partial: false, oldestAt: null })),
    ].map((x) => (x.id === 'agents-size' ? agents(990) : x));
    const forward = JSON.stringify(rankNeedsYou(ms));
    assert.equal(JSON.stringify(rankNeedsYou([...ms].reverse())), forward);
  });

  test('top 8 with a TRUE +N more', () => {
    const behind = Array.from({ length: 12 }, (_, i) => ({ name: `c${i}`, state: 'behind', behind: i + 1, syncedAt: null }));
    const n = rankNeedsYou(withOverride('consumers', consumers({ total: 12, inspected: 12, current: 0, behind: 12, rows: behind })));
    assert.equal(n.rows.length, MAX_NEEDS_ROWS);
    assert.equal(n.total, 12);
    assert.equal(n.more, 4);
  });

  test('every rendered command is a literal: no angle-bracket or brace placeholders, npm flags use --', () => {
    const rows = [{ name: 'real-name', state: 'behind', behind: 1, syncedAt: null }];
    let ms = withOverride('consumers', consumers({ total: 1, inspected: 1, current: 0, behind: 1, rows }));
    ms = ms.map((x) => (x.id === 'queue-q3' ? q('queue-q3', { total: 3 }, null, null, { repo: 'owner/repo' }) : x));
    ms = ms.map((x) => (x.id === 'skills' ? m('skills', { count: 1, roster: 17 }) : x));
    ms = ms.map((x) => (x.id === 'queue-upstream' ? q('queue-upstream', { total: 1, partial: false, oldestAt: null }) : x));
    const commands = rankNeedsYou(ms).rows.map((r) => r.command).filter(Boolean);
    assert.ok(commands.length >= 4);
    for (const c of commands) {
      assert.doesNotMatch(c, /[<>{}]/, c);
      if (/^npm run \S+ /.test(c)) assert.match(c, /^npm run \S+ -- /, `npm flags need the -- form: ${c}`);
    }
    assert.ok(commands.includes('npm run sync -- --target real-name'));
  });
});

describe('bound / clip — the bounded projection', () => {
  test('intact strings pass with no title; truncated ones get an ellipsis and a capped full-text title', () => {
    assert.deepEqual(bound('short', LIMITS.title), { text: 'short', title: null });
    const long = 'a'.repeat(1000);
    const b = bound(long, LIMITS.title);
    assert.equal(b.text.length, LIMITS.title);
    assert.ok(b.text.endsWith('…'));
    assert.equal(b.title.length, LIMITS.titleAttr);
  });
  test('the documented limits', () => {
    assert.deepEqual({ ...LIMITS }, { title: 140, path: 120, subject: 140, detail: 200, receiptLabel: 60, titleAttr: 400 });
    assert.equal(bound('x'.repeat(141), LIMITS.title).text.length, 140);
    assert.equal(bound('x'.repeat(140), LIMITS.title).title, null);
  });
  test('control characters collapse to spaces; a surrogate pair is never split', () => {
    assert.equal(bound('a\nb\r\nc\u0000d', 50).text, 'a b c d');
    const emoji = '😀'.repeat(200);
    const b = bound(emoji, 141);
    assert.doesNotMatch(b.text.slice(0, -1), /[\ud800-\udbff]$/);
    assert.ok(b.text.endsWith('…'));
  });
  test('clip bounds what collectors store, on one line', () => {
    assert.equal(clip('x'.repeat(5000)).length, LIMITS.titleAttr);
    assert.equal(clip('line1\nline2'), 'line1 line2');
    assert.equal(clip(null), '');
  });
});

describe('buildHomeModel', () => {
  const cards = (ms) => {
    const out = {};
    for (const x of ms) (out[x.card] ??= { measurements: [] }).measurements.push(x);
    return out;
  };

  test('composes cards, chips and needs from collector output', () => {
    const model = buildHomeModel(cards(quietSet()), { now: new Date(NOW) });
    assert.equal(model.builtAt, NOW);
    assert.deepEqual(Object.keys(model.cards).sort(), ['consumers', 'inflight', 'queues', 'shipped', 'vitals']);
    assert.equal(model.health.length, HEALTH_RULES.length);
    assert.equal(model.needs.headline, NOTHING_NEEDS_YOU);
    assert.equal(model.cards.queues.status, 'ok');
    assert.equal(model.cards.queues.warning, null);
  });

  test('a card warns only when EVERY measurement in it is non-ok', () => {
    const bad = (id, card) => makeMeasurement({ id, label: id, card, status: 'unexpected-error', detail: `broken ${id}`, source: 's' });
    const some = quietSet().map((x) => (x.id === 'queue-q1' ? bad('queue-q1', 'queues') : x));
    const m1 = buildHomeModel(cards(some), { now: new Date(NOW) });
    assert.equal(m1.cards.queues.warning, null, 'one bad queue does not blank the card');
    assert.equal(m1.cards.queues.status, 'unexpected-error', 'but the card status reports the worst');
    const all = quietSet().map((x) => (x.card === 'queues' ? bad(x.id, 'queues') : x));
    const m2 = buildHomeModel(cards(all), { now: new Date(NOW) });
    assert.equal(m2.cards.queues.warning.status, 'unexpected-error');
    assert.match(m2.cards.queues.warning.detail, /broken queue-/);
    assert.equal(m2.cards.vitals.warning, null, 'the other cards are untouched');
  });
});

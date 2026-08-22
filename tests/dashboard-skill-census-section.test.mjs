/**
 * @fileoverview Producer + consumer-path gates for the skill-census
 * dashboard collector + section (docs/plans/skill-efficacy-census.md
 * Phase 3). Two distinct describe blocks, kept distinct deliberately
 * (round-1 M14 fix): an earlier version's "consumer path" block only
 * called `censusAllSkills()` directly, never `collectTelemetry()` — so it
 * verified the PRODUCER's output, not the wiring `collectSkillCensus`
 * adds inside `collectTelemetry`, which is what "consumer path" actually
 * means (mirrors tests/dashboard-collect-reference.test.mjs's pattern:
 * run the real top-level collector, not an internal piece of it).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import sectionSkillCensus from '../scripts/lib/dashboard/sections/skill-census.mjs';
import { buildUi } from '../scripts/lib/dashboard/helpers.mjs';
import { censusAllSkills, ALL_SKILLS } from '../scripts/lib/store/skill-census.mjs';
import { collectTelemetry } from '../scripts/lib/dashboard/collect-telemetry.mjs';

const ui = buildUi();

describe('censusAllSkills (producer)', () => {
  it('produces exactly 16 rows without throwing, cloud on or off', async () => {
    const result = await censusAllSkills({ root: process.cwd() });
    assert.equal(result.rows.length, 16, `expected 16 skill rows, got ${result.rows.length}`);
    assert.deepEqual(
      result.rows.map((r) => r.skill).sort(),
      [...ALL_SKILLS].sort(),
      'every ALL_SKILLS entry must have exactly one row',
    );
    for (const row of result.rows) {
      assert.ok(['caller-checked', 'unchecked-call-site', 'no-table-by-design', 'ship-attribution-only'].includes(row.signalQuality),
        `${row.skill} has an unrecognised signalQuality: ${row.signalQuality}`);
      assert.equal(typeof row.caveat, 'string');
      assert.ok(row.caveat.length > 0, `${row.skill}'s caveat must never be empty — the whole point is honesty about what a row means`);
    }
  });
});

describe('collectTelemetry -> skillCensus (consumer path)', () => {
  it('the real top-level collector wires skillCensus into both `data` and `sources`', async () => {
    const data = await collectTelemetry();
    // A broken import/wiring degrading collectSkillCensus to
    // unexpected-error must surface HERE, not read as a silently absent
    // key — this is exactly the class of bug a producer-only test cannot
    // catch (the producer can be perfectly fine while the wiring is broken).
    assert.ok('skillCensus' in data, 'collectTelemetry must include a skillCensus key');
    assert.ok('skillCensus' in data.sources, 'collectTelemetry must include a sources.skillCensus status');
    assert.ok(Array.isArray(data.skillCensus.rows), 'skillCensus.rows must be an array');
    assert.equal(data.skillCensus.rows.length, 16);
    assert.notEqual(data.sources.skillCensus.status, 'unexpected-error',
      `skillCensus degraded: ${data.sources.skillCensus.detail}`);
  });
});

describe('sectionSkillCensus — rendering contract', () => {
  const sampleRow = (over = {}) => ({
    skill: 'audit-code', signalSource: 'audit_runs (mode=code)', signalQuality: 'caller-checked',
    effectiveSince: null, window: { current: 5, prior: 3 }, allTimeCount: 20,
    trend: { delta: 2, pct: 66.7 }, conversionRate: { current: { numerator: 8, denominator: 10 }, prior: { numerator: 4, denominator: 6 } },
    lastRunAt: null, caveat: 'test caveat', ...over,
  });
  const census = (rows, over = {}) => ({ cloud: true, repoId: 'r1', repoName: 'o/r', windowDays: 14, rows, ...over });

  it('renders a table row per skill, never dropping a zero-count row (state 4)', () => {
    const html = sectionSkillCensus({ src: { status: 'ok' }, skillCensus: census([sampleRow({ window: { current: 0, prior: 0 }, allTimeCount: 0 })]) }, ui);
    assert.match(html, /audit-code/);
    assert.match(html, /<table/);
  });

  it('a skill with no conversion-rate metric renders "n/a", never a blank cell (state 3)', () => {
    const html = sectionSkillCensus({ src: { status: 'ok' }, skillCensus: census([sampleRow({ conversionRate: null })]) }, ui);
    assert.match(html, /n\/a/);
  });

  it('a missing-optional row renders its OWN inline caveat, not a blanket panel (state 2)', () => {
    const html = sectionSkillCensus({
      src: { status: 'missing-optional' },
      skillCensus: census([sampleRow({ window: { current: null, prior: null }, allTimeCount: null, caveat: 'source unavailable this run — missing-optional.' })]),
    }, ui);
    assert.match(html, /source unavailable this run/);
    assert.doesNotMatch(html, /class="warning/i, 'a per-row missing-optional caveat must not trigger the whole-tab warning panel');
  });

  it('an unexpected-error status renders the warning panel (state 1)', () => {
    const html = sectionSkillCensus({ src: { status: 'unexpected-error', detail: 'boom' }, skillCensus: census([]) }, ui);
    assert.match(html, /boom/);
  });

  it('never throws on an empty rows array', () => {
    assert.doesNotThrow(() => sectionSkillCensus({ src: { status: 'ok' }, skillCensus: census([]) }, ui));
  });
});

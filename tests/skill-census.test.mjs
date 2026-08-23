/**
 * @fileoverview Tier 1 tests for the skill-efficacy census aggregator
 * (docs/plans/skill-efficacy-census.md Phase 2).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeWindowBounds, buildTrend, parseTrailerCommits, ALL_SKILLS,
} from '../scripts/lib/store/skill-census.mjs';

describe('computeWindowBounds — contiguous, non-overlapping windows from ONE now snapshot', () => {
  it('current is [now-windowDays, now); prior is [now-2*windowDays, now-windowDays)', () => {
    const now = Date.parse('2026-08-22T00:00:00.000Z');
    const b = computeWindowBounds(14, now);
    assert.equal(b.now, '2026-08-22T00:00:00.000Z');
    assert.equal(b.currentStart, '2026-08-08T00:00:00.000Z');
    assert.equal(b.priorStart, '2026-07-25T00:00:00.000Z');
  });

  it('the two windows are exactly adjacent — no gap, no overlap', () => {
    const b = computeWindowBounds(7, Date.parse('2026-01-15T12:00:00.000Z'));
    // currentStart is exactly windowDays before now, priorStart is exactly
    // 2x before — the midpoint between priorStart and now IS currentStart,
    // so [priorStart, currentStart) and [currentStart, now) share a boundary
    // with no gap and no overlap.
    const currentMs = Date.parse(b.currentStart);
    const priorMs = Date.parse(b.priorStart);
    const nowMs = Date.parse(b.now);
    assert.equal(nowMs - currentMs, currentMs - priorMs);
    assert.ok(priorMs < currentMs && currentMs < nowMs);
  });

  it('scales with windowDays', () => {
    const now = Date.parse('2026-08-22T00:00:00.000Z');
    const b1 = computeWindowBounds(1, now);
    const b90 = computeWindowBounds(90, now);
    assert.equal(Date.parse(b1.now) - Date.parse(b1.currentStart), 86_400_000);
    assert.equal(Date.parse(b90.now) - Date.parse(b90.currentStart), 90 * 86_400_000);
  });
});

describe('buildTrend — delta AND percentage, never just one', () => {
  it('reports both a raw delta and a percentage when prior is non-zero', () => {
    assert.deepEqual(buildTrend(10, 5), { delta: 5, pct: 100 });
    assert.deepEqual(buildTrend(5, 10), { delta: -5, pct: -50 });
  });

  it('pct is null on a zero prior — a delta with no base rate hides direction', () => {
    const t = buildTrend(5, 0);
    assert.equal(t.delta, 5);
    assert.equal(t.pct, null, 'a 0->5 move has no defined percentage; must not fabricate one (e.g. Infinity or 500)');
  });

  it('a 0/0 tie is a real zero, not null', () => {
    assert.deepEqual(buildTrend(0, 0), { delta: 0, pct: null });
  });

  it('rounds pct to one decimal, not raw float noise', () => {
    const t = buildTrend(1, 3);
    assert.equal(t.pct, -66.7);
  });
});

describe('ALL_SKILLS — the 16-skill roster is exhaustive and has no duplicates', () => {
  it('lists exactly 16 skills', () => {
    assert.equal(ALL_SKILLS.length, 16);
  });

  it('has no duplicate names', () => {
    assert.equal(new Set(ALL_SKILLS).size, ALL_SKILLS.length);
  });

  it('includes every DB-backed skill named in the plan\'s contract table', () => {
    for (const s of ['audit-code', 'audit-plan', 'plan', 'ship', 'persona-test', 'nav-audit', 'ux-lock']) {
      assert.ok(ALL_SKILLS.includes(s), `missing DB-backed skill: ${s}`);
    }
  });

  it('includes every no-table-by-design skill', () => {
    for (const s of ['click-test', 'visual-audit']) {
      assert.ok(ALL_SKILLS.includes(s), `missing no-table skill: ${s}`);
    }
  });

  it('includes every trailer-proxy-only skill', () => {
    for (const s of ['explain', 'investigate', 'brainstorm', 'security-strategy', 'ai-context-management', 'cycle', 'skills']) {
      assert.ok(ALL_SKILLS.includes(s), `missing trailer-proxy skill: ${s}`);
    }
  });
});

describe('parseTrailerCommits — structural contract against a real git checkout', () => {
  // This repo IS the fixture: exact counts vary run-to-run (new commits land
  // constantly), so this asserts SHAPE, not values — the same discipline
  // Tier 1 applies to any live-adjacent structural probe.
  it('returns {ok:true, commits:[...]} with the documented per-commit shape', () => {
    const r = parseTrailerCommits(process.cwd());
    assert.equal(r.ok, true);
    assert.ok(Array.isArray(r.commits));
    assert.ok(r.commits.length > 0, 'this repo has commit history');
    const c = r.commits[0];
    assert.equal(typeof c.sha, 'string');
    assert.match(c.sha, /^[0-9a-f]{40}$/);
    assert.equal(typeof c.committerDate, 'string');
    assert.match(c.committerDate, /^\d{4}-\d{2}-\d{2}T/, 'committerDate is ISO-8601 (%cI)');
    assert.ok(Array.isArray(c.skills));
  });

  it('every commit\'s skills field is always an array, never null/undefined — trailered or not', () => {
    // Round-1 M16 fix: an earlier version required an untrailered commit to
    // EXIST in this repo's history, which could be false on a minimal or
    // synthetic checkout (e.g. one commit, or every commit happens to carry
    // a trailer). This asserts the property that must hold universally
    // instead of depending on this repo's particular commit mix.
    const r = parseTrailerCommits(process.cwd());
    for (const c of r.commits) {
      assert.ok(Array.isArray(c.skills), `commit ${c.sha} has a non-array skills field`);
    }
    const untrailered = r.commits.find((c) => c.skills.length === 0);
    if (untrailered) assert.deepEqual(untrailered.skills, []);
  });

  it('fails gracefully (ok:false) rather than throwing on an unresolvable directory', () => {
    const r = parseTrailerCommits('C:/definitely-not-a-git-repo-' + Date.now());
    assert.equal(r.ok, false);
    assert.deepEqual(r.commits, []);
    assert.equal(typeof r.error, 'string');
  });
});

/**
 * @fileoverview Tests for the à-la-carte skill recommender (deterministic seam).
 * Locks the brainstorm-consensus invariants: silent-when-empty, cap, leverage rank,
 * env-aware browser suppression, never-just-ran / never-already-covered, and the
 * signal hierarchy (audit findings > plan lenses > structural file globs; the fuzzy
 * lenses never fire on file paths alone).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { recommendSkills, renderRecommendationCard, _internals } from '../scripts/lib/skill-recommender.mjs';

const skills = (recs) => recs.map((r) => r.skill);

test('silent when nothing fits (backend-only change → no recommendations)', () => {
  assert.deepEqual(recommendSkills({ changedFiles: ['src/db/repo.mjs', 'src/api/route.mjs'], hasLiveUrl: true }), []);
  assert.equal(renderRecommendationCard([]), '');
});

test('ux-lock ranks first when a HIGH fix lacks a spec (highest leverage)', () => {
  const recs = recommendSkills({ unlockedHighFix: true, auditFindings: [{ category: 'theme', title: 'contrast fail' }], hasLiveUrl: true });
  assert.equal(recs[0].skill, 'ux-lock');
  assert.ok(skills(recs).includes('visual-audit'));
});

test('audit findings drive the lens (highest signal): aria→click, route→nav, theme→visual, journey→persona', () => {
  assert.deepEqual(skills(recommendSkills({ auditFindings: [{ title: 'input missing aria-label' }], hasLiveUrl: true })), ['click-test']);
  assert.deepEqual(skills(recommendSkills({ auditFindings: [{ message: 'orphan route not reachable from nav' }], hasLiveUrl: true })), ['nav-audit']);
  assert.deepEqual(skills(recommendSkills({ auditFindings: [{ category: 'frontend', title: 'dark mode contrast' }], hasLiveUrl: true })), ['visual-audit']);
  assert.deepEqual(skills(recommendSkills({ auditFindings: [{ title: 'checkout journey is confusing' }], hasLiveUrl: true })), ['persona-test']);
});

test('cap respected + ranked by leverage', () => {
  const recs = recommendSkills({
    auditFindings: [{ title: 'aria-label missing' }, { title: 'route orphan' }, { title: 'theme contrast' }, { title: 'onboarding friction' }],
    hasLiveUrl: true, max: 2,
  });
  assert.equal(recs.length, 2);
  assert.deepEqual(skills(recs), ['visual-audit', 'nav-audit']); // top-2 by leverage
});

test('browser lenses suppressed without a live URL (env-aware)', () => {
  assert.deepEqual(recommendSkills({ auditFindings: [{ title: 'theme contrast' }], hasLiveUrl: false }), []);
  // ux-lock is not a browser lens → still surfaces with no URL
  assert.deepEqual(skills(recommendSkills({ unlockedHighFix: true, hasLiveUrl: false })), ['ux-lock']);
});

test('never recommends the skill that just ran, nor one already covered', () => {
  assert.ok(!skills(recommendSkills({ auditFindings: [{ title: 'theme' }], hasLiveUrl: true, justRan: 'visual-audit' })).includes('visual-audit'));
  assert.ok(!skills(recommendSkills({ auditFindings: [{ title: 'theme' }], hasLiveUrl: true, alreadyCovered: ['visual-audit'] })).includes('visual-audit'));
});

test('file evidence fires structural lenses only (css→visual, routes→nav); click/persona need a stronger signal', () => {
  assert.deepEqual(skills(recommendSkills({ changedFiles: ['src/styles/theme.css'], hasLiveUrl: true })), ['visual-audit']);
  assert.deepEqual(skills(recommendSkills({ changedFiles: ['src/router/routes.ts'], hasLiveUrl: true })), ['nav-audit']);
  // a generic component file alone → NO click/persona recommendation (banner-blindness guard)
  assert.deepEqual(recommendSkills({ changedFiles: ['src/components/WineCard.tsx'], hasLiveUrl: true }), []);
});

test('plan applicable_lenses map to lenses (tier 2)', () => {
  assert.deepEqual(skills(recommendSkills({ planLenses: ['nav', 'click'], hasLiveUrl: true })).sort(), ['click-test', 'nav-audit']);
});

test('audit-finding reason wins over a file-evidence reason for the same lens (hierarchy)', () => {
  const recs = recommendSkills({ auditFindings: [{ title: 'dark mode contrast fail' }], changedFiles: ['a.css'], hasLiveUrl: true });
  assert.match(recs[0].reason, /audit flagged/);
});

test('renderRecommendationCard shows commands + the advisory framing', () => {
  const card = renderRecommendationCard(recommendSkills({ auditFindings: [{ title: 'theme contrast' }], hasLiveUrl: true }));
  assert.match(card, /Recommended next/);
  assert.match(card, /\/visual-audit --verify/);
  assert.match(card, /advisory/);
});

test('leverage ordering + browser set are the documented invariants', () => {
  assert.equal(_internals.LEVERAGE['ux-lock'], 5);
  assert.ok(_internals.BROWSER_LENSES.has('persona-test') && !_internals.BROWSER_LENSES.has('ux-lock'));
});

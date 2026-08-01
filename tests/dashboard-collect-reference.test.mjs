/**
 * Consumer-path gate for the dashboard reference collector.
 *
 * Why this exists: `collectReference` had ZERO coverage across all 13 dashboard
 * test files, and it wraps its skills load in a try/catch that degrades to
 * `unexpected-error` rather than throwing. A broken import therefore surfaces as
 * a SILENTLY EMPTY skills section, not a crash — a passing build proves nothing.
 * That made "run the dashboard and look" the weakest possible check for exactly
 * the failure mode the L5 extraction could introduce.
 *
 * This executes the real `collect-reference.mjs -> lib/skills-index.mjs` path.
 * Plan: docs/plans/dashboard-skills-index-layering.md §6.
 *
 * SCOPE — assert on `sources.skills` ONLY, never "no source degraded".
 * `collectReference` also collects plans, architecture, cli, nav, visual and
 * purposes, and reads `.audit-loop/domain-deps-observed.json` — a Category A,
 * GITIGNORED artifact. The pre-push hook runs `check` in a clean worktree with no
 * gitignored inputs (scripts/prepush-check.mjs), so a generalised "nothing
 * degraded" assertion would pass locally and fail on every push.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { collectReference } from '../scripts/lib/dashboard/collect-reference.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

describe('collectReference — skills source (consumer path)', () => {
  it('loads skills through lib/skills-index.mjs without degrading', async () => {
    const ref = await collectReference();

    // The try/catch cannot mask a broken import behind an empty list.
    assert.equal(
      ref.sources.skills.status,
      'ok',
      `skills source degraded: ${ref.sources.skills.detail} `
      + '— a broken collect-reference -> skills-index import shows up here, '
      + 'not as a thrown error.',
    );
    assert.ok(ref.skills.length > 0, 'skills list must be non-empty');

    // Sentinel authority: skills.manifest.json, the committed inventory, itself
    // freshness-gated by `npm run skills:check` — so this cannot go stale without
    // an existing gate failing first.
    assert.ok(
      ref.skills.some((s) => s.name === 'ship'),
      `sentinel skill "ship" missing from: ${ref.skills.map((s) => s.name).join(', ')}`,
    );
  });

  it('projects the fields the dashboard renders', async () => {
    // Precondition, not an assumption: `collectReference()` roots itself at
    // process.cwd(), and tests/skills-index.test.mjs chdir's into temp dirs.
    // Node runs test FILES in separate processes, so that cannot leak here today —
    // but if it ever did, the path assertion below would fail with a confusing
    // mismatch instead of naming the cause. Fail loudly and specifically.
    assert.equal(
      path.basename(process.cwd()), path.basename(REPO_ROOT),
      `cwd is ${process.cwd()}, not the repo root — a chdir leaked from another suite; `
      + 'this test roots itself at process.cwd().',
    );

    const ref = await collectReference();
    const ship = ref.skills.find((s) => s.name === 'ship');

    for (const key of ['name', 'oneLiner', 'triggers', 'usage', 'disableModelInvocation', 'path']) {
      assert.ok(key in ship, `projected skill record is missing "${key}"`);
    }
    // The rendered `path` is cwd-relative by contract (see the cwd note in
    // scripts/lib/skills-index.mjs). Re-rooting it would change dashboard output.
    assert.equal(ship.path, 'skills/ship/SKILL.md');
  });
});

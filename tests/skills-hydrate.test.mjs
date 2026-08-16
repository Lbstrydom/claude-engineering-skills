/**
 * @fileoverview `skills:hydrate` — the worktree remedy, and the gate that the
 * remedy actually exists.
 *
 * **The defect these pin (2026-08-14).** Sixteen SKILL.md files carry a
 * worktree-preflight marker telling the reader to run `npm run skills:hydrate`,
 * and `check-worktree-preflight.mjs` enforced that the marker was PRESENT.
 * Nothing enforced that the command it names could RUN — and it could not: no
 * such npm script existed, so following the instruction produced
 * `npm error Missing script`. That is the exact class the marker gate was built
 * to stop (*the instruction ships and the tool does not*), reappearing one
 * level up: in the remedy rather than the subject it remedies.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { planHydration, resolveMainWorktree, SYNCED_TOOLING_DIR } from '../scripts/skills-hydrate.mjs';
import { markerNamedNpmScripts, checkMarkerRemedies, MARKER_BLOCK } from '../scripts/lib/worktree-preflight.mjs';

const MAIN = path.resolve('/repo');
const WORKTREE = path.resolve('/repo/.claude/worktrees/wt');

describe('planHydration — every branch, without touching a filesystem', () => {
  it('the SOURCE repo is a no-op, not a failure', () => {
    // The runbook's consumer one-liner exits 1 when the tooling tree is absent.
    // Here it is absent BY DESIGN (tooling is tracked at scripts/), so the
    // consumer-shaped script would fail on a repo with nothing to hydrate.
    const p = planHydration({
      cwd: WORKTREE, mainWorktree: MAIN,
      packageName: 'claude-engineering-skills', sourceExists: false,
    });
    assert.equal(p.action, 'noop');
    assert.equal(p.code, 'source-repo');
  });

  it('the consumer MAIN checkout is a no-op that says so — it never re-syncs', () => {
    const p = planHydration({
      cwd: MAIN, mainWorktree: MAIN, packageName: 'some-consumer', sourceExists: true,
    });
    assert.equal(p.action, 'noop');
    assert.equal(p.code, 'main-checkout');
  });

  it('a worktree whose main checkout has no tooling FAILS, naming the path', () => {
    // Never a half-populated tree, and never a silent success.
    const p = planHydration({
      cwd: WORKTREE, mainWorktree: MAIN, packageName: 'some-consumer', sourceExists: false,
    });
    assert.equal(p.action, 'fail');
    assert.equal(p.code, 'no-tooling-in-main');
    assert.match(p.message, /re-sync the main checkout first/);
    assert.ok(p.from.includes('.claude-skills'));
  });

  it('a worktree with tooling in main copies it', () => {
    const p = planHydration({
      cwd: WORKTREE, mainWorktree: MAIN, packageName: 'some-consumer', sourceExists: true,
    });
    assert.equal(p.action, 'copy');
    assert.equal(p.from, path.resolve(MAIN, SYNCED_TOOLING_DIR));
    assert.equal(p.to, path.resolve(WORKTREE, SYNCED_TOOLING_DIR));
  });

  it('fails rather than guessing when git cannot answer', () => {
    const p = planHydration({
      cwd: WORKTREE, mainWorktree: null, packageName: 'some-consumer', sourceExists: false,
    });
    assert.equal(p.action, 'fail');
    assert.equal(p.code, 'no-git');
  });
});

describe('resolveMainWorktree', () => {
  it('returns the PARENT of the git common dir', () => {
    const run = () => `${MAIN.replace(/\\/g, '/')}/.git\n`;
    assert.equal(resolveMainWorktree(run), path.resolve(MAIN));
  });

  it('returns null when git throws, rather than propagating', () => {
    assert.equal(resolveMainWorktree(() => { throw new Error('not a repo'); }), null);
  });
});

describe('checkMarkerRemedies — the gate on the gate', () => {
  it('derives the script name from MARKER_BLOCK, not a hard-coded copy', () => {
    // Derived, so an edit to the remedy cannot drift from what is verified.
    assert.deepEqual(markerNamedNpmScripts(), ['skills:hydrate']);
    assert.ok(MARKER_BLOCK.includes('npm run skills:hydrate'));
  });

  it('passes when package.json defines every named script', () => {
    const r = checkMarkerRemedies('/x', { readPackageJson: () => ({ scripts: { 'skills:hydrate': 'node …' } }) });
    assert.deepEqual(r, { ok: true, missing: [], checked: ['skills:hydrate'] });
  });

  it('THE DIRECTION THAT HAD TO FIRE: fails when the named script is absent', () => {
    // This is the state the repo was actually in, undetected, for the marker's
    // whole life. If this assertion cannot go red, the gate is decorative.
    const r = checkMarkerRemedies('/x', { readPackageJson: () => ({ scripts: { other: 'x' } }) });
    assert.equal(r.ok, false);
    assert.deepEqual(r.missing, ['skills:hydrate']);
  });

  it('an unreadable package.json reports MISSING, never a pass', () => {
    // Absence of evidence is not evidence the remedy exists.
    const r = checkMarkerRemedies('/x', { readPackageJson: () => { throw new Error('ENOENT'); } });
    assert.equal(r.ok, false);
    assert.deepEqual(r.missing, ['skills:hydrate']);
  });

  it('THE REAL REPO satisfies its own marker', () => {
    const r = checkMarkerRemedies(path.resolve(import.meta.dirname, '..'));
    assert.equal(r.ok, true, `package.json is missing: ${r.missing.join(', ')}`);
  });
});

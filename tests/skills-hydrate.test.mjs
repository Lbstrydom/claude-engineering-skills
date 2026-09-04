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

import {
  planHydration, resolveMainWorktree, resolveExplicitSource,
  SYNCED_TOOLING_DIR, SOURCE_ENV_VAR, INSTALL_ARGV, DEFAULT_INSTALL_COMMAND,
} from '../scripts/skills-hydrate.mjs';
import { displayDlx } from '../scripts/lib/package-manager.mjs';
import {
  markerNamedNpmScripts, checkMarkerRemedies, checkDocumentedRecipes,
  MARKER_BLOCK, MAIN_CHECKOUT_PATH_RECIPE, CONSUMER_HYDRATE_NPM_SCRIPT,
} from '../scripts/lib/worktree-preflight.mjs';

const MAIN = path.resolve('/repo');
const WORKTREE = path.resolve('/repo/.claude/worktrees/wt');
const OTHER = path.resolve('/elsewhere/checkout');

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

  it('a PLAIN CLONE with no tooling FAILS instead of reporting "nothing to do"', () => {
    // `actions/checkout` produces a checkout whose git common dir is itself, so
    // it resolves as its own main checkout. Before 2026-09-04 that returned the
    // `main-checkout` no-op with exit 0 while copying nothing, and the next
    // `arch:*` step died on a bare MODULE_NOT_FOUND with nothing tying it back
    // here. A consumer could only make CI run by welding the job to a
    // runner-local checkout named by a repository variable.
    const p = planHydration({
      cwd: MAIN, mainWorktree: MAIN, packageName: 'some-consumer', sourceExists: false,
    });
    assert.equal(p.action, 'fail');
    assert.equal(p.code, 'no-tooling-here');
    assert.match(p.message, /npx github:Lbstrydom\/claude-engineering-skills/);
    assert.match(p.message, /--from/);
  });

  it('an explicit --from source overrides the git-derived one', () => {
    const p = planHydration({
      cwd: MAIN, mainWorktree: MAIN, packageName: 'some-consumer',
      sourceExists: true, explicitSource: OTHER,
    });
    assert.equal(p.action, 'copy');
    assert.ok(p.from.startsWith(OTHER), `${p.from} must come from the explicit source`);
  });

  it('an explicit source works where git can answer nothing at all', () => {
    const p = planHydration({
      cwd: MAIN, mainWorktree: null, packageName: 'some-consumer',
      sourceExists: true, explicitSource: OTHER,
    });
    assert.equal(p.action, 'copy');
  });

  it('names --from and the env var when git cannot resolve a source', () => {
    const p = planHydration({
      cwd: MAIN, mainWorktree: null, packageName: 'some-consumer', sourceExists: false,
    });
    assert.equal(p.code, 'no-git');
    assert.match(p.message, /--from/);
    assert.match(p.message, new RegExp(SOURCE_ENV_VAR));
  });

  it('resolveExplicitSource: flag beats env, both resolve to absolute', () => {
    const cwd = MAIN;
    assert.equal(
      resolveExplicitSource(['node', 'x', '--from', 'rel/dir'], { [SOURCE_ENV_VAR]: 'env/dir' }, cwd),
      path.resolve(cwd, 'rel/dir'),
    );
    assert.equal(
      resolveExplicitSource(['node', 'x', '--from=rel/dir'], {}, cwd),
      path.resolve(cwd, 'rel/dir'),
    );
    assert.equal(
      resolveExplicitSource(['node', 'x'], { [SOURCE_ENV_VAR]: 'env/dir' }, cwd),
      path.resolve(cwd, 'env/dir'),
    );
    assert.equal(resolveExplicitSource(['node', 'x'], {}, cwd), null);
  });

  it('a PRESENT but valueless --from is an error, not an absence (audit R5 M2)', () => {
    // Falling back to SKILLS_SOURCE here would hydrate from somewhere other
    // than the operator just named — doing something else silently.
    const env = { [SOURCE_ENV_VAR]: 'env/dir' };
    for (const argv of [
      ['node', 'x', '--from', '--json'],
      ['node', 'x', '--from'],
      ['node', 'x', '--from='],
    ]) {
      assert.throws(() => resolveExplicitSource(argv, env, MAIN), /--from requires a non-empty path/);
    }
  });

  it('stops at the POSIX `--` terminator (audit R5 M6)', () => {
    // After `--`, `--from` is a positional argument by convention, not a flag.
    assert.equal(
      resolveExplicitSource(['node', 'x', '--', '--from', 'rel/dir'], {}, MAIN),
      null,
    );
    // and still reads one BEFORE the terminator
    assert.equal(
      resolveExplicitSource(['node', 'x', '--from', 'rel/dir', '--', 'other'], {}, MAIN),
      path.resolve(MAIN, 'rel/dir'),
    );
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

describe('checkDocumentedRecipes — N copies legal, disagreement not', () => {
  const ROOT = path.resolve(import.meta.dirname, '..');

  it('THE REAL REPO: every documented copy matches its canonical constant', () => {
    const r = checkDocumentedRecipes(ROOT);
    assert.equal(r.ok, true, `drifted: ${JSON.stringify(r.mismatches)}`);
    // Guards against a vacuous pass: if the markers stop matching anything,
    // `checked` collapses to 0 and `ok` would be trivially true.
    assert.ok(r.checked >= 3, `expected >=3 occurrences, checked ${r.checked}`);
  });

  it('accepts the SAME recipe appearing many times — copies are not the defect', () => {
    const many = [
      'blah', MAIN_CHECKOUT_PATH_RECIPE, 'text', `> ${MAIN_CHECKOUT_PATH_RECIPE}`, 'more',
    ].join('\n');
    const r = checkDocumentedRecipes('/x', {
      readFile: (p) => (p.includes('SKILL.md') ? many : CONSUMER_HYDRATE_NPM_SCRIPT),
    });
    assert.equal(r.ok, true);
    assert.equal(r.checked, 3);
  });

  it('THE DIRECTION THAT MUST FIRE: one drifted copy fails, and is located', () => {
    const drifted = MAIN_CHECKOUT_PATH_RECIPE.replace('pending.md', 'DRIFTED.md');
    const r = checkDocumentedRecipes('/x', {
      readFile: (p) => (p.includes('SKILL.md')
        ? `${MAIN_CHECKOUT_PATH_RECIPE}\n${drifted}`
        : CONSUMER_HYDRATE_NPM_SCRIPT),
    });
    assert.equal(r.ok, false);
    assert.equal(r.mismatches.length, 1);
    assert.equal(r.mismatches[0].line, 2, 'must name WHICH copy drifted');
  });

  it('strips only the blockquote marker, which is formatting rather than meaning', () => {
    const r = checkDocumentedRecipes('/x', {
      readFile: (p) => (p.includes('SKILL.md')
        ? `> ${MAIN_CHECKOUT_PATH_RECIPE}`
        : CONSUMER_HYDRATE_NPM_SCRIPT),
    });
    assert.equal(r.ok, true);
  });

  it('an unreadable doc FAILS, never passes on absence of evidence', () => {
    const r = checkDocumentedRecipes('/x', {
      readFile: () => { throw new Error('ENOENT'); },
    });
    assert.equal(r.ok, false);
    assert.equal(r.mismatches.length, 2, 'both subject docs reported');
  });
});

describe('the plain-clone remedy speaks the reader\u2019s package manager', () => {
  it('uses the injected install command verbatim', () => {
    // Audit R1 H3: the remedy was hardcoded to `npx` and aimed at a pnpm
    // consumer, where a corepack-managed image need not have npm on PATH.
    const p = planHydration({
      cwd: MAIN, mainWorktree: MAIN, packageName: 'some-consumer', sourceExists: false,
      installCommand: 'pnpm dlx github:Lbstrydom/claude-engineering-skills .',
    });
    assert.equal(p.code, 'no-tooling-here');
    assert.match(p.message, /pnpm dlx github:Lbstrydom\/claude-engineering-skills \./);
    assert.doesNotMatch(p.message, /npx /);
  });

  it('falls back to the npm dialect when nothing is injected', () => {
    const p = planHydration({
      cwd: MAIN, mainWorktree: MAIN, packageName: 'some-consumer', sourceExists: false,
    });
    assert.ok(p.message.includes(DEFAULT_INSTALL_COMMAND),
      `message must carry the default install command, got: ${p.message}`);
  });

  it('INSTALL_ARGV is what displayDlx is handed — one spelling, not two', () => {
    // A second literal here is how the rendered command and the documented one
    // drift apart.
    assert.equal(DEFAULT_INSTALL_COMMAND, `npx ${INSTALL_ARGV.join(' ')}`);
    assert.equal(displayDlx('pnpm', [...INSTALL_ARGV]), `pnpm dlx ${INSTALL_ARGV.join(' ')}`);
  });
});

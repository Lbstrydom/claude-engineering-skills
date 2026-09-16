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
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

import {
  planHydration, resolveMainWorktree, resolveExplicitSource, pruneStale,
  SYNCED_TOOLING_DIR, SYNCED_MANIFEST_PATH, SOURCE_ENV_VAR, INSTALL_ARGV, DEFAULT_INSTALL_COMMAND,
} from '../scripts/skills-hydrate.mjs';
import { displayDlx } from '../scripts/lib/package-manager.mjs';
import { MANIFEST_RELATIVE_PATH } from '../scripts/lib/sync-manifest.mjs';
import {
  markerNamedNpmScripts, checkMarkerRemedies, checkDocumentedRecipes,
  MARKER_BLOCK, PENDING_NOTE_READ_RECIPE, PENDING_NOTE_WRITE_RECIPE,
  CONSUMER_HYDRATE_NPM_SCRIPT,
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

  it('THE STAMP TRAVELS WITH THE TREE: the manifest is a second copied item', () => {
    // upstream 5bc7ff30 — hydration copied the tooling and left the provenance
    // behind, so every hydrated worktree ran with readBundleStamp() === null:
    // upstream reports filed as "version unknown", doctor probes unable to run.
    const p = planHydration({
      cwd: WORKTREE, mainWorktree: MAIN, packageName: 'some-consumer',
      sourceExists: true, manifestExists: true,
    });
    assert.deepEqual(p.items.map((i) => i.rel), [SYNCED_TOOLING_DIR, SYNCED_MANIFEST_PATH]);
    assert.ok(p.items.every((i) => i.present));
    assert.equal(p.items[1].from, path.resolve(MAIN, SYNCED_MANIFEST_PATH));
    assert.equal(p.items[1].to, path.resolve(WORKTREE, SYNCED_MANIFEST_PATH));
    assert.equal(p.items[1].recursive, false, 'the manifest is a FILE, not a tree');
    assert.match(p.message, /2\/2 items/);
  });

  it('PARTIAL hydration says so on the line an operator reads', () => {
    // The failure this replaces was silent: "copied <path>", exit 0, and the
    // absent stamp visible only as a null inside --json.
    const p = planHydration({
      cwd: WORKTREE, mainWorktree: MAIN, packageName: 'some-consumer',
      sourceExists: true, manifestExists: false,
    });
    assert.equal(p.action, 'copy', 'a missing stamp does not block the tooling copy');
    assert.equal(p.items[1].present, false);
    assert.match(p.message, /1\/2 items/);
    assert.match(p.message, /NO bundle stamp/);
    assert.match(p.message, new RegExp(SYNCED_MANIFEST_PATH.replace('.', '\\.')));
  });

  it('the manifest path agrees with sync-manifest.mjs — N copies legal, drift not', () => {
    // skills-hydrate keeps a local literal on purpose: it must run in a tree
    // that may have no node_modules, and sync-manifest.mjs pulls in zod. The
    // agreement is enforced here instead, where both are importable.
    assert.equal(SYNCED_MANIFEST_PATH, MANIFEST_RELATIVE_PATH);
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

  it('the WRITE recipe is pinned too, not just the read one', () => {
    // Both halves of the handoff are commands now; pinning only one would let
    // the writer drift from the reader again, which is the class this gate owns.
    const r = checkDocumentedRecipes('/x', {
      readFile: (p) => (p.includes('SKILL.md')
        ? `${PENDING_NOTE_READ_RECIPE}\n${PENDING_NOTE_WRITE_RECIPE}`
        : CONSUMER_HYDRATE_NPM_SCRIPT),
    });
    assert.equal(r.ok, true);
    // 2 SKILL.md lines + the hydrate one-liner the mock returns for the runbook.
    assert.equal(r.checked, 3);
  });

  it('THE REAL REPO: every documented copy matches its canonical constant', () => {
    const r = checkDocumentedRecipes(ROOT);
    assert.equal(r.ok, true, `drifted: ${JSON.stringify(r.mismatches)}`);
    // Guards against a vacuous pass: if the markers stop matching anything,
    // `checked` collapses to 0 and `ok` would be trivially true.
    assert.ok(r.checked >= 3, `expected >=3 occurrences, checked ${r.checked}`);
  });

  it('accepts the SAME recipe appearing many times — copies are not the defect', () => {
    const many = [
      'blah', PENDING_NOTE_READ_RECIPE, 'text', `> ${PENDING_NOTE_READ_RECIPE}`, 'more',
    ].join('\n');
    const r = checkDocumentedRecipes('/x', {
      readFile: (p) => (p.includes('SKILL.md') ? many : CONSUMER_HYDRATE_NPM_SCRIPT),
    });
    assert.equal(r.ok, true);
    assert.equal(r.checked, 3);
  });

  it('THE DIRECTION THAT MUST FIRE: one drifted copy fails, and is located', () => {
    const drifted = PENDING_NOTE_READ_RECIPE.replace('pending-note read', 'pending-note read --all');
    assert.notEqual(drifted, PENDING_NOTE_READ_RECIPE, 'the drifted copy must actually differ');
    const r = checkDocumentedRecipes('/x', {
      readFile: (p) => (p.includes('SKILL.md')
        ? `${PENDING_NOTE_READ_RECIPE}\n${drifted}`
        : CONSUMER_HYDRATE_NPM_SCRIPT),
    });
    assert.equal(r.ok, false);
    assert.equal(r.mismatches.length, 1);
    assert.equal(r.mismatches[0].line, 2, 'must name WHICH copy drifted');
  });

  it('strips only the blockquote marker, which is formatting rather than meaning', () => {
    const r = checkDocumentedRecipes('/x', {
      readFile: (p) => (p.includes('SKILL.md')
        ? `> ${PENDING_NOTE_READ_RECIPE}`
        : CONSUMER_HYDRATE_NPM_SCRIPT),
    });
    assert.equal(r.ok, true);
  });

  it('an unreadable doc FAILS, never passes on absence of evidence', () => {
    const r = checkDocumentedRecipes('/x', {
      readFile: () => { throw new Error('ENOENT'); },
    });
    assert.equal(r.ok, false);
    assert.equal(r.mismatches.length, 3, 'every subject doc reported');
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

describe('pruneStale — topicIds 7949a7c28e1c, a1b7f50d0277, d19c7f929169, f19a74763f93', () => {
  const tmpDirs = [];
  function mkTmp() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-hydrate-prune-'));
    tmpDirs.push(dir);
    return dir;
  }
  afterEach(() => {
    while (tmpDirs.length) {
      const dir = tmpDirs.pop();
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best-effort */ }
    }
  });

  it('removes a file present in dest but no longer present in src', () => {
    const root = mkTmp();
    const src = path.join(root, 'src');
    const dest = path.join(root, 'dest');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'a.mjs'), 'current');
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, 'a.mjs'), 'current');
    fs.writeFileSync(path.join(dest, 'deleted-upstream.mjs'), 'stale — no longer in src');

    const removed = pruneStale(src, dest);

    assert.deepEqual(removed, ['deleted-upstream.mjs']);
    assert.equal(fs.existsSync(path.join(dest, 'a.mjs')), true, 'a live file must survive');
    assert.equal(fs.existsSync(path.join(dest, 'deleted-upstream.mjs')), false, 'the stale file must be gone');
  });

  it('removes a whole directory deleted upstream, recursively', () => {
    const root = mkTmp();
    const src = path.join(root, 'src');
    const dest = path.join(root, 'dest');
    fs.mkdirSync(src, { recursive: true });
    fs.mkdirSync(path.join(dest, 'retired-dir', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(dest, 'retired-dir', 'x.mjs'), 'stale');
    fs.writeFileSync(path.join(dest, 'retired-dir', 'nested', 'y.mjs'), 'stale');

    const removed = pruneStale(src, dest);

    assert.equal(fs.existsSync(path.join(dest, 'retired-dir')), false);
    assert.ok(removed.includes('retired-dir'));
  });

  it('leaves a directory that still exists in src untouched even if pruning left it non-empty', () => {
    const root = mkTmp();
    const src = path.join(root, 'src');
    const dest = path.join(root, 'dest');
    fs.mkdirSync(path.join(src, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(src, 'lib', 'keep.mjs'), 'current');
    fs.mkdirSync(path.join(dest, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(dest, 'lib', 'keep.mjs'), 'current');
    fs.writeFileSync(path.join(dest, 'lib', 'gone.mjs'), 'stale');

    const removed = pruneStale(src, dest);

    assert.deepEqual(removed, [path.join('lib', 'gone.mjs')]);
    assert.equal(fs.existsSync(path.join(dest, 'lib')), true, 'the directory itself is still current in src');
    assert.equal(fs.existsSync(path.join(dest, 'lib', 'keep.mjs')), true);
  });

  it('a fully in-sync mirror is left completely alone', () => {
    const root = mkTmp();
    const src = path.join(root, 'src');
    const dest = path.join(root, 'dest');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'a.mjs'), 'current');
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, 'a.mjs'), 'current');

    assert.deepEqual(pruneStale(src, dest), []);
    assert.equal(fs.existsSync(path.join(dest, 'a.mjs')), true);
  });

  it('a dest that does not exist yet is a no-op, not a crash', () => {
    const root = mkTmp();
    assert.deepEqual(pruneStale(path.join(root, 'src'), path.join(root, 'never-created')), []);
  });

  it('hydration converges a mirror across a real prune-then-copy cycle, not just an overlay', () => {
    // The end-to-end contract this fixes: hydrate once, delete a file upstream,
    // hydrate again — the second hydration must remove it from the mirror
    // rather than leaving it there forever (the exact defect named in the
    // linked topicIds).
    const root = mkTmp();
    const src = path.join(root, 'src');
    const dest = path.join(root, 'dest');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'a.mjs'), 'v1');
    fs.writeFileSync(path.join(src, 'b.mjs'), 'v1');

    // First hydration.
    fs.cpSync(src, dest, { recursive: true });
    pruneStale(src, dest);
    assert.deepEqual(fs.readdirSync(dest).sort(), ['a.mjs', 'b.mjs']);

    // b.mjs is removed upstream.
    fs.rmSync(path.join(src, 'b.mjs'), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });

    // Second hydration — the overlay copy alone would leave b.mjs behind.
    fs.cpSync(src, dest, { recursive: true });
    pruneStale(src, dest);
    assert.deepEqual(fs.readdirSync(dest).sort(), ['a.mjs'], 'b.mjs must not survive a re-hydration after upstream deletion');
  });
});

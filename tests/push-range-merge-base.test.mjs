/**
 * @fileoverview End-to-end: a range-scoped gate on a branch BEHIND its base (static-gates' false red on PR #515, 2026-11-24).
 *
 * CI hands `static-gates` BASE = main's tip and HEAD = the PR head. Diffed two-dot, a PR that main has moved past sees main's newer
 * changes REVERSED, as its own added lines: PR #515 went red on an undispositioned `[ship]` line that existed only in main's
 * pre-#514 text, and a rebase with no other change made it green. `resolvePushRange` now anchors an explicit range at
 * merge-base(BASE, HEAD). This drives the real `check-gate-contracts.mjs` CLI over real commits written into this repo's object
 * store (unreferenced, like gate-path-scope.test.mjs's fixtures):
 *
 *   HEAD ── A0 (old main: SKILL.md carries line X) ──┬── M  (main moves on: X reworded away)
 *                                                    ├── P  (PR behind main: an unrelated change only)
 *                                                    └── P2 (PR behind main: really adds an undispositioned line Y)
 *
 * The contracts the CLI judges by are this checkout's, as in CI (which checks out the merge commit): X and Y are dispositioned by
 * none of them.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sanitizeGitEnv } from '../scripts/lib/git-env-sanitize.mjs';
import { parseChangedSkillCandidates } from '../scripts/check-gate-contracts.mjs';
import { resolvePushRange, PUSH_RANGE_ENV } from '../scripts/lib/push-range.mjs';
import { isCandidateLine } from '../scripts/lib/gate-honesty/verb-pattern.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'scripts', 'check-gate-contracts.mjs');
const SKILL = 'skills/brainstorm/SKILL.md';
const X = '- Fixture line X: the zorkmid frobnicator must refuse a stale widget (old main text, never shipped).';
const Y = '- Fixture line Y: the quux reticulator must block every unsplined spline (the PR really adds this).';

const commitEnv = { ...sanitizeGitEnv(ROOT), GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
function git(args, { input, env = commitEnv } = {}) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', input, env });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

const head = git(['rev-parse', 'HEAD']);
const original = git(['show', `${head}:${SKILL}`]);
const indexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-range-merge-base-'));
let n = 0;
/** HEAD's tree with each `path → content` replaced, written through a throwaway index so this checkout's index is never touched. */
function treeWith(files) {
  const env = { ...commitEnv, GIT_INDEX_FILE: path.join(indexDir, `index-${n++}`) };
  git(['read-tree', `${head}^{tree}`], { env });
  for (const [p, content] of Object.entries(files)) {
    const blob = git(['hash-object', '-w', '--stdin'], { input: content });
    git(['update-index', '--add', '--cacheinfo', `100644,${blob},${p}`], { env });
  }
  return git(['write-tree'], { env });
}
const commit = (tree, parent, msg) => git(['commit-tree', tree, '-p', parent, '-m', msg]);

const withX = `${original}\n${X}\n`;
const A0 = commit(treeWith({ [SKILL]: withX }), head, 'old main: SKILL.md carries X');
const M = commit(git(['rev-parse', `${head}^{tree}`]), A0, 'main moves on: X reworded away');
const P = commit(treeWith({ [SKILL]: withX, 'docs/push-range-merge-base-fixture.md': 'unrelated\n' }), A0, 'PR behind main: no SKILL.md change');
const P2 = commit(treeWith({ [SKILL]: `${withX}${Y}\n` }), A0, 'PR behind main: adds Y');

function runGate(base, rangeHead) {
  const env = { ...process.env, [PUSH_RANGE_ENV.REQUIRED]: '1', [PUSH_RANGE_ENV.BASE]: base, [PUSH_RANGE_ENV.HEAD]: rangeHead };
  const r = spawnSync(process.execPath, [CLI], { cwd: ROOT, encoding: 'utf8', env });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('a range-scoped gate on a branch behind its base (merge-base anchoring)', () => {
  it('HARNESS CONTROL: X and Y are enforcement-verb candidates, and the fixture commits exist', () => {
    assert.equal(isCandidateLine(X), true);
    assert.equal(isCandidateLine(Y), true);
    for (const c of [A0, M, P, P2]) assert.match(c, /^[0-9a-f]{40}$/);
    assert.equal(git(['merge-base', M, P]), A0);
  });

  it('NEGATIVE CONTROL: the old two-dot diff main-tip..PR reports X, main\'s removed line, as the PR\'s own added line', () => {
    const twoDot = git(['-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false', 'diff', '--src-prefix=a/', '--dst-prefix=b/', '--unified=0', M, P, '--', 'skills/*/SKILL.md']);
    const lines = parseChangedSkillCandidates(twoDot).map((c) => c.line);
    assert.equal(lines.length, 1, lines.join('\n'));
    assert.ok(lines[0].includes('zorkmid frobnicator'), lines[0]);
    // ...and that is exactly the range an un-anchored resolver would hand the gate.
    const verbatim = resolvePushRange({ env: { [PUSH_RANGE_ENV.BASE]: M, [PUSH_RANGE_ENV.HEAD]: P }, anchor: 'verbatim', run: (a) => { const r = spawnSync('git', a, { cwd: ROOT, encoding: 'utf8', env: sanitizeGitEnv(ROOT) }); return r.status === 0 ? r.stdout.trim() || null : null; } });
    assert.equal(verbatim.base, M);
  });

  it('a branch behind main with no SKILL.md change is GREEN (was the PR #515 false red)', () => {
    const r = runGate(M, P);
    assert.equal(r.status, 0, r.out);
    assert.doesNotMatch(r.out, /undispositioned enforcement-verb line/);
  });

  it('a branch behind main that really adds an undispositioned line is still RED, and only for that line', () => {
    const r = runGate(M, P2);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /\[brainstorm\] undispositioned enforcement-verb line/);
    assert.ok(r.out.includes('quux reticulator'), r.out);
    assert.ok(!r.out.includes('zorkmid frobnicator'), `main's removed line X must not be reported:\n${r.out}`);
  });

  it('a fast-forward range (base is an ancestor of head) is unchanged: the real addition is red', () => {
    const r = runGate(A0, P2);
    assert.equal(r.status, 1, r.out);
    assert.ok(r.out.includes('quux reticulator'), r.out);
  });

  it('a head with no merge-base with the base FAILS under REQUIRED=1, never passes having read nothing', () => {
    const orphan = git(['commit-tree', git(['rev-parse', `${head}^{tree}`]), '-m', 'unrelated root']);
    const r = runGate(M, orphan);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /UNVERIFIABLE and AUDIT_PUSH_RANGE_REQUIRED=1 .*no-merge-base/);
  });
});

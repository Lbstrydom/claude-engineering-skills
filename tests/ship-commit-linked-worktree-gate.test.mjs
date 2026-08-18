/**
 * @fileoverview `--gate passed` must be reachable from a LINKED GIT WORKTREE.
 *
 * THE DEFECT (measured 2026-08-18). `ship-commit` resolved the tree a scoped
 * commit would produce by staging into a private index at
 * `<repoRoot>/.git/ship-commit-index-<pid>-<ts>`. In a main checkout `.git` is a
 * directory and that works. In a LINKED worktree `.git` is a ~77-byte `gitdir:`
 * pointer FILE, so git could not create the index (or its `.lock`), `read-tree`
 * exited 128, `committedTree` stayed null, and `evaluateGateVerification`
 * fail-closed with "cannot resolve the tree being committed". Every worktree
 * session had to ship `--gate waived` no matter how thoroughly it was audited —
 * a gate value that cannot be earned, 14 lines below a comment in the same file
 * saying exactly that about a previous unreachability in the same marker.
 *
 * WHY THE SUITE IS SHAPED THIS WAY. `--gate passed` clears three independent
 * hurdles: E1 content identity (local), then a cloud-configured store, then a
 * converged run row. Only E1 is a function of the WORKTREE — the other two are
 * environment state, and are covered by tests/commit-trailers.test.mjs. So the
 * headline case drives the real E1 resolution from a real linked worktree and
 * feeds it to the real verifier with the store hurdles supplied, proving the
 * ACCEPT is reachable; the CLI cases then prove the wiring, by asserting the
 * tree refusal is gone and that the run reached the (environment-legitimate)
 * store refusal instead. Asserting only "exit != 0 for a different reason"
 * would not distinguish a fix from a reworded error.
 *
 * NEGATIVE DIRECTION IS NON-NEGOTIABLE (repo rule: test the direction a gate
 * must NOT fire). A path fix that turned into "always resolves to something"
 * would read green on every positive case here while destroying the check's
 * only purpose. `mismatched tree` and `partial commit` run end-to-end through
 * the CLI in a worktree and must still refuse — E1 precedes the store lookups,
 * so those cases need no cloud at all.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { initTempRepo, cleanupTempRepo } from './helpers/worktree-guard-args.mjs';
import { gitPathspecTree } from '../scripts/lib/vcs.mjs';
import { evaluateGateVerification } from '../scripts/lib/commit-trailers.mjs';

const CLI = fileURLToPath(new URL('../scripts/ship-commit.mjs', import.meta.url));
const SKILLS_DIR = fileURLToPath(new URL('../skills', import.meta.url));

let main;      // the main checkout
let wt;        // a LINKED worktree of it — the subject under test

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
const write = (root, rel, body) => {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
};
/**
 * Delete one fixture file.
 *
 * Retry-hardened per the repo's Windows EPERM/EBUSY convention (enforced by
 * tests/rmsync-retry-guard.test.mjs) — a virus scanner or indexer holding the
 * handle for a few ms would otherwise fail a case for a reason that has nothing
 * to do with what it is testing.
 */
const rmFile = (root, rel) => fs.rmSync(path.join(root, rel), { recursive: true, maxRetries: 3, retryDelay: 50 });

/**
 * Stamp `.audit/last-audit-run.json` in the worktree.
 *
 * `ts` must be strictly after HEAD's committer time or resolveEvidence reads it
 * as `stale` and never reaches the tree check at all — a stale marker would make
 * every case here pass for the wrong reason.
 */
function stampEvidence(root, auditedTree) {
  const runId = '11111111-2222-4333-8444-555555555555';
  write(root, '.audit/last-audit-run.json', `${JSON.stringify({
    runId,
    ts: new Date(Date.now() + 60_000).toISOString(),
    auditedTree,
    auditedBranch: git(['symbolic-ref', '--quiet', '--short', 'HEAD'], root),
  })}\n`);
  return runId;
}

/** Run the real CLI inside the LINKED worktree. */
function ship(args, cwd = wt) {
  const msg = path.join(cwd, 'msg.txt');
  fs.writeFileSync(msg, 'test: a fixture commit\n');
  // NOTE: deliberately NO `--no-tests`. That flag caps the gate at
  // `waived`/`not-run` ~30 lines BEFORE the E1 tree check runs, so a suite that
  // passed it would never reach the code under test and would be green for a
  // reason unrelated to worktrees. The fixture repo has no hooks, and every case
  // here refuses (exit 2) before `git commit` is ever invoked, so omitting it
  // costs nothing.
  const r = spawnSync(process.execPath, [
    CLI, '--message-file', msg, '--skill', 'ship', '--models', 'claude',
    ...args,
  ], {
    cwd,
    encoding: 'utf-8',
    windowsHide: true,
    // AUDIT_DB_URL is scrubbed so the store hurdle is DETERMINISTIC: inherited,
    // these cases would pass or fail by whose machine ran them. It is the ONLY
    // runtime DSN input (lib/db/client.mjs), so scrubbing it is sufficient —
    // and naming any other DB variable here would make this suite read as
    // DB-gated to db:enrolment:gate when it needs no database at all.
    env: { ...process.env, AUDIT_DB_URL: '' },
  });
  return { status: r.status, stderr: r.stderr || '', stdout: r.stdout || '' };
}

const headOf = (root) => git(['rev-parse', 'HEAD'], root);
const branchOf = (root) => git(['symbolic-ref', '--quiet', '--short', 'HEAD'], root);
const identity = (root) => ['--expect-head', headOf(root), '--expect-branch', branchOf(root)];

before(() => {
  main = initTempRepo('wt-gate-main-');
  write(main, 'seed.txt', 'seed\n');
  write(main, '.gitignore', '.audit/\nmsg.txt\nskills/\n');
  git(['add', '.'], main);
  git(['commit', '-qm', 'seed'], main);

  wt = path.join(path.dirname(main), `${path.basename(main)}-linked`);
  git(['worktree', 'add', '-q', '-b', 'work', wt], main);

  // ship-commit resolves its --skill enum from a skills/ layout under repoRoot,
  // which IS the linked worktree here. Seeded after the worktree exists because
  // git does not track empty directories — seeding the main checkout would not
  // reach the worktree, and ship-commit would exit 1 on "no skill layout found"
  // before ever reaching the gate logic this suite is about.
  fs.mkdirSync(path.join(wt, 'skills'), { recursive: true });
  for (const d of fs.readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    if (d.isDirectory()) fs.mkdirSync(path.join(wt, 'skills', d.name), { recursive: true });
  }
});

after(() => {
  try { execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: main, stdio: 'ignore' }); } catch { /* best effort */ }
  cleanupTempRepo(wt);
  cleanupTempRepo(main);
});

describe('the fixture really is a linked worktree', () => {
  test('.git is a FILE, not a directory — the precondition the bug needed', () => {
    const dotGit = path.join(wt, '.git');
    assert.ok(fs.existsSync(dotGit), '.git must exist in the linked worktree');
    assert.ok(fs.statSync(dotGit).isFile(), '.git must be a gitdir: pointer FILE, else this suite proves nothing');
    assert.match(fs.readFileSync(dotGit, 'utf-8'), /^gitdir:/);
    // The exact derivation the old code used, exercised directly. If this ever
    // becomes creatable, the suite has stopped reproducing the original defect.
    assert.notEqual(
      spawnSync('git', ['read-tree', 'HEAD'], {
        cwd: wt,
        encoding: 'utf-8',
        windowsHide: true,
        env: { ...process.env, GIT_INDEX_FILE: path.join(wt, '.git', 'ship-commit-index-probe') },
      }).status,
      0,
      'the old <repoRoot>/.git/<name> index derivation must still be impossible here',
    );
  });
});

describe('E1 tree resolution from a linked worktree (the root cause)', () => {
  test('gitPathspecTree resolves — the old derivation returned null here', () => {
    write(wt, 'a.txt', 'a\n');
    const res = gitPathspecTree(wt, ['a.txt']);
    assert.equal(res.ok, true, `must resolve inside a linked worktree; got ${JSON.stringify(res.error)}`);
    assert.match(res.tree, /^[0-9a-f]{40}$|^[0-9a-f]{64}$/);
  });

  test('it hashes HEAD-plus-named-paths, not the index and not the whole tree', () => {
    write(wt, 'a.txt', 'a\n');
    write(wt, 'excluded.txt', 'must not be in the tree\n');
    const scoped = gitPathspecTree(wt, ['a.txt']);
    assert.equal(scoped.ok, true);
    // Ground truth: the tree git ACTUALLY produces for `commit --only -- a.txt`.
    const probe = path.join(path.dirname(main), `${path.basename(main)}-probe`);
    git(['worktree', 'add', '-q', '-b', 'probe', probe], main);
    try {
      fs.copyFileSync(path.join(wt, 'a.txt'), path.join(probe, 'a.txt'));
      fs.copyFileSync(path.join(wt, 'excluded.txt'), path.join(probe, 'excluded.txt'));
      // `--only` rejects a pathspec matching no KNOWN file, so an untracked
      // path needs intent-to-add first — which is exactly what ship-commit does
      // for untracked `--path` entries, so the ground truth stays faithful.
      execFileSync('git', ['add', '-N', '--', 'a.txt'], { cwd: probe });
      execFileSync('git', ['commit', '-q', '--only', '-m', 'scoped', '--', 'a.txt'], { cwd: probe });
      assert.equal(
        scoped.tree,
        git(['rev-parse', 'HEAD^{tree}'], probe),
        'the resolved tree must equal the tree a scoped commit really produces',
      );
    } finally {
      try { execFileSync('git', ['worktree', 'remove', '--force', probe], { cwd: main, stdio: 'ignore' }); } catch { /* best effort */ }
      cleanupTempRepo(probe);
    }
  });

  test('it does not touch the real index of the worktree', () => {
    write(wt, 'a.txt', 'a\n');
    const before = git(['status', '--porcelain'], wt);
    gitPathspecTree(wt, ['a.txt']);
    assert.equal(git(['status', '--porcelain'], wt), before, 'the private index must leave the real one pristine');
  });

  test('a path that does not exist FAILS rather than resolving to a lie', () => {
    const res = gitPathspecTree(wt, ['no-such-file.txt']);
    assert.equal(res.ok, false);
    assert.ok(res.error.code, 'a structured error code is the contract');
  });
});

describe('`passed` is REACHABLE from a linked worktree', () => {
  test('the verifier ACCEPTS a worktree-resolved tree that matches the evidence', () => {
    write(wt, 'a.txt', 'accepted\n');
    const res = gitPathspecTree(wt, ['a.txt']);
    assert.equal(res.ok, true);
    // The real verifier, the real tree, the store hurdles supplied. Under the
    // old derivation `committedTree` was null here and this returned the
    // "cannot resolve the tree being committed" refusal — that is the red.
    const verdict = evaluateGateVerification({
      gate: 'passed',
      evidence: { state: 'fresh', runId: 'run-1', auditedTree: res.tree },
      cloudEnabled: true,
      convergence: { roundConvergedAfter: 2 },
      committedTree: res.tree,
    });
    assert.equal(verdict, null, `"passed" must be reachable from a linked worktree; got ${JSON.stringify(verdict)}`);
  });

  test('CLI: the tree refusal is GONE and the run reaches the store hurdle', () => {
    write(wt, 'a.txt', 'cli-passed\n');
    const res = gitPathspecTree(wt, ['a.txt']);
    assert.equal(res.ok, true);
    stampEvidence(wt, res.tree);
    const r = ship(['--path', 'a.txt', '--gate', 'passed', ...identity(wt)]);
    assert.doesNotMatch(
      r.stderr,
      /cannot resolve the tree being committed/,
      'E1 must resolve inside a linked worktree — this is the regression line',
    );
    // Proves it got PAST E1 rather than failing earlier for an unrelated reason.
    assert.match(r.stderr, /AUDIT_DB_URL unset|run not found in the store/);
  });
});

describe('fail-closed direction is preserved (the fix must not become "always passes")', () => {
  test('CLI: a MISMATCHED audited tree still refuses, in a worktree', () => {
    write(wt, 'a.txt', 'mismatch\n');
    stampEvidence(wt, 'f'.repeat(40));   // well-formed tree id, but not ours
    const r = ship(['--path', 'a.txt', '--gate', 'passed', ...identity(wt)]);
    assert.equal(r.status, 2, 'a tree that was never audited must refuse');
    assert.match(r.stderr, /what you are committing is not what run .* audited/);
  });

  test('CLI: a PARTIAL commit of an audited worktree still refuses', () => {
    write(wt, 'a.txt', 'part-a\n');
    write(wt, 'b.txt', 'part-b\n');
    // Evidence bound to BOTH files; the commit names only one, so the trees differ.
    const both = gitPathspecTree(wt, ['a.txt', 'b.txt']);
    assert.equal(both.ok, true);
    stampEvidence(wt, both.tree);
    const r = ship(['--path', 'a.txt', '--gate', 'passed', ...identity(wt)]);
    assert.equal(r.status, 2, 'a subset of an audited worktree is not covered by that audit');
    assert.match(r.stderr, /what you are committing is not what run .* audited/);
  });

  test('the verifier still refuses when the tree cannot be resolved at all', () => {
    const verdict = evaluateGateVerification({
      gate: 'passed',
      evidence: { state: 'fresh', runId: 'run-1', auditedTree: 'a'.repeat(40) },
      cloudEnabled: true,
      convergence: { roundConvergedAfter: 2 },
      committedTree: null,
    });
    assert.ok(verdict, 'an unresolvable tree must still refuse — the fail-closed branch stays live');
    assert.match(verdict.custom, /cannot resolve the tree being committed/);
  });
});

/**
 * The equivalence the whole E1 check rests on, across the shapes a real commit
 * takes.
 *
 * ship-commit compares `gitPathspecTree`'s answer against the audit evidence and
 * THEN commits with `git commit -F <msg> -- <paths>` (pathspec ⇒ `--only`
 * semantics). Those are two different programs computing what is supposed to be
 * the same tree. If they ever disagree, E1 validates one tree while the commit
 * records another — a FALSE PASS, and the precise hole the check exists to close.
 * Note the asymmetry with the rest of this file: everywhere else a defect makes
 * the gate refuse (annoying, honest), but a divergence here makes it ACCEPT
 * something unaudited.
 *
 * A single shape cannot establish this. Deletions are the classic divergence
 * candidate, because "stage this path" and "record this path's absence" are the
 * same operation only if the seeding step got the HEAD baseline right — which is
 * exactly what the original defect broke. So the table sweeps the shapes a
 * scoped commit actually takes, and each case obtains ground truth by REALLY
 * COMMITTING rather than by re-deriving the expected tree (re-deriving would
 * just be a second copy of the code under test).
 */
describe('gitPathspecTree === the tree `git commit -- <paths>` really records', () => {
  /** Files every fixture starts with, committed, so tracked-file shapes exist. */
  const SEED = ['keep.txt', 'mod.txt', 'del.txt', 'dir/nested.txt'];

  /**
   * A throwaway repo + LINKED worktree per case: ground truth is obtained by
   * committing, which would otherwise mutate the shared fixture other tests use.
   */
  function freshFixture(label) {
    const root = initTempRepo(`equiv-${label}-`);
    for (const f of SEED) write(root, f, 'orig\n');
    git(['add', '.'], root);
    git(['commit', '-qm', 'seed'], root);
    const link = path.join(path.dirname(root), `${path.basename(root)}-wt`);
    git(['worktree', 'add', '-q', '-b', `w-${label}`, link], root);
    assert.ok(fs.statSync(path.join(link, '.git')).isFile(), 'the fixture must be a LINKED worktree');
    return { root, link };
  }

  const CASES = [
    {
      label: 'modified',
      desc: 'a modified tracked file',
      paths: ['mod.txt'],
      mutate: (w) => write(w, 'mod.txt', 'changed\n'),
    },
    {
      label: 'deleted',
      desc: 'a DELETED tracked file — the shape most likely to diverge',
      paths: ['del.txt'],
      mutate: (w) => rmFile(w, 'del.txt'),
    },
    {
      label: 'directory',
      desc: 'a directory pathspec, which expands to its members',
      paths: ['dir'],
      mutate: (w) => write(w, 'dir/nested.txt', 'changed\n'),
    },
    {
      label: 'mixed',
      desc: 'a modification and a deletion in one commit',
      paths: ['mod.txt', 'del.txt'],
      mutate: (w) => { write(w, 'mod.txt', 'changed\n'); rmFile(w, 'del.txt'); },
    },
    {
      label: 'bystander',
      desc: 'an unnamed dirty file must NOT leak into the tree',
      paths: ['mod.txt'],
      mutate: (w) => { write(w, 'mod.txt', 'changed\n'); write(w, 'keep.txt', 'must not appear\n'); },
    },
    {
      label: 'untracked',
      desc: 'a new untracked file',
      paths: ['new.txt'],
      mutate: (w) => write(w, 'new.txt', 'new\n'),
      // `git commit -- <path>` rejects a pathspec matching no KNOWN file, so
      // ship-commit marks untracked --path entries intent-to-add before
      // committing. Ground truth must do the same or it measures a different
      // operation. (E1 runs BEFORE that intent-add, which is why the private
      // index does a plain `git add` and still has to agree with the result.)
      intentAdd: true,
    },
  ];

  for (const c of CASES) {
    test(`${c.desc}`, () => {
      const { root, link } = freshFixture(c.label);
      try {
        c.mutate(link);

        const mine = gitPathspecTree(link, c.paths);
        assert.equal(mine.ok, true, `must resolve; got ${JSON.stringify(mine.error)}`);

        if (c.intentAdd) git(['add', '-N', '--', ...c.paths], link);
        git(['commit', '-q', '-m', 'ground truth', '--', ...c.paths], link);
        const truth = git(['rev-parse', 'HEAD^{tree}'], link);

        assert.equal(
          mine.tree,
          truth,
          `divergence would make E1 validate a tree the commit does not carry (${c.label})`,
        );
      } finally {
        try { execFileSync('git', ['worktree', 'remove', '--force', link], { cwd: root, stdio: 'ignore' }); } catch { /* best effort */ }
        cleanupTempRepo(link);
        cleanupTempRepo(root);
      }
    });
  }
});

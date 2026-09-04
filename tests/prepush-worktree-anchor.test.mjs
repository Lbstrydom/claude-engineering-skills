/**
 * @fileoverview Source-repo discovery must be anchored on the MAIN checkout,
 * not on cwd.
 *
 * THE DEFECT (measured 2026-09-04 in a consumer repo). Both discovery paths —
 * the bash sibling scan inside the managed pre-push hook and the JS
 * `resolveSourceRepo` oracle it mirrors — scanned `dirname(cwd)`. A push from
 * a linked worktree runs with cwd = `<repo>/.claude/worktrees/<name>`, so that
 * parent enumerates sibling WORKTREES and can never contain a sibling REPO.
 * The hook printed a warning and `exit 0` — a skip wearing a clean pass's
 * clothes — on every push a Claude Code session makes, which is the majority
 * of them.
 *
 * WHY BOTH HALVES ARE PINNED HERE. The bash body and the JS oracle are
 * independent implementations of one rule (`docs/status/2026-05.md`: "bash
 * sibling-scan aligned with JS resolveSourceRepo"). Nothing type-checks that
 * alignment, so a fix to one is exactly the drift this file exists to catch.
 *
 * Both halves ask git for the main checkout — the JS side through the
 * `gitContext` helper that already existed in `shared-cloud-config.mjs`, the
 * bash side through `git rev-parse --git-common-dir` — so the worktree cases
 * build REAL repositories and are guarded on a git binary. The cases that do
 * not involve a worktree need no repo and never skip; they are the ones that
 * pin "a plain checkout is unaffected".
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { _internals } from '../scripts/install-prepush-hook.mjs';
import { resolveSourceRepo } from '../scripts/lib/shared-cloud-config.mjs';
import { resolveMainRoot } from '../scripts/lib/pinned-worktree/paths.mjs';
import { hasBash } from './lib/hook-test-helpers.mjs';

const { HOOK_BODY } = _internals;

/** A directory that passes the source-repo sentinel. */
function makeSourceRepo(parent, name = 'source-repo') {
  const root = path.join(parent, name);
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'sync-to-repos.mjs'), '// fixture\n');
  return root;
}

/**
 * Nested one level deeper than mkdtemp, matching the hermeticity note in
 * shared-cloud-config.test.mjs: the sibling scan reads the PARENT of cwd, so a
 * fixture rooted directly at the mkdtemp dir would scan a shared tmp directory
 * and could match a concurrent test's fixture.
 */
function withTmp(fn) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-anchor-'));
  const parent = path.join(base, 'workspace');
  fs.mkdirSync(parent);
  // maxRetries/retryDelay per the repo-wide rmSync hardening rule: these
  // fixtures hold a git worktree whose index/lock files Windows may still have
  // open when the test returns, which is exactly the EPERM/EBUSY case.
  try {
    return fn(parent);
  } finally {
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

const HAS_GIT = spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;
const HAS_BASH = hasBash();

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
}

/**
 * A real repository at `<parent>/consumer` with a real linked worktree at
 * `.claude/worktrees/feature-x` — the layout Claude Code creates, and the one
 * `dirname(cwd)` cannot see past. Returns `{main, worktree}`.
 */
function makeRepoWithWorktree(parent) {
  const main = path.join(parent, 'consumer');
  fs.mkdirSync(main);
  git(['init', '-q'], main);
  git(['config', 'user.email', 'test@example.invalid'], main);
  git(['config', 'user.name', 'Test'], main);
  fs.writeFileSync(path.join(main, 'README.md'), '# fixture\n');
  git(['add', 'README.md'], main);
  git(['commit', '-qm', 'fixture'], main);
  const worktree = path.join(main, '.claude', 'worktrees', 'feature-x');
  git(['worktree', 'add', '-q', '-b', 'feature-x', worktree], main);
  // Fixture validity: the directory the broken code scanned must hold no
  // source repo, or a pass here would prove nothing.
  const oldAnchor = path.dirname(worktree);
  assert.equal(
    fs.readdirSync(oldAnchor).some(d => fs.existsSync(path.join(oldAnchor, d, 'scripts', 'sync-to-repos.mjs'))),
    false,
    'fixture invalid: the pre-fix anchor must not contain a source repo',
  );
  return { main, worktree };
}

describe('resolveSourceRepo — worktree anchoring', () => {
  it('finds the sibling source repo from inside a linked worktree', (t) => {
    if (!HAS_GIT) return t.skip('git is required to build a real linked worktree');
    withTmp((parent) => {
      const source = makeSourceRepo(parent);
      const { worktree } = makeRepoWithWorktree(parent);
      const r = resolveSourceRepo({ cwd: worktree });
      assert.equal(r.type, 'resolved');
      assert.equal(r.path, source);
      assert.equal(r.source, 'sibling');
    });
  });

  it('still reports none from a worktree when there is no source repo beside it', (t) => {
    if (!HAS_GIT) return t.skip('git is required to build a real linked worktree');
    withTmp((parent) => {
      const { worktree } = makeRepoWithWorktree(parent);
      assert.equal(resolveSourceRepo({ cwd: worktree }).type, 'none');
    });
  });

  it('preserves the ambiguity contract across both anchors', (t) => {
    if (!HAS_GIT) return t.skip('git is required to build a real linked worktree');
    withTmp((parent) => {
      makeSourceRepo(parent, 'source-a');
      makeSourceRepo(parent, 'source-b');
      const { worktree } = makeRepoWithWorktree(parent);
      const r = resolveSourceRepo({ cwd: worktree });
      // Two anchors must not degrade "ambiguous" into first-anchor-wins.
      assert.equal(r.type, 'ambiguous');
      assert.equal(r.candidates.length, 2);
    });
  });

  it('is unchanged outside a repo (both anchors collapse to one)', () => {
    withTmp((parent) => {
      const source = makeSourceRepo(parent);
      const plain = path.join(parent, 'consumer');
      fs.mkdirSync(plain);
      const r = resolveSourceRepo({ cwd: plain });
      assert.equal(r.type, 'resolved');
      assert.equal(r.path, source);
    });
  });

  it('is unchanged for a plain checkout', (t) => {
    if (!HAS_GIT) return t.skip('git is required to build a real checkout');
    withTmp((parent) => {
      const source = makeSourceRepo(parent);
      const { main } = makeRepoWithWorktree(parent);
      const r = resolveSourceRepo({ cwd: main });
      assert.equal(r.type, 'resolved');
      assert.equal(r.path, source);
    });
  });
});

describe('managed pre-push hook — discovery body', () => {
  it('anchors the scan on --git-common-dir, not on cwd alone', () => {
    assert.match(HOOK_BODY, /git rev-parse --git-common-dir/);
    assert.match(HOOK_BODY, /for parent in "\$MAIN_PARENT" "\.\."/);
  });

  it('no longer scans `../*/` as the only anchor', () => {
    // The exact broken loop header. Present verbatim in v2.
    assert.doesNotMatch(HOOK_BODY, /^\s*for sibling in \.\.\/\*\/; do$/m);
  });

  it('does not use --show-toplevel, which is the worktree root', () => {
    // --show-toplevel from a linked worktree returns the worktree itself, so
    // swapping it in would look like a fix and change nothing.
    const code = HOOK_BODY.split('\n').filter(l => !l.trim().startsWith('#')).join('\n');
    assert.doesNotMatch(code, /--show-toplevel/);
  });

  it('names what it searched when discovery fails', () => {
    assert.match(HOOK_BODY, /not found beside/);
    assert.match(HOOK_BODY, /CLAUDE_AUDIT_LOOP_DIR to override/);
  });
});

describe('managed pre-push hook — discovery body, executed', () => {
  const bashOk = hasBash();
  const gitOk = spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;

  /**
   * Everything from the AUDIT_LOOP_DIR assignment to the end of the scan,
   * plus a verdict line.
   *
   * The verdict is computed IN BASH deliberately. On Windows git-bash reports
   * `%TEMP%` as `/tmp/...`, a path Node's `fs` cannot resolve — converting the
   * result back would test the conversion, not the hook. So bash answers the
   * two questions that matter (does the resolved dir carry the sentinel, and
   * what is its path) in its own path space.
   */
  function discoveryFragment() {
    const lines = HOOK_BODY.split('\n');
    const start = lines.findIndex(l => l.startsWith('AUDIT_LOOP_DIR="$CLAUDE_AUDIT_LOOP_DIR"'));
    assert.ok(start >= 0, 'discovery block not found in HOOK_BODY');
    const end = lines.indexOf('fi', start);
    assert.ok(end > start, 'discovery block has no terminator');
    return [
      lines.slice(start, end + 1).join('\n'),
      'echo "PATH=${AUDIT_LOOP_DIR}"',
      'if [ -n "$AUDIT_LOOP_DIR" ] && [ -f "$AUDIT_LOOP_DIR/scripts/sync-to-repos.mjs" ]; then',
      '  echo "SENTINEL=yes"',
      'else',
      '  echo "SENTINEL=no"',
      'fi',
      '',
    ].join('\n');
  }

  function runFragmentIn(cwd) {
    const script = path.join(cwd, '.discovery-probe.sh');
    fs.writeFileSync(script, discoveryFragment());
    const r = spawnSync('bash', [script], { cwd, encoding: 'utf-8', env: { ...process.env, CLAUDE_AUDIT_LOOP_DIR: '' } });
    assert.equal(r.status, 0, `fragment exited ${r.status}: ${r.stderr}`);
    const out = Object.fromEntries(
      r.stdout.trim().split('\n').map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
    );
    return { resolved: out.PATH ?? '', sentinel: out.SENTINEL === 'yes' };
  }

  it('resolves the sibling source repo from a real linked worktree', (t) => {
    if (!bashOk || !gitOk) return t.skip('bash and git are both required');
    withTmp((parent) => {
      const source = makeSourceRepo(parent);
      const consumer = path.join(parent, 'consumer');
      fs.mkdirSync(consumer);
      const git = (args, cwd) => {
        const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
        assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
      };
      git(['init', '-q'], consumer);
      git(['config', 'user.email', 'test@example.invalid'], consumer);
      git(['config', 'user.name', 'Test'], consumer);
      fs.writeFileSync(path.join(consumer, 'README.md'), '# fixture\n');
      git(['add', 'README.md'], consumer);
      git(['commit', '-qm', 'fixture'], consumer);
      const wt = path.join(consumer, '.claude', 'worktrees', 'feature-x');
      git(['worktree', 'add', '-q', '-b', 'feature-x', wt], consumer);

      // Red control: the directory the v2 body scanned.
      const oldParent = path.dirname(wt);
      assert.equal(
        fs.readdirSync(oldParent).some(d => fs.existsSync(path.join(oldParent, d, 'scripts', 'sync-to-repos.mjs'))),
        false,
        'fixture invalid: the old anchor must not contain a source repo',
      );

      // The tail is pinned rather than the whole path: only the drive-prefix
      // spelling differs between bash and Node, and `workspace/source-repo` is
      // unique to this fixture.
      for (const [label, cwd] of [['worktree', wt], ['main checkout', consumer]]) {
        const got = runFragmentIn(cwd);
        assert.equal(got.sentinel, true, `${label}: resolved "${got.resolved}" carries no sentinel`);
        assert.ok(
          got.resolved.replace(/\\/g, '/').endsWith('/workspace/source-repo'),
          `${label}: resolved "${got.resolved}" is not the fixture source repo`,
        );
      }
      assert.equal(path.basename(source), 'source-repo');
    });
  });

  it('resolves nothing — and does not crash — with no source repo beside it', (t) => {
    if (!bashOk) return t.skip('bash is required');
    withTmp((parent) => {
      const lonely = path.join(parent, 'lonely');
      fs.mkdirSync(lonely);
      // Vacuous-pass guard: the previous case must be able to fail here.
      const got = runFragmentIn(lonely);
      assert.equal(got.resolved, '');
      assert.equal(got.sentinel, false);
    });
  });
});

/**
 * The pre-push sandbox provisions gitignored inputs. Those exist in exactly one
 * place — the MAIN checkout — so the root it copies FROM is a different
 * question from the root it builds the sandbox from, and answering both with
 * `--show-toplevel` is the same defect this file's subject had.
 */
describe('prepush sandbox — local artifacts come from the main checkout', () => {
  const runnerSrc = fs.readFileSync(path.join(process.cwd(), 'scripts', 'prepush-check.mjs'), 'utf-8');

  it('provisions from the artifact root, never from the worktree root', () => {
    assert.match(
      runnerSrc, /provisionArtifacts\(sandbox, localArtifactRoot\)/,
      'PROVISIONED_ARTIFACTS are gitignored; a linked worktree never has them, so passing '
      + 'repoRoot here blocks every worktree push on a file the operator already has',
    );
    assert.doesNotMatch(runnerSrc, /provisionArtifacts\(sandbox, repoRoot\)/);
  });

  it('reuses the shared oracle rather than re-deriving the main checkout', () => {
    assert.match(runnerSrc, /import \{ resolveMainRoot \} from '\.\/lib\/pinned-worktree\/paths\.mjs'/);
  });

  it('names the directory it searched when a required artifact is missing', () => {
    // "must be copied from the main checkout" was already the wording while the
    // code read the worktree — a message that describes the intent cannot help
    // an operator debug the behaviour. Print the path actually used.
    assert.match(runnerSrc, /\$\{localArtifactRoot\}/);
  });

  it('finds a main-checkout-only artifact from inside a linked worktree', (t) => {
    if (!HAS_GIT) return t.skip('git is required to build a real linked worktree');
    withTmp((parent) => {
      const { main, worktree } = makeRepoWithWorktree(parent);
      const rel = path.join('.audit-loop', 'domain-deps-observed.json');
      fs.mkdirSync(path.join(main, '.audit-loop'), { recursive: true });
      fs.writeFileSync(path.join(main, rel), '{}\n');

      // Red control: the value the pre-fix code used cannot see it.
      assert.equal(fs.existsSync(path.join(worktree, rel)), false);

      assert.equal(fs.existsSync(path.join(resolveMainRoot(worktree), rel)), true);
    });
  });
});

/**
 * Population ratchet on "find the main checkout".
 *
 * `resolveMainRoot`'s own docstring warns that a further copy is how the
 * existing ones drift apart, and `transcript-archive.mjs` cites that warning as
 * its reason for reusing it. Nothing enforced it, and `prepush-check.mjs` then
 * shipped the bug this file exists for — not by copying the derivation, but by
 * answering the question with `--show-toplevel` instead.
 *
 * A new entry is not forbidden; it is required to be a decision. Add it here
 * with the reason it cannot reuse `resolveMainRoot`.
 */
describe('main-checkout derivation population', () => {
  const DECLARED = new Map([
    ['scripts/lib/pinned-worktree/paths.mjs',
      'THE canonical oracle — `resolveMainRoot`. Everything else should import this.'],
    ['scripts/lib/shared-cloud-config.mjs',
      'Runs on every process\'s env load and needs BOTH --show-toplevel and --git-common-dir; '
      + 'one combined `git rev-parse` is a documented perf decision, and calling resolveMainRoot '
      + 'would restore the second spawn it removed.'],
    ['scripts/install-prepush-hook.mjs',
      'Emits a POSIX sh hook body into a consumer repo. It is bash, not JS — it cannot import a module.'],
    ['scripts/skills-hydrate.mjs',
      'Bootstraps the tooling tree; it runs where scripts/lib may not be hydrated yet, so it '
      + 'cannot depend on a lib module to find the checkout it is about to populate.'],
    ['scripts/lib/worktree-preflight.mjs',
      'Not a derivation — canonical RECIPE strings, compared against the one-liners in synced '
      + 'SKILL.md prose so documented commands cannot drift from the code.'],
  ]);

  /** Strip comments: a docstring MENTIONING the flag is documentation, not a derivation. */
  function stripComments(src) {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/^\s*[#*].*$/gm, '');
  }

  function derivationSites() {
    const found = [];
    (function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue; }
        if (!e.name.endsWith('.mjs')) continue;
        if (stripComments(fs.readFileSync(p, 'utf-8')).includes('--git-common-dir')) {
          found.push(path.relative(process.cwd(), p).split(path.sep).join('/'));
        }
      }
    })(path.join(process.cwd(), 'scripts'));
    return found.sort();
  }

  it('is exactly the declared set — a new one needs a reason here', () => {
    const found = derivationSites();
    // Not vacuous: the canonical oracle must always be among them.
    assert.ok(found.includes('scripts/lib/pinned-worktree/paths.mjs'), `scan found nothing plausible: ${found.join(', ')}`);
    assert.deepEqual(
      found, [...DECLARED.keys()].sort(),
      'undeclared "find the main checkout" derivation(s). Import `resolveMainRoot` from '
      + 'scripts/lib/pinned-worktree/paths.mjs, or declare the site above with the reason it cannot.',
    );
  });

  it('every declared site carries a non-empty reason', () => {
    for (const [file, reason] of DECLARED) {
      assert.ok(reason && reason.length > 40, `${file}: reason is too thin to be a decision`);
    }
  });
});

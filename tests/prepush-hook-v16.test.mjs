/**
 * @fileoverview Hook v16 (Tier 3: consumer hook contract - ships to repos nobody here can observe).
 * docs/plans/hook-fidelity-and-v15-field-gaps.md §2.1-2.2, §2.5
 *   - a tag-only push of commits the DESTINATION already holds runs no plan selection and no audit; the negative controls are the point:
 *     a tag publishing an unseen commit, a stale local remote-tracking ref, a mixed tag+branch push and a failed ls-remote all still audit
 *   - the archive lane in a consumer: clean skips, a planted secret refuses, a crashed lane refuses an archive-looking push
 *   - the sanctioned sync lane: a real sync-shaped commit passes with no plan and no override; a hand edit smuggled into it does not
 *   - the version warning
 * Every case drives the REAL hook body against a stub source repo and a real bare origin.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { _internals } from '../scripts/install-prepush-hook.mjs';
import { hasBash, git } from './lib/hook-test-helpers.mjs';
import { writeStepRunnerStub } from './lib/prepush-step-stub.mjs';
import { buildOwnedSidecar } from '../scripts/lib/sync-owned-sidecar.mjs';
import { buildReceiptEntry } from '../scripts/lib/sync-receipt.mjs';
import { _internals as gitignoreInternals } from '../scripts/lib/sync-gitignore.mjs';

const BLOCK = `${gitignoreInternals.BEGIN}
scripts/.claude-skills/
${gitignoreInternals.END}
`;

const { HOOK_BODY, HOOK_VERSION_MARKER } = _internals;
const HAS_BASH = hasBash();
const ZERO = '0'.repeat(40);
const BUNDLE = 'b'.repeat(40);
const tmpDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const rmrf = (p) => fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
const GHP = `ghp_${'a1B2'.repeat(9)}`;

/** A stub source repo: the REAL step runner and archive lane, a stub plan selector and a stub audit that leaves a marker. */
function sourceRepo(ws, { lane = 'real' } = {}) {
  const scripts = path.join(ws, 'source-repo', 'scripts');
  fs.mkdirSync(scripts, { recursive: true });
  fs.writeFileSync(path.join(scripts, 'sync-to-repos.mjs'), '// fixture\n');
  writeStepRunnerStub(scripts);
  const realLane = new URL('../scripts/prepush-archive-lane.mjs', import.meta.url).href;
  fs.writeFileSync(path.join(scripts, 'prepush-archive-lane.mjs'), lane === 'crash'
    ? 'process.stderr.write("archive lane crashed (Stub)\\n"); process.exit(3);\n'
    : [
      "import { spawnSync } from 'node:child_process';", "import { fileURLToPath } from 'node:url';",
      `const r = spawnSync(process.execPath, [fileURLToPath(${JSON.stringify(realLane)}), ...process.argv.slice(2)], { stdio: 'inherit' });`,
      'process.exit(r.status ?? 1);', ''].join('\n'));
  fs.writeFileSync(path.join(scripts, 'check-plan-status.mjs'), [
    "import fs from 'node:fs';",
    "const a = process.argv.slice(2);",
    "if (a.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }",
    "fs.writeFileSync('SELECT_RAN', '1');",
    "if (a.includes('--select')) { if (fs.existsSync('docs/plans/active.md')) process.stdout.write('docs/plans/active.md\\n'); process.exit(0); }",
    'process.exit(0);', '',
  ].join('\n'));
  fs.writeFileSync(path.join(scripts, 'openai-audit.mjs'), [
    "import fs from 'node:fs';", "fs.writeFileSync('AUDIT_RAN', '1');",
    "const i = process.argv.indexOf('--out');",
    "if (i >= 0) fs.writeFileSync(process.argv[i + 1], JSON.stringify({ verdict: 'PASS', findings: [] }));",
    'process.exit(0);', '',
  ].join('\n'));
  return path.join(ws, 'source-repo');
}

/** origin (bare) + a clone with `seed` pushed to main. `plan`: an active plan, so a code push CAN be audited. */
function consumer(ws, { plan = false } = {}) {
  const bare = path.join(ws, 'origin.git');
  const local = path.join(ws, 'local');
  git(['init', '--bare', '-q', '-b', 'main', bare]);
  git(['clone', '-q', bare, local]);
  git(['config', 'user.email', 'a@example.invalid'], local);
  git(['config', 'user.name', 'A'], local);
  fs.mkdirSync(path.join(local, 'docs', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(local, 'docs', 'plans', plan ? 'active.md' : 'done.md'), `# Plan\n\n- **Status**: ${plan ? 'In Progress' : 'Complete'}\n`);
  fs.writeFileSync(path.join(local, '.gitignore'), 'node_modules/\n');
  fs.writeFileSync(path.join(local, 'scripts-owned-placeholder.txt'), 'x\n');
  git(['add', '.'], local);
  git(['commit', '-q', '-m', 'seed'], local);
  git(['push', '-q', 'origin', 'main'], local);
  const write = (files) => { for (const [f, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(local, f)), { recursive: true }); fs.writeFileSync(path.join(local, f), body); } };
  const commit = (files, msg) => { write(files); git(['add', '.'], local); git(['commit', '-q', '-m', msg], local); return git(['rev-parse', 'HEAD'], local); };
  return { bare, local, base: git(['rev-parse', 'HEAD'], local), commit };
}

/** The ONE subprocess environment for a hook run: every documented hook input is set explicitly, then per-test overrides. */
function hookEnv(source, extra = {}) {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AZURE_'))),
    CLAUDE_AUDIT_LOOP_DIR: source, AUDIT_PREPUSH_BLOCK: '', AUDIT_PREPUSH_DISABLE: '', AUDIT_PREPUSH_ALLOW_UNMEASURED: '', AUDIT_PREPUSH_ARCHIVE_LANE: '',
    AUDIT_PREPUSH_PLAN: '', PLAN_STATUS_DISABLE: '', PREPUSH_LOCAL_DISABLE: '', ...extra,
  };
}

function runHook(c, source, stdin, env = {}) {
  const script = path.join(c.local, '.hook.sh');
  fs.writeFileSync(script, HOOK_BODY);
  return spawnSync('bash', [script, 'origin', c.bare], {
    cwd: c.local, encoding: 'utf-8', input: stdin, timeout: 180_000,
    env: hookEnv(source, env),
  });
}

function scenario(t, name, opts, fn) {
  if (!HAS_BASH) return t.skip('bash is required');
  const ws = tmpDir(`hook-v16-${name}-`);
  try { return fn({ c: consumer(ws, opts), source: sourceRepo(ws, opts), ws }); } finally { rmrf(ws); }
}
const audited = (c) => fs.existsSync(path.join(c.local, 'AUDIT_RAN'));
const selected = (c) => fs.existsSync(path.join(c.local, 'SELECT_RAN'));
const tagLine = (name, sha, remoteSha = ZERO) => `refs/tags/${name} ${sha} refs/tags/${name} ${remoteSha}\n`;

describe('hook v16 - version', () => {
  it('the installed body carries the v16 marker, and the version constant is the one place it lives', () => {
    assert.equal(HOOK_VERSION_MARKER, '# hook-version: 16');
  });
  it('a stale install is named on every push, non-blocking, when the source expects a newer hook', (t) => {
    scenario(t, 'stale', { plan: true }, ({ c, source }) => {
      fs.writeFileSync(path.join(source, 'scripts', 'hook-version-override.txt'), '');
      // Pretend this body is older than the source expects: the source says 17.
      const stub = path.join(source, 'scripts', 'prepush-step.mjs');
      const real = fs.readFileSync(stub, 'utf8');
      fs.writeFileSync(stub, real.replace("const r = spawnSync(", "if (process.argv[2] === 'hook-version') { console.log('17'); process.exit(0); }\nconst r = spawnSync("));
      const head = c.commit({ 'src/a.mjs': 'export const a = 1;\n' }, 'work');
      const r = runHook(c, source, `refs/heads/main ${head} refs/heads/main ${c.base}\n`);
      assert.match(r.stderr, /this installed hook is v16 but .* expects v17/);
      assert.equal(r.status, 0, r.stderr);
    });
  });
  it('silent when the versions agree', (t) => {
    scenario(t, 'current', { plan: true }, ({ c, source }) => {
      const head = c.commit({ 'src/a.mjs': 'export const a = 1;\n' }, 'work');
      const r = runHook(c, source, `refs/heads/main ${head} refs/heads/main ${c.base}\n`);
      assert.doesNotMatch(r.stderr, /this installed hook is v/);
    });
  });
});

describe('hook v16 - tag-only push (fleet 2d68)', () => {
  it('a tag on a commit the destination already holds: no plan selection, no audit', (t) => {
    scenario(t, 'tag-pub', { plan: true }, ({ c, source }) => {
      git(['tag', 'v1', c.base], c.local);
      const r = runHook(c, source, tagLine('v1', c.base));
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stderr, /tag-only push: 1 tag update\(s\) whose commits .* already holds/);
      assert.equal(audited(c), false);
      assert.equal(selected(c), false, 'plan selection must not even run');
    });
  });
  it('NEGATIVE: a tag on a commit the destination does NOT hold still goes to the audit', (t) => {
    scenario(t, 'tag-unpub', { plan: true }, ({ c, source }) => {
      const unseen = c.commit({ 'src/a.mjs': 'export const a = 1;\n' }, 'unpushed');
      git(['tag', 'v2', unseen], c.local);
      const r = runHook(c, source, tagLine('v2', unseen));
      assert.match(r.stderr, /not a tag-only push of published commits: .*publishes 1 commit/);
      assert.equal(audited(c), true, 'the audit ran');
    });
  });
  it('NEGATIVE: a STALE local remote-tracking ref does not count as publication', (t) => {
    scenario(t, 'tag-stale', { plan: true }, ({ c, source }) => {
      const unseen = c.commit({ 'src/a.mjs': 'export const a = 1;\n' }, 'unpushed');
      git(['update-ref', 'refs/remotes/origin/main', unseen], c.local); // a lie: the destination never got it
      git(['tag', 'v3', unseen], c.local);
      const r = runHook(c, source, tagLine('v3', unseen));
      assert.match(r.stderr, /not a tag-only push of published commits/);
      assert.equal(audited(c), true);
    });
  });
  it('NEGATIVE: a mixed tag + branch push is not tag-only', (t) => {
    scenario(t, 'tag-mixed', { plan: true }, ({ c, source }) => {
      git(['tag', 'v4', c.base], c.local);
      const head = c.commit({ 'src/a.mjs': 'export const a = 1;\n' }, 'work');
      const r = runHook(c, source, `${tagLine('v4', c.base)}refs/heads/main ${head} refs/heads/main ${c.base}\n`);
      assert.match(r.stderr, /not a tag-only push of published commits: refs\/heads\/main is not a tag/);
      assert.equal(audited(c), true);
    });
  });
  it('NEGATIVE: when the destination cannot be asked (ls-remote fails) the audit runs, never a skip', (t) => {
    scenario(t, 'tag-nols', { plan: true }, ({ c, source, ws }) => {
      git(['tag', 'v5', c.base], c.local);
      const script = path.join(c.local, '.hook.sh');
      fs.writeFileSync(script, HOOK_BODY);
      const r = spawnSync('bash', [script, 'origin', path.join(ws, 'no-such-remote.git')], {
        cwd: c.local, encoding: 'utf-8', input: tagLine('v5', c.base), timeout: 180_000,
        env: hookEnv(source),
      });
      assert.match(r.stderr, /landing|not a tag-only push|could not be asked|ls-remote/i);
      assert.equal(audited(c), true);
    });
  });
});

describe('hook v16 - archive lane in a consumer', () => {
  it('an archive tag whose commits are clean takes the lane: scanned, audit skipped', (t) => {
    scenario(t, 'lane-clean', { plan: true }, ({ c, source }) => {
      const head = c.commit({ 'notes.txt': 'harmless\n' }, 'wip');
      git(['tag', 'archive/wip', head], c.local);
      const r = runHook(c, source, tagLine('archive/wip', head).replace('refs/tags/archive/wip', 'refs/tags/archive/wip'));
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stderr, /archive lane clean/);
      assert.equal(audited(c), false);
    });
  });
  it('NEGATIVE: an archive tag publishing a secret is REFUSED and nothing is audited', (t) => {
    scenario(t, 'lane-secret', { plan: true }, ({ c, source }) => {
      const head = c.commit({ 'notes.txt': `token = ${GHP}\n` }, 'wip with a secret');
      git(['tag', 'archive/leak', head], c.local);
      const r = runHook(c, source, tagLine('archive/leak', head));
      assert.equal(r.status, 1, r.stderr);
      assert.match(r.stderr, /archive lane blocked this push/);
      assert.equal(audited(c), false);
    });
  });
  it('NEGATIVE: a lane that CRASHES on an archive-only push is refused (exit 3, no token is never "not applicable")', (t) => {
    scenario(t, 'lane-crash', { plan: true, lane: 'crash' }, ({ c, source }) => {
      const head = c.commit({ 'notes.txt': 'x\n' }, 'wip');
      git(['tag', 'archive/crash', head], c.local);
      const r = runHook(c, source, tagLine('archive/crash', head));
      assert.equal(r.status, 1, r.stderr);
      assert.match(r.stderr, /archive lane produced no valid result/);
    });
  });
  it('a crashed lane on a push that is NOT archive-only warns and the normal gate continues', (t) => {
    scenario(t, 'lane-crash-code', { plan: true, lane: 'crash' }, ({ c, source }) => {
      const head = c.commit({ 'src/a.mjs': 'export const a = 1;\n' }, 'work');
      const r = runHook(c, source, `refs/heads/main ${head} refs/heads/main ${c.base}\n`);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stderr, /this push is not archive-only, so the normal gate continues/);
      assert.equal(audited(c), true, 'a real code push is still audited');
    });
  });
});

describe('hook v16 - sanctioned sync lane (fleet 0927)', () => {
  const OWNED = ['.claude/skills/demo/SKILL.md'];
  const syncFiles = (extra = {}) => ({
    '.claude/skills/demo/SKILL.md': '# demo skill\n',
    'scripts/.sync-owned.json': `${JSON.stringify(buildOwnedSidecar(OWNED), null, 2)}\n`,
    '.sync-receipt.json': `${JSON.stringify({ version: 2, recentSyncs: [buildReceiptEntry({ syncedAt: '2026-10-25T10:00:00.000Z', source: { repo: 'Lbstrydom/claude-engineering-skills', branch: 'main', commitSha: BUNDLE, sourceDirty: false } })] }, null, 2)}\n`,
    '.gitignore': `node_modules/\n${BLOCK}`,
    ...extra,
  });
  const MSG = (sha = BUNDLE) => `chore(sync): bundle sync from x ${sha.slice(0, 8)}\n\nbody\n\nSync-Bundle: ${sha}`;
  const syncCommit = (c, files, msg = MSG()) => {
    git(['checkout', '-q', '-b', 'chore/sync-bbbbbbbb'], c.local);
    return c.commit(files, msg);
  };
  const newBranchLine = (head) => `refs/heads/chore/sync-bbbbbbbb ${head} refs/heads/chore/sync-bbbbbbbb ${ZERO}\n`;

  it('a sync:pr commit on a no-plan repo, new branch: passes with no override and no audit', (t) => {
    scenario(t, 'sync-ok', { plan: false }, ({ c, source }) => {
      const head = syncCommit(c, syncFiles());
      const r = runHook(c, source, newBranchLine(head));
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stderr, /SANCTIONED SYNC LANE: a sync:pr commit for bundle b{40} 4 file\(s\)/);
      assert.equal(audited(c), false);
    });
  });
  it('NEGATIVE: the same repo and push shape WITHOUT the trailer is a code push with no plan: refused UNMEASURED', (t) => {
    scenario(t, 'sync-notrailer', { plan: false }, ({ c, source }) => {
      const head = syncCommit(c, syncFiles(), 'chore: looks like a sync but is not');
      const r = runHook(c, source, newBranchLine(head));
      assert.equal(r.status, 1, r.stderr);
      assert.match(r.stderr, /UNMEASURED/);
    });
  });
  it('NEGATIVE: a hand-edited code file smuggled into a sync-shaped commit is NOT sanctioned', (t) => {
    scenario(t, 'sync-smuggle', { plan: false }, ({ c, source }) => {
      const head = syncCommit(c, syncFiles({ 'src/evil.mjs': 'export const x = 1;\n' }));
      const r = runHook(c, source, newBranchLine(head));
      assert.equal(r.status, 1, r.stderr);
      assert.match(r.stderr, /src\/evil\.mjs is not owned by the sync/);
      assert.match(r.stderr, /UNMEASURED/);
    });
  });
  it('NEGATIVE: a .gitignore edit OUTSIDE the managed block is not sanctioned', (t) => {
    scenario(t, 'sync-gitignore', { plan: false }, ({ c, source }) => {
      const head = syncCommit(c, syncFiles({ '.gitignore': `node_modules/\nsecrets/\n${BLOCK}` }));
      const r = runHook(c, source, newBranchLine(head));
      assert.equal(r.status, 1, r.stderr);
      assert.match(r.stderr, /\.gitignore changes outside the managed block/);
    });
  });
  it('NEGATIVE: a receipt that attests a different bundle than the trailer is not sanctioned', (t) => {
    scenario(t, 'sync-receipt', { plan: false }, ({ c, source }) => {
      const head = syncCommit(c, syncFiles(), MSG('c'.repeat(40)));
      const r = runHook(c, source, newBranchLine(head));
      assert.equal(r.status, 1, r.stderr);
      assert.match(r.stderr, /receipt in the pushed tree does not attest/);
    });
  });
  it('NEGATIVE: a sync commit pushed together with a second ref is not sanctioned (the lane takes exactly one update)', (t) => {
    scenario(t, 'sync-two-refs', { plan: false }, ({ c, source }) => {
      const head = syncCommit(c, syncFiles());
      const r = runHook(c, source, `${newBranchLine(head)}refs/tags/vx ${head} refs/tags/vx ${ZERO}\n`);
      assert.equal(r.status, 1, r.stderr);
    });
  });
  it('END TO END: a real `git push` through the INSTALLED hook - new branch, then an update - passes with no override', (t) => {
    scenario(t, 'sync-realpush', { plan: false }, ({ c, source }) => {
      fs.mkdirSync(path.join(c.local, '.git', 'hooks'), { recursive: true });
      fs.writeFileSync(path.join(c.local, '.git', 'hooks', 'pre-push'), HOOK_BODY, { mode: 0o755 });
      syncCommit(c, syncFiles());
      const push = (...a) => spawnSync('git', ['push', ...a], { cwd: c.local, encoding: 'utf8', env: hookEnv(source) });
      const first = push('-u', 'origin', 'chore/sync-bbbbbbbb');
      assert.equal(first.status, 0, first.stderr);
      assert.match(first.stderr, /SANCTIONED SYNC LANE/);
      assert.equal(git(['rev-parse', 'refs/heads/chore/sync-bbbbbbbb'], c.bare), git(['rev-parse', 'HEAD'], c.local), 'the branch really landed');
      // The update: a second sync-shaped commit for a newer bundle on the same branch.
      const NEW = 'd'.repeat(40);
      c.commit(syncFiles({ '.sync-receipt.json': `${JSON.stringify({ version: 2, recentSyncs: [buildReceiptEntry({ syncedAt: '2026-10-26T10:00:00.000Z', source: { repo: 'Lbstrydom/claude-engineering-skills', branch: 'main', commitSha: NEW, sourceDirty: false } })] }, null, 2)}
` }), MSG(NEW));
      const second = push('origin', 'chore/sync-bbbbbbbb');
      assert.equal(second.status, 0, second.stderr);
      assert.match(second.stderr, /SANCTIONED SYNC LANE/);
      assert.equal(audited(c), false);
    });
  });
  it('the UPDATE case (remote branch already at the base) passes as well', (t) => {
    scenario(t, 'sync-update', { plan: false }, ({ c, source }) => {
      const head = syncCommit(c, syncFiles());
      const r = runHook(c, source, `refs/heads/chore/sync-bbbbbbbb ${head} refs/heads/chore/sync-bbbbbbbb ${c.base}\n`);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stderr, /SANCTIONED SYNC LANE/);
    });
  });
});

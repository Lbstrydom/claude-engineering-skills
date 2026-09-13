/**
 * @fileoverview A push whose ONLY changed files are the sync bookkeeping pair
 * (`.sync-receipt.json`, `scripts/.sync-owned.json` — both written by this
 * repo's own `npm run sync`, never hand-edited) still ran the full code audit
 * against whatever plan the Status-aware selector fell back to picking.
 * `selectAuditPlan`'s documented fallback ("a single active plan is still
 * unambiguous — no guess required") fires even when nothing in the push
 * touches that plan, and `openai-audit.mjs`'s A1 integrity guard then
 * correctly REFUSES to certify a verdict over code it never read (0 of the
 * plan's files land in `--scope diff`) — but that refusal is an uncaught
 * `throw`: it prints a Node stack trace that reads as a crash, and it still
 * spends a preflight cost estimate first. Measured live in ai-organiser
 * (2026-09-08), on a push made entirely of bookkeeping this hook's own v6
 * fix (see prepush-push-range-stdin.test.mjs) had just regenerated.
 *
 * v7 adds a short-circuit: with a KNOWN push range (v6's PUSH_BASE/PUSH_HEAD),
 * skip the audit invocation entirely when every changed file is one of the
 * two bookkeeping files. The plan-status gate, maintenance sweep and
 * surfaces-manifest check are UNCHANGED — cheap, still worth running.
 *
 * WHY BEHAVIOURAL CASES RUN THE REAL HOOK_BODY. A regex only pins the
 * spelling; the fixtures below run the actual emitted shell against a real
 * git repo with a stub source dir whose `openai-audit.mjs` writes a marker
 * file when invoked, so "did the audit run" is a filesystem fact, not an
 * inference from stdout.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { _internals } from '../scripts/install-prepush-hook.mjs';
import { hasBash, git } from './lib/hook-test-helpers.mjs';

const { HOOK_BODY } = _internals;
const HAS_BASH = hasBash();
const HAS_GIT = spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;

function withWorkspace(fn) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-shortcircuit-'));
  try {
    return fn(base);
  } finally {
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

/**
 * A stub source dir: `sync-to-repos.mjs` is the discovery sentinel;
 * `check-plan-status.mjs` mimics the real CLI's `--selfcheck-relocation` /
 * `--select` / `--drift` contract just enough to select a fixed active plan;
 * `openai-audit.mjs` writes MARKER on invocation instead of doing anything
 * real — the only reliable way to answer "was the audit actually invoked".
 */
function makeSourceRepo(workspace) {
  const root = path.join(workspace, 'source-repo');
  const scripts = path.join(root, 'scripts');
  fs.mkdirSync(scripts, { recursive: true });
  fs.writeFileSync(path.join(scripts, 'sync-to-repos.mjs'), '// fixture\n');
  fs.writeFileSync(path.join(scripts, 'openai-audit.mjs'), [
    "import fs from 'node:fs';",
    "fs.writeFileSync('AUDIT_WAS_CALLED', 'yes\\n');",
    "process.exit(0);",
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(scripts, 'check-plan-status.mjs'), [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "const argv = process.argv.slice(2);",
    "if (argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }",
    "const selIdx = argv.indexOf('--select');",
    "if (selIdx >= 0) {",
    "  const dir = argv[selIdx + 1];",
    "  const p = path.join(dir, 'active.md');",
    "  if (fs.existsSync(p)) process.stdout.write(path.relative(process.cwd(), p).split(path.sep).join('/') + '\\n');",
    "  process.exit(0);",
    "}",
    "if (argv.includes('--drift')) process.exit(0);",
    "process.exit(0);",
    '',
  ].join('\n'));
  return root;
}

/**
 * A real consumer repo with one active plan and both sync bookkeeping files
 * present from the seed commit, pushed to a bare remote. Returns a `commit`
 * helper that stages the given relative paths (writing trivial content to
 * each) and returns `{base, head}` for the range git would report to the hook.
 */
function buildConsumerFixture(workspace) {
  const bare = path.join(workspace, 'origin.git');
  const local = path.join(workspace, 'local');
  git(['init', '--bare', '-q', '-b', 'main', bare]);
  git(['clone', '-q', bare, local]);
  git(['config', 'user.email', 'local@example.invalid'], local);
  git(['config', 'user.name', 'Local'], local);

  fs.mkdirSync(path.join(local, 'docs', 'plans'), { recursive: true });
  fs.writeFileSync(
    path.join(local, 'docs', 'plans', 'active.md'),
    '# Plan: Active\n\n- **Status**: In Progress\n\n## Notes\n',
  );
  fs.mkdirSync(path.join(local, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(local, '.sync-receipt.json'), '{"v":1}\n');
  fs.writeFileSync(path.join(local, 'scripts', '.sync-owned.json'), '{}\n');
  git(['add', '.'], local);
  git(['commit', '-q', '-m', 'A0: seed'], local);
  git(['push', '-q', 'origin', 'main'], local);

  let counter = 0;
  const commit = (files) => {
    const base = git(['rev-parse', 'HEAD'], local);
    for (const rel of files) {
      const abs = path.join(local, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, `change ${++counter}\n`);
      git(['add', rel], local);
    }
    git(['commit', '-q', '-m', `bump ${files.join(', ')}`], local);
    const head = git(['rev-parse', 'HEAD'], local);
    return { base, head };
  };

  return { local, commit };
}

function runHook(local, sourceRepo, stdin) {
  const script = path.join(local, '.hook.sh');
  fs.writeFileSync(script, HOOK_BODY);
  return spawnSync('bash', [script, 'origin', 'https://example.invalid'], {
    cwd: local,
    encoding: 'utf-8',
    input: stdin,
    env: { ...process.env, CLAUDE_AUDIT_LOOP_DIR: sourceRepo },
  });
}

describe('sync-bookkeeping-only short-circuit — static shape', () => {
  it('sits after PLAN_FILE selection and before the audit invocation', () => {
    const selectAt = HOOK_BODY.indexOf('[ -z "$PLAN_FILE" ] && finish');
    const shortCircuitAt = HOOK_BODY.indexOf('NON_BOOKKEEPING_FILES=');
    const auditAt = HOOK_BODY.indexOf('auditing $PLAN_FILE');
    assert.ok(selectAt > 0 && shortCircuitAt > 0 && auditAt > 0);
    assert.ok(selectAt < shortCircuitAt, 'short-circuit must run after plan selection');
    assert.ok(shortCircuitAt < auditAt, 'short-circuit must run before the audit invocation');
  });

  it('matches exactly the two sync bookkeeping paths, anchored', () => {
    assert.match(HOOK_BODY, /\^\(\\\.sync-receipt\\\.json\|scripts\/\\\.sync-owned\\\.json\)\$/);
  });

  it('only fires with a known push range — guarded on PUSH_BASE/PUSH_HEAD', () => {
    const guardAt = HOOK_BODY.indexOf('if [ -n "$PUSH_BASE" ] && [ -n "$PUSH_HEAD" ]; then');
    const shortCircuitAt = HOOK_BODY.indexOf('NON_BOOKKEEPING_FILES=');
    assert.ok(guardAt > 0 && shortCircuitAt > guardAt);
  });

  it('bumped the version so consumers re-install', () => {
    const v = Number(HOOK_BODY.match(/# hook-version: (\d+)/)[1]);
    assert.ok(v >= 7, `hook-version must be >= 7 for this fix, got ${v}`);
  });
});

describe('sync-bookkeeping-only short-circuit — the real hook, executed', () => {
  it('RED: an unrelated active plan used to get audited anyway (fixture validity)', (t) => {
    if (!HAS_GIT || !HAS_BASH) return t.skip('git and bash are both required');
    withWorkspace((ws) => {
      const sourceRepo = makeSourceRepo(ws);
      const { local, commit } = buildConsumerFixture(ws);
      const { base, head } = commit(['.sync-receipt.json']);
      // Sanity: the diff really is bookkeeping-only, or this test proves nothing.
      const changed = git(['diff', '--name-only', `${base}..${head}`], local).split('\n').filter(Boolean);
      assert.deepEqual(changed, ['.sync-receipt.json']);

      const r = runHook(local, sourceRepo, `refs/heads/main ${head} refs/heads/main ${base}\n`);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stderr, /skipping code audit/);
      assert.equal(fs.existsSync(path.join(local, 'AUDIT_WAS_CALLED')), false, 'the audit must not have been invoked');
    });
  });

  it('GREEN: both bookkeeping files changed together — still skipped', (t) => {
    if (!HAS_GIT || !HAS_BASH) return t.skip('git and bash are both required');
    withWorkspace((ws) => {
      const sourceRepo = makeSourceRepo(ws);
      const { local, commit } = buildConsumerFixture(ws);
      const { base, head } = commit(['.sync-receipt.json', 'scripts/.sync-owned.json']);

      const r = runHook(local, sourceRepo, `refs/heads/main ${head} refs/heads/main ${base}\n`);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stderr, /skipping code audit/);
      assert.equal(fs.existsSync(path.join(local, 'AUDIT_WAS_CALLED')), false);
    });
  });

  it('a mixed push (bookkeeping + a real file) still runs the audit', (t) => {
    if (!HAS_GIT || !HAS_BASH) return t.skip('git and bash are both required');
    withWorkspace((ws) => {
      const sourceRepo = makeSourceRepo(ws);
      const { local, commit } = buildConsumerFixture(ws);
      const { base, head } = commit(['.sync-receipt.json', 'README.md']);

      const r = runHook(local, sourceRepo, `refs/heads/main ${head} refs/heads/main ${base}\n`);
      assert.doesNotMatch(r.stderr, /skipping code audit/);
      assert.match(r.stderr, /auditing docs\/plans\/active\.md/);
      assert.equal(fs.existsSync(path.join(local, 'AUDIT_WAS_CALLED')), true, 'the audit must have been invoked');
    });
  });

  it('a real-file-only push runs the audit (no bookkeeping involved at all)', (t) => {
    if (!HAS_GIT || !HAS_BASH) return t.skip('git and bash are both required');
    withWorkspace((ws) => {
      const sourceRepo = makeSourceRepo(ws);
      const { local, commit } = buildConsumerFixture(ws);
      const { base, head } = commit(['README.md']);

      const r = runHook(local, sourceRepo, `refs/heads/main ${head} refs/heads/main ${base}\n`);
      assert.doesNotMatch(r.stderr, /skipping code audit/);
      assert.equal(fs.existsSync(path.join(local, 'AUDIT_WAS_CALLED')), true);
    });
  });

  it('an UNKNOWN push range never skips — the audit still runs rather than guessing', (t) => {
    if (!HAS_GIT || !HAS_BASH) return t.skip('git and bash are both required');
    withWorkspace((ws) => {
      const sourceRepo = makeSourceRepo(ws);
      const { local, commit } = buildConsumerFixture(ws);
      // A genuinely bookkeeping-only commit exists...
      commit(['.sync-receipt.json']);
      // ...but stdin is empty, exactly like a hook that never learned the
      // range (pre-v6, or a malformed invocation) — PUSH_BASE/_HEAD stay "".
      const r = runHook(local, sourceRepo, '');
      assert.doesNotMatch(r.stderr, /skipping code audit/);
      assert.equal(fs.existsSync(path.join(local, 'AUDIT_WAS_CALLED')), true, 'an unknown range must never be read as "skip"');
    });
  });
});

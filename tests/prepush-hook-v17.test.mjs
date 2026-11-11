/**
 * @fileoverview Hook v17 (Tier 3: the consumer hook contract - it ships to repos nobody here can observe), from the 2026-11-11 consumer
 * feedback, theme 1 (docs/plans/prepush-gate-consumer-feedback-theme1.md):
 *
 *   D1. NO PLAN -> a PLAN-LESS AUDIT. A code push the selector resolved no plan for (untracked plans, no docs/plans directory, several
 *       active and none touched) is audited WITHOUT a plan - the pushed commits' own messages are the stated intent - instead of being
 *       refused (v13-v16) or waved through (a missing docs/plans directory, v16). Only a SUCCESSFUL no-match falls back: a failed
 *       selector, an override naming no file and an unknown range still refuse UNMEASURED.
 *   D2. THE AUDIT READS THE PUSHED COMMIT. It runs with cwd in a detached snapshot worktree of PUSH_HEAD, removed on every exit path; the
 *       paths the hook reads afterwards are absolute in the checkout; untracked inputs follow the declared census.
 *   D4. ONE INVOCATION LOG LINE per run, with the outcome and the overrides that were set.
 *
 * The real hook body runs under bash against a real origin + clone, with the real step runner and a recording fake audit. Both directions
 * throughout: what each rule must do AND what it must not.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { _internals } from '../scripts/install-prepush-hook.mjs';
import { CONSUMER_SNAPSHOT_PREFIX } from '../scripts/lib/prepush-snapshot.mjs';
import { hasBash, git } from './lib/hook-test-helpers.mjs';
import { writeStepRunnerStub } from './lib/prepush-step-stub.mjs';

const { HOOK_BODY } = _internals;
const HAS_BASH = hasBash();
const tmpDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const rmrf = (p) => fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
// An OpenAI-shaped key the gentle redactor recognises, assembled so this file carries no key-shaped literal.
const FAKE_KEY = ['sk', 'proj', 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2'].join('-');

/** The source checkout: the REAL step runner (via a delegating stub), a scriptable selector, and a fake audit that records what it saw. */
function sourceRepo(ws) {
  const scripts = path.join(ws, 'source-repo', 'scripts');
  fs.mkdirSync(scripts, { recursive: true });
  fs.writeFileSync(path.join(scripts, 'sync-to-repos.mjs'), '// fixture\n');
  writeStepRunnerStub(scripts);
  fs.writeFileSync(path.join(scripts, 'check-plan-status.mjs'), [
    "import fs from 'node:fs';",
    "const a = process.argv.slice(2);",
    "if (a.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }",
    "if (a.includes('--select')) {",
    "  if (process.env.STUB_SELECT === 'crash') { console.error('selector: malformed Status'); process.exit(1); }",
    "  const ov = (process.env.AUDIT_PREPUSH_PLAN || '').trim();",
    "  if (ov) { if (fs.existsSync(ov)) console.log(ov); process.exit(0); }",
    "  if (fs.existsSync('docs/plans/active.md')) console.log('docs/plans/active.md');",
    "  process.exit(0);",
    "}",
    'process.exit(0);', '',
  ].join('\n'));
  fs.writeFileSync(path.join(scripts, 'openai-audit.mjs'), [
    "import fs from 'node:fs';", "import path from 'node:path';",
    "const a = process.argv.slice(2);",
    "const o = a.indexOf('--out'); const out = o >= 0 ? a[o + 1] : null;",
    "const root = out ? path.resolve(out, '..', '..', '..') : process.cwd();",
    "const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);",
    "const rec = { argv: a, cwd: process.cwd(), app: read('src/app.mjs'), untrackedVisible: fs.existsSync('UNTRACKED.txt'), auditignore: read('.auditignore'), gitDir: process.env.GIT_DIR ?? null, gitWorkTree: process.env.GIT_WORK_TREE ?? null };",
    "const pl = a.indexOf('--planless'); if (pl >= 0) rec.intent = read(a[pl + 1]);",
    // A real audit writes its reuse marker relative to cwd; in v17 that is the snapshot, so it must never reach the checkout.
    "fs.mkdirSync('.audit', { recursive: true }); fs.writeFileSync('.audit/last-audit-run.json', '{\"runId\":\"written-by-the-hook-audit\"}');",
    "fs.writeFileSync(path.join(root, 'AUDIT_REC.json'), JSON.stringify(rec));",
    "if ((process.env.AUDIT_STUB || 'pass') === 'crash') { console.error('Error: audit aborted - boom'); process.exit(1); }",
    "if (out) fs.writeFileSync(out, JSON.stringify({ verdict: 'PASS', findings: [], ...(pl >= 0 ? { planless: true } : {}) }));",
    'process.exit(0);', '',
  ].join('\n'));
  return path.join(ws, 'source-repo');
}

/**
 * origin (bare) + a clone. `plans`: 'none' (no docs/plans directory), 'ignored' (docs/plans gitignored, an untracked draft in it),
 * 'active' (a tracked plan the selector picks).
 */
function consumer(ws, { plans = 'none' } = {}) {
  const bare = path.join(ws, 'origin.git');
  const local = path.join(ws, 'local');
  git(['init', '--bare', '-q', '-b', 'main', bare]);
  git(['clone', '-q', bare, local]);
  git(['config', 'user.email', 'a@example.invalid'], local);
  git(['config', 'user.name', 'A'], local);
  const ignore = ['.audit/', 'AUDIT_REC.json', 'UNTRACKED.txt', '.auditignore', ...(plans === 'ignored' ? ['docs/plans/'] : [])];
  fs.writeFileSync(path.join(local, '.gitignore'), `${ignore.join('\n')}\n`);
  fs.mkdirSync(path.join(local, 'src'), { recursive: true });
  fs.writeFileSync(path.join(local, 'src', 'app.mjs'), 'export const app = 0;\n');
  if (plans === 'active') {
    fs.mkdirSync(path.join(local, 'docs', 'plans'), { recursive: true });
    fs.writeFileSync(path.join(local, 'docs', 'plans', 'active.md'), '# Plan\n\n- **Status**: In Progress\n');
  }
  git(['add', '.'], local);
  git(['commit', '-q', '-m', 'seed'], local);
  git(['push', '-q', 'origin', 'main'], local);
  if (plans === 'ignored') {
    fs.mkdirSync(path.join(local, 'docs', 'plans'), { recursive: true });
    fs.writeFileSync(path.join(local, 'docs', 'plans', 'draft.md'), '# Untracked draft\n');
  }
  /** Commit `files` with `msg` (only those paths) and return git's pre-push stdin line for it. */
  const push = (files, msg = 'feat: work') => {
    const base = git(['rev-parse', 'HEAD'], local);
    for (const [f, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(local, f)), { recursive: true });
      fs.writeFileSync(path.join(local, f), body);
      git(['add', '-f', f], local);
    }
    git(['commit', '-q', '-m', msg], local);
    const head = git(['rev-parse', 'HEAD'], local);
    return { stdin: `refs/heads/main ${head} refs/heads/main ${base}\n`, head, base };
  };
  return { bare, local, push };
}

function hookEnv(source, extra = {}) {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AZURE_'))),
    CLAUDE_AUDIT_LOOP_DIR: source, AUDIT_PREPUSH_BLOCK: '', AUDIT_PREPUSH_DISABLE: '', AUDIT_PREPUSH_ALLOW_UNMEASURED: '',
    AUDIT_PREPUSH_ARCHIVE_LANE: '', AUDIT_PREPUSH_PLAN: '', PLAN_STATUS_DISABLE: '', PREPUSH_LOCAL_DISABLE: '', AUDIT_STUB: '', STUB_SELECT: '',
    AUDIT_PREPUSH_AUDIT_BUDGET_SEC: '', ...extra,
  };
}
function runHook(c, source, stdin, env = {}) {
  const script = path.join(c.local, '.hook.sh');
  fs.writeFileSync(script, HOOK_BODY);
  // An empty env value would still be "set" for printenv; unset what the caller blanked so the invocation log sees only real overrides.
  const e = hookEnv(source, env);
  for (const [k, v] of Object.entries(e)) if (v === '') delete e[k];
  return spawnSync('bash', [script, 'origin', c.bare], { cwd: c.local, encoding: 'utf-8', input: stdin, timeout: 240_000, env: e });
}
const recOf = (c) => { const f = path.join(c.local, 'AUDIT_REC.json'); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; };
const logLines = (c) => { const f = path.join(c.local, '.audit', 'prepush', 'invocations.log'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean) : []; };

function scenario(t, name, opts, fn) {
  if (!HAS_BASH) return t.skip('bash is required');
  const ws = tmpDir(`hook-v17-${name}-`);
  try { return fn({ c: consumer(ws, opts), source: sourceRepo(ws) }); } finally { rmrf(ws); }
}

describe('hook v17 - D1: a push with no plan is audited WITHOUT a plan', () => {
  it('untracked plans (docs/plans gitignored): a code push is audited with `code --planless <intent>`; the intent is the commit messages, redacted', (t) => {
    scenario(t, 'ignored', { plans: 'ignored' }, ({ c, source }) => {
      const p = c.push({ 'src/app.mjs': 'export const app = 1;\n' }, `feat: wire the thing\n\nrotated ${FAKE_KEY} out of config`);
      const r = runHook(c, source, p.stdin);
      assert.equal(r.status, 0, r.stderr);
      const rec = recOf(c);
      assert.ok(rec, `the audit ran:\n${r.stderr}`);
      assert.deepEqual(rec.argv.slice(0, 2), ['code', '--planless']);
      assert.ok(path.isAbsolute(rec.argv[2]), 'the intent path crosses into the snapshot as an absolute path');
      assert.match(rec.argv[2], /\.audit\/prepush\/[0-9a-f]{12}-[0-9a-f]{12}-[0-9a-f]{12}-\d+\.intent\.md$/);
      assert.ok(rec.argv.includes('--base') && rec.argv.includes(p.base), 'the range git handed the hook');
      assert.match(rec.intent, /feat: wire the thing/);
      assert.ok(!rec.intent.includes(FAKE_KEY), 'a secret in a commit message never reaches the audit');
      assert.match(r.stderr, /no plan selected .* auditing WITHOUT a plan: intent = 1 commit message\(s\) .*plan conformance is NOT checked/);
      assert.match(r.stderr, /code audit \(plan-less\): PASS/);
      assert.ok(fs.existsSync(rec.argv[2]), 'the intent file is kept beside the report');
    });
  });
  it('NO docs/plans directory: the same plan-less path (v16 ran `finish` here: exit 0 and the audit never called)', (t) => {
    scenario(t, 'nodir', { plans: 'none' }, ({ c, source }) => {
      const p = c.push({ 'src/app.mjs': 'export const app = 2;\n' }, 'fix: no plans directory here');
      const r = runHook(c, source, p.stdin);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stderr, /no docs\/plans directory here or in the pushed commit, and AUDIT_PREPUSH_PLAN is not set/);
      assert.equal(recOf(c)?.argv?.[1], '--planless', `the audit was called plan-less:\n${r.stderr}`);
    });
  });
  it('a docs-only push with no plan stays EXEMPT: the audit is not called', (t) => {
    scenario(t, 'docs', { plans: 'none' }, ({ c, source }) => {
      const r = runHook(c, source, c.push({ 'docs/guide.md': 'words\n' }).stdin);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stderr, /nothing a code audit reads: only documentation/);
      assert.equal(recOf(c), null);
    });
  });
  it('an UNKNOWN range (no stdin from git) with no plan is still refused UNMEASURED - never plan-less', (t) => {
    scenario(t, 'norange', { plans: 'none' }, ({ c, source }) => {
      c.push({ 'src/app.mjs': 'export const app = 3;\n' });
      const r = runHook(c, source, '');
      assert.equal(r.status, 1, r.stderr);
      assert.match(r.stderr, /UNMEASURED: no plan was selected .*could not be established/);
      assert.equal(recOf(c), null);
    });
  });
  it('AUDIT_PREPUSH_PLAN naming a missing file is refused naming it - a typo never becomes a plan-less audit', (t) => {
    scenario(t, 'typo', { plans: 'active' }, ({ c, source }) => {
      const r = runHook(c, source, c.push({ 'src/app.mjs': 'export const app = 4;\n' }).stdin, { AUDIT_PREPUSH_PLAN: 'docs/plans/missing.md' });
      assert.equal(r.status, 1, r.stderr);
      assert.match(r.stderr, /AUDIT_PREPUSH_PLAN=docs\/plans\/missing\.md does not exist/);
      assert.equal(recOf(c), null);
    });
  });
  it('a selector that FAILED is refused UNMEASURED - it has not shown that no plan applies', (t) => {
    scenario(t, 'selcrash', { plans: 'active' }, ({ c, source }) => {
      const r = runHook(c, source, c.push({ 'src/app.mjs': 'export const app = 5;\n' }).stdin, { STUB_SELECT: 'crash' });
      assert.equal(r.status, 1, r.stderr);
      assert.match(r.stderr, /the plan selector failed/);
      assert.equal(recOf(c), null);
    });
  });
  it('a SELECTED plan is plan-keyed, by its repo-relative path (same bytes in the snapshot), never plan-less', (t) => {
    scenario(t, 'selected', { plans: 'active' }, ({ c, source }) => {
      const r = runHook(c, source, c.push({ 'src/app.mjs': 'export const app = 6;\n' }).stdin);
      assert.equal(r.status, 0, r.stderr);
      const rec = recOf(c);
      assert.deepEqual(rec.argv.slice(0, 2), ['code', 'docs/plans/active.md']);
      assert.ok(!rec.argv.includes('--planless'));
      assert.match(r.stderr, /code audit: PASS/);
      assert.doesNotMatch(r.stderr, /plan read from the checkout/);
    });
  });
  it('a selected plan EDITED in the working tree is read from the checkout by absolute path, and the hook says so', (t) => {
    scenario(t, 'edited', { plans: 'active' }, ({ c, source }) => {
      const p = c.push({ 'src/app.mjs': 'export const app = 7;\n' });
      fs.writeFileSync(path.join(c.local, 'docs', 'plans', 'active.md'), '# Plan\n\n- **Status**: In Progress\n\nlocal edit\n');
      const r = runHook(c, source, p.stdin);
      assert.equal(r.status, 0, r.stderr);
      const rec = recOf(c);
      assert.ok(path.isAbsolute(rec.argv[1]) && rec.argv[1].endsWith('docs/plans/active.md'), rec.argv[1]);
      assert.match(r.stderr, /plan read from the checkout, not the pushed commit: .*docs\/plans\/active\.md/);
    });
  });
});

describe('hook v17 - D2: the audit reads a snapshot of the pushed commit', () => {
  it('cwd is a snapshot: a dirty tracked edit and an untracked file are invisible; the snapshot is gone afterwards; the reuse marker is untouched', (t) => {
    scenario(t, 'snap', { plans: 'active' }, ({ c, source }) => {
      const p = c.push({ 'src/app.mjs': 'export const app = 8; // pushed\n' });
      fs.writeFileSync(path.join(c.local, 'src', 'app.mjs'), 'export const app = 8; // DIRTY, not pushed\n');
      fs.writeFileSync(path.join(c.local, 'UNTRACKED.txt'), 'x'.repeat(3 * 1024 * 1024));
      fs.mkdirSync(path.join(c.local, '.audit'), { recursive: true });
      const marker = path.join(c.local, '.audit', 'last-audit-run.json');
      fs.writeFileSync(marker, '{"runId":"converged-audit-code-loop"}');
      const before = fs.readFileSync(marker);
      const r = runHook(c, source, p.stdin);
      assert.equal(r.status, 0, r.stderr);
      const rec = recOf(c);
      assert.match(path.basename(rec.cwd), new RegExp(`^${CONSUMER_SNAPSHOT_PREFIX}`));
      assert.equal(rec.app, 'export const app = 8; // pushed\n', 'the pushed bytes, not the working tree');
      assert.equal(rec.untrackedVisible, false);
      assert.equal(fs.existsSync(rec.cwd), false, 'the snapshot is removed after the audit');
      assert.ok(fs.readFileSync(marker).equals(before), 'the hook audit\'s own marker died with the snapshot');
      assert.match(r.stderr, /audit snapshot: .* a detached worktree of [0-9a-f]{12}/);
    });
  });
  it('git\'s repo-pointing variables never follow the audit into the snapshot (a linked-worktree push exports GIT_DIR) - audit B R3 H1', (t) => {
    scenario(t, 'gitdir', { plans: 'active' }, ({ c, source }) => {
      const p = c.push({ 'src/app.mjs': 'export const app = 16;\n' });
      const r = runHook(c, source, p.stdin, { GIT_DIR: path.join(c.local, '.git'), GIT_WORK_TREE: c.local });
      assert.equal(r.status, 0, r.stderr);
      const rec = recOf(c);
      assert.equal(rec.gitDir, null, 'GIT_DIR must be unset inside the snapshot');
      assert.equal(rec.gitWorkTree, null);
      assert.match(path.basename(rec.cwd), new RegExp(`^${CONSUMER_SNAPSHOT_PREFIX}`));
    });
  });
  it('a refused audit (crash) still removes the snapshot, and the push is refused UNMEASURED', (t) => {
    scenario(t, 'crash', { plans: 'active' }, ({ c, source }) => {
      const r = runHook(c, source, c.push({ 'src/app.mjs': 'export const app = 9;\n' }).stdin, { AUDIT_STUB: 'crash' });
      assert.equal(r.status, 1, r.stderr);
      assert.match(r.stderr, /UNMEASURED: the code audit did NOT run/);
      assert.equal(fs.existsSync(recOf(c).cwd), false);
    });
  });
  it('census: an untracked .auditignore is copied in; the untracked debt ledger is passed by ABSOLUTE path, read-only', (t) => {
    scenario(t, 'census', { plans: 'active' }, ({ c, source }) => {
      const p = c.push({ 'src/app.mjs': 'export const app = 10;\n' });
      fs.writeFileSync(path.join(c.local, '.auditignore'), 'vendor/**\n');
      fs.mkdirSync(path.join(c.local, '.audit'), { recursive: true });
      fs.writeFileSync(path.join(c.local, '.audit', 'tech-debt.json'), '{"version":1,"entries":[]}');
      const r = runHook(c, source, p.stdin);
      assert.equal(r.status, 0, r.stderr);
      const rec = recOf(c);
      assert.equal(rec.auditignore, 'vendor/**\n');
      const i = rec.argv.indexOf('--debt-ledger');
      assert.ok(i > 0, rec.argv.join(' '));
      assert.ok(path.isAbsolute(rec.argv[i + 1]) && rec.argv[i + 1].endsWith('.audit/tech-debt.json'));
      assert.ok(rec.argv.includes('--read-only-debt'));
    });
  });
  it('NEGATIVE: no debt ledger in the checkout -> no --debt-ledger flag (nothing is invented)', (t) => {
    scenario(t, 'nodebt', { plans: 'active' }, ({ c, source }) => {
      const r = runHook(c, source, c.push({ 'src/app.mjs': 'export const app = 11;\n' }).stdin);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(!recOf(c).argv.includes('--debt-ledger'));
    });
  });
});

describe('hook v17 - D4: one invocation log line per run', () => {
  it('the kill switch logs `disabled` with head "-" (stdin is never read on that path) and its override', (t) => {
    scenario(t, 'log-off', { plans: 'active' }, ({ c, source }) => {
      const r = runHook(c, source, c.push({ 'src/app.mjs': 'export const app = 12;\n' }).stdin, { AUDIT_PREPUSH_DISABLE: '1' });
      assert.equal(r.status, 0, r.stderr);
      const l = logLines(c);
      assert.equal(l.length, 1);
      // CLAUDE_AUDIT_LOOP_DIR is set by this harness to point at the fixture source checkout; it is a real override and is listed.
      assert.match(l[0], /^\S+Z - outcome=disabled overrides=AUDIT_PREPUSH_DISABLE,CLAUDE_AUDIT_LOOP_DIR$/);
      assert.equal(recOf(c), null);
    });
  });
  it('a clean audit logs `clean` with the pushed head; ALLOW_UNMEASURED set but unused is listed, never counted as exercised', (t) => {
    scenario(t, 'log-clean', { plans: 'active' }, ({ c, source }) => {
      const p = c.push({ 'src/app.mjs': 'export const app = 13;\n' });
      const r = runHook(c, source, p.stdin, { AUDIT_PREPUSH_ALLOW_UNMEASURED: '1' });
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(logLines(c).map((l) => l.replace(/^\S+ /, '')), [`${p.head.slice(0, 12)} outcome=clean overrides=AUDIT_PREPUSH_ALLOW_UNMEASURED,CLAUDE_AUDIT_LOOP_DIR`]);
    });
  });
  it('`allowed-unmeasured` only when that override decided the outcome; a refusal logs `refused`', (t) => {
    scenario(t, 'log-unmeasured', { plans: 'active' }, ({ c, source }) => {
      const p = c.push({ 'src/app.mjs': 'export const app = 14;\n' });
      const refused = runHook(c, source, p.stdin, { AUDIT_STUB: 'crash' });
      assert.equal(refused.status, 1);
      const allowed = runHook(c, source, p.stdin, { AUDIT_STUB: 'crash', AUDIT_PREPUSH_ALLOW_UNMEASURED: '1' });
      assert.equal(allowed.status, 0, allowed.stderr);
      const l = logLines(c).map((x) => x.replace(/^\S+ \S+ /, ''));
      assert.deepEqual(l, ['outcome=refused overrides=CLAUDE_AUDIT_LOOP_DIR', 'outcome=allowed-unmeasured overrides=AUDIT_PREPUSH_ALLOW_UNMEASURED,CLAUDE_AUDIT_LOOP_DIR']);
    });
  });
  it('over 256 KB the log rotates to .1 before the append: at most two files, the live one starts fresh', (t) => {
    scenario(t, 'log-rotate', { plans: 'none' }, ({ c, source }) => {
      const dir = path.join(c.local, '.audit', 'prepush');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'invocations.log'), 'old line\n'.repeat(300 * 1024 / 9));
      const big = fs.statSync(path.join(dir, 'invocations.log')).size;
      const r = runHook(c, source, c.push({ 'docs/a.md': 'x\n' }).stdin);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(fs.statSync(path.join(dir, 'invocations.log.1')).size, big);
      assert.equal(logLines(c).length, 1);
      assert.match(logLines(c)[0], /outcome=exempt/);
    });
  });
  it('an unwritable log location never changes the exit', (t) => {
    scenario(t, 'log-unwritable', { plans: 'active' }, ({ c, source }) => {
      fs.writeFileSync(path.join(c.local, '.audit'), 'a FILE where the directory would go');
      const r = runHook(c, source, c.push({ 'src/app.mjs': 'export const app = 15;\n' }).stdin, { AUDIT_PREPUSH_DISABLE: '1' });
      assert.equal(r.status, 0, r.stderr);
    });
  });
});

describe('hook v17 - static shape', () => {
  it('no early `finish` for a missing docs/plans directory remains (the hole a worktree without it fell through)', () => {
    assert.doesNotMatch(HOOK_BODY, /\[ ! -d "\$PLANS_DIR" \] && finish/);
  });
  it('a v17 body refuses a step runner without the planless and snapshot capabilities', () => {
    assert.match(HOOK_BODY, /for cap in audit-outcome audit-reuse audit-budget no-plan planless snapshot; do/);
  });
  it('every exit after the kill switch runs the EXIT trap that removes the snapshot and logs the invocation (signals included: prepush_killed exits)', () => {
    const trapAt = HOOK_BODY.indexOf("trap 'prepush_on_exit $?' EXIT");
    assert.ok(trapAt > HOOK_BODY.indexOf('[ "$AUDIT_PREPUSH_DISABLE" = "1" ] && { prepush_log_invocation disabled; exit 0; }'));
    assert.ok(trapAt < HOOK_BODY.indexOf('while read -r LOCAL_REF'), 'installed before any step can refuse');
    assert.match(HOOK_BODY, /prepush_killed\(\) \{\n {2}trap '' \$PREPUSH_TRAPPED\n.*\n {2}exit 1\n\}/);
  });
  it('the audit runs in the snapshot, from a subshell, so the hook\'s own cwd never moves', () => {
    assert.match(HOOK_BODY, /\( unset \$GIT_LOCAL_ENV_BASELINE \$\(git rev-parse --local-env-vars 2>\/dev\/null\); cd "\$SNAP_DIR" && AUDIT_ALLOW_FOREIGN_CWD=1 node "\$STEP_CLI" run --step code-audit/);
  });
});

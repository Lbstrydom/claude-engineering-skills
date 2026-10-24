/**
 * @fileoverview Hook v14 (Tier 3: consumer hook contract - ships to repos nobody here can observe). The advisory audit's report is
 * KEPT after the outcome is read (fleet p-20261024142941-39f0; wine #1171/#1181/#1183 had H/M findings nobody could triage because
 * v13 deleted both temp files as soon as the verdict was read).
 *
 * Every case drives the REAL hook body against a stub source repo whose audit follows the real exit contract, and was seen to fail
 * against v13's hook (the file was gone, the path never printed):
 *   - the report survives the push, under .audit/prepush/<pushed-tree-sha>.report.json, on pass, findings, unmeasured and timeout
 *   - the path is printed on every outcome; a timeout keeps partial output or SAYS none exists
 *   - retention is bounded (newest N of each kind) and never touches the files this push just wrote
 *   - a directory that cannot be created refuses the push and runs no audit (fail closed)
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

const { HOOK_BODY } = _internals;
const HAS_BASH = hasBash();
const tmpDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const rmrf = (p) => fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
const KEEP = '.audit/prepush';

/** Stub source repo: the real step runner, a selecting plan-status stub, and an audit whose AUDIT_STUB mode picks its outcome. */
function makeSource(ws) {
  const scripts = path.join(ws, 'source-repo', 'scripts');
  fs.mkdirSync(scripts, { recursive: true });
  fs.writeFileSync(path.join(scripts, 'sync-to-repos.mjs'), '// fixture\n');
  writeStepRunnerStub(scripts);
  fs.writeFileSync(path.join(scripts, 'check-plan-status.mjs'), [
    "import fs from 'node:fs';",
    "const a = process.argv.slice(2);",
    "if (a.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }",
    "if (a.includes('--select')) { if (fs.existsSync('docs/plans/active.md')) process.stdout.write('docs/plans/active.md\\n'); process.exit(0); }",
    'process.exit(0);', '',
  ].join('\n'));
  fs.writeFileSync(path.join(scripts, 'openai-audit.mjs'), [
    "import fs from 'node:fs';",
    "fs.writeFileSync('AUDIT_RAN', '1');",
    "const mode = process.env.AUDIT_STUB || 'pass';",
    "const envelope = (verdict, findings) => { const i = process.argv.indexOf('--out'); if (i >= 0) fs.writeFileSync(process.argv[i + 1], JSON.stringify({ verdict, findings })); };",
    "if (mode === 'hang' || mode === 'hangwrite') {",
    "  if (mode === 'hangwrite') console.log('PARTIAL-OUTPUT-MARKER');",
    "  setInterval(() => {}, 1000);",
    "} else if (mode === 'crash') { console.error('Error: audit aborted - boom'); process.exit(1); }",
    "else if (mode === 'exit3') { envelope('INCOMPLETE', []); process.exit(3); }",
    "else if (mode === 'findings') { console.log('AUDIT-STDOUT-MARKER'); envelope('SIGNIFICANT_ISSUES', [{ severity: 'HIGH', id: 'H1-MARKER' }, { severity: 'MEDIUM' }]); process.exit(0); }",
    "else { envelope('PASS', []); process.exit(0); }", '',
  ].join('\n'));
  return path.join(ws, 'source-repo');
}

/** origin + clone with an active plan, then ONE own commit; returns the stdin git would hand the hook and the pushed tree. */
function consumer(ws) {
  const bare = path.join(ws, 'origin.git');
  const local = path.join(ws, 'local');
  git(['init', '--bare', '-q', '-b', 'main', bare]);
  git(['clone', '-q', bare, local]);
  git(['config', 'user.email', 'a@example.invalid'], local);
  git(['config', 'user.name', 'A'], local);
  fs.mkdirSync(path.join(local, 'docs', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(local, 'docs', 'plans', 'active.md'), '# Plan\n\n- **Status**: In Progress\n');
  git(['add', '.'], local);
  git(['commit', '-q', '-m', 'seed'], local);
  git(['push', '-q', 'origin', 'main'], local);
  const base = git(['rev-parse', 'HEAD'], local);
  fs.mkdirSync(path.join(local, 'src'), { recursive: true });
  fs.writeFileSync(path.join(local, 'src', 'own.txt'), 'x\n');
  git(['add', 'src/own.txt'], local);
  git(['commit', '-q', '-m', 'own'], local);
  const head = git(['rev-parse', 'HEAD'], local);
  return { local, stdin: `refs/heads/main ${head} refs/heads/main ${base}\n`, tree: git(['rev-parse', `${head}^{tree}`], local) };
}

function runHook(local, source, stdin, env = {}) {
  const script = path.join(local, '.hook.sh');
  fs.writeFileSync(script, HOOK_BODY);
  return spawnSync('bash', [script, 'origin', 'https://example.invalid'], {
    cwd: local, encoding: 'utf-8', input: stdin, timeout: 120_000,
    env: { ...process.env, CLAUDE_AUDIT_LOOP_DIR: source, AUDIT_PREPUSH_BLOCK: '', AUDIT_PREPUSH_DISABLE: '', AUDIT_PREPUSH_ALLOW_UNMEASURED: '', AUDIT_PREPUSH_KEEP_REPORTS: '', AUDIT_STUB: '', ...env },
  });
}
const kept = (c, suffix) => path.join(c.local, KEEP, `${c.tree}.${suffix}`);
const keptEntries = (c) => (fs.existsSync(path.join(c.local, KEEP)) ? fs.readdirSync(path.join(c.local, KEEP)) : []);
/** One scenario in a fresh workspace; the callback gets the consumer and the source. */
function scenario(t, name, fn) {
  if (!HAS_BASH) return t.skip('bash is required');
  const ws = tmpDir(`hook-v14-${name}-`);
  try { return fn({ c: consumer(ws), source: makeSource(ws), ws }); } finally { rmrf(ws); }
}

describe('hook v14 - the audit report survives the push, and its path is printed', () => {
  it('FINDINGS (advisory, push goes on): the envelope and the output outlive the hook, keyed by the pushed tree', (t) => scenario(t, 'findings', ({ c, source }) => {
    const got = runHook(c.local, source, c.stdin, { AUDIT_STUB: 'findings' });
    assert.equal(got.status, 0, got.stderr);
    const report = JSON.parse(fs.readFileSync(kept(c, 'report.json'), 'utf8'));
    assert.equal(report.verdict, 'SIGNIFICANT_ISSUES');
    assert.equal(report.findings[0].id, 'H1-MARKER', 'the H/M findings are what must be triageable after the push');
    assert.match(fs.readFileSync(kept(c, 'output.log'), 'utf8'), /AUDIT-STDOUT-MARKER/);
    assert.ok(got.stderr.includes(`audit report.json kept: ${KEEP}/${c.tree}.report.json`), got.stderr);
    assert.ok(got.stderr.includes(`audit output.log kept: ${KEEP}/${c.tree}.output.log`), got.stderr);
    assert.deepEqual(keptEntries(c).filter((f) => f.startsWith('.tmp.')), [], 'no mktemp leftovers');
  }));

  it('PASS: kept and printed too', (t) => scenario(t, 'pass', ({ c, source }) => {
    const got = runHook(c.local, source, c.stdin);
    assert.equal(got.status, 0, got.stderr);
    assert.equal(JSON.parse(fs.readFileSync(kept(c, 'report.json'), 'utf8')).verdict, 'PASS');
    assert.ok(got.stderr.includes(`audit report.json kept: ${KEEP}/${c.tree}.report.json`), got.stderr);
  }));

  it('UNMEASURED (INCOMPLETE, exit 3): the push is refused AND the envelope is kept and printed', (t) => scenario(t, 'exit3', ({ c, source }) => {
    const got = runHook(c.local, source, c.stdin, { AUDIT_STUB: 'exit3' });
    assert.equal(got.status, 1, got.stderr);
    assert.equal(JSON.parse(fs.readFileSync(kept(c, 'report.json'), 'utf8')).verdict, 'INCOMPLETE');
    assert.ok(got.stderr.includes(`audit report.json kept: ${KEEP}/${c.tree}.report.json`), got.stderr);
  }));

  it('UNMEASURED (crash, no envelope): says no report exists, still keeps the output that explains the crash', (t) => scenario(t, 'crash', ({ c, source }) => {
    const got = runHook(c.local, source, c.stdin, { AUDIT_STUB: 'crash' });
    assert.equal(got.status, 1, got.stderr);
    assert.equal(fs.existsSync(kept(c, 'report.json')), false);
    assert.match(got.stderr, /audit report\.json: none exists \(the audit wrote nothing\)/);
    assert.match(fs.readFileSync(kept(c, 'output.log'), 'utf8'), /audit aborted - boom/);
    assert.ok(got.stderr.includes(`audit output.log kept: ${KEEP}/${c.tree}.output.log`), got.stderr);
  }));

  it('TIMEOUT (exit 124, refused): partial output the audit had written is kept and its path printed', (t) => scenario(t, 'hangwrite', ({ c, source }) => {
    const got = runHook(c.local, source, c.stdin, { AUDIT_STUB: 'hangwrite', AUDIT_PREPUSH_AUDIT_BUDGET_SEC: '3', AUDIT_PREPUSH_PROGRESS_SEC: '1' });
    assert.equal(got.status, 1, got.stderr);
    assert.match(got.stderr, /exceeded its 3s budget/);
    assert.match(fs.readFileSync(kept(c, 'output.log'), 'utf8'), /PARTIAL-OUTPUT-MARKER/);
    assert.ok(got.stderr.includes(`audit output.log kept: ${KEEP}/${c.tree}.output.log`), got.stderr);
    assert.match(got.stderr, /audit report\.json: none exists/, 'a timed-out audit wrote no envelope - said, not silent');
  }));

  it('TIMEOUT with nothing written at all: states clearly that none exists, and leaves no empty stub behind', (t) => scenario(t, 'hang', ({ c, source }) => {
    const got = runHook(c.local, source, c.stdin, { AUDIT_STUB: 'hang', AUDIT_PREPUSH_AUDIT_BUDGET_SEC: '3', AUDIT_PREPUSH_PROGRESS_SEC: '1' });
    assert.equal(got.status, 1, got.stderr);
    assert.match(got.stderr, /audit report\.json: none exists/);
    assert.match(got.stderr, /audit output\.log: none exists|audit output\.log kept/);
    assert.deepEqual(keptEntries(c).filter((f) => f.startsWith('.tmp.') || f.endsWith('.report.json')), []);
  }));
});

describe('hook v14 - bounded retention', () => {
  const seed = (c, n) => {
    const dir = path.join(c.local, KEEP);
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < n; i++) {
      for (const suffix of ['report.json', 'output.log']) {
        const f = path.join(dir, `${String(i).padStart(40, '0')}.${suffix}`);
        fs.writeFileSync(f, '{}');
        const when = new Date(Date.now() - (n - i + 5) * 3600_000);   // i=0 oldest; all older than this push's files
        fs.utimesSync(f, when, when);
      }
    }
  };
  it('keeps the newest N of each kind (default 20 when the knob is unset), always including the files just written', (t) => scenario(t, 'prune', ({ c, source }) => {
    seed(c, 25);
    const got = runHook(c.local, source, c.stdin);
    assert.equal(got.status, 0, got.stderr);
    const entries = keptEntries(c);
    assert.equal(entries.filter((f) => f.endsWith('.report.json')).length, 20);
    assert.equal(entries.filter((f) => f.endsWith('.output.log')).length, 20);
    assert.ok(entries.includes(`${c.tree}.report.json`), 'the file this push wrote is never the one pruned');
    assert.ok(!entries.includes(`${'0'.repeat(40)}.report.json`), 'the oldest went');
    assert.ok(entries.includes(`${String(24).padStart(40, '0')}.report.json`), 'the newest seeded one stayed');
  }));
  it('AUDIT_PREPUSH_KEEP_REPORTS tunes it; a nonsense value falls back to 20 rather than deleting everything', (t) => {
    scenario(t, 'prune3', ({ c, source }) => {
      seed(c, 10);
      assert.equal(runHook(c.local, source, c.stdin, { AUDIT_PREPUSH_KEEP_REPORTS: '3' }).status, 0);
      assert.equal(keptEntries(c).filter((f) => f.endsWith('.report.json')).length, 3);
    });
    scenario(t, 'prune-bad', ({ c, source }) => {
      seed(c, 10);
      assert.equal(runHook(c.local, source, c.stdin, { AUDIT_PREPUSH_KEEP_REPORTS: 'abc' }).status, 0);
      assert.equal(keptEntries(c).filter((f) => f.endsWith('.report.json')).length, 11);
    });
  });
});

describe('hook v14 - fail closed when the report cannot be created', () => {
  it('a file squatting on .audit/prepush refuses the push and runs NO audit', (t) => scenario(t, 'squat', ({ c, source }) => {
    fs.mkdirSync(path.join(c.local, '.audit'), { recursive: true });
    fs.writeFileSync(path.join(c.local, KEEP), 'not a directory');
    const got = runHook(c.local, source, c.stdin, { AUDIT_STUB: 'findings' });
    assert.equal(got.status, 1, got.stderr);
    assert.match(got.stderr, /cannot create private files under \.audit\/prepush .*push BLOCKED/);
    assert.equal(fs.readFileSync(path.join(c.local, KEEP), 'utf8'), 'not a directory', 'the squatter is untouched');
    assert.equal(fs.existsSync(path.join(c.local, 'AUDIT_RAN')), false, 'no private file, no audit');
  }));
});

describe('hook v14 housekeeping', () => {
  it('is version 14+ and no longer deletes the audit files after reading the outcome', () => {
    assert.ok(Number(HOOK_BODY.match(/# hook-version: (\d+)/)[1]) >= 14);
    assert.ok(!HOOK_BODY.includes('rm -f "$AUDIT_OUT" "$AUDIT_REPORT"\n  [ "$OUTCOME_RC"'), 'v13 deleted both files right after the outcome');
    assert.ok(HOOK_BODY.includes('.audit/prepush'));
  });
});

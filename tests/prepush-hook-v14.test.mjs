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
    "fs.writeFileSync('AUDIT_ARGV', JSON.stringify(process.argv.slice(2)));",
    "fs.writeFileSync('AUDIT_RANGE_BASE', process.env.AUDIT_PUSH_RANGE_BASE || '');",
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
  fs.writeFileSync(path.join(local, 'src', 'own.mjs'), 'x\n');
  git(['add', 'src/own.mjs'], local);
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
    assert.match(got.stderr, /audit output\.log: none exists \(the audit wrote nothing\)/);
    assert.deepEqual(keptEntries(c), [], 'no report, no output, no mktemp stub: the directory is empty');
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

describe('hook v14 - the kept files describe the LATEST attempt on a tree', () => {
  it('a later attempt that wrote nothing removes the earlier attempt files instead of leaving them to be read as its own', (t) => scenario(t, 'stale', ({ c, source }) => {
    assert.equal(runHook(c.local, source, c.stdin, { AUDIT_STUB: 'findings' }).status, 0);
    assert.ok(fs.existsSync(kept(c, 'report.json')) && fs.existsSync(kept(c, 'output.log')), 'fixture: the first attempt kept both');
    const got = runHook(c.local, source, c.stdin, { AUDIT_STUB: 'hang', AUDIT_PREPUSH_AUDIT_BUDGET_SEC: '3', AUDIT_PREPUSH_PROGRESS_SEC: '1' });
    assert.equal(got.status, 1, got.stderr);
    assert.match(got.stderr, /earlier attempt's .*.report.json was removed/);
    assert.deepEqual(keptEntries(c), []);
  }));
  it('a later attempt that wrote a report replaces the earlier one (same key, newest wins)', (t) => scenario(t, 'replace', ({ c, source }) => {
    assert.equal(runHook(c.local, source, c.stdin, { AUDIT_STUB: 'findings' }).status, 0);
    assert.equal(runHook(c.local, source, c.stdin).status, 0);
    assert.equal(JSON.parse(fs.readFileSync(kept(c, 'report.json'), 'utf8')).verdict, 'PASS');
    assert.deepEqual(keptEntries(c), [`${c.tree}.report.json`], 'the PASS attempt wrote no output, so the earlier output.log is gone too');
  }));
});

describe('hook v14 - retention never prunes what the run just published, and its knob is a positive decimal', () => {
  const seedFile = (c, name, ageHours) => {
    const dir = path.join(c.local, KEEP);
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, name);
    fs.writeFileSync(f, '{}');
    const when = new Date(Date.now() - ageHours * 3600_000);
    fs.utimesSync(f, when, when);
  };
  const count = (c, ext) => keptEntries(c).filter((f) => f.endsWith(ext)).length;
  it('KEEP=1 with a NEWER file already there: the just-published pair survives and the other goes (mtime order alone would delete it)', (t) => scenario(t, 'protect', ({ c, source }) => {
    seedFile(c, `${'a'.repeat(40)}.report.json`, -24);   // 24h in the FUTURE: outranks anything this run writes
    seedFile(c, `${'a'.repeat(40)}.output.log`, -24);
    const got = runHook(c.local, source, c.stdin, { AUDIT_PREPUSH_KEEP_REPORTS: '1', AUDIT_STUB: 'findings' });
    assert.equal(got.status, 0, got.stderr);
    assert.deepEqual(keptEntries(c).sort(), [`${c.tree}.output.log`, `${c.tree}.report.json`].sort());
  }));
  it('the six-digit limit is inclusive: 999999 is honoured (25 seeded + the run\'s own = 26 kept), 1000000 falls back to 20', (t) => {
    for (const [value, expected] of [['999999', 26], ['1000000', 20]]) {
      scenario(t, 'bound', ({ c, source }) => {
        for (let i = 0; i < 25; i++) seedFile(c, `${String(i).padStart(40, '0')}.report.json`, 10 + i);
        assert.equal(runHook(c.local, source, c.stdin, { AUDIT_PREPUSH_KEEP_REPORTS: value }).status, 0);
        assert.equal(count(c, '.report.json'), expected, `value ${value}`);
      });
    }
  });
  for (const [value, expectReports] of [['00', 11], ['08', 8], ['0020', 11], ['1234567', 11], ['-3', 11], ['1.5', 11]]) {
    it(`AUDIT_PREPUSH_KEEP_REPORTS=${value}: never deletes the run's own report; keeps ${expectReports - 1} older + it`, (t) => scenario(t, 'knob', ({ c, source }) => {
      for (let i = 0; i < 10; i++) { seedFile(c, `${String(i).padStart(40, '0')}.report.json`, 10 + i); seedFile(c, `${String(i).padStart(40, '0')}.output.log`, 10 + i); }
      const got = runHook(c.local, source, c.stdin, { AUDIT_PREPUSH_KEEP_REPORTS: value });
      assert.equal(got.status, 0, got.stderr);
      assert.ok(fs.existsSync(kept(c, 'report.json')), 'the own report of the run is never a casualty of a bad knob');
      assert.equal(count(c, '.report.json'), expectReports);
      assert.doesNotMatch(got.stderr, /value too great|syntax error|arithmetic/i);
    }));
  }
});

describe('hook v14 - the key is the pushed tree or the push is refused', () => {
  it('a pushed tree git cannot resolve refuses with the git reason and runs no audit (no invented key)', (t) => scenario(t, 'notree', ({ c, source, ws }) => {
    // The commit exists (the earlier steps resolved it), so make only the tree lookup fail: a git shim ahead of the real one on PATH.
    const shim = path.join(ws, 'shim');
    fs.mkdirSync(shim);
    const realGit = spawnSync('bash', ['-c', 'command -v git'], { encoding: 'utf-8' }).stdout.trim();
    fs.writeFileSync(path.join(shim, 'git'), [
      '#!/bin/sh',
      'case "$*" in *--verify*"^{tree}"*) echo "fatal: shimmed tree failure" >&2; exit 128 ;; esac',
      `exec "${realGit}" "$@"`, '',
    ].join('\n'), { mode: 0o755 });
    const got = runHook(c.local, source, c.stdin, { PATH: `${shim}${path.delimiter}${process.env.PATH}` });
    assert.equal(got.status, 1, got.stderr);
    assert.match(got.stderr, /cannot resolve the pushed tree of [0-9a-f]{40} \(git: fatal: shimmed tree failure ?\) .*push BLOCKED/);
    assert.equal(fs.existsSync(path.join(c.local, 'AUDIT_RAN')), false, 'no key, no audit');
    assert.deepEqual(keptEntries(c).filter((f) => f.startsWith('unknown')), []);
  }));
});

describe('hook v14 - the push base after a rebase + force push (fleet p-20261024154912-06f9)', () => {
  /** feature (one commit) pushed to origin, then main moves on. Returns the old remote tip and the new main tip. */
  function featurePushedAndMainMoved(c) {
    const { local } = c;
    const put = (rel, text, msg) => { fs.mkdirSync(path.dirname(path.join(local, rel)), { recursive: true }); fs.writeFileSync(path.join(local, rel), text); git(['add', rel], local); git(['commit', '-q', '-m', msg], local); return git(['rev-parse', 'HEAD'], local); };
    git(['checkout', '-q', '-b', 'feature', 'origin/main'], local);
    const oldRemote = put('src/f1.txt', 'f1\n', 'F1');
    git(['push', '-q', 'origin', 'feature'], local);
    git(['checkout', '-q', 'main'], local);
    git(['reset', '-q', '--hard', 'origin/main'], local);
    const mainTip = put('src/main-only.txt', 'm\n', 'M1 main moves on');
    git(['push', '-q', 'origin', 'main'], local);
    git(['checkout', '-q', 'feature'], local);
    return { put, oldRemote, mainTip };
  }
  const baseOf = (c) => fs.readFileSync(path.join(c.local, 'AUDIT_RANGE_BASE'), 'utf8');
  const argvOf = (c) => JSON.parse(fs.readFileSync(path.join(c.local, 'AUDIT_ARGV'), 'utf8'));

  it('REBASED onto a moved main and force-pushed: the stale remote tip is NOT the base - the merge-base with origin/main is, and the output says why', (t) => scenario(t, 'rebase', ({ c, source }) => {
    const f = featurePushedAndMainMoved(c);
    git(['rebase', '-q', 'main'], c.local);
    const head = git(['rev-parse', 'HEAD'], c.local);
    assert.notEqual(git(['merge-base', f.oldRemote, head], c.local), f.oldRemote, 'fixture: the old remote tip really is not an ancestor');
    const got = runHook(c.local, source, `refs/heads/feature ${head} refs/heads/feature ${f.oldRemote}\n`);
    assert.equal(got.status, 0, got.stderr);
    assert.equal(baseOf(c), f.mainTip, 'AUDIT_PUSH_RANGE_BASE carries the merge-base, so plan selection sees only the branch\'s own files');
    assert.equal(argvOf(c)[argvOf(c).indexOf('--base') + 1], f.mainTip, 'the audit is handed the same base');
    assert.match(got.stderr, new RegExp(`push base: ${f.mainTip}, the merge-base with origin/main \\(rewritten history: the remote tip ${f.oldRemote} is not an ancestor`));
  }));

  it('MUST NOT CHANGE: a plain fast-forward push still uses the remote tip as the base', (t) => scenario(t, 'ff', ({ c, source }) => {
    const f = featurePushedAndMainMoved(c);
    const head = f.put('src/f2.txt', 'f2\n', 'F2');
    const got = runHook(c.local, source, `refs/heads/feature ${head} refs/heads/feature ${f.oldRemote}\n`);
    assert.equal(got.status, 0, got.stderr);
    assert.equal(baseOf(c), f.oldRemote, 'REMOTE_SHA, not the (older) merge-base with origin/main');
    assert.notEqual(f.oldRemote, git(['merge-base', 'origin/main', head], c.local), 'fixture: the two candidates differ');
    assert.equal(argvOf(c)[argvOf(c).indexOf('--base') + 1], f.oldRemote);
    assert.match(got.stderr, new RegExp(`push base: the remote tip ${f.oldRemote} \\(fast-forward\\)`));
  }));

  it('a NEW branch still takes the merge-base with origin/main, saying it is a new branch', (t) => scenario(t, 'newbranch', ({ c, source }) => {
    const f = featurePushedAndMainMoved(c);
    git(['checkout', '-q', '-b', 'fresh'], c.local);
    const head = f.put('src/f3.txt', 'f3\n', 'F3');
    const got = runHook(c.local, source, `refs/heads/fresh ${head} refs/heads/fresh ${'0'.repeat(40)}\n`);
    assert.equal(got.status, 0, got.stderr);
    assert.equal(baseOf(c), git(['merge-base', 'origin/main', head], c.local));
    assert.match(got.stderr, /merge-base with origin\/main \(new branch\)/);
  }));
});

describe('hook v14 housekeeping', () => {
  it('is version 14+ and no longer deletes the audit files after reading the outcome', () => {
    assert.ok(Number(HOOK_BODY.match(/# hook-version: (\d+)/)[1]) >= 14);
    assert.ok(!HOOK_BODY.includes('rm -f "$AUDIT_OUT" "$AUDIT_REPORT"\n  [ "$OUTCOME_RC"'), 'v13 deleted both files right after the outcome');
    assert.ok(HOOK_BODY.includes('.audit/prepush'));
  });
});

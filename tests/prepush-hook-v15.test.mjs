/**
 * @fileoverview Hook v15 (Tier 3: consumer hook contract - ships to repos nobody here can observe). docs/plans/prepush-convergence-cluster-a.md
 *   - a push whose files are all NON-SUBJECTS for the code audit is NO_CODE_IN_SCOPE: recorded, allowed, no audit spend (fleet 70b5)
 *   - the bypass is proven or it does not happen: an older source checkout, a failing step, a malformed line, a missing record all RUN the audit
 *   - the run's own `.tmp-ledger.*` is removed by exact path; a concurrent run's live ledger is not touched; old orphans age out (fleet 484f)
 *   - one informational recurrence line after the report is kept
 * Every case drives the REAL hook body against a stub source repo whose audit follows the real exit contract.
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

const { HOOK_BODY, HOOK_VERSION_MARKER } = _internals;
const HAS_BASH = hasBash();
const tmpDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const rmrf = (p) => fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
const KEEP = '.audit/prepush';

/** Stub source repo. `stepMode` swaps the step runner for one that lies about a capability or about the no-code line. */
function makeSource(ws, stepMode = 'real') {
  const scripts = path.join(ws, 'source-repo', 'scripts');
  fs.mkdirSync(scripts, { recursive: true });
  fs.writeFileSync(path.join(scripts, 'sync-to-repos.mjs'), '// fixture\n');
  writeStepRunnerStub(scripts);
  if (stepMode !== 'real') {
    const real = path.join(scripts, 'prepush-step-real.mjs');
    fs.renameSync(path.join(scripts, 'prepush-step.mjs'), real);
    fs.writeFileSync(path.join(scripts, 'prepush-step.mjs'), [
      "import { spawnSync } from 'node:child_process';",
      "import { fileURLToPath } from 'node:url';",
      "const a = process.argv.slice(2);",
      `const mode = ${JSON.stringify(stepMode)};`,
      // `run -- node <step> no-code` is how the hook reaches the subcommand; intercept the wrapped command's tail.
      "const dd = a.indexOf('--'); const wrapped = dd >= 0 ? a.slice(dd + 1) : [];",
      "const isNoCode = wrapped[wrapped.length - 1] === 'no-code';",
      "if (a[0] === 'capabilities' && mode === 'old') { console.log('run own-files audit-outcome audit-reuse audit-budget no-plan'); process.exit(0); }",
      "if (isNoCode && mode === 'garbage') { console.log('no-code?? banana'); process.exit(0); }",
      "if (isNoCode && mode === 'norecord') { console.log('no-code 1 .audit/prepush/does-not-exist.no-code.json'); process.exit(0); }",
      "if (isNoCode && mode === 'rc1') { console.error('boom'); process.exit(1); }",
      "if (isNoCode && mode === 'emptyrecord') { const fs = await import('node:fs'); fs.mkdirSync('.audit/prepush', { recursive: true }); fs.writeFileSync('.audit/prepush/empty.no-code.json', ''); console.log('no-code 1 .audit/prepush/empty.no-code.json'); process.exit(0); }",
      `const r = spawnSync(process.execPath, [fileURLToPath(${JSON.stringify(new URL(`file:///${real.replaceAll('\\', '/')}`).href)}), ...a], { stdio: 'inherit' });`,
      'process.exit(r.status ?? 1);', '',
    ].join('\n'));
  }
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
    "const i = process.argv.indexOf('--out');",
    // The real audit derives a ledger beside --out: .tmp.XXXX -> .tmp-ledger.XXXX. Do the same so the hook has something to clean.
    "if (i >= 0) { const out = process.argv[i + 1]; fs.writeFileSync(out.replace(/\\.tmp\\.([^./\\\\]+)$/, '.tmp-ledger.$1'), '{}'); }",
    "const mode = process.env.AUDIT_STUB || 'pass';",
    "if (mode === 'nothing') process.exit(0);",
    "const f = mode === 'findings' ? [{ severity: 'HIGH', id: 'H1', section: 'src/own.mjs', _primaryFile: 'src/own.mjs', category: 'c', detail: 'd' }] : [];",
    "if (i >= 0) fs.writeFileSync(process.argv[i + 1], JSON.stringify({ verdict: mode === 'findings' ? 'SIGNIFICANT_ISSUES' : 'PASS', findings: f }));",
    'process.exit(0);', '',
  ].join('\n'));
  return path.join(ws, 'source-repo');
}

/** origin + clone with an active plan, then ONE own commit of `files`; returns the stdin git would hand the hook and the pushed tree. */
function consumer(ws, files, { withPlan = true } = {}) {
  const bare = path.join(ws, 'origin.git');
  const local = path.join(ws, 'local');
  git(['init', '--bare', '-q', '-b', 'main', bare]);
  git(['clone', '-q', bare, local]);
  git(['config', 'user.email', 'a@example.invalid'], local);
  git(['config', 'user.name', 'A'], local);
  fs.mkdirSync(path.join(local, 'docs', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(local, 'docs', 'plans', withPlan ? 'active.md' : 'done.md'), `# Plan\n\n- **Status**: ${withPlan ? 'In Progress' : 'Complete'}\n`);
  git(['add', '.'], local);
  git(['commit', '-q', '-m', 'seed'], local);
  git(['push', '-q', 'origin', 'main'], local);
  const base = git(['rev-parse', 'HEAD'], local);
  const commit = (fs_, msg) => {
    for (const [f, body] of Object.entries(fs_)) { fs.mkdirSync(path.dirname(path.join(local, f)), { recursive: true }); fs.writeFileSync(path.join(local, f), body); }
    git(['add', '.'], local); git(['commit', '-q', '-m', msg], local);
    const head = git(['rev-parse', 'HEAD'], local);
    return { head, stdin: `refs/heads/main ${head} refs/heads/main ${base}\n`, tree: git(['rev-parse', `${head}^{tree}`], local) };
  };
  return { local, base, commit, ...commit(files, 'own') };
}

function runHook(local, source, stdin, env = {}) {
  const script = path.join(local, '.hook.sh');
  fs.writeFileSync(script, HOOK_BODY);
  return spawnSync('bash', [script, 'origin', 'https://example.invalid'], {
    cwd: local, encoding: 'utf-8', input: stdin, timeout: 120_000,
    env: { ...process.env, CLAUDE_AUDIT_LOOP_DIR: source, AUDIT_PREPUSH_BLOCK: '', AUDIT_PREPUSH_DISABLE: '', AUDIT_PREPUSH_ALLOW_UNMEASURED: '', AUDIT_PREPUSH_KEEP_REPORTS: '', AUDIT_STUB: '', ...env },
  });
}
function scenario(t, name, files, fn, stepMode = 'real', opts = {}) {
  if (!HAS_BASH) return t.skip('bash is required');
  const ws = tmpDir(`hook-v15-${name}-`);
  try { return fn({ c: consumer(ws, files, opts), source: makeSource(ws, stepMode), ws }); } finally { rmrf(ws); }
}
const ran = (c) => fs.existsSync(path.join(c.local, 'AUDIT_RAN'));
const CODE = { 'src/own.mjs': 'export const a = 1;\n' };
const MANIFEST = { 'package.json': '{"name":"x"}\n' };

describe('hook v15 - version', () => {
  it('the installed body carries the v15 marker', () => assert.equal(HOOK_VERSION_MARKER, '# hook-version: 15'));
});

describe('hook v15 - NO_CODE_IN_SCOPE', () => {
  it('a package.json-only push is allowed, says NO_CODE_IN_SCOPE (not PASS, not UNMEASURED), leaves its record, and spends no audit', (t) => scenario(t, 'nocode', MANIFEST, ({ c, source }) => {
    const got = runHook(c.local, source, c.stdin);
    assert.equal(got.status, 0, got.stderr);
    assert.match(got.stderr, /NO_CODE_IN_SCOPE: this push changes no file the code audit reads \(recorded at \.audit\/prepush\/[0-9a-f]+\.no-code\.json\)/);
    assert.doesNotMatch(got.stderr, /UNMEASURED/);
    assert.doesNotMatch(got.stderr, /ran clean|code audit: PASS/);
    assert.equal(ran(c), false, 'the audit must not run');
    const rec = JSON.parse(fs.readFileSync(path.join(c.local, KEEP, `${c.tree}.no-code.json`), 'utf8'));
    assert.equal(rec.outcome, 'NO_CODE_IN_SCOPE');
    assert.equal(rec.tree, c.tree);
  }));

  it('a push with no active plan and only a manifest is also NO_CODE_IN_SCOPE (it used to be refused as "no plan selected")', (t) => scenario(t, 'noplan', MANIFEST, ({ c, source }) => {
    const got = runHook(c.local, source, c.stdin);
    assert.equal(got.status, 0, got.stderr);
    assert.match(got.stderr, /NO_CODE_IN_SCOPE/);
    assert.equal(ran(c), false);
  }, 'real', { withPlan: false }));

  it('a code push still audits and says nothing about NO_CODE_IN_SCOPE', (t) => scenario(t, 'code', CODE, ({ c, source }) => {
    const got = runHook(c.local, source, c.stdin);
    assert.equal(got.status, 0, got.stderr);
    assert.equal(ran(c), true);
    assert.doesNotMatch(got.stderr, /NO_CODE_IN_SCOPE:/);
  }));

  it('NEGATIVE: a manifest plus ONE code file audits; so does source in a config dir (shared is context, not an exemption)', (t) => {
    scenario(t, 'mixed', { ...MANIFEST, ...CODE }, ({ c, source }) => { runHook(c.local, source, c.stdin); assert.equal(ran(c), true); });
    scenario(t, 'configsrc', { 'src/config/settings.ts': 'export const s = 1;\n' }, ({ c, source }) => {
      const got = runHook(c.local, source, c.stdin);
      assert.doesNotMatch(got.stderr, /NO_CODE_IN_SCOPE:/);
      assert.equal(ran(c), true, 'config-dir source must reach the audit (which then reads or refuses it exactly as v14 did)');
    });
  });

  for (const [mode, why] of [
    ['old', 'an older source checkout without the subcommand'],
    ['garbage', 'a malformed line'],
    ['norecord', 'a named record that does not exist'],
    ['emptyrecord', 'an empty record'],
    ['rc1', 'the step failing'],
  ]) {
    it(`bypass NOT taken on ${why}: the audit runs as in v14`, (t) => scenario(t, `fb-${mode}`, MANIFEST, ({ c, source }) => {
      const got = runHook(c.local, source, c.stdin);
      assert.equal(ran(c), true, got.stderr);
      assert.doesNotMatch(got.stderr, /NO_CODE_IN_SCOPE:/);
    }, mode));
  }
});

describe('hook v15 - temp ledgers', () => {
  it('removes THIS run\'s ledger by exact path, leaves a concurrent run\'s fresh one, and ages out an old orphan', (t) => scenario(t, 'ledger', CODE, ({ c, source }) => {
    const k = path.join(c.local, KEEP);
    fs.mkdirSync(k, { recursive: true });
    fs.writeFileSync(path.join(k, '.tmp-ledger.LIVE99'), '{}');          // a concurrent invocation's, written just now
    fs.writeFileSync(path.join(k, '.tmp-ledger.OLD000'), '{}');           // an orphan from a killed run
    const old = new Date(Date.now() - 3 * 24 * 3600 * 1000);
    fs.utimesSync(path.join(k, '.tmp-ledger.OLD000'), old, old);
    const got = runHook(c.local, source, c.stdin);
    assert.equal(got.status, 0, got.stderr);
    const left = fs.readdirSync(k).filter((f) => f.startsWith('.tmp-ledger.'));
    assert.deepEqual(left, ['.tmp-ledger.LIVE99'], `own ledger gone, concurrent one kept, old orphan aged out; saw ${left}`);
  }));
});

describe('hook v15 - recurrence', () => {
  it('after a second push on the same lineage, ONE recurrence line is printed and it does not change the outcome', (t) => scenario(t, 'recur', CODE, ({ c, source }) => {
    const first = runHook(c.local, source, c.stdin, { AUDIT_STUB: 'findings' });
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stderr, /recurrence unavailable: no earlier report on this lineage/);
    const second = c.commit({ 'src/own.mjs': 'export const a = 2;\n' }, 'fix');
    const got = runHook(c.local, source, second.stdin, { AUDIT_STUB: 'findings' });
    assert.equal(got.status, 0, got.stderr);
    assert.match(got.stderr, /recurrence vs [0-9a-f]{12}: 1 of 1 finding\(s\) are on files already flagged/);
    assert.equal((got.stderr.match(/recurrence /g) || []).length, 1);
  }));

  it('a later attempt that wrote no report removes the earlier report AND its recurrence sidecar (no orphan is left to be read as current)', (t) => scenario(t, 'recur-orphan', CODE, ({ c, source }) => {
    assert.equal(runHook(c.local, source, c.stdin, { AUDIT_STUB: 'findings' }).status, 0);
    const k = path.join(c.local, KEEP);
    assert.ok(fs.existsSync(path.join(k, `${c.tree}.head`)), 'the sidecar exists beside the report');
    runHook(c.local, source, c.stdin, { AUDIT_STUB: 'nothing' }); // exits 0 with no envelope: UNMEASURED, but the keep step still runs
    assert.equal(fs.existsSync(path.join(k, `${c.tree}.report.json`)), false);
    assert.equal(fs.existsSync(path.join(k, `${c.tree}.head`)), false, 'the sidecar must go with its report');
  }));

  it('an older source checkout (no recurrence subcommand) prints no recurrence line and still audits', (t) => scenario(t, 'recur-old', CODE, ({ c, source }) => {
    const got = runHook(c.local, source, c.stdin);
    assert.equal(got.status, 0, got.stderr);
    assert.doesNotMatch(got.stderr, /recurrence /);
  }, 'old'));
});

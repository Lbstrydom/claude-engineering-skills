/**
 * @fileoverview `/cycle`'s cluster audit runs the argv the scope tool builds, and that argv carries `--base`
 * (upstream dd3e4276).
 *
 * Before the fix SKILL.md hand-assembled the audit command from three JSON fields and never passed `--base`, so an
 * allowlist round stamped no `_diffBase` and the final reviewer could not measure changed lines. The scope tool now
 * builds the whole argv and, under `--audit`, runs it in the same process that computed the scope — so no scope JSON is
 * consumed later and nothing in one can choose what runs (code audit R1-H1/H5/M1). Each assertion of completeness has a
 * control showing the refusal path fires.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { buildClusterAuditArgv, auditExtrasProblem, spawnClusterAudit, AUDIT_CLI, PROTECTED_AUDIT_FLAGS } from '../scripts/cycle-cluster-scope.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const SCOPE_CLI = path.join(REPO_ROOT, 'scripts', 'cycle-cluster-scope.mjs');
const OID = 'a'.repeat(40);

const makeRepo = ({ edit = true } = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cycle-argv-'));
  const g = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
  g(['init', '-q', '.']); g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']);
  fs.mkdirSync(path.join(dir, 's'));
  fs.writeFileSync(path.join(dir, 's', 'keep.mjs'), 'a\n');
  fs.writeFileSync(path.join(dir, 's', 'old.mjs'), 'b\n');
  // As in any consumer: the tool's own patch output is ignored, or a second call reads it as an out-of-scope edit.
  fs.writeFileSync(path.join(dir, '.gitignore'), '.audit/\n');
  g(['add', '-A']); g(['commit', '-qm', 'base']);
  const base = g(['rev-parse', 'HEAD']).trim();
  if (edit) fs.appendFileSync(path.join(dir, 's', 'keep.mjs'), 'edit\n');
  return { dir, base };
};
const cleanup = (dir) => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  fs.rmSync(`${dir}-scope`, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
};
// The scope file sits OUTSIDE the fixture repo (inside, it would be an untracked out-of-scope edit), in a test-owned
// directory that cleanup() removes.
const scopeArgs = (dir, base, scopePaths = ['s/keep.mjs']) => {
  fs.mkdirSync(`${dir}-scope`, { recursive: true });
  const scopeFile = path.join(`${dir}-scope`, 'scope.txt');
  fs.writeFileSync(scopeFile, `${scopePaths.join('\n')}\n`);
  return [SCOPE_CLI, '--base', base, '--scope-file', scopeFile];
};
const runScope = (dir, args) => spawnSync(process.execPath, args, { cwd: dir, encoding: 'utf8' });
const valueOf = (argv, flag) => argv[argv.indexOf(flag) + 1];

describe('cycle-cluster-scope --plan builds the WHOLE audit argv', () => {
  it('the argv carries --base = the resolved base, --files = --changed = the scope, and --diff', () => {
    const { dir, base } = makeRepo();
    try {
      const r = runScope(dir, [...scopeArgs(dir, base), '--plan', 'docs/plans/x.md', '--json']);
      assert.equal(r.status, 0, r.stderr);
      const j = JSON.parse(r.stdout);
      assert.ok(Array.isArray(j.auditArgv), 'auditArgv emitted');
      assert.equal(j.auditArgv[0], AUDIT_CLI);
      assert.deepEqual(j.auditArgv.slice(1, 3), ['code', 'docs/plans/x.md']);
      assert.equal(valueOf(j.auditArgv, '--base'), base);
      assert.equal(j.base, base);
      assert.equal(valueOf(j.auditArgv, '--files'), 's/keep.mjs');
      assert.equal(valueOf(j.auditArgv, '--changed'), valueOf(j.auditArgv, '--files'));
      assert.equal(valueOf(j.auditArgv, '--diff'), j.diffPath);
    } finally { cleanup(dir); }
  });

  it('negative control: without --plan there is no argv, and --audit refuses (exit 2) rather than run a partial command', () => {
    const { dir, base } = makeRepo();
    try {
      const j = JSON.parse(runScope(dir, [...scopeArgs(dir, base), '--json']).stdout);
      assert.equal(j.auditArgv, null);
      const r = runScope(dir, [...scopeArgs(dir, base), '--audit']);
      assert.equal(r.status, 2);
      assert.match(r.stderr, /--audit needs --plan/);
    } finally { cleanup(dir); }
  });

  it('--audit really runs the built argv, and the audit\'s non-zero exit is the caller\'s (no spend)', () => {
    // openai-audit refuses a cwd that is not its own checkout BEFORE any model call (exit 1, naming the expected root), so
    // a fixture repo proves the spawn happened and its code propagated without spending anything.
    const { dir, base } = makeRepo();
    try {
      const r = runScope(dir, [...scopeArgs(dir, base), '--plan', 'p.md', '--audit', '--', '--out', 'o.json']);
      assert.equal(r.status, 1, r.stderr);
      assert.match(r.stderr, /node scripts\/openai-audit\.mjs/, 'the stderr is the AUDIT\'s refusal, so it was spawned');
    } finally { cleanup(dir); }
  });

  it('R2+ extras (--round, --ledger, --out, --passes) pass THROUGH to the audit, not refused by this CLI', () => {
    // assertKnownFlags stops at `--`, so these reach openai-audit, whose own cwd refusal (exit 1) proves the spawn. A
    // rejection by this CLI would be exit 2 naming the flag (final-gate G1 claimed that; this pins it does not happen).
    const { dir, base } = makeRepo();
    try {
      const r = runScope(dir, [...scopeArgs(dir, base), '--plan', 'p.md', '--audit', '--',
        '--round', '2', '--ledger', 'l.json', '--out', 'o.json', '--passes', 'structure']);
      assert.equal(r.status, 1, r.stderr);
      assert.doesNotMatch(r.stderr, /unknown flag/);
      assert.match(r.stderr, /node scripts\/openai-audit\.mjs/);
    } finally { cleanup(dir); }
  });

  it('no-op modes cannot ride in as extras: --help and --selfcheck-relocation after -- exit 2, never a vacuous 0', () => {
    const { dir, base } = makeRepo();
    try {
      for (const noop of ['--help', '-h', '--selfcheck-relocation']) {
        const r = runScope(dir, [...scopeArgs(dir, base), '--plan', 'p.md', '--audit', '--', noop]);
        assert.equal(r.status, 2, `${noop}: ${r.stdout}${r.stderr}`);
        assert.doesNotMatch(r.stdout, /^OK$/m);
      }
      // Control: as a WRAPPER arg the self-check still answers.
      assert.equal(runScope(dir, [SCOPE_CLI, '--selfcheck-relocation']).stdout.trim(), 'OK');
    } finally { cleanup(dir); }
  });

  it('--audit fails closed: an out-of-scope edit exits 1, an empty allowlist exits 1, a protected extra or --json exits 2', () => {
    const { dir, base } = makeRepo();
    try {
      fs.writeFileSync(path.join(dir, 's', 'stray.mjs'), 'x\n');
      const stray = runScope(dir, [...scopeArgs(dir, base), '--plan', 'p.md', '--audit', '--', '--out', 'o.json']);
      assert.equal(stray.status, 1, 'the scope is RECOMPUTED under --audit, so an edit made after an earlier --json fails closed');
      assert.match(stray.stderr, /out-of-scope edit/);
      fs.rmSync(path.join(dir, 's', 'stray.mjs'), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      const protectedExtra = runScope(dir, [...scopeArgs(dir, base), '--plan', 'p.md', '--audit', '--', '--files', 'other.mjs']);
      assert.equal(protectedExtra.status, 2);
      assert.match(protectedExtra.stderr, /--files is decided by the scope tool/);
      assert.equal(runScope(dir, [...scopeArgs(dir, base), '--plan', 'p.md', '--audit', '--json']).status, 2);
    } finally { cleanup(dir); }
    const unchanged = makeRepo({ edit: false });
    try {
      const r = runScope(unchanged.dir, [...scopeArgs(unchanged.dir, unchanged.base), '--plan', 'p.md', '--audit', '--', '--out', 'o.json']);
      assert.equal(r.status, 1, 'nothing to audit must not exit 0 (it would read as audited-and-clean)');
      assert.match(r.stderr, /consolidated gate/);
    } finally { cleanup(unchanged.dir); }
  });
});

describe('buildClusterAuditArgv / auditExtrasProblem / spawnClusterAudit', () => {
  const fields = { plan: 'p.md', files: ['a.mjs', 'b.mjs'], diffPath: '.audit/c.diff', base: OID, allowInfraScopeRequired: true };

  it('a non-sha base, an empty allowlist, no plan or no diff yields no argv', () => {
    assert.equal(buildClusterAuditArgv({ ...fields, base: 'HEAD' }), null);
    assert.equal(buildClusterAuditArgv({ ...fields, files: [] }), null);
    assert.equal(buildClusterAuditArgv({ ...fields, plan: null }), null);
    assert.equal(buildClusterAuditArgv({ ...fields, diffPath: null }), null);
    assert.ok(buildClusterAuditArgv(fields).includes('--allow-infra-scope'));
    assert.ok(!buildClusterAuditArgv({ ...fields, allowInfraScopeRequired: false }).includes('--allow-infra-scope'));
  });

  it('no input field can choose the script (code audit R1-H5)', () => {
    assert.equal(buildClusterAuditArgv({ ...fields, auditCli: 'evil.mjs' })[0], AUDIT_CLI);
  });

  it('every protected flag is refused as an extra, bare or as --flag=value; round flags pass', () => {
    assert.equal(auditExtrasProblem(['--round', '2', '--ledger', 'l.json', '--out', 'o.json']), null);
    for (const f of PROTECTED_AUDIT_FLAGS) {
      assert.ok(auditExtrasProblem([f, 'x']), f);
      assert.ok(auditExtrasProblem([`${f}=x`]), `${f}=`);
    }
  });

  it('the audit\'s exit code is the caller\'s: 0, 3, 4 propagate; a signal-killed or unstartable child is 1', () => {
    const argv = buildClusterAuditArgv(fields);
    for (const status of [0, 3, 4]) {
      let seen = null;
      assert.equal(spawnClusterAudit(argv, { spawn: (exe, a) => { seen = { exe, a }; return { status }; } }), status);
      assert.equal(seen.exe, process.execPath);
      assert.deepEqual(seen.a, argv);
    }
    assert.equal(spawnClusterAudit(argv, { spawn: () => ({ status: null, signal: 'SIGTERM' }) }), 1);
    assert.equal(spawnClusterAudit(argv, { spawn: () => ({ error: new Error('ENOENT') }) }), 1);
  });
});

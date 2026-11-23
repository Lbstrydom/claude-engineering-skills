/**
 * `help:readonly:gate` — `--help` must be a pure read on every CLI.
 *
 * Positive controls first (a gate is not trustworthy until seen to fail): the
 * probe must flag a CLI whose `--help` writes, reaches the network or spawns a
 * mutating process, and must NOT flag a clean one.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { helpGuardEntry, usageFromSource, wantsHelp } from '../scripts/lib/help-guard.mjs';
import { probeHelp } from '../scripts/lib/help-probe/probe.mjs';
import {
  hasHelpContract, offenderIds, listEntryPoints, listSubcommandProbes, withHandledFinding,
} from '../scripts/check-help-readonly.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
let dir;
before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'help-ro-')); });
after(() => { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

function fixture(name, body) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, body);
  return p;
}

describe('probeHelp — the instrument sees what a CLI ignoring --help does', () => {
  it('flags an fs write, and BLOCKS it (nothing lands on disk)', async () => {
    const target = path.join(dir, 'should-not-exist.txt');
    const f = fixture('writer.mjs', `import fs from 'node:fs'; try { fs.writeFileSync(${JSON.stringify(target)}, 'x'); } catch {}`);
    const r = await probeHelp(f, { cwd: dir });
    assert.deepEqual(r.kinds, ['fs-write']);
    assert.equal(fs.existsSync(target), false, 'the write must be blocked, not merely recorded');
  });

  it('flags a named-import write (the bare-bootstrap shape: copyFileSync/mkdirSync)', async () => {
    const f = fixture('named.mjs', `import { mkdirSync, copyFileSync } from 'node:fs'; try { mkdirSync(${JSON.stringify(path.join(dir, 'd'))}); } catch {} try { copyFileSync('a','b'); } catch {}`);
    const r = await probeHelp(f, { cwd: dir });
    assert.deepEqual(r.kinds, ['fs-write']);
    assert.ok(r.violations.length >= 2);
  });

  it('flags network and a non-read-only spawn', async () => {
    const f = fixture('net.mjs', `import { execSync } from 'node:child_process';
      try { await fetch('http://example.invalid/'); } catch {}
      try { execSync('git push origin main'); } catch {}`);
    const r = await probeHelp(f, { cwd: dir });
    assert.deepEqual(r.kinds, ['network', 'spawn']);
  });

  it('negative control: a CLI that only reads and prints is clean, and read-only git is allowed', async () => {
    const f = fixture('clean.mjs', `import fs from 'node:fs'; import { execFileSync } from 'node:child_process';
      fs.readFileSync(${JSON.stringify(fileURLSafe(import.meta.filename))}); execFileSync('git', ['rev-parse', '--show-toplevel']); console.log('usage');`);
    const r = await probeHelp(f, { cwd: ROOT });
    assert.deepEqual(r.kinds, []);
  });
});

function fileURLSafe(p) { return p; }

describe('static contract — the hole as it actually was', () => {
  it('a CLI with neither --help nor unknown-flag refusal has no contract (the arch-intent-bootstrap shape)', () => {
    assert.equal(hasHelpContract("const flags = new Set(process.argv.slice(2));\nawait copyTemplate();"), false);
  });
  it('--help handling or assertKnownFlags each satisfy it', () => {
    assert.equal(hasHelpContract("if (argv.includes('--help')) usage();"), true);
    assert.equal(hasHelpContract("assertKnownFlags(process.argv, KNOWN, { cli: 'x' });"), true);
  });
});

describe('arch-intent-bootstrap --help (field report 2026-11-21: --help ran the bootstrap)', () => {
  it('prints usage, exits 0, and attempts NO write/network/spawn', async () => {
    const script = path.join(ROOT, 'scripts', 'arch-intent-bootstrap.mjs');
    const r = await probeHelp(script, { cwd: ROOT });
    assert.deepEqual(r.violations, []);
    const out = spawnSync(process.execPath, [script, '--help'], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(out.status, 0);
    assert.match(out.stdout, /usage: node scripts\/arch-intent-bootstrap\.mjs/);
    assert.doesNotMatch(out.stdout, /Bootstrap starting/);
  });

  it('refuses an unknown flag with exit 2 instead of running', () => {
    const script = path.join(ROOT, 'scripts', 'arch-intent-bootstrap.mjs');
    const out = spawnSync(process.execPath, [script, '--bogus'], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(out.status, 2);
    assert.match(out.stderr, /unknown flag "--bogus"/);
    assert.doesNotMatch(out.stdout, /Bootstrap starting/);
  });
});

// Contract id for scripts/gate-contracts/help-readonly-gate.json (a contract may only claim a
// test file that names its gate id): help-readonly-gate-rejects-a-cli-that-runs-on-help.
describe('census', () => {
  it('a hang IS an offender: a CLI that never exited was not shown read-only', () => {
    assert.deepEqual(offenderIds([
      { file: 'a.mjs', kinds: ['no-help-contract'] },
      { file: 'b.mjs', kinds: ['hang', 'fs-write'] },
    ]), ['a.mjs::no-help-contract', 'b.mjs::fs-write', 'b.mjs::hang']);
  });
  it('every nested non-lib CLI is covered, derived from the filesystem', () => {
    const files = listEntryPoints(ROOT, []).map((p) => path.relative(path.join(ROOT, 'scripts'), p).split(path.sep).join('/'));
    assert.ok(files.includes('symbol-index/embed.mjs'));
    assert.ok(files.includes('postgres-parity/generate-expected-schema.mjs'));
    assert.ok(!files.some((f) => f.startsWith('lib/')), 'lib/ is only reached through CLI_SMOKE_SET');
  });
  it('the entry-point list is derived from the filesystem, plus nested smoke-set CLIs', () => {
    const files = listEntryPoints(ROOT, ['symbol-index/drift.mjs', 'check-setup.mjs']).map((p) => path.relative(path.join(ROOT, 'scripts'), p).split(path.sep).join('/'));
    assert.ok(files.includes('arch-intent-bootstrap.mjs'));
    assert.ok(files.includes('symbol-index/drift.mjs'));
    assert.ok(!files.includes('shared.mjs'), 'exempt barrel');
  });
  it('THE GATE: every CLI in this repo is read-only on --help (no baseline)', () => {
    const out = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'check-help-readonly.mjs'), '--json'], { cwd: ROOT, encoding: 'utf8', timeout: 240000 });
    const j = JSON.parse(out.stdout);
    assert.deepEqual(j.offenders, []);
    assert.equal(out.status, 0);
  });
});

describe('help-guard — usage comes from the CLI own header', () => {
  it('prints the Usage block, exits 0, and is skipped after a -- terminator', () => {
    const src = ['/**', ' * @fileoverview x', ' *', ' * Usage:', ' *   node scripts/x.mjs a   # does a', ' *   node scripts/x.mjs b', ' *', ' * Exit codes:', ' *   0 ok', ' */', ''].join('\n');
    const text = usageFromSource(src, 'x.mjs');
    assert.match(text, /node scripts\/x\.mjs a/);
    assert.doesNotMatch(text, /Exit codes/);
    assert.equal(wantsHelp(['--help']), true);
    assert.equal(wantsHelp(['run', '--', '--help']), false);
  });
  it('helpGuardEntry prints and exits only when --help is present', () => {
    const outs = []; let code = null;
    const script = path.join(ROOT, 'scripts', 'anthropic-ping.mjs');
    assert.equal(helpGuardEntry({ argv: ['node', script, '--bogus'], out: (s) => outs.push(s), exit: (c) => { code = c; } }), false);
    assert.equal(code, null);
    assert.equal(helpGuardEntry({ argv: ['node', script, '--help'], out: (s) => outs.push(s), exit: (c) => { code = c; } }), true);
    assert.equal(code, 0);
    assert.match(outs[0], /anthropic:ping/);
  });

  it('an entry that did NOT opt in is never intercepted (a guarded LIBRARY must not swallow its importer --help)', () => {
    // arch-intent-bootstrap handles --help itself and does not import the guard.
    const outs = []; let code = null;
    const script = path.join(ROOT, 'scripts', 'arch-intent-bootstrap.mjs');
    assert.equal(helpGuardEntry({ argv: ['node', script, '--help'], out: (s) => outs.push(s), exit: (c) => { code = c; } }), false);
    assert.equal(code, null);
    assert.deepEqual(outs, []);
  });

  it('a header with no Usage: block prints the whole header, not one paragraph', () => {
    const src = ['/**', ' * @fileoverview first paragraph', ' *', ' * second paragraph with a --flag', ' *', ' * @module x', ' */', ''].join('\n');
    const text = usageFromSource(src, 'x.mjs');
    assert.match(text, /first paragraph/);
    assert.match(text, /second paragraph with a --flag/);
  });
});

describe('probe instrument gaps from the code audit', () => {
  it('blocks promise-form and numeric-flag opens, dns.resolve and dgram', async () => {
    const f = fixture('gaps.mjs', `import fs from 'node:fs'; import fsp from 'node:fs/promises'; import dns from 'node:dns'; import dgram from 'node:dgram';
      try { await fsp.open(${JSON.stringify(path.join(dir, 'p1'))}, 'w'); } catch {}
      try { fs.openSync(${JSON.stringify(path.join(dir, 'p2'))}, fs.constants.O_WRONLY | fs.constants.O_CREAT); } catch {}
      try { dns.resolve4('example.invalid', () => {}); } catch {}
      try { dgram.createSocket('udp4').send('x', 9, '127.0.0.1'); } catch {}`);
    const r = await probeHelp(f, { cwd: dir });
    assert.deepEqual(r.kinds, ['fs-write', 'network']);
    assert.equal(fs.existsSync(path.join(dir, 'p1')), false);
    assert.equal(fs.existsSync(path.join(dir, 'p2')), false);
    assert.ok(r.violations.length >= 4, `saw ${r.violations.map((v) => v.detail).join(' | ')}`);
  });

  it('blocks shell-chained exec, a mutating `git branch <name>`, fd-based writes, and an env-stripped node child', async () => {
    const f = fixture('spawns.mjs', `import cp from 'node:child_process'; import fs from 'node:fs';
      try { cp.execSync('git status && echo hi'); } catch {}
      try { cp.execFileSync('git', ['branch', 'new-branch-xyz']); } catch {}
      try { const fd = fs.openSync(${JSON.stringify(import.meta.filename)}, 'r'); fs.fchmodSync(fd, 0o600); } catch {}
      try { cp.execFileSync(process.execPath, ['-e', "require('node:fs').writeFileSync(" + ${JSON.stringify(JSON.stringify(path.join(dir, 'child-wrote.txt')))} + ", 'x')"], { env: {} }); } catch {}`);
    const r = await probeHelp(f, { cwd: dir });
    assert.ok(r.kinds.includes('spawn') && r.kinds.includes('fs-write'), r.kinds.join(','));
    const details = r.violations.map((v) => v.detail).join(' | ');
    assert.match(details, /git status && echo hi/);
    assert.match(details, /git branch new-branch-xyz/);
    assert.match(details, /fchmodSync/);
    assert.equal(fs.existsSync(path.join(dir, 'child-wrote.txt')), false, 'the env-stripped child must still be instrumented');
  });

  it('blocks `git diff --output=<file>` and dns.promises.lookup/resolveMx; allows fork of a module', async () => {
    const f = fixture('more.mjs', `import cp from 'node:child_process'; import dns from 'node:dns';
      try { cp.execFileSync('git', ['diff', '--output=' + ${JSON.stringify(path.join(dir, 'diff-out.txt'))}]); } catch {}
      try { await dns.promises.lookup('example.invalid'); } catch {}
      try { await dns.promises.resolveMx('example.invalid'); } catch {}`);
    const r = await probeHelp(f, { cwd: ROOT });
    assert.deepEqual(r.kinds, ['network', 'spawn']);
    const details = r.violations.map((v) => v.detail).join(' | ');
    assert.match(details, /--output=/);
    assert.match(details, /dns\.promises\.lookup/);
    assert.match(details, /resolveMx/);
    assert.equal(fs.existsSync(path.join(dir, 'diff-out.txt')), false);
    const w = fixture('worker.mjs', 'process.exit(0);');
    const forker = fixture('forker.mjs', `import cp from 'node:child_process'; cp.fork(${JSON.stringify(w)}).on('exit', () => {});`);
    assert.deepEqual((await probeHelp(forker, { cwd: dir })).kinds, []);
  });

  it('an ambient NODE_OPTIONS is preserved (appended to, not replaced), and a child with its own NODE_OPTIONS keeps it', async () => {
    const f = fixture('nodeopts.mjs', `import cp from 'node:child_process';
      const out = cp.execFileSync(process.execPath, ['-p', 'process.env.NODE_OPTIONS'], { env: { NODE_OPTIONS: '--no-warnings' }, encoding: 'utf8' });
      if (!out.includes('--no-warnings') || !out.includes('preload.mjs')) { try { (await import('node:fs')).writeFileSync('x', 'bad'); } catch {} }`);
    const r = await probeHelp(f, { cwd: dir });
    assert.deepEqual(r.kinds, [], r.violations.map((v) => v.detail).join(' | '));
    const prev = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = '--no-warnings';
    try {
      // the probe child must see the ambient option AND the preload; a missing one makes it attempt a (blocked, recorded) write
      const h = fixture('ambient2.mjs', `if (!process.env.NODE_OPTIONS.includes('--no-warnings') || !process.env.NODE_OPTIONS.includes('preload.mjs')) { try { (await import('node:fs')).writeFileSync('x', 'bad'); } catch {} }`);
      assert.deepEqual((await probeHelp(h, { cwd: dir })).kinds, []);
    } finally {
      if (prev === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = prev;
    }
  });

  it('read-only git forms and stdout fd writes are allowed (negative control)', async () => {
    const f = fixture('allowed.mjs', `import cp from 'node:child_process'; import fs from 'node:fs';
      cp.execFileSync('git', ['-C', ${JSON.stringify(ROOT)}, 'rev-parse', '--show-toplevel']);
      cp.execFileSync('git', ['branch', '--show-current'], { cwd: ${JSON.stringify(ROOT)} });
      fs.writeSync(1, 'ok\\n');`);
    assert.deepEqual((await probeHelp(f, { cwd: ROOT })).kinds, []);
  });

  it('a read-only numeric open is NOT flagged (negative control)', async () => {
    const f = fixture('ro.mjs', `import fs from 'node:fs'; fs.closeSync(fs.openSync(${JSON.stringify(import.meta.filename)}, fs.constants.O_RDONLY));`);
    assert.deepEqual((await probeHelp(f, { cwd: dir })).kinds, []);
  });

  it('a CLI that cannot be spawned is a finding, never a clean result', async () => {
    const r = await probeHelp(path.join(dir, 'does-not-exist.mjs'), { cwd: path.join(dir, 'no-such-cwd') });
    assert.deepEqual(r.kinds, ['probe-error']);
  });
});

describe('static contract — comments do not count', () => {
  it('a --help mentioned only in a comment or docstring is no contract', () => {
    assert.equal(hasHelpContract('/** Usage: node x.mjs --help */\n// handles --help later\nawait main();'), false);
    assert.equal(hasHelpContract("if (process.argv.includes('--help')) usage();"), true);
  });
});

// Contract id: help-readonly-gate-rejects-a-cli-that-runs-on-help (subcommand half).
describe('cross-skill subcommand --help (2026-11-23: `ledger mint --help` minted a work item)', () => {
  it('subcommand probes are derived from the registry, verbs included', () => {
    const labels = listSubcommandProbes(ROOT).map((p) => p.label);
    assert.ok(labels.includes('cross-skill.mjs ledger mint'), 'the field-report command must be probed');
    assert.ok(labels.includes('cross-skill.mjs whoami'));
  });
  it('positive control: a result-printing run is flagged, a Usage block is not', () => {
    const bad = withHandledFinding({ file: 'x', kinds: [], violations: [], exitCode: 0, stdout: '{"ok":true,"work_item_id":"01a"}' });
    assert.deepEqual(bad.kinds, ['help-not-handled']);
    const good = withHandledFinding({ file: 'x', kinds: [], violations: [], exitCode: 0, stdout: 'Usage: node scripts/cross-skill.mjs ledger\n' });
    assert.deepEqual(good.kinds, []);
    const nonzero = withHandledFinding({ file: 'x', kinds: [], violations: [], exitCode: 2, stdout: 'Usage: x' });
    assert.deepEqual(nonzero.kinds, ['help-not-handled']);
  });
  it('the gate rejects a usage line followed by a command result (whole stdout must be usage)', () => {
    const r = withHandledFinding({ file: 'x', kinds: [], violations: [], exitCode: 0, stdout: 'Usage: node scripts/cross-skill.mjs ledger\n{"ok":true,"work_item_id":"01a"}\n' });
    assert.deepEqual(r.kinds, ['help-not-handled']);
    const ok = withHandledFinding({ file: 'x', kinds: [], violations: [], exitCode: 0, stdout: 'Usage: node scripts/cross-skill.mjs ledger [mint]\nFlags:\n  --kind <value>\n  --json\n' });
    assert.deepEqual(ok.kinds, []);
  });
  it('probe flags stdout beyond the capture cap, and the gate refuses a truncated capture', async () => {
    const { STDOUT_CAP } = await import('../scripts/lib/help-probe/probe.mjs');
    const f = fixture('big.mjs', `process.stdout.write('Usage: x\\n'.padEnd(${STDOUT_CAP}, ' ')); setTimeout(() => process.stdout.write('{"ok":true}\\n'), 50);`);
    const r = await probeHelp(f, { cwd: dir, captureStdout: true });
    assert.equal(r.stdoutTruncated, true);
    assert.deepEqual(withHandledFinding({ ...r, exitCode: 0, stdout: 'Usage: x\n' }).kinds, ['help-not-handled']);
    const small = fixture('small.mjs', "process.stdout.write('Usage: x\\n');");
    assert.equal((await probeHelp(small, { cwd: dir, captureStdout: true })).stdoutTruncated, false);
  });
  it('helpRequested: a flag, not a valued flag value, not after `--`', async () => {
    const { helpRequested } = await import('../scripts/lib/cross-skill/dispatch.mjs');
    const decls = [{ name: 'note', kind: 'valued' }, { name: 'dry-run', kind: 'boolean' }];
    assert.equal(helpRequested(['mint', '--help'], decls), true);
    assert.equal(helpRequested(['--dry-run', '--help'], decls), true);
    assert.equal(helpRequested(['--note', '--help'], decls), false, 'a valued flag VALUE is data');
    assert.equal(helpRequested(['--json', '--help'], decls), false, '--json value is data');
    assert.equal(helpRequested(['a', '--', '--help'], decls), false);
    // Pinned: a valued flag swallows `--` as its value (same as findPositionals); resolves toward help, never toward running.
    assert.equal(helpRequested(['--note', '--', '--help'], decls), true);
  });
  it('dispatch --help never touches the store port, for EVERY registry command and verb', async () => {
    const { dispatch } = await import('../scripts/lib/cross-skill/dispatch.mjs');
    const poisoned = new Proxy({}, { get(_t, k) { throw new Error(`store port touched on --help: ${String(k)}`); } });
    const out = process.stdout.write.bind(process.stdout);
    let wrote = '';
    process.stdout.write = (c) => { wrote += c; return true; };
    try {
      for (const p of listSubcommandProbes(ROOT)) {
        wrote = '';
        const r = await dispatch(['node', 'cross-skill.mjs', ...p.args], { deps: poisoned });
        assert.equal(r.exitCode, 0, p.label);
        assert.equal(r.envelope, null, p.label);
        assert.match(wrote, /^Usage: node scripts\/cross-skill\.mjs /, p.label);
      }
    } finally { process.stdout.write = out; }
  });
  it('--only <script> selects the script AND its subcommand probes', () => {
    const out = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'check-help-readonly.mjs'), '--only', 'cross-skill.mjs', '--json'], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
    const j = JSON.parse(out.stdout);
    assert.ok(j.probed > 1, `probed ${j.probed}`);
    assert.equal(out.status, 0);
  });
  it('ledger mint --help prints usage and mints nothing', () => {
    const out = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'cross-skill.mjs'), 'ledger', 'mint', '--help'], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(out.status, 0);
    assert.match(out.stdout, /^Usage: node scripts\/cross-skill\.mjs ledger/);
    assert.doesNotMatch(out.stdout, /work_item_id/);
  });
});

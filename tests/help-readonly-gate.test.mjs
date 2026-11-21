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
  hasHelpContract, offenderIds, listEntryPoints,
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

describe('census', () => {
  it('a hang is reported but never gated identity (load-dependent)', () => {
    assert.deepEqual(offenderIds([
      { file: 'a.mjs', kinds: ['no-help-contract'] },
      { file: 'b.mjs', kinds: ['hang', 'fs-write'] },
    ]), ['a.mjs::no-help-contract', 'b.mjs::fs-write']);
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
    const script = path.join(ROOT, 'scripts', 'arch-intent-bootstrap.mjs');
    assert.equal(helpGuardEntry({ argv: ['node', script, '--bogus'], out: (s) => outs.push(s), exit: (c) => { code = c; } }), false);
    assert.equal(code, null);
    assert.equal(helpGuardEntry({ argv: ['node', script, '--help'], out: (s) => outs.push(s), exit: (c) => { code = c; } }), true);
    assert.equal(code, 0);
    assert.match(outs[0], /arch-intent-bootstrap/);
  });
});

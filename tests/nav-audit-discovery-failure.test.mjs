/**
 * @fileoverview Regression test for the discovery-failure fail-open bug: the
 * catch wrapping listSourceFiles()/gitChangedFiles() in scripts/nav-audit.mjs
 * used to swallow ANY discovery error and let the run continue with an empty
 * source set — its own comment scoped that leniency to live-only modes
 * (--verify, --bootstrap --from-url) but the catch applied unconditionally,
 * so a static or --gate invocation (deterministic CI gates) could read a
 * real discovery failure as "nothing to report" instead of "couldn't check".
 * Spawns the real nav-audit.mjs against a directory that is NOT a git repo,
 * so `git -C <root> ls-files ...` fails exactly like a real discovery error.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/nav-audit.mjs');
let dir;

function run(args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf-8' });
}

beforeEach(() => {
  // Deliberately NOT a git repo — `git -C dir ls-files ...` fails, reproducing
  // a real discovery error without needing to mock execFileSync.
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nav-audit-discovery-'));
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

describe('nav-audit discovery failure — static/--gate must not read as clean', () => {
  it('default static mode fails loudly (exit 2), not a clean/empty result', () => {
    const r = run([]);
    assert.equal(r.status, 2, `expected exit 2 on discovery failure, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /source\/git discovery failed/);
    assert.doesNotMatch(r.stdout, /GATE PASS/);
  });

  it('--gate mode fails loudly (exit 2), never GATE PASS / exit 0', () => {
    const r = run(['--gate']);
    assert.equal(r.status, 2, `a discovery failure under --gate must not silently pass\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /source\/git discovery failed/);
    assert.doesNotMatch(r.stderr, /GATE PASS/);
  });

  it('plain --bootstrap (no --from-url) also fails loudly — it still needs local source', () => {
    const r = run(['--bootstrap']);
    assert.equal(r.status, 2, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /source\/git discovery failed/);
  });
});

/**
 * @fileoverview Theme-safety CLI integration (audit L1/M8 — the risky wiring seam):
 * static-mode advisory output, the unchanged --gate refusal, and malformed-source
 * tolerance. Spawns the real visual-audit.mjs against a temp fixture (no browser).
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/visual-audit.mjs');
let dir;

const CONTRACT = JSON.stringify({
  version: 1,
  surfaces: [{ id: 'app', selector: 'body', sourceGlobs: ['src/**'] }],
  tokenSources: [{ path: 'src/app.css', type: 'css-vars' }],
  globalStyleGlobs: [],
  themes: [],
});

function run(args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf-8' });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-cli-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'visual-contract.json'), CONTRACT);
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('visual-audit theme-safety CLI', () => {
  it('static mode emits the advisory lint finding (exit 0)', () => {
    fs.writeFileSync(path.join(dir, 'src/app.css'), 'button.danger { background:#b00; border:1px solid #333; }\nbutton.ok { background:#fff; color:#333; }');
    const r = run([]);
    assert.equal(r.status, 0);
    assert.match(r.stdout + r.stderr, /interactive_color_unset|Theme-safety lint/);
    assert.match(r.stdout + r.stderr, /button\.danger/);
    assert.doesNotMatch(r.stdout + r.stderr, /button\.ok/, 'a control that sets color is not flagged');
  });

  it('static --gate STILL exits 2 (the paint-gate refusal is unchanged — decision 7)', () => {
    fs.writeFileSync(path.join(dir, 'src/app.css'), 'button { background:#b00; }');
    const r = run(['--gate']);
    assert.equal(r.status, 2, 'advisory static findings do not flip the paint gate');
  });

  it('a malformed/unreadable style source does not crash the static run', () => {
    // contract points at a file that does not exist → readStyleSources skips it
    fs.writeFileSync(path.join(dir, 'visual-contract.json'), JSON.stringify({
      version: 1, surfaces: [{ id: 'app', selector: 'body', sourceGlobs: ['src/**'] }],
      tokenSources: [{ path: 'src/missing.css', type: 'css-vars' }], globalStyleGlobs: [], themes: [],
    }));
    const r = run([]);
    assert.equal(r.status, 0, 'unreadable source → skipped, not a crash');
  });
});

/**
 * @fileoverview The pilot instrument is FROZEN (verification-lessons Phase 5 redesign): the sha256 of the checklist, the matcher and
 * the scoring code are pinned constants, and a confirmation run refuses to start if any differs. Editing one of the three is
 * allowed but ends the freeze: update `frozen.mjs` and the pilot doc's Freeze section together, and start a new confirmation window.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { FROZEN, verifyFrozen } from '../scripts/lib/checklist/frozen.mjs';

const REPO = path.resolve(import.meta.dirname, '..');
const TMP = [];
after(() => { for (const d of TMP) fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

test('the repo is at the frozen instrument (checklist, matcher, scoring code)', () => {
  const v = verifyFrozen(REPO);
  assert.deepEqual(v.mismatches, [], `the freeze moved: ${JSON.stringify(v.mismatches)}`);
  assert.equal(v.ok, true);
});

test('the pinned doc section names the same three hashes', () => {
  const doc = fs.readFileSync(path.join(REPO, 'docs', 'research', 'checklist-pilot-2026-11.md'), 'utf8');
  for (const { sha256 } of Object.values(FROZEN.files)) assert.ok(doc.includes(sha256), `the doc does not record ${sha256}`);
});

test('the instrument is seen to fail: a one-byte change to any of the three is reported, and --confirmation refuses to run', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'checklist-frozen-'));
  TMP.push(tmp);
  for (const { path: rel } of Object.values(FROZEN.files)) {
    fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
    fs.copyFileSync(path.join(REPO, rel), path.join(tmp, rel));
  }
  assert.equal(verifyFrozen(tmp).ok, true, 'control: an untouched copy verifies');
  for (const [name, { path: rel }] of Object.entries(FROZEN.files)) {
    const abs = path.join(tmp, rel);
    const original = fs.readFileSync(abs, 'utf8');
    fs.writeFileSync(abs, `${original} `);
    const v = verifyFrozen(tmp);
    assert.deepEqual(v.mismatches.map((m) => m.name), [name]);
    fs.writeFileSync(abs, original);
  }
  fs.appendFileSync(path.join(tmp, FROZEN.files.matcher.path), '\n// moved after the freeze\n');
  const cli = path.join(REPO, 'scripts', 'checklist-pilot.mjs');
  const r = spawnSync(process.execPath, [cli, '--replay', '--confirmation', '--tip', 'HEAD', '--out-dir', path.join(tmp, 'o')], { cwd: tmp, encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /refused: the instrument is not the frozen one \(matcher differ/);
});

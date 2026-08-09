/**
 * @fileoverview Gate 2C — orphaned tooling in the consumer isolation dir.
 *
 * THE BLIND SPOT THIS LOCKS (upstream 167084b3, filed from a consumer
 * 2026-08-04). Gate 2B walks `manifest.files` and asks "is each entry on disk
 * with the right hash?". A file on disk that NO manifest entry claims is never
 * iterated, so it can be neither `missing` nor `mismatched` — invisible by
 * construction. The reporting consumer held 531 files in
 * `scripts/.claude-skills/` against 431 manifest entries: 100 orphans, frozen
 * at whatever version they last shipped, still executable and still on
 * documented command paths, while the bundle stamp read current.
 *
 * The set difference is the whole gate, so the tests that matter are: an orphan
 * is FOUND (2C), and 2B still cannot find it (proving the two directions are
 * genuinely different and 2C is not redundant).
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { _internals } from '../scripts/lib/sync-isolation-verify.mjs';
import { LAYOUT_CONSTANTS } from '../scripts/lib/sync-path-map.mjs';
import { hashFile } from '../scripts/lib/sync-manifest.mjs';

const { gate2B, gate2C } = _internals;
const TOOL_DIR = LAYOUT_CONSTANTS.CONSUMER_TOOLING_DIR;

let root;
const write = (rel, body) => {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  return abs;
};

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'iso-orphan-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

/** A manifest claiming exactly the files given. */
function manifestFor(rels) {
  const files = {};
  for (const rel of rels) files[rel] = hashFile(path.join(root, rel));
  return { files };
}

describe('gate 2C — disk → manifest orphan detection', () => {
  it('FINDS a file the manifest does not claim', () => {
    write(`${TOOL_DIR}/claimed.mjs`, 'export const a = 1;\n');
    const manifest = manifestFor([`${TOOL_DIR}/claimed.mjs`]);
    write(`${TOOL_DIR}/orphan.mjs`, 'export const b = 2;\n');

    const res = gate2C(root, manifest);
    assert.equal(res.pass, false);
    assert.match(res.error, /1 orphaned file/);
    assert.deepEqual(res.details.orphans, [`${TOOL_DIR}/orphan.mjs`]);
  });

  it('gate 2B is BLIND to that same orphan (the two directions differ)', () => {
    // Without this, 2C could be redundant and nobody would know.
    write(`${TOOL_DIR}/claimed.mjs`, 'export const a = 1;\n');
    const manifest = manifestFor([`${TOOL_DIR}/claimed.mjs`]);
    write(`${TOOL_DIR}/orphan.mjs`, 'export const b = 2;\n');

    assert.equal(gate2B(root, manifest).pass, true,
      'gate 2B must still pass — it iterates the manifest, so it cannot see an unclaimed file');
  });

  it('finds orphans nested at depth', () => {
    write(`${TOOL_DIR}/claimed.mjs`, 'x\n');
    const manifest = manifestFor([`${TOOL_DIR}/claimed.mjs`]);
    write(`${TOOL_DIR}/lib/deep/stale.mjs`, 'y\n');

    const res = gate2C(root, manifest);
    assert.equal(res.pass, false);
    assert.deepEqual(res.details.orphans, [`${TOOL_DIR}/lib/deep/stale.mjs`]);
  });

  it('PASSES when every file on disk is claimed (no false positive)', () => {
    write(`${TOOL_DIR}/a.mjs`, '1\n');
    write(`${TOOL_DIR}/lib/b.mjs`, '2\n');
    const manifest = manifestFor([`${TOOL_DIR}/a.mjs`, `${TOOL_DIR}/lib/b.mjs`]);

    assert.equal(gate2C(root, manifest).pass, true);
  });

  it('ignores files OUTSIDE the isolated tooling dir', () => {
    // The manifest also governs .claude/skills/ etc., but those hold
    // consumer-owned files too — reverse-walking them would report the
    // consumer's own work as orphaned and earn the gate a bypass.
    write(`${TOOL_DIR}/a.mjs`, '1\n');
    const manifest = manifestFor([`${TOOL_DIR}/a.mjs`]);
    write('.claude/skills/my-own-skill/SKILL.md', '# mine\n');

    assert.equal(gate2C(root, manifest).pass, true);
  });

  it('does not report the manifest itself as an orphan', () => {
    // It cannot record its own hash, so 2B carves it out; 2C must match.
    write(`${TOOL_DIR}/a.mjs`, '1\n');
    const manifest = manifestFor([`${TOOL_DIR}/a.mjs`]);
    write(LAYOUT_CONSTANTS.MANIFEST_PATH, '{}\n');

    assert.equal(gate2C(root, manifest).pass, true);
  });

  it('passes when the tooling dir does not exist at all', () => {
    assert.equal(gate2C(root, { files: {} }).pass, true);
  });
});

describe('gate 2C — declared non-manifest files', () => {
  it('does not report the ownership watermark as an orphan', () => {
  // The watermark is DECLARED never-in-the-manifest (sync-path-map.mjs). Without
  // a carve-out, 2C fails on every correctly-synced consumer — measured on both
  // on 2026-08-09, one orphan each, this file. A gate that cannot be satisfied by
  // doing the work correctly is the shape that earns --no-verify.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gate2c-watermark-'));
  const toolDir = path.join(root, LAYOUT_CONSTANTS.CONSUMER_TOOLING_DIR);
  fs.mkdirSync(toolDir, { recursive: true });
  fs.writeFileSync(path.join(root, LAYOUT_CONSTANTS.OWNERSHIP_WATERMARK), '{"owner":"x"}');
  fs.writeFileSync(path.join(toolDir, 'claimed.mjs'), '// claimed');

  const manifest = { files: { [`${LAYOUT_CONSTANTS.CONSUMER_TOOLING_DIR}/claimed.mjs`]: { sha256: 'x' } } };
  const r = _internals.gate2C(root, manifest);
  assert.equal(r.pass, true, `watermark reported as an orphan: ${JSON.stringify(r)}`);

  // Negative control: a genuine orphan IS still caught, so the carve-out did not
  // blunt the gate.
  fs.writeFileSync(path.join(toolDir, 'stowaway.mjs'), '// not in the manifest');
  const r2 = _internals.gate2C(root, manifest);
  assert.equal(r2.pass, false, 'a real orphan must still fail the gate');
  assert.ok(JSON.stringify(r2).includes('stowaway.mjs'));

  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});
});

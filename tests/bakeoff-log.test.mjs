/**
 * @fileoverview `readLog` — mid-file corruption is surfaced, not silently
 * dropped (consolidated-gate finding, round-4/5 H23, plan:
 * comparison-tooling-consolidation.md).
 *
 * @module tests/bakeoff-log
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readLog } from '../scripts/lib/bakeoff/log.mjs';

const dirs = [];
after(() => {
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best effort */ } }
});

function writeLog(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bakeoff-log-'));
  dirs.push(dir);
  const p = path.join(dir, 'bakeoff-log.jsonl');
  fs.writeFileSync(p, lines.join('\n'));
  return p;
}

describe('readLog — torn-final-line tolerance vs. mid-file corruption', () => {
  it('a torn FINAL line is silently tolerated — no stderr, prior snapshots survive', () => {
    const p = writeLog([
      JSON.stringify({ snapshotId: 'a', x: 1 }),
      JSON.stringify({ snapshotId: 'b', x: 2 }),
      '{"snapshotId": "c", "truncated_mid_wri', // torn — crash mid-write
    ]);
    const entries = readLog(p);
    assert.deepEqual(entries.map((e) => e.snapshotId).sort(), ['a', 'b']);
  });

  it('a corrupt MIDDLE line is surfaced on stderr, not silently dropped (round-4/5 H23)', () => {
    const p = writeLog([
      JSON.stringify({ snapshotId: 'a', x: 1 }),
      '{"snapshotId": "corrupted-middle", not valid json at all',
      JSON.stringify({ snapshotId: 'c', x: 3 }),
    ]);
    const originalWrite = process.stderr.write;
    const captured = [];
    process.stderr.write = (chunk) => { captured.push(String(chunk)); return true; };
    let entries;
    try {
      entries = readLog(p);
    } finally {
      process.stderr.write = originalWrite;
    }
    // The corrupt line is still excluded from the returned entries (it
    // cannot be parsed, so there is nothing to include) — the FIX is that
    // its loss is now VISIBLE, not that it magically becomes readable.
    assert.deepEqual(entries.map((e) => e.snapshotId).sort(), ['a', 'c']);
    assert.ok(captured.some((line) => /corrupt line/.test(line)), 'a mid-file corruption must write a visible warning');
    assert.ok(captured.some((line) => /not the final line/.test(line)), 'the warning must distinguish this from the tolerated torn-final-line case');
  });

  it('negative control — the torn-final-line tolerance still works when the ONLY line is torn', () => {
    const p = writeLog(['{"snapshotId": "solo", incomplete']);
    const originalWrite = process.stderr.write;
    let wroteWarning = false;
    process.stderr.write = (chunk) => { if (/corrupt line/.test(String(chunk))) wroteWarning = true; return true; };
    let entries;
    try {
      entries = readLog(p);
    } finally {
      process.stderr.write = originalWrite;
    }
    assert.deepEqual(entries, []);
    assert.equal(wroteWarning, false, 'a torn final line must never warn — it is the documented, expected shape');
  });
});

/**
 * @fileoverview `printProgress` — the human-readable rendering of a bake-off
 * campaign's spend/effectiveness summary. No dedicated suite existed before
 * this; `summarise()`'s own arithmetic is covered by tests/bakeoff-summary.test.mjs,
 * this covers the RENDERING contract on top of it.
 *
 * @module tests/bakeoff-progress
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { printProgress } from '../scripts/lib/bakeoff/progress.mjs';
import { CONTRACT_EPOCH } from '../scripts/lib/bakeoff/log.mjs';
import { createResolvedScope } from '../scripts/lib/bakeoff/scope.mjs';

const SCOPE = createResolvedScope('c', [
  { id: 'opus', model: 'm' }, { id: 'kimi', model: 'm' }, { id: 'solo-opus', model: 'm', solo: true },
], null);

const dirs = [];
after(() => {
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best effort */ } }
});

function writeLog(entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bakeoff-progress-'));
  dirs.push(dir);
  const p = path.join(dir, 'bakeoff-log.jsonl');
  fs.writeFileSync(p, entries.map((e) => JSON.stringify(e)).join('\n'));
  return p;
}

/** Capture everything printProgress writes to stdout during `fn()`. */
function captureStdout(fn) {
  const original = process.stdout.write;
  const chunks = [];
  process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
  try {
    fn();
  } finally {
    process.stdout.write = original;
  }
  return chunks.join('');
}

const ran = (over) => ({ shadowState: 'ran', buckets: { shadowOnly: 1 }, primaryVerdict: 'CONCERNS', ...over });

describe('printProgress — spend total qualifier (final-review-credit-queue fp d207d40a)', () => {
  it('with ALL arms priced, the total carries no qualifier', () => {
    const p = writeLog([{
      snapshotId: 'a', campaignId: 'c', contractEpoch: CONTRACT_EPOCH,
      arms: {
        opus: { ...ran({}), costUsd: 1.5 },
        kimi: { ...ran({}), costUsd: 0.5 },
        'solo-opus': { primaryVerdict: 'CONCERNS', primaryFindings: 4, costUsd: 0.3 },
      },
    }]);
    const out = captureStdout(() => printProgress(p, 1, { ok: true, scope: SCOPE }));
    assert.match(out, /total \$2\.30/);
    assert.doesNotMatch(out, /arm\(s\) unpriced/, 'every arm was priced — no qualifier should appear');
  });

  it('with ONE arm unpriced, the total is qualified — D6 no-silent-zero applied to money', () => {
    const p = writeLog([{
      snapshotId: 'a', campaignId: 'c', contractEpoch: CONTRACT_EPOCH,
      arms: {
        opus: { ...ran({}), costUsd: 2.0 },
        kimi: { ...ran({}), costUsd: null }, // unpriced
        'solo-opus': { primaryVerdict: 'CONCERNS', primaryFindings: 4, costUsd: null },
      },
    }]);
    const out = captureStdout(() => printProgress(p, 1, { ok: true, scope: SCOPE }));
    // The per-arm parts already label unpriced arms...
    assert.match(out, /kimi=unpriced/);
    // ...but before this fix the AGGREGATE total silently summed only the
    // priced arms with no signal that it had excluded anything.
    assert.match(out, /total \$2\.00 \(2 arm\(s\) unpriced, excluded\)/);
  });
});

/**
 * The shared write-ahead envelope core.
 *
 * Plan: docs/plans/audit-store-write-durability.md, Phase 0.
 *
 * The two contract changes this module makes over the code it was extracted
 * from are the reason it exists, so they get the sharpest tests:
 *
 *  1. `drainEnvelopes` distinguishes `empty` from `unavailable`. The original
 *     returned identical zeroes for "nothing to do" and "I could not read the
 *     directory".
 *  2. A connection-scoped failure aborts the drain instead of being recorded
 *     against every artifact in the batch — otherwise one store outage
 *     consumes the whole backlog's retry budget for a reason that was never
 *     the data's fault.
 *
 * Plus the property that made extraction safe at all: `apply` must PROVE it
 * applied. A handler resolving `undefined` retains the envelope. That is the
 * defect the Gemini gate found in this plan's first draft, and the shipped
 * upstream code already had it right — which is itself the argument for one
 * implementation rather than three.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  parseEnvelopeFrame, writeEnvelope, drainEnvelopes, listEnvelopesOldestFirst,
  REJECTED_SUBDIR,
} from '../scripts/lib/outbox-envelope.mjs';

const V = 1;
const mkTmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
// `maxRetries`/`retryDelay` are required by tests/rmsync-retry-guard.test.mjs,
// not decoration: on Windows an antivirus or a lingering handle turns a tmpdir
// teardown into EPERM/EBUSY, and a bare rmSync makes that a flaky failure.
const rmTmp = (d) => {
  try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best effort */ }
};
const env = (fingerprint, payload = { a: 1 }) => ({ v: V, fingerprint, payload });
const parse = (t) => parseEnvelopeFrame(t, { version: V });

// ── Frame validation ────────────────────────────────────────────────────────

test('frame: malformed / wrong-version / keyless envelopes are unusable', () => {
  assert.equal(parse('{not json'), null);
  assert.equal(parse(JSON.stringify({ v: 999, fingerprint: 'f', payload: {} })), null);
  assert.equal(parse(JSON.stringify({ v: V, fingerprint: '', payload: {} })), null);
  assert.equal(parse(JSON.stringify({ v: V, fingerprint: 'f' })), null);
  assert.equal(parse(JSON.stringify({ v: V, fingerprint: 'f', payload: 'nope' })), null);
});

test('frame: a well-formed envelope survives the round trip', () => {
  const parsed = parse(JSON.stringify(env('abc', { title: 't' })));
  assert.equal(parsed.fingerprint, 'abc');
  assert.deepEqual(parsed.payload, { title: 't' });
});

test('frame: the payload validator is CONSUMER-supplied, not baked in', () => {
  // The whole reason the frame/payload split exists: upstream validates report
  // shape, an audit-store writer validates something else. A core that hard-
  // coded either would have forced the second consumer to copy the module.
  const strict = (t) => parseEnvelopeFrame(t, { version: V, validatePayload: (p) => p.kind === 'ok' });
  assert.equal(strict(JSON.stringify(env('f', { kind: 'nope' }))), null);
  assert.ok(strict(JSON.stringify(env('f', { kind: 'ok' }))));
});

// ── Ordering ────────────────────────────────────────────────────────────────

test('list: oldest first, and the cap takes the OLDEST not an arbitrary subset', () => {
  const dir = mkTmp('ces-env-order-');
  try {
    // Written newest-first so directory order and age disagree; if the
    // implementation fell back to readdir order this assertion would flip.
    for (const [name, mtime] of [['c', 3000], ['a', 1000], ['b', 2000]]) {
      const f = writeEnvelope(dir, env(name));
      fs.utimesSync(f, mtime / 1000, mtime / 1000);
    }
    const all = listEnvelopesOldestFirst(dir, 10);
    assert.deepEqual(all.names, ['a.json', 'b.json', 'c.json']);

    const capped = listEnvelopesOldestFirst(dir, 2);
    assert.deepEqual(capped.names, ['a.json', 'b.json'], 'a cap must retire the oldest work first');
  } finally { rmTmp(dir); }
});

// ── Drain states ────────────────────────────────────────────────────────────

test('drain: absent directory is EMPTY', async () => {
  const dir = mkTmp('ces-env-absent-');
  try {
    const res = await drainEnvelopes({
      dir: path.join(dir, 'nope'), apply: async () => true, parse, cap: 10,
    });
    assert.deepEqual(res, { state: 'empty', drained: 0, rejected: 0, failed: 0 });
  } finally { rmTmp(dir); }
});

test('drain: UNREADABLE directory is unavailable — the distinction is the point', async () => {
  const dir = mkTmp('ces-env-unreadable-');
  try {
    const notADir = path.join(dir, 'outbox');
    fs.writeFileSync(notADir, 'regular file');
    const res = await drainEnvelopes({ dir: notADir, apply: async () => true, parse, cap: 10 });
    assert.equal(res.state, 'unavailable');
    assert.match(res.reason, /readdir failed/);
  } finally { rmTmp(dir); }
});

test('drain: an applied envelope is deleted; the counters say so', async () => {
  const dir = mkTmp('ces-env-apply-');
  try {
    writeEnvelope(dir, env('f1'));
    const res = await drainEnvelopes({ dir, apply: async () => true, parse, cap: 10 });
    assert.equal(res.state, 'drained');
    assert.equal(res.drained, 1);
    assert.equal(fs.existsSync(path.join(dir, 'f1.json')), false);
  } finally { rmTmp(dir); }
});

test('drain: an `apply` resolving UNDEFINED retains the envelope', async () => {
  // The regression test for the defect the Gemini gate found: a handler that
  // returns without throwing (e.g. an early `return` when the store is off)
  // must not be read as success, or the drain deletes undelivered data.
  const dir = mkTmp('ces-env-silent-');
  try {
    const res = await drainEnvelopes({ dir: (writeEnvelope(dir, env('f2')), dir), apply: async () => undefined, parse, cap: 10 });
    assert.equal(res.drained, 0);
    assert.equal(res.failed, 1);
    assert.ok(fs.existsSync(path.join(dir, 'f2.json')), 'silence is not success');
  } finally { rmTmp(dir); }
});

test('drain: a poison envelope is quarantined, not deleted and not retried forever', async () => {
  const dir = mkTmp('ces-env-poison-');
  try {
    fs.writeFileSync(path.join(dir, 'bad.json'), '{not json');
    const res = await drainEnvelopes({ dir, apply: async () => true, parse, cap: 10 });
    assert.equal(res.rejected, 1);
    assert.equal(fs.existsSync(path.join(dir, REJECTED_SUBDIR, 'bad.json')), true,
      'a poison envelope must survive in rejected/, not vanish');
  } finally { rmTmp(dir); }
});

// ── The outage rule ─────────────────────────────────────────────────────────

test('drain: a connection-scoped failure ABORTS and spares the rest of the batch', async () => {
  // Without this, one outage-time drain records a failure against every
  // artifact in the batch. Three of those retire a healthy backlog.
  const dir = mkTmp('ces-env-outage-');
  try {
    for (const n of ['a', 'b', 'c']) writeEnvelope(dir, env(n));
    let attempts = 0;
    const res = await drainEnvelopes({
      dir,
      parse,
      cap: 10,
      apply: async () => { attempts++; const e = new Error('connect ECONNREFUSED'); e.code = 'ECONNREFUSED'; throw e; },
      isConnectionError: (e) => e?.code === 'ECONNREFUSED',
    });
    assert.equal(res.state, 'unavailable');
    assert.equal(attempts, 1, 'the drain must stop at the FIRST connection failure, not try all three');
    assert.equal(res.failed, 0, 'an outage is not the artifacts\' fault — nothing is charged against them');
    for (const n of ['a', 'b', 'c']) {
      assert.ok(fs.existsSync(path.join(dir, `${n}.json`)), `${n} must survive an outage`);
    }
  } finally { rmTmp(dir); }
});

test('drain: an ARTIFACT-scoped failure is charged to that artifact and the batch continues', async () => {
  // The other side of the rule above — without this pair, "abort on error"
  // and "abort on connection error" are indistinguishable.
  const dir = mkTmp('ces-env-artifact-fail-');
  try {
    for (const n of ['a', 'b']) writeEnvelope(dir, env(n));
    let attempts = 0;
    const res = await drainEnvelopes({
      dir,
      parse,
      cap: 10,
      apply: async () => { attempts++; const e = new Error('constraint violation'); e.code = '23505'; throw e; },
      isConnectionError: (e) => e?.code === 'ECONNREFUSED',
    });
    assert.equal(res.state, 'drained');
    assert.equal(attempts, 2, 'a per-artifact error must not stop the batch');
    assert.equal(res.failed, 2);
  } finally { rmTmp(dir); }
});

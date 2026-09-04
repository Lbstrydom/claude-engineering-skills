/**
 * @fileoverview Cluster A / Phase 2 — a failed debt mirror SPILLS, it is not swallowed.
 *
 * This test is the plan's Phase 2 deliverable and was missing until the round-1
 * code audit named it (H1). It guards the fix for the defect that made the whole
 * plan necessary.
 *
 * The defect: `persistDebtEntries` called `upsertDebtEntries(...)` directly and
 * swallowed failure with `.catch(e => ({ ok: false, error: e.message }))`. The
 * resulting `cloudMirrored: false` was inspected by nobody and retried by
 * nothing, so a one-off deferral got exactly ONE chance to reach the store.
 * Measured consequence on this repo: 37 entries lived on a single disk.
 *
 * The fix routes that call through the already-registered
 * `durableWrite('debt.entries', …)` writer, so a failure spills to
 * `.audit/write-spill/` and the existing drain replays it.
 *
 * What is asserted here is the CONTRACT, not the transport: that
 * `persistDebtEntries` reports the durable-write outcome verbatim, and that
 * `cloudMirrored` is true only for `written`. A `spilled` push is NOT a
 * completed one — the entry is genuinely still absent from the store until a
 * drain lands, and a caller that cannot tell them apart will assert a
 * zero-orphan postcondition that is not yet true (plan A10).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { EventSource } from '../scripts/lib/debt-memory.mjs';

function tmpdir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `debt-durable-${label}-`));
}
function rmrf(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best effort */ }
}

describe('persistDebtEntries — the store write goes through the durable seam', () => {
  test('it does NOT call upsertDebtEntries directly any more', async () => {
    // The regression this whole plan exists to prevent, asserted at the seam
    // rather than by behaviour: a direct call is what swallowed the failure.
    // `scripts/debt-auto-capture.mjs` adopted durableWrite on 2026-08-27 after
    // reproducing the loss in a consumer; this call site was the other half.
    const src = fs.readFileSync(
      new URL('../scripts/lib/debt-memory.mjs', import.meta.url), 'utf-8',
    );
    assert.match(src, /durableWrite\('debt\.entries'/,
      'the mirror must route through the registered durable writer');
    assert.doesNotMatch(src, /await\s+upsertDebtEntries\(/,
      'a direct upsert here is the swallow-the-failure path that stranded 37 entries');
    assert.match(src, /import '\.\/audit-store-writers\.mjs'/,
      'the registry has exactly one bootstrap; without it a fresh process finds no handler');
  });

  test('the `debt.entries` writer is registered WITH a constraint-backed rowKey', async () => {
    // Replay eligibility requires a real DB uniqueness constraint. `debt_entries`
    // has UNIQUE (repo_id, topic_id), which is what makes at-least-once replay
    // safe here. Without the key the writer would be `lost`-only and a failed
    // mirror would never be retried — the original defect, reinstated.
    const { registeredWriters, _resetRegistry } = await import('../scripts/lib/durable-write.mjs');
    await import('../scripts/lib/audit-store-writers.mjs');
    assert.ok(registeredWriters().includes('debt.entries'),
      'debt.entries must be registered, or durableWrite would quarantine every payload');

    const src = fs.readFileSync(
      new URL('../scripts/lib/audit-store-writers.mjs', import.meta.url), 'utf-8',
    );
    assert.match(src, /rowKey: \(row\) => `\$\{row\.repo_id\}:\$\{row\.topic_id\}`/,
      'the key must match the UNIQUE (repo_id, topic_id) constraint that arbitrates it');
    assert.ok(typeof _resetRegistry === 'function');
  });

  test('DISABLED source writes nothing and reports `skipped`, never `written`', async () => {
    const dir = tmpdir('disabled');
    try {
      const { persistDebtEntries } = await import('../scripts/lib/debt-memory.mjs');
      const ledgerPath = path.join(dir, 'tech-debt.json');
      const r = await persistDebtEntries(
        { source: EventSource.DISABLED, canWrite: false, repoId: null },
        [{ topicId: 'aaaa1111', severity: 'HIGH' }],
        { ledgerPath },
      );
      assert.equal(r.cloudOutcome, 'skipped');
      assert.equal(r.cloudMirrored, false);
      assert.equal(fs.existsSync(ledgerPath), false, 'disabled must not write the local cache either');
    } finally { rmrf(dir); }
  });

  test('LOCAL source writes the cache and reports `skipped` — cloud-off is not a failure', async () => {
    const dir = tmpdir('local');
    try {
      const { persistDebtEntries } = await import('../scripts/lib/debt-memory.mjs');
      const ledgerPath = path.join(dir, 'tech-debt.json');
      const r = await persistDebtEntries(
        { source: EventSource.LOCAL, canWrite: true, repoId: null },
        [{
          topicId: 'bbbb2222', semanticHash: 'bbbb2222', severity: 'HIGH',
          category: 'x', section: 'y', detailSnapshot: 'z'.repeat(25),
          affectedFiles: [], affectedPrinciples: [], pass: 'backend',
          deferredReason: 'out-of-scope', deferredAt: new Date().toISOString(),
          deferredRun: 'test', deferredRationale: 'a'.repeat(25), contentAliases: [],
        }],
        { ledgerPath },
      );
      // Cloud off is a supported mode, not an error: `skipped` means the store
      // declined, which is why debt-reconcile counts it as still-local rather
      // than as reconciled.
      assert.equal(r.cloudOutcome, 'skipped');
      assert.equal(r.cloudMirrored, false);
    } finally { rmrf(dir); }
  });

  test('cloudMirrored is true ONLY for `written` — a spill is not a completed push', () => {
    // Pinned at the source, because constructing a real spill needs a failing
    // store. The mapping is the contract debt-reconcile's postcondition rests
    // on (plan A10): localOnly === spilled, reaching 0 only when every push was
    // actually written.
    const src = fs.readFileSync(
      new URL('../scripts/lib/debt-memory.mjs', import.meta.url), 'utf-8',
    );
    assert.match(src, /cloudMirrored: cloudOutcome === 'written'/,
      "'spilled' or 'lost' must never read as mirrored");
  });
});

describe('a failing store write really does SPILL (behavioural, not source-text)', () => {
  // The R2 audit was right that the assertions above are structural: they pin
  // the wiring but never make a mirror fail. This block does — it registers a
  // writer that throws, drives durableWrite against a tmpdir repoRoot, and
  // asserts the artifact lands on disk. That artifact IS the retry: without it
  // the entry is gone, which is how 37 of them ended up on one machine.

  test('a throwing writer with a rowKey SPILLS, and the envelope is on disk', async () => {
    const dir = tmpdir('spill');
    try {
      const { durableWrite, registerWriter, _resetRegistry, SPILL_DIR } =
        await import('../scripts/lib/durable-write.mjs');
      _resetRegistry();
      registerWriter('test.debtLike', {
        schemaVersion: 1,
        // Same key shape as the real debt.entries writer: replay-eligible only
        // because a UNIQUE (repo_id, topic_id) constraint arbitrates it.
        rowKey: (row) => `${row.repo_id}:${row.topic_id}`,
        replay: async () => { throw Object.assign(new Error('store unreachable'), { code: 'ECONNREFUSED' }); },
      });

      const r = await durableWrite(
        'test.debtLike',
        { repoId: 'r1', entries: [{ repo_id: 'r1', topic_id: 'aaaa1111' }] },
        { repoRoot: dir },
      );

      assert.equal(r.outcome, 'spilled',
        'a keyed writer whose store call fails must SPILL for replay, never vanish');

      const spillPath = path.join(dir, SPILL_DIR);
      const files = fs.readdirSync(spillPath).filter((f) => f.endsWith('.json'));
      assert.equal(files.length, 1, 'exactly one envelope should be queued');
      const env = JSON.parse(fs.readFileSync(path.join(spillPath, files[0]), 'utf-8'));
      assert.equal(env.writerId, 'test.debtLike');
      assert.ok(env.payload, 'the payload must be serialised, or a later drain has nothing to replay');
      _resetRegistry();
    } finally { rmrf(dir); }
  });

  test('a KEYLESS writer is LOST, not spilled — replay would corrupt', async () => {
    // The other half of the contract: without a constraint-backed key,
    // at-least-once replay is unsafe, so the failure is recorded as evidence
    // rather than queued. Asserting this direction is what stops someone
    // "fixing" a lost writer by adding a rowKey it cannot honour.
    const dir = tmpdir('lost');
    try {
      const { durableWrite, registerWriter, _resetRegistry, SPILL_DIR, LOST_SUBDIR } =
        await import('../scripts/lib/durable-write.mjs');
      _resetRegistry();
      registerWriter('test.keyless', {
        schemaVersion: 1,
        replay: async () => { throw new Error('store unreachable'); },
      });
      const r = await durableWrite('test.keyless', { any: 'payload' }, { repoRoot: dir });
      assert.equal(r.outcome, 'lost');
      const lost = path.join(dir, SPILL_DIR, LOST_SUBDIR);
      assert.ok(fs.existsSync(lost), 'evidence is kept even when replay is not possible');
      _resetRegistry();
    } finally { rmrf(dir); }
  });

  test('a succeeding writer is `written` and leaves NO envelope behind', async () => {
    // The negative control: without it, a spill assertion could pass because
    // every write spills, which would be its own defect.
    const dir = tmpdir('written');
    try {
      const { durableWrite, registerWriter, _resetRegistry, SPILL_DIR } =
        await import('../scripts/lib/durable-write.mjs');
      _resetRegistry();
      registerWriter('test.ok', {
        schemaVersion: 1,
        rowKey: (row) => `${row.id}`,
        replay: async () => ({ applied: true }),
      });
      const r = await durableWrite('test.ok', { entries: [{ id: 1 }] }, { repoRoot: dir });
      assert.equal(r.outcome, 'written');
      const spillPath = path.join(dir, SPILL_DIR);
      const left = fs.existsSync(spillPath)
        ? fs.readdirSync(spillPath).filter((f) => f.endsWith('.json')) : [];
      assert.deepEqual(left, [], 'a completed write must not leave a queued envelope');
      _resetRegistry();
    } finally { rmrf(dir); }
  });
});

/**
 * @fileoverview CLI-boundary tests for `scripts/event-wiring-lifecycle.mjs` —
 * the operator command that makes `disposition: 'dismissed'` reachable
 * (found with no producer at all in final-review credit triage, 2026-09-14).
 *
 * Mirrors `tests/event-wiring-scan-cli.test.mjs`'s structure: `_internals`
 * for pure argument parsing, `spawnSync` for process-boundary behavior
 * (flag validation, `--selfcheck-relocation`, exit codes).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { upsertLifecycle } from '../scripts/lib/audit/event-wiring-lifecycle-store.mjs';

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const CLI = path.join(REPO_ROOT, 'scripts', 'event-wiring-lifecycle.mjs');

function scratchLedgerPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'event-wiring-lifecycle-cli-'));
  return path.join(dir, 'ledger.json');
}

describe('event-wiring-lifecycle --selfcheck-relocation / flag validation', () => {
  it('the canonical bare invocation exits 0 and prints OK', () => {
    const r = spawnSync(process.execPath, [CLI, '--selfcheck-relocation'], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.stdout.trim(), 'OK');
  });

  it('an unknown flag is an invocation error (exit 2)', () => {
    const r = spawnSync(process.execPath, [CLI, '--totally-bogus-flag'], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(r.status, 2, `stdout: ${r.stdout}, stderr: ${r.stderr}`);
    assert.match(r.stderr, /unknown flag/);
  });

  it('missing --ledger is an invocation error (exit 2)', () => {
    const r = spawnSync(process.execPath, [CLI, '--list-open'], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--ledger/);
  });

  it('neither --list-open nor --dismiss is an invocation error (exit 2)', () => {
    const r = spawnSync(process.execPath, [CLI, '--ledger', 'x.json'], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /exactly one of/);
  });

  it('both --list-open and --dismiss together is an invocation error (exit 2)', () => {
    const r = spawnSync(process.execPath, [CLI, '--ledger', 'x.json', '--list-open', '--dismiss', 'a:b'], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /exactly one of/);
  });

  it('--reason without --dismiss is an invocation error (exit 2)', () => {
    const r = spawnSync(process.execPath, [CLI, '--ledger', 'x.json', '--list-open', '--reason', 'why'], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--reason only applies to --dismiss/);
  });
});

describe('event-wiring-lifecycle --list-open', () => {
  it('an empty/missing ledger reports no open records, exit 0', () => {
    const ledgerPath = scratchLedgerPath();
    try {
      const r = spawnSync(process.execPath, [CLI, '--ledger', ledgerPath, '--list-open'], { encoding: 'utf8', timeout: 30_000 });
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      assert.match(r.stdout, /no open records/);
    } finally {
      fs.rmSync(path.dirname(ledgerPath), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('lists an open record and excludes a dismissed one, in --json shape', () => {
    const ledgerPath = scratchLedgerPath();
    try {
      upsertLifecycle(ledgerPath, {
        kind: 'event-wiring-symmetry', fingerprint: 'event-wiring-symmetry|cart:updated', eventName: 'cart:updated',
        triggers: ['added-dispatch'], firstSeen: 1000, lastSeen: 1000, occurrences: 1,
        disposition: null, dispositionAt: null, resolvedObservedAt: null, deletionObservedAt: null,
        reopenHistory: [], lastObservedRef: 'sha1',
      });
      upsertLifecycle(ledgerPath, {
        kind: 'event-wiring-symmetry', fingerprint: 'event-wiring-symmetry|other:evt', eventName: 'other:evt',
        triggers: [], firstSeen: 1000, lastSeen: 1000, occurrences: 1,
        disposition: 'dismissed', dispositionAt: 1500, resolvedObservedAt: null, deletionObservedAt: null,
        reopenHistory: [], lastObservedRef: 'sha1', dismissReason: 'known, accepted',
      });
      const r = spawnSync(process.execPath, [CLI, '--ledger', ledgerPath, '--list-open', '--json'], { encoding: 'utf8', timeout: 30_000 });
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      const envelope = JSON.parse(r.stdout);
      assert.equal(envelope.ok, true);
      assert.equal(envelope.records.length, 1);
      assert.equal(envelope.records[0].eventName, 'cart:updated');
    } finally {
      fs.rmSync(path.dirname(ledgerPath), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});

describe('event-wiring-lifecycle --dismiss', () => {
  it('dismisses an open record and it stays dismissed on --list-open', () => {
    const ledgerPath = scratchLedgerPath();
    try {
      upsertLifecycle(ledgerPath, {
        kind: 'event-wiring-symmetry', fingerprint: 'event-wiring-symmetry|cart:updated', eventName: 'cart:updated',
        triggers: [], firstSeen: 1000, lastSeen: 1000, occurrences: 1,
        disposition: null, dispositionAt: null, resolvedObservedAt: null, deletionObservedAt: null,
        reopenHistory: [], lastObservedRef: 'sha1',
      });
      const dismiss = spawnSync(process.execPath, [CLI, '--ledger', ledgerPath, '--dismiss', 'cart:updated', '--reason', 'test-only forever', '--json'], { encoding: 'utf8', timeout: 30_000 });
      assert.equal(dismiss.status, 0, `stderr: ${dismiss.stderr}`);
      const envelope = JSON.parse(dismiss.stdout);
      assert.equal(envelope.ok, true);
      assert.equal(envelope.record.disposition, 'dismissed');
      assert.equal(envelope.record.dismissReason, 'test-only forever');

      const list = spawnSync(process.execPath, [CLI, '--ledger', ledgerPath, '--list-open', '--json'], { encoding: 'utf8', timeout: 30_000 });
      assert.equal(JSON.parse(list.stdout).records.length, 0);
    } finally {
      fs.rmSync(path.dirname(ledgerPath), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('dismissing an unknown event name is exit 3, not a silent no-op', () => {
    const ledgerPath = scratchLedgerPath();
    try {
      upsertLifecycle(ledgerPath, {
        kind: 'event-wiring-symmetry', fingerprint: 'event-wiring-symmetry|other', eventName: 'other',
        triggers: [], firstSeen: 1000, lastSeen: 1000, occurrences: 1,
        disposition: null, dispositionAt: null, resolvedObservedAt: null, deletionObservedAt: null,
        reopenHistory: [], lastObservedRef: 'sha1',
      });
      const r = spawnSync(process.execPath, [CLI, '--ledger', ledgerPath, '--dismiss', 'no-such-event'], { encoding: 'utf8', timeout: 30_000 });
      assert.equal(r.status, 3, `stdout: ${r.stdout}, stderr: ${r.stderr}`);
      assert.match(r.stderr, /no lifecycle record/);
    } finally {
      fs.rmSync(path.dirname(ledgerPath), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('dismissing a non-open (already-fixed) record is exit 3, and does not overwrite the fixed evidence', () => {
    const ledgerPath = scratchLedgerPath();
    try {
      upsertLifecycle(ledgerPath, {
        kind: 'event-wiring-symmetry', fingerprint: 'event-wiring-symmetry|cart:updated', eventName: 'cart:updated',
        triggers: [], firstSeen: 1000, lastSeen: 1000, occurrences: 1,
        disposition: 'fixed', dispositionAt: 1500, resolvedObservedAt: 1500, deletionObservedAt: null,
        reopenHistory: [], lastObservedRef: 'sha1',
      });
      const r = spawnSync(process.execPath, [CLI, '--ledger', ledgerPath, '--dismiss', 'cart:updated'], { encoding: 'utf8', timeout: 30_000 });
      assert.equal(r.status, 3, `stdout: ${r.stdout}, stderr: ${r.stderr}`);
      assert.match(r.stderr, /not open/);
      assert.match(r.stderr, /fixed/);
    } finally {
      fs.rmSync(path.dirname(ledgerPath), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});

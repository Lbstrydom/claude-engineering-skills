/**
 * @fileoverview Crash-safe install transaction with on-disk write-ahead log (WAL).
 *
 * The transaction journal lives at `<repoRoot>/.audit-loop-install-txn.json`
 * (or a caller-supplied path). It is created + fsynced before any write occurs
 * and deleted only after the transaction is fully committed. If the process
 * crashes mid-transaction, the next installer run detects the journal and
 * either rolls forward (completes pending renames) or rolls back (deletes
 * staged `.tmp-*` files).
 *
 * Atomicity boundary: filesystems give us atomic rename only within a
 * directory and only for single operations. Multi-file installs are NOT
 * atomic at the OS level — this gives us eventual consistency via journal
 * reconciliation, matching the `atomicWriteFileSync` guarantees used
 * elsewhere in the repo.
 *
 * @module scripts/lib/install/transaction
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { retrySync } from '../retry-transient-fs.mjs';

/**
 * @typedef {Object} WriteOp
 * @property {string} absPath — target path (will be written)
 * @property {string|Buffer} content
 *
 * @typedef {Object} DeleteOp
 * @property {string} absPath — target path (will be deleted)
 * @property {string} [expectedSha] — first-12-hex SHA the installer expects;
 *   if on-disk SHA differs, deletion is skipped (user-modified) and a
 *   `skippedDelete` conflict is returned.
 *
 * @typedef {Object} TransactionOps
 * @property {WriteOp[]} [writes]
 * @property {DeleteOp[]} [deletes]
 * @property {string} [journalPath] — override default journal location
 */

function tmpSuffix() {
  // PID + millisecond + random — collision requires same PID + same ms + RNG collision
  return `${process.pid}.${Date.now()}.${Math.floor(Math.random() * 0xFFFF).toString(16)}`;
}

function shaShort(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);
}

function fsyncFile(fd) {
  try { fs.fsyncSync(fd); } catch { /* best-effort; some filesystems lack fsync support */ }
}

/**
 * Write a journal file atomically (temp + rename, fsynced).
 * @param {string} journalPath
 * @param {object} body
 */
function writeJournal(journalPath, body) {
  fs.mkdirSync(path.dirname(journalPath), { recursive: true });
  const tmp = `${journalPath}.tmp.${tmpSuffix()}`;
  const content = JSON.stringify(body, null, 2);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, content);
    fsyncFile(fd);
  } finally {
    fs.closeSync(fd);
  }
  retrySync(() => fs.renameSync(tmp, journalPath));
}

/**
 * Execute a crash-safe install transaction covering writes + deletes.
 *
 * Accepts either the legacy `Array<{absPath, content}>` signature (writes only)
 * or the new `{writes, deletes, journalPath}` object.
 *
 * @param {WriteOp[] | TransactionOps} opsOrWrites
 * @returns {{ success: boolean, written: number, deleted: number, skippedDeletes: Array<{absPath: string, reason: string}>, error?: string }}
 */
export function executeTransaction(opsOrWrites) {
  const ops = Array.isArray(opsOrWrites)
    ? { writes: opsOrWrites, deletes: [] }
    : { writes: opsOrWrites.writes || [], deletes: opsOrWrites.deletes || [], journalPath: opsOrWrites.journalPath };

  const writes = ops.writes;
  const deletes = ops.deletes;
  const skippedDeletes = [];

  // Phase 1 — snapshot + journal
  const snapshots = new Map();
  for (const w of writes) {
    if (fs.existsSync(w.absPath)) {
      try { snapshots.set(w.absPath, fs.readFileSync(w.absPath)); }
      catch { snapshots.set(w.absPath, null); }
    } else {
      snapshots.set(w.absPath, undefined);
    }
  }

  // Pre-compute staging paths so the journal describes the exact filesystem
  // operations the installer will perform. Allows rollback/roll-forward on
  // crash without needing to re-derive state from the inputs.
  const staged = writes.map(w => ({
    absPath: w.absPath,
    tmpPath: `${w.absPath}.tmp.${tmpSuffix()}`,
  }));

  const journalPath = ops.journalPath || defaultJournalPath();
  writeJournal(journalPath, {
    startedAt: new Date().toISOString(),
    stage: 'staged',
    staged: staged.map(s => ({ absPath: s.absPath, tmpPath: s.tmpPath })),
    deletes: deletes.map(d => ({ absPath: d.absPath, expectedSha: d.expectedSha ?? null })),
  });

  // Phase 2 — stage every write to its .tmp path (fsynced)
  for (let i = 0; i < writes.length; i++) {
    const w = writes[i];
    const { tmpPath } = staged[i];
    fs.mkdirSync(path.dirname(w.absPath), { recursive: true });
    const fd = fs.openSync(tmpPath, 'w');
    try {
      fs.writeFileSync(fd, w.content);
      fsyncFile(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  // Update journal to "renaming" stage — crash after this means roll forward.
  writeJournal(journalPath, {
    startedAt: new Date().toISOString(),
    stage: 'renaming',
    staged: staged.map(s => ({ absPath: s.absPath, tmpPath: s.tmpPath })),
    deletes: deletes.map(d => ({ absPath: d.absPath, expectedSha: d.expectedSha ?? null })),
  });

  // Phase 3 — atomic rename every staged file into place
  const writtenPaths = [];
  try {
    for (const { absPath, tmpPath } of staged) {
      retrySync(() => fs.renameSync(tmpPath, absPath));
      writtenPaths.push(absPath);
    }
  } catch (err) {
    // Rollback renames + staged files
    rollbackPartialTransaction(writtenPaths, snapshots, staged);
    cleanupJournal(journalPath);
    return { success: false, written: 0, deleted: 0, skippedDeletes, error: err.message };
  }

  // Phase 4 — execute deletes (respect orphan protection)
  let deletedCount = 0;
  for (const d of deletes) {
    if (!fs.existsSync(d.absPath)) continue;
    if (d.expectedSha) {
      let actualSha;
      try { actualSha = shaShort(fs.readFileSync(d.absPath)); } catch { actualSha = null; }
      if (actualSha && actualSha !== d.expectedSha) {
        skippedDeletes.push({
          absPath: d.absPath,
          reason: `CONFLICT_DELETION_SKIPPED: user-modified since last install (expected ${d.expectedSha}, found ${actualSha})`,
        });
        continue;
      }
    }
    try { retrySync(() => fs.unlinkSync(d.absPath)); deletedCount++; }
    catch (err) {
      skippedDeletes.push({ absPath: d.absPath, reason: `DELETE_FAILED: ${err.message}` });
    }
  }

  cleanupJournal(journalPath);
  return { success: true, written: writtenPaths.length, deleted: deletedCount, skippedDeletes };
}

function rollbackPartialTransaction(writtenPaths, snapshots, staged) {
  // Remove any unused .tmp files first
  for (const { tmpPath } of staged) {
    try { if (fs.existsSync(tmpPath)) retrySync(() => fs.unlinkSync(tmpPath)); } catch { /* best effort */ }
  }
  // Revert any completed renames to their snapshot
  for (const absPath of writtenPaths) {
    const snapshot = snapshots.get(absPath);
    try {
      if (snapshot === undefined) {
        if (fs.existsSync(absPath)) retrySync(() => fs.unlinkSync(absPath));
      } else if (snapshot !== null) {
        const tmpPath = `${absPath}.tmp.${tmpSuffix()}`;
        fs.writeFileSync(tmpPath, snapshot);
        retrySync(() => fs.renameSync(tmpPath, absPath));
      }
    } catch (err) {
      process.stderr.write(`  [rollback] Failed to restore ${absPath}: ${err.message}\n`);
    }
  }
}

function cleanupJournal(journalPath) {
  try { if (fs.existsSync(journalPath)) retrySync(() => fs.unlinkSync(journalPath)); }
  catch { /* best effort */ }
}

/**
 * Recovery — call at installer startup. If a journal exists, reconcile the
 * filesystem state (roll forward completed renames, roll back stragglers).
 * @param {string} [journalPath]
 * @returns {{ recovered: boolean, rolledForward: number, rolledBack: number, error?: string }}
 */
export function recoverFromJournal(journalPath = defaultJournalPath()) {
  if (!fs.existsSync(journalPath)) return { recovered: false, rolledForward: 0, rolledBack: 0 };

  let journal;
  try { journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')); }
  catch (err) {
    // Unreadable journal — remove it to avoid infinite recovery loop
    try { retrySync(() => fs.unlinkSync(journalPath)); } catch { /* best effort */ }
    return { recovered: false, rolledForward: 0, rolledBack: 0, error: `corrupt journal: ${err.message}` };
  }

  let rolledForward = 0, rolledBack = 0;

  if (journal.stage === 'renaming') {
    // Roll forward — any staged .tmp file whose rename didn't complete, rename now.
    for (const { absPath, tmpPath } of journal.staged || []) {
      if (fs.existsSync(tmpPath)) {
        try { retrySync(() => fs.renameSync(tmpPath, absPath)); rolledForward++; }
        catch (err) { process.stderr.write(`  [recover] roll-forward failed for ${absPath}: ${err.message}\n`); }
      }
    }
  } else {
    // stage === 'staged' — nothing was renamed yet; discard all .tmp files.
    for (const { tmpPath } of journal.staged || []) {
      if (fs.existsSync(tmpPath)) {
        try { retrySync(() => fs.unlinkSync(tmpPath)); rolledBack++; } catch { /* best effort */ }
      }
    }
  }

  try { retrySync(() => fs.unlinkSync(journalPath)); } catch { /* best effort */ }
  return { recovered: true, rolledForward, rolledBack };
}

function defaultJournalPath() {
  return path.resolve('.audit-loop-install-txn.json');
}

/**
 * @fileoverview Moving a tech-debt ledger from the legacy single file to one file
 * per entry — and reconciling a stale branch's legacy file after the move.
 * docs/plans/debt-ledger-per-entry-files.md §2.5.
 *
 * Four situations, decided from git and the filesystem, never guessed:
 *
 *  - **initial** — only the legacy file exists. Copy every entry into a sibling
 *    staging directory, verify, publish it with one directory rename, then
 *    delete (or shrink to the unresolved remainder) the legacy file. Staging
 *    means a reader never sees a half-written directory — and in the tracked
 *    both-forms state the directory is authoritative, so a half-written one
 *    would have been read as a complete ledger.
 *  - **fold** — both exist, the legacy file is untracked (an interrupted
 *    automatic migration): the same copy, into the existing directory.
 *  - **resumed** — both exist, the legacy file is tracked, and no commit has
 *    deleted it yet (a tracked migration interrupted before its commit): fold.
 *  - **stale-reconcile** — both exist, the legacy file is tracked, and a commit
 *    `M` reachable from HEAD deleted it: a branch cut before the migration
 *    carried it back in. Absence from the directory cannot say "deleted after
 *    migration" vs "never migrated", so this is a THREE-WAY merge against the
 *    stale branch's own baseline — `git merge-base <stale-ref> M` — applying
 *    only what that branch changed. Inputs are immutable git blobs and the plan
 *    applies all-or-nothing, so a retry recomputes the same plan.
 *
 * Copy-only is load-bearing for initial/fold/resumed: an id missing from the
 * legacy file simply has nothing to move — never read as a deletion — which is
 * what makes a shrunk remainder safe to retry.
 *
 * Every entry is copied byte-for-byte in meaning (no schema normalisation): a
 * migration moves records, it does not edit them.
 *
 * @module scripts/lib/debt-ledger-migration
 */

import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from './file-io.mjs';
import { retrySync } from './retry-transient-fs.mjs';
import {
  resolveLedgerLocation, topicIdFilenameProblem, entryFilePath, serializeEntryForDisk,
  serializeBudgetsForDisk, serializeLedgerForDisk, canonicalEqual, assertLedgerPathSafe,
  readBytesOrNull, isDirectory, readEntryDir, readBudgetsFile, parseLegacyBytes,
  withLedgerLock, legacyTrackingState, workTreeOf, repoRelative, ignoredPaths, runGit,
} from './debt-ledger-files.mjs';

/** Remove a file or directory; absent is fine; transient Windows locks are retried. */
function removePath(p) {
  fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}

/** POSIX single-quote a shell argument. */
function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * The commit reachable from HEAD that deleted the legacy file, or null.
 * `--full-history`: after a merge that KEPT the file, default history
 * simplification can hide the side on which it was deleted.
 */
function legacyDeletionCommit(root, relLegacy) {
  const r = runGit(['log', '--full-history', '--diff-filter=D', '-1', '--format=%H', '--', relLegacy], root);
  if (r.error || r.status !== 0) throw new Error(`git log failed: ${(r.stderr || r.error?.message || '').trim()}`);
  return r.stdout.trim() || null;
}

function gitShowJson(root, rev, rel) {
  const r = runGit(['show', `${rev}:${rel}`], root);
  if (r.error || r.status !== 0) return null;
  return r.stdout;
}

/** Group entries by topicId; ids whose copies differ are reported, not merged. */
function groupById(entries) {
  const byId = new Map();
  for (const e of entries) {
    const id = e && e.topicId;
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(e);
  }
  const single = new Map();
  const divergent = new Map();
  for (const [id, copies] of byId) {
    if (copies.every((c) => canonicalEqual(c, copies[0]))) single.set(id, copies[0]);
    else divergent.set(id, copies);
  }
  return { single, divergent };
}

function emptyReport(extra) {
  return {
    ok: true, action: 'nothing-to-do', mode: null, written: [], deleted: [], unchanged: 0,
    conflicts: [], ignored: [], legacy: 'absent', tracking: null, reason: null, stageCommand: null,
    ...extra,
  };
}

/**
 * Copy-only plan for initial / fold / resumed.
 */
function planCopy(legacy, current, currentBudgets, prefer) {
  const writes = new Map();
  const keeps = new Set();
  const remainder = [];
  const conflicts = [];
  const { single, divergent } = groupById(legacy.entries);
  for (const [id, copies] of divergent) {
    conflicts.push({ topicId: id, reason: 'legacy-duplicate-copies-differ', resolvable: false });
    remainder.push(...copies);
  }
  for (const [id, entry] of single) {
    const problem = topicIdFilenameProblem(id);
    if (problem) {
      conflicts.push({ topicId: String(id), reason: `unsafe-topicId: ${problem}`, resolvable: false });
      remainder.push(entry);
      continue;
    }
    const d = current.get(id);
    if (d === undefined) writes.set(id, entry);
    else if (canonicalEqual(d, entry)) keeps.add(id);
    else if (prefer === 'dir') keeps.add(id);
    else if (prefer === 'legacy') writes.set(id, entry);
    else {
      conflicts.push({ topicId: id, reason: 'legacy-copy-differs', resolvable: true });
      remainder.push(entry);
    }
  }
  let budgetsOp = 'none';
  let remainderBudgets;
  if (legacy.budgets !== undefined) {
    if (!currentBudgets.present) budgetsOp = 'write';
    else if (canonicalEqual(currentBudgets.budgets, legacy.budgets) || prefer === 'dir') budgetsOp = 'keep';
    else if (prefer === 'legacy') budgetsOp = 'write';
    else {
      conflicts.push({ topicId: 'budgets', reason: 'budgets-differ', resolvable: true });
      remainderBudgets = legacy.budgets;
    }
  }
  return { writes, deletes: new Set(), keeps, remainder, remainderBudgets, conflicts, budgetsOp, budgetsValue: legacy.budgets };
}

/**
 * Three-way plan for stale-reconcile: apply only the stale branch's own change
 * relative to the merge-base baseline (plan §2.5 table).
 */
function planThreeWay(base, stale, current, currentBudgets, prefer) {
  const writes = new Map();
  const deletes = new Set();
  const keeps = new Set();
  const conflicts = [];
  const B = groupById(base.entries).single;
  const S = groupById(stale.entries);
  for (const [id] of S.divergent) conflicts.push({ topicId: id, reason: 'legacy-duplicate-copies-differ', resolvable: false });
  const ids = new Set([...B.keys(), ...S.single.keys()]);
  for (const id of ids) {
    if (S.divergent.has(id)) continue;
    const b = B.get(id);
    const s = S.single.get(id);
    const d = current.get(id);
    if (s !== undefined) {
      const problem = topicIdFilenameProblem(id);
      if (problem) { conflicts.push({ topicId: String(id), reason: `unsafe-topicId: ${problem}`, resolvable: false }); continue; }
    }
    const apply = () => { if (s === undefined) deletes.add(id); else writes.set(id, s); };
    if (canonicalEqual(s, b) || canonicalEqual(d, s)) { if (s !== undefined && d !== undefined) keeps.add(id); continue; }
    if (canonicalEqual(d, b)) { apply(); continue; }
    if (prefer === 'dir') { if (d !== undefined && s !== undefined) keeps.add(id); continue; }
    if (prefer === 'legacy') { apply(); continue; }
    conflicts.push({ topicId: id, reason: s === undefined ? 'stale-deletion-of-changed-entry' : 'both-sides-changed', resolvable: true });
  }
  let budgetsOp = 'none';
  const bB = base.budgets;
  const sB = stale.budgets;
  const dB = currentBudgets.present ? currentBudgets.budgets : undefined;
  if (!canonicalEqual(sB, bB) && !canonicalEqual(dB, sB)) {
    if (canonicalEqual(dB, bB) || prefer === 'legacy') budgetsOp = sB === undefined ? 'delete' : 'write';
    else if (prefer !== 'dir') conflicts.push({ topicId: 'budgets', reason: 'both-sides-changed', resolvable: true });
  }
  if (budgetsOp === 'none' && sB !== undefined && dB !== undefined) budgetsOp = 'keep';
  return { writes, deletes, keeps, remainder: [], remainderBudgets: undefined, conflicts, budgetsOp, budgetsValue: sB };
}

/**
 * Migrate / fold / reconcile while the caller ALREADY holds the ledger lock.
 * Synchronous: every step is a local file or git operation.
 *
 * @param {ReturnType<typeof resolveLedgerLocation>} location
 * @param {object} [opts]
 * @param {'dir'|'legacy'|null} [opts.prefer] - resolve differing copies (CLI only)
 * @param {boolean} [opts.dryRun]
 * @param {string|null} [opts.staleRef] - required for stale-reconcile
 * @param {boolean} [opts.auto] - writer-initiated: only untracked legacy files
 * @param {(() => void)|null} [opts.onStaged] - test seam: called after the staged
 *   copy is verified and BEFORE it is published (initial mode only)
 * @returns {object} report (see `emptyReport`)
 */
export function migrateLegacyLedgerLocked(location, {
  prefer = null, dryRun = false, staleRef = null, auto = false, onStaged = null,
} = {}) {
  assertLedgerPathSafe(location, location.legacyFile, { expect: 'file' });
  const legacyBytes = readBytesOrNull(location.legacyFile);
  if (legacyBytes === null) return emptyReport({ legacy: 'absent' });

  const tracking = legacyTrackingState(location.legacyFile);
  const refuse = (reason, extra = {}) => ({ ...emptyReport({ legacy: 'kept', tracking }), ok: false, action: 'refused', reason, ...extra });
  if (tracking === 'unknown') return refuse('tracking-unknown: git could not say whether the legacy file is committed');
  if (auto && tracking !== 'untracked') return refuse('tracked-legacy-not-auto-migrated');

  const dirExists = isDirectory(location.dir);
  const wt = tracking === 'tracked' ? workTreeOf(location.legacyFile) : null;
  if (tracking === 'tracked' && (!wt || wt.state !== 'repo')) return refuse('tracking-unknown: no work tree');
  const relLegacy = wt ? repoRelative(wt.root, location.legacyFile) : null;

  let mode;
  if (!dirExists) mode = 'initial';
  else if (tracking === 'untracked') mode = 'fold';
  else {
    // A shallow clone can hide the commit that deleted the legacy file, which
    // would misread a stale branch's file as an interrupted migration and fold
    // it in whole — resurrecting every entry deleted since. Refuse instead.
    const shallow = runGit(['rev-parse', '--is-shallow-repository'], wt.root);
    if (shallow.status !== 0 || shallow.stdout.trim() !== 'false') {
      return refuse('no-baseline: shallow clone — the migration commit cannot be located; fetch full history (git fetch --unshallow)');
    }
    mode = legacyDeletionCommit(wt.root, relLegacy) ? 'stale-reconcile' : 'resumed';
  }

  const current = new Map();
  let currentBudgets = { present: false, budgets: undefined };
  if (dirExists) {
    for (const e of readEntryDir(location)) current.set(e.topicId, e);
    currentBudgets = readBudgetsFile(location);
  }

  let plan;
  if (mode === 'stale-reconcile') {
    if (!staleRef) return refuse('stale-ref-required', { mode });
    const M = legacyDeletionCommit(wt.root, relLegacy);
    const ref = runGit(['rev-parse', '--verify', '--quiet', `${staleRef}^{commit}`], wt.root);
    const sha = ref.status === 0 ? ref.stdout.trim() : null;
    if (!sha) return refuse(`stale-ref-unresolvable: ${staleRef}`, { mode });
    if (runGit(['merge-base', '--is-ancestor', M, sha], wt.root).status === 0) {
      return refuse('stale-ref-contains-migration: that revision already has the migration commit', { mode });
    }
    const mb = runGit(['merge-base', sha, M], wt.root);
    const baseRev = mb.status === 0 ? mb.stdout.trim() : '';
    const baseText = baseRev ? gitShowJson(wt.root, baseRev, relLegacy) : null;
    const staleText = gitShowJson(wt.root, sha, relLegacy);
    if (baseText === null || staleText === null) return refuse('no-baseline: fetch full history, or reconcile by hand', { mode });
    // Provenance: the working file must BE the stale blob (compared through git's
    // own clean/EOL conversion — a CRLF checkout is not an edit).
    const work = runGit(['hash-object', `--path=${relLegacy}`, '--', location.legacyFile], wt.root);
    const blob = runGit(['rev-parse', `${sha}:${relLegacy}`], wt.root);
    if (work.status !== 0 || blob.status !== 0 || work.stdout.trim() !== blob.stdout.trim()) {
      return refuse('provenance-mismatch: the working legacy file is not the stale revision\'s file', { mode });
    }
    plan = planThreeWay(
      parseLegacyBytes(Buffer.from(baseText), `${baseRev}:${relLegacy}`),
      parseLegacyBytes(Buffer.from(staleText), `${sha}:${relLegacy}`),
      current, currentBudgets, prefer,
    );
    const blocking = plan.conflicts.filter((c) => !c.resolvable || !prefer);
    if (blocking.length) return refuse('conflicts: nothing applied', { mode, conflicts: plan.conflicts });
  } else {
    plan = planCopy(parseLegacyBytes(legacyBytes, location.legacyFile), current, currentBudgets, prefer);
  }

  // Preservation manifest: every destination that becomes the authoritative
  // home of a record leaving the tracked source — written OR already identical
  // OR kept by --prefer dir (plan §2.5, R2 H1).
  const homeIds = [...plan.writes.keys(), ...plan.keeps];
  const budgetsHome = plan.budgetsOp === 'write' || plan.budgetsOp === 'keep';
  const manifest = wt
    ? [
      ...homeIds.map((id) => repoRelative(wt.root, entryFilePath(location, id))),
      ...(budgetsHome ? [repoRelative(wt.root, location.budgetsFile)] : []),
    ]
    : [];
  const checkManifest = () => (wt ? ignoredPaths(wt.root, manifest) : []);
  let ignored;
  try {
    ignored = checkManifest();
  } catch (err) {
    return refuse(err.message, { mode });
  }
  if (ignored.length) {
    return refuse('destination-ignored: these paths would not be committed', { mode, ignored, conflicts: plan.conflicts });
  }

  const report = {
    ...emptyReport({ tracking, mode }),
    action: mode === 'stale-reconcile' ? 'reconciled' : 'migrated',
    written: [...plan.writes.keys()],
    deleted: [...plan.deletes],
    unchanged: plan.keeps.size,
    conflicts: plan.conflicts,
    legacy: (plan.remainder.length || plan.remainderBudgets !== undefined) ? 'shrunk' : 'deleted',
  };
  if (wt) {
    const relDir = repoRelative(wt.root, location.dir);
    report.stageCommand = `git -C ${shQuote(wt.root.split(path.sep).join('/'))} add -A -- ${shQuote(relDir)} ${shQuote(relLegacy)}`;
  }
  if (dryRun) return { ...report, dryRun: true };

  // ── Apply ──
  const target = mode === 'initial'
    ? { ...location, dir: location.stagingDir, entriesDir: path.join(location.stagingDir, 'entries'), budgetsFile: path.join(location.stagingDir, 'budgets.json') }
    : location;
  if (mode === 'initial') {
    // A leftover staging directory is a pure function of the legacy file: rebuild it.
    assertLedgerPathSafe(location, location.stagingDir);
    removePath(location.stagingDir);
  }
  assertLedgerPathSafe(target, target.entriesDir);
  fs.mkdirSync(target.entriesDir, { recursive: true });
  const expected = new Map();
  for (const [id, entry] of plan.writes) {
    const file = entryFilePath(target, id);
    const bytes = serializeEntryForDisk(entry);
    atomicWriteFileSync(file, bytes);
    expected.set(file, bytes);
  }
  if (plan.budgetsOp === 'write') {
    const bytes = serializeBudgetsForDisk(plan.budgetsValue);
    atomicWriteFileSync(target.budgetsFile, bytes);
    expected.set(target.budgetsFile, bytes);
  } else if (plan.budgetsOp === 'delete') {
    removePath(target.budgetsFile);
  }
  for (const id of plan.deletes) removePath(entryFilePath(target, id));

  // Verify every postcondition before the legacy source loses anything.
  for (const [file, bytes] of expected) {
    const got = readBytesOrNull(file);
    if (got === null || got.toString('utf-8') !== bytes) throw new Error(`Debt ledger migration verification failed at ${file}`);
  }
  for (const id of plan.deletes) {
    if (fs.existsSync(entryFilePath(target, id))) throw new Error(`Debt ledger migration verification failed: ${id} still present`);
  }

  if (mode === 'initial') {
    if (onStaged) onStaged();
    retrySync(() => fs.renameSync(location.stagingDir, location.dir));
  }

  // Re-check immediately before the tracked source shrinks or disappears.
  const ignoredNow = checkManifest();
  if (ignoredNow.length) {
    return { ...report, ok: false, action: 'refused', reason: 'destination-ignored (changed during migration)', ignored: ignoredNow, legacy: 'kept' };
  }

  if (mode === 'stale-reconcile' || report.legacy === 'deleted') {
    removePath(location.legacyFile);
  } else {
    atomicWriteFileSync(location.legacyFile, serializeLedgerForDisk({
      version: 1,
      ...(plan.remainderBudgets !== undefined ? { budgets: plan.remainderBudgets } : {}),
      entries: plan.remainder,
    }));
  }
  report.ok = plan.conflicts.length === 0;
  return report;
}

/**
 * Lock, then migrate. The CLI's entry point.
 *
 * @param {string} ledgerPath
 * @param {Parameters<typeof migrateLegacyLedgerLocked>[1]} [opts]
 */
export async function migrateLegacyLedger(ledgerPath, opts = {}) {
  const location = resolveLedgerLocation(ledgerPath);
  // No legacy file, nothing to move — and no lock either: taking it would create
  // the parent directory of a ledger that does not exist (a dry run must not write).
  if (!fs.existsSync(location.legacyFile)) return emptyReport({ legacy: 'absent' });
  return withLedgerLock(location, () => migrateLegacyLedgerLocked(location, opts));
}

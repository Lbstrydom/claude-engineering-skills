/**
 * @fileoverview Crash-safe install transaction with on-disk write-ahead log (WAL).
 *
 * The journal is created + fsynced before any write occurs and deleted only
 * after the transaction is fully committed. If the process crashes
 * mid-transaction, the next installer run detects the journal and either rolls
 * forward (completes pending renames) or rolls back (deletes staged `.tmp-*`
 * files).
 *
 * JOURNAL PLACEMENT — the journal is anchored at the WIDEST surface the
 * transaction mutates, not at whichever repo started it:
 *   - repo-scoped only        -> `<repoRoot>/.audit-loop-install-txn.json`
 *   - touches ~/.claude/skills -> `~/.audit-loop-install-txn.json`
 * A mixed-scope transaction mutates a surface EVERY repo shares, so its
 * recovery record has to be somewhere every repo looks. Anchoring it in the
 * originating repo stranded it there: other repos found nothing, broke the dead
 * process's stale global lock after 60s, and installed over the half-applied
 * shared state — falsifying this module's own guarantee that an unresolved
 * partial transaction durably blocks installs.
 *
 * OWNERSHIP — a global journal records `originRepoRoot` as an identity CLAIM,
 * compared only against the recovering process's own known root. It never
 * contributes a containment root, so it cannot authorise itself. A journal that
 * is not ours is BLOCKED, never rolled forward and never moved: only its origin
 * can validate its repo-scoped half and write the receipt its transaction
 * depends on.
 *
 * Atomicity boundary: filesystems give us atomic rename only within a
 * directory and only for single operations. Multi-file installs are NOT
 * atomic at the OS level — this gives us eventual consistency via journal
 * reconciliation, matching the `atomicWriteFileSync` guarantees used
 * elsewhere in the repo.
 *
 * DURABILITY GUARANTEE — best-effort and platform-dependent, never silent.
 * A definite fsync failure on the journal or on staged content is a HARD
 * ABORT (the WAL is worthless if its own write may not have landed). A
 * platform that genuinely lacks fsync support (`ENOTSUP`/`EINVAL`), and any
 * directory-entry fsync failure, DEGRADES: the operation proceeds and the
 * degradation is reported via the result's `degradations[]` for the caller to
 * surface. Both `executeTransaction` and `recoverFromJournal` return that
 * channel — recovery performs the same renames, so it carries the same barrier
 * and the same reporting. Windows is the one platform where directory fsync is
 * not attempted at all (it has no such operation; see `fsyncDir`) — that is
 * absence of a capability, not a degradation, and reporting it every run would
 * drown the real signal. We do not claim unconditional crash-safety, and we
 * never degrade silently — see `docs/plans/install-transaction-wal-hardening.md`.
 *
 * CONTAINMENT — journal paths are validated against an ALLOWED-ROOT SET, not
 * a single repoRoot: one transaction legitimately spans both the repo and the
 * global `~/.claude/skills/` surface (`install-skills.mjs` merges repo- and
 * global-scope writes into a single call).
 *
 * @module scripts/lib/install/transaction
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { retrySync } from '../retry-transient-fs.mjs';
import { acquireLock, releaseLock } from '../file-store.mjs';
import {
  globalSurfaceRoot, globalJournalPath, globalQuarantineDir,
  repoJournalPath, repoQuarantineDir, INSTALL_JOURNAL_BASENAME,
} from './surface-paths.mjs';

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
 * @property {string} [repoRoot] — containment + quarantine anchor
 *
 * @typedef {Object} Degradation
 * @property {string} code — errno code (e.g. 'ENOTSUP')
 * @property {string} what — human label for what could not be fsynced
 */

/** Journal format version written by THIS code. */
const JOURNAL_VERSION = 1;

/**
 * fsync failures that mean "this platform/filesystem cannot do it", NOT "the
 * write failed". Deliberately minimal: only these two are well-documented as
 * capability signals. `EBADF`/`EPERM`/`EISDIR` are NOT here — they indicate a
 * real bug or a real permission problem, and on a CRITICAL fsync the safe
 * direction to be wrong in is a loud abort.
 */
const BENIGN_FSYNC_CODES = new Set(['ENOTSUP', 'EINVAL']);

function tmpSuffix() {
  // PID + millisecond + random — collision requires same PID + same ms + RNG collision
  return `${process.pid}.${Date.now()}.${Math.floor(Math.random() * 0xFFFF).toString(16)}`;
}

function shaShort(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);
}

// ── Durability ──────────────────────────────────────────────────────────────

/**
 * fsync a file descriptor.
 *
 * Returns rather than throwing for degradation so the caller can collect it;
 * throws ONLY when the data's durability is genuinely in doubt (a `critical`
 * fsync failing with a code outside the benign allowlist). A silent catch here
 * would recreate exactly the behaviour this module's guarantee rejects.
 *
 * @param {number} fd
 * @param {{critical?: boolean, what?: string}} [opts]
 * @returns {{ok: true} | {ok: false, degraded: Degradation}}
 */
function fsyncFile(fd, { critical = false, what = 'file' } = {}) {
  try {
    fs.fsyncSync(fd);
    return { ok: true };
  } catch (err) {
    const code = err.code || 'UNKNOWN';
    if (critical && !BENIGN_FSYNC_CODES.has(code)) {
      throw new Error(`fsync failed for ${what} (${code}): ${err.message}`);
    }
    return { ok: false, degraded: { code, what } };
  }
}

/**
 * fsync a DIRECTORY entry — a POSIX requirement for rename durability that has
 * nothing to do with the file's own fsync.
 *
 * `critical` splits the two cases, mirroring `fsyncFile`:
 *   - The JOURNAL's directory IS critical. If its rename may not be durable the
 *     WAL itself is in doubt, and at that point NO real work has happened — so
 *     aborting is both coherent and correct.
 *   - A TARGET's directory is not. By then the rename has already succeeded and
 *     the content is already durably fsynced (critical), so aborting would
 *     abandon completed, correct work over a weaker barrier. Report instead.
 * Either way a benign capability code (ENOTSUP/EINVAL) never aborts.
 *
 * NOT ATTEMPTED ON WINDOWS, and this is a correctness choice, not a shortcut.
 * Win32 has no fd-level directory fsync — `openSync(dir, 'r')` fails with
 * EPERM by design — so there is no capability to degrade FROM. Recording a
 * degradation would make the warning fire on every single Windows install (4x
 * per run; measured on a real end-to-end run before this guard existed), which
 * trains operators to ignore it and would drown a REAL degradation, e.g. a
 * network share failing a file-content fsync. A warning that always fires
 * carries no information.
 *
 * @param {string} dirPath
 * @param {string} what
 * @returns {{ok: true} | {ok: false, degraded: Degradation}}
 */
function fsyncDir(dirPath, what = 'directory', { critical = false } = {}) {
  if (process.platform === 'win32') return { ok: true };
  let fd;
  try {
    fd = fs.openSync(dirPath, 'r');
  } catch (err) {
    const code = err.code || 'UNKNOWN';
    if (critical && !BENIGN_FSYNC_CODES.has(code)) {
      throw new Error(`cannot open ${what} for fsync (${code}): ${err.message}`);
    }
    return { ok: false, degraded: { code, what } };
  }
  try {
    return fsyncFile(fd, { critical, what });
  } finally {
    try { fs.closeSync(fd); } catch { /* best-effort */ }
  }
}

// ── Containment ─────────────────────────────────────────────────────────────

/**
 * Resolve `targetPath` and test whether it lands inside one of `allowedRoots`.
 *
 * A rename TARGET legitimately does not exist yet, so `realpathSync(target)`
 * would fail (ENOENT) for the common case — which is why the repo's existing
 * helpers (`sensitive-paths.mjs::resolveAndClassify`,
 * `gate-honesty/schema.mjs::resolveContainedPath`) are wrong here: they
 * fail-closed on ENOENT, correct for validating paths that SHOULD exist.
 * Instead: walk up to the nearest EXISTING ancestor, realpath THAT (catching a
 * symlinked ancestor — the INC-001 class), then re-append the literal
 * remainder and re-check. The re-check also defeats a literal `../` embedded
 * in the un-resolved tail, since `path.resolve` collapses it before the test.
 *
 * Fail-closed: any resolution error → false.
 *
 * @param {string} targetPath
 * @param {string[]} allowedRoots
 * @returns {boolean}
 */
function isWithinAllowedRoots(targetPath, allowedRoots) {
  if (typeof targetPath !== 'string' || targetPath.length === 0) return false;
  const abs = path.resolve(targetPath);

  let existing = abs;
  const remainder = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return false; // walked to FS root without finding one
    remainder.unshift(path.basename(existing));
    existing = parent;
  }

  let realAncestor;
  try { realAncestor = fs.realpathSync(existing); } catch { return false; }

  const reconstructed = remainder.length > 0
    ? path.resolve(realAncestor, ...remainder)
    : realAncestor;

  return allowedRoots.some((root) => {
    let realRoot;
    try { realRoot = fs.realpathSync(root); } catch { realRoot = path.resolve(root); }
    const rel = path.relative(realRoot, reconstructed);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
}

// ── Scope ───────────────────────────────────────────────────────────────────

/**
 * THE scope derivation — every scope-dependent decision in this module reads
 * from this ONE function.
 *
 * Three times over this module's history the same defect recurred: a scope was
 * handled in one place and forgotten in another (error flags, then quarantine
 * locations, then journal placement). Enumerating scopes at each decision site
 * is what makes that inevitable. So the four things that MUST follow a
 * transaction's scope — journal placement, the lock set, the quarantine target,
 * and the pre-flight blocker scan — all derive from this single call.
 *
 * The predicate is TOTAL: a path either resolves inside the global surface or
 * it does not, so there is no third case to overlook. It is also MONOTONE — it
 * asks "does this transaction touch the shared surface?", not "is it
 * exclusively repo-scoped" — so it stays correct even where the roots overlap
 * (e.g. a repo checked out inside the home directory).
 *
 * Covers writes AND deletes: a delete mutates the surface exactly as a write
 * does, and recovery reconciles deletes too. (The original lock predicate read
 * only `writes` — a global-deletes-only transaction took no global lock.)
 *
 * @returns {boolean}
 */
function touchesGlobalSurface({ writes, deletes }) {
  const root = globalSurfaceRoot();
  return [...writes, ...deletes].some(op => isWithinAllowedRoots(op.absPath, [root]));
}

/**
 * Where a transaction of this scope keeps its durable state.
 *
 * The rule is "anchor at the WIDEST surface touched": a transaction that
 * mutates the shared global surface must leave its recovery record where every
 * repo looks, because every repo is a party to that surface. A purely
 * repo-scoped transaction concerns only its own repo.
 *
 * @param {boolean} isGlobal
 * @param {string} repoRoot
 * @param {string} [journalOverride] — honoured for REPO scope only; a global
 *   transaction's journal location is not a caller's choice, because getting it
 *   wrong is invisible to the caller and harms other repos.
 */
function anchorFor(isGlobal, repoRoot, journalOverride) {
  return isGlobal
    ? { scope: 'global', journalPath: globalJournalPath(), quarantineDir: globalQuarantineDir() }
    : {
      scope: 'repo',
      journalPath: journalOverride || repoJournalPath(repoRoot),
      quarantineDir: repoQuarantineDir(repoRoot),
    };
}

/**
 * The anchor a journal ALREADY sits at, derived from its LOCATION — never from
 * its contents, which must work even for a journal too corrupt to parse.
 */
function anchorForJournal(journalPath, repoRoot) {
  return path.resolve(journalPath) === path.resolve(globalJournalPath())
    ? { scope: 'global', quarantineDir: globalQuarantineDir() }
    : { scope: 'repo', quarantineDir: repoQuarantineDir(repoRoot) };
}

/**
 * Identity test for two repo roots. Resolves symlinks (a checkout reached via a
 * link, `/var` -> `/private/var`) and compares case-insensitively on win32,
 * matching that platform's own filesystem semantics.
 */
function sameRoot(a, b) {
  const norm = (p) => {
    let r;
    try { r = fs.realpathSync(p); } catch { r = path.resolve(p); }
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  try { return norm(a) === norm(b); } catch { return false; }
}

// ── Journal schema ──────────────────────────────────────────────────────────

const StagedEntrySchema = z.object({
  absPath: z.string().min(1),
  tmpPath: z.string().min(1),
});

const DeleteEntrySchema = z.object({
  absPath: z.string().min(1),
  expectedSha: z.string().nullable().optional(),
});

/**
 * `version` is OPTIONAL by design: journals written before this code shipped
 * carry no version field, and rejecting them would quarantine exactly the
 * in-flight crash this module exists to recover. Absent → legacy, valid.
 * An explicit unrecognized value → invalid (a future format we cannot read).
 */
const JournalSchema = z.object({
  version: z.literal(JOURNAL_VERSION).optional(),
  /**
   * The repo that STARTED this transaction — an identity CLAIM, never an
   * authorisation.
   *
   * The distinction is the whole design. Letting a journal name its own
   * allowed root would be circular: a corrupt or hostile journal would
   * authorise itself. This field is only ever compared against the recovering
   * process's OWN, independently-known repoRoot, to answer one question: "is
   * this journal mine?". Containment still validates against caller-supplied
   * roots exclusively, so a journal claiming `originRepoRoot: '/etc'` widens
   * nothing — it just fails to match, and is treated as foreign.
   *
   * Optional for schema purposes because a repo-anchored journal does not need
   * it (living inside the repo proves ownership) and pre-existing journals
   * carry no such field. A GLOBAL-anchored journal without it cannot establish
   * an owner and is treated as foreign — fail-closed.
   */
  originRepoRoot: z.string().min(1).optional(),
  startedAt: z.string().optional(),
  stage: z.enum(['staged', 'renaming', 'rollback-failed']),
  staged: z.array(StagedEntrySchema).optional(),
  deletes: z.array(DeleteEntrySchema).optional(),
});

/**
 * Validate a parsed journal: schema, then containment, then the staged-pair
 * structural invariant.
 * @returns {{ok: true, journal: object} | {ok: false, error: string}}
 */
function validateJournal(parsed, allowedRoots) {
  const result = JournalSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, error: `schema invalid: ${result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ').slice(0, 300)}` };
  }
  const journal = result.data;

  for (const entry of journal.staged || []) {
    // Structural invariant: executeTransaction ALWAYS builds tmpPath as
    // `${absPath}.tmp.${suffix}`. Asserting it makes "rename one unrelated
    // repo file over another" impossible by construction, for one compare.
    if (!entry.tmpPath.startsWith(`${entry.absPath}.tmp.`)) {
      return { ok: false, error: `staged entry tmpPath is not its own absPath + '.tmp.<suffix>': ${entry.absPath}` };
    }
    if (!isWithinAllowedRoots(entry.absPath, allowedRoots)) {
      return { ok: false, error: `staged absPath escapes allowed roots: ${entry.absPath}` };
    }
    if (!isWithinAllowedRoots(entry.tmpPath, allowedRoots)) {
      return { ok: false, error: `staged tmpPath escapes allowed roots: ${entry.tmpPath}` };
    }
  }
  for (const entry of journal.deletes || []) {
    if (!isWithinAllowedRoots(entry.absPath, allowedRoots)) {
      return { ok: false, error: `delete absPath escapes allowed roots: ${entry.absPath}` };
    }
  }
  return { ok: true, journal };
}

// ── Quarantine ──────────────────────────────────────────────────────────────

/**
 * Lock guarding the SHARED global skills surface. Lives beside the surface it
 * protects (not beside a repo's journal) because its whole purpose is to
 * serialise installs originating from DIFFERENT repos.
 *
 * Now partly subsumed by the global journal lock (a global-scoped transaction
 * anchors its journal — and therefore its journal lock — globally too), but
 * kept deliberately: a lock anchored to the RESOURCE it protects stays correct
 * regardless of where journal-placement logic later decides to put the journal.
 */
function globalSurfaceLockPath() {
  return path.join(globalSurfaceRoot(), '.install.lock');
}

/**
 * Rename an invalid journal aside — never delete it. Deleting destroys the
 * only record of a possibly partially-applied transaction; the quarantined
 * file is ALSO the durable blocker (see `findUnresolvedQuarantine`).
 *
 * `targetDir` comes from the journal's OWN anchor, so a globally-anchored
 * journal is quarantined globally. Quarantining it into whichever repo happened
 * to find it would leave every OTHER repo unblocked — the same defect one scope
 * over.
 *
 * @returns {string|null} quarantined path, or null if quarantining failed
 */
function quarantineJournal(journalPath, targetDir, reason) {
  try {
    const dir = targetDir;
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, `${path.basename(journalPath)}.${Date.now()}.json`);
    let raw = null;
    try { raw = fs.readFileSync(journalPath, 'utf8'); } catch { /* keep null */ }
    fs.writeFileSync(dest, JSON.stringify({
      quarantinedAt: new Date().toISOString(),
      originJournalPath: journalPath,
      reason,
      raw,
    }, null, 2));
    retrySync(() => fs.unlinkSync(journalPath));
    process.stderr.write(`  [transaction] Quarantined invalid journal ${journalPath} -> ${dest}\n`);
    return dest;
  } catch (err) {
    process.stderr.write(`  [transaction] Quarantine failed for ${journalPath}: ${err.message}\n`);
    return null;
  }
}

/**
 * The durable blocker. Scoped to the journal's own basename so an unrelated
 * `file-store.mjs::_quarantineRecord` entry can never block an install.
 *
 * Takes the DIRECTORY SET the caller's scope actually implicates (derived from
 * `touchesGlobalSurface`, never enumerated by hand at the call site): a
 * transaction touching the shared surface must honour a global quarantine too,
 * or a partial global install blocks only the repo that discovered it.
 *
 * @param {string[]} dirs
 * @param {string} journalBasename
 * @returns {string|null} path of the first unresolved quarantined journal
 */
function findUnresolvedQuarantine(dirs, journalBasename) {
  for (const dir of Array.isArray(dirs) ? dirs : [dirs]) {
    let entries;
    try { entries = fs.readdirSync(dir); } catch { continue; }
    const hit = entries.find(n => n.startsWith(`${journalBasename}.`) && n.endsWith('.json'));
    if (hit) return path.join(dir, hit);
  }
  return null;
}

// ── Journal I/O ─────────────────────────────────────────────────────────────

/**
 * Write a journal file atomically (temp + rename, fsynced).
 * Throws on a critical fsync failure — the WAL is worthless if its own write
 * may not have landed.
 * @returns {Degradation[]}
 */
function writeJournal(journalPath, body) {
  const degradations = [];
  fs.mkdirSync(path.dirname(journalPath), { recursive: true });
  const tmp = `${journalPath}.tmp.${tmpSuffix()}`;
  const content = JSON.stringify({ version: JOURNAL_VERSION, ...body }, null, 2);

  let fd = fs.openSync(tmp, 'w');
  let closed = false;
  try {
    fs.writeFileSync(fd, content);
    const r = fsyncFile(fd, { critical: true, what: 'journal' });
    if (!r.ok) degradations.push(r.degraded);
    fs.closeSync(fd);
    closed = true;
  } catch (err) {
    // Close BEFORE unlinking. The EPERM-on-open-fd concern does not reproduce
    // on modern Windows (verified: POSIX delete semantics), but closing first
    // is free and forecloses the network-share / AV-handle cases we cannot
    // characterise. Cleanup must never mask the original error.
    if (!closed) { try { fs.closeSync(fd); } catch { /* ignore */ } closed = true; }
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
    catch (cleanupErr) {
      process.stderr.write(`  [transaction] Journal temp cleanup failed: ${cleanupErr.message}\n`);
    }
    throw err;
  } finally {
    if (!closed) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }

  // 0b7661a0/22bb5573/aea521d8/ee735643: an exhausted-retry rename failure
  // used to leak `tmp` — this call sat outside the try/catch/finally above,
  // which only covers the open/write/fsync/close phase. Mirror that same
  // cleanup style here rather than introduce a new pattern.
  try {
    retrySync(() => fs.renameSync(tmp, journalPath));
  } catch (err) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
    catch (cleanupErr) {
      process.stderr.write(`  [transaction] Journal temp cleanup failed: ${cleanupErr.message}\n`);
    }
    throw err;
  }
  // Critical: an undurable journal rename means the WAL may not survive the
  // crash it exists for, and nothing real has happened yet — so abort rather
  // than proceed on a WAL we cannot trust.
  const d = fsyncDir(path.dirname(journalPath), 'journal directory', { critical: true });
  if (!d.ok) degradations.push(d.degraded);
  return degradations;
}

function journalBody(stage, staged, deletes, repoRoot) {
  let origin = repoRoot;
  // Resolve at WRITE time so the later identity comparison is against a stable
  // form rather than whatever spelling this invocation happened to be given.
  try { origin = fs.realpathSync(repoRoot); } catch { /* keep as given */ }
  return {
    originRepoRoot: origin,
    startedAt: new Date().toISOString(),
    stage,
    staged: staged.map(s => ({ absPath: s.absPath, tmpPath: s.tmpPath })),
    deletes: deletes.map(d => ({ absPath: d.absPath, expectedSha: d.expectedSha ?? null })),
  };
}

// ── Deletes (shared by execute + recover) ───────────────────────────────────

/**
 * Attempt one delete with orphan protection. Shared by `executeTransaction`'s
 * Phase 4 and `recoverFromJournal`'s delete-replay so the two can never drift.
 *
 * Discriminated result — `kind` is the sole discriminant every caller reads;
 * `reason` is diagnostic text only, never parsed for control flow.
 * @returns {
 *   {kind: 'deleted', degradation?: Degradation} |
 *   {kind: 'absent'} |
 *   {kind: 'conflict-skipped', reason: string} |
 *   {kind: 'delete-failed', reason: string}
 * }
 */
function attemptDelete(d) {
  if (!fs.existsSync(d.absPath)) return { kind: 'absent' };
  if (d.expectedSha) {
    let actualSha;
    try { actualSha = shaShort(fs.readFileSync(d.absPath)); } catch { actualSha = null; }
    if (actualSha && actualSha !== d.expectedSha) {
      return {
        kind: 'conflict-skipped',
        reason: `CONFLICT_DELETION_SKIPPED: user-modified since last install (expected ${d.expectedSha}, found ${actualSha})`,
      };
    }
  }
  try {
    retrySync(() => fs.unlinkSync(d.absPath));
  } catch (err) {
    return { kind: 'delete-failed', reason: `DELETE_FAILED: ${err.message}` };
  }
  const dir = fsyncDir(path.dirname(d.absPath), `directory for deleted ${d.absPath}`);
  return dir.ok ? { kind: 'deleted' } : { kind: 'deleted', degradation: dir.degraded };
}

// ── Transaction ─────────────────────────────────────────────────────────────

/**
 * Execute a crash-safe install transaction covering writes + deletes.
 *
 * Accepts either the legacy `Array<{absPath, content}>` signature (writes only)
 * or the new `{writes, deletes, journalPath, repoRoot}` object.
 *
 * @param {WriteOp[] | TransactionOps} opsOrWrites
 * @returns {{ success: boolean, written: number, deleted: number, skippedDeletes: Array<{absPath: string, reason: string}>, degradations: Degradation[], error?: string }}
 */
export function executeTransaction(opsOrWrites) {
  const ops = Array.isArray(opsOrWrites)
    ? { writes: opsOrWrites, deletes: [] }
    : {
      writes: opsOrWrites.writes || [],
      deletes: opsOrWrites.deletes || [],
      journalPath: opsOrWrites.journalPath,
      repoRoot: opsOrWrites.repoRoot,
    };

  const writes = ops.writes;
  const deletes = ops.deletes;
  // repoRoot is resolved BEFORE the journal, because the journal's location now
  // depends on it. (The reverse order let `repoRoot` default from a cwd-derived
  // journal path, so a caller passing only `repoRoot` silently journalled to the
  // cwd while quarantining to the repo — two anchors for one transaction.)
  const repoRoot = ops.repoRoot
    || (ops.journalPath ? path.dirname(path.resolve(ops.journalPath)) : path.resolve('.'));

  // ONE derivation drives journal placement, the lock set, the quarantine
  // target, and the blocker scan. See `touchesGlobalSurface`.
  const isGlobal = touchesGlobalSurface({ writes, deletes });
  const anchor = anchorFor(isGlobal, repoRoot, ops.journalPath);
  const journalPath = anchor.journalPath;

  const skippedDeletes = [];
  const degradations = [];
  const deleteFailures = [];
  const fail = (error) => ({ success: false, written: 0, deleted: 0, skippedDeletes, degradations, deleteFailures, error });

  // Lock EVERY root this transaction actually mutates, not just the repo.
  // A transaction legitimately spans the SHARED global ~/.claude/skills
  // surface, so two different consumer repos would otherwise each hold their
  // own repo-local lock while racing the same global paths. Ordered
  // deterministically (journal lock first, then global surface) so concurrent
  // installs cannot deadlock; `acquireLock` throws after its fixed 5s wait
  // anyway.
  const lockPaths = [`${journalPath}.lock`];
  if (isGlobal) lockPaths.push(globalSurfaceLockPath());

  // The wait budget is a hard-coded 5s inside the primitive; the second
  // argument is the STALE-LOCK AGE, not a wait budget, so we take its 60s
  // default deliberately (a longer age would only prolong how long a crashed
  // predecessor blocks recovery). Nothing has touched the filesystem yet, so a
  // lock failure is always a clean no-op.
  const held = [];
  try {
    for (const lp of lockPaths) { acquireLock(lp); held.push(lp); }
  } catch (err) {
    for (const lp of held.reverse()) releaseLock(lp);
    return fail(`another install is in progress (lock held at ${lockPaths[held.length]}) — retry in a moment: ${err.message}`);
  }

  let stage = 'not-started';
  const staged = writes.map(w => ({
    absPath: w.absPath,
    tmpPath: `${w.absPath}.tmp.${tmpSuffix()}`,
  }));
  const writtenPaths = [];
  const snapshots = new Map();

  try {
    // Pre-flight — refuse on EITHER a live journal or an unresolved
    // quarantined one. Quarantining moves the journal aside, so without the
    // second check a quarantined transaction would stop blocking after one run.
    if (fs.existsSync(journalPath)) {
      return fail('a prior transaction journal exists — run recovery first');
    }
    // Scan every quarantine directory this transaction's scope implicates — a
    // repo-scoped run cares only about its own, but a run touching the shared
    // surface must also honour a global quarantine left by ANY repo.
    const blockerDirs = [repoQuarantineDir(repoRoot)];
    if (isGlobal) blockerDirs.push(globalQuarantineDir());
    const blocked = findUnresolvedQuarantine(blockerDirs, INSTALL_JOURNAL_BASENAME);
    if (blocked) {
      return fail(`a prior install transaction was quarantined at ${blocked} and has not been resolved — inspect it, then remove it to unblock installs`);
    }

    // Phase 1 — snapshot + journal. One classified read per target, no
    // existsSync probe first: existsSync collapses stat/access failures to
    // a bare `false`, which would silently treat some non-ENOENT "can't
    // tell if it exists" states as absent, and races against the read that
    // follows. ENOENT alone means genuinely absent; anything else aborts
    // BEFORE any journal write, staging, rename, or delete — `stage` is
    // still 'not-started' here, so the existing catch-block dispatch
    // already handles the abort correctly.
    for (const w of writes) {
      try {
        snapshots.set(w.absPath, fs.readFileSync(w.absPath));
      } catch (err) {
        if (err.code === 'ENOENT') snapshots.set(w.absPath, undefined);
        else throw err;
      }
    }

    degradations.push(...writeJournal(journalPath, journalBody('staged', staged, deletes, repoRoot)));
    stage = 'journal-written';

    // Phase 2 — stage every write to its .tmp path (fsynced).
    // `staging` is a distinct state: a failure partway through this loop leaves
    // temp files on disk that `journal-written` would wrongly report as
    // "nothing has changed yet".
    stage = 'staging';
    for (let i = 0; i < writes.length; i++) {
      const w = writes[i];
      const { tmpPath } = staged[i];
      fs.mkdirSync(path.dirname(w.absPath), { recursive: true });
      const fd = fs.openSync(tmpPath, 'w');
      try {
        fs.writeFileSync(fd, w.content);
        const r = fsyncFile(fd, { critical: true, what: `staged content for ${w.absPath}` });
        if (!r.ok) degradations.push(r.degraded);
      } finally {
        fs.closeSync(fd);
      }
    }
    stage = 'staged';

    degradations.push(...writeJournal(journalPath, journalBody('renaming', staged, deletes, repoRoot)));

    // Phase 3 — atomic rename every staged file into place
    stage = 'renaming';
    for (const { absPath, tmpPath } of staged) {
      retrySync(() => fs.renameSync(tmpPath, absPath));
      writtenPaths.push(absPath);
      const d = fsyncDir(path.dirname(absPath), `target directory for ${absPath}`);
      if (!d.ok) degradations.push(d.degraded);
    }
    stage = 'renamed';

    // Phase 4 — deletes. Past this point every rename is legitimately
    // complete, so a failure must NOT roll them back.
    stage = 'deleting';
    let deletedCount = 0;
    for (const d of deletes) {
      const r = attemptDelete(d);
      if (r.kind === 'deleted') {
        deletedCount++;
        if (r.degradation) degradations.push(r.degradation);
      } else if (r.kind === 'conflict-skipped') {
        skippedDeletes.push({ absPath: d.absPath, reason: r.reason });
      } else if (r.kind === 'delete-failed') {
        skippedDeletes.push({ absPath: d.absPath, reason: r.reason });
        deleteFailures.push({ absPath: d.absPath, reason: r.reason });
      }
    }

    // Safe to retain unmodified on a delete-failed outcome: the on-disk
    // journal already reads stage 'renaming' at this point, and recovery's
    // roll-forward branch replays journal.deletes through this same
    // attemptDelete() — so a future recovery run's retry is the correct
    // completion of this transaction, not an unwanted one.
    if (deleteFailures.length === 0) cleanupJournal(journalPath, 'success');
    return { success: true, written: writtenPaths.length, deleted: deletedCount, skippedDeletes, degradations, deleteFailures };
  } catch (err) {
    // Single top-level catch, dispatching on the stage the disk is actually in.
    // Temp files are enumerated from `staged` (the same list the journal
    // records), so this and `recoverFromJournal` share one source of truth.
    let rollbackFailures = [];
    switch (stage) {
      case 'not-started':
      case 'journal-written':
        // Journal may exist but nothing else does.
        cleanupJournal(journalPath, 'abort');
        break;
      case 'staging':
      case 'staged':
      case 'renaming': {
        // Durably mark the journal as unsafe-for-automatic-recovery BEFORE
        // attempting any rollback mutation — not after. The on-disk journal
        // already reads stage 'renaming' (written before Phase 3 even
        // starts), so a rollback failure followed by plain retention would
        // let a future recoverFromJournal() roll this transaction FORWARD
        // instead of back. Writing the marker first closes that window for
        // the entire rollback attempt, not just after it.
        let markerWritten = false;
        try {
          writeJournal(journalPath, journalBody('rollback-failed', staged, deletes, repoRoot));
          markerWritten = true;
        } catch (markErr) {
          process.stderr.write(`  [transaction] Failed to write rollback-failed marker: ${markErr.message}\n`);
        }
        if (!markerWritten) {
          // Do not attempt rollback without the safety marker in place —
          // leave the journal exactly as it durably stood on entry (stage
          // 'renaming', unmodified). This is safe, not merely a fallback:
          // no rollback mutation has been attempted, so the filesystem is
          // still in its plain partially-renamed Phase-3 state, which the
          // existing roll-forward branch already handles correctly.
          break;
        }
        rollbackFailures = rollbackPartialTransaction(writtenPaths, snapshots, staged);
        if (rollbackFailures.length === 0) cleanupJournal(journalPath, 'rollback');
        break;
      }
      case 'renamed':
      case 'deleting':
        // Renames are complete and correct — rolling them back would be wrong.
        // Leave the journal so recovery can finish the deletes next run.
        break;
    }
    return { ...fail(err.message), rollbackFailures };
  } finally {
    for (const lp of held.reverse()) releaseLock(lp);
  }
}

/**
 * @returns {Array<{absPath: string, reason: string}>} every path whose
 *   restore attempt failed — empty means rollback fully succeeded.
 */
function rollbackPartialTransaction(writtenPaths, snapshots, staged) {
  // Remove any unused .tmp files first — harmless, uniquely-named garbage;
  // never tracked as a rollback failure.
  for (const { tmpPath } of staged) {
    try { if (fs.existsSync(tmpPath)) retrySync(() => fs.unlinkSync(tmpPath)); } catch { /* best effort */ }
  }
  // Revert any completed renames to their snapshot. The domain is
  // deliberately binary: `undefined` (delete the new file) vs anything
  // else (a Buffer — restore it).
  const failures = [];
  for (const absPath of writtenPaths) {
    const snapshot = snapshots.get(absPath);
    try {
      if (snapshot === undefined) {
        try {
          if (fs.existsSync(absPath)) retrySync(() => fs.unlinkSync(absPath));
        } catch (err) {
          // ENOENT here means the target is already gone — a benign TOCTOU
          // outcome, not a real restore failure (the delete goal is
          // idempotently reachable however you get there).
          if (err.code !== 'ENOENT') throw err;
        }
      } else {
        // Restore has no "already done" precondition to reconverge
        // against — a restore's end state is specific bytes, which either
        // got written or didn't. Every error here, including ENOENT
        // (e.g. a missing parent directory), is a genuine failure.
        const tmpPath = `${absPath}.tmp.${tmpSuffix()}`;
        fs.writeFileSync(tmpPath, snapshot);
        retrySync(() => fs.renameSync(tmpPath, absPath));
      }
    } catch (err) {
      failures.push({ absPath, reason: err.message });
      process.stderr.write(`  [rollback] Failed to restore ${absPath}: ${err.message}\n`);
    }
  }
  return failures;
}

/**
 * `context` distinguishes the three real call sites so a cleanup failure's
 * logged message never claims a rollback happened when it didn't (or vice
 * versa) — this function is shared, its callers are not interchangeable.
 * @param {string} journalPath
 * @param {'success'|'rollback'|'recovery'|'abort'} context
 */
function cleanupJournal(journalPath, context) {
  try {
    if (fs.existsSync(journalPath)) retrySync(() => fs.unlinkSync(journalPath));
  } catch (err) {
    const what = context === 'rollback' ? 'a fully successful rollback'
      : context === 'recovery' ? 'recovery completing successfully'
      : context === 'abort' ? 'an abort before any mutation'
      : 'a successful install';
    process.stderr.write(`  [transaction] Failed to remove journal ${journalPath} after ${what} (only journal cleanup failed): ${err.message}\n`);
  }
}

/**
 * Recovery — call at installer startup. If a journal exists, reconcile the
 * filesystem state (roll forward completed renames, roll back stragglers).
 *
 * OWNERSHIP: a globally-anchored journal may have been written by a DIFFERENT
 * repo. Such a journal is never recovered here and never moved — see the
 * foreign-origin branch below for why blocking is the only sound answer.
 *
 * @param {string} [journalPath]
 * @param {{repoRoot?: string}} [opts]
 * @returns {{ recovered: boolean, rolledForward: number, rolledBack: number, skippedDeletes: Array<{absPath: string, reason: string}>, quarantined?: string, foreign?: boolean, foreignOrigin?: string|null, error?: string }}
 */
export function recoverFromJournal(journalPath = defaultJournalPath(), opts = {}) {
  const skippedDeletes = [];
  const degradations = [];
  const recoveryFailures = [];
  const none = { recovered: false, rolledForward: 0, rolledBack: 0, skippedDeletes, degradations, recoveryFailures };
  if (!fs.existsSync(journalPath)) return none;

  const repoRoot = opts.repoRoot || path.dirname(path.resolve(journalPath));
  // Containment roots come from the CALLER only. The journal never contributes
  // one — that is what keeps `originRepoRoot` an identity claim rather than a
  // self-issued authorisation.
  const allowedRoots = [repoRoot, globalSurfaceRoot()];
  const anchor = anchorForJournal(journalPath, repoRoot);
  // Ownership of a GLOBAL journal cannot be established without the caller's own
  // repoRoot: nothing in a shared anchor's location identifies its author. Absent
  // one, every global journal is foreign — fail closed.
  const ownerKnown = Boolean(opts.repoRoot);
  const lockPath = `${journalPath}.lock`;

  try {
    acquireLock(lockPath);
  } catch (err) {
    return { ...none, error: `another install is in progress (lock held at ${lockPath}) — retry in a moment: ${err.message}` };
  }

  try {
    // Re-check under the lock: another process may have handled it.
    if (!fs.existsSync(journalPath)) return none;

    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(journalPath, 'utf8')); }
    catch (err) {
      const q = quarantineJournal(journalPath, anchor.quarantineDir, `unparseable: ${err.message}`);
      return { ...none, error: `corrupt journal: ${err.message}`, quarantined: q ?? undefined };
    }

    // Schema first (it types `originRepoRoot`), then OWNERSHIP, and only then
    // containment. The order is load-bearing: containment validates against
    // THIS process's roots, so running it on another repo's journal would
    // reject that repo's perfectly valid entries and quarantine a healthy
    // record — destroying the evidence and the owner's ability to self-heal.
    const shape = JournalSchema.safeParse(parsed);
    if (shape.success && anchor.scope === 'global') {
      const origin = shape.data.originRepoRoot ?? null;
      if (!ownerKnown || !origin || !sameRoot(origin, repoRoot)) {
        // FOREIGN — another repo crashed mid-update of the shared surface.
        //
        // Block, and leave the journal EXACTLY where it is. Three reasons this
        // is the conservative answer rather than a lazy one:
        //  1. Rolling forward is not ours to do. The transaction is only half
        //     the install: the originating process writes the receipt AFTER it
        //     commits. Completing another repo's renames would leave that repo
        //     with files installed and no receipt — so its next install
        //     computes no deletes and orphans them.
        //  2. We cannot validate its repo-scoped entries against any root we
        //     trust, and INC-001's lesson is to fail closed when a path cannot
        //     be resolved — not to act on half of it.
        //  3. Blocking is bounded, loud, and self-healing: the originating repo
        //     recovers it on its next run and unblocks everyone. Installing
        //     over unverified partial state is silent and unbounded, on a
        //     surface every repo shares.
        // NOT quarantined: moving it would strand the record from the only
        // party who can resolve it automatically, converting a self-healing
        // state into a permanent human-gated one.
        return {
          ...none,
          foreign: true,
          foreignOrigin: origin,
          error: `an install started by another repo (${origin ?? 'origin unrecorded'}) left an unresolved transaction on the shared global skills surface at ${journalPath}. `
            + `This repo cannot safely recover it. Re-run the install in ${origin ?? 'the originating repo'} to complete recovery, `
            + 'or inspect that journal and delete it to unblock installs.',
        };
      }
    }

    const v = validateJournal(parsed, allowedRoots);
    if (!v.ok) {
      const q = quarantineJournal(journalPath, anchor.quarantineDir, v.error);
      return { ...none, error: `invalid journal: ${v.error}`, quarantined: q ?? undefined };
    }
    const journal = v.journal;

    // A journal marked 'rollback-failed' describes a VALID, partially-
    // resolved transaction whose in-process rollback attempt itself failed —
    // structurally different from a corrupt/foreign journal. It is never
    // safe to roll forward (that would complete the very transaction the
    // original process tried to abort) and there are no persisted
    // before-images to roll back with, so recovery refuses ALL automatic
    // action and performs NO filesystem mutation. The journal is left
    // exactly where it is (never quarantined) so the pre-flight
    // `existsSync` check keeps blocking future installs until a human
    // resolves it.
    if (journal.stage === 'rollback-failed') {
      return {
        ...none,
        error: `a prior install transaction failed during rollback and could not be safely auto-resolved at ${journalPath}. `
          + 'This repo cannot safely recover it automatically. Inspect the journal and the filesystem state it describes, '
          + 'then delete the journal to unblock installs once you have verified the state is acceptable.',
      };
    }

    let rolledForward = 0, rolledBack = 0;

    if (journal.stage === 'renaming') {
      // Roll forward — any staged .tmp file whose rename didn't complete.
      // Rename durability is fsynced here exactly as in executeTransaction's
      // Phase 3: recovery performs the SAME operation, so it needs the same
      // barrier and the same degradation reporting. Without this, a crash right
      // after recovery could lose the very rename recovery just completed, and
      // the degradation channel would be silent on the recovery path only.
      for (const { absPath, tmpPath } of journal.staged || []) {
        if (fs.existsSync(tmpPath)) {
          try {
            retrySync(() => fs.renameSync(tmpPath, absPath));
            rolledForward++;
            const d = fsyncDir(path.dirname(absPath), `target directory for ${absPath}`);
            if (!d.ok) degradations.push(d.degraded);
          } catch (err) {
            recoveryFailures.push({ absPath, reason: err.message });
            process.stderr.write(`  [recover] roll-forward failed for ${absPath}: ${err.message}\n`);
          }
        }
      }
      // Deletes were never reconciled if the crash landed in Phase 4.
      for (const d of journal.deletes || []) {
        const r = attemptDelete(d);
        if (r.kind === 'deleted' && r.degradation) {
          degradations.push(r.degradation);
        } else if (r.kind === 'conflict-skipped') {
          skippedDeletes.push({ absPath: d.absPath, reason: r.reason });
        } else if (r.kind === 'delete-failed') {
          skippedDeletes.push({ absPath: d.absPath, reason: r.reason });
          recoveryFailures.push({ absPath: d.absPath, reason: r.reason });
        }
      }
      if (recoveryFailures.length === 0) cleanupJournal(journalPath, 'recovery');
    } else {
      // stage === 'staged' — nothing was renamed yet; discard all .tmp files.
      // A leaked .tmp file is uniquely-named, harmless garbage (never read by
      // anything, never conflicts with a future transaction's own .tmp
      // files) — matching rollbackPartialTransaction()'s own equivalent
      // loop, a discard failure here never blocks journal cleanup. ENOENT
      // (already gone, a prior attempt converged on it) produces no output;
      // a real unlink failure is reported via `degradations` (informational,
      // non-blocking) so the operator has visibility without being blocked.
      for (const { tmpPath } of journal.staged || []) {
        if (fs.existsSync(tmpPath)) {
          try {
            retrySync(() => fs.unlinkSync(tmpPath));
            rolledBack++;
          } catch (err) {
            if (err.code !== 'ENOENT') {
              degradations.push({ code: err.code || 'UNKNOWN', what: `discard of orphaned ${tmpPath}` });
            }
          }
        }
      }
      cleanupJournal(journalPath, 'recovery');
    }

    return { recovered: true, rolledForward, rolledBack, skippedDeletes, degradations, recoveryFailures };
  } finally {
    releaseLock(lockPath);
  }
}

function defaultJournalPath() {
  return path.resolve('.audit-loop-install-txn.json');
}

export const _internals = {
  BENIGN_FSYNC_CODES,
  fsyncFile,
  fsyncDir,
  isWithinAllowedRoots,
  validateJournal,
  writeJournal,
  attemptDelete,
  quarantineJournal,
  quarantineDir: repoQuarantineDir,
  findUnresolvedQuarantine,
  touchesGlobalSurface,
  anchorFor,
  anchorForJournal,
  sameRoot,
  JOURNAL_VERSION,
};

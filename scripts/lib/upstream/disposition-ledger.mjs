/**
 * @fileoverview The committed closure-disposition ledger: how it is read,
 * merged, serialised, and how a `--apply` run mass-writes the entries a
 * reconciliation found missing.
 *
 * Split out of `commands.mjs` when the `--apply` machinery pushed that file
 * past the size ratchet. The seam is real, not cosmetic: everything here is
 * about ONE file on disk (`scripts/upstream-dispositions.json`) and the gates
 * that guard writing to it, whereas `commands.mjs` is about issue lifecycle
 * over the store.
 *
 * Plan: docs/plans/reconcile-attribution-and-base-freshness.md (Cluster B).
 *
 * @module scripts/lib/upstream/disposition-ledger
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawnSync } from 'child_process';

import { atomicWriteFileSync } from '../file-io.mjs';
import { withFileLock } from '../file-lock.mjs';
import { readFileAtRef } from '../git-freshness.mjs';
import {
  MISSING_CAUSE, isLegalTestDisposition, parseDisposition, LEGACY_UNTRACKED_TRANSITION,
  formatDisposition,
} from './dispositions.mjs';

/** Where the committed closure-disposition ledger lives (§2.4). */
export const DISPOSITION_LEDGER_PATH = 'scripts/upstream-dispositions.json';

/**
 * The branch a closure's ledger entry must reach before the reconcile gate stops
 * reporting it as a pending landing. It is the same default the pre-push hook and
 * `push-range.mjs` use for a new branch's merge-base. It is the FULLY QUALIFIED
 * remote-tracking ref, never the short name. A local branch literally named
 * `origin/main` would otherwise be read instead (see `readUpstreamLedgerEvidence`).
 * It is read as of the last fetch. Nothing here fetches.
 */
export const LANDING_BASE_REF = 'refs/remotes/origin/main';
const LANDING_BASE_DISPLAY = 'origin/main';

/**
 * Local git adapter. Duplicated from `commands.mjs` deliberately rather than
 * exported across the seam: it is four lines, and the alternative is a
 * circular import between two modules that are otherwise independent.
 */
function git(args, cwd) {
  return spawnSync('git', args, {
    cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
  });
}

/**
 * The ledger's directory must exist BEFORE the lock is taken, not merely before
 * the ledger is written. `atomicWriteFileSync` mkdirs its own target, so the
 * write was always safe — but `withFileLock` creates a sibling `.lock` file
 * first and does not, so in a repo where the directory is absent the lock
 * acquisition died on ENOENT before any writer ran. Both writers go through
 * here so the fix cannot be applied to one of them.
 *
 * @param {string} ledgerPath absolute path to the ledger file
 * @returns {string} the same path, for chaining
 */
function ensureLedgerDir(ledgerPath) {
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  return ledgerPath;
}

/**
 * Read the committed disposition ledger for a WRITE. An absent file (the
 * first-ever transition in a fresh checkout) is `[]`.
 *
 * A present-but-malformed or unreadable file THROWS (`code: 'LEDGER_MALFORMED'`),
 * before anything is written and before the store is transitioned. It used to
 * degrade to `[]` so a JSON typo could not block transitions. But both writers
 * merge into what this returns and then atomically REPLACE the file, so that
 * fallback turned a typo into "the whole ledger is now one entry", in valid JSON.
 * Nothing downstream could then tell corruption from a deliberate removal
 * (code-audit R1 H2/H4/H5, docs/plans/upstream-disposition-landing.md). Refusing
 * costs a hand-fix of the JSON. Not refusing costs the history.
 *
 * @param {string} repoRoot
 * @returns {Array<object>}
 */
function readDispositionLedger(repoRoot) {
  const read = readWorkingLedger(repoRoot);
  if (read.status === 'absent') return [];
  if (read.status === 'read') return read.entries;
  const err = new Error(`${DISPOSITION_LEDGER_PATH} is ${read.status}${read.reason ? ` (${read.reason})` : ''}. `
    + 'Refusing to write over it, because that would replace every entry. Repair the JSON, or restore it with '
    + `git checkout -- ${DISPOSITION_LEDGER_PATH}, then re-run. Nothing was written and the store was not touched.`);
  err.code = 'LEDGER_MALFORMED';
  throw err;
}

/**
 * Parse ledger bytes into a well-formed entry list, or `malformed`. This is the ONE
 * parser for every reader, and for the write path (`readDispositionLedger`), that
 * has to tell a broken ledger from an empty one. Nothing may read "unparseable" as
 * "no entries". A gate doing so turns a corrupt file into a clean reconciliation,
 * and a writer doing so overwrites the history (docs/plans/upstream-disposition-landing.md).
 *
 * @param {string} text
 * @returns {{status: 'read'|'malformed', entries: object[]|null, reason: string|null}}
 */
export function parseLedgerText(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { status: 'malformed', entries: null, reason: `not valid JSON (${err.message})` };
  }
  if (!parsed || !Array.isArray(parsed.entries)) {
    return { status: 'malformed', entries: null, reason: 'no top-level `entries` array' };
  }
  return { status: 'read', entries: parsed.entries, reason: null };
}

/**
 * The ledger as committed at `ref`. It is `absent` when the ref has no such file
 * (determinate), `unreadable` when the question could not be asked, and
 * `malformed` when the file is there but broken.
 *
 * @returns {{status: 'read'|'absent'|'unreadable'|'malformed', entries: object[]|null, reason: string|null}}
 */
export function readLedgerEntriesAtRef({ ref, repoRoot = process.cwd() }) {
  const read = readFileAtRef({ ref, filePath: DISPOSITION_LEDGER_PATH, repoRoot });
  if (read.status !== 'read') return { status: read.status, entries: null, reason: read.reason ?? null };
  return parseLedgerText(read.content);
}

/**
 * The ledger in the working tree. In the pre-push sandbox the working tree IS the
 * pushed commit, so this is the head side of the gate's comparison. It uses the
 * same statuses as `readLedgerEntriesAtRef`, so absent and malformed stay distinct.
 */
export function readWorkingLedger(repoRoot = process.cwd()) {
  const p = path.join(repoRoot, DISPOSITION_LEDGER_PATH);
  let text;
  try {
    text = fs.readFileSync(p, 'utf-8');
  } catch (err) {
    return err?.code === 'ENOENT'
      ? { status: 'absent', entries: null, reason: null }
      : { status: 'unreadable', entries: null, reason: err.message };
  }
  return parseLedgerText(text);
}

/**
 * Has this entry LANDED, i.e. does the base branch already carry it?
 * "Same" means same `state` and the same formatted disposition. Those are exactly
 * the two fields the reconcile gate compares, so a `recordedAt`-only difference
 * does not count as unlanded. PURE.
 *
 * `landed: null` means the base could not be read, so the answer is unknown,
 * never "no".
 *
 * @param {{entry: {issueId: string, state: string, disposition: {kind: string, value: string}},
 *   baseLedger: {status: string, entries: object[]|null, reason?: string|null}, baseDisplay?: string}} args
 * @returns {{landed: boolean|null, reason: string|null}}
 */
export function assessDispositionLanding({ entry, baseLedger, baseDisplay = LANDING_BASE_DISPLAY }) {
  if (baseLedger?.status === 'absent') return { landed: false, reason: `${baseDisplay} has no disposition ledger yet` };
  if (baseLedger?.status !== 'read') {
    return { landed: null, reason: `could not read the ledger on ${baseDisplay} (${baseLedger?.reason ?? baseLedger?.status ?? 'no evidence'})` };
  }
  const onBase = baseLedger.entries.find((e) => e?.issueId === entry.issueId);
  if (!onBase) return { landed: false, reason: `${baseDisplay} does not carry this entry yet (as of your last fetch)` };
  const same = onBase.state === entry.state && Boolean(onBase.disposition)
    && formatDisposition(onBase.disposition) === formatDisposition(entry.disposition);
  return same
    ? { landed: true, reason: null }
    : { landed: false, reason: `${baseDisplay} carries a DIFFERENT entry for this issue (as of your last fetch)` };
}

/**
 * The merge rule, as a PURE function over an entry list — extracted so the
 * single-entry writer and the batch `--apply` share one implementation.
 *
 * A batch cannot be N calls to the writer below: `--apply` re-checks a hash of
 * the ledger before writing, and with a write per row the FIRST write
 * invalidates the SECOND row's precondition — self-invalidating, aborting
 * halfway for a conflict that never happened. So the batch folds every row
 * through this in memory and writes once. Behaviour is unchanged for the
 * single-entry path, which is now read → merge → write over the same rule.
 *
 * `storeFingerprint` records WHICH database an issue lives in (a one-way digest
 * — this file is committed to a PUBLIC repo and one consumer's store is a
 * corporate internal host, so the hostname itself must never land here). Without
 * it, an entry closing a report filed by a consumer on a different store reads
 * as `ledgerOnly` to every reconcile run here and fails the push — the state
 * that forced five real closures to be deleted from this file by hand on
 * 2026-08-29. Written only when the caller could determine it; omitted
 * otherwise, because an INVENTED store value would be worse than none (it would
 * make the entry foreign to every run, and so permanently unreconcilable).
 *
 * @param {object[]} entries current ledger entries
 * @param {{issueId: string, state: string, disposition: object, storeFingerprint?: string|null}} entry
 * @returns {object[]} the merged list (input not mutated)
 */
export function mergeLedgerEntry(entries, entry) {
  // "Never asked" and "asked, unanswerable" are DIFFERENT, and conflating them is the
  // whole defect (2026-09-07). `null` is a real state — no DSN resolves, so the store is
  // genuinely unknown and the key is omitted rather than invented. `undefined` means the
  // author of this call never considered the question, and an entry written that way is
  // indistinguishable from a legacy one: `isForeign` skips it, so it is never partitioned
  // into `otherStore` and instead reconciles as `ledgerOnly` against any other store —
  // failing a push, which is the 2026-08-29 incident this field exists to prevent.
  //
  // Enforced HERE because this is the one function both writers pass through, so a third
  // writer inherits the requirement without anybody remembering to give it one. The
  // sibling suite that compares the two writers cannot catch this class: it hands both an
  // entry it built itself, so a caller's omission is upstream of everything it sees.
  if (entry?.storeFingerprint === undefined) {
    throw new TypeError(
      'mergeLedgerEntry: storeFingerprint is required — pass the fingerprint of the store '
      + 'this transition was made against, or an explicit `null` when no DSN resolves. '
      + 'It is a property of the CONNECTION, never of a row and never of a default.');
  }
  const prior = entries.find((e) => e?.issueId === entry.issueId);
  const withoutThis = entries.filter((e) => e?.issueId !== entry.issueId);
  // A re-transition that cannot determine the store must not STRIP one an
  // earlier write established — a read-modify-write is a constructor, and
  // silently dropping a field on re-write is how the entry would become
  // legacy-shaped again without anybody deciding that.
  const storeFingerprint = (typeof entry.storeFingerprint === 'string' && entry.storeFingerprint.trim())
    ? entry.storeFingerprint.trim()
    : (typeof prior?.storeFingerprint === 'string' && prior.storeFingerprint.trim()
      ? prior.storeFingerprint : null);
  return [...withoutThis, {
    schemaVersion: 1,
    issueId: entry.issueId,
    ...(storeFingerprint ? { storeFingerprint } : {}),
    state: entry.state,
    disposition: entry.disposition,
    recordedAt: new Date().toISOString(),
  }];
}

/**
 * Upsert one entry into the committed ledger, keyed by `issueId` (exactly one
 * active disposition per upstream issue — a re-transition on the same issue
 * REPLACES its prior entry rather than appending a second one).
 *
 * ASYNC: it takes the ledger lock. Read → merge → write over `mergeLedgerEntry`
 * and `serialiseDispositionLedger`,
 * deliberately holding NO rule of its own. It used to be a full second copy of
 * both while its docstring already claimed this composition — so an edit to the
 * merge rule would have been made in whichever path the author was reading, and
 * the other would have kept the old behaviour silently. That is the single-
 * writer path every `upstream fix` / `wont-fix` takes, and `--apply` is the
 * other; `tests/upstream-disposition-ledger-single-writer.test.mjs` now fails
 * the moment the two disagree.
 *
 * Called BEFORE the DB write (§2.4's sequential ledger-then-DB order) — the
 * cheap local write happens first, so a crash between this call and the DB
 * write leaves the ledger AHEAD of the store rather than the reverse; the
 * cloud reconciler (`upstream list --worksheet`) is the advisory backstop for
 * exactly that gap, not this function.
 *
 * @param {string} repoRoot
 * @param {{issueId: string, state: string, disposition: {kind: string, value: string}, storeFingerprint?: string|null}} entry
 */
export async function upsertDispositionLedgerEntry(repoRoot, entry) {
  const p = path.join(repoRoot, DISPOSITION_LEDGER_PATH);
  // Same lock as `applyMissingDispositions`, and for the same reason: this is a
  // read-modify-write on a file the batch path also rewrites, so a lock only one
  // of the two takes protects nothing.
  ensureLedgerDir(p);
  await withFileLock(`${p}.lock`, {}, async () => {
    atomicWriteFileSync(p, serialiseDispositionLedger(mergeLedgerEntry(readDispositionLedger(repoRoot), entry)));
  });
  // WHAT THE WRITE LEFT BEHIND (docs/plans/upstream-disposition-landing.md §2.3).
  // The entry now sits in a COMMITTED file, uncommitted in whatever checkout ran
  // this. Until it lands on the base branch, the reconcile gate reports this
  // issue on every push in the repo. Twice on 2026-10-10 nobody was told, and every
  // session's push failed until a hand-made one-file PR landed it. The caller
  // turns this descriptor into the operator notice and the envelope field.
  const landing = assessDispositionLanding({
    entry, baseLedger: readLedgerEntriesAtRef({ ref: LANDING_BASE_REF, repoRoot }),
  });
  return { path: DISPOSITION_LEDGER_PATH, written: true, base: LANDING_BASE_DISPLAY, ...landing };
}

/** The exact bytes the ledger file is written as — one serialiser, one format. */
export function serialiseDispositionLedger(entries) {
  const payload = {
    _description: 'The upstream-report closure-disposition ledger (consumer-friction-doctor plan §2.4). '
      + 'One entry per TERMINAL (fixed|wont_fix) upstream_issues row, naming EITHER a doctor probe that now '
      + 'detects the failure class, a tracked regression test that closes it, or a written exemption. '
      + 'Validated by `npm run upstream:coverage:gate`. Hand-authored source, same species as '
      + 'scripts/gate-contracts/_exemptions.json — never generated, never synced to consumers.',
    entries: [...entries].sort((a, b) => (a.issueId < b.issueId ? -1 : a.issueId > b.issueId ? 1 : 0)),
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

/**
 * Write the DB's disposition into the committed ratchet ledger for rows the
 * ledger is missing — the repair path for the gap `reconcile` could only report.
 *
 * **IT MUST NOT LAUNDER AN UNDISPOSITIONED CLOSURE.** The ledger exists so that
 * closing an upstream report cannot be a no-op; a repair tool that copies
 * whatever the store says would quietly undo that. INC-002's lesson is the
 * governing one — *"an env-gate that checks whether a variable is SET is not a
 * safety gate; it only proves intent, never that the target is safe"* — and the
 * analogue is exact: checking that a row HAS a disposition string is not
 * validation. It must RESOLVE.
 *
 * Five gates, and a row must clear every one:
 *
 *  1. the cause is `not-explained-by-staleness`. Refuses on `stale`, `mixed`
 *     AND `unknown` — repairing a stale checkout writes duplicates of entries
 *     already pushed, which is the near-miss this whole plan came from.
 *  2. the DB row carries a disposition `parseDisposition` accepts.
 *  3. it is NOT the `LEGACY_UNTRACKED_TRANSITION` sentinel — that value MEANS
 *     "needs human review", so applying it would convert a review flag into a
 *     clean record.
 *  4. it RESOLVES: `probe:` ids must exist in the registry, `test:` paths must
 *     be tracked and match the suite glob.
 *  5. `exempt:` requires `allowExempt` — an exemption is prose no referential
 *     check can validate, so a human authored it and a human confirms it.
 *
 * Then the mutation is bound to the state it was classified against: the
 * subject/upstream OIDs and a hash of the ledger are re-verified inside the
 * lock immediately before writing. HEAD moved 16 times in this worktree during
 * one sitting, so "the repo did not move" is not an assumption available for
 * free.
 *
 * @returns {{applied: string[], refused: Array<{issueId: string, gate: string, reason: string}>,
 *   wrote: boolean, aborted: string|null}}
 */
export async function applyMissingDispositions({
  repoRoot = process.cwd(), dbRows, missingIds, missingCause, allowExempt = false,
  probeIdsFn, trackedTestFilesFn, storeFingerprint,
}) {
  // Required, and deliberately without a default. `dbRows` came from ONE connection, and
  // only the caller knows which — the rows themselves cannot say, because the store does
  // not record which store it is. Defaulting here would recreate the defect this argument
  // was added to fix, one layer up from where it was found.
  if (storeFingerprint === undefined) {
    throw new TypeError(
      'applyMissingDispositions: storeFingerprint is required — pass the fingerprint of '
      + 'the store `dbRows` were read from, or an explicit `null` when no DSN resolves.');
  }
  const applied = [];
  const refused = [];

  if (missingCause?.cause !== MISSING_CAUSE.NOT_STALENESS) {
    return {
      applied, refused, wrote: false,
      aborted: `cause is "${missingCause?.cause ?? 'unknown'}" — repair is only safe when staleness has been ruled out`,
    };
  }

  const byId = new Map(dbRows.map((r) => [r.issueId, r]));
  const registryIds = new Set(probeIdsFn ? probeIdsFn() : []);
  const trackedTests = trackedTestFilesFn ? trackedTestFilesFn() : new Set();

  const candidates = [];
  for (const id of missingIds) {
    const row = byId.get(id);
    if (!row) { refused.push({ issueId: id, gate: 'db-row', reason: 'no terminal db row for this id' }); continue; }
    if (!row.disposition) { refused.push({ issueId: id, gate: 'disposition-present', reason: 'db row has no disposition' }); continue; }
    if (row.disposition === LEGACY_UNTRACKED_TRANSITION) {
      refused.push({ issueId: id, gate: 'legacy-sentinel', reason: 'carries the needs-human-review sentinel' });
      continue;
    }
    const parsed = parseDisposition(row.disposition);
    if (!parsed.ok) { refused.push({ issueId: id, gate: 'disposition-shape', reason: parsed.error }); continue; }
    if (parsed.kind === 'probe' && !registryIds.has(parsed.value)) {
      refused.push({ issueId: id, gate: 'probe-resolves', reason: `probe "${parsed.value}" is not in the registry` });
      continue;
    }
    if (parsed.kind === 'test') {
      const legal = isLegalTestDisposition(parsed.value, { trackedFiles: trackedTests });
      if (!legal.ok) { refused.push({ issueId: id, gate: 'test-resolves', reason: legal.reason }); continue; }
    }
    if (parsed.kind === 'exempt' && !allowExempt) {
      refused.push({ issueId: id, gate: 'exempt-opt-in', reason: 'an exemption is unverifiable prose — pass --allow-exempt to accept it' });
      continue;
    }
    // The stamp comes from the CALLER's connection, never from `row`:
    // `listTerminalUpstreamIssues` projects exactly {issueId, state, disposition}, so
    // `row.storeFingerprint` was `undefined` on every row and the old `?? null`
    // fallback always fired — an unreachable read wearing a considered fallback's
    // clothes. (`upstream_issues` does have a `fingerprint` column; it is the issue's
    // 64-hex CONTENT hash, and reaching for it here would poison the cross-store
    // partition — the 16-hex validator is what rejects that.)
    candidates.push({ issueId: id, state: row.state, disposition: { kind: parsed.kind, value: parsed.value }, storeFingerprint });
  }

  if (candidates.length === 0) return { applied, refused, wrote: false, aborted: null };

  const ledgerPath = path.join(repoRoot, DISPOSITION_LEDGER_PATH);

  // The token is the one captured AT CLASSIFICATION. A token this function
  // minted itself would only prove nothing changed while it ran — which is not
  // the question. Its absence is a refusal, not a skip: an optional safety
  // input whose omission passes is not a safety gate (INC-002's shape).
  const token = missingCause.precondition;
  if (!token?.headOid || !token?.ledgerHash) {
    return { applied, refused, wrote: false, aborted: 'no precondition was captured at classification — refusing to write blind' };
  }

  ensureLedgerDir(ledgerPath);
  return withFileLock(`${ledgerPath}.lock`, {}, async () => {
    // RE-VERIFY INSIDE THE LOCK — the precondition is a property of the batch,
    // checked once, immediately before the single write.
    //
    // HEAD is asked of git DIRECTLY, not via `resolveBaseFreshness`, which
    // returns `unknown` with a null oid whenever the UPSTREAM cannot resolve (a
    // local-only repo, a detached HEAD). Routing this through it made the check
    // silently inapplicable in exactly those repos — fail-OPEN inside the guard
    // whose purpose is to fail closed. Caught by its own test.
    const nowOid = git(['rev-parse', '--verify', '-q', 'HEAD^{commit}'], repoRoot);
    if (nowOid.status !== 0) {
      return { applied: [], refused, wrote: false, aborted: 'could not re-resolve HEAD to verify the repository did not move — refusing' };
    }
    if (String(nowOid.stdout).trim() !== token.headOid) {
      return { applied: [], refused, wrote: false, aborted: 'the repository moved after classification — re-run' };
    }
    const now = fs.existsSync(ledgerPath) ? fs.readFileSync(ledgerPath, 'utf-8') : '';
    if (crypto.createHash('sha256').update(now).digest('hex') !== token.ledgerHash) {
      return { applied: [], refused, wrote: false, aborted: 'the ledger changed on disk after classification — re-run' };
    }

    let entries = readDispositionLedger(repoRoot);
    for (const c of candidates) { entries = mergeLedgerEntry(entries, c); applied.push(c.issueId); }
    atomicWriteFileSync(ledgerPath, serialiseDispositionLedger(entries));
    return { applied, refused, wrote: true, aborted: null };
  });
}

/**
 * The repository facts a later mutation must still find true — commit AND
 * ledger bytes, read as one snapshot so they cannot describe different moments.
 */
export function captureReconcilePrecondition(repoRoot) {
  const head = git(['rev-parse', '--verify', '-q', 'HEAD^{commit}'], repoRoot);
  const ledgerPath = path.join(repoRoot, DISPOSITION_LEDGER_PATH);
  let ledgerHash = null;
  try {
    ledgerHash = crypto.createHash('sha256')
      .update(fs.existsSync(ledgerPath) ? fs.readFileSync(ledgerPath, 'utf-8') : '')
      .digest('hex');
  } catch { /* unreadable ⇒ null ⇒ `--apply` refuses below */ }
  return {
    headOid: head.status === 0 ? String(head.stdout).trim() : null,
    ledgerHash,
    capturedAt: new Date().toISOString(),
  };
}

/**
 * The upstream copy of the disposition ledger, as the tri-state
 * `classifyMissingCause` consumes. `no-upstream` is its own status because it is
 * DETERMINATE — there is no upstream that could have held the entries — while
 * `unreadable` means the question could not be asked.
 */
export function readUpstreamLedgerEvidence({ freshness, repoRoot = process.cwd() }) {
  if (!freshness?.upstream) {
    return { status: freshness?.reason === 'no-upstream' ? 'no-upstream' : 'unreadable', issueIds: null };
  }
  // ASK FOR THE QUALIFIED REF, NOT THE DISPLAY NAME. `freshness.upstream` is
  // the readable short form (`origin/main`) that `resolveUpstreamRef` renders
  // for messages; `upstreamRef` is the fully qualified name it VERIFIED
  // (`refs/remotes/origin/main`). git resolves `refs/heads/` before
  // `refs/remotes/`, so a local branch literally named `origin/main` makes the
  // short form read a DIFFERENT commit's ledger — evidence about the wrong
  // tree, fed straight into a classification that decides whether to write.
  // The two fields are separate for exactly this reason; dropping back to the
  // display name here discards the identity that was checked.
  const upstreamRef = freshness.upstreamRef || freshness.upstream;
  const read = readLedgerEntriesAtRef({ ref: upstreamRef, repoRoot });
  if (read.status === 'read') {
    return { status: 'read', issueIds: new Set(read.entries.map((e) => e?.issueId).filter(Boolean)) };
  }
  // A file that is there but not parseable means we looked and could not tell.
  // That is `unreadable`, never an empty set masquerading as a clean upstream.
  return { status: read.status === 'malformed' ? 'unreadable' : read.status, issueIds: null };
}

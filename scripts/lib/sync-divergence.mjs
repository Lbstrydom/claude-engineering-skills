/**
 * @fileoverview Consumer-divergence classifier for the sync — the missing half
 * of the ownership model.
 *
 * ## The defect class this closes
 *
 * `sync-to-repos.mjs` asks exactly one ownership question: *did a previous sync
 * write this destination?* A yes (an entry in the consumer's
 * `scripts/.sync-manifest.json`) has always licensed an UNCONDITIONAL
 * overwrite. It never asked the second question — *has the consumer changed it
 * since?* — so a consumer's deliberate, reviewed, MERGED divergence is reverted
 * silently, and the manifest that proves the sync did it is gitignored.
 *
 * Observed 2026-08-29 (upstream report `5b1a121e`, filed from `storyline`): a
 * sync at `14:11:25Z` reverted four separate pieces of already-merged work,
 * including a `.vscode/mcp.json` that went from pinned local paths to
 * `npx -y …@latest`. Only two of the four had consumer-side gates; the rest
 * would have been re-enshrined by any later `git commit -a`.
 *
 * ## Why the manifest is the right base
 *
 * The manifest already records the sha256 of what the LAST sync wrote to each
 * destination. That makes a three-way comparison free, with no new state:
 *
 *   base   = manifest[dst]  — what we wrote last time
 *   theirs = bytes on disk  — what is there now
 *   ours   = outbound bytes — what we would write now
 *
 * `theirs === base` means the consumer has not touched it, so an overwrite
 * destroys nothing no matter how far `ours` has moved. `theirs !== base` is the
 * consumer's own change, and that is the only case worth stopping for. Deriving
 * the signal this way is what keeps the gate from firing on every ordinary
 * upstream update — the failure mode that gets a gate `--force`d into
 * irrelevance.
 *
 * ## Why tracked-ness decides the severity
 *
 * A diverged destination under the gitignored tooling dir is a hand-edit of an
 * upstream-owned file: a governance violation the banner already forbids, whose
 * sanctioned remedy IS the re-sync. Warning is right there. A diverged TRACKED
 * file is the opposite — it is content the consumer's own history vouches for,
 * and there is no way to recover it after the write except from git. So the
 * split is `tracked ⇒ refuse`, `untracked ⇒ warn`, and it is derived from the
 * consumer's index, never from a path list that would drift from it.
 *
 * PURE decisions here; the one impure git adapter is `readVcsState`, isolated
 * so the decision table is testable without a git fixture (same split as
 * `lib/upstream/commands.mjs`).
 *
 * @module scripts/lib/sync-divergence
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import { LAYOUT_CONSTANTS } from './sync-path-map.mjs';
import { canonicalizeEol } from './file-io.mjs';

/**
 * The sync's OWN bookkeeping destinations, which are exempt from the
 * divergence gate and from the receipt's touched-file lists.
 *
 * Each carries a timestamp or a HEAD sha, so each differs on EVERY run by
 * construction — `scripts/.sync-manifest.json` is a synced asset AND a
 * per-run artifact at once. Gating on them would print "overwrote consumer
 * content" on every sync of every consumer, and a warning that fires when
 * nothing is wrong is a warning nobody reads: it would destroy the signal this
 * whole mechanism exists to create, on its first day. Listing them here, rather
 * than pattern-matching "looks volatile", keeps the exemption a closed set
 * somebody has to widen deliberately.
 */
export const SYNC_BOOKKEEPING_DESTS = Object.freeze(new Set([
  LAYOUT_CONSTANTS.MANIFEST_PATH,
  LAYOUT_CONSTANTS.IN_PROGRESS_JOURNAL,
  LAYOUT_CONSTANTS.OWNERSHIP_WATERMARK,
]));

/**
 * Is this destination the sync's own bookkeeping rather than bundle content?
 *
 * @param {string} destRel
 * @returns {boolean}
 */
export function isSyncBookkeeping(destRel) {
  return SYNC_BOOKKEEPING_DESTS.has(String(destRel || '').replace(/\\/g, '/'));
}

/**
 * Are two byte sequences the same content apart from CRLF-vs-LF?
 *
 * ## Why the divergence question must ask this
 *
 * The sync copies WORKING-TREE bytes, and two checkouts of the same commit do
 * not agree on line endings. Measured 2026-08-30 on
 * `.claude/hooks/bash-grep-nudge.mjs`, one commit, four trees:
 *
 * | tree                                   | bytes | CR |
 * |----------------------------------------|-------|----|
 * | this repo's linked worktree            |  2222 | 67 |
 * | this repo's main checkout              |  2155 |  0 |
 * | `wine-cellar-app` (synced from main)   |  2155 |  0 |
 * | `storyline` (synced from the worktree) |  2222 | 67 |
 *
 * `.gitattributes` already pins `* text=auto eol=lf`, and git calls the CRLF
 * copy **CLEAN** — that is the documented behaviour, not a misconfiguration.
 * So whichever checkout last synced a consumer decides that consumer's line
 * endings, and the next sync from the OTHER checkout sees a different sha and
 * concludes the consumer edited the file.
 *
 * That is precisely the AGENTS.md rule — *"the tell is a diff where git says
 * clean and your tool says changed: git is right, the tool is comparing the
 * wrong thing"* — and here it had teeth: the four hooks it hit are TRACKED in
 * the consumer, so the classifier fails closed to REFUSE, every sync to that
 * consumer exits 1, and the refusal carries the stale base forward so the
 * state is self-perpetuating. Four files blocked a whole consumer's bundle for
 * a difference no human made.
 *
 * ## Why NOT to canonicalise everywhere
 *
 * The manifest keeps hashing the exact bytes on disk, deliberately: there the
 * hash IS a transfer-integrity contract (`sync-isolation-verify` gate 2B), and
 * AGENTS.md is explicit that EOL folding does not belong where the exact bytes
 * are the contract. This fold applies to ONE question — *did the consumer
 * change this content?* — where a line ending introduced by a different
 * checkout is not an answer of "yes".
 *
 * ## Binary is excluded, and fails closed
 *
 * A NUL byte means the exact bytes are the contract, so binaries compare
 * strictly. Folding there could call two genuinely different files equal —
 * `0x0D 0x0A` is ordinary data in a binary, not a line ending.
 *
 * PURE. Accepts Buffers or strings.
 *
 * @param {Buffer|string} a
 * @param {Buffer|string} b
 * @returns {boolean}
 */
export function eolInsensitiveEqual(a, b) {
  const ba = Buffer.isBuffer(a) ? a : Buffer.from(String(a ?? ''), 'utf-8');
  const bb = Buffer.isBuffer(b) ? b : Buffer.from(String(b ?? ''), 'utf-8');
  if (ba.equals(bb)) return true;
  // `includes(0)` on a Buffer searches for the BYTE 0x00 — the standard
  // is-this-text test, and the same NUL-makes-it-binary rule git applies.
  if (ba.includes(0) || bb.includes(0)) return false;
  return canonicalizeEol(ba).equals(canonicalizeEol(bb));
}

/** How on-disk content relates to the base the last sync recorded. */
export const BASE_STATE = Object.freeze({
  /** No manifest entry — first sync, or the ownership record regressed. */
  NO_BASE: 'no-base',
  /** On disk exactly as we last wrote it. Overwriting destroys nothing. */
  PRISTINE: 'pristine',
  /** Changed since our last write. This is consumer content. */
  DIVERGED: 'diverged',
});

/** What the sync should do with one intended write. */
export const ACTION = Object.freeze({
  /** Write it. */
  WRITE: 'write',
  /** Write it, but say out loud that consumer content was replaced. */
  WRITE_LOUD: 'write-loud',
  /** Do not write: a `.sync-overrides.json` entry claims this path. */
  HOLD: 'hold',
  /** Do not write, and fail the target: this would revert consumer work. */
  REFUSE: 'refuse',
});

/**
 * Compare on-disk bytes to the base the last sync recorded.
 *
 * PURE. Hashes are compared as strings; the `sha256:` prefix the manifest uses
 * is tolerated on either side so callers need not normalise. A missing or
 * unparseable base is `NO_BASE`, never `PRISTINE` — absence of a record must
 * never read as "unchanged", which is the same fail-closed rule
 * `readBundleStamp` applies to `sourceDirty`.
 *
 * @param {{baseHash: string|null|undefined, diskHash: string|null|undefined}} input
 * @returns {'no-base'|'pristine'|'diverged'}
 */
export function classifyAgainstBase({ baseHash, diskHash }) {
  const strip = (h) => (typeof h === 'string' ? h.replace(/^sha256:/, '') : null);
  const base = strip(baseHash);
  const disk = strip(diskHash);
  if (!base) return BASE_STATE.NO_BASE;
  if (!disk) return BASE_STATE.NO_BASE;
  return base === disk ? BASE_STATE.PRISTINE : BASE_STATE.DIVERGED;
}

/**
 * Decide what to do with one intended write.
 *
 * PURE — every git fact arrives as an argument. Ordered precedence; first match
 * wins:
 *
 *   1. an override claims the path         → HOLD   (consumer said so, in-repo)
 *   2. base state is not DIVERGED          → WRITE
 *   3. diverged + operator passed the flag → WRITE_LOUD
 *   4. diverged + untracked in the consumer→ WRITE_LOUD
 *   5. diverged (tracked, or git unknown)  → REFUSE
 *
 * Rule 3 sits ABOVE the tracked test on purpose: `--overwrite-diverged` is the
 * documented escape hatch, and an escape hatch that still refuses is not one.
 * It stays loud, and the receipt records every path it consumed.
 *
 * Rule 5 has one sub-case with a different REMEDY, not a different action:
 * committed content whose base is still unabsorbed on a sync branch
 * (`vcs.staleSyncRef`, see `findUnabsorbedSyncBase`) is a checkout that is
 * behind its own sync PR. It still refuses — writing would leave uncommitted
 * edits that block the very pull that fixes it — but says "pull", never
 * "--overwrite-diverged".
 *
 * @param {object} input
 * @param {'no-base'|'pristine'|'diverged'} input.baseState
 * @param {{tracked: boolean|null, matchesHead: boolean|null, staleSyncRef?: string|null}|null} input.vcs
 * @param {boolean} input.overrideActive
 * @param {boolean} input.allowOverwriteDiverged
 * @returns {{action: 'write'|'write-loud'|'hold'|'refuse', reason: string}}
 */
export function decideAction({ baseState, vcs, overrideActive, allowOverwriteDiverged }) {
  if (overrideActive) return { action: ACTION.HOLD, reason: 'consumer-override' };
  if (baseState !== BASE_STATE.DIVERGED) return { action: ACTION.WRITE, reason: baseState };
  if (allowOverwriteDiverged) {
    return { action: ACTION.WRITE_LOUD, reason: 'diverged-overwrite-flag' };
  }
  if (vcs && vcs.tracked === false) {
    return { action: ACTION.WRITE_LOUD, reason: 'diverged-untracked' };
  }
  // `tracked: null` means git could not answer. Fail CLOSED: an unanswerable
  // question about whether we are about to destroy committed work is not
  // evidence that we are not. A consumer with no git at all is the one case
  // this inconveniences, and `--overwrite-diverged` covers it.
  if (vcs && vcs.matchesHead === true && vcs.staleSyncRef) {
    return { action: ACTION.REFUSE, reason: 'diverged-stale-checkout' };
  }
  return {
    action: ACTION.REFUSE,
    reason: vcs && vcs.matchesHead === true ? 'diverged-committed'
      : vcs && vcs.tracked === true ? 'diverged-uncommitted'
        : 'diverged-vcs-unknown',
  };
}

/**
 * One-line operator prose for a decision. Kept beside the decision table so a
 * new reason cannot ship without a message.
 *
 * @param {string} reason
 * @returns {string}
 */
export function describeReason(reason) {
  switch (reason) {
    // The two WRITE reasons. Not rendered on today's output lines — a plain
    // write says nothing — but present because the contract is "every reason
    // the table can emit has prose", and a contract with a hole in it is one a
    // future caller falls into.
    case BASE_STATE.NO_BASE:
      return 'no prior record of this destination — writing it fresh';
    case BASE_STATE.PRISTINE:
      return 'unchanged since our last sync — safe to replace';
    case 'consumer-override':
      return 'held by .sync-overrides.json';
    case 'diverged-committed':
      return 'content is COMMITTED in this repo — overwriting reverts merged work';
    case 'diverged-stale-checkout':
      return 'this checkout predates the last sync\'s own commit — NOT a consumer edit; merge that sync PR and pull, then re-sync';
    case 'diverged-uncommitted':
      return 'tracked, with uncommitted local changes — overwriting loses them irrecoverably';
    case 'diverged-vcs-unknown':
      return 'changed since our last sync and git could not say whether it is tracked';
    case 'diverged-untracked':
      return 'changed since our last sync; untracked here (upstream-owned — fix upstream, not this copy)';
    case 'diverged-overwrite-flag':
      return 'changed since our last sync; overwritten because --overwrite-diverged was passed';
    default:
      return reason;
  }
}

/**
 * Ask the consumer's git what it knows about one path. IMPURE.
 *
 * Two questions, two cheap execs, and only ever asked about a path already
 * known to be diverged — in steady state a handful per run, so this is not on
 * the hot path for the 751-file bundle.
 *
 * Never throws: any git failure yields `{tracked: null, matchesHead: null}`,
 * which `decideAction` treats as fail-closed.
 *
 * @param {string} repoRoot
 * @param {string} relPath — POSIX-separated, repo-relative
 * @returns {{tracked: boolean|null, matchesHead: boolean|null}}
 */
export function readVcsState(repoRoot, relPath) {
  const UNKNOWN = { tracked: null, matchesHead: null };
  const git = (args) => spawnSync('git', ['-C', repoRoot, ...args], {
    encoding: 'utf-8', windowsHide: true,
  });

  // "git answered no" and "git could not run" are DIFFERENT, and collapsing
  // them fails OPEN — the one direction this guard must never fail. git uses
  // exit 1 for an honest negative (`--verify --quiet` on a missing ref,
  // `ls-files --error-unmatch` on an unmatched path) and 128 for a fatal error
  // (not a repository, corrupt index, no HEAD yet). Anything that is not 0 or 1
  // is therefore an unanswered question, and `decideAction` refuses on it.
  const answered = (r) => !r.error && (r.status === 0 || r.status === 1);

  const head = git(['rev-parse', '--verify', '--quiet', `HEAD:${relPath}`]);
  if (!answered(head)) return UNKNOWN;
  const headBlob = head.status === 0 ? head.stdout.trim() : null;

  if (!headBlob) {
    // Not in HEAD. It may still be tracked (added, never committed) — that is
    // consumer work too, and `ls-files` is the only thing that can see it.
    const indexed = git(['ls-files', '--error-unmatch', '--', relPath]);
    if (!answered(indexed)) return UNKNOWN;
    return { tracked: indexed.status === 0, matchesHead: false };
  }

  const disk = git(['hash-object', '--', relPath]);
  if (disk.error || disk.status !== 0) return { tracked: true, matchesHead: null };
  return { tracked: true, matchesHead: disk.stdout.trim() === headBlob };
}

/** Branch prefix `sync:pr` commits a consumer's sync on (`branchNameFor`). */
export const SYNC_BRANCH_PREFIX = 'chore/sync-';

/**
 * Is the recorded base still sitting UNABSORBED on a sync branch — i.e. is this
 * checkout behind its own sync PR, rather than carrying a consumer edit? IMPURE.
 *
 * ## The incident
 *
 * 2026-09-29, `storyline`: 11 tracked files refused as "COMMITTED in this repo
 * — overwriting reverts merged work", with `--overwrite-diverged` offered as a
 * remedy. Every one was byte-identical to an OLDER upstream version; none
 * carried a storyline edit. `sync:pr` had committed the newer sync onto
 * `chore/sync-e3c29944`, switched back to `main` — which restored the old
 * committed bytes — and auto-merged the PR on GitHub. Nobody pulled. The
 * gitignored manifest still named the newer bytes as base, so disk ≠ base and
 * the classifier called our own stale content consumer work.
 *
 * ## The signal, and why it needs both halves
 *
 * 1. The base bytes are the tip content of some `chore/sync-*` ref (local or
 *    remote-tracking) — the sync's own commit holds exactly what it wrote.
 * 2. HEAD's history for this path never contained that blob.
 *
 * (1) alone is wrong: after the PR squash-merges and is pulled, the sync branch
 * is STILL "unmerged" by ancestry, so a genuine consumer edit made afterwards
 * would match (1) forever. (2) is what separates them — once HEAD absorbed the
 * base, any later difference is the consumer's.
 *
 * The base is the sha256 of the bytes the sync wrote, which may be CRLF (see
 * `eolInsensitiveEqual`); a blob is LF-normalised, so both forms are tried.
 *
 * Never throws; any git failure is `null` (the caller then keeps the generic
 * refusal, which is the fail-closed direction).
 *
 * @param {string} repoRoot
 * @param {string} relPath — POSIX-separated, repo-relative
 * @param {string|null|undefined} baseHash — manifest value, `sha256:` optional
 * @returns {string|null} the short ref name holding the base, or null
 */
export function findUnabsorbedSyncBase(repoRoot, relPath, baseHash) {
  const base = typeof baseHash === 'string' ? baseHash.replace(/^sha256:/, '') : null;
  if (!base) return null;
  const git = (args, opts = {}) => spawnSync('git', ['-C', repoRoot, ...args], {
    windowsHide: true, maxBuffer: 64 * 1024 * 1024, ...opts,
  });
  const text = (r) => (r.error || r.status !== 0 ? null : String(r.stdout).trim());

  const refs = text(git(['for-each-ref', '--format=%(refname:short)',
    `refs/heads/${SYNC_BRANCH_PREFIX}*`, `refs/remotes/*/${SYNC_BRANCH_PREFIX}*`], { encoding: 'utf-8' }));
  if (!refs) return null;

  const sha = (buf) => createHash('sha256').update(buf).digest('hex');
  for (const ref of refs.split('\n').filter(Boolean)) {
    const blob = text(git(['rev-parse', '--verify', '--quiet', `${ref}:${relPath}`], { encoding: 'utf-8' }));
    if (!blob) continue;
    const bytes = git(['cat-file', 'blob', blob]);
    if (bytes.error || bytes.status !== 0) continue;
    const lf = bytes.stdout;
    const matches = sha(lf) === base
      || (!lf.includes(0) && sha(Buffer.from(lf.toString('latin1').replace(/\r?\n/g, '\r\n'), 'latin1')) === base);
    if (!matches) continue;
    // Half (2): has HEAD ever held this exact blob at this path?
    const absorbed = git(['log', '-n', '1', '--format=%H', `--find-object=${blob}`, 'HEAD', '--', relPath],
      { encoding: 'utf-8' });
    if (absorbed.error || absorbed.status !== 0) return null;
    if (String(absorbed.stdout).trim()) return null;
    return ref;
  }
  return null;
}

/**
 * `readVcsState` plus the stale-checkout question, asked only when the answer
 * could change the remedy (committed content). IMPURE; never throws.
 *
 * @param {string} repoRoot
 * @param {string} relPath
 * @param {string|null|undefined} baseHash
 * @returns {{tracked: boolean|null, matchesHead: boolean|null, staleSyncRef: string|null}}
 */
export function readDivergenceVcs(repoRoot, relPath, baseHash) {
  const vcs = readVcsState(repoRoot, relPath);
  return {
    ...vcs,
    staleSyncRef: vcs.matchesHead === true ? findUnabsorbedSyncBase(repoRoot, relPath, baseHash) : null,
  };
}

/**
 * The operator-facing REFUSED block for one target. PURE — returns lines.
 *
 * Stale-checkout refusals get their own remedy and are kept OUT of the
 * "resolve one of three ways" list: for them `--overwrite-diverged` is the
 * wrong answer (it leaves uncommitted edits that block the pull that fixes
 * it), and printing it beside them is exactly what misled on 2026-09-29.
 *
 * @param {Array<{path: string, reason: string, staleSyncRef?: string|null}>} refusals
 * @param {{repoPath: string, receiptPath: string, overridesPath: string,
 *   colors?: {R?: string, Y?: string, D?: string, X?: string}}} ctx
 * @returns {string[]}
 */
export function formatRefusalReport(refusals, { repoPath, receiptPath, overridesPath, colors = {} }) {
  const { R = '', Y = '', D = '', X = '' } = colors;
  const lines = [`  ${R}REFUSED${X} ${refusals.length} file(s) changed in this repo since our last sync — not overwritten:`];
  for (const { path, reason, staleSyncRef } of refusals.slice(0, 20)) {
    const where = staleSyncRef ? ` [${staleSyncRef}]` : '';
    lines.push(`    ${R}diverged${X} ${path} ${D}(${describeReason(reason)})${where}${X}`);
  }
  if (refusals.length > 20) lines.push(`    ${D}... ${refusals.length - 20} more (all listed in ${receiptPath})${X}`);

  const stale = refusals.filter((r) => r.staleSyncRef);
  if (stale.length) {
    const refs = [...new Set(stale.map((r) => r.staleSyncRef))].join(', ');
    lines.push(`    ${Y}${stale.length} of these are this checkout lagging its own sync commit (${refs}), not consumer edits:${X}`);
    lines.push(`    ${D}  • merge that sync PR if still open, run \`git pull --ff-only\` in ${repoPath}, then re-run the sync — NOT --overwrite-diverged${X}`);
  }
  if (stale.length < refusals.length) {
    lines.push(`    ${D}Resolve ${stale.length ? 'the rest' : 'it'} one of three ways:${X}`);
    lines.push(`    ${D}  • keep the divergence: declare each path in ${overridesPath} with a reason${X}`);
    lines.push(`    ${D}  • adopt upstream: revert your change, then re-run the sync${X}`);
    lines.push(`    ${D}  • discard the divergence deliberately: re-run with --overwrite-diverged${X}`);
    lines.push(`    ${D}  If upstream's version is WRONG for consumers, say so: cross-skill.mjs upstream report${X}`);
  }
  return lines;
}

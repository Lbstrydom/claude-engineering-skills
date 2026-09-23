/**
 * @fileoverview Pure helpers for `sync-status.mjs` — separating a consumer's
 * dirty working tree into "written by the claude-engineering-skills sync" vs
 * "this repo's own edits".
 *
 * ## The defect this closes
 *
 * A sync writes `.claude/skills/**`, `.sync-receipt.json` and
 * `scripts/.sync-owned.json` straight into a consumer's working tree and never
 * commits them (see `sync-receipt.mjs`'s header for why self-committing was
 * rejected: the tree is the human's, and a commit would fire their hooks and
 * bundle unrelated staged work). The result sat as ordinary uncommitted
 * changes in `storyline` — byte-identical in `git status` to a person's own
 * unfinished edits — and had to be triaged by hand: open
 * `scripts/.sync-manifest.json` (gitignored, easy to forget exists), diff each
 * file, decide what's safe to commit.
 *
 * `scripts/.sync-owned.json` already exists as a COMMITTED, deterministic
 * answer to "is this path upstream's?" (see `sync-owned-sidecar.mjs`), and
 * `lib/upstream-ownership.mjs`'s `createUpstreamOwnershipOracle` already unions
 * it with git-ignore state as the single ownership oracle (`debt-review.mjs`
 * uses it the same way). This module is the missing last step: point that
 * oracle at `git status`'s own output instead of a curated candidate list, so
 * the classification a human used to do by hand runs automatically.
 *
 * @module scripts/lib/sync-status
 */

import { RECEIPT_PATH } from './sync-receipt.mjs';
import { OWNED_SIDECAR_RELATIVE_PATH, comparisonKey } from './sync-owned-sidecar.mjs';
import { SYNC_BOOKKEEPING_DESTS } from './sync-divergence.mjs';

/**
 * Sync-produced paths that `createUpstreamOwnershipOracle` cannot see, because
 * neither of its two sources describes them: the receipt and the sidecar are
 * the RECORD of what a sync did, not payload the sync copied from upstream, so
 * they never appear in the sidecar's own `paths` list, and both are committed
 * (never gitignored) by design. Listed once here, from the modules that own
 * each path string, so this can never drift into a second hand-typed spelling.
 */
export const EXTRA_SYNC_ARTIFACTS = Object.freeze(new Set(
  [RECEIPT_PATH, OWNED_SIDECAR_RELATIVE_PATH, ...SYNC_BOOKKEEPING_DESTS]
    .map((p) => comparisonKey(p)),
));

/**
 * Is either status column `R` (rename), as opposed to `C` (copy)? The two
 * share a wire format (see `parsePorcelainZ`) but NOT a semantics: a rename's
 * origin is gone (deleted, needs its removal captured), while a copy's origin
 * is a DIFFERENT, still-live file that may carry its own independent
 * classification. `/audit-code` round 3 H1: origin-inclusion logic that does
 * not distinguish the two could pull a copy's source into a commit under an
 * unrelated entry's authority, bypassing whatever `needsReview` verdict that
 * source earned on its own.
 *
 * @param {string} status
 * @returns {boolean}
 */
function isRenameStatus(status) {
  return status?.[0] === 'R' || status?.[1] === 'R';
}

/**
 * Parse `git status --porcelain=v1 -z` output into structured entries.
 *
 * `-z` is load-bearing, not a style choice: without it, a path containing a
 * space or a quote is unparseable from plain porcelain output with any
 * delimiter-based split. Each record is NUL-terminated; a rename/copy record
 * (X or Y is `R`/`C`) is followed by a SECOND NUL-terminated token — this MUST
 * be consumed either way to keep the stream aligned for the next record, but
 * it is only kept as `origPath` for a genuine RENAME (see `isRenameStatus`): a
 * copy's "origin" is a live, separately-classified file, not evidence about
 * the new path's own provenance.
 *
 * PURE — accepts the raw stdout string, never shells out itself.
 *
 * @param {string} output
 * @returns {Array<{status: string, path: string, origPath: string|null}>}
 */
export function parsePorcelainZ(output) {
  const tokens = String(output ?? '').split('\0').filter((t) => t.length > 0);
  const entries = [];
  let i = 0;
  while (i < tokens.length) {
    const record = tokens[i++];
    // `XY<space>PATH` — the two status columns, a space, then the path.
    const status = record.slice(0, 2);
    const entryPath = record.slice(3);
    const isRenameOrCopy = isRenameStatus(status) || status[0] === 'C' || status[1] === 'C';
    let secondToken = null;
    if (isRenameOrCopy && i < tokens.length) {
      secondToken = tokens[i++];
    }
    const origPath = isRenameStatus(status) ? secondToken : null;
    if (entryPath.length > 0) entries.push({ status, path: entryPath, origPath });
  }
  return entries;
}

/**
 * Is this entry's index/working-tree relationship unambiguous — i.e., is
 * there no STAGED content that could differ from the working-tree bytes we
 * hash-verify and `git commit -- <paths>` (which commits WORKING-TREE bytes,
 * verified empirically) would overwrite?
 *
 * Git's two-character porcelain status is `XY`: X = HEAD-vs-index (what's
 * staged), Y = index-vs-working-tree (what's staged further on top). Content
 * can only be LOST when BOTH are a real change — X says something was
 * staged, and Y says the working tree then diverged from THAT staged content.
 * When Y is blank, the index already equals the working tree, so hashing and
 * committing working-tree bytes touches nothing the index didn't already
 * agree with — true even for `R ` (a clean rename: X=`R`, Y=` `, nothing to
 * lose). `/audit-code` round 2 H1 was found on exactly the case where Y is
 * NOT blank: `MM` (staged edit, then a further unstaged edit) — the commit
 * silently discarded the staged version with no trace (verified empirically).
 *
 * @param {string} status — the two-character porcelain status
 * @returns {boolean}
 */
function hasUnambiguousIndexState(status) {
  const indexCol = status?.[0];
  const worktreeCol = status?.[1];
  const indexHasRealChange = indexCol !== ' ' && indexCol !== '?' && indexCol !== undefined;
  const worktreeHasFurtherChange = worktreeCol !== ' ' && worktreeCol !== '?' && worktreeCol !== undefined;
  return !(indexHasRealChange && worktreeHasFurtherChange);
}

/**
 * Split `git status` entries into sync-owned (verified), needing review, and
 * everything else. Each bucket holds full entries (not bare path strings) so
 * a caller building a commit can recover a rename's origin.
 *
 * **Ownership is not provenance** (`/audit-code` round 1, H1/H6/H7 —
 * `docs/plans/sync-output-drift-classification.md`). The sidecar/git-ignore
 * oracle answers "does the sync manage this PATH", never "did the sync write
 * these BYTES" — a hand-edit to an owned `SKILL.md`, or a human rename onto an
 * owned path, would otherwise inherit a "safe to commit" claim it never
 * earned. So an owned path only reaches `syncOwned` when `isVerifiedSyncOutput`
 * confirms the on-disk content matches what the last sync actually recorded
 * writing there (see `createProvenanceVerifier`) AND its index state is
 * unambiguous (see `hasUnambiguousIndexState`); everything else owned-but-
 * unverified goes to `needsReview` instead of being silently trusted.
 *
 * `EXTRA_SYNC_ARTIFACTS` affect OWNERSHIP ONLY, not provenance (round 2 M1 —
 * the receipt and sidecar are real files with real bytes and must earn
 * "verified" the same way as any other path; `sync-to-repos.mjs` records
 * their hashes into the manifest for exactly this reason). Neither the
 * sidecar nor git-ignore state can see these two paths at all, which is the
 * gap this constant closes — it does not grant them a provenance bypass.
 *
 * A rename is classified by EITHER of its two paths — if the file the sync
 * last wrote was renamed, the old path is still the evidence — UNLESS a
 * DIFFERENT entry in this same `git status` snapshot independently occupies
 * the origin path, as a FILE or as a DIRECTORY (`/audit-code` round 4 H1 +
 * round 5 H1, both confirmed with reproducible fixtures). The file case:
 * `git mv A B` then recreating a NEW file at `A` reports BOTH `R  B` (origin
 * `A`) AND a separate `?? A` in one snapshot. The directory case, verified
 * empirically: `git mv fileA fileB` then `mkdir fileA && echo … > fileA/inner`
 * reports `R  fileB` (origin `fileA`) alongside `?? fileA/inner.txt` — no
 * entry's path is the exact string `fileA`, but `git add -- './fileA'`
 * (a directory pathspec) recursively stages everything under it regardless,
 * including `fileA/inner.txt`, confirmed with `git status` showing it staged
 * afterward. Blindly including the origin in the rename's commit would sweep
 * that unrelated, independently-classified content into a commit it was
 * never part of — so a reoccupied origin (file OR directory) demotes the
 * WHOLE rename entry to `needsReview` rather than merely dropping the origin
 * from its pathspecs (per GPT's own round-4 recommendation: exclude the
 * conflicting rename as a unit).
 *
 * PURE. `isUpstreamOwned` and `isVerifiedSyncOutput` are injected so this
 * stays testable without a git fixture, a real sidecar, or a real manifest.
 *
 * @param {{entries: Array<{status: string, path: string, origPath: string|null}>,
 *           isUpstreamOwned: (rel: string) => boolean,
 *           isVerifiedSyncOutput: (entry: {path: string, origPath: string|null}) => boolean}} input
 * @returns {{syncOwned: Array<{status: string, path: string, origPath: string|null}>,
 *            needsReview: Array<{status: string, path: string, origPath: string|null}>,
 *            other: Array<{status: string, path: string, origPath: string|null}>}}
 */
export function classifyDirtyEntries({ entries, isUpstreamOwned, isVerifiedSyncOutput }) {
  const list = entries ?? [];
  // Every path this snapshot reports as its OWN current entry — checked
  // before classifying any rename's origin, since a live entry can be added
  // in any order relative to the rename that names it as an origin.
  const livePaths = list.map((e) => e.path);
  const liveSet = new Set(livePaths);
  // A directory pathspec matches everything under it — see this function's
  // header for the `mkdir`-after-rename fixture that reoccupies the origin as
  // a directory rather than a same-named file.
  const isReoccupied = (origPath) => liveSet.has(origPath)
    || livePaths.some((p) => p.startsWith(`${origPath}/`));
  const syncOwned = new Map();
  const needsReview = new Map();
  const other = new Map();
  for (const entry of list) {
    const candidates = entry.origPath ? [entry.path, entry.origPath] : [entry.path];
    const isExtraArtifact = candidates.some((p) => EXTRA_SYNC_ARTIFACTS.has(comparisonKey(p)));
    const owned = isExtraArtifact || candidates.some((p) => isUpstreamOwned(p));
    if (!owned) { other.set(entry.path, entry); continue; }
    const originReoccupied = !!entry.origPath && isReoccupied(entry.origPath);
    if (!originReoccupied && hasUnambiguousIndexState(entry.status) && isVerifiedSyncOutput(entry)) {
      syncOwned.set(entry.path, entry);
    } else {
      needsReview.set(entry.path, entry);
    }
  }
  const sorted = (m) => [...m.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { syncOwned: sorted(syncOwned), needsReview: sorted(needsReview), other: sorted(other) };
}

/**
 * Build the provenance check `classifyDirtyEntries` needs: does the on-disk
 * content at an entry's current path match the hash the last sync RECORDED
 * for it (checked under its pre-rename name first, since that is the identity
 * the manifest actually knows)?
 *
 * A match is real evidence — content hashes are identical only when the bytes
 * are. No manifest, no recorded hash for either candidate name, or a hash that
 * doesn't match all fail CLOSED to "unverified": absence of a record must
 * never read as "must be fine", the same rule this repo's divergence guard
 * (`sync-divergence.mjs`'s `BASE_STATE.NO_BASE`) already applies.
 *
 * PURE — `manifestFiles` and `hashOf` are both data/functions the caller
 * supplies; this module never touches the filesystem itself.
 *
 * @param {{manifestFiles: Record<string,string>|null, hashOf: (relPath: string) => string|null}} deps
 * @returns {(entry: {path: string, origPath: string|null}) => boolean}
 */
export function createProvenanceVerifier({ manifestFiles, hashOf }) {
  return (entry) => {
    if (!manifestFiles) return false;
    const candidateKeys = entry.origPath ? [entry.origPath, entry.path] : [entry.path];
    const expected = candidateKeys.map((k) => manifestFiles[k]).find((h) => typeof h === 'string');
    if (!expected) return false;
    const actual = hashOf(entry.path);
    return typeof actual === 'string' && actual === expected;
  };
}

/**
 * Expand a set of classified entries into the FULL pathspec set a COMMIT
 * needs — both sides of a rename, not just the destination.
 *
 * `/audit-code` round 2 H2: `classifyDirtyEntries` used to keep only
 * `entry.path`, so a rename's origin never reached `buildCommitSuggestion`.
 * Without it, `git add -- <newPath>` stages the addition but leaves the old
 * path's deletion uncommitted — git shows a rename only when BOTH sides land
 * in the same commit; naming just one leaves the old blob's path dangling as
 * a separate, uncommitted deletion. This set is for the COMMIT step only —
 * see `buildCommitSuggestion`'s header for why `git add` must NOT also target
 * the origin path.
 *
 * PURE.
 *
 * @param {Array<{path: string, origPath: string|null}>} classifiedEntries
 * @returns {string[]} de-duplicated, unsorted
 */
export function pathspecsForCommit(classifiedEntries) {
  const out = new Set();
  for (const e of classifiedEntries ?? []) {
    out.add(e.path);
    if (e.origPath) out.add(e.origPath);
  }
  return [...out];
}

/**
 * Wrap a string in POSIX single quotes — the only fully-literal shell
 * quoting: nothing between `'...'` is special except the quote character
 * itself, which gets the standard `'"'"'` escape (close the quote, emit one
 * literal quote via a double-quoted segment, reopen the quote). Applied to
 * BOTH paths and the commit message, closing `/audit-code` M2 (a message
 * containing `$(...)` executing as command substitution under the previous
 * double-quote-based escaping) in the same stroke.
 *
 * @param {string} s
 * @returns {string}
 */
function shellQuote(s) {
  return `'${String(s).replace(/'/g, "'\"'\"'")}'`;
}

/**
 * A path as a git PATHSPEC argument — shell-quoted, `--` before it so a
 * leading `-` can never be read as an option (`/audit-code` H3: a rename to
 * `./-A`), and `./`-prefixed so a leading `:` can never trigger git's
 * pathspec magic syntax (`:(exclude)…`) even if `GIT_LITERAL_PATHSPECS`
 * (below) were ever dropped from a copy-pasted fragment of the command.
 * Shell quoting alone defeats neither: `--` stops CLI option parsing, but
 * pathspec magic is git's OWN string syntax and starts however innocently
 * the shell delivers the argument.
 *
 * @param {string} p — repo-relative, forward-slash path
 * @returns {string}
 */
function pathspecArg(p) {
  return shellQuote(`./${p}`);
}

/**
 * Render the copy-paste commit suggestion for a set of verified sync-owned
 * paths. PURE.
 *
 * Pinned to `repoRoot` with `git -C` on BOTH commands (`/audit-code` H4/M4) —
 * without it, pasting the suggestion from a different working directory
 * silently stages or commits in the wrong repository. Scoped with
 * `git commit -m … -- <paths>`, not a bare `git commit` (`/audit-code`
 * H2/H5) — a pathspec-scoped commit records only the named paths' current
 * content and leaves anything else already staged untouched (verified
 * empirically: a `git add`ed unrelated file survives a scoped commit still
 * staged, never silently swept in). `--literal-pathspecs` on BOTH commands
 * (`/audit-code` H3, the wildcard half — Gemini final review G2: a plain CLI
 * flag, not `GIT_LITERAL_PATHSPECS=1`, since the env-var-prefix form is POSIX
 * shell syntax and is a syntax error pasted into PowerShell or cmd.exe): `--`
 * and a leading `./` stop option parsing and colon-magic, but git's glob
 * wildcards (`*`, `?`, `[...]`) are matched inside an ordinary pathspec
 * string regardless of quoting — this flag is git's own documented way to
 * disable pathspec magic (including globs) entirely for the whole invocation.
 *
 * **`git add` targets ONLY the current path of each entry — never a rename's
 * origin** (`/audit-code` round 2 H2, second pass, found empirically): after
 * `git mv` (the common case — most editors and `git status` itself surface a
 * rename this way), the origin path is ALREADY fully resolved in the index —
 * neither present on disk nor holding any further change — so
 * `git add -- <origin>` fails outright with "pathspec did not match any
 * files", aborting the whole `&&` chain before the commit ever runs.
 * `git commit -m … -- <pathspec>...` does not have this problem: verified
 * empirically that naming BOTH the current path and a rename's origin there
 * (with only the current path ever `git add`-ed) produces a correct rename
 * commit whether the rename was pre-staged via `git mv` or is a plain
 * unstaged filesystem rename — and per the H2/H5 note above, an unrelated
 * file staged before this command ran is still left untouched.
 *
 * @param {Array<{path: string, origPath?: string|null}>} entries
 * @param {{message?: string, repoRoot: string}} opts
 * @returns {string}
 */
export function buildCommitSuggestion(entries, { message = 'chore(sync): update audit-loop tooling', repoRoot }) {
  if (!repoRoot) {
    throw new Error('buildCommitSuggestion requires repoRoot — a suggested git command must be pinned to the repo it was computed for');
  }
  const gitC = `git --literal-pathspecs -C ${shellQuote(repoRoot)}`;
  const addTargets = [...new Set(entries.map((e) => e.path))].sort().map(pathspecArg).join(' ');
  const commitTargets = pathspecsForCommit(entries).sort().map(pathspecArg).join(' ');
  return `${gitC} add -- ${addTargets} && ${gitC} commit -m ${shellQuote(message)} -- ${commitTargets}`;
}

/**
 * Render sync-to-repos.mjs's end-of-run "safe to commit" line, or `null` when
 * there's nothing to report. Kept here rather than inline in the caller: that
 * file is already over file-size-ratchet.mjs's governed-file limit, and its
 * own header names `sync-to-repos.mjs` as a repeat offender for exactly this
 * kind of unmanaged growth.
 *
 * @param {{created: string[], updated: string[], sidecarWritten: boolean, statusCliRel: string, repoRoot: string}} input
 * @param {{G?: string, D?: string, X?: string}} [colors] — ANSI codes, caller's own
 * @returns {string|null}
 */
export function describeSafeToCommit(
  { created, updated, sidecarWritten, statusCliRel, repoRoot },
  { G = '', D = '', X = '' } = {},
) {
  const paths = [...new Set([
    ...created, ...updated,
    ...(sidecarWritten ? [OWNED_SIDECAR_RELATIVE_PATH, RECEIPT_PATH] : []),
  ])].sort();
  if (paths.length === 0) return null;
  // No renames in this caller's data (plain created/updated destination
  // lists), so every entry is its own origin.
  const entries = paths.map((path) => ({ path, origPath: null }));
  return `  ${G}safe to commit${X} ${D}(written by this sync — \`node ${statusCliRel}\` re-derives this list any time):${X}\n    ${buildCommitSuggestion(entries, { repoRoot })}\n  ${D}or, from the upstream repo, \`npm run sync:pr\` commits exactly this group on a branch, opens the PR and arms auto-merge.${X}`;
}

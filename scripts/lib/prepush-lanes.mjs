/**
 * @fileoverview The consumer pre-push hook's v16 early exits, as pure deciders: a push that lands no commit on a branch, and a push that
 * is a `sync:pr` commit. Plan: docs/plans/hook-fidelity-and-v15-field-gaps.md §2.1-2.2.
 *
 * Both exits skip a PAID code audit, so each is a positive proof and every doubt falls back to v15 behaviour (the audit runs, or the push
 * is refused UNMEASURED): an unreadable ref, a git error, a missing trailer, a receipt that disagrees, a path the sync does not own.
 * Facts are gathered by `prepush-step.mjs`; nothing here touches git, the filesystem or the network.
 *
 * @module scripts/lib/prepush-lanes
 */

/** The commit trailer `sync:pr` writes (a non-`AI-*` name: that namespace is reserved for ship-commit.mjs). */
export const SYNC_BUNDLE_TRAILER = 'Sync-Bundle';

const FULL_OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const ZERO = /^0+$/;

/**
 * The bundle sha a commit message claims, or null. Exactly ONE `Sync-Bundle:` line is accepted, in the message's last paragraph; two,
 * a short sha or a trailer buried in prose are all `null` (a forged-by-accident message must not pass).
 * @param {string} message
 * @returns {string|null}
 */
export function parseSyncBundleTrailer(message) {
  const text = String(message ?? '').replace(/\r\n/g, '\n').replace(/\n+$/, '');
  const lines = text.split('\n').filter((l) => new RegExp(`^${SYNC_BUNDLE_TRAILER}:`, 'i').test(l));
  if (lines.length !== 1) return null;
  const last = text.split(/\n\n/).pop().split('\n');
  if (!last.includes(lines[0])) return null;
  const m = new RegExp(`^${SYNC_BUNDLE_TRAILER}: ([0-9a-f]+)$`).exec(lines[0]);
  return m && FULL_OID.test(m[1]) ? m[1] : null;
}

/**
 * Does this push land a commit on a branch? `none` only when EVERY published ref is a tag and each tagged commit is proven published at
 * the push destination (reachable from a tip the destination itself advertised, not from a local remote-tracking ref).
 *
 * @param {{
 *   entries: Array<{remoteRef: string, localSha: string}>, malformed: number,
 *   tips: Array<string|null>,              — peeled commit of each non-deletion entry, parallel; null = unresolvable
 *   unpublishedCount: (tip: string) => number|null  — commits of `tip` the destination does not hold; null = unknown
 * }} input
 * @returns {{kind: 'none', tags: number} | {kind: 'code', reason: string}}
 */
export function decideLanding({ entries, malformed, tips, unpublishedCount }) {
  if (malformed > 0) return { kind: 'code', reason: 'a push line could not be parsed' };
  const published = entries.filter((e) => !ZERO.test(e.localSha));
  if (published.length === 0) return { kind: 'code', reason: 'no published ref update' };
  const branch = published.find((e) => !e.remoteRef.startsWith('refs/tags/'));
  if (branch) return { kind: 'code', reason: `${branch.remoteRef} is not a tag: a branch update lands commits` };
  if (tips.length !== published.length || tips.some((t) => typeof t !== 'string')) return { kind: 'code', reason: 'a pushed tag does not resolve to a commit' };
  for (const tip of tips) {
    const n = unpublishedCount(tip);
    if (n === null) return { kind: 'code', reason: 'the destination could not be asked what it already holds' };
    if (n > 0) return { kind: 'code', reason: `a pushed tag publishes ${n} commit(s) the destination does not hold` };
  }
  return { kind: 'none', tags: published.length };
}

/**
 * Is this push exactly one `sync:pr` commit touching only what the sync owns?
 *
 * @param {{
 *   entries: Array<{localRef: string, localSha: string, remoteRef: string, remoteSha: string}>, malformed: number,
 *   exportedBase: string|null, exportedHead: string|null,   — the range the hook exported
 *   commits: Array<{sha: string, parents: string[], message: string}>|null,   — base..head, newest first
 *   basePublished: boolean|null,                            — creation only: the parent is under a tip the destination advertised
 *   changes: Array<{status: string, path: string}>|null,
 *   receiptEntry: {source?: {repo?: unknown, commitSha?: unknown}}|null,
 *   isOwned: (change: {status: string, path: string}) => boolean,
 *   gitignoreBlockOnly: (() => boolean)|null
 * }} f
 * @returns {{syncLane: true, bundleSha: string, files: number} | {syncLane: false, reason: string}}
 */
export function decideSyncLane(f) {
  const no = (reason) => ({ syncLane: false, reason });
  if (f.malformed > 0 || f.entries.length !== 1) return no(`the push has ${f.entries.length} ref update(s); the sync lane takes exactly one`);
  const [u] = f.entries;
  if (ZERO.test(u.localSha)) return no('a deletion');
  if (!u.remoteRef.startsWith('refs/heads/')) return no(`${u.remoteRef} is not a branch`);
  if (!FULL_OID.test(u.localSha) || u.localSha !== f.exportedHead) return no('the pushed commit is not the range the hook exported');
  if (!Array.isArray(f.commits) || f.commits.length !== 1) return no(`the range holds ${Array.isArray(f.commits) ? f.commits.length : 'an unknown number of'} commit(s); sync:pr makes one`);
  const [c] = f.commits;
  if (c.sha !== f.exportedHead || c.parents.length !== 1) return no('the commit is a merge or a root commit');
  if (c.parents[0] !== f.exportedBase) return no('the commit is not directly over the range base');
  const creation = ZERO.test(u.remoteSha);
  if (creation) {
    if (f.basePublished !== true) return no('a new branch whose base the destination was not shown to hold');
  } else if (u.remoteSha !== f.exportedBase) {
    return no('rewritten history: the remote tip is not the range base');
  }
  const bundleSha = parseSyncBundleTrailer(c.message);
  if (!bundleSha) return no('no Sync-Bundle trailer');
  const src = f.receiptEntry?.source;
  if (typeof src?.commitSha !== 'string' || src.commitSha !== bundleSha || typeof src.repo !== 'string' || src.repo === '') {
    return no('the receipt in the pushed tree does not attest the trailer\'s bundle');
  }
  if (!Array.isArray(f.changes) || f.changes.length === 0) return no('the changed paths could not be established');
  for (const ch of f.changes) {
    if (ch.path === '.gitignore') {
      if (!f.gitignoreBlockOnly || f.gitignoreBlockOnly() !== true) return no('.gitignore changes outside the managed block');
      continue;
    }
    if (!f.isOwned(ch)) return no(`${ch.path} is not owned by the sync`);
  }
  return { syncLane: true, bundleSha, files: f.changes.length };
}

export const syncLaneLine = (bundleSha, files) => `sync-lane ${bundleSha} ${files}`;
export const notSyncLine = (reason) => `not-sync ${String(reason).replace(/[\r\n]+/g, ' ')}`;
export const landingLine = (tags, destination) => `landing none ${tags} tag update(s) whose commits ${destination} already holds`;
export const landingCodeLine = (reason) => `landing code ${String(reason).replace(/[\r\n]+/g, ' ')}`;

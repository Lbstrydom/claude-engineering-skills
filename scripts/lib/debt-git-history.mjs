/**
 * @fileoverview Phase D.8 — git-history-based debt metric derivation.
 *
 * Fallback source for `distinctRunCount` + `firstDeferredCommit` when the
 * event log is not available (e.g., CI without local .audit/local/ events).
 *
 * Uses `git log -S<topicId>` on the legacy single-file ledger, and the topic's own
 * entry file once the ledger is in per-entry storage, to find commits that touched
 * each entry. Each unique commit that touched the topicId represents a run
 * that persisted the entry (new or updated) — a lower bound on occurrences.
 *
 * This is LESS accurate than event-log-based derivation (events capture
 * surfaces/reopens/escalations which don't touch the ledger file). But it's
 * available everywhere git is available, making PR comments + CI useful
 * without requiring the local event log.
 *
 * @module scripts/lib/debt-git-history
 */

import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileKey, topicIdFilenameProblem } from './debt-ledger-files.mjs';

/**
 * The two places a topic's history lives: the legacy single file (searched by
 * pickaxe, as it always was) and — once the ledger is in per-entry storage —
 * the topic's own entry file, every commit to which concerns that topic alone.
 * Both, because a migrated ledger's earlier history is all in the legacy file:
 * reading only the entry file would date every entry's first deferral to the
 * migration commit (docs/plans/debt-ledger-per-entry-files.md §6).
 *
 * Paths stay as given (usually repo-relative) — git resolves pathspecs against
 * `cwd`, which is what the caller passes.
 */
function historyPaths(ledgerPath, topicId) {
  const lp = String(ledgerPath).split(path.sep).join('/');
  const dir = /\.json$/i.test(lp) ? lp.slice(0, -'.json'.length) : lp;
  return {
    legacy: `${dir}.json`,
    entry: topicIdFilenameProblem(topicId) ? null : `${dir}/entries/${fileKey(topicId)}.json`,
  };
}

/** `git log` lines, or [] when git is unavailable / not a repo / path never existed. */
function gitLogLines(args, { cwd, env }) {
  try {
    const out = execFileSync('git', ['log', ...args], {
      cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], ...(env ? { env } : {}),
    });
    return out.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Count distinct commits that recorded a change to a topicId.
 *
 * **A LOWER BOUND on real occurrences.** In the legacy single file, `git log -S`
 * reports only commits that added or removed the string — commits that merely
 * re-saved the file with the string present are NOT counted, so an entry added
 * once and updated 5 times returns 1 there. In per-entry storage every commit
 * that touched the entry's own file counts (one file, one topic). Commits are
 * unioned by sha across the two, so a migration never double-counts.
 *
 * This is fine for our PR-comment use case: we're signalling "this topic has
 * a persisted history" not "exact run count". The event-log-derived
 * distinctRunCount (Phase D.1) is the accurate metric when available.
 *
 * Returns 0 if git unavailable, file not tracked, or topicId not found.
 *
 * @param {string} topicId
 * @param {object} [opts]
 * @param {string} [opts.ledgerPath='.audit/tech-debt.json'] - either spelling
 * @param {string} [opts.cwd=process.cwd()]
 * @param {NodeJS.ProcessEnv} [opts.env] - when supplied, REPLACES the
 *   inherited `process.env` for this subprocess. Omitted (the default) →
 *   identical to today's full-ambient-inherit behaviour.
 * @returns {number}
 */
export function countCommitsTouchingTopic(topicId, {
  ledgerPath = '.audit/tech-debt.json',
  cwd = process.cwd(),
  env,
} = {}) {
  if (!topicId) return 0;
  const { legacy, entry } = historyPaths(ledgerPath, topicId);
  const shas = new Set(gitLogLines([`-S${topicId}`, '--format=%H', '--', legacy], { cwd, env }));
  if (entry) for (const sha of gitLogLines(['--format=%H', '--', entry], { cwd, env })) shas.add(sha);
  return shas.size;
}

/**
 * Find the commit that first introduced a topicId to the ledger.
 * Returns `{sha, subject, url}` or null if not found.
 *
 * Legacy file: the earliest pickaxe match (`-S` + `--reverse`). This used to
 * pass `--diff-filter=A` as well, which restricts matches to the commit that
 * CREATED the file — so any topic added in a later commit was never found.
 * Entry file: the commit that added it. The earlier of the two wins.
 *
 * @param {string} topicId
 * @param {object} [opts]
 * @param {string} [opts.ledgerPath='.audit/tech-debt.json'] - either spelling
 * @param {string} [opts.remoteUrl] - if provided, constructs a commit URL
 * @param {string} [opts.cwd=process.cwd()]
 * @param {NodeJS.ProcessEnv} [opts.env] - when supplied, REPLACES the
 *   inherited `process.env` for this subprocess.
 * @returns {{sha: string, subject: string, url?: string}|null}
 */
export function findFirstDeferCommit(topicId, {
  ledgerPath = '.audit/tech-debt.json',
  remoteUrl,
  cwd = process.cwd(),
  env,
} = {}) {
  if (!topicId) return null;
  const { legacy, entry } = historyPaths(ledgerPath, topicId);
  const FORMAT = '--format=%H%x09%ct%x09%s';
  const candidates = [
    gitLogLines(['--reverse', `-S${topicId}`, FORMAT, '--', legacy], { cwd, env })[0],
    entry ? gitLogLines(['--reverse', '--diff-filter=A', FORMAT, '--', entry], { cwd, env })[0] : undefined,
  ]
    .filter(Boolean)
    .map((line) => {
      const [sha, ct, ...subject] = line.split('\t');
      return { sha: (sha || '').trim(), ct: Number(ct), subject: subject.join('\t').trim() };
    })
    .filter((c) => /^[a-f0-9]{40}$/.test(c.sha))
    .sort((a, b) => a.ct - b.ct);
  if (!candidates.length) return null;
  const { sha, subject } = candidates[0];
  const result = { sha, subject };
  if (remoteUrl) result.url = buildCommitUrl(remoteUrl, sha);
  return result;
}

/**
 * Derive the GitHub repo URL from `git remote get-url origin` so we can
 * construct commit links without requiring the caller to pass it explicitly.
 * Returns null if origin not a recognized GitHub URL.
 *
 * @param {object} [opts]
 * @param {string} [opts.cwd=process.cwd()]
 * @param {NodeJS.ProcessEnv} [opts.env] - when supplied, REPLACES the
 *   inherited `process.env` for this subprocess.
 * @returns {string|null} e.g. "https://github.com/owner/repo"
 */
export function detectGitHubRepoUrl({ cwd = process.cwd(), env } = {}) {
  try {
    const out = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], ...(env ? { env } : {}),
    }).trim();
    // Normalize: git@github.com:owner/repo.git → https://github.com/owner/repo
    //            https://github.com/owner/repo.git → https://github.com/owner/repo
    const sshMatch = out.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
    if (sshMatch) return `https://github.com/${sshMatch[1]}/${sshMatch[2]}`;
    const httpsMatch = out.match(/^https?:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/);
    if (httpsMatch) return `https://github.com/${httpsMatch[1]}/${httpsMatch[2]}`;
    return null;
  } catch {
    return null;
  }
}

/**
 * Build a commit URL for a given repo + SHA.
 * @param {string} repoUrl e.g. "https://github.com/owner/repo"
 * @param {string} sha
 * @returns {string}
 */
export function buildCommitUrl(repoUrl, sha) {
  return `${repoUrl.replace(/\.git$/, '').replace(/\/$/, '')}/commit/${sha}`;
}

/**
 * Derive distinctRunCount (fallback) for a set of entries. Uses git-log
 * counting. Returns a Map<topicId, count>.
 *
 * @param {object[]} entries
 * @param {object} [opts]
 * @returns {Map<string, number>}
 */
export function deriveOccurrencesFromGit(entries, opts = {}) {
  const result = new Map();
  for (const e of entries || []) {
    if (!e.topicId) continue;
    result.set(e.topicId, countCommitsTouchingTopic(e.topicId, opts));
  }
  return result;
}

// ── Staleness preflight ──────────────────────────────────────────────────

/**
 * Count commits touching any of an entry's `affectedFiles` at or after its
 * `deferredAt` timestamp. A non-zero count does NOT prove the finding was
 * fixed -- only that the file changed since filing and the entry needs a
 * fresh read before being trusted as live work. A zero count is the
 * stronger signal: nothing has touched the file since the entry was filed,
 * so the original disposition almost certainly still holds.
 *
 * This is the preflight a debt entry (topicId 3040a87641ef) asked the
 * clustering pipeline to run: "diff each candidate deferredAt against git
 * log for its file before presenting a cluster as work." Without it, a
 * 24-entry cluster on one file sat open in the ledger for a month after
 * every one of its entries had already been fixed -- all 24 predated the
 * fixing commit by 3-6 weeks, and nothing in debt-review ever compared the
 * two.
 *
 * Fails open (returns 0) on any git error, matching this module's other
 * git-log helpers -- git unavailability degrades the signal to "assume
 * fresh", never to blocking the review.
 *
 * @param {object} entry - hydrated debt entry ({deferredAt, affectedFiles})
 * @param {object} [opts]
 * @param {string} [opts.cwd=process.cwd()]
 * @param {NodeJS.ProcessEnv} [opts.env] - when supplied, REPLACES the
 *   inherited `process.env` for this subprocess.
 * @returns {number} commits touching any affectedFile since deferredAt
 */
export function countCommitsSinceDefer(entry, { cwd = process.cwd(), env } = {}) {
  const files = (entry?.affectedFiles || []).filter(Boolean);
  const deferredAt = entry?.deferredAt;
  if (files.length === 0 || !deferredAt || !Number.isFinite(Date.parse(deferredAt))) return 0;
  try {
    const out = execFileSync('git', [
      'log',
      '--oneline',
      `--since=${deferredAt}`,
      '--',
      ...files,
    ], { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], ...(env ? { env } : {}) });
    if (!out) return 0;
    return out.trim().split('\n').filter(Boolean).length;
  } catch {
    // git unavailable, not a repo, or an affected path never tracked
    return 0;
  }
}

/**
 * Annotate debt entries with `countCommitsSinceDefer` and return only the
 * ones with at least one post-defer commit -- the candidates that need a
 * fresh code read before a cluster containing them is presented as work.
 *
 * @param {object[]} debtEntries
 * @param {object} [opts]
 * @returns {{topicId: string, commitsSinceDefer: number}[]}
 */
export function findPossiblyStaleEntries(debtEntries, opts = {}) {
  const result = [];
  for (const e of debtEntries || []) {
    if (!e?.topicId) continue;
    const commits = countCommitsSinceDefer(e, opts);
    if (commits > 0) result.push({ topicId: e.topicId, commitsSinceDefer: commits });
  }
  return result;
}

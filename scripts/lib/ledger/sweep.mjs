/**
 * @fileoverview `ledger sweep-reverts`: close the observation window of merged
 * outcomes (docs/plans/own-model-decision-ledger.md decision 13).
 *
 * An absent outcome means UNKNOWN, never success, so a merged event only gets an
 * `observed-clean` child when (a) the remote default branch was freshly fetched
 * (the commit that fetch RETURNED, not a tracking ref), (b) it provably contains
 * the merge sha, (c) the scanned history reaches back to the OLDEST candidate in
 * the page (a revert can only follow its merge), and (d) no revert of it appears.
 * Anything less produces NO row: the candidate is retried next sweep.
 *
 * Candidates are this repository's only (ancestry in the cwd's history does not
 * establish which repo a ledger row came from), and a derived observation carries
 * its SOURCE event's purge generation, so a purge that landed after selection still
 * refuses it. The child's `event_id` is a deterministic UUIDv5 of its parent, so
 * two sweepers (or a replay after an outage) collapse on `event_id UNIQUE`.
 *
 * Pure helpers are exported for tests; `sweepReverts` takes injectable git/store
 * dependencies.
 *
 * @module scripts/lib/ledger/sweep
 */
import { execFileSync } from 'node:child_process';
import { observationEventId } from './work-item.mjs';

export const OBSERVATION_WINDOW_DAYS = 7;
/** Merges older than this are left unobserved: the history scan is bounded. */
export const MAX_WINDOW_DAYS = 365;

/** Shas named by `This reverts commit <sha>` lines in `git log --format=%H%n%B%x00` output. */
export function parseRevertedShas(logText) {
  const out = new Set();
  for (const m of String(logText ?? '').matchAll(/This reverts commit ([0-9a-f]{40,64})/g)) out.add(m[1]);
  return out;
}

/**
 * Decide the observation for each candidate. PURE.
 * @param {Array<{event_id: string, purge_generation?: string|number, payload: {merge_sha?: string, ref: string}, repo_name?: string|null, work_item_id?: string|null, coordinator?: string}>} candidates
 * @param {{revertedShas: Set<string>, contains: (sha: string) => boolean, nowIso: string}} h
 * @returns {{emit: object[], generationOf: Map<string, number>, unobserved: Array<{event_id: string, reason: string}>}}
 *   `generationOf` maps a derived event_id to its SOURCE event's purge generation.
 */
export function planObservations(candidates, { revertedShas, contains, nowIso }) {
  const emit = [];
  const generationOf = new Map();
  const unobserved = [];
  for (const c of candidates) {
    const sha = c.payload?.merge_sha;
    if (!sha) { unobserved.push({ event_id: c.event_id, reason: 'no-merge-sha' }); continue; }
    if (!contains(sha)) { unobserved.push({ event_id: c.event_id, reason: 'merge-sha-not-in-history' }); continue; }
    const kind = revertedShas.has(sha) ? 'reverted' : 'observed-clean';
    const id = observationEventId(c.event_id);
    generationOf.set(id, Number(c.purge_generation ?? 0));
    emit.push({
      kind: 'outcome',
      event_id: id,
      parent_event_id: c.event_id,
      work_item_id: c.work_item_id ?? null,
      repo: c.repo_name ?? null,
      coordinator: c.coordinator ?? 'other',
      actor: 'system',
      event_at: nowIso,
      payload: { kind, ref: c.payload.ref, merge_sha: sha, observation_window_days: OBSERVATION_WINDOW_DAYS },
    });
  }
  return { emit, generationOf, unobserved };
}

const git = (cwd, args, timeout = 60000) => execFileSync('git', args, { cwd, encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });

/** `origin/<default>` for the repo at cwd (symbolic-ref, falling back to origin/main). */
export function remoteDefaultRef(cwd) {
  try { return git(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).trim(); } catch { return 'origin/main'; }
}

/**
 * Real git dependencies: fetch the remote default branch and read ITS history once.
 * @returns {{ok: true, ref: string, revertedShas: Set<string>, contains: (sha: string) => boolean} | {ok: false, reason: string}}
 */
export function readRemoteHistory(cwd, { windowDays = 30 } = {}) {
  const branch = remoteDefaultRef(cwd).replace(/^origin\//, '');
  const firstLine = (err) => String(err.message).split('\n')[0].slice(0, 120);
  // Fetch into a PRIVATE ref named for this process. Neither FETCH_HEAD (a shared file any concurrent fetch in the worktree
  // overwrites between our two git calls) nor the remote-tracking ref (only updated when the configured mapping says so) is a
  // safe place to read "what THIS fetch returned"; a ref nobody else writes is.
  const priv = `refs/own-model/sweep-${process.pid}`;
  try { git(cwd, ['fetch', '--quiet', 'origin', `+refs/heads/${branch}:${priv}`], 120000); } catch (err) { return { ok: false, reason: `fetch-failed:${firstLine(err)}` }; }
  try {
    if (git(cwd, ['rev-parse', '--is-shallow-repository']).trim() === 'true') return { ok: false, reason: 'shallow-history' };
    const tip = git(cwd, ['rev-parse', '--verify', `${priv}^{commit}`]).trim();
    try { git(cwd, ['update-ref', '-d', priv]); } catch { /* a leftover private ref is harmless: the next sweep force-updates it */ }
    const log = git(cwd, ['log', tip, `--since=${windowDays} days ago`, '--format=%H%n%B%x00']);
    return {
      ok: true, ref: tip, revertedShas: parseRevertedShas(log),
      contains: (sha) => { try { git(cwd, ['merge-base', '--is-ancestor', sha, tip], 20000); return true; } catch { return false; } },
    };
  } catch (err) {
    return { ok: false, reason: `history-unreadable:${firstLine(err)}` };
  }
}

/**
 * One bounded sweep page.
 * @param {{cwd?: string, limit?: number, after?: object|null, repoName?: string|null, deps: {listCandidates: Function, submit: (e: object, o?: {purgeGeneration?: number}) => Promise<{state: string}>, readHistory?: Function, nowIso?: string}}} a
 * @returns {Promise<{status: string, candidates: number, emitted: number, unobserved: number, results: Record<string, number>, next: object|null}>}
 */
export async function sweepReverts({ cwd = process.cwd(), limit = 200, after = null, repoName = null, deps }) {
  const nowIso = deps.nowIso ?? new Date().toISOString();
  const all = await deps.listCandidates({ olderThanDays: OBSERVATION_WINDOW_DAYS, limit, after, repoName });
  const ageDays = (c) => (Date.parse(nowIso) - Date.parse(c.event_at)) / 86_400_000;
  const candidates = all.filter((c) => ageDays(c) <= MAX_WINDOW_DAYS);
  const tooOld = all.length - candidates.length;
  const last = all[all.length - 1];
  const next = all.length === limit && last ? { eventAt: last.event_at, eventId: last.event_id } : null;
  if (candidates.length === 0) return { status: 'ok', candidates: all.length, emitted: 0, unobserved: tooOld, results: {}, next };

  // The scan must reach back to the OLDEST candidate: a revert can only come after its merge, so scanning from the oldest
  // merge sees every revert of every candidate in the page, and absence is evidence only inside that window.
  const windowDays = Math.min(MAX_WINDOW_DAYS + 2, Math.ceil(Math.max(...candidates.map(ageDays))) + 2);
  const history = (deps.readHistory ?? readRemoteHistory)(cwd, { windowDays });
  if (!history.ok) return { status: history.reason, candidates: all.length, emitted: 0, unobserved: 0, results: {}, next: after };

  const plan = planObservations(candidates, { revertedShas: history.revertedShas, contains: history.contains, nowIso });
  const results = {};
  for (const e of plan.emit) {
    const r = await deps.submit(e, { purgeGeneration: plan.generationOf.get(e.event_id) });
    results[r.state] = (results[r.state] ?? 0) + 1;
  }
  return { status: 'ok', candidates: all.length, emitted: plan.emit.length, unobserved: plan.unobserved.length + tooOld, results, next };
}

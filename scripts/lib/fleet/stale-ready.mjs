/**
 * @fileoverview Stale ready marks (plan docs/plans/fleet-feedback-cluster2-claims-turns.md D3): the pure classifier behind
 * `fleet release --stale-ready`. Split out of `overlap.mjs`, which sits at the file-size limit.
 *
 * @module scripts/lib/fleet/stale-ready
 */
import { toMs } from './overlap.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

export const STALE_READY_DEFAULT_DAYS = 14;
export const STALE_READY_MAX_DAYS = 3650;

/**
 * Stale ready marks (plan cluster 2, D3), from status items. Two classes, each judged on evidence it can READ:
 *  - `landed`: merged evidence is `known` and `merged === true` (it covers the branch's EXACT current tip; `'partially'`
 *    means commits came after the merge and is NOT landed) - the mark is moot, the work is on base.
 *  - `aged`: merged evidence is `known` and not `true`, the head moved since the mark (`readyStale`), and the mark
 *    (`ready.at`) is at least `days` old. Age plus a moved head proves the MARK is dead, never that the session is -
 *    the caller invalidates the mark and leaves the session and its claim alone.
 * Unreadable merged evidence (or none gathered) lists the session in `skipped` with the reason, in neither class: an old
 * mark may be a merged one we cannot see. A missing or unparseable `ready.at` is skipped, never aged.
 * @param {object[]} items status items
 * @param {{now: Date|number|string, days?: number}} opts `days`: a whole number 1..STALE_READY_MAX_DAYS
 * @returns {{landed: object[], aged: object[], skipped: Array<{id: string, reason: string}>}}
 */
export function staleReadyMarks(items, { now, days = STALE_READY_DEFAULT_DAYS }) {
  const nowMs = toMs(now);
  if (nowMs === null) throw new Error('staleReadyMarks: `now` is required');
  if (!Number.isInteger(days) || days < 1 || days > STALE_READY_MAX_DAYS) throw new Error(`staleReadyMarks: days must be a whole number from 1 to ${STALE_READY_MAX_DAYS}`);
  const out = { landed: [], aged: [], skipped: [] };
  for (const i of items) {
    if (!i.tracked || i.state !== 'ready' || !i.ready) continue;
    const key = { id: i.id, gen: i.gen, rev: i.rev, readyOid: i.ready.oid, tip: i.oid ?? null };
    // Only a branch-sourced session can have its tip re-read locally at apply time; a PR-sourced one is never listed as actionable.
    if (i.kind !== 'branch') { out.skipped.push({ id: i.id, reason: 'a PR-sourced session is not verified by this command' }); continue; }
    if (!i.oid) { out.skipped.push({ id: i.id, reason: 'its branch tip could not be read' }); continue; }
    const m = i.merged;
    if (!m || m.known !== true) { out.skipped.push({ id: i.id, reason: m?.reason ? `merged evidence unreadable (${m.reason})` : 'merged evidence not gathered' }); continue; }
    if (m.merged === true) { out.landed.push({ ...key, class: 'landed', via: m.via ?? null, pr: m.pr ?? null }); continue; }
    if (!i.readyStale) continue;
    const at = Date.parse(i.ready.at);
    if (!Number.isFinite(at)) { out.skipped.push({ id: i.id, reason: 'the ready mark has no valid timestamp' }); continue; }
    if (nowMs - at >= days * DAY_MS) out.aged.push({ ...key, class: 'aged', ageDays: Math.floor((nowMs - at) / DAY_MS) });
  }
  return out;
}

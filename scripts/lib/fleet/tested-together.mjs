/**
 * @fileoverview "Have the ready branches been tested TOGETHER?" — the `fleet status` hint that tells the coordinator a
 * fast-tier probe (`land --dry-run --tier <name>`) is due (consumer report 2026-11-15, item 2: a clash between two ready
 * branches surfaced only at the full train, hours after the second became ready).
 *
 * The ready set is the (id, ready oid) pairs `land` would take. It counts as tested together when ONE train or probe
 * manifest carries every pair at the same oid AND got as far as a verdict (a tier result, or a conflict). A head that moves
 * changes its oid, so the set is untested again — which is what "re-run when a ready head moves" means. Pure: the caller
 * lists the manifests (real trains and probes).
 *
 * @module scripts/lib/fleet/tested-together
 */

/** The ready (id, oid) pairs `land` would take, from a `buildStatus` result. */
export const readySet = (status) => status.items
  .filter((i) => status.landingOrder.includes(i.id) && i.ready?.oid)
  .map((i) => ({ id: i.id, oid: i.ready.oid }));

const reachedVerdict = (t) => Boolean(t.conflict) || (t.tierResults ?? []).length > 0;

/**
 * @param {Array<{id: string, oid: string}>} ready
 * @param {object[]} manifests - train and probe manifests
 * @returns {{count: number, tested: boolean, by: object|null}|null} null when fewer than two branches are ready
 */
export function testedTogether(ready, manifests) {
  if (ready.length < 2) return null;
  const covers = (t) => ready.every((r) => (t.sources ?? []).some((s) => s.id === r.id && s.oid === r.oid));
  const hits = manifests.filter((t) => reachedVerdict(t) && covers(t)).sort((a, b) => String(b.updatedAt ?? b.createdAt).localeCompare(String(a.updatedAt ?? a.createdAt)));
  return { count: ready.length, tested: hits.length > 0, by: hits[0] ?? null };
}

/**
 * The status line, or null when there is nothing to say (under two ready branches).
 * @param {{count: number, tested: boolean, by: object|null}|null} r
 * @param {{cmd?: string, probeTier?: string|null}} [o] - the first pre-land tier, the one a probe should run
 */
export function testedTogetherLine(r, { cmd = 'fleet', probeTier = null } = {}) {
  if (!r) return null;
  if (r.tested) {
    const t = r.by;
    const verdict = t.conflict ? `CONFLICT at ${t.conflict.sourceId}` : t.result ?? 'none';
    const what = (t.tierResults ?? []).map((x) => x.name).join('+') || 'no tier';
    return `ready set (${r.count} branches) tested together in ${t.trainId} (${what}): ${verdict}`;
  }
  const run = `${cmd} land --dry-run --tier ${probeTier ?? '<tier>'}`;
  return `hint: ${r.count} ready branches never tested together — \`${run}\` builds the combined candidate and runs that tier only (never approvable, no heavy slot)`;
}

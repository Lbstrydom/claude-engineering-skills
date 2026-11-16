/**
 * @fileoverview "Have the ready branches been tested TOGETHER?" — the `fleet status` hint that tells the coordinator a
 * fast-tier probe (`land --dry-run --tier <name>`) is due (consumer report 2026-11-15, item 2: a clash between two ready
 * branches surfaced only at the full train, hours after the second became ready).
 *
 * The ready set is the (id, ready oid) pairs `land` would take. It counts as tested together when ONE train or probe
 * manifest, built on the CURRENT base, REACHED every pair at the same oid and got a verdict: a tier result (every source was
 * applied), or a conflict — which reached only the sources up to and including the one that conflicted. A head or base
 * that moves changes the identity, so the set is untested again ("re-run when a ready head moves"). Pure: the caller lists
 * the manifests (real trains and probes).
 *
 * @module scripts/lib/fleet/tested-together
 */

/** The ready (id, oid) pairs `land` would take, from a `buildStatus` result. */
export const readySet = (status) => status.items
  .filter((i) => status.landingOrder.includes(i.id) && i.ready?.oid)
  .map((i) => ({ id: i.id, oid: i.ready.oid }));

/** The sources a manifest's verdict covers: all of them after a tier ran; up to the conflicting one after a conflict; none otherwise. */
export function reachedSources(t) {
  const all = t.sources ?? [];
  if (t.conflict) { const at = all.findIndex((s) => s.id === t.conflict.sourceId); return at === -1 ? [] : all.slice(0, at + 1); }
  return (t.tierResults ?? []).length > 0 ? all : [];
}

/**
 * @param {Array<{id: string, oid: string}>} ready
 * @param {object[]} manifests - train and probe manifests
 * @param {string|null} baseOid - the base the next train would be built on; null (unmeasured) means nothing counts as tested
 * @returns {{count: number, tested: boolean, by: object|null}|null} null when fewer than two branches are ready
 */
export function testedTogether(ready, manifests, baseOid) {
  if (ready.length < 2) return null;
  const covers = (t) => { const got = reachedSources(t); return ready.every((r) => got.some((s) => s.id === r.id && s.oid === r.oid)); };
  const hits = manifests.filter((t) => Boolean(baseOid) && t.baseOid === baseOid && covers(t)).sort((a, b) => String(b.updatedAt ?? b.createdAt).localeCompare(String(a.updatedAt ?? a.createdAt)));
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

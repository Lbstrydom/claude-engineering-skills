/**
 * @fileoverview Recurrence aggregation and ranking (plan docs/plans/harness-retro.md
 * §2 component 6). Pure and deterministic: same scan → same order.
 *
 * Recurrence ACROSS SESSIONS is the strong signal; a one-off is counted in the
 * totals but never ranked. Weights keep corrections and hook blocks (enforcement
 * that fired) below genuine errors.
 *
 * @module scripts/lib/friction/retro/aggregate
 */

export const KIND_WEIGHTS = Object.freeze({
  tool_error: 1.0, refusal: 1.0, denial: 1.0, hook_error: 1.0, hook_rewrite: 1.0,
  retry: 0.8, hook_block: 0.5, user_correction: 0.3,
});
export const STRONG_SESSIONS = 3;
export const WEAK_SESSIONS = 2;

/** @param {number} sessions */
export const strengthOf = (sessions) => (sessions >= STRONG_SESSIONS ? 'strong' : sessions >= WEAK_SESSIONS ? 'weak' : 'one-off');

/**
 * Fold per-session counts into per-fingerprint aggregates.
 * @param {Array<{sessionKey: string, repoUuid: string, origin: string, startedAt: string|null, counts: Record<string, number>}>} sessions
 * @param {Record<string, {kind: string, tool: string, label: string}>} fingerprints
 * @returns {Map<string, object>}
 */
export function aggregateSessions(sessions, fingerprints) {
  const out = new Map();
  const seen = new Set();
  for (const s of sessions) {
    // One session counts once, however many inputs carried it (audit H4).
    if (seen.has(s.sessionKey)) continue;
    seen.add(s.sessionKey);
    const day = typeof s.startedAt === 'string' ? s.startedAt.slice(0, 10) : null;
    for (const [fp, n] of Object.entries(s.counts ?? {})) {
      let a = out.get(fp);
      if (!a) {
        const meta = fingerprints[fp] ?? { kind: 'unknown', tool: '', label: '' };
        a = { fingerprint: fp, kind: meta.kind, tool: meta.tool, label: meta.label,
          occurrences: 0, sessions: 0, repos: new Set(), days: new Set(),
          origins: { interactive: 0, automated: 0 }, firstSeen: null, lastSeen: null };
        out.set(fp, a);
      }
      a.occurrences += n;
      a.sessions += 1;
      a.repos.add(s.repoUuid);
      if (day) a.days.add(day);
      if (s.origin in a.origins) a.origins[s.origin] += 1;
      if (s.startedAt && (!a.firstSeen || s.startedAt < a.firstSeen)) a.firstSeen = s.startedAt;
      if (s.startedAt && (!a.lastSeen || s.startedAt > a.lastSeen)) a.lastSeen = s.startedAt;
    }
  }
  return out;
}

/** Rank score: sessions × kind weight × cross-repo bonus. */
export function rankScore(a) {
  const repos = a.repos instanceof Set ? a.repos.size : Number(a.repos) || 1;
  return a.sessions * (KIND_WEIGHTS[a.kind] ?? 1) * (1 + 0.5 * (repos - 1));
}

/** JSON-safe projection of an aggregate. */
function project(a) {
  return {
    fingerprint: a.fingerprint, kind: a.kind, tool: a.tool, label: a.label,
    occurrences: a.occurrences, sessions: a.sessions,
    repos: a.repos instanceof Set ? a.repos.size : a.repos,
    days: a.days instanceof Set ? a.days.size : a.days,
    origins: a.origins, firstSeen: a.firstSeen, lastSeen: a.lastSeen,
    strength: strengthOf(a.sessions), rank: Math.round(rankScore(a) * 100) / 100,
  };
}

/**
 * Split aggregates into ranked candidates and the decided/one-off remainder.
 * @param {Map<string, object>} aggregates
 * @param {{decisions?: Map<string, {decision: string}>, top?: number}} [opts]
 */
export function rankCandidates(aggregates, { decisions = new Map(), top = 10 } = {}) {
  const ranked = [];
  const enforced = [];
  const previouslyRejected = [];
  let oneOffs = 0;
  for (const a of aggregates.values()) {
    const p = project(a);
    const d = decisions.get(a.fingerprint)?.decision;
    if (d === 'enforced') { enforced.push(p); continue; }
    if (d === 'rejected') { previouslyRejected.push(p); continue; }
    if (p.strength === 'one-off') { oneOffs++; continue; }
    ranked.push(p);
  }
  const order = (x, y) => (y.rank - x.rank) || (y.sessions - x.sessions) || x.fingerprint.localeCompare(y.fingerprint);
  ranked.sort(order); enforced.sort(order); previouslyRejected.sort(order);
  return {
    candidates: ranked.slice(0, top),
    beyondTop: Math.max(0, ranked.length - top),
    strongCount: ranked.filter((r) => r.strength === 'strong').length,
    weakCount: ranked.filter((r) => r.strength === 'weak').length,
    oneOffs, enforced, previouslyRejected,
  };
}

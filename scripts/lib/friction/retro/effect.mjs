/**
 * @fileoverview The effect metric — recurrence of an enforced identity BEFORE vs
 * AFTER its activation, over equal windows and a stable population (plan
 * docs/plans/harness-retro.md §2 Telemetry). Pure: the CLI feeds it store rows
 * or local scan artifacts, normalised to the same shape.
 *
 * A window is evidence only when completed scans of the same ACCOUNT cover it;
 * the population is restricted to accounts covering BOTH windows, so the figure
 * cannot rotate under `now()` (AGENTS.md: a trend needs a stable population).
 *
 * @module scripts/lib/friction/retro/effect
 */

export const DEFAULT_WINDOW_DAYS = 14;
export const MIN_SESSIONS_PER_WINDOW = 10;
export const MIN_HITS = 3;
export const REDUCED_RATIO = 0.5;
const DAY_MS = 86_400_000;
const ms = (iso) => (iso ? Date.parse(iso) : NaN);

/**
 * Accounts whose COMPLETED scans of `repoUuid`, unioned, cover [fromMs, toMs).
 * @param {Array<{accountKey: string, repoUuid: string, since: string, until: string, completed: boolean}>} scans
 * @returns {Set<string>}
 */
export function coveredAccounts(scans, repoUuid, fromMs, toMs) {
  const byAccount = new Map();
  for (const s of scans) {
    if (!s.completed || s.repoUuid !== repoUuid) continue;
    const a = ms(s.since); const b = ms(s.until);
    if (!(a < b)) continue;
    if (!byAccount.has(s.accountKey)) byAccount.set(s.accountKey, []);
    byAccount.get(s.accountKey).push([a, b]);
  }
  const out = new Set();
  for (const [acct, ranges] of byAccount) {
    ranges.sort((x, y) => x[0] - y[0]);
    let reach = fromMs;
    for (const [a, b] of ranges) {
      if (a > reach) break;          // a gap before `reach` was covered
      if (b > reach) reach = b;
      if (reach >= toMs) break;
    }
    if (reach >= toMs) out.add(acct);
  }
  return out;
}

/**
 * @param {{decision: {identity: string, evidenceFingerprints: string[], fingerprintVersion: number},
 *          activation: {status: string, at?: string, provenance?: string, reason?: string},
 *          repoUuid: string,
 *          sessions: Array<{sessionKey: string, repoUuid: string, accountKey: string, startedAt: string, fingerprintVersion: number, counts: Record<string, number>}>,
 *          scans: Array<{accountKey: string, repoUuid: string, since: string, until: string, completed: boolean}>,
 *          now?: number, windowDays?: number, minSessions?: number, source: string}} input
 */
export function computeEffect(input) {
  const {
    decision, activation, repoUuid, sessions, scans, source,
    now = Date.now(), windowDays = DEFAULT_WINDOW_DAYS, minSessions = MIN_SESSIONS_PER_WINDOW,
  } = input;
  const base = { identity: decision.identity, source, windowDays, thresholds: { minSessions, minHits: MIN_HITS, reducedRatio: REDUCED_RATIO } };
  if (activation.status === 'pending-merge') return { ...base, verdict: 'pending-merge' };
  if (activation.status !== 'active') return { ...base, verdict: 'unmeasured', reason: activation.reason ?? 'activation-unknown' };

  const t = ms(activation.at);
  const W = windowDays * DAY_MS;
  const window = { before: [new Date(t - W).toISOString(), activation.at], after: [activation.at, new Date(t + W).toISOString()] };
  const withActivation = { ...base, activation: { at: activation.at, provenance: activation.provenance }, window };
  if (now < t + W) return { ...withActivation, verdict: 'pending', reason: `after-window ends ${window.after[1]}` };

  const accounts = coveredAccounts(scans, repoUuid, t - W, t + W);
  if (accounts.size === 0) return { ...withActivation, verdict: 'unmeasured', reason: 'no-covered-account: no account has completed scans spanning both windows' };

  // One session counts once, however many inputs carried it (audit H4).
  const unique = new Map();
  for (const s of sessions) if (!unique.has(s.sessionKey)) unique.set(s.sessionKey, s);
  const population = [...unique.values()].filter((s) => s.repoUuid === repoUuid && accounts.has(s.accountKey));
  if (population.some((s) => s.fingerprintVersion !== decision.fingerprintVersion
      && ms(s.startedAt) >= t - W && ms(s.startedAt) < t + W)) {
    return { ...withActivation, verdict: 'unmeasured', reason: 'fingerprint-version-changed within the windows — re-baseline' };
  }
  const evidence = new Set(decision.evidenceFingerprints);
  const hit = (s) => Object.keys(s.counts ?? {}).some((fp) => evidence.has(fp));
  const before = population.filter((s) => ms(s.startedAt) >= t - W && ms(s.startedAt) < t);
  const after = population.filter((s) => ms(s.startedAt) >= t && ms(s.startedAt) < t + W);
  const hitsB = before.filter(hit).length;
  const hitsA = after.filter(hit).length;
  const counts = { accounts: accounts.size, before: before.length, after: after.length, hitsBefore: hitsB, hitsAfter: hitsA };
  if (before.length < minSessions || after.length < minSessions) {
    const short = before.length < minSessions ? 'before' : 'after';
    return { ...withActivation, counts, verdict: 'unmeasured', reason: `${short}-window has fewer than ${minSessions} sessions` };
  }
  const rateB = hitsB / before.length;
  const rateA = hitsA / after.length;
  const rates = { before: Math.round(rateB * 1000) / 1000, after: Math.round(rateA * 1000) / 1000 };
  let verdict = 'unchanged';
  if (hitsB >= MIN_HITS && rateA <= REDUCED_RATIO * rateB) verdict = 'reduced';
  else if (rateA > rateB && hitsA >= MIN_HITS) verdict = 'regressed';
  return { ...withActivation, counts, rates, verdict };
}

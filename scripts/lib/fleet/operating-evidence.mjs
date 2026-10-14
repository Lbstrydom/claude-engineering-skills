/**
 * @fileoverview Fleet's side of doctor's operating-fit probes: the two measured inputs only fleet's own stores can
 * answer (how many sessions this repo had alive at once, and which other repos share the machine's heavy-slot lease).
 *
 * Owned by fleet, not by doctor: doctor's measurement layer (`scripts/lib/doctor/operating-inputs.mjs`, shared-lib)
 * must not import fleet, so `scripts/doctor.mjs` (the composition layer) hands this provider to it through `ctx`.
 * fleet imports nothing from doctor (docs/plans/adoption-fit-check.md section 2.1; layering fix, audit R1 M11).
 *
 * Both return a `Measured`: `{measured: true, value, source}` or `{measured: false, why}`. Never a default.
 *
 * @module scripts/lib/fleet/operating-evidence
 */
import { readSessions, fleetDir } from './registry.mjs';
import { readLease, machineDir, repoKeyOf, repoLabel } from './lease.mjs';

const DAY_MS = 86_400_000;
export const SESSION_WINDOW_DAYS = 7;
/** A lease event older than this says nothing about who shares the machine now (plan section 2.2, R1 M2). */
export const LEASE_EVENT_FRESH_MS = 24 * 3_600_000;

/**
 * Peak number of this repo's sessions alive at once over the last `days`, by sweep line. APPROXIMATE: a done record's
 * `updatedAt` is its last change, not its end; callers label it so.
 */
export function peakConcurrency(sessions, now, days = SESSION_WINDOW_DAYS) {
  const from = now.getTime() - days * DAY_MS;
  const edges = [];
  for (const s of sessions) {
    const start = Date.parse(s.createdAt);
    const live = s.state === 'working' || s.state === 'blocked' || s.state === 'ready';
    const end = live ? now.getTime() : Date.parse(s.updatedAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < from) continue;
    edges.push([Math.max(start, from), 1], [Math.max(end, Math.max(start, from)), -1]);
  }
  // At a tie a session ending is processed before one starting: touching intervals do not overlap.
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0; let peak = 0;
  for (const [, d] of edges) { cur += d; if (cur > peak) peak = cur; }
  return peak;
}

const un = (why) => ({ measured: false, why });

/**
 * @param {{root: string, now: Date}} a
 * @param {{readSessions?: Function}} [deps] test seam
 */
export function measurePeakSessions({ root, now }, deps = {}) {
  let res;
  try { res = deps.readSessions ? deps.readSessions() : readSessions(fleetDir(root)); } catch (err) {
    return un(`no fleet registry (${err?.message ?? err})`);
  }
  if (res.sessions.length === 0) {
    return un(res.invalid.length > 0 ? `fleet registry unreadable (${res.invalid.length} invalid record(s))` : 'no fleet sessions recorded for this repo');
  }
  return {
    measured: true,
    value: { peak: peakConcurrency(res.sessions, now), windowDays: SESSION_WINDOW_DAYS, partial: res.invalid.length > 0, approximate: true, sessions: res.sessions.length },
    source: `fleet registry (${res.sessions.length} record(s))`,
  };
}

/**
 * Which OTHER repos the machine lease names. Positive evidence only: an empty list means sharing UNOBSERVED, never
 * exclusive, because refusals are not recorded and windows prune an hour after they end.
 *
 * @param {{root: string, commonDir: string|null, exec: Function, now: Date}} a
 * @param {{readLease?: Function, machineDir?: Function}} [deps] test seams
 */
export function measureLeaseSharing({ root, commonDir, exec, now }, deps = {}) {
  let dir;
  try { dir = deps.machineDir ? deps.machineDir() : machineDir(); } catch (err) { return un(`lease directory unresolved (${err?.message ?? err})`); }
  const res = deps.readLease ? deps.readLease(dir) : readLease(dir);
  if (res.state === 'absent') return un(`no lease file in ${dir}`);
  if (res.state !== 'ok') return un(`lease ${res.state}${res.reason ? ` (${res.reason})` : ''}`);
  let ownKey = null; let ownLabel = null;
  try {
    if (commonDir) ownKey = repoKeyOf(commonDir);
    let url = '';
    try { url = String(exec('git', ['remote', 'get-url', 'origin'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 })).trim(); } catch { /* no origin: fall back to the folder name */ }
    ownLabel = repoLabel(url, root);
  } catch { /* identity stays unresolved: handled below */ }
  // Without this repo's own identity the lease cannot be split into "this repo" and "others": classifying every named
  // repo as another would invent sharing (audit R4 round 2, M1).
  if (ownKey === null) return un('this repo\'s identity could not be resolved (no git common dir), so the lease cannot be split into this repo and others');
  const t = now.getTime();
  const others = new Set();
  const l = res.lease;
  if (l.heavy && l.heavy.repoKey !== ownKey) others.add(l.heavy.repo);
  for (const w of l.windows) if (w.repoKey !== ownKey) others.add(w.repo);
  for (const e of l.events) {
    if (t - Date.parse(e.at) > LEASE_EVENT_FRESH_MS) continue;
    const repo = String(e.by).split('@').slice(1).join('@');
    if (repo && repo !== ownLabel) others.add(repo);
  }
  return { measured: true, value: { otherRepos: [...others].sort() }, source: `lease in ${dir}` };
}

/** The provider `scripts/doctor.mjs` puts on `ctx.fleetEvidence`. */
export const fleetEvidence = Object.freeze({ peakSessions: measurePeakSessions, leaseSharing: measureLeaseSharing });

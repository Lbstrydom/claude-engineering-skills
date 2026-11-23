/**
 * @fileoverview Freeze and PARTITION the decision points for Pilot 1, the meta step-back A/B
 * (docs/plans/seeded-defect-benchmark.md §2.1). Reads only a store export (`step-back-replay.mjs export`), never the store.
 *
 * A **decision point** is a real audit SESSION at the moment the meta-review would fire:
 *   - T1 — a round refused past the soft cap: plan round 4 (checkpoint 3), code round 7 (checkpoint 6);
 *   - T2 — code round 4 (checkpoint 3); whether the round signal actually fires is checked on the case tree before any call.
 * The checkpoint state (round results, ledger as of the checkpoint) comes from `buildExportSnapshot` — the same no-look-ahead
 * reconstruction the replay uses — and is sealed in a sidecar file with a digest. The tree the continuation audits is the
 * audited sha of the NEXT recorded run (what production would audit at that round); a session whose next run has no sha is
 * `unrecoverable`, never guessed.
 *
 * Sessions are then PARTITIONED, by session and by a seeded shuffle recorded in the dataset, into four disjoint sets:
 * calibration (matcher labels), rehearsal, pilot and repeat. Nothing is wall-clock dependent: two freezes of one export,
 * spec and seed are byte-identical, so the dataset hash is an identity.
 *
 * Authorised repos only (Louis, 2026-11-23): CES and the home consumers. A work repo is excluded, never sampled.
 *
 * Domain: audit-orchestration.
 *
 * @module scripts/lib/audit/step-back-pilot-freeze
 */
import crypto from 'node:crypto';
import { buildExportSnapshot, SESSION_GAP_MS } from './step-back-export.mjs';

export const PILOT_DATASET_VERSION = 1;
export const PILOT_KIND = 'meta-ab';
export const PILOT_SETS = Object.freeze(['calibration', 'rehearsal', 'pilot', 'repeat']);
/** Branches whose runs are many unrelated sessions interleaved: a session cannot be told from the run list. */
export const AMBIGUOUS_BRANCHES = Object.freeze(['main', 'master', 'HEAD']);
/** The only repos a pilot may read (the approval of 2026-11-23). Matched on the store's `audit_repos.name`. */
export const AUTHORISED_REPOS = Object.freeze(['Lbstrydom/claude-engineering-skills', 'Lbstrydom/wine-cellar-app', 'Lbstrydom/ai-organiser']);
export const DEFAULT_TARGETS = Object.freeze({ calibration: 12, rehearsal: 5, pilot: 16, minPilotCode: 6 });

/** The checkpoint a trigger reads, per mode: plan T1 reads round 3 (refused round 4); code T1 round 6 (refused 7); code T2 round 3 (admitted 4). */
export const POINT_SHAPES = Object.freeze([
  { mode: 'plan', trigger: 'T1', checkpoint: 3 },
  { mode: 'code', trigger: 'T2', checkpoint: 3 },
  { mode: 'code', trigger: 'T1', checkpoint: 6 },
]);

const sha256Hex = (s) => crypto.createHash('sha256').update(s).digest('hex');
const ts = (s) => Date.parse(s);

/** Deterministic PRNG (mulberry32) seeded from a string; the seed is recorded in the dataset so a partition is reproducible. */
export function seededRng(seed) {
  let a = parseInt(sha256Hex(String(seed)).slice(0, 8), 16) >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Fisher-Yates over a copy, ordered first by a stable key so the result never depends on the input order. */
export function seededShuffle(items, seed, keyOf = (x) => String(x)) {
  const arr = [...items].sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
  const rnd = seededRng(seed);
  for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  return arr;
}

/** Contiguous run groups per (repo, branch, mode): no gap over SESSION_GAP_MS. A session is one such group. */
export function sessionsOf(exp) {
  const by = new Map();
  for (const r of exp.runs) {
    if (!r.branch) continue;
    const k = `${r.repo_id}\u0000${r.branch}\u0000${r.mode ?? 'code'}`;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(r);
  }
  const sessions = [];
  for (const runs of by.values()) {
    runs.sort((a, b) => ts(a.created_at) - ts(b.created_at) || String(a.id).localeCompare(String(b.id)));
    let cur = null;
    for (const r of runs) {
      if (cur && ts(r.created_at) - ts(cur[cur.length - 1].created_at) <= SESSION_GAP_MS) cur.push(r);
      else { cur = [r]; sessions.push(cur); }
    }
  }
  return sessions.map((runs) => ({ sessionId: `${runs[0].repo_id}|${runs[0].mode ?? 'code'}|${runs[0].branch}@${runs[0].created_at}`, repoId: runs[0].repo_id, branch: runs[0].branch, mode: runs[0].mode ?? 'code', runs }));
}

/**
 * Freeze the dataset. Pure: everything it reads is in `exp`.
 * @param {object} a
 * @param {object} a.exp - the store export (runs, findings, events)
 * @param {Record<string, {name: string, localPath?: string}>} a.repos - repo_id -> identity (the caller resolved names from `audit_repos`)
 * @param {string} a.seed - recorded; the partition is a pure function of (export, seed, targets)
 * @param {object} [a.targets]
 * @param {string[]} [a.authorisedRepos]
 * @returns {{dataset: object, snapshots: object}}
 */
export function freezeMetaPilot({ exp, repos, seed, targets = DEFAULT_TARGETS, authorisedRepos = AUTHORISED_REPOS, verifyRepo }) {
  if (typeof verifyRepo !== 'function') throw new Error('freezeMetaPilot: a verifyRepo(repo) function is required; authorisation never defaults to trusting the supplied name');
  if (!seed) throw new Error('freezeMetaPilot: a seed is required (it is recorded in the dataset)');
  // Authorisation binds to a VERIFIED repository identity: the caller-supplied name must match the clone's own origin.
  for (const [id, r] of Object.entries(repos)) {
    if (!authorisedRepos.includes(r.name)) continue;
    const v = verifyRepo(r);
    if (!v.ok) throw new Error(`repo ${id} is mapped to ${r.name} but ${v.reason}; refusing to read it under that authorisation`);
  }
  const excluded = []; const points = []; const snapshots = {}; const sessionRows = [];
  const allSessions = sessionsOf(exp);
  const ids = new Set(); for (const s of allSessions) { if (ids.has(s.sessionId)) throw new Error(`duplicate session id ${s.sessionId}`); ids.add(s.sessionId); }
  for (const s of allSessions) {
    const repo = repos[s.repoId];
    const exclude = (reason) => excluded.push({ sessionId: s.sessionId, repo: repo?.name ?? s.repoId, mode: s.mode, runs: s.runs.length, reason });
    if (!repo || !authorisedRepos.includes(repo.name)) { if (s.runs.length >= 4) exclude(`repo not authorised for a pilot (${repo?.name ?? 'unknown'})`); continue; }
    if (AMBIGUOUS_BRANCHES.includes(s.branch)) { if (s.runs.length >= 4) exclude(`branch "${s.branch}" interleaves unrelated sessions`); continue; }
    const shapes = POINT_SHAPES.filter((p) => p.mode === s.mode && s.runs.length >= p.checkpoint);
    const mine = [];
    for (const shape of shapes) {
      const N = shape.checkpoint;
      const next = s.runs[N];
      const pointId = `${s.mode}-${shape.trigger}-${sha256Hex(`${s.repoId}|${s.branch}|${s.runs[0].id}|${N}`).slice(0, 10)}`;
      const base = { pointId, sessionId: s.sessionId, repo: repo.name, branch: s.branch, mode: s.mode, trigger: shape.trigger, checkpoint: N, round: N + 1 };
      if (!next) continue; // the session ended at the checkpoint: no next round existed to audit, so this is not a point
      if (!next.audited_sha) { points.push({ ...base, status: 'unrecoverable', reason: `run ${N + 1} has no audited_sha (the tree the next round audits)` }); continue; }
      const snap = buildExportSnapshot({ exp, runIds: s.runs.map((r) => r.id), checkpoint: N });
      if (!snap.ok) { points.push({ ...base, status: 'unrecoverable', reason: snap.reason }); continue; }
      if (!(next.plan_file || snap.snapshot.planFile)) { points.push({ ...base, status: 'unrecoverable', reason: `${s.mode} audit with no recorded plan_file (the invocation cannot be re-issued)` }); continue; }
      const sealed = { rounds: snap.snapshot.rounds, ledgerEntries: snap.snapshot.ledgerEntries };
      const digest = sha256Hex(JSON.stringify(sealed));
      snapshots[pointId] = { ...sealed, digest };
      points.push({
        ...base, status: 'recoverable', checkpointSha: snap.snapshot.auditedSha, treeSha: next.audited_sha, firstSha: s.runs[0].audited_sha ?? null,
        planFile: next.plan_file ?? snap.snapshot.planFile ?? null, runIds: s.runs.slice(0, N + 1).map((r) => r.id), snapshotDigest: digest,
        rounds: N, findingsAtCheckpoint: sealed.rounds.reduce((n, r) => n + r.findings.length, 0), ledgerEntries: sealed.ledgerEntries.length,
      });
      mine.push(pointId);
    }
    if (mine.length) sessionRows.push({ sessionId: s.sessionId, repo: repo.name, branch: s.branch, mode: s.mode, runs: s.runs.length, pointIds: mine });
  }

  // ── partition, BY SESSION: a session's points never straddle sets ──
  const recoverable = new Map(points.filter((p) => p.status === 'recoverable').map((p) => [p.pointId, p]));
  const sets = { calibration: [], rehearsal: [], pilot: [], repeat: [] };
  const used = new Set();
  const take = (name, cap, pick) => {
    for (const s of seededShuffle(sessionRows.filter((x) => !used.has(x.sessionId) && pick(x)), `${seed}:${name}`, (x) => x.sessionId)) {
      if (sets[name].length >= cap) break;
      if (sets[name].length + s.pointIds.length > cap) continue; // never overshoot the target; a smaller session may still fit
      sets[name].push(...s.pointIds); used.add(s.sessionId);
    }
  };
  const isCode = (s) => s.mode === 'code';
  // The pilot first (its code floor is the binding constraint), then rehearsal, calibration; whatever is left is the repeat set.
  const codeFirst = (cap, floor) => { take('pilot', Math.min(cap, floor), isCode); take('pilot', cap, () => true); };
  codeFirst(targets.pilot, targets.minPilotCode);
  take('rehearsal', targets.rehearsal, () => true);
  take('calibration', targets.calibration, () => true);
  const pilotCode = sets.pilot.filter((id) => recoverable.get(id)?.mode === 'code').length;
  const codeAvailable = [...recoverable.values()].filter((p) => p.mode === 'code').length;
  if (pilotCode < Math.min(targets.minPilotCode, codeAvailable)) throw new Error(`the partition could not reach the pilot's code floor (${pilotCode} of ${targets.minPilotCode}) although ${codeAvailable} code points exist; re-freeze with another seed`);
  for (const s of sessionRows) if (!used.has(s.sessionId)) { sets.repeat.push(...s.pointIds); used.add(s.sessionId); }
  const setOf = Object.fromEntries(Object.entries(sets).flatMap(([name, ids]) => ids.map((id) => [id, name])));
  for (const p of points) p.set = setOf[p.pointId] ?? null;
  for (const s of sessionRows) s.set = setOf[s.pointIds[0]];
  const sorted = (xs, k) => [...xs].sort((a, b) => String(a[k]).localeCompare(String(b[k])));

  const dataset = {
    version: PILOT_DATASET_VERSION, kind: PILOT_KIND, source: 'store-export', seed, targets, authorisedRepos: [...authorisedRepos],
    exportSha256: exp.exportSha256 ?? null, exportedAt: exp.exportedAt ?? null,
    repoPaths: Object.fromEntries(Object.values(repos).filter((r) => authorisedRepos.includes(r.name)).map((r) => [r.name, r.localPath ?? null])),
    counts: {
      recoverable: recoverable.size, unrecoverable: points.length - recoverable.size,
      bySet: Object.fromEntries(PILOT_SETS.map((n) => [n, { points: sets[n].length, code: sets[n].filter((id) => recoverable.get(id)?.mode === 'code').length, plan: sets[n].filter((id) => recoverable.get(id)?.mode === 'plan').length }])),
    },
    sessions: sorted(sessionRows, 'sessionId'), points: sorted(points, 'pointId'), excluded: sorted(excluded, 'sessionId'),
  };
  dataset.snapshotsSha256 = sha256Hex(JSON.stringify(Object.fromEntries(Object.keys(snapshots).sort().map((k) => [k, snapshots[k].digest]))));
  dataset.datasetHash = sha256Hex(JSON.stringify({ ...dataset, datasetHash: undefined }));
  return { dataset, snapshots };
}

/** The loader refuses a run whose set does not match its purpose (§2.1), and the sets must be disjoint. */
export function assertPartition(dataset) {
  const seen = new Map();
  for (const p of dataset.points) {
    if (p.status !== 'recoverable') continue;
    if (!PILOT_SETS.includes(p.set)) throw new Error(`point ${p.pointId} has no partition set`);
    const prev = seen.get(p.sessionId);
    if (prev && prev !== p.set) throw new Error(`session ${p.sessionId} straddles sets ${prev} and ${p.set}`);
    seen.set(p.sessionId, p.set);
  }
  return true;
}

/** Points of one set, recoverable only; throws on a purpose/set mismatch so a rehearsal can never read pilot points. */
export function pointsFor({ dataset, set, purpose }) {
  const allowed = { rehearsal: ['rehearsal'], pilot: ['pilot'], repeat: ['repeat'], calibration: ['calibration'] }[purpose];
  if (!allowed || !allowed.includes(set)) throw new Error(`a "${purpose}" run may not read the "${set}" set`);
  return dataset.points.filter((p) => p.status === 'recoverable' && p.set === set);
}

/** Verify a snapshot sidecar against the dataset before any use: every point's digest recomputed, never trusted. */
export function verifySnapshots({ dataset, snapshots }) {
  for (const p of dataset.points) {
    if (p.status !== 'recoverable') continue;
    const s = snapshots[p.pointId];
    if (!s) throw new Error(`snapshot for ${p.pointId} is missing from the sidecar`);
    const d = sha256Hex(JSON.stringify({ rounds: s.rounds, ledgerEntries: s.ledgerEntries }));
    if (d !== p.snapshotDigest || d !== s.digest) throw new Error(`snapshot for ${p.pointId} does not match its frozen digest (sidecar edited or from another freeze)`);
  }
  const all = sha256Hex(JSON.stringify(Object.fromEntries(Object.keys(snapshots).sort().map((k) => [k, snapshots[k].digest]))));
  if (all !== dataset.snapshotsSha256) throw new Error('the snapshot sidecar does not match the dataset (a different freeze)');
  const { datasetHash, ...rest } = dataset;
  if (sha256Hex(JSON.stringify({ ...rest, datasetHash: undefined })) !== datasetHash) throw new Error('the dataset content does not match its recorded hash');
  return true;
}

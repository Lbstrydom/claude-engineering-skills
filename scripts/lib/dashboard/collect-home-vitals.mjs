/**
 * @fileoverview Home collector: the vitals that are not queues — AGENTS.md size, the
 * plans summary, the skills roster, and the maintenance heartbeat — one MEASUREMENT
 * each, so an unreadable heartbeat degrades only the Maintenance chip.
 *
 * AGENTS.md is measured in CHARACTERS of the decoded text through the shared
 * context-size oracle (the same one `check-context-drift.mjs` gates on), never
 * `statSync` bytes; a config problem (unreadable, bad JSON, retired field) makes the
 * measurement `invalid` rather than grading against a silently-wrong default. Plans
 * and skills are the already-collected `reference` data, not a second read; the
 * stale-plan POLICY is not here — this collector passes raw dates and `home-model.mjs`
 * decides. The heartbeat is read by the shared `lib/maintenance-heartbeat.mjs`.
 *
 * Does synchronous fs work, so it runs in the Home worker thread like the other
 * synchronous cards; `reduceVitalsInput` shrinks the (10 MB) plan bodies to what
 * crosses the thread boundary.
 *
 * Plan: docs/plans/dashboard-home-summary.md §2 (Health strip).
 *
 * @module scripts/lib/dashboard/collect-home-vitals
 */
import fs from 'node:fs';
import path from 'node:path';
import { agentsMdCharCount, resolveMaxAgentsMdChars } from '../claudemd/context-size.mjs';
import { ALL_SKILLS } from '../store/skill-census.mjs';
import { gitCommonDir } from '../fleet/git-facts.mjs';
import { loadHeartbeat, isOverdue, HEARTBEAT_FILE, DEFAULT_INTERVAL_DAYS } from '../maintenance-heartbeat.mjs';
import { makeMeasurement } from './home-model.mjs';

/** The four vitals (id + label), for a placeholder when the whole unit fails. */
export const VITAL_MEASUREMENTS = Object.freeze([
  { id: 'agents-size', label: 'AGENTS.md size', card: 'vitals', source: 'AGENTS.md' },
  { id: 'plans', label: 'Plans', card: 'vitals', source: 'reference.plans' },
  { id: 'skills', label: 'Skills', card: 'vitals', source: 'reference.skills' },
  { id: 'maintenance', label: 'Maintenance', card: 'vitals', source: 'last-maintenance.json heartbeat' },
]);

const DAY_MS = 86_400_000;
const IN_PROGRESS = /^\s*in[ -]?progress\b/i;

/**
 * Shrink `reference.plans` / `reference.skills` to what the worker needs: the In Progress plans
 * (path, raw date) and counts. Plan bodies stay behind. Idempotent.
 * @returns {{plans: {inProgress: object[], total: number}|null, skillsCount: number|null}}
 */
export function reduceVitalsInput({ plans, skills }) {
  let p = null;
  if (plans?.inProgress && Number.isFinite(plans.total)) p = plans;
  else if (Array.isArray(plans?.active)) {
    p = {
      total: plans.active.length + (plans.completed?.length ?? 0),
      inProgress: plans.active.filter((x) => IN_PROGRESS.test(x.status ?? '')).map((x) => ({ path: String(x.path ?? ''), title: String(x.title ?? ''), date: x.date ?? null })),
    };
  }
  return { plans: p, skillsCount: Number.isFinite(skills) ? skills : (Array.isArray(skills) ? skills.length : null) };
}

function agentsSize(root, asOf) {
  const base = { id: 'agents-size', label: 'AGENTS.md size', card: 'vitals', asOf, source: 'AGENTS.md (characters, via lib/claudemd/context-size.mjs)' };
  const cfg = resolveMaxAgentsMdChars(root);
  if (cfg.problem) {
    return makeMeasurement({ ...base, status: 'invalid', detail: `unmeasured: config problem: ${cfg.problem.split('\n')[0]}` });
  }
  let text;
  try { text = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'); } catch (err) {
    return makeMeasurement({ ...base, status: err.code === 'ENOENT' ? 'missing-optional' : 'unexpected-error', detail: err.code === 'ENOENT' ? 'no AGENTS.md in this repo' : `cannot read AGENTS.md (${err.code})` });
  }
  return makeMeasurement({ ...base, status: 'ok', value: { chars: agentsMdCharCount(text), cap: cfg.cap } });
}

/** Raw facts only: the staleness policy (In Progress older than N days) lives in home-model.mjs. */
function plansSummary(plans, srcStatus, asOf) {
  const base = { id: 'plans', label: 'Plans', card: 'vitals', asOf, source: 'reference.plans (docs/plans)' };
  if (srcStatus && srcStatus.status !== 'ok') return makeMeasurement({ ...base, status: srcStatus.status, detail: srcStatus.detail || 'plans source degraded' });
  if (!plans) return makeMeasurement({ ...base, status: 'unexpected-error', detail: 'plans were not supplied to the Home collector' });
  const list = plans.inProgress.map((p) => {
    const t = Date.parse(p.date ?? '');
    return { slug: path.posix.basename(p.path || p.title || 'plan').replace(/\.md$/, ''), path: p.path, date: Number.isNaN(t) ? null : new Date(t).toISOString() };
  });
  return makeMeasurement({ ...base, status: 'ok', value: { inProgress: list.length, total: plans.total, plans: list } });
}

function skillsRoster(count, srcStatus, asOf) {
  const base = { id: 'skills', label: 'Skills', card: 'vitals', asOf, source: 'reference.skills (skills/) vs the census roster' };
  if (srcStatus && srcStatus.status !== 'ok') return makeMeasurement({ ...base, status: srcStatus.status, detail: srcStatus.detail || 'skills source degraded' });
  if (!Number.isFinite(count)) return makeMeasurement({ ...base, status: 'unexpected-error', detail: 'skills were not supplied to the Home collector' });
  return makeMeasurement({ ...base, status: 'ok', value: { count, roster: ALL_SKILLS.length } });
}

/** Where the heartbeat lives: the env override, else `<root>/.audit-loop`, else the MAIN checkout's (linked worktrees share one). */
function heartbeatPath(root, env) {
  if (env.AUDIT_LOOP_STATE_DIR) return path.join(env.AUDIT_LOOP_STATE_DIR, HEARTBEAT_FILE);
  const local = path.join(root, '.audit-loop', HEARTBEAT_FILE);
  if (fs.existsSync(local)) return local;
  const common = gitCommonDir(root);
  return common.ok ? path.join(path.dirname(common.dir), '.audit-loop', HEARTBEAT_FILE) : local;
}

function maintenance(root, env, now, asOf, explicitPath) {
  const base = { id: 'maintenance', label: 'Maintenance', card: 'vitals', asOf, source: 'last-maintenance.json heartbeat' };
  const hb = loadHeartbeat(explicitPath ?? heartbeatPath(root, env), { now: now.getTime() });
  if (!hb) return makeMeasurement({ ...base, status: 'missing-optional', detail: 'no usable heartbeat: weekly maintenance has not run, is not enabled here, or the file is malformed or future-dated' });
  const last = Date.parse(hb.lastRunAt);
  const overdue = isOverdue(hb, DEFAULT_INTERVAL_DAYS, { now: now.getTime() });
  const overdueDays = overdue ? Math.max(1, Math.ceil((now.getTime() - last) / DAY_MS - DEFAULT_INTERVAL_DAYS)) : 0;
  return makeMeasurement({ ...base, status: 'ok', value: { lastRunAt: new Date(last).toISOString(), windowDays: DEFAULT_INTERVAL_DAYS, overdueDays } });
}

/**
 * @param {string} root
 * @param {object} [opts]
 * @param {object} [opts.plans] - `reference.plans` (full) or the {@link reduceVitalsInput} shape
 * @param {object[]|number} [opts.skills] - `reference.skills` or its count
 * @param {{plans?: {status: string, detail: string}, skills?: {status: string, detail: string}}} [opts.sourceStatus]
 * @param {Date} [opts.now]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {string} [opts.heartbeatPath] - explicit heartbeat file (tests)
 * @returns {{card: 'vitals', measurements: object[]}}
 */
export function collectVitals(root, { plans, skills, sourceStatus = {}, now = new Date(), env = process.env, heartbeatPath: hbPath } = {}) {
  const asOf = now.toISOString();
  const reduced = reduceVitalsInput({ plans, skills });
  return {
    card: 'vitals',
    measurements: [
      agentsSize(root, asOf),
      plansSummary(reduced.plans, sourceStatus.plans, asOf),
      skillsRoster(reduced.skillsCount, sourceStatus.skills, asOf),
      maintenance(root, env, now, asOf, hbPath),
    ],
  };
}

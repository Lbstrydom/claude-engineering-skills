/**
 * @fileoverview Judge browser step timings recorded by /persona-test and
 * /click-test against an OPTIONAL app-declared contract.
 *
 * Plan: docs/plans/performance-checklist-and-step-timings.md §Change 2.
 * Method (ready predicate, in-page timing, budgets): the shared reference
 * docs/audit/shared-references/performance-measurement.md §Step timings.
 *
 * The one rule this module exists to hold: **an untimed step reads
 * `unmeasured`, never green.** `within-budget` is reachable only when every
 * attempted step (`attemptedIds`, the skill's own log) was sent, timed AND
 * matched a budget declared for the ready settings it was measured with; zero steps is `unmeasured`, not a clean pass. Without a contract the
 * times are reported only (`reported`) — CES carries no budgets of its own.
 *
 * The contract is loaded HERE, never by the model: the path goes through
 * `resolveAndClassify` (realpath, repo containment, sensitive-path refusal —
 * INC-001), and an error never echoes the file's contents. The contract is
 * never sent to a model.
 *
 * @module scripts/lib/step-timing
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { resolveAndClassify } from './sensitive-paths.mjs';

/** Closed per-step status enum. */
export const STEP_STATUSES = Object.freeze(['within-budget', 'over-budget', 'reported', 'unmeasured']);
/** Closed reasons a step carries no duration; `not-recorded` = the skill sent none. */
export const UNMEASURED_REASONS = Object.freeze(['timeout', 'navigation-failed', 'no-in-page-timing', 'page-error', 'not-recorded']);
/** Where an app declares its contract when no explicit path is given. */
export const DEFAULT_CONTRACT_FILE = 'step-timing-contract.json';
export const MAX_CONTRACT_BYTES = 64 * 1024;
/** Input bounds: a run has tens of steps; these stop a runaway payload, never a real one. */
export const MAX_STEPS = 2000;
export const MAX_BUDGETS = 200;
/** WAIT polls every 25 ms; the timeout must leave the quiet window room to close. */
const MIN_TIMEOUT_HEADROOM_MS = 1000;

const ROUTE_RE = /^\/[^*]*\*?$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** A real calendar date, not just its shape: 2026-02-30 round-trips to 2026-03-02 and is refused. */
const isCalendarDate = (d) => {
  if (!ISO_DATE_RE.test(d)) return false;
  const t = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
};
const MAX_ID_CHARS = 200;
const MAX_ROUTE_CHARS = 2048;

const BudgetSchema = z.object({
  route: z.string().max(MAX_ROUTE_CHARS).regex(ROUTE_RE, 'route must be a pathname starting with "/", optionally ending in one "*" (prefix)'),
  kind: z.enum(['navigate', 'action']),
  budgetMs: z.number().int().positive(),
  basis: z.object({
    percentile: z.enum(['p50', 'p90', 'p99']),
    measuredMs: z.number().positive().max(600000),
    factor: z.number().min(1).max(10),
    measuredAt: z.string().refine(isCalendarDate, 'measuredAt must be a real calendar date YYYY-MM-DD'),
    remeasureWhen: z.array(z.string().min(1)).min(1),
  }).strict(),
}).strict().refine(
  (b) => b.budgetMs === Math.round(b.basis.measuredMs * b.basis.factor),
  { message: 'budgetMs must equal round(basis.measuredMs × basis.factor) — a budget is a measured percentile times a stated factor' },
);

/** Ready settings: the predicate and the bounds a step is measured with. */
const ReadySchema = z.object({
  selector: z.string().min(1).nullable(),
  quietMs: z.number().int().min(0).max(10000),
  timeoutMs: z.number().int().min(1000).max(120000),
}).strict().refine(
  (r) => r.timeoutMs >= r.quietMs + MIN_TIMEOUT_HEADROOM_MS,
  { message: `timeoutMs must be at least quietMs + ${MIN_TIMEOUT_HEADROOM_MS}: otherwise an idle, ready page times out before its quiet window closes` },
);

/** The app-declared contract (`step-timing-contract.json`). */
export const StepTimingContractSchema = z.object({
  version: z.literal(1),
  ready: ReadySchema,
  budgets: z.array(BudgetSchema).max(MAX_BUDGETS),
}).strict().superRefine((c, ctx) => {
  const seen = new Set();
  c.budgets.forEach((b, i) => {
    const key = `${b.kind} ${b.route}`;
    if (seen.has(key)) ctx.addIssue({ code: 'custom', path: ['budgets', i], message: 'duplicate budget for one (route, kind)' });
    seen.add(key);
  });
});

const StepSchema = z.object({
  id: z.string().min(1).max(MAX_ID_CHARS),
  route: z.string().min(1).max(MAX_ROUTE_CHARS),
  kind: z.enum(['navigate', 'action']),
  // Deliberately loose: a missing / null / garbage duration is DATA (it reads
  // `unmeasured`), not a payload error — rejecting it would let a skill drop
  // the untimed step and report the rest as green.
  durationMs: z.unknown().optional(),
  // A reason ALWAYS makes the step unmeasured, whatever durationMs says.
  unmeasuredReason: z.enum(UNMEASURED_REASONS).optional(),
}); // unknown step fields are stripped, not carried

/** The `judge-step-timings` payload. */
export const StepTimingInputSchema = z.object({
  steps: z.array(StepSchema).max(MAX_STEPS),
  // The skill's ATTEMPT LOG (every navigation/action tried, failures included),
  // kept apart from the timing entries so an omitted step is visible by id.
  attemptedIds: z.array(z.string().min(1).max(MAX_ID_CHARS)).max(MAX_STEPS),
  // The ready settings the steps were ACTUALLY measured with (after any flag
  // override). Budgets apply only when these equal the contract's own.
  ready: ReadySchema,
  // What step-timing-ready returned: the judge refuses a contract that changed in between.
  contractDigest: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  contractPath: z.string().min(1).optional(),
}).strict();

function isTimed(d) {
  return typeof d === 'number' && Number.isFinite(d) && d >= 0;
}

/** Effective ready settings equal the contract's: the condition for its budgets to apply. */
function sameReady(a, b) {
  return a.selector === b.selector && a.quietMs === b.quietMs && a.timeoutMs === b.timeoutMs;
}

/** The budget for `route`+`kind`: an exact route beats every prefix; among prefixes the longest wins. */
export function matchBudget(budgets, route, kind) {
  let best = null;
  for (const b of budgets) {
    if (b.kind !== kind) continue;
    const prefix = b.route.endsWith('*');
    if (!prefix) {
      if (route === b.route) return b;
      continue;
    }
    const stem = b.route.slice(0, -1);
    if (route.startsWith(stem) && (!best || stem.length > best.route.length - 1)) best = b;
  }
  return best;
}

/**
 * A validation issue as text that cannot carry contract content: the path is
 * kept only where it is a schema-defined key or an array index, and only OUR
 * fixed refine messages are quoted — Zod's own messages can name an
 * unrecognised key, which is file text.
 */
const SCHEMA_KEYS = new Set(['version', 'ready', 'selector', 'quietMs', 'timeoutMs', 'budgets', 'route', 'kind', 'budgetMs',
  'basis', 'percentile', 'measuredMs', 'factor', 'measuredAt', 'remeasureWhen']);
function describeIssue(i) {
  const where = i.path.map((k) => (typeof k === 'number' || SCHEMA_KEYS.has(k) ? k : '?')).join('.') || '(root)';
  return `${where}: ${i.code === 'custom' ? i.message : i.code}`;
}

/** Validate a parsed contract object. Errors never contain contract keys or values. */
export function parseStepTimingContract(raw) {
  const r = StepTimingContractSchema.safeParse(raw);
  if (!r.success) {
    return { ok: false, error: r.error.issues.map(describeIssue).join('; ') };
  }
  return { ok: true, contract: r.data };
}

/**
 * Load the app's contract. Only an ABSENT default file is "no contract";
 * every other failure is an error whose text never contains the file body.
 * @param {{contractPath?: string, repoRoot: string}} opts
 * @returns {{ok:true, contract:object|null, path:string|null} | {ok:false, error:string}}
 */
export function loadStepTimingContract({ contractPath, repoRoot }) {
  const explicit = typeof contractPath === 'string';
  const rel = explicit ? contractPath : DEFAULT_CONTRACT_FILE;
  if (!explicit) {
    // lstat, not existsSync: a DANGLING symlink or an access error must not read as "no contract".
    try { fs.lstatSync(path.resolve(repoRoot, rel)); } catch (e) {
      if (e.code === 'ENOENT') return { ok: true, contract: null, path: null };
      return { ok: false, error: `contract ${rel} cannot be inspected (${e.code || 'error'})` };
    }
  }
  const c = resolveAndClassify(rel, { repoRoot });
  if (c.category === 'sensitive') {
    const why = c.resolutionFailed ? 'does not exist or cannot be resolved'
      : c.escapedRepo ? 'resolves outside the repository' : 'is a sensitive path';
    return { ok: false, error: `contract ${rel} ${why}` };
  }
  let st;
  try { st = fs.statSync(c.canonical); } catch (e) { return { ok: false, error: `contract ${rel} cannot be read (${e.code || 'error'})` }; }
  if (!st.isFile()) return { ok: false, error: `contract ${rel} is not a regular file` };
  if (st.size > MAX_CONTRACT_BYTES) return { ok: false, error: `contract ${rel} is ${st.size} bytes, over the ${MAX_CONTRACT_BYTES}-byte cap` };
  let raw;
  try { raw = JSON.parse(fs.readFileSync(c.canonical, 'utf8')); } catch { return { ok: false, error: `contract ${rel} is not valid JSON` }; }
  const parsed = parseStepTimingContract(raw);
  if (!parsed.ok) return { ok: false, error: `contract ${rel} is invalid: ${parsed.error}` };
  return { ok: true, contract: parsed.contract, path: rel };
}

/**
 * sha256 of a VALIDATED contract; `null` for no contract. Zod emits a parsed
 * object's keys in schema order, so two parses of the same content serialise
 * identically: no key sorting needed.
 */
export function contractDigest(contract) {
  return contract ? crypto.createHash('sha256').update(JSON.stringify(contract)).digest('hex') : null;
}

/**
 * Judge each step and the run.
 * @param {Array<{id:string, route:string, kind:'navigate'|'action', durationMs?:unknown, unmeasuredReason?:string}>} steps
 * @param {object|null} contract  a VALIDATED contract, or null
 * @param {{attemptedIds: string[], ready: object}} run  the attempt log + the ready settings measured with
 * @returns {{ok:true, steps:object[], counts:object, missingIds:string[], readyOverridden:boolean, overall:string} | {ok:false, error:string}}
 */
export function judgeStepTimings(steps, contract, { attemptedIds, ready }) {
  const attempted = new Set(attemptedIds);
  if (attempted.size !== attemptedIds.length) return { ok: false, error: 'attemptedIds contains a duplicate id' };
  const ids = new Set();
  for (const s of steps) {
    if (ids.has(s.id)) return { ok: false, error: `duplicate step id "${s.id}"` };
    if (!attempted.has(s.id)) return { ok: false, error: `step "${s.id}" is not in attemptedIds` };
    ids.add(s.id);
  }
  const missingIds = attemptedIds.filter((id) => !ids.has(id));
  // Budgets were measured under the contract's ready predicate; a run measured
  // under another (a flag override) is reported, never judged against them.
  const readyOverridden = contract !== null && !sameReady(ready, contract.ready);
  const budgets = contract && !readyOverridden ? contract.budgets : [];
  const judged = steps.map((s) => {
    if (s.unmeasuredReason !== undefined || !isTimed(s.durationMs)) {
      return { id: s.id, route: s.route, kind: s.kind, durationMs: null, budgetMs: null,
        status: 'unmeasured', unmeasuredReason: s.unmeasuredReason ?? 'not-recorded' };
    }
    const b = matchBudget(budgets, s.route, s.kind);
    const status = !b ? 'reported' : (s.durationMs <= b.budgetMs ? 'within-budget' : 'over-budget');
    // The basis is returned WITHOUT its free-text `remeasureWhen`.
    const basis = b
      ? { percentile: b.basis.percentile, measuredMs: b.basis.measuredMs, factor: b.basis.factor, measuredAt: b.basis.measuredAt }
      : null;
    return { id: s.id, route: s.route, kind: s.kind, durationMs: s.durationMs, budgetMs: b ? b.budgetMs : null, basis, status };
  });
  const counts = Object.fromEntries(STEP_STATUSES.map((k) => [k, judged.filter((j) => j.status === k).length]));
  counts.missing = missingIds.length;
  // Completeness first: a run with an unmeasured or unsent step is `unmeasured`
  // even when another step is over budget (that stays visible in `counts`).
  let overall;
  if (judged.length === 0 || counts.unmeasured > 0 || counts.missing > 0) overall = 'unmeasured';
  else if (counts['over-budget'] > 0) overall = 'over-budget';
  else if (counts.reported > 0) overall = 'reported';
  else overall = 'within-budget';
  return { ok: true, steps: judged, counts, missingIds, readyOverridden, overall };
}

/** Ready settings used when the app declares no contract. `selector: null` = `document.readyState === 'complete'`. */
export const DEFAULT_READY = Object.freeze({ selector: null, quietMs: 500, timeoutMs: 10000 });

/**
 * The ready settings a skill measures with: the contract's validated `ready`
 * block, or the defaults. Never the budgets, never file text.
 * @returns {{ok:true, ready:{selector:string|null, quietMs:number, timeoutMs:number}, contractDeclared:boolean, path:string|null} | {ok:false, error:string}}
 */
export function resolveReadySettings({ contractPath, repoRoot }) {
  const loaded = loadStepTimingContract({ contractPath, repoRoot });
  if (!loaded.ok) return loaded;
  const ready = loaded.contract ? { ...loaded.contract.ready } : { ...DEFAULT_READY };
  return { ok: true, ready, contractDeclared: loaded.contract !== null, path: loaded.path, contractDigest: contractDigest(loaded.contract) };
}

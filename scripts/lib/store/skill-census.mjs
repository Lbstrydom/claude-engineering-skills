/**
 * @fileoverview Skill-efficacy census aggregator — docs/plans/skill-efficacy-census.md
 * Phase 2. Answers, per bundled skill: how often is it invoked, is the
 * signal trustworthy, and (where applicable) what fraction of its findings
 * get fixed.
 *
 * Calls the underlying `scripts/lib/store/*.mjs` reader functions directly
 * — never `scripts/lib/dashboard/collect-telemetry.mjs`'s collectors, which
 * are presentation-layer and already depend on `store/`; importing from
 * there would invert the dependency this repo's layering rules gate on.
 * `scripts/lib/dashboard/collect-telemetry.mjs::collectSkillCensus` wraps
 * THIS module's output, the same direction `collectAuditEffectiveness`
 * already uses.
 *
 * Per-skill entries are a LOOKUP TABLE (`SKILL_BUILDERS`), not an if/else
 * chain — adding a table for a currently-silent skill is a new entry, never
 * a rewrite (§3 extension point).
 *
 * @module scripts/lib/store/skill-census
 */
import { execFileSync } from 'node:child_process';
import { resolveRepoIdentity } from '../repo-identity.mjs';
import { getRepoIdByUuid, isCloudEnabled } from './repo.mjs';
import { getAuditRunWindowCounts, getAuditFindingConversionRate } from './runs-findings.mjs';
import { getPlanWindowCounts } from './plans.mjs';
import { getShipEventWindowCounts } from './ship-events.mjs';
import { getPersonaSessionWindowCounts } from './persona.mjs';
import { getNavAuditWindowCounts } from './nav-audit.mjs';
import { getRegressionSpecWindowCounts } from './regression-specs.mjs';

/** The seven read-only/meta skills whose ONLY signal is the git trailer proxy. */
const TRAILER_ONLY_SKILLS = Object.freeze([
  'explain', 'investigate', 'brainstorm', 'security-strategy',
  'ai-context-management', 'cycle', 'skills',
]);

/** No DB table at all, by deliberate design; still get a trailer-proxy fallback row. */
const NO_TABLE_SKILLS = Object.freeze(['click-test', 'visual-audit']);

/** All sixteen skill names, in the bundle's own documented order. */
export const ALL_SKILLS = Object.freeze([
  'audit-code', 'audit-plan', 'plan', 'ship', 'persona-test', 'nav-audit', 'ux-lock',
  'click-test', 'visual-audit',
  ...TRAILER_ONLY_SKILLS,
]);

/**
 * Current/prior/now bounds for the window semantics (§2): `current` =
 * `[now - windowDays, now)`; `prior` = `[now - 2*windowDays, now -
 * windowDays)` — both from the SAME `now` snapshot, never re-evaluated per
 * row, so the two windows are always contiguous and non-overlapping.
 *
 * @param {number} windowDays
 * @param {number} nowMs epoch ms — pass explicitly so the function is testable
 * @returns {{currentStart: string, priorStart: string, now: string}}
 */
export function computeWindowBounds(windowDays, nowMs) {
  const DAY_MS = 86_400_000;
  return {
    currentStart: new Date(nowMs - windowDays * DAY_MS).toISOString(),
    priorStart: new Date(nowMs - 2 * windowDays * DAY_MS).toISOString(),
    now: new Date(nowMs).toISOString(),
  };
}

/**
 * `trend` = raw delta AND a percentage (never just one — a delta with no
 * base rate hides direction on a near-zero prior).
 * @param {number} current
 * @param {number} prior
 * @returns {{delta: number, pct: number|null}}
 */
export function buildTrend(current, prior) {
  const delta = current - prior;
  const pct = prior > 0 ? Number(((delta / prior) * 100).toFixed(1)) : null;
  return { delta, pct };
}

/**
 * Parse this checkout's own commit history into `{sha, committerDate,
 * skills[]}` records — the trailer proxy's raw material. One tab-separated
 * record per commit (sha, committer date `%cI`, trailer value(s)); a commit
 * with more than one `AI-Skill` trailer (unobserved in this repo's history)
 * splits on `\x1f` and counts toward every distinct skill named.
 *
 * @param {string} root
 * @returns {{ok: boolean, commits: Array<{sha:string, committerDate:string, skills:string[]}>}}
 */
export function parseTrailerCommits(root) {
  try {
    // The trailers directive's own options are COMMA-separated after
    // `trailers:` (key=..., valueonly, separator=...) — a colon before
    // `separator=` makes git fail to recognise the whole placeholder and
    // print it back literally, unexpanded, with NO error (caught live
    // against this repo's own history during manual verification: a raw
    // `grep click-test` on the colon-form's output matched zero rows
    // against a confirmed 4 in the plain trailers-only form).
    const out = execFileSync(
      'git',
      ['log', '--format=%H%x09%cI%x09%(trailers:key=AI-Skill,valueonly,separator=%x1f)'],
      { cwd: root, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const commits = out.split('\n').filter(Boolean).map((line) => {
      const [sha, committerDate, trailerField] = line.split('\t');
      const skills = (trailerField || '').split('\x1f').map((s) => s.trim()).filter(Boolean);
      return { sha, committerDate, skills };
    });
    return { ok: true, commits };
  } catch (err) {
    return { ok: false, commits: [], error: err.message };
  }
}

/**
 * Count one skill's trailer-tagged commits into current/prior/allTime
 * buckets. Compares EPOCH MILLISECONDS, never the raw ISO strings (round-1
 * M2/M5 fix): `%cI` retains each commit's own UTC offset (e.g.
 * `+02:00`), and lexical string comparison against a UTC (`Z`-suffixed)
 * bound is unreliable across differing offsets — a commit at
 * `2026-08-08T01:00:00+02:00` (23:00 UTC the PRIOR day) can sort lexically
 * AFTER `2026-08-08T00:00:00.000Z`, landing it in the wrong window.
 */
function countTrailerSkill(commits, skillName, { currentStart, priorStart, now }) {
  const currentStartMs = Date.parse(currentStart);
  const priorStartMs = Date.parse(priorStart);
  const nowMs = Date.parse(now);
  let current = 0, prior = 0, allTime = 0;
  for (const c of commits) {
    if (!c.skills.includes(skillName)) continue;
    allTime += 1;
    const t = Date.parse(c.committerDate);
    if (t >= currentStartMs && t < nowMs) current += 1;
    else if (t >= priorStartMs && t < currentStartMs) prior += 1;
  }
  return { current, prior, allTime };
}

/** Build a `ship-attribution-only` row from parsed trailer commits. */
function trailerRow(skillName, trailerCommits, bounds) {
  if (!trailerCommits.ok) {
    return {
      skill: skillName, signalSource: 'git AI-Skill trailer (this checkout)',
      signalQuality: 'ship-attribution-only', effectiveSince: null,
      window: { current: 0, prior: 0 }, allTimeCount: 0, trend: { delta: 0, pct: null },
      conversionRate: null, lastRunAt: null,
      caveat: `git log failed: ${trailerCommits.error} — trailer proxy unavailable this run.`,
    };
  }
  const c = countTrailerSkill(trailerCommits.commits, skillName, bounds);
  const last = trailerCommits.commits.find((commit) => commit.skills.includes(skillName));
  return {
    skill: skillName, signalSource: 'git AI-Skill trailer (this checkout)',
    signalQuality: 'ship-attribution-only', effectiveSince: null,
    window: { current: c.current, prior: c.prior }, allTimeCount: c.allTime,
    trend: buildTrend(c.current, c.prior), conversionRate: null,
    lastRunAt: last ? last.committerDate : null,
    caveat: 'ship-time attribution, not an invocation count — a read-only session that never produces a commit leaves no trailer at all. Proxy signal reflects THIS checkout\'s commit history.',
  };
}

/** DB-source rows share this envelope-building shape. */
function dbRow({ skill, signalSource, signalQuality, effectiveSince, counts, conversionRate = null, caveat }) {
  if (!counts) {
    return {
      skill, signalSource, signalQuality, effectiveSince,
      window: { current: null, prior: null }, allTimeCount: null, trend: { delta: null, pct: null },
      conversionRate: null, lastRunAt: null, caveat: `${caveat} (source unavailable this run — missing-optional)`,
    };
  }
  return {
    skill, signalSource, signalQuality, effectiveSince,
    window: { current: counts.current, prior: counts.prior }, allTimeCount: counts.allTime,
    trend: buildTrend(counts.current, counts.prior), conversionRate, lastRunAt: null, caveat,
  };
}

/**
 * One async builder per DB-backed skill (§2's per-skill contract table).
 * Each receives `{repoId, bounds}` and returns a finished row.
 */
const SKILL_BUILDERS = {
  async 'audit-code'({ repoId, bounds }) {
    const counts = await getAuditRunWindowCounts(repoId, 'code', bounds);
    const rate = await getAuditFindingConversionRate(repoId, 'code', bounds);
    return {
      skill: 'audit-code', signalSource: 'audit_runs (mode=code)', signalQuality: 'caller-checked',
      effectiveSince: null,
      window: counts ? { current: counts.commitsTouched.current, prior: counts.commitsTouched.prior } : { current: null, prior: null },
      allTimeCount: counts ? counts.commitsTouched.allTime : null,
      trend: counts ? buildTrend(counts.commitsTouched.current, counts.commitsTouched.prior) : { delta: null, pct: null },
      roundCount: counts ? counts.roundCount : null,
      conversionRate: rate,
      lastRunAt: null,
      caveat: counts
        ? 'window/allTime/trend use commitsTouched (a LOWER BOUND on invocations); roundCount is the raw per-round row count, reported separately — never collapsed into one number.'
        : 'source unavailable this run — missing-optional.',
    };
  },
  async 'audit-plan'({ repoId, bounds }) {
    const counts = await getAuditRunWindowCounts(repoId, 'plan', bounds);
    const rate = await getAuditFindingConversionRate(repoId, 'plan', bounds);
    return {
      skill: 'audit-plan', signalSource: 'audit_runs (mode=plan)', signalQuality: 'caller-checked',
      effectiveSince: null,
      window: counts ? { current: counts.commitsTouched.current, prior: counts.commitsTouched.prior } : { current: null, prior: null },
      allTimeCount: counts ? counts.commitsTouched.allTime : null,
      trend: counts ? buildTrend(counts.commitsTouched.current, counts.commitsTouched.prior) : { delta: null, pct: null },
      roundCount: counts ? counts.roundCount : null,
      conversionRate: rate,
      lastRunAt: null,
      caveat: counts
        ? 'window/allTime/trend use commitsTouched (a LOWER BOUND on invocations); roundCount is the raw per-round row count, reported separately — never collapsed into one number.'
        : 'source unavailable this run — missing-optional.',
    };
  },
  async plan({ repoId, bounds }) {
    const counts = await getPlanWindowCounts(repoId, bounds);
    return dbRow({
      skill: 'plan', signalSource: "plans (skill='plan')", signalQuality: 'caller-checked',
      effectiveSince: null, counts, caveat: 'row count of plans authored via /plan; excludes skill=\'manual\' rows.',
    });
  },
  async ship({ repoId, bounds }) {
    const counts = await getShipEventWindowCounts(repoId, bounds);
    return dbRow({
      skill: 'ship', signalSource: 'ship_events', signalQuality: 'caller-checked',
      effectiveSince: null, counts, caveat: 'row count of recorded ship outcomes.',
    });
  },
  async 'persona-test'({ repoName, repoId, bounds }) {
    const counts = await getPersonaSessionWindowCounts({ repoName, repoId, ...bounds });
    return dbRow({
      skill: 'persona-test', signalSource: 'persona_test_sessions', signalQuality: 'caller-checked',
      effectiveSince: null, counts, caveat: 'repo-scoped like every other row — thinness at low n is a reliability caveat, never a reason to widen scope.',
    });
  },
  async 'nav-audit'({ repoId, bounds }) {
    const counts = await getNavAuditWindowCounts(repoId, bounds);
    return dbRow({
      skill: 'nav-audit', signalSource: 'nav_audit_runs', signalQuality: 'unchecked-call-site',
      effectiveSince: '2026-08-22', counts,
      caveat: 'written best-effort from a bare execFileSync; the telemetry catch was narrowed to log a write failure on 2026-08-22 — rows before that date carry irreducible ambiguity between "ran once, successfully" and "ran, and the write silently failed".',
    });
  },
  async 'ux-lock'({ repoId, bounds }) {
    const counts = await getRegressionSpecWindowCounts(repoId, bounds);
    return dbRow({
      skill: 'ux-lock', signalSource: "regression_specs (source_kind != 'unit-test')", signalQuality: 'caller-checked',
      effectiveSince: null, counts,
      caveat: 'measures SPECS AUTHORED, not invocations — one session can author several; --verify-mode sessions author none and are invisible to every signal this census has.',
    });
  },
};

/**
 * Run the full 16-skill census for the repo at `root`.
 *
 * @param {object} opts
 * @param {string} opts.root local checkout path (defaults to cwd)
 * @param {number} [opts.windowDays=14]
 * @param {number} [opts.nowMs] epoch ms — pass explicitly in tests
 * @param {string} [opts.repoNameOverride] disambiguator (mirrors final-review-pending's --repo contract)
 * @returns {Promise<{ok:boolean, cloud:boolean, repoId:string|null, windowDays:number, rows: object[]}>}
 */
export async function censusAllSkills({ root = process.cwd(), windowDays = 14, nowMs = Date.now(), repoNameOverride } = {}) {
  const bounds = computeWindowBounds(windowDays, nowMs);
  let repoId = null;
  let repoName = repoNameOverride ?? null;
  try {
    const identity = resolveRepoIdentity(root);
    repoName = repoNameOverride ?? identity?.name ?? null;
    if (identity?.repoUuid && await isCloudEnabled()) {
      const row = await getRepoIdByUuid(identity.repoUuid);
      repoId = row?.id ?? null;
    }
  } catch { /* repo identity unresolvable — DB-backed rows fall back to missing-optional below */ }

  const cloudUp = await isCloudEnabled();
  const rows = [];

  for (const skill of ['audit-code', 'audit-plan', 'plan', 'ship', 'persona-test', 'nav-audit', 'ux-lock']) {
    if (!cloudUp || !repoId) {
      rows.push({
        skill, signalSource: 'postgres (unavailable)', signalQuality: 'unchecked-call-site',
        effectiveSince: null, window: { current: null, prior: null }, allTimeCount: null,
        trend: { delta: null, pct: null }, conversionRate: null, lastRunAt: null,
        caveat: cloudUp ? 'no canonical repo row resolvable for this checkout — missing-optional.' : 'cloud store off — missing-optional.',
      });
      continue;
    }
    rows.push(await SKILL_BUILDERS[skill]({ repoId, repoName, bounds }));
  }

  const trailerCommits = parseTrailerCommits(root);
  for (const skill of TRAILER_ONLY_SKILLS) rows.push(trailerRow(skill, trailerCommits, bounds));
  for (const skill of NO_TABLE_SKILLS) {
    const row = trailerRow(skill, trailerCommits, bounds);
    row.signalQuality = 'no-table-by-design';
    row.caveat = 'no-table-by-design for the DB dimension; the window/allTime/trend/lastRunAt figures above are its trailer-proxy fallback (it can still ship an AI-Skill-tagged commit) — never a "checked and rejected" zero.';
    rows.push(row);
  }

  const anyRealData = rows.some((r) => (r.window.current ?? 0) > 0 || (r.window.prior ?? 0) > 0 || (r.allTimeCount ?? 0) > 0);
  return { ok: trailerCommits.ok || anyRealData, cloud: cloudUp, repoId, repoName, windowDays, rows };
}

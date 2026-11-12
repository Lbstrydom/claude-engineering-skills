/**
 * @fileoverview Audit convergence metrics (item 8d) — PURE over `audit_runs` rows.
 *
 * `audit_runs` holds one row per ROUND. A "change" is therefore a session of
 * consecutive rounds, and "pass" is the first round that met the gate. The
 * definitions are written down in docs/plans/audit-convergence-metrics.md §2;
 * this module is their only implementation.
 *
 * Nothing is dropped silently: every excluded row/session lands in a named
 * counter, and a group with nothing eligible reads `unmeasured`, never 0%.
 *
 * @module scripts/lib/audit/convergence-metrics
 */

export const DEFAULT_GAP_HOURS = 24;
const HOUR_MS = 3_600_000;

/** @param {object} r an audit_runs row */
export function isExperimentRow(r) {
  return Boolean(r.assignment_id || r.arm_eval_run_id || r.phase);
}

/**
 * Did this ROUND pass? INCOMPLETE rounds (a lost write) are unmeasured, never a pass.
 * Code: the code-computed convergence stamp. Plan: an APPROVE verdict.
 * @param {object} r
 * @returns {boolean}
 */
export function roundPassed(r) {
  if (r.run_status && r.run_status !== 'complete') return false;
  if (r.mode === 'plan') return r.gemini_verdict === 'APPROVE';
  return r.round_converged_after != null;
}

// node-postgres hands back millisecond Dates, but the store orders at microsecond precision. `ord` is the
// store's own row order (ORDER BY created_at, id), so it breaks ms ties without re-deriving what the DB knew.
function byTimeThenId(a, b) {
  if (ms(a) !== ms(b)) return ms(a) - ms(b);
  if (a.ord != null && b.ord != null) return a.ord - b.ord;
  return String(a.id).localeCompare(String(b.id));
}

function ms(r) {
  return r.created_at instanceof Date ? r.created_at.getTime() : Date.parse(r.created_at);
}

/**
 * Group rows into audited sessions.
 *
 * @param {Array<object>} rows audit_runs rows (any order)
 * @param {{gapHours?: number}} [opts]
 * @returns {{sessions: Array<object>, excluded: {experiment:number, notFinalised:number}}}
 */
export function groupSessions(rows, { gapHours = DEFAULT_GAP_HOURS, fetchStartMs = null } = {}) {
  const gapMs = gapHours * HOUR_MS;
  const excluded = { experiment: 0, notFinalised: 0 };
  const byId = new Map();
  const byKey = new Map();

  for (const r of rows) {
    if (isExperimentRow(r)) { excluded.experiment += 1; continue; }
    if (!(Number(r.rounds) > 0)) { excluded.notFinalised += 1; continue; }
    if (r.audit_session_id) {
      const k = `${r.repo_id}\u0000${r.mode}\u0000${r.audit_session_id}`;
      if (!byId.has(k)) byId.set(k, []);
      byId.get(k).push(r);
    } else {
      const k = `${r.repo_id}\u0000${r.mode}\u0000${r.plan_file}\u0000${r.branch}`;
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(r);
    }
  }

  const groups = [];
  for (const g of byId.values()) groups.push({ rows: g, groupedBy: 'session-id' });
  for (const g of byKey.values()) {
    g.sort(byTimeThenId);
    let cur = [];
    for (const r of g) {
      const prev = cur[cur.length - 1];
      // Equal round numbers are re-runs of the SAME round (measured: up to 8 rows per round), so only a strict
      // drop (a restart) or a long silence starts a new session.
      if (prev && (Number(r.rounds) < Number(prev.rounds) || ms(r) - ms(prev) > gapMs)) {
        groups.push({ rows: cur, groupedBy: 'inferred' });
        cur = [];
      }
      cur.push(r);
    }
    if (cur.length) groups.push({ rows: cur, groupedBy: 'inferred' });
  }

  const sessions = groups.map(({ rows: g, groupedBy }) => {
    g.sort(byTimeThenId);
    const first = g[0];
    const last = g[g.length - 1];
    const pass = g.find(roundPassed) || null;
    const upto = pass ? g.slice(0, g.indexOf(pass) + 1) : g;
    // Reviews = DISTINCT round numbers up to the pass: the counter often does not start at 1.
    const reviews = new Set(upto.map((x) => Number(x.rounds))).size;
    // A lost write (incomplete round) at or before the pass may have hidden an earlier pass: the outcome or
    // the pass round is not known, so the session is `unknown`, never a precise rounds-to-pass.
    const unknown = upto.some((x) => x.run_status && x.run_status !== 'complete');
    return {
      mode: first.mode,
      repoId: first.repo_id,
      repoName: first.repo_name || String(first.repo_id),
      planFile: first.plan_file,
      branch: first.branch,
      groupedBy,
      rowCount: g.length,
      firstRound: Number(first.rounds),
      lastAt: ms(last),
      passed: Boolean(pass) && !unknown,
      roundsToPass: pass && !unknown ? reviews : null,
      // The head may be cut by the fetch start: rounds-to-pass is then only a lower bound.
      // Identified sessions have no gap boundary, so their own audit_round says whether round 1 was seen.
      truncatedHead: (fetchStartMs != null && ms(first) - fetchStartMs < gapMs)
        || (groupedBy === 'session-id' && (first.audit_round == null || Number(first.audit_round) > 1)),
      startsMidChain: Number(first.rounds) > 1,
      weakKey: groupedBy === 'inferred' && (first.plan_file === 'ad-hoc' || first.branch === 'HEAD'),
      incompleteRounds: g.filter((x) => x.run_status && x.run_status !== 'complete').length,
      unknown,
    };
  });
  return { sessions, excluded };
}

function round1(x) { return Math.round(x * 1000) / 1000; }

function median(sorted) {
  const n = sorted.length;
  if (!n) return null;
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

/**
 * Metrics for one group of sessions. Zero passed sessions reads `unmeasured`.
 * @param {Array<object>} sessions already filtered to window + non-headless
 * @param {{nowMs:number, gapHours:number}} ctx
 */
export function metricsFor(sessions, { nowMs, gapHours }) {
  const passed = sessions.filter((s) => s.passed);
  const unknown = sessions.filter((s) => s.unknown);
  const unpassed = sessions.filter((s) => !s.passed && !s.unknown);
  const settledUnpassed = unpassed.filter((s) => nowMs - s.lastAt > gapHours * HOUR_MS).length;
  const base = {
    sessions: sessions.length,
    passed: passed.length,
    unpassed: unpassed.length,
    unknownOutcome: unknown.length,
    startsMidChain: sessions.filter((s) => s.startsMidChain).length,
    unpassedSettled: settledUnpassed,
    unpassedOpen: unpassed.length - settledUnpassed,
    incompleteRounds: sessions.reduce((a, s) => a + s.incompleteRounds, 0),
    weakKey: sessions.filter((s) => s.weakKey).length,
    inferredSessions: sessions.filter((s) => s.groupedBy === 'inferred').length,
    sessionIdSessions: sessions.filter((s) => s.groupedBy === 'session-id').length,
  };
  if (!passed.length) {
    return {
      ...base, status: 'unmeasured',
      reason: sessions.length ? 'no session in the window reached a passing round' : 'no eligible sessions in the window',
      passedFirstRoundShare: null, fiveOrMoreShare: null, meanRoundsToPass: null, medianRoundsToPass: null,
      passRate: settledUnpassed > 0 ? 0 : null,
    };
  }
  const rtp = passed.map((s) => s.roundsToPass).sort((a, b) => a - b);
  const settledDenominator = passed.length + settledUnpassed;
  return {
    ...base, status: 'measured', reason: null,
    passedFirstRoundShare: round1(passed.filter((s) => s.roundsToPass === 1).length / passed.length),
    fiveOrMoreShare: round1(passed.filter((s) => s.roundsToPass >= 5).length / passed.length),
    meanRoundsToPass: round1(rtp.reduce((a, b) => a + b, 0) / rtp.length),
    medianRoundsToPass: median(rtp),
    passRate: round1(passed.length / settledDenominator),
  };
}

/**
 * Full report: per mode, overall and per repo.
 *
 * @param {Array<object>} rows rows fetched with a lookback before `windowStartMs`
 * @param {{windowStartMs:number, fetchStartMs?:number|null, nowMs?:number, gapHours?:number, mode?:'code'|'plan'|'all', repo?:string|null}} opts
 */
export function buildReport(rows, { windowStartMs, fetchStartMs = null, nowMs = Date.now(), gapHours = DEFAULT_GAP_HOURS, mode = 'all', repo = null }) {
  // Mode and repo are part of every session key, so filtering ROWS first cannot split a session, and it
  // gives every exclusion counter the same scope as the metrics.
  const scopedRows = rows.filter((r) => (mode === 'all' || r.mode === mode)
    && (!repo || r.repo_name === repo || String(r.repo_id) === repo));
  const { sessions, excluded } = groupSessions(scopedRows, { gapHours, fetchStartMs });
  const scoped = sessions;
  const inWindow = scoped.filter((s) => s.lastAt >= windowStartMs);
  const truncated = inWindow.filter((s) => s.truncatedHead);
  const eligible = inWindow.filter((s) => !s.truncatedHead);
  const ctx = { nowMs, gapHours };

  const byMode = {};
  for (const m of ['code', 'plan']) {
    if (mode !== 'all' && mode !== m) continue;
    const ofMode = eligible.filter((s) => s.mode === m);
    // Keyed by repo ID; a display name shared by two repos gets the full id appended, never merged.
    const ids = [...new Set(ofMode.map((s) => s.repoId))];
    const nameOf = (id) => ofMode.find((s) => s.repoId === id).repoName;
    const dupName = (id) => ids.filter((o) => nameOf(o) === nameOf(id)).length > 1;
    const label = (id) => (dupName(id) ? `${nameOf(id)} (${String(id)})` : nameOf(id));
    ids.sort((a, b) => label(a).localeCompare(label(b)));
    byMode[m] = {
      overall: metricsFor(ofMode, ctx),
      byRepo: Object.fromEntries(ids.map((id) => [label(id), metricsFor(ofMode.filter((s) => s.repoId === id), ctx)])),
    };
  }
  return {
    window: { startIso: new Date(windowStartMs).toISOString(), asOfIso: new Date(nowMs).toISOString(), gapHours },
    definitionVersion: 1,
    excluded: {
      experimentRows: excluded.experiment,
      notFinalisedRows: excluded.notFinalised,
      truncatedHeadSessions: truncated.length,
      outsideWindowSessions: scoped.length - inWindow.length,
    },
    byMode,
  };
}

/** One-line summary for stdout when --out is used. */
export function summaryLine(report) {
  const parts = [];
  for (const [m, v] of Object.entries(report.byMode)) {
    const o = v.overall;
    parts.push(o.status === 'measured'
      ? `${m}: ${o.passed} passed, ${(o.passedFirstRoundShare * 100).toFixed(0)}% first-round, ${(o.fiveOrMoreShare * 100).toFixed(0)}% 5+ rounds, mean ${o.meanRoundsToPass}`
      : `${m}: unmeasured (${o.reason})`);
  }
  return `audit-convergence: ${parts.join(' | ')}`;
}

/**
 * Flatten a report into dashboard rows: one per (mode, repo), "all repos" first.
 * @param {ReturnType<typeof buildReport>} report
 */
export function flattenReport(report) {
  const rows = [];
  for (const [mode, v] of Object.entries(report.byMode)) {
    rows.push({ mode, repo: 'all repos', ...v.overall });
    for (const [repo, m] of Object.entries(v.byRepo)) rows.push({ mode, repo, ...m });
  }
  return rows;
}

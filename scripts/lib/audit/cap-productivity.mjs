/**
 * @fileoverview Did the round cap stop an audit that was still productive?
 *
 * **The report (work consumer, 2026-11-15).** Plan audits hit the 3-round cap at
 * 100% acceptance with HIGH findings at 7→5→5 — every round was buying real
 * corrections, and the cap ended the run anyway. The cap POLICY is not changed
 * here. What was missing is evidence: the structural-or-stop card said "capped"
 * and nothing said "capped while every finding was still being accepted", so a
 * policy decision could only be argued from anecdote.
 *
 * Two outputs, one assessment:
 *   - the card states it (`renderCapProductivity`), so the operator reading the
 *     cap sees the acceptance rate of the last triaged round and the HIGH trend;
 *   - `recordCapStop` writes an observation-only `round_cap_stop` learning
 *     decision (no migration: `learning_decisions.decision_type` is free text),
 *     so the policy can later be decided on data.
 *
 * **Acceptance has ONE formula** (`roundAcceptance`): `write-ledger-entries`
 * prints it per round and this module reads it back from the ledger, so the
 * number on the card cannot drift from the number the operator saw at triage.
 * A ledger entry carries the round it was last ruled in (`resolvedRound`), so
 * the entries whose `resolvedRound` is the last round ARE that round's rulings.
 *
 * Unmeasured is never "not productive": no ledger, or a last round nobody
 * triaged, reads `stillProductive: null` with the reason.
 *
 * @module scripts/lib/audit/cap-productivity
 */
import fs from 'node:fs';
import path from 'node:path';

/** At or above this acceptance a round is PRODUCTIVE (the /audit-plan convergence table's "≥ ~⅔"). */
export const PRODUCTIVE_ACCEPTANCE = 2 / 3;

/** The learning decision type this module records. */
export const CAP_STOP_DECISION_TYPE = 'round_cap_stop';

/**
 * The round's acceptance rate — the one formula. `outcome` is the adjudication
 * outcome, `ruling` the triage ruling (`defer` is never acceptance).
 * @param {Array<{outcome?: string, ruling?: string}>} rulings
 * @returns {{ruled: number, accepted: number, adjusted: number, dismissed: number, deferred: number, acceptanceRate: number}}
 */
export function roundAcceptance(rulings) {
  const ruled = rulings || [];
  const accepted = ruled.filter((t) => t.outcome === 'accepted' && t.ruling !== 'defer').length;
  const adjusted = ruled.filter((t) => t.outcome === 'severity_adjusted').length;
  const deferred = ruled.filter((t) => t.ruling === 'defer').length;
  const dismissed = ruled.filter((t) => t.outcome === 'dismissed' && t.ruling !== 'defer').length;
  const acceptanceRate = ruled.length > 0 ? (accepted + adjusted) / ruled.length : 0;
  return { ruled: ruled.length, accepted, adjusted, dismissed, deferred, acceptanceRate };
}

/**
 * @param {{rounds: Array<{round: number, findings: object[], runId?: string|null}>|null, ledgerEntries: object[]|null, ledgerUnmeasured?: string|null}} input
 * @returns {{lastRound: number|null, lastRunId: string|null, acceptanceRate: number|null, ruled: number, highByRound: number[],
 *   stillProductive: boolean|null, unmeasured: string|null}}
 */
export function assessCapProductivity({ rounds, ledgerEntries, ledgerUnmeasured = null }) {
  const sorted = [...(rounds || [])].sort((a, b) => a.round - b.round);
  const highByRound = sorted.map((r) => (r.findings || []).filter((f) => String(f?.severity).toUpperCase() === 'HIGH').length);
  const lastRound = sorted.length ? sorted[sorted.length - 1].round : null;
  const lastRunId = sorted.length ? (sorted[sorted.length - 1].runId ?? null) : null;
  const base = { lastRound, lastRunId, acceptanceRate: null, ruled: 0, highByRound, stillProductive: null };
  if (lastRound == null) return { ...base, unmeasured: 'no round results' };
  if (!ledgerEntries) return { ...base, unmeasured: ledgerUnmeasured || 'no ledger' };
  const last = ledgerEntries.filter((e) => e?.resolvedRound === lastRound)
    .map((e) => ({ outcome: e.adjudicationOutcome, ruling: e.ruling }));
  if (last.length === 0) return { ...base, unmeasured: `round ${lastRound} has no rulings in the ledger (not triaged)` };
  const a = roundAcceptance(last);
  return { ...base, acceptanceRate: a.acceptanceRate, ruled: a.ruled, stillProductive: a.acceptanceRate >= PRODUCTIVE_ACCEPTANCE, unmeasured: null };
}

/**
 * Read `<auditDir>/<sid>-ledger.json`. Never throws.
 * @returns {{entries: object[]|null, unmeasured: string|null}}
 */
export function readLedgerEntries({ sid, auditDir }) {
  if (!sid) return { entries: null, unmeasured: 'no session id' };
  const p = path.join(auditDir, `${sid}-ledger.json`);
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); } catch (err) {
    return { entries: null, unmeasured: err?.code === 'ENOENT' ? `no ledger at ${path.basename(p)}` : `ledger unreadable (${err?.code || err})` };
  }
  try {
    const j = JSON.parse(raw);
    return Array.isArray(j?.entries) ? { entries: j.entries, unmeasured: null } : { entries: null, unmeasured: 'ledger has no entries[]' };
  } catch { return { entries: null, unmeasured: 'ledger is not valid JSON' }; }
}

/**
 * The card line. Says plainly when the cap, not convergence, stopped the run.
 * @param {ReturnType<typeof assessCapProductivity>|null} p
 * @returns {string|null}
 */
export function renderCapProductivity(p) {
  if (!p) return null;
  const trend = p.highByRound.length ? `HIGH ${p.highByRound.join('→')}` : 'HIGH n/a';
  if (p.stillProductive === null) return `Last round acceptance: UNMEASURED (${p.unmeasured}) · ${trend}`;
  const pct = `${Math.round(p.acceptanceRate * 100)}%`;
  if (p.stillProductive) {
    return `⚠ CAPPED WHILE PRODUCTIVE — round ${p.lastRound} acceptance ${pct} of ${p.ruled} ruled · ${trend}: `
      + 'the cap stopped this run, not convergence. Recorded as round_cap_stop telemetry; the cap policy is unchanged.';
  }
  return `Last round: acceptance ${pct} of ${p.ruled} ruled · ${trend} — below the productive line; the cap and the loop agree.`;
}

/**
 * Record the cap stop as an observation-only learning decision and flush it.
 * Best-effort: never throws, and reports what it did.
 * @param {{sid: string|null, mode: string, round: number, caps: {soft: number, absolute: number}|null,
 *   productivity: ReturnType<typeof assessCapProductivity>, runId?: string|null}} input
 * @param {{record?: Function, flush?: Function}} [deps] - test seams
 * @returns {Promise<{recorded: boolean, reason: string|null}>}
 */
export async function recordCapStop({ sid, mode, round, caps, productivity, runId = null }, deps = {}) {
  try {
    const keyOk = (v) => typeof v === 'string' && v.trim() !== '' && !v.includes(':');
    const bound = keyOk(runId) ? { auditRunId: runId, round, sequence: 0 }
      : keyOk(sid) ? { externalId: `${sid}-r${round}-cap` } : null;
    if (!bound) return { recorded: false, reason: 'no run id or session id to key the decision' };
    const record = deps.record ?? (await import('../learning/decision-logger.mjs')).recordDecision;
    const key = record({
      decisionType: CAP_STOP_DECISION_TYPE,
      ...bound,
      context: {
        mode, requestedRound: round, softCap: caps?.soft ?? null, absoluteCap: caps?.absolute ?? null,
        lastRound: productivity.lastRound, acceptanceRate: productivity.acceptanceRate, ruled: productivity.ruled,
        highByRound: productivity.highByRound, unmeasured: productivity.unmeasured,
      },
      choice: { chose: 'stop_at_cap', stillProductive: productivity.stillProductive },
      outcome: null,
    });
    if (!key) return { recorded: false, reason: 'not admitted (LEARNING_DISABLE=1 or back-pressure)' };
    const flush = deps.flush ?? (async () => {
      const [{ flush: f }, store] = await Promise.all([import('../learning/decision-logger.mjs'), import('../../learning-store.mjs')]);
      return f({ store });
    });
    await flush();
    return { recorded: true, reason: null };
  } catch (err) {
    return { recorded: false, reason: String(err?.message || err) };
  }
}

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
 *   - `recordCapStop` writes an observation-only `round_cap_reached` learning
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
import { generateTopicId, populateFindingMetadata } from '../ledger.mjs';

/** A finding's ledger topic, derived on a COPY exactly as write-ledger-entries derives it (never mutates the input). */
export function topicOf(finding) {
  const f = { ...finding };
  populateFindingMetadata(f, f._pass);
  return generateTopicId(f);
}

/** At or above this acceptance a round is PRODUCTIVE (the /audit-plan convergence table's "≥ ~⅔"). */
export const PRODUCTIVE_ACCEPTANCE = 2 / 3;

/** The learning decision type this module records. */
export const CAP_REACHED_DECISION_TYPE = 'round_cap_reached';

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
  // Ledger entries are one per CONCERN (topicId), so compare concerns with concerns: the last round's own topics,
  // derived exactly as write-ledger-entries derives them. The rate counts ONLY rulings for those topics — an entry
  // stamped with this round number for a concern the result no longer carries (a re-run, a hand edit) is not
  // this round's ruling — and every one of those topics must be ruled, or the round is partially triaged.
  const topics = new Set((sorted[sorted.length - 1].findings || []).map(topicOf));
  const mine = ledgerEntries.filter((e) => e?.resolvedRound === lastRound && topics.has(e.topicId));
  const last = mine.map((e) => ({ outcome: e.adjudicationOutcome, ruling: e.ruling }));
  if (last.length === 0) return { ...base, unmeasured: `round ${lastRound} has no rulings in the ledger (not triaged)` };
  const ruledTopics = new Set(mine.map((e) => e.topicId));
  const unruled = [...topics].filter((t) => !ruledTopics.has(t)).length;
  if (unruled > 0) return { ...base, ruled: last.length, unmeasured: `round ${lastRound} partially triaged (${topics.size - unruled} of ${topics.size} concerns ruled)` };
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
 * The card line. Claims the CAP only when the card is for a round past the soft
 * cap — a card built earlier says what the last round measured and nothing about
 * a stop. It never claims the telemetry was written: `recordCapStop` reports its
 * own outcome where it runs.
 * @param {ReturnType<typeof assessCapProductivity>|null} p
 * @param {{round?: number|null, caps?: {soft: number}|null}} [at] - the card's requested round and caps
 * @returns {string|null}
 */
export function renderCapProductivity(p, { round = null, caps = null } = {}) {
  if (!p) return null;
  const trend = p.highByRound.length ? `HIGH ${p.highByRound.join('→')}` : 'HIGH n/a';
  if (p.stillProductive === null) return `Last round acceptance: UNMEASURED (${p.unmeasured}) · ${trend}`;
  const pct = `${Math.round(p.acceptanceRate * 100)}%`;
  const measured = `round ${p.lastRound} acceptance ${pct} of ${p.ruled} ruled · ${trend}`;
  if (!atCap({ round, caps })) return `Last round: ${measured}${p.stillProductive ? ' (productive)' : ''}.`;
  if (p.stillProductive) {
    return `⚠ AT THE CAP WHILE PRODUCTIVE — ${measured}: if the run stops here, the cap stopped it, not convergence. `
      + 'Say so in the final report. The cap policy is unchanged.';
  }
  return `Last round: ${measured} — below the productive line; the cap and the loop agree.`;
}

/** Is this card for a round past the soft cap? */
export function atCap({ round, caps }) {
  return Number.isInteger(round) && Number.isInteger(caps?.soft) && round > caps.soft;
}

/**
 * Record the cap stop as an observation-only learning decision and flush it
 * (to the cloud store, or the learning outbox when it is off). Only for a round
 * past the soft cap. Best-effort: never throws, and reports what it did.
 * @param {{sid: string|null, mode: string, round: number, caps: {soft: number, absolute: number}|null,
 *   productivity: ReturnType<typeof assessCapProductivity>, runId?: string|null, trigger?: 'refused'|'on-demand'}} input
 * @param {{record?: Function, flush?: Function}} [deps] - test seams
 * @returns {Promise<{recorded: boolean, reason: string|null}>}
 */
export async function recordCapStop({ sid, mode, round, caps, productivity, runId = null, trigger = 'refused' }, deps = {}) {
  try {
    if (!atCap({ round, caps })) return { recorded: false, reason: `round ${round} is within the soft cap — no cap stop to record` };
    const keyOk = (v) => typeof v === 'string' && v.trim() !== '' && !v.includes(':');
    const bound = keyOk(runId) ? { auditRunId: runId, round, sequence: 0 }
      : keyOk(sid) ? { externalId: `${sid}-r${round}-cap` } : null;
    if (!bound) return { recorded: false, reason: 'no run id or session id to key the decision' };
    const record = deps.record ?? (await import('../learning/decision-logger.mjs')).recordDecision;
    const key = record({
      decisionType: CAP_REACHED_DECISION_TYPE,
      ...bound,
      context: {
        mode, trigger, requestedRound: round, softCap: caps?.soft ?? null, absoluteCap: caps?.absolute ?? null,
        lastRound: productivity.lastRound, acceptanceRate: productivity.acceptanceRate, ruled: productivity.ruled,
        highByRound: productivity.highByRound, unmeasured: productivity.unmeasured,
      },
      // `trigger`: 'refused' (openai-audit refused the round) or 'on-demand' (card read at the cap; the operator may still CONTINUE).
      choice: { chose: 'card_at_cap', stillProductive: productivity.stillProductive },
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

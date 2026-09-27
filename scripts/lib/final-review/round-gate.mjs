/**
 * @fileoverview The final-review ROUND GATE — the hard 2-round cap, the
 * round-2 "settled items" prompt block, and the code-computed gate disposition
 * (`approve` / `approve_with_debt` / `blocked`).
 *
 * **Why the disposition is computed here and not asked of the model.** Field
 * report 2026-09-26: a final reviewer was re-run 7 times, each run found fresh
 * items in a scope that had grown by every fix, and the last run called every
 * remaining finding "not release-blocking" while its verdict stayed
 * CONCERNS_REMAINING — so the gate could only be closed by a user override.
 * The verdict is the model's word and stays untouched; whether the gate may
 * close is a deterministic function of (verdict, per-finding
 * `release_blocking`/`blocking_basis`, wrongly_dismissed severities, coverage
 * gate), and deciding it in code is what makes it reproducible.
 *
 * **Why the cap is here and not in prose.** "Max 2 final-review rounds" lived
 * only in docs/audit/shared-references/gemini-gate.md and was not stated in
 * /audit-code's own Step 7 at all. `validateRoundArgs` makes `--round 3`
 * a refusal, so the cap no longer depends on an agent reading the right file.
 *
 * Domain: audit-orchestration (explicit rule in .audit-loop/domain-map.json) —
 * it reads `isRefuted`, the existence gate's single accessor, rather than
 * re-spelling that predicate.
 *
 * @module scripts/lib/final-review/round-gate
 */
import { isRefuted } from '../audit/finding-verification.mjs';
import { redactSecretsWithCount } from '../sensitive-egress-gate.mjs';
import { BLOCKING_BASIS_VALUES } from './output-schemas.mjs';

/** Hard cap on final-review rounds. Not a target — see gemini-gate.md. */
export const FINAL_REVIEW_MAX_ROUNDS = 2;

/**
 * Validate the release-blocking PAIR on one finding. The provider schema makes
 * both fields required but cannot express the pairing (no refinements reach a
 * provider), and the transport's Zod step is warn-and-keep — so a finding may
 * arrive with either field missing or the two contradicting each other.
 * @param {object} finding
 * @returns {{valid: boolean, reason: string|null}}
 */
export function checkBlockingPair(finding) {
  const rb = finding?.release_blocking;
  const basis = finding?.blocking_basis;
  if (typeof rb !== 'boolean') return { valid: false, reason: 'release_blocking missing or not boolean' };
  if (!BLOCKING_BASIS_VALUES.includes(basis)) return { valid: false, reason: `blocking_basis "${basis}" is not one of ${BLOCKING_BASIS_VALUES.join('|')}` };
  if (rb && basis === 'none') return { valid: false, reason: 'release_blocking=true with blocking_basis=none' };
  if (!rb && basis !== 'none') return { valid: false, reason: `release_blocking=false with blocking_basis=${basis}` };
  return { valid: true, reason: null };
}

/**
 * Does this finding block release? FAIL-CLOSED: an invalid or missing pair
 * counts as blocking, because "the reviewer did not say" must never read as
 * "the reviewer said it was fine". The one exemption is a finding the
 * existence gate REFUTED against the repo inventory — it is mechanically
 * false, so it can neither block nor become debt.
 * @param {object} finding
 * @returns {boolean}
 */
export function isReleaseBlocking(finding) {
  if (isRefuted(finding)) return false;
  if (!checkBlockingPair(finding).valid) return true;
  return finding.release_blocking === true;
}

/**
 * Compute the gate disposition from a (post-filtered) final-review result.
 *
 * - `blocked` — verdict REJECT; or the coverage gate downgraded the verdict
 *   (it rests on code the reviewer never received); or any non-refuted
 *   new_finding is release-blocking (fail-closed on a bad pair); or any
 *   non-refuted wrongly_dismissed entry is HIGH (a HIGH finding Claude
 *   dismissed is re-opened, not debt); or the verdict is unrecognised.
 * - `approve` — verdict APPROVE and none of the above.
 * - `approve_with_debt` — verdict CONCERNS or CONCERNS_REMAINING and none of
 *   the above: every remaining new_finding is non-blocking and is to be
 *   captured as debt (`debt-auto-capture.mjs --final-review`).
 *
 * APPROVE with a release-blocking finding is `blocked`, not `approve`: the
 * two statements contradict, and the gate resolves a contradiction closed.
 *
 * @param {object} result
 * @returns {{disposition: 'approve'|'approve_with_debt'|'blocked', reasons: string[],
 *   blockingIds: string[], debtIds: string[], pairViolations: Array<{id: string, reason: string}>}}
 */
export function computeGateDisposition(result) {
  const verdict = result?.verdict;
  const findings = Array.isArray(result?.new_findings) ? result.new_findings : [];
  const dismissed = Array.isArray(result?.wrongly_dismissed) ? result.wrongly_dismissed : [];
  const live = findings.filter((f) => !isRefuted(f));
  const pairViolations = live
    .map((f) => ({ id: f.id ?? '?', ...checkBlockingPair(f) }))
    .filter((c) => !c.valid)
    .map(({ id, reason }) => ({ id, reason }));
  const blockingIds = live.filter(isReleaseBlocking).map((f) => f.id ?? '?');
  const debtIds = live.filter((f) => !isReleaseBlocking(f)).map((f) => f.id ?? '?');
  const highDismissed = dismissed.filter((d) => !isRefuted(d) && d.recommended_severity === 'HIGH');

  const reasons = [];
  if (verdict === 'REJECT') reasons.push('verdict REJECT');
  if (!['APPROVE', 'CONCERNS', 'CONCERNS_REMAINING', 'REJECT'].includes(verdict)) reasons.push(`unrecognised verdict "${verdict}"`);
  if (result?._coverageGate?.downgraded) reasons.push('coverage gate: the reviewer received none of the changed code');
  if (blockingIds.length > 0) reasons.push(`${blockingIds.length} release-blocking new finding(s): ${blockingIds.join(', ')}`);
  if (pairViolations.length > 0) reasons.push(`${pairViolations.length} finding(s) with an invalid release_blocking/blocking_basis pair (counted as blocking)`);
  if (highDismissed.length > 0) reasons.push(`${highDismissed.length} HIGH wrongly_dismissed: ${highDismissed.map((d) => d.original_finding_id).join(', ')}`);

  let disposition;
  if (reasons.length > 0) disposition = 'blocked';
  else if (verdict === 'APPROVE') disposition = 'approve';
  else disposition = 'approve_with_debt';
  return { disposition, reasons, blockingIds, debtIds, pairViolations };
}

/**
 * Compute the disposition and stamp it on the result (mutates). `gateDisposition`
 * is a first-class field — no underscore — because it is the gate's OUTPUT;
 * `verdict` beside it stays the model's own word.
 * @param {object} result
 * @param {number|null} [round] - null when --round was not given
 * @returns {string} the one-line summary fragment for stdout
 */
export function stampGateDisposition(result, round = null) {
  const d = computeGateDisposition(result);
  result.gateDisposition = d.disposition;
  result.gateDispositionDetail = {
    reasons: d.reasons, blockingIds: d.blockingIds, debtIds: d.debtIds, pairViolations: d.pairViolations,
  };
  result.finalReviewRound = round;
  const roundPart = round ? ` | Round ${round}/${FINAL_REVIEW_MAX_ROUNDS}` : '';
  return `Gate: ${d.disposition} (blocking ${d.blockingIds.length}, debt ${d.debtIds.length})${roundPart}`;
}

/**
 * Parse the `--prior` result file's content. Pure (content in).
 * @param {string} content
 * @returns {{ok: true, prior: object} | {ok: false, error: string}}
 */
export function parsePriorResult(content) {
  let prior;
  try { prior = JSON.parse(content); } catch (err) {
    return { ok: false, error: `--prior is not valid JSON: ${err.message}` };
  }
  if (!prior || typeof prior !== 'object' || !Array.isArray(prior.new_findings)) {
    return { ok: false, error: '--prior has no new_findings array — pass the previous round\'s gemini-review --out result JSON' };
  }
  return { ok: true, prior };
}

/**
 * Validate `--round` / `--prior`. Pure: the caller reads the prior file.
 * Round absent ⇒ legacy single-shot behaviour (no cap is claimable without a
 * round number, so none is claimed). Round 2 REQUIRES `--prior`: structured
 * memory of what round 1 raised is the whole point of a second round.
 * @param {{round: string|null, priorPath: string|null}} args
 * @returns {{ok: true, round: number|null} | {ok: false, error: string}}
 */
export function validateRoundArgs({ round, priorPath }) {
  if (round === null || round === undefined) {
    if (priorPath) return { ok: false, error: '--prior requires --round 2' };
    return { ok: true, round: null };
  }
  const n = Number(round);
  if (!Number.isInteger(n) || n < 1) return { ok: false, error: `--round must be a positive integer, got "${round}"` };
  if (n > FINAL_REVIEW_MAX_ROUNDS) {
    return {
      ok: false,
      error: `--round ${n} refused: the final review is capped at ${FINAL_REVIEW_MAX_ROUNDS} rounds (hard limit). `
        + 'Close the gate from the round-2 result: gateDisposition approve_with_debt → capture the debt '
        + '(debt-auto-capture.mjs --final-review <result.json>); blocked → escalate the named blocking items to the user.',
    };
  }
  if (n === 1 && priorPath) return { ok: false, error: '--prior is only meaningful with --round 2' };
  if (n >= 2 && !priorPath) return { ok: false, error: `--round ${n} requires --prior <round-${n - 1} result.json>` };
  return { ok: true, round: n };
}

/**
 * The prior round's findings, read defensively from its result JSON.
 * @param {object} prior - parsed previous `--out` result
 * @returns {object[]}
 */
export function priorFindingsOf(prior) {
  return Array.isArray(prior?.new_findings) ? prior.new_findings : [];
}

const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * System-prompt addendum for round >= 2: the previous round's findings as
 * SETTLED items, and the narrowed scope of this round. Secret-redacted — the
 * text is model-authored prose about the reviewed code and rides the system
 * prompt, which the envelope-level redactor never sees.
 * @param {object} prior - parsed previous result
 * @param {number} round
 * @returns {string}
 */
export function buildPriorRoundBlock(prior, round) {
  const findings = priorFindingsOf(prior);
  const lines = findings.map((f) => {
    const blocking = f.release_blocking === true ? `BLOCKING(${f.blocking_basis})` : 'non-blocking';
    return `- [${f.id ?? '?'}] ${f.severity ?? '?'} ${blocking} — ${clip(f.category, 80)} — ${clip(f.section, 120)} — ${clip(f.detail, 240)}`;
  });
  const block = [
    '',
    `## ROUND ${round} OF ${FINAL_REVIEW_MAX_ROUNDS} — FINAL (hard cap; there is no further round)`,
    `The findings below were already raised in round ${round - 1}. Each has since been either fixed or accepted as`,
    'tracked debt. They are SETTLED: do NOT re-raise any of them, even reworded, unless a line changed since',
    `round ${round - 1} reopens it — then set is_reopened: true and cite that changed line (file:line) in detail.`,
    'This round reviews ONLY: (1) regressions introduced by the fixes made after the previous round, and',
    '(2) previous-round items marked BLOCKING that remain unresolved. Do not start a fresh full review of the',
    'whole change; a new finding outside those two categories must be non-blocking unless it names a',
    'blocking_basis in code the fixes touched.',
    '',
    `Settled round-${round - 1} findings (${findings.length}):`,
    ...(lines.length > 0 ? lines : ['- (none)']),
    '',
  ].join('\n');
  return redactSecretsWithCount(block).text;
}

/**
 * The debt candidates in a final-review result: every non-refuted,
 * non-release-blocking new_finding. Fail-closed by construction — a finding
 * with an invalid pair is blocking (isReleaseBlocking) and therefore never
 * silently becomes debt.
 * @param {object} result
 * @returns {object[]}
 */
function finalReviewDebtCandidates(result) {
  const findings = Array.isArray(result?.new_findings) ? result.new_findings : [];
  return findings.filter((f) => !isRefuted(f) && !isReleaseBlocking(f));
}

/**
 * Project a final-review result's debt candidates onto the adjudication-ledger
 * ENTRY shape `debt-auto-capture.mjs` already consumes (`ruling: 'defer'`), so
 * final-review debt flows through the one existing capture path — same
 * `buildDebtEntry`, same `persistDebtEntries`, same durable-write seam — rather
 * than a second writer. `topicId` is the finding's `_hash` (stamped by
 * `addSemanticIds` on every gemini-review result); a candidate without one
 * cannot be keyed and is returned in `skipped`, never invented.
 *
 * @param {object} result - a gemini-review `--out` result JSON
 * @returns {{entries: object[], skipped: Array<{id: string, reason: string}>, blocked: string[]}}
 */
export function finalReviewToLedgerEntries(result) {
  const round = result?.finalReviewRound ?? null;
  const findings = Array.isArray(result?.new_findings) ? result.new_findings : [];
  const blocked = findings.filter((f) => !isRefuted(f) && isReleaseBlocking(f)).map((f) => f.id ?? '?');
  const entries = [];
  const skipped = [];
  for (const f of finalReviewDebtCandidates(result)) {
    if (typeof f._hash !== 'string' || f._hash.length === 0) {
      skipped.push({ id: f.id ?? '?', reason: 'no _hash — not a gemini-review --out result (semantic id never stamped)' });
      continue;
    }
    const files = Array.isArray(f.affectedFiles) && f.affectedFiles.length > 0
      ? f.affectedFiles : (f._primaryFile ? [f._primaryFile] : []);
    entries.push({
      topicId: f._hash,
      semanticHash: f._hash,
      ruling: 'defer',
      severity: f.severity,
      category: f.category,
      section: f.section,
      detailSnapshot: f.detail ?? '',
      affectedFiles: files,
      affectedPrinciples: f.principle ? [f.principle] : [],
      pass: 'final-review',
      classification: f.classification ?? null,
      rulingRationale: `Final review${round ? ` round ${round}` : ''} finding ${f.id ?? '?'} classified `
        + 'release_blocking=false (blocking_basis=none): no violated acceptance criterion, changed-code regression, '
        + `security, data-loss or runtime-failure ground, so it is tracked debt, not a ship blocker. Risk: ${clip(f.risk, 400)}`,
    });
  }
  return { entries, skipped, blocked };
}

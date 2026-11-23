/**
 * @fileoverview Pilot 1's novelty AUDIT (amendment 2, epoch `seeded-bench-v2`; docs/experiments/seeded-bench/amendment-2-novelty-audit.md).
 *
 * The pre-registered matcher calibration gate (plan §1.4) came back INCONCLUSIVE: the base rate of `same` pairs is ~7%, so its
 * prevalence sample held 8 judge-positive pairs and could not bound precision. The amendment replaces "certify the judge before
 * the pilot" with "bound the judge's one dangerous error on the real pilot findings":
 *
 *   - a finding is HIDDEN from the human only when BOTH judges call it `same` as some prior ledger entry (a failed, unparseable
 *     or disagreeing judge sends it to the human);
 *   - the human sees every other finding, with its closest ledger entries, and decides novelty itself (`KNOWN` = restates one);
 *   - a seeded, finding-level probability sample of the HIDDEN findings is shown to the human too, blind; each one the human does
 *     not call `KNOWN` is a false suppression.
 *   - the audit PASSES iff the one-sided Clopper-Pearson upper bound of false suppressions / audited is <= the amendment's
 *     `upperBoundMax`; a failed audit invalidates the instrument and falls back to labelling ALL hidden findings (`--audit all`).
 *
 * Pure: no IO except `readAmendment`.
 *
 * Domain: audit-orchestration.
 *
 * @module scripts/lib/audit/pilot-novelty-audit
 */
import fs from 'node:fs';
import { seededShuffle } from './step-back-pilot-freeze.mjs';
import { SEEDED_BENCH_EPOCH } from './meta-pilot-decision.mjs';

/** Both judges present, neither failed, both `same`: the only way a finding is hidden from the human. */
export function isSuppressed(entry) {
  const a = entry?.opus; const b = entry?.pro;
  if (!a || !b || a.notJudged || b.notJudged) return false;
  return a.novel === false && b.novel === false;
}

/** Both judges have produced an entry (judged or failed) for this finding: the novelty step covered it. */
export const isCovered = (entry) => Boolean(entry?.opus && entry?.pro);

/** ln(n choose k) via a stable log-gamma-free sum (n is small: tens to hundreds). */
function logChoose(n, k) { let s = 0; for (let i = 1; i <= k; i++) s += Math.log((n - k + i) / i); return s; }
const binomCdf = (k, n, p) => { let s = 0; for (let i = 0; i <= k; i++) s += Math.exp(logChoose(n, i) + (i ? i * Math.log(p) : 0) + ((n - i) ? (n - i) * Math.log(1 - p) : 0)); return s; };

/**
 * One-sided Clopper-Pearson UPPER bound on a proportion: the p such that P(X <= f | n, p) = 1 - confidence.
 * f = 0 gives 1 - (1 - confidence)^(1/n). Bisection; n = 0 has no bound (1).
 */
export function clopperPearsonUpper(f, n, confidence = 0.95) {
  if (!Number.isInteger(f) || !Number.isInteger(n) || n < 0 || f < 0 || f > n) throw new Error(`clopperPearsonUpper: invalid (f=${f}, n=${n})`);
  if (n === 0 || f === n) return 1;
  const alpha = 1 - confidence;
  let lo = 0; let hi = 1;
  for (let i = 0; i < 80; i++) { const mid = (lo + hi) / 2; if (binomCdf(f, n, mid) > alpha) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}

/** The audit's verdict from counts. `n` audited hidden findings, `f` of them not KNOWN (a false suppression). */
export function auditVerdict({ n, f, upperBoundMax, confidence = 0.95 }) {
  const upperBound = clopperPearsonUpper(f, n, confidence);
  return { n, f, upperBound, upperBoundMax, confidence, pass: n > 0 && upperBound <= upperBoundMax };
}

/** The largest f that still passes for n audited findings (for the amendment text and the worksheet header). */
export function maxFalseSuppressions({ n, upperBoundMax, confidence = 0.95 }) {
  let best = -1; for (let f = 0; f <= n; f++) { if (clopperPearsonUpper(f, n, confidence) <= upperBoundMax) best = f; else break; }
  return best;
}

/** A seeded finding-level probability sample of the hidden findings (all of them under `'all'`). Input order never matters. */
export function pickAuditSample({ suppressedKeys, size, seed }) {
  const sorted = [...suppressedKeys].sort();
  if (size === 'all' || size >= sorted.length) return sorted;
  return seededShuffle(sorted, `${seed}:audit`, (k) => k).slice(0, size).sort();
}

/** Load and validate the signed amendment. Anything missing makes novelty and scoring refuse to run. */
export function readAmendment(file, { readText = (p) => fs.readFileSync(p, 'utf8') } = {}) {
  let a; try { a = JSON.parse(readText(file)); } catch (err) { throw new Error(`amendment ${file} unreadable (${err?.message})`); }
  const bad = [];
  if (a.epoch !== SEEDED_BENCH_EPOCH) bad.push(`epoch is ${a.epoch}, expected ${SEEDED_BENCH_EPOCH}`);
  if (!a.approvedBy || !a.approvedAt) bad.push('approvedBy / approvedAt missing');
  if (a.suppression !== 'both-judges-same') bad.push('suppression must be both-judges-same');
  if (!(Number.isInteger(a.audit?.sample) && a.audit.sample > 0)) bad.push('audit.sample must be a positive integer');
  if (!(a.audit?.upperBoundMax > 0 && a.audit.upperBoundMax < 1)) bad.push('audit.upperBoundMax must be in (0,1)');
  if (!(a.audit?.confidence > 0 && a.audit.confidence < 1)) bad.push('audit.confidence must be in (0,1)');
  if (bad.length) throw new Error(`amendment ${file} is not valid: ${bad.join('; ')}`);
  return a;
}

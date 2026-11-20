/**
 * @fileoverview Small pure guards extracted from scripts/solo-control-audit.mjs
 * (an over-1000-line file that may not grow — scripts/** size ratchet). Each
 * one is a decision that used to live inline in a subcommand where nothing
 * could test it; the subcommand now calls it.
 *
 * @module scripts/lib/solo-control/run-guards
 */
import crypto from 'node:crypto';
import { resolveAndAuthorize } from './policy.mjs';
import { resumeArmFile } from './completion.mjs';

/** Authorize EVERY model a commit's diff will be sent to (apparatus: the 5-pass
 * GPT and the gate). Throws on the first refusal. Both the fresh and the
 * --gate-only path use it, so a saved diff can never reach a gate the policy
 * never cleared for that repo. */
export function authorizeAll(models, repoIdentity, policy) {
  for (const model of models) resolveAndAuthorize({ model, repoIdentity, policy });
}

/** `cmdRun`'s output object on resume: the prior file minus the findings of the
 * commits about to be RE-RUN (a budget-exceeded / drift commit keeps partial
 * findings yet is not covered, so re-running it would append them twice). */
export function resumedOut(prior, { force, fresh, rerunShas, patch }) {
  if (!prior || force) return fresh;
  return { ...resumeArmFile(prior, { force, rerun: rerunShas, fresh }), ...patch };
}

/** Content fingerprint of a blind-sheet row — blind ids renumber on re-merge. */
export const rowFingerprint = (r) => crypto.createHash('sha256')
  .update([r.commit, r.severity, r.category, r.file, r.detail].map((x) => String(x ?? '')).join('\u0000')).digest('hex');

/** judge-gpt resume: a prior grade is only valid for the sheet CONTENT it was
 * made for. Rows are `{blindId, commit, severity, category, file, detail, ...grade}`.
 * @returns {{grades: Map<string, object>, discarded: number}} */
export function seedResumedGrades(priorRows, currentRows) {
  const current = new Map(currentRows.map((r) => [r.blindId, rowFingerprint(r)]));
  const grades = new Map();
  let discarded = 0;
  for (const p of priorRows) {
    if (!p.label) continue;
    if (current.get(p.blindId) !== rowFingerprint(p)) { discarded++; continue; }
    grades.set(p.blindId, { blind_id: p.blindId, label: p.label, proof: p.proof, cluster: p.cluster, matches: p.matches, pattern: p.pattern });
  }
  return { grades, discarded };
}

/** Judge batches are independent LLM calls, so a tag like `c1` recurs across
 * batches for unrelated defects; scoring keys clusters by arm+commit+tag. */
export const qualifyBatchCluster = (g, shortSha, batchIndex) => ({ ...g, cluster: g.cluster ? `${shortSha}:b${batchIndex}:${g.cluster}` : '' });

/** Label coverage: an INVALID label is not a label. */
export const labelCoverage = ({ dataRows, unlabeled, invalid }) => (dataRows > 0 ? (dataRows - unlabeled - invalid) / dataRows : 0);
export const decisionStatusFor = ({ coverage, invalid, highNeedingProof }) => (coverage >= 0.9 && invalid === 0 && highNeedingProof.length === 0 ? 'final' : 'directional-only');

/** merge: split commits into covered / apparatus-gap. With the allow flag the
 * caller must score ONLY `covered` (a gap commit would read "solo won"). */
export function splitApparatusGaps(commits, viewACommits, localACommits) {
  const gaps = commits.filter((c) => !viewACommits.has(c) && !localACommits.has(c));
  const gapSet = new Set(gaps);
  return { gaps, covered: commits.filter((c) => !gapSet.has(c)) };
}

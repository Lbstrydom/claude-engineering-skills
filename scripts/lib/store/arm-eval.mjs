/**
 * @fileoverview Store layer for the unified arm-evaluation framework.
 *
 * Plan: docs/plans/arm-eval-framework.md (Cluster A, Phase 3 / §10.1). Persists
 * the session → run → output → judgment/crosscheck lifecycle + the blinded human
 * ranking, and reads the leaderboard + per-session data the decision module
 * folds. Graceful no-op when cloud is off (mirrors store/model-ab.mjs).
 *
 * jsonb-safe writes (AGENTS.md seam): jsonb columns (`resolved_model`, `scores`,
 * `findings`, `evidence_refs`, `ranked_labels`) are passed RAW — the db/query
 * write builders auto-JSON-serialize a plain array/object bound to a jsonb
 * column; a `pgArray()` opt-out is only for genuine Postgres array columns (none
 * here).
 *
 * @module scripts/lib/store/arm-eval
 */

import { one, many, insertReturning } from '../db/query.mjs';
import { isCloudEnabled } from './repo.mjs';

const SAFE_IDENT = /^[a-z_][a-z0-9_]*$/i;

async function relExists(table, col) {
  if (!SAFE_IDENT.test(table) || (col != null && !SAFE_IDENT.test(col))) {
    throw new Error(`relExists: unsafe identifier ${JSON.stringify(col ? `${table}.${col}` : table)}`);
  }
  try { await many(`SELECT ${col ? `"${col}"` : '1'} FROM "${table}" LIMIT 0`); return true; }
  catch (err) { if (err && (err.code === '42703' || err.code === '42P01')) return false; return false; }
}

const REQUIRED = Object.freeze([
  ['arm_eval_sessions', 'session_id'], ['arm_eval_sessions', 'task_id'], ['arm_eval_sessions', 'repo_id'],
  ['arm_eval_runs', 'session_id'], ['arm_eval_runs', 'resolved_model'],
  ['arm_eval_outputs', 'producer_conformant'],
  ['arm_eval_judgments', 'scores'], ['arm_eval_judgments', 'judge_pass'],
  ['arm_eval_human_rankings', 'ranked_labels'],
  ['arm_eval_crosschecks', 'check_name'],
  ['audit_runs', 'arm_eval_run_id'],
  ['arm_eval_leaderboard', null],
]);

/** @returns {Promise<{ready:boolean, cloud:boolean, missing:string[]}>} */
export async function armEvalSchemaReady() {
  if (!await isCloudEnabled()) return { ready: false, cloud: false, missing: [] };
  const missing = [];
  for (const [t, c] of REQUIRED) if (!await relExists(t, c)) missing.push(c ? `${t}.${c}` : t);
  return { ready: missing.length === 0, cloud: true, missing };
}

// ── Writers (graceful no-op when cloud off) ──────────────────────────────────

export async function recordSession({ sessionId, repoId = null, experimentType, taskId, phase = null, configVersion = null, rubricVersion = null, seed = null }) {
  if (!sessionId || !experimentType || !taskId) throw new Error('recordSession: sessionId + experimentType + taskId required');
  if (!await isCloudEnabled()) return { cloud: false };
  try {
    await insertReturning('arm_eval_sessions', {
      session_id: sessionId, repo_id: repoId, experiment_type: experimentType, task_id: taskId,
      phase, config_version: configVersion, rubric_version: rubricVersion, seed,
    }, { returning: ['session_id'] });
    return { cloud: true, ok: true };
  } catch (err) { process.stderr.write(`  [arm-eval] recordSession failed: ${err.message}\n`); return { cloud: true, ok: false }; }
}

export async function recordRun({ runId, sessionId, arm, resolvedModel = null, contextPackHash = null, budgetLeaseId = null }) {
  if (!runId || !sessionId || !arm) throw new Error('recordRun: runId + sessionId + arm required');
  if (!await isCloudEnabled()) return { cloud: false };
  try {
    await insertReturning('arm_eval_runs', {
      run_id: runId, session_id: sessionId, arm, resolved_model: resolvedModel, // jsonb raw
      context_pack_hash: contextPackHash, budget_lease_id: budgetLeaseId,
    }, { returning: ['run_id'] });
    return { cloud: true, ok: true };
  } catch (err) { process.stderr.write(`  [arm-eval] recordRun failed: ${err.message}\n`); return { cloud: true, ok: false }; }
}

export async function recordOutput({ runId, outputHash, outputRef = null, producerConformant = true, normalized = false }) {
  if (!runId || !outputHash) throw new Error('recordOutput: runId + outputHash required');
  if (!await isCloudEnabled()) return { cloud: false };
  try {
    await insertReturning('arm_eval_outputs', {
      run_id: runId, output_hash: outputHash, output_ref: outputRef,
      producer_conformant: producerConformant, normalized,
    }, { returning: ['run_id'] });
    return { cloud: true, ok: true };
  } catch (err) { process.stderr.write(`  [arm-eval] recordOutput failed: ${err.message}\n`); return { cloud: true, ok: false }; }
}

export async function recordJudgment({ runId, outputHash, judgePass, presentationOrder = null, rubricVersion = null, scores }) {
  if (!runId || !outputHash || !judgePass || !scores) throw new Error('recordJudgment: runId + outputHash + judgePass + scores required');
  if (!await isCloudEnabled()) return { cloud: false };
  try {
    await insertReturning('arm_eval_judgments', {
      run_id: runId, output_hash: outputHash, judge_pass: judgePass,
      presentation_order: presentationOrder, rubric_version: rubricVersion, scores, // jsonb raw
    }, { returning: ['id'] });
    return { cloud: true, ok: true };
  } catch (err) { process.stderr.write(`  [arm-eval] recordJudgment failed: ${err.message}\n`); return { cloud: true, ok: false }; }
}

export async function recordCrossCheck({ runId, checkName, checkVersion = null, status, score = null, findings = null, evidenceRefs = null, failureReason = null }) {
  if (!runId || !checkName || !status) throw new Error('recordCrossCheck: runId + checkName + status required');
  if (!await isCloudEnabled()) return { cloud: false };
  try {
    await insertReturning('arm_eval_crosschecks', {
      run_id: runId, check_name: checkName, check_version: checkVersion, status,
      score, findings, evidence_refs: evidenceRefs, failure_reason: failureReason, // jsonb raw where applicable
    }, { returning: ['id'] });
    return { cloud: true, ok: true };
  } catch (err) { process.stderr.write(`  [arm-eval] recordCrossCheck failed: ${err.message}\n`); return { cloud: true, ok: false }; }
}

export async function recordHumanRanking({ sessionId, rankedLabels, reviewer = null }) {
  if (!sessionId || !Array.isArray(rankedLabels) || rankedLabels.length < 2) throw new Error('recordHumanRanking: sessionId + rankedLabels[≥2] required');
  if (!await isCloudEnabled()) return { cloud: false };
  try {
    await insertReturning('arm_eval_human_rankings', {
      session_id: sessionId, ranked_labels: rankedLabels, reviewer, // jsonb raw
    }, { returning: ['id'] });
    return { cloud: true, ok: true };
  } catch (err) { process.stderr.write(`  [arm-eval] recordHumanRanking failed: ${err.message}\n`); return { cloud: true, ok: false }; }
}

// ── Readers ──────────────────────────────────────────────────────────────────

/** Per (experiment × arm × phase) leaderboard aggregate rows, REPO-SCOPED by
 * default (audit R1/R2 9f4a31bc): a caller MUST pass either `repoId` (scoped) or
 * `allRepos:true` (explicit cross-repo opt-in) — omitting both throws, so a
 * cross-repo aggregation is never an accidental default footgun. */
export async function getArmEvalLeaderboard({ experimentType = null, repoId = null, allRepos = false } = {}) {
  if (!repoId && !allRepos) {
    throw new Error('getArmEvalLeaderboard: pass repoId (scoped) or allRepos:true (explicit cross-repo) — cross-repo is never the default');
  }
  if (!await isCloudEnabled()) return { cloud: false, rows: [] };
  try {
    const where = [];
    const params = [];
    if (repoId) { params.push(repoId); where.push(`repo_id = $${params.length}`); }
    if (experimentType) { params.push(experimentType); where.push(`experiment_type = $${params.length}`); }
    const sql = `SELECT * FROM arm_eval_leaderboard${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY experiment_type, arm`;
    const rows = await many(sql, params);
    return { cloud: true, rows };
  } catch (err) { process.stderr.write(`  [arm-eval] getArmEvalLeaderboard failed: ${err.message}\n`); return { cloud: true, rows: [] }; }
}

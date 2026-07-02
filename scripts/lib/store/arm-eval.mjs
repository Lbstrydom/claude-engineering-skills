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

/**
 * Reconstruct the in-memory SESSION objects the decision module consumes, from
 * the persisted arm_eval_* rows. Repo-scoped (or explicit allRepos). Returns
 * `{ cloud, sessions:[{ taskId, judge:{conformant,labelToArm,dims,passes}, conformance,
 * humanRanking }] }`. The label→arm map is rebuilt from each judgment's
 * presentation_order (`output-N`) + its run's arm; human rankings are unblinded
 * the same way (ranked_labels → arms).
 */
export async function getSessionsForDecision({ experimentType, repoId = null, allRepos = false, phase = 'prospective' } = {}) {
  if (!experimentType) throw new Error('getSessionsForDecision: experimentType required');
  if (!repoId && !allRepos) throw new Error('getSessionsForDecision: pass repoId or allRepos:true (never accidental cross-repo)');
  if (!await isCloudEnabled()) return { cloud: false, sessions: [] };
  try {
    const params = [experimentType];
    let where = 'experiment_type = $1';
    if (phase) { params.push(phase); where += ` AND phase = $${params.length}`; }
    if (repoId) { params.push(repoId); where += ` AND repo_id = $${params.length}`; }
    const sessions = await many(`SELECT session_id, task_id FROM arm_eval_sessions WHERE ${where}`, params);
    const out = [];
    for (const s of sessions) {
      const runs = await many('SELECT r.run_id, r.arm, o.producer_conformant FROM arm_eval_runs r LEFT JOIN arm_eval_outputs o ON o.run_id = r.run_id WHERE r.session_id = $1', [s.session_id]);
      const runArm = Object.fromEntries(runs.map((r) => [r.run_id, r.arm]));
      const conformance = {}; for (const r of runs) conformance[r.arm] = r.producer_conformant !== false;
      const judg = await many('SELECT run_id, judge_pass, presentation_order, scores FROM arm_eval_judgments WHERE run_id = ANY($1::uuid[])', [runs.map((r) => r.run_id)]);
      const labelToArm = {}; const passesMap = {};
      for (const j of judg) {
        const label = `output-${j.presentation_order}`;
        labelToArm[label] = runArm[j.run_id];
        (passesMap[j.judge_pass] ||= {})[label] = typeof j.scores === 'string' ? JSON.parse(j.scores) : j.scores;
      }
      const passes = Object.keys(passesMap).sort().map((k) => passesMap[k]);
      const dims = passes.length ? Object.keys(Object.values(passes[0])[0] || {}) : [];
      const hr = await many('SELECT ranked_labels FROM arm_eval_human_rankings WHERE session_id = $1 ORDER BY created_at DESC LIMIT 1', [s.session_id]);
      let humanRanking = null;
      if (hr[0]) {
        const labels = typeof hr[0].ranked_labels === 'string' ? JSON.parse(hr[0].ranked_labels) : hr[0].ranked_labels;
        humanRanking = (labels || []).map((l) => labelToArm[l]).filter(Boolean);
        if (humanRanking.length < 2) humanRanking = null;
      }
      out.push({ taskId: s.task_id, judge: { conformant: passes.length >= 2, labelToArm, dims, passes }, conformance, humanRanking });
    }
    return { cloud: true, sessions: out };
  } catch (err) { process.stderr.write(`  [arm-eval] getSessionsForDecision failed: ${err.message}\n`); return { cloud: true, sessions: [] }; }
}

/**
 * BLINDED outputs for a session for human spot-check — opaque labels (`output-N`,
 * from the judge presentation order) + the output TEXT, with the ARM HIDDEN. The
 * reviewer ranks the labels; the label→arm map is never returned here (unblinded
 * post-hoc from the seed in the decision path).
 */
export async function getBlindedSessionOutputs(sessionId) {
  if (!sessionId) throw new Error('getBlindedSessionOutputs: sessionId required');
  if (!await isCloudEnabled()) return { cloud: false, outputs: [] };
  try {
    // Presentation order lives on the judgments (assigned at judge time); join to
    // the output text. DISTINCT so the two passes don't duplicate a label.
    const rows = await many(
      `SELECT DISTINCT j.presentation_order, o.output_ref
         FROM arm_eval_judgments j
         JOIN arm_eval_runs r ON r.run_id = j.run_id
         JOIN arm_eval_outputs o ON o.run_id = r.run_id AND o.output_hash = j.output_hash
        WHERE r.session_id = $1
        ORDER BY j.presentation_order`,
      [sessionId],
    );
    // arm deliberately NOT selected — the queue is BLINDED.
    return { cloud: true, outputs: rows.map((r) => ({ label: `output-${r.presentation_order}`, text: r.output_ref })) };
  } catch (err) { process.stderr.write(`  [arm-eval] getBlindedSessionOutputs failed: ${err.message}\n`); return { cloud: true, outputs: [] }; }
}

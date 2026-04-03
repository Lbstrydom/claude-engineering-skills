/**
 * @fileoverview Cloud learning store — Supabase-backed persistence for audit outcomes,
 * pass effectiveness, false positive patterns, prompt variants, and bandit state.
 * Falls back to local-only mode if SUPABASE_AUDIT_URL is not set.
 * @module scripts/learning-store
 */

import 'dotenv/config';

let _supabase = null;
let _userId = null;

/**
 * Initialize the cloud learning store.
 * @returns {Promise<boolean>} true if cloud mode active, false if local-only
 */
export async function initLearningStore() {
  if (!process.env.SUPABASE_AUDIT_URL || !process.env.SUPABASE_AUDIT_ANON_KEY) {
    process.stderr.write('  [learning] Cloud store not configured — using local mode\n');
    return false;
  }

  try {
    const { createClient } = await import('@supabase/supabase-js');
    _supabase = createClient(
      process.env.SUPABASE_AUDIT_URL,
      process.env.SUPABASE_AUDIT_ANON_KEY
    );

    // Check connection
    const { error } = await _supabase.from('audit_repos').select('id').limit(1);
    if (error) {
      process.stderr.write(`  [learning] Supabase connection failed: ${error.message}\n`);
      _supabase = null;
      return false;
    }

    process.stderr.write('  [learning] Cloud store connected\n');
    return true;
  } catch (err) {
    process.stderr.write(`  [learning] Failed to init: ${err.message}\n`);
    _supabase = null;
    return false;
  }
}

/** Check if cloud store is available. */
export function isCloudEnabled() {
  return _supabase !== null;
}

// ── Repo Management ─────────────────────────────────────────────────────────

/**
 * Upsert a repo profile to the cloud store.
 * @param {object} profile - From generateRepoProfile()
 * @param {string} repoName - Human-readable repo name
 */
export async function upsertRepo(profile, repoName) {
  if (!_supabase) return null;

  const { data, error } = await _supabase
    .from('audit_repos')
    .upsert({
      fingerprint: profile.repoFingerprint,
      name: repoName,
      stack: profile.stack,
      file_breakdown: profile.fileBreakdown,
      focus_areas: profile.focusAreas,
      last_audited_at: new Date().toISOString()
    }, { onConflict: 'fingerprint' })
    .select('id')
    .single();

  if (error) {
    process.stderr.write(`  [learning] upsertRepo failed: ${error.message}\n`);
    return null;
  }
  return data?.id;
}

// ── Audit Run Recording ─────────────────────────────────────────────────────

/**
 * Record the start of an audit run.
 * @returns {string|null} run ID
 */
export async function recordRunStart(repoId, planFile, mode) {
  if (!_supabase) return null;

  const { data, error } = await _supabase
    .from('audit_runs')
    .insert({
      repo_id: repoId,
      plan_file: planFile,
      mode,
      rounds: 0,
      total_findings: 0,
      accepted_count: 0,
      dismissed_count: 0,
      fixed_count: 0
    })
    .select('id')
    .single();

  if (error) {
    process.stderr.write(`  [learning] recordRunStart failed: ${error.message}\n`);
    return null;
  }
  return data?.id;
}

/**
 * Update a completed audit run with final stats.
 */
export async function recordRunComplete(runId, stats) {
  if (!_supabase || !runId) return;

  const { error } = await _supabase
    .from('audit_runs')
    .update({
      rounds: stats.rounds,
      total_findings: stats.totalFindings,
      accepted_count: stats.accepted,
      dismissed_count: stats.dismissed,
      fixed_count: stats.fixed,
      gemini_verdict: stats.geminiVerdict,
      total_cost_estimate: stats.costEstimate,
      total_duration_ms: stats.durationMs
    })
    .eq('id', runId);

  if (error) process.stderr.write(`  [learning] recordRunComplete failed: ${error.message}\n`);
}

// ── Finding & Adjudication Recording ────────────────────────────────────────

/**
 * Record a batch of findings from an audit pass.
 */
export async function recordFindings(runId, findings, passName, round) {
  if (!_supabase || !runId) return;

  const rows = findings.map(f => ({
    run_id: runId,
    finding_fingerprint: f._hash || 'unknown',
    pass_name: passName,
    severity: f.severity,
    category: f.category,
    primary_file: f._primaryFile || f.section,
    detail_snapshot: f.detail?.slice(0, 600),
    round_raised: round
  }));

  const { error } = await _supabase.from('audit_findings').insert(rows);
  if (error) process.stderr.write(`  [learning] recordFindings failed: ${error.message}\n`);
}

/**
 * Record pass-level stats.
 */
export async function recordPassStats(runId, passName, stats) {
  if (!_supabase || !runId) return;

  const { error } = await _supabase
    .from('audit_pass_stats')
    .insert({
      run_id: runId,
      pass_name: passName,
      findings_raised: stats.raised || 0,
      findings_accepted: stats.accepted || 0,
      findings_dismissed: stats.dismissed || 0,
      findings_compromised: stats.compromised || 0,
      input_tokens: stats.inputTokens,
      output_tokens: stats.outputTokens,
      latency_ms: stats.latencyMs,
      reasoning_effort: stats.reasoning,
      prompt_variant_id: stats.promptVariantId
    });

  if (error) process.stderr.write(`  [learning] recordPassStats failed: ${error.message}\n`);
}

/**
 * Record suppression events from R2+ post-processing.
 */
export async function recordSuppressionEvents(runId, suppressionResult) {
  if (!_supabase || !runId) return;

  const rows = [
    ...suppressionResult.suppressed.map(s => ({
      run_id: runId,
      finding_fingerprint: s.finding?._hash || 'unknown',
      matched_topic_id: s.matchedTopic,
      match_score: s.matchScore,
      action: 'suppressed',
      reason: s.reason
    })),
    ...suppressionResult.reopened.map(f => ({
      run_id: runId,
      finding_fingerprint: f._hash || 'unknown',
      matched_topic_id: f._matchedTopic,
      match_score: f._matchScore,
      action: 'reopened',
      reason: 'Scope changed'
    }))
  ];

  if (rows.length === 0) return;
  const { error } = await _supabase.from('suppression_events').insert(rows);
  if (error) process.stderr.write(`  [learning] recordSuppressionEvents failed: ${error.message}\n`);
}

// ── Adjudication Events ────────────────────────────────────────────────────

/**
 * Record adjudication events for findings after deliberation.
 * @param {string} findingId - The audit_findings row ID (or fingerprint for lookup)
 * @param {object} event - { adjudicationOutcome, remediationState, ruling, rulingRationale, round }
 */
export async function recordAdjudicationEvent(runId, findingFingerprint, event) {
  if (!_supabase || !runId) return;

  // Look up the finding ID using run_id + fingerprint + pass_name for unique resolution
  let query = _supabase
    .from('audit_findings')
    .select('id')
    .eq('run_id', runId)
    .eq('finding_fingerprint', findingFingerprint);

  // Include pass_name and round for unique identity when available
  if (event.passName) query = query.eq('pass_name', event.passName);
  if (event.round) query = query.eq('round_raised', event.round);

  const { data: finding } = await query.limit(1).single();

  if (!finding?.id) return;

  const { error } = await _supabase
    .from('finding_adjudication_events')
    .insert({
      finding_id: finding.id,
      adjudication_outcome: event.adjudicationOutcome,
      remediation_state: event.remediationState,
      ruling: event.ruling,
      ruling_rationale: event.rulingRationale,
      round: event.round
    });

  if (error) process.stderr.write(`  [learning] recordAdjudicationEvent failed: ${error.message}\n`);
}

// ── Bandit Arms Sync ───────────────────────────────────────────────────────

/**
 * Sync local bandit arm state to Supabase.
 * @param {object} arms - The bandit arms map from PromptBandit
 */
export async function syncBanditArms(arms) {
  if (!_supabase) return;

  const rows = Object.values(arms).map(arm => ({
    pass_name: arm.passName,
    variant_id: arm.variantId,
    alpha: arm.alpha,
    beta: arm.beta,
    pulls: arm.pulls,
    context_bucket: arm.contextBucket || null,
    updated_at: new Date().toISOString()
  }));

  if (rows.length === 0) return;

  const { error } = await _supabase
    .from('bandit_arms')
    .upsert(rows, { onConflict: 'pass_name,variant_id,context_bucket' });

  if (error) process.stderr.write(`  [learning] syncBanditArms failed: ${error.message}\n`);
  else process.stderr.write(`  [learning] Synced ${rows.length} bandit arms to cloud\n`);
}

/**
 * Load bandit arm state from Supabase (for seeding local state).
 * @returns {object|null} arms map keyed by passName:variantId
 */
export async function loadBanditArms() {
  if (!_supabase) return null;

  const { data, error } = await _supabase
    .from('bandit_arms')
    .select('*');

  if (error) {
    process.stderr.write(`  [learning] loadBanditArms failed: ${error.message}\n`);
    return null;
  }

  if (!data?.length) return null;

  const arms = {};
  for (const row of data) {
    const bucket = row.context_bucket || 'global';
    const key = `${row.pass_name}:${row.variant_id}:${bucket}`;
    arms[key] = {
      passName: row.pass_name,
      variantId: row.variant_id,
      alpha: Number(row.alpha),
      beta: Number(row.beta),
      pulls: row.pulls,
      contextBucket: bucket
    };
  }
  return arms;
}

// ── Prompt Variants ────────────────────────────────────────────────────────

/**
 * Upsert a prompt variant record with updated effectiveness stats.
 */
export async function upsertPromptVariant(repoId, passName, variantName, promptHash, stats) {
  if (!_supabase) return;

  const { error } = await _supabase
    .from('prompt_variants')
    .upsert({
      repo_id: repoId || null,
      pass_name: passName,
      variant_name: variantName,
      prompt_hash: promptHash,
      total_uses: stats.totalUses || 1,
      avg_acceptance_rate: stats.avgAcceptanceRate,
      avg_findings_per_use: stats.avgFindingsPerUse,
      is_active: true
    }, { onConflict: 'pass_name,variant_name' });

  if (error) process.stderr.write(`  [learning] upsertPromptVariant failed: ${error.message}\n`);
}

// ── False Positive Pattern Sync ────────────────────────────────────────────

/**
 * Sync local FP tracker patterns to Supabase.
 * @param {string|null} repoId - The repo UUID
 * @param {object} patterns - The local FP tracker patterns map
 */
export async function syncFalsePositivePatterns(repoId, patterns) {
  if (!_supabase) return;

  const rows = Object.entries(patterns).map(([key, p]) => {
    return {
      repo_id: repoId || null,
      pattern_type: 'category',
      pattern_value: key,
      dismissal_count: p.dismissed,
      last_dismissed_at: new Date().toISOString(),
      auto_suppress: (p.accepted + p.dismissed) >= 5 && p.ema < 0.15,
      suppress_threshold: 5
    };
  });

  if (rows.length === 0) return;

  const { error } = await _supabase
    .from('false_positive_patterns')
    .upsert(rows, { onConflict: 'repo_id,pattern_type,pattern_value' });

  if (error) process.stderr.write(`  [learning] syncFalsePositivePatterns failed: ${error.message}\n`);
  else process.stderr.write(`  [learning] Synced ${rows.length} FP patterns to cloud\n`);
}

// ── Experiment Sync ──────────────────────────────────────────────────────────

/**
 * Sync experiment records using deterministic experimentId as upsert key.
 * @param {object[]} experiments
 */
export async function syncExperiments(experiments) {
  if (!_supabase) return;

  const rows = experiments.map(e => ({
    experiment_id: e.experimentId,
    pass_name: e.pass,
    revision_id: e.revisionId,
    parent_revision_id: e.parentRevisionId,
    parent_ewr: e.parentEWR,
    parent_confidence: e.parentConfidence,
    parent_effective_sample_size: e.parentEffectiveSampleSize,
    rationale: e.rationale,
    status: e.status,
    final_ewr: e.finalEWR || null,
    final_confidence: e.finalConfidence || null,
    total_pulls: e.totalPulls || 0
  }));

  if (rows.length === 0) return;

  const { error } = await _supabase
    .from('prompt_experiments')
    .upsert(rows, { onConflict: 'experiment_id' });

  if (error) process.stderr.write(`  [learning] syncExperiments failed: ${error.message}\n`);
  else process.stderr.write(`  [learning] Synced ${rows.length} experiments to cloud\n`);
}

// ── Prompt Revision Sync ────────────────────────────────────────────────────

/**
 * Sync a promoted prompt revision to cloud.
 * @param {string} passName
 * @param {string} revisionId
 * @param {string} promptText
 */
export async function syncPromptRevision(passName, revisionId, promptText) {
  if (!_supabase) return;

  const { createHash } = await import('node:crypto');
  const checksum = createHash('sha256').update(promptText).digest('hex');

  const { error } = await _supabase
    .from('prompt_revisions')
    .upsert({
      pass_name: passName,
      revision_id: revisionId,
      prompt_text: promptText,
      checksum,
      promoted_at: new Date().toISOString()
    }, { onConflict: 'pass_name,revision_id' });

  if (error) process.stderr.write(`  [learning] syncPromptRevision failed: ${error.message}\n`);
}

// ── Hierarchical FP Pattern Loading ─────────────────────────────────────────

/**
 * Load FP patterns from cloud with structured dimensions.
 * @param {string} repoId
 * @returns {{ repoPatterns: object[], globalPatterns: object[] }}
 */
export async function loadFalsePositivePatterns(repoId) {
  if (!_supabase) return { repoPatterns: [], globalPatterns: [] };

  const GLOBAL_REPO_ID = '00000000-0000-0000-0000-000000000000';
  const columns = 'category, severity, principle, repo_id, file_extension, scope, dismissed, accepted, ema, auto_suppress';

  const { data: repo } = await _supabase
    .from('false_positive_patterns')
    .select(columns)
    .eq('repo_id', repoId).eq('auto_suppress', true);

  const { data: global } = await _supabase
    .from('false_positive_patterns')
    .select(columns)
    .eq('repo_id', GLOBAL_REPO_ID).eq('auto_suppress', true);

  return {
    repoPatterns: repo || [],
    globalPatterns: global || []
  };
}

// ── Querying (for Phase 4-6) ────────────────────────────────────────────────

/**
 * Get pass effectiveness stats for a repo.
 */
export async function getPassEffectiveness(repoId) {
  if (!_supabase) return [];

  // Two-step query: get run IDs for repo, then get pass stats
  const { data: runs, error: runErr } = await _supabase
    .from('audit_runs')
    .select('id')
    .eq('repo_id', repoId);

  if (runErr || !runs?.length) {
    if (runErr) process.stderr.write(`  [learning] getPassEffectiveness runs query failed: ${runErr.message}\n`);
    return [];
  }

  const runIds = runs.map(r => r.id);
  const { data, error } = await _supabase
    .from('audit_pass_stats')
    .select('pass_name, findings_raised, findings_accepted, findings_dismissed')
    .in('run_id', runIds);

  if (error) {
    process.stderr.write(`  [learning] getPassEffectiveness failed: ${error.message}\n`);
    return [];
  }
  return data || [];
}

/**
 * Get false positive patterns for a repo.
 */
export async function getFalsePositivePatterns(repoId) {
  if (!_supabase) return [];

  const { data, error } = await _supabase
    .from('false_positive_patterns')
    .select('*')
    .eq('repo_id', repoId)
    .eq('auto_suppress', true);

  if (error) {
    process.stderr.write(`  [learning] getFalsePositivePatterns failed: ${error.message}\n`);
    return [];
  }
  return data || [];
}

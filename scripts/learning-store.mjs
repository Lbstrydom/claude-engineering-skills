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

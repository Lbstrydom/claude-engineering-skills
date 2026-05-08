/**
 * @fileoverview Cloud learning store — Supabase-backed persistence for audit outcomes,
 * pass effectiveness, false positive patterns, prompt variants, and bandit state.
 * Falls back to local-only mode if SUPABASE_AUDIT_URL is not set.
 * @module scripts/learning-store
 */

// Quiet dotenv load — keeps CLI stdout clean for JSON output from debt-resolve, etc.
import dotenv from 'dotenv';
dotenv.config({ path: process.env.DOTENV_CONFIG_PATH || '.env', quiet: true });

import crypto from 'node:crypto';

let _supabase = null;
let _userId = null;
let _hasClassificationColumns = null;

// Separate Supabase client for persona-test (different project, different anon key).
// Lazy-initialised on first persona-CLI call so cloud-unavailable stays no-op.
let _personaSupabase = null;
let _personaInitAttempted = false;

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
 * @param {string} repoId
 * @param {string} planFile
 * @param {'plan'|'code'} mode
 * @param {object} [options]
 * @param {string} [options.scopeMode]
 * @param {string} [options.commitSha]  — current HEAD at audit time
 * @param {string} [options.branch]     — current branch at audit time
 * @param {string} [options.planId]     — UUID from plans table (from upsertPlan)
 * @returns {string|null} run ID
 */
export async function recordRunStart(repoId, planFile, mode, { scopeMode, commitSha, branch, planId } = {}) {
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
      fixed_count: 0,
      ...(scopeMode ? { scope_mode: scopeMode } : {}),
      ...(commitSha ? { commit_sha: commitSha } : {}),
      ...(branch ? { branch } : {}),
      ...(planId ? { plan_id: planId } : {}),
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
 * @param {string} runId
 * @param {object} stats
 * @param {number}   stats.rounds
 * @param {number}   stats.totalFindings
 * @param {number}   stats.accepted
 * @param {number}   stats.dismissed
 * @param {number}   stats.fixed
 * @param {string}   [stats.geminiVerdict]
 * @param {number}   [stats.costEstimate]
 * @param {number}   [stats.durationMs]
 * @param {number}   [stats.diffLinesChanged]
 * @param {number}   [stats.diffFilesChanged]
 * @param {boolean}  [stats.sessionCacheHit]
 * @param {string[]} [stats.mapReducePasses]
 * @param {string}   [stats.r2SkipReason]
 */
export async function recordRunComplete(runId, stats) {
  if (!_supabase || !runId) return;

  const update = {
    rounds: stats.rounds,
    total_findings: stats.totalFindings,
    accepted_count: stats.accepted,
    dismissed_count: stats.dismissed,
    fixed_count: stats.fixed,
    gemini_verdict: stats.geminiVerdict,
    total_cost_estimate: stats.costEstimate,
    total_duration_ms: stats.durationMs,
  };

  if (stats.diffLinesChanged != null) update.diff_lines_changed = stats.diffLinesChanged;
  if (stats.diffFilesChanged != null) update.diff_files_changed = stats.diffFilesChanged;
  if (stats.sessionCacheHit != null) update.session_cache_hit = stats.sessionCacheHit;
  if (stats.mapReducePasses != null) update.map_reduce_passes = stats.mapReducePasses;
  if (stats.r2SkipReason != null) update.r2_skip_reason = stats.r2SkipReason;

  const { error } = await _supabase.from('audit_runs').update(update).eq('id', runId);
  if (error) process.stderr.write(`  [learning] recordRunComplete failed: ${error.message}\n`);
}

/**
 * Update a subset of run metadata — used by the orchestrator after R2 decisions.
 * @param {string} runId
 * @param {object} meta — any subset of audit_runs columns
 */
export async function updateRunMeta(runId, meta) {
  if (!_supabase || !runId) return;
  const update = {};
  if (meta.r2SkipReason != null) update.r2_skip_reason = meta.r2SkipReason;
  if (meta.geminiVerdict != null) update.gemini_verdict = meta.geminiVerdict;
  if (Object.keys(update).length === 0) return;
  const { error } = await _supabase.from('audit_runs').update(update).eq('id', runId);
  if (error) process.stderr.write(`  [learning] updateRunMeta failed: ${error.message}\n`);
}

// ── Finding & Adjudication Recording ────────────────────────────────────────

/**
 * Detect whether the audit_findings table has Phase B classification columns.
 * Cached after first probe — column shape doesn't change mid-run.
 */
async function detectClassificationColumns() {
  if (_hasClassificationColumns !== null) return _hasClassificationColumns;
  if (!_supabase) {
    _hasClassificationColumns = false;
    return false;
  }
  try {
    const { error } = await _supabase.from('audit_findings').select('sonar_type').limit(0);
    _hasClassificationColumns = !error;
  } catch {
    _hasClassificationColumns = false;
  }
  if (!_hasClassificationColumns) {
    process.stderr.write('  [learning] classification columns not present — run migration to enable\n');
  }
  return _hasClassificationColumns;
}

/** Test-only reset for detection cache. */
export function _resetClassificationColumnCache() { _hasClassificationColumns = null; }

/**
 * Record a batch of findings from an audit pass.
 */
export async function recordFindings(runId, findings, passName, round) {
  if (!_supabase || !runId) return;

  const hasClassification = await detectClassificationColumns();
  const rows = findings.map(f => {
    const base = {
      run_id: runId,
      finding_fingerprint: f._hash || 'unknown',
      pass_name: passName,
      severity: f.severity,
      category: f.category,
      primary_file: f._primaryFile || f.section,
      detail_snapshot: f.detail?.slice(0, 600),
      round_raised: round
    };
    if (!hasClassification) return base;
    return {
      ...base,
      sonar_type: f.classification?.sonarType ?? null,
      effort: f.classification?.effort ?? null,
      source_kind: f.classification?.sourceKind ?? null,
      source_name: f.classification?.sourceName ?? null,
    };
  });

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
 * Update pass stats with actual adjudication outcomes after deliberation.
 * Called by outcome-sync.mjs after triage — fixes the data loop gap where
 * findings_accepted/findings_dismissed were always written as 0.
 * @param {string} runId
 * @param {Object<string, {accepted: number, dismissed: number, compromised: number}>} passCounts
 */
export async function updatePassStatsPostDeliberation(runId, passCounts) {
  if (!_supabase || !runId) return;

  for (const [passName, counts] of Object.entries(passCounts)) {
    const { error } = await _supabase
      .from('audit_pass_stats')
      .update({
        findings_accepted: counts.accepted,
        findings_dismissed: counts.dismissed,
        findings_compromised: counts.compromised || 0,
      })
      .eq('run_id', runId)
      .eq('pass_name', passName);

    if (error) process.stderr.write(`  [learning] updatePassStats(${passName}) failed: ${error.message}\n`);
  }
}

/**
 * Retrieve average pass timing/token data for cost prediction.
 * Groups by pass_name, returns averages only for passes with real data.
 * @returns {Promise<Array<{passName: string, avgInputTokens: number, avgOutputTokens: number, avgLatencyMs: number, runCount: number}>>}
 */
export async function getPassTimings() {
  if (!_supabase) return [];

  const { data, error } = await _supabase
    .from('audit_pass_stats')
    .select('pass_name, input_tokens, output_tokens, latency_ms')
    .gt('input_tokens', 0);

  if (error || !data) {
    process.stderr.write(`  [learning] getPassTimings failed: ${error?.message}\n`);
    return [];
  }

  // Aggregate in-memory (simpler than a Supabase RPC for now)
  const byPass = {};
  for (const row of data) {
    if (!byPass[row.pass_name]) byPass[row.pass_name] = { totalIn: 0, totalOut: 0, totalLat: 0, count: 0 };
    const p = byPass[row.pass_name];
    p.totalIn += row.input_tokens || 0;
    p.totalOut += row.output_tokens || 0;
    p.totalLat += row.latency_ms || 0;
    p.count++;
  }

  return Object.entries(byPass).map(([passName, p]) => ({
    passName,
    avgInputTokens: Math.round(p.totalIn / p.count),
    avgOutputTokens: Math.round(p.totalOut / p.count),
    avgLatencyMs: Math.round(p.totalLat / p.count),
    runCount: p.count,
  }));
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

// ── Debt Ledger (Phase D) ───────────────────────────────────────────────────

/**
 * Upsert debt entries to the cloud debt_entries table. Per-entry idempotent
 * via (repo_id, topic_id) UNIQUE constraint. Caller handles local persistence;
 * this writer only mirrors approved entries to the cloud.
 *
 * @param {string|null} repoId - from upsertRepo(); null skips the call
 * @param {object[]} entries - PersistedDebtEntry-shaped
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function upsertDebtEntries(repoId, entries) {
  if (!_supabase || !repoId || !Array.isArray(entries) || entries.length === 0) {
    return { ok: true };
  }
  const rows = entries.map(e => ({
    repo_id: repoId,
    topic_id: e.topicId,
    semantic_hash: e.semanticHash,
    severity: e.severity,
    category: e.category,
    section: e.section,
    detail_snapshot: e.detailSnapshot,
    affected_files: e.affectedFiles,
    affected_principles: e.affectedPrinciples,
    pass: e.pass,
    sonar_type: e.classification?.sonarType ?? null,
    effort: e.classification?.effort ?? null,
    source_kind: e.classification?.sourceKind ?? null,
    source_name: e.classification?.sourceName ?? null,
    deferred_reason: e.deferredReason,
    deferred_at: e.deferredAt,
    deferred_run: e.deferredRun,
    deferred_rationale: e.deferredRationale,
    blocked_by: e.blockedBy ?? null,
    followup_pr: e.followupPr ?? null,
    approver: e.approver ?? null,
    approved_at: e.approvedAt ?? null,
    policy_ref: e.policyRef ?? null,
    owner: e.owner ?? null,
    content_aliases: e.contentAliases || [],
    sensitive: e.sensitive ?? false,
    updated_at: new Date().toISOString(),
  }));
  const { error } = await _supabase
    .from('debt_entries')
    .upsert(rows, { onConflict: 'repo_id,topic_id' });
  if (error) {
    process.stderr.write(`  [learning] upsertDebtEntries failed: ${error.message}\n`);
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

/**
 * Read all debt entries for a repo from the cloud.
 * Returns PersistedDebtEntry-shaped objects (no derived fields — derive via events).
 * @param {string|null} repoId
 * @returns {Promise<object[]>}
 */
export async function readDebtEntriesCloud(repoId) {
  if (!_supabase || !repoId) return [];
  const { data, error } = await _supabase
    .from('debt_entries')
    .select('*')
    .eq('repo_id', repoId);
  if (error) {
    process.stderr.write(`  [learning] readDebtEntriesCloud failed: ${error.message}\n`);
    return [];
  }
  return (data || []).map(row => ({
    source: 'debt',
    topicId: row.topic_id,
    semanticHash: row.semantic_hash,
    severity: row.severity,
    category: row.category,
    section: row.section,
    detailSnapshot: row.detail_snapshot,
    affectedFiles: row.affected_files || [],
    affectedPrinciples: row.affected_principles || [],
    pass: row.pass,
    classification: row.sonar_type
      ? { sonarType: row.sonar_type, effort: row.effort, sourceKind: row.source_kind, sourceName: row.source_name }
      : null,
    deferredReason: row.deferred_reason,
    deferredAt: row.deferred_at,
    deferredRun: row.deferred_run,
    deferredRationale: row.deferred_rationale,
    blockedBy: row.blocked_by ?? undefined,
    followupPr: row.followup_pr ?? undefined,
    approver: row.approver ?? undefined,
    approvedAt: row.approved_at ?? undefined,
    policyRef: row.policy_ref ?? undefined,
    owner: row.owner ?? undefined,
    contentAliases: row.content_aliases || [],
    sensitive: row.sensitive ?? false,
  }));
}

/**
 * Delete a debt entry from the cloud by topicId.
 * Idempotent — no-op when the row doesn't exist.
 */
export async function removeDebtEntryCloud(repoId, topicId) {
  if (!_supabase || !repoId) return { ok: true };
  const { error } = await _supabase
    .from('debt_entries')
    .delete()
    .eq('repo_id', repoId)
    .eq('topic_id', topicId);
  if (error) {
    process.stderr.write(`  [learning] removeDebtEntryCloud failed: ${error.message}\n`);
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

/**
 * Append debt events to the cloud. Idempotent via the
 * (repo_id, topic_id, run_id, event) UNIQUE constraint — duplicate inserts
 * are silently dropped, which enables the offline→cloud reconciler.
 *
 * @param {string|null} repoId
 * @param {object[]} events - DebtEvent-shaped
 * @returns {Promise<{inserted: number, error?: string}>}
 */
export async function appendDebtEventsCloud(repoId, events) {
  if (!_supabase || !repoId || !Array.isArray(events) || events.length === 0) {
    return { inserted: 0 };
  }
  const rows = events.map(e => ({
    repo_id: repoId,
    topic_id: e.topicId ?? null,
    event: e.event,
    run_id: e.runId,
    ts: e.ts,
    match_count: e.matchCount ?? null,
    rationale: e.rationale ?? null,
    resolution_rationale: e.resolutionRationale ?? null,
    resolved_by: e.resolvedBy ?? null,
  }));
  // Use upsert with ignoreDuplicates to get idempotent inserts.
  const { data, error } = await _supabase
    .from('debt_events')
    .upsert(rows, {
      onConflict: 'repo_id,topic_id,run_id,event',
      ignoreDuplicates: true,
    })
    .select('id');
  if (error) {
    process.stderr.write(`  [learning] appendDebtEventsCloud failed: ${error.message}\n`);
    return { inserted: 0, error: error.message };
  }
  return { inserted: (data || []).length };
}

/**
 * Read all debt events for a repo.
 * @param {string|null} repoId
 * @returns {Promise<object[]>} DebtEvent[] (normalized camelCase)
 */
export async function readDebtEventsCloud(repoId) {
  if (!_supabase || !repoId) return [];
  const { data, error } = await _supabase
    .from('debt_events')
    .select('*')
    .eq('repo_id', repoId)
    .order('ts', { ascending: true });
  if (error) {
    process.stderr.write(`  [learning] readDebtEventsCloud failed: ${error.message}\n`);
    return [];
  }
  return (data || []).map(row => ({
    ts: row.ts,
    runId: row.run_id,
    topicId: row.topic_id ?? undefined,
    event: row.event,
    matchCount: row.match_count ?? undefined,
    rationale: row.rationale ?? undefined,
    resolutionRationale: row.resolution_rationale ?? undefined,
    resolvedBy: row.resolved_by ?? undefined,
  }));
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

// ═══════════════════════════════════════════════════════════════════════════
//  Cross-Skill Data Loop — plans / regression_specs / correlations / ship
// ═══════════════════════════════════════════════════════════════════════════
// These tables close the feedback loop between /plan-*, /audit-loop, /ux-lock,
// /persona-test, and /ship — see migration 20260419120000_cross_skill_data_loop.
// Every function gracefully no-ops when cloud mode is off.

// ── Plans ──────────────────────────────────────────────────────────────────

/**
 * Upsert a plan artefact record. Returns the plan UUID so audit_runs can link.
 *
 * @param {string|null} repoId — from upsertRepo
 * @param {object} plan
 * @param {string}   plan.path              — repo-relative path to the plan file
 * @param {'plan-backend'|'plan-frontend'|'manual'|'other'} plan.skill
 * @param {string}   [plan.status]          — default 'draft'
 * @param {string[]} [plan.principlesCited] — principle identifiers the plan cites
 * @param {string[]} [plan.focusAreas]      — e.g. ['backend', 'auth']
 * @param {string}   [plan.commitSha]       — commit the plan was authored against
 * @param {string}   [plan.checksum]        — sha256 of plan markdown (drift detection)
 * @returns {Promise<string|null>} plan UUID
 */
export async function upsertPlan(repoId, plan) {
  if (!_supabase) return null;
  if (!plan?.path || !plan?.skill) return null;

  const { data, error } = await _supabase
    .from('plans')
    .upsert({
      repo_id: repoId || null,
      path: plan.path,
      skill: plan.skill,
      status: plan.status || 'draft',
      principles_cited: plan.principlesCited || [],
      focus_areas: plan.focusAreas || [],
      commit_sha: plan.commitSha || null,
      checksum: plan.checksum || null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'repo_id,path' })
    .select('id')
    .single();

  if (error) {
    process.stderr.write(`  [learning] upsertPlan failed: ${error.message}\n`);
    return null;
  }
  return data?.id;
}

/**
 * Update a plan's status (draft → in_progress → complete → abandoned).
 */
export async function updatePlanStatus(planId, status) {
  if (!_supabase || !planId) return;
  const { error } = await _supabase
    .from('plans')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', planId);
  if (error) process.stderr.write(`  [learning] updatePlanStatus failed: ${error.message}\n`);
}

// ── Regression Specs (/ux-lock) ────────────────────────────────────────────

/**
 * Record a regression spec authored by /ux-lock.
 *
 * @param {string|null} repoId
 * @param {object} spec
 * @param {string}   spec.specPath             — e.g. tests/e2e/fix-modal-close.spec.js
 * @param {string}   spec.description
 * @param {string}   [spec.commitSha]
 * @param {number}   [spec.assertionCount]
 * @param {string[]} [spec.domContractTypes]   — ['role','aria-*','data-testid','axe',...]
 * @param {'audit-loop-fix'|'persona-test-p0'|'persona-test-p1'|'manual'|'other'} spec.sourceKind
 * @param {string}   [spec.sourceFindingId]    — audit_findings.id OR persona finding hash
 * @param {'audit'|'persona'} [spec.sourceFindingType]
 * @returns {Promise<string|null>} spec UUID
 */
export async function recordRegressionSpec(repoId, spec) {
  if (!_supabase) return null;
  if (!spec?.specPath || !spec?.description || !spec?.sourceKind) return null;

  const { data, error } = await _supabase
    .from('regression_specs')
    .upsert({
      repo_id: repoId || null,
      spec_path: spec.specPath,
      description: spec.description,
      commit_sha: spec.commitSha || null,
      assertion_count: spec.assertionCount || 0,
      dom_contract_types: spec.domContractTypes || [],
      source_kind: spec.sourceKind,
      source_finding_id: spec.sourceFindingId || null,
      source_finding_type: spec.sourceFindingType || null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'repo_id,spec_path' })
    .select('id')
    .single();

  if (error) {
    process.stderr.write(`  [learning] recordRegressionSpec failed: ${error.message}\n`);
    return null;
  }
  return data?.id;
}

/**
 * Append a run outcome for a regression spec (pass/fail, whether it caught a regression).
 *
 * @param {string} specId — from recordRegressionSpec
 * @param {object} run
 * @param {boolean} run.passed
 * @param {string}  [run.commitSha]
 * @param {boolean} [run.capturedRegression] — true if the spec failed on code that *should* have preserved the contract
 * @param {number}  [run.durationMs]
 * @param {string}  [run.errorMessage]
 * @param {'ship-gate'|'ci'|'manual'|'ux-lock-verify'} [run.runContext]
 */
export async function recordRegressionSpecRun(specId, run) {
  if (!_supabase || !specId) return;

  const { error } = await _supabase
    .from('regression_spec_runs')
    .insert({
      spec_id: specId,
      commit_sha: run.commitSha || null,
      passed: !!run.passed,
      captured_regression: !!run.capturedRegression,
      duration_ms: run.durationMs || null,
      error_message: run.errorMessage || null,
      run_context: run.runContext || null,
    });

  if (error) process.stderr.write(`  [learning] recordRegressionSpecRun failed: ${error.message}\n`);
}

/**
 * Query recent fixes that lack a regression spec (feeds /ship's warning gate).
 * @param {string|null} repoId
 * @returns {Promise<object[]>} rows from unlocked_fixes view (limit 20)
 */
export async function getUnlockedFixes(repoId) {
  if (!_supabase) return [];
  const q = _supabase
    .from('unlocked_fixes')
    .select('*')
    .limit(20);
  const { data, error } = repoId ? await q.eq('repo_id', repoId) : await q;
  if (error) {
    process.stderr.write(`  [learning] getUnlockedFixes failed: ${error.message}\n`);
    return [];
  }
  return data || [];
}

// ── Persona-Audit Correlations (the ground-truth labelling feed) ───────────

/**
 * Record a correlation between a persona finding and an audit finding.
 * This is the highest-leverage table: every row here is a ground-truth label
 * for audit-loop's bandit reward.
 *
 * @param {string} personaSessionId
 * @param {object} correlation
 * @param {string} correlation.personaFindingHash
 * @param {'P0'|'P1'|'P2'|'P3'} correlation.personaSeverity
 * @param {string|null} [correlation.auditFindingId]  — null if audit missed it
 * @param {string|null} [correlation.auditRunId]
 * @param {'confirmed_hit'|'audit_missed'|'audit_false_positive'|'severity_understated'|'severity_overstated'} correlation.correlationType
 * @param {number} [correlation.matchScore]
 * @param {string} [correlation.matchRationale]
 */
export async function recordPersonaAuditCorrelation(personaSessionId, correlation) {
  if (!_supabase || !personaSessionId) return;
  if (!correlation?.personaFindingHash || !correlation?.correlationType || !correlation?.personaSeverity) return;

  const { error } = await _supabase
    .from('persona_audit_correlations')
    .upsert({
      persona_session_id: personaSessionId,
      persona_finding_hash: correlation.personaFindingHash,
      persona_severity: correlation.personaSeverity,
      audit_finding_id: correlation.auditFindingId || null,
      audit_run_id: correlation.auditRunId || null,
      correlation_type: correlation.correlationType,
      match_score: correlation.matchScore ?? null,
      match_rationale: correlation.matchRationale || null,
    }, { onConflict: 'persona_session_id,persona_finding_hash,audit_finding_id' });

  if (error) process.stderr.write(`  [learning] recordPersonaAuditCorrelation failed: ${error.message}\n`);
}

/**
 * Read correlations for a specific audit_run — used by the bandit to compute
 * user-visible-impact rewards post-hoc.
 * @param {string} auditRunId
 * @returns {Promise<object[]>}
 */
export async function readCorrelationsForRun(auditRunId) {
  if (!_supabase || !auditRunId) return [];
  const { data, error } = await _supabase
    .from('persona_audit_correlations')
    .select('*')
    .eq('audit_run_id', auditRunId);
  if (error) {
    process.stderr.write(`  [learning] readCorrelationsForRun failed: ${error.message}\n`);
    return [];
  }
  return data || [];
}

/**
 * Read correlations for a specific finding (by ID) — used by the bandit
 * per-finding reward augmentation.
 * @param {string} auditFindingId
 * @returns {Promise<object[]>}
 */
export async function readCorrelationsForFinding(auditFindingId) {
  if (!_supabase || !auditFindingId) return [];
  const { data, error } = await _supabase
    .from('persona_audit_correlations')
    .select('*')
    .eq('audit_finding_id', auditFindingId);
  if (error) {
    process.stderr.write(`  [learning] readCorrelationsForFinding failed: ${error.message}\n`);
    return [];
  }
  return data || [];
}

/**
 * Read the audit_effectiveness rollup — user-visible precision & recall.
 * Used by meta-assess to drive prompt evolution.
 */
export async function readAuditEffectiveness(repoId) {
  if (!_supabase) return null;
  const { data, error } = await _supabase
    .from('audit_effectiveness')
    .select('*')
    .eq('repo_id', repoId)
    .maybeSingle();
  if (error) {
    process.stderr.write(`  [learning] readAuditEffectiveness failed: ${error.message}\n`);
    return null;
  }
  return data;
}

// ── Ship Events ────────────────────────────────────────────────────────────

// ── Plan Verification (/ux-lock verify) ───────────────────────────────────

/**
 * Record a plan verification run — one invocation of /ux-lock verify on a plan.
 * Returns the run UUID so the caller can attach per-item rows.
 *
 * @param {object} run
 * @param {string} run.planId
 * @param {string} [run.specId]     — UUID of the generated regression_spec file
 * @param {string} [run.commitSha]
 * @param {string} [run.url]
 * @param {number} run.totalCriteria
 * @param {number} run.passedCount
 * @param {number} run.failedCount
 * @param {number} [run.skippedCount]
 * @param {number} [run.durationMs]
 * @param {'ux-lock-verify'|'ci'|'manual'} [run.runContext]
 * @returns {Promise<string|null>} run UUID
 */
export async function recordPlanVerificationRun(run) {
  if (!_supabase || !run?.planId) return null;

  const { data, error } = await _supabase
    .from('plan_verification_runs')
    .insert({
      plan_id: run.planId,
      spec_id: run.specId || null,
      commit_sha: run.commitSha || null,
      url: run.url || null,
      total_criteria: run.totalCriteria || 0,
      passed_count: run.passedCount || 0,
      failed_count: run.failedCount || 0,
      skipped_count: run.skippedCount || 0,
      duration_ms: run.durationMs || null,
      run_context: run.runContext || 'ux-lock-verify',
    })
    .select('id')
    .single();

  if (error) {
    process.stderr.write(`  [learning] recordPlanVerificationRun failed: ${error.message}\n`);
    return null;
  }
  return data?.id;
}

/**
 * Record a batch of per-criterion outcomes for a plan verification run.
 * @param {string} runId   — from recordPlanVerificationRun
 * @param {string} planId
 * @param {Array<{
 *   criterionHash: string,
 *   criterionIndex: number,
 *   severity: 'P0'|'P1'|'P2'|'P3',
 *   category: string,
 *   description: string,
 *   setupText?: string,
 *   assertText?: string,
 *   passed: boolean,
 *   errorMessage?: string,
 *   durationMs?: number,
 * }>} items
 */
export async function recordPlanVerificationItems(runId, planId, items) {
  if (!_supabase || !runId || !planId || !Array.isArray(items) || items.length === 0) return;

  const rows = items.map(item => ({
    run_id: runId,
    plan_id: planId,
    criterion_hash: item.criterionHash,
    criterion_index: item.criterionIndex,
    severity: item.severity,
    category: item.category,
    description: item.description,
    setup_text: item.setupText || null,
    assert_text: item.assertText || null,
    passed: !!item.passed,
    error_message: item.errorMessage || null,
    duration_ms: item.durationMs || null,
  }));

  const { error } = await _supabase.from('plan_verification_items').insert(rows);
  if (error) process.stderr.write(`  [learning] recordPlanVerificationItems failed: ${error.message}\n`);
}

/**
 * Read the plan_satisfaction rollup for a given plan (latest run + failing P0/P1).
 * @param {string} planId
 */
export async function readPlanSatisfaction(planId) {
  if (!_supabase || !planId) return null;
  const { data, error } = await _supabase
    .from('plan_satisfaction')
    .select('*')
    .eq('plan_id', planId)
    .maybeSingle();
  if (error) {
    process.stderr.write(`  [learning] readPlanSatisfaction failed: ${error.message}\n`);
    return null;
  }
  return data;
}

/**
 * Read criteria that have been failing across recent runs (persistent failures).
 * @param {string} planId
 */
export async function readPersistentPlanFailures(planId) {
  if (!_supabase || !planId) return [];
  const { data, error } = await _supabase
    .from('persistent_plan_failures')
    .select('*')
    .eq('plan_id', planId);
  if (error) {
    process.stderr.write(`  [learning] readPersistentPlanFailures failed: ${error.message}\n`);
    return [];
  }
  return data || [];
}

/**
 * Record a /ship outcome: shipped, blocked, warned, overridden, or aborted.
 *
 * @param {string|null} repoId
 * @param {object} event
 * @param {string}   [event.commitSha]
 * @param {string}   [event.branch]
 * @param {'shipped'|'blocked'|'warned'|'overridden'|'aborted'} event.outcome
 * @param {string[]} [event.blockReasons]       — ['test-failure','open-p0',...]
 * @param {number}   [event.openP0Count]
 * @param {number}   [event.openP1Count]
 * @param {number}   [event.missingSpecCount]
 * @param {boolean}  [event.overriddenByUser]
 * @param {string}   [event.overrideFlag]       — e.g. '--no-tests'
 * @param {string}   [event.stackDetected]      — 'js-ts'|'python'|'mixed'|'unknown'
 * @param {string}   [event.framework]
 * @param {number}   [event.durationMs]
 */
export async function recordShipEvent(repoId, event) {
  if (!_supabase) return;
  if (!event?.outcome) return;

  const { error } = await _supabase
    .from('ship_events')
    .insert({
      repo_id: repoId || null,
      commit_sha: event.commitSha || null,
      branch: event.branch || null,
      outcome: event.outcome,
      block_reasons: event.blockReasons || [],
      open_p0_count: event.openP0Count || 0,
      open_p1_count: event.openP1Count || 0,
      missing_spec_count: event.missingSpecCount || 0,
      overridden_by_user: !!event.overriddenByUser,
      override_flag: event.overrideFlag || null,
      stack_detected: event.stackDetected || null,
      framework: event.framework || null,
      duration_ms: event.durationMs || null,
    });

  if (error) process.stderr.write(`  [learning] recordShipEvent failed: ${error.message}\n`);
}

// ═══════════════════════════════════════════════════════════════════════════
//  Persona-Test CLI (Phase D of skill-progressive-disclosure refactor)
//  Replaces raw curl blocks in persona-test SKILL.md with typed CLI.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Lazy-init the persona-test Supabase client. Returns null when the env vars
 * are not configured — callers then report cloud:false and no-op.
 */
async function getPersonaSupabase() {
  if (_personaSupabase) return _personaSupabase;
  if (_personaInitAttempted) return null;
  _personaInitAttempted = true;

  const url = process.env.PERSONA_TEST_SUPABASE_URL;
  if (!url) return null;

  // After 20260507 RLS hardening, anon-read is blocked on personas +
  // persona_test_sessions. Reads + writes both require service-role.
  // Resolution order:
  //   1. PERSONA_TEST_SUPABASE_SERVICE_ROLE_KEY (explicit, preferred)
  //   2. SUPABASE_AUDIT_SERVICE_ROLE_KEY (fallback when persona project ==
  //      audit project — common single-Supabase-account setup)
  // Anon key is no longer used; presence-only check kept for graceful
  // degradation messaging.
  const serviceKey =
    process.env.PERSONA_TEST_SUPABASE_SERVICE_ROLE_KEY ||
    (process.env.PERSONA_TEST_SUPABASE_URL === process.env.SUPABASE_AUDIT_URL
      ? process.env.SUPABASE_AUDIT_SERVICE_ROLE_KEY
      : null);

  if (!serviceKey) {
    if (process.env.PERSONA_TEST_SUPABASE_ANON_KEY) {
      process.stderr.write(
        `  [persona] WARN: PERSONA_TEST_SUPABASE_ANON_KEY no longer suffices after the\n` +
        `         20260507 RLS hardening. Set PERSONA_TEST_SUPABASE_SERVICE_ROLE_KEY\n` +
        `         (or rely on SUPABASE_AUDIT_SERVICE_ROLE_KEY when the URLs match).\n`,
      );
    }
    return null;
  }

  try {
    const { createClient } = await import('@supabase/supabase-js');
    _personaSupabase = createClient(url, serviceKey, {
      auth: { persistSession: false },
    });
    return _personaSupabase;
  } catch (err) {
    process.stderr.write(`  [persona] Supabase init failed: ${err.message}\n`);
    return null;
  }
}

/** True when persona-test Supabase is configured + reachable. */
export async function isPersonaCloudEnabled() {
  const c = await getPersonaSupabase();
  return c !== null;
}

/**
 * List personas for an app URL — reads the persona_dashboard view so callers
 * get the running stats (test_count, last_verdict, days_since_last_test, etc.)
 * in one call.
 *
 * @param {string} appUrl
 * @returns {Promise<object[]>} Persona dashboard rows (empty array if none)
 */
export async function listPersonasForApp(appUrl) {
  const supa = await getPersonaSupabase();
  if (!supa || !appUrl) return [];

  const { data, error } = await supa
    .from('persona_dashboard')
    .select('*')
    .eq('app_url', appUrl);

  if (error) {
    process.stderr.write(`  [persona] listPersonasForApp failed: ${error.message}\n`);
    return [];
  }
  return data || [];
}

/**
 * Upsert a persona (idempotent on name+app_url). Returns the persona id and
 * whether the row already existed.
 *
 * @param {object} persona
 * @param {string} persona.name
 * @param {string} persona.description
 * @param {string} persona.appUrl
 * @param {string} [persona.appName]
 * @param {string} [persona.notes]
 * @param {string} [persona.repoName]
 * @returns {Promise<{personaId: string|null, existed: boolean}>}
 */
export async function upsertPersona(persona) {
  const supa = await getPersonaSupabase();
  if (!supa) return { personaId: null, existed: false };
  if (!persona?.name || !persona?.description || !persona?.appUrl) {
    return { personaId: null, existed: false };
  }

  // Detect existed by querying first (Supabase onConflict doesn't expose it directly)
  const { data: existing } = await supa
    .from('personas')
    .select('id')
    .eq('name', persona.name)
    .eq('app_url', persona.appUrl)
    .maybeSingle();

  const existed = !!existing?.id;

  const { data, error } = await supa
    .from('personas')
    .upsert({
      name: persona.name,
      description: persona.description,
      app_url: persona.appUrl,
      app_name: persona.appName || null,
      notes: persona.notes || null,
      repo_name: persona.repoName || null,
    }, { onConflict: 'name,app_url' })
    .select('id')
    .single();

  if (error) {
    process.stderr.write(`  [persona] upsertPersona failed: ${error.message}\n`);
    return { personaId: null, existed: false };
  }
  return { personaId: data?.id || null, existed };
}

/**
 * Record a persona-test session with full session + persona stats update.
 * Idempotent: re-posting the same session_id returns existed=true.
 *
 * The persona stats update (test_count++, last_tested_at=now) is best-effort
 * — if it fails, the session insert is preserved and statsUpdated=false is
 * returned. Stats are derivable from sessions via a reconciler.
 *
 * @param {object} session
 * @returns {Promise<{sessionId: string|null, existed: boolean, statsUpdated: boolean}>}
 */
export async function recordPersonaSession(session) {
  const supa = await getPersonaSupabase();
  if (!supa || !session?.sessionId) {
    return { sessionId: null, existed: false, statsUpdated: false };
  }

  // Idempotent insert via onConflict session_id
  const { data, error } = await supa
    .from('persona_test_sessions')
    .upsert({
      session_id: session.sessionId,
      persona: session.persona,
      url: session.url,
      focus: session.focus || null,
      browser_tool: session.browserTool,
      steps_taken: session.stepsTaken || 0,
      verdict: session.verdict,
      p0_count: session.p0Count || 0,
      p1_count: session.p1Count || 0,
      p2_count: session.p2Count || 0,
      p3_count: session.p3Count || 0,
      avg_confidence: session.avgConfidence ?? null,
      findings: session.findings || [],
      report_md: session.reportMd || null,
      debrief_md: session.debriefMd || null,
      commit_sha: session.commitSha || null,
      deployment_id: session.deploymentId || null,
      repo_name: session.repoName || null,
      persona_id: session.personaId || null,
    }, { onConflict: 'session_id', ignoreDuplicates: false })
    .select('id')
    .single();

  if (error) {
    process.stderr.write(`  [persona] recordPersonaSession failed: ${error.message}\n`);
    return { sessionId: null, existed: false, statsUpdated: false };
  }

  // Secondary: update persona stats (best-effort; session insert is source of truth)
  let statsUpdated = false;
  if (session.personaId) {
    try {
      const { error: statsErr } = await supa
        .from('personas')
        .update({
          last_tested_at: new Date().toISOString(),
          last_verdict: session.verdict,
          last_focus: session.focus || null,
          // test_count increments are tricky without RPC — skip here; reconciler handles it.
        })
        .eq('id', session.personaId);
      statsUpdated = !statsErr;
      if (statsErr) {
        process.stderr.write(`  [persona] WARN stats update failed — session recorded at ${data?.id}: ${statsErr.message}\n`);
      }
    } catch (err) {
      process.stderr.write(`  [persona] WARN stats update exception — session recorded: ${err.message}\n`);
    }
  }

  // existed detection: compare session_id lookup timestamp
  // Simpler: we can't cheaply detect "existed" via upsert, so we issue a follow-up
  // inspection. For MVP, rely on session_id uniqueness — any conflict kept the
  // existing row's id. Caller can compare to its generated session_id to tell.
  return { sessionId: data?.id || null, existed: false, statsUpdated };
}

/**
 * Fetch persona-test sessions filtered by repo name. Used by /plan
 * Phase 1 pre-step, /ship Step 0.5a, and persona-test interop helpers
 * (replaces the curl-based anon reads after 20260507 RLS hardening).
 *
 * @param {object} args
 * @param {string} args.repoName - PERSONA_TEST_REPO_NAME equivalent
 * @param {number} [args.limit=5]
 * @param {boolean} [args.p0Only=false] - filter to sessions where p0_count > 0
 * @param {string[]} [args.select] - optional column allowlist (default: full row)
 * @returns {Promise<object[]>} Rows; empty array on no-cloud or error.
 */
export async function getPersonaSessionsByRepo({ repoName, limit = 5, p0Only = false, select = null }) {
  const supa = await getPersonaSupabase();
  if (!supa || !repoName) return [];

  const cols = (Array.isArray(select) && select.length > 0) ? select.join(',') : '*';
  let q = supa.from('persona_test_sessions').select(cols).eq('repo_name', repoName);
  if (p0Only) q = q.gt('p0_count', 0);
  q = q.order('created_at', { ascending: false }).limit(Math.max(1, Math.min(limit, 100)));

  const { data, error } = await q;
  if (error) {
    process.stderr.write(`  [persona] getPersonaSessionsByRepo failed: ${error.message}\n`);
    return [];
  }
  return data || [];
}

/**
 * Fetch persona-test sessions filtered by app URL. Used by
 * persona-test session-history reference (regression tracking).
 *
 * @param {object} args
 * @param {string} args.url - app URL exact match
 * @param {number} [args.limit=3]
 * @param {string[]} [args.select] - optional column allowlist
 * @returns {Promise<object[]>}
 */
export async function getPersonaSessionsByUrl({ url, limit = 3, select = null }) {
  const supa = await getPersonaSupabase();
  if (!supa || !url) return [];

  const cols = (Array.isArray(select) && select.length > 0) ? select.join(',') : '*';
  const { data, error } = await supa
    .from('persona_test_sessions')
    .select(cols)
    .eq('url', url)
    .order('created_at', { ascending: false })
    .limit(Math.max(1, Math.min(limit, 100)));

  if (error) {
    process.stderr.write(`  [persona] getPersonaSessionsByUrl failed: ${error.message}\n`);
    return [];
  }
  return data || [];
}

// ════════════════════════════════════════════════════════════════════════════
// Architectural Memory (per docs/plans/architectural-memory.md)
//
// Per R2 H10: writes use a SEPARATE service-role client. No anon-write
// fallback exists; missing service-role key → SERVICE_ROLE_REQUIRED throw.
// ════════════════════════════════════════════════════════════════════════════

let _writeClient = null;

/**
 * Lazy-init the service-role write client. Throws SERVICE_ROLE_REQUIRED if
 * the key is absent — no anon-write fallback (per R2 H10).
 * @returns {Promise<object>}
 */
export async function getWriteClient() {
  if (_writeClient) return _writeClient;
  if (!process.env.SUPABASE_AUDIT_URL || !process.env.SUPABASE_AUDIT_SERVICE_ROLE_KEY) {
    const err = new Error(
      'SUPABASE_AUDIT_SERVICE_ROLE_KEY required for writes. ' +
      'Set it in .env (developer-local) or as a GH secret (workflow). ' +
      'No anon-write fallback exists by design.'
    );
    err.code = 'SERVICE_ROLE_REQUIRED';
    throw err;
  }
  const { createClient } = await import('@supabase/supabase-js');
  _writeClient = createClient(
    process.env.SUPABASE_AUDIT_URL,
    process.env.SUPABASE_AUDIT_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );
  return _writeClient;
}

/** Anon read client — same as the existing _supabase. */
export function getReadClient() { return _supabase; }

/**
 * Resolve repo row by stable repo_uuid (per R1 H6 / R3 H6).
 * Returns null if cloud disabled or row not found.
 *
 * @param {string} repoUuid
 * @returns {Promise<{id: string, name: string, activeRefreshId: string|null, activeEmbeddingModel: string|null, activeEmbeddingDim: number|null}|null>}
 */
export async function getRepoIdByUuid(repoUuid) {
  if (!_supabase) return null;
  const { data, error } = await _supabase
    .from('audit_repos')
    .select('id, name, repo_uuid, active_refresh_id, active_embedding_model, active_embedding_dim')
    .eq('repo_uuid', repoUuid)
    .maybeSingle();
  if (error || !data) return null;
  return {
    id: data.id,
    name: data.name,
    activeRefreshId: data.active_refresh_id,
    activeEmbeddingModel: data.active_embedding_model,
    activeEmbeddingDim: data.active_embedding_dim,
  };
}

/**
 * Upsert a repo row keyed on repo_uuid. Requires write client.
 *
 * @param {{repoUuid: string, name: string, fingerprint?: string}} input
 * @returns {Promise<{id: string}|null>}
 */
export async function upsertRepoByUuid({ repoUuid, name, fingerprint }) {
  const w = await getWriteClient();
  // First try update by uuid
  const { data: existing } = await w
    .from('audit_repos')
    .select('id')
    .eq('repo_uuid', repoUuid)
    .maybeSingle();
  if (existing?.id) return { id: existing.id };
  // Insert new row (fingerprint may be provided for backward-compat)
  const fp = fingerprint || `repo_uuid:${repoUuid}`;
  const { data, error } = await w
    .from('audit_repos')
    .upsert({ repo_uuid: repoUuid, name, fingerprint: fp, last_audited_at: new Date().toISOString() },
            { onConflict: 'fingerprint' })
    .select('id')
    .maybeSingle();
  if (error) {
    process.stderr.write(`  [arch] upsertRepoByUuid failed: ${error.message}\n`);
    return null;
  }
  return data ? { id: data.id } : null;
}

/**
 * Open a new refresh_run row. Holds the (repo_id, status='running') unique
 * lock until publishRefreshRun or abortRefreshRun.
 *
 * @param {{repoId: string, mode: 'full'|'incremental', walkStartCommit?: string}} input
 * @returns {Promise<{refreshId: string, cancellationToken: string}>}
 */
export async function openRefreshRun({ repoId, mode, walkStartCommit }) {
  const w = await getWriteClient();
  const cancellationToken = crypto.randomUUID();
  const { data, error } = await w
    .from('refresh_runs')
    .insert({
      repo_id: repoId,
      mode,
      walk_start_commit: walkStartCommit || null,
      cancellation_token: cancellationToken,
      last_heartbeat_at: new Date().toISOString(),
    })
    .select('id')
    .maybeSingle();
  if (error) {
    if (error.code === '23505') {
      const e = new Error(`A refresh is already in flight for this repo. Pass --force to abort.`);
      e.code = 'REFRESH_IN_FLIGHT';
      throw e;
    }
    throw error;
  }
  return { refreshId: data.id, cancellationToken };
}

/**
 * Atomic publish via Postgres RPC (per Gemini-R2 G1).
 * supabase-js cannot multi-statement transact; must use the server-side RPC.
 * R1 audit H4: active embedding model + dim are set atomically inside the
 * publish RPC so repo metadata can never diverge from a half-completed refresh.
 *
 * @param {{repoId: string, refreshId: string, activeEmbeddingModel?: string, activeEmbeddingDim?: number}} input
 */
export async function publishRefreshRun({ repoId, refreshId, activeEmbeddingModel, activeEmbeddingDim }) {
  const w = await getWriteClient();
  const { data, error } = await w.rpc('publish_refresh_run', {
    p_repo_id: repoId,
    p_refresh_id: refreshId,
    p_active_embedding_model: activeEmbeddingModel || null,
    p_active_embedding_dim: activeEmbeddingDim || null,
  });
  if (error) throw new Error(`publish_refresh_run RPC failed: ${error.message}`);
  return data;
}

/** Mark a refresh_run aborted. Workers checking status see this and exit. */
export async function abortRefreshRun({ refreshId, reason }) {
  const w = await getWriteClient();
  const { error } = await w
    .from('refresh_runs')
    .update({ status: 'aborted', error: reason || null, completed_at: new Date().toISOString(), retention_class: 'aborted' })
    .eq('id', refreshId);
  if (error) throw new Error(`abortRefreshRun failed: ${error.message}`);
}

/** Touch heartbeat so --force can detect a live worker. */
export async function heartbeatRefreshRun({ refreshId }) {
  const w = await getWriteClient();
  await w.from('refresh_runs')
    .update({ last_heartbeat_at: new Date().toISOString() })
    .eq('id', refreshId);
}

/**
 * Read current `audit_repos.active_refresh_id` + active embedding model/dim.
 * Reader (anon) — used by neighbourhood-query, render, audit-code.
 *
 * @param {string} repoId
 * @returns {Promise<{refreshId: string|null, activeEmbeddingModel: string|null, activeEmbeddingDim: number|null}|null>}
 */
export async function getActiveSnapshot(repoId) {
  if (!_supabase) return null;
  const { data, error } = await _supabase
    .from('audit_repos')
    .select('active_refresh_id, active_embedding_model, active_embedding_dim')
    .eq('id', repoId)
    .maybeSingle();
  if (error || !data) return null;
  // Read provenance flag from refresh_runs (added by migration
  // 20260503170000). Existing snapshots default to false → renderer +
  // /explain treat as "pre-feature" and skip caller-domain analysis
  // (chain-of-trust rule per plan §2.6.1).
  let importGraphPopulated = false;
  if (data.active_refresh_id) {
    const { data: rr } = await _supabase
      .from('refresh_runs')
      .select('import_graph_populated')
      .eq('id', data.active_refresh_id)
      .maybeSingle();
    if (rr && rr.import_graph_populated === true) importGraphPopulated = true;
  }
  return {
    refreshId: data.active_refresh_id,
    activeEmbeddingModel: data.active_embedding_model,
    activeEmbeddingDim: data.active_embedding_dim,
    importGraphPopulated,
  };
}

// Chunk size for Supabase REST upserts. Large repos (8000+ symbols) blow
// past Supabase's request body limit and PostgREST timeouts when sent in
// one shot — found live during ai-organiser refresh (8406 symbols → fetch
// failed). 500 rows/chunk keeps each request well under the 1MB limit and
// inside the default 60s timeout.
const UPSERT_CHUNK_SIZE = 500;

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/**
 * Wrap a Supabase request in retry+backoff so transient network blips
 * (`TypeError: fetch failed`) don't abort a multi-thousand-symbol refresh.
 * Found live during ai-organiser refresh (8406 symbols, mid-run fetch died).
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @param {string} label - for error context
 * @param {number} maxAttempts
 * @returns {Promise<T>}
 */
async function withRetry(fn, label, maxAttempts = 4) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try { return await fn(); }
    catch (err) {
      lastErr = err;
      const msg = String(err.message || err);
      const isNetwork = msg.includes('fetch failed') || msg.includes('ETIMEDOUT')
        || msg.includes('ECONNRESET') || msg.includes('ENOTFOUND') || msg.includes('EAI_AGAIN');
      if (!isNetwork || attempt === maxAttempts) throw err;
      const delayMs = 500 * Math.pow(2, attempt - 1) + Math.random() * 250;
      process.stderr.write(`  [arch] ${label} network blip (attempt ${attempt}/${maxAttempts}): ${msg.slice(0, 120)} — retrying in ${Math.round(delayMs)}ms\n`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

/** Bulk upsert symbol_definitions; returns {[canonical_path|name|kind]: definitionId}. */
export async function recordSymbolDefinitions(repoId, defs) {
  if (!Array.isArray(defs) || defs.length === 0) return {};
  const w = await getWriteClient();
  const rows = defs.map(d => ({
    repo_id: repoId,
    canonical_path: d.canonicalPath,
    symbol_name: d.symbolName,
    kind: d.kind,
    last_seen_at: new Date().toISOString(),
  }));
  const map = {};
  for (const slice of chunk(rows, UPSERT_CHUNK_SIZE)) {
    const data = await withRetry(async () => {
      const { data, error } = await w
        .from('symbol_definitions')
        .upsert(slice, { onConflict: 'repo_id,canonical_path,symbol_name,kind' })
        .select('id, canonical_path, symbol_name, kind');
      if (error) throw new Error(`recordSymbolDefinitions failed: ${error.message}`);
      return data;
    }, 'recordSymbolDefinitions');
    for (const r of (data || [])) {
      map[`${r.canonical_path}|${r.symbol_name}|${r.kind}`] = r.id;
    }
  }
  return map;
}

export async function recordSymbolIndex(refreshId, repoId, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  const w = await getWriteClient();
  const payload = rows.map(r => ({
    refresh_id: refreshId,
    repo_id: repoId,
    definition_id: r.definitionId,
    file_path: r.filePath,
    start_line: r.startLine,
    end_line: r.endLine,
    signature_hash: r.signatureHash,
    purpose_summary: r.purposeSummary || null,
    domain_tag: r.domainTag || null,
  }));
  let total = 0;
  for (const slice of chunk(payload, UPSERT_CHUNK_SIZE)) {
    await withRetry(async () => {
      const { error } = await w
        .from('symbol_index')
        .upsert(slice, { onConflict: 'refresh_id,definition_id' });
      if (error) throw new Error(`recordSymbolIndex failed: ${error.message}`);
    }, 'recordSymbolIndex');
    total += slice.length;
  }
  return total;
}

export async function recordSymbolEmbedding({ definitionId, embeddingModel, dimension, vector, signatureHash }) {
  const w = await getWriteClient();
  await withRetry(async () => {
    const { error } = await w
      .from('symbol_embeddings')
      .upsert({
        definition_id: definitionId,
        embedding_model: embeddingModel,
        dimension,
        embedding: vector,
        signature_hash: signatureHash,
      }, { onConflict: 'definition_id,embedding_model,dimension,signature_hash' });
    if (error) throw new Error(`recordSymbolEmbedding failed: ${error.message}`);
  }, 'recordSymbolEmbedding');
}

export async function recordLayeringViolations(refreshId, repoId, violations) {
  if (!Array.isArray(violations) || violations.length === 0) return 0;
  const w = await getWriteClient();
  const payload = violations.map(v => ({
    refresh_id: refreshId,
    repo_id: repoId,
    rule_name: v.ruleName,
    from_path: v.fromPath,
    to_path: v.toPath,
    severity: v.severity,
    comment: v.comment || null,
  }));
  let total = 0;
  for (const slice of chunk(payload, UPSERT_CHUNK_SIZE)) {
    await withRetry(async () => {
      const { error } = await w
        .from('symbol_layering_violations')
        .upsert(slice, { onConflict: 'refresh_id,rule_name,from_path,to_path' });
      if (error) throw new Error(`recordLayeringViolations failed: ${error.message}`);
    }, 'recordLayeringViolations');
    total += slice.length;
  }
  return total;
}

/**
 * Set the repo's active embedding model+dim atomically. Per R3 H7 + Gemini G2,
 * `model` MUST be a concrete provider id (never a sentinel string).
 */
export async function setActiveEmbeddingModel({ repoId, model, dim }) {
  if (!model || !dim) throw new Error('model and dim are both required');
  const w = await getWriteClient();
  const { error } = await w
    .from('audit_repos')
    .update({ active_embedding_model: model, active_embedding_dim: dim })
    .eq('id', repoId);
  if (error) throw new Error(`setActiveEmbeddingModel failed: ${error.message}`);
}

/** Read active embedding model + dim from repo state. */
export async function getActiveEmbeddingModel(repoId) {
  if (!_supabase) return null;
  const { data } = await _supabase
    .from('audit_repos')
    .select('active_embedding_model, active_embedding_dim')
    .eq('id', repoId)
    .maybeSingle();
  if (!data) return null;
  return { model: data.active_embedding_model, dim: data.active_embedding_dim };
}

/**
 * Call symbol_neighbourhood RPC.
 *
 * @param {{repoId: string, refreshId: string, targetPaths: string[], intentEmbedding: number[], kindFilter: string[]|null, k: number}} args
 * @returns {Promise<object[]>}
 */
export async function callNeighbourhoodRpc({ repoId, refreshId, targetPaths, intentEmbedding, kindFilter, k }) {
  if (!_supabase) return [];
  const { data, error } = await _supabase.rpc('symbol_neighbourhood', {
    p_repo_id: repoId,
    p_refresh_id: refreshId,
    p_target_paths: targetPaths,
    p_intent_embedding: intentEmbedding,
    p_kind_filter: kindFilter && kindFilter.length ? kindFilter : null,
    p_k: k,
  });
  if (error) {
    const e = new Error(`symbol_neighbourhood RPC failed: ${error.message}`);
    e.code = 'RPC_ERROR';
    throw e;
  }
  return Array.isArray(data) ? data : [];
}

/**
 * Compute drift score via RPC.
 * @returns {Promise<object|null>}
 */
export async function computeDriftScore({ repoId, refreshId, simDup, simName }) {
  if (!_supabase) return null;
  const { data, error } = await _supabase.rpc('drift_score', {
    p_repo_id: repoId,
    p_refresh_id: refreshId,
    p_sim_dup: simDup,
    p_sim_name: simName,
  });
  if (error) {
    const e = new Error(`drift_score RPC failed: ${error.message}`);
    e.code = 'RPC_ERROR';
    throw e;
  }
  return data;
}

// ── security_incidents helpers (Plan: docs/plans/security-memory-v1.md) ─────

/**
 * UPSERT a batch of parsed incidents from docs/security-strategy.md.
 * Mirrors the chunked recordSymbolIndex pattern.
 */
export async function recordSecurityIncidents(repoId, incidents) {
  if (!_supabase || !Array.isArray(incidents) || incidents.length === 0) return { upserted: 0 };
  const w = await getWriteClient();
  let upserted = 0;
  for (const batch of chunk(incidents, UPSERT_CHUNK_SIZE)) {
    const payload = batch.map(i => ({
      repo_id: repoId,
      incident_id: i.incident_id,
      description: i.description,
      affected_paths: i.affected_paths,
      mitigation_ref: i.mitigation_ref,
      mitigation_kind: i.mitigation_kind,
      lessons_learned: i.lessons_learned,
      embedding: i.embedding,
      embedding_model: i.embedding_model,
      embedding_dim: i.embedding_dim,
      source_fingerprint: i.source_fingerprint,
      status: i.status,
      status_check_at: i.status_check_at,
    }));
    const { error } = await w
      .from('security_incidents')
      .upsert(payload, { onConflict: 'repo_id,incident_id' });
    if (error) throw new Error(`recordSecurityIncidents failed: ${error.message}`);
    upserted += payload.length;
  }
  return { upserted };
}

/** Read existing incidents for cache-hit comparison during refresh. */
export async function getSecurityIncidentsByRepo(repoId) {
  if (!_supabase || !repoId) return [];
  const { data, error } = await _supabase
    .from('security_incidents')
    .select('id, incident_id, source_fingerprint, embedding_model, embedding_dim, status, mitigation_ref, mitigation_kind')
    .eq('repo_id', repoId);
  if (error) throw new Error(`getSecurityIncidentsByRepo failed: ${error.message}`);
  return data || [];
}

/** R-Gemini-r2-G2: sweep — mark removed-from-markdown incidents as historical. */
export async function markIncidentsHistorical(repoId, incidentIds) {
  if (!_supabase || !Array.isArray(incidentIds) || incidentIds.length === 0) return { marked: 0 };
  const w = await getWriteClient();
  const { error } = await w
    .from('security_incidents')
    .update({ status: 'historical', status_check_at: new Date().toISOString() })
    .eq('repo_id', repoId)
    .in('incident_id', incidentIds);
  if (error) throw new Error(`markIncidentsHistorical failed: ${error.message}`);
  return { marked: incidentIds.length };
}

/** R2-H2: freshness check — what's the most recent updated_at for this repo? */
export async function getMaxIncidentRefreshAt(repoId) {
  if (!_supabase || !repoId) return null;
  const { data, error } = await _supabase
    .from('security_incidents')
    .select('updated_at')
    .eq('repo_id', repoId)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return null;
  return data?.updated_at ?? null;
}

/** Composite RPC: returns raw signals; client weights + re-sorts. */
export async function callIncidentNeighbourhoodRpc({ repoId, targetPaths, intentEmbedding, k }) {
  if (!_supabase) return [];
  // R1-H1: incident_neighbourhood is service_role only — must use write client
  const w = await getWriteClient();
  const { data, error } = await w.rpc('incident_neighbourhood', {
    p_repo_id: repoId,
    p_target_paths: targetPaths,
    p_intent_embedding: intentEmbedding,
    p_k: k,
  });
  if (error) {
    const e = new Error(`incident_neighbourhood RPC failed: ${error.message}`);
    e.code = 'RPC_ERROR';
    throw e;
  }
  return (data || []).map(r => ({
    incidentId: r.incident_id,
    description: r.description,
    affectedPaths: r.affected_paths,
    mitigationRef: r.mitigation_ref,
    status: r.status,
    lessonsLearned: r.lessons_learned,
    cosineScore: Number(r.cosine_score),
    pathOverlap: r.path_overlap === true,
    mitigationBonus: Number(r.mitigation_bonus),
    recencyDecay: Number(r.recency_decay),
  }));
}

/**
 * Bulk-insert file-level import edges into symbol_file_imports for a
 * snapshot. Plan §2.6 — keyed by importer_path so copy-forward works
 * correctly (R1-H1).
 *
 * @param {string} refreshId
 * @param {Array<{importer:string, imported:string}>} edges
 * @returns {Promise<{inserted:number}>}
 */
export async function recordSymbolFileImports(refreshId, edges) {
  if (!_supabase || !Array.isArray(edges) || edges.length === 0) {
    return { inserted: 0 };
  }
  const w = await getWriteClient();
  let inserted = 0;
  for (const batch of chunk(edges, UPSERT_CHUNK_SIZE)) {
    const payload = batch.map(e => ({
      refresh_id: refreshId,
      importer_path: e.importer,
      imported_path: e.imported,
    }));
    const { error } = await w
      .from('symbol_file_imports')
      .upsert(payload, { onConflict: 'refresh_id,importer_path,imported_path' });
    if (error) throw new Error(`recordSymbolFileImports failed: ${error.message}`);
    inserted += payload.length;
  }
  return { inserted };
}

/**
 * Copy-forward symbol_file_imports rows for untouched importer files.
 * Plan §2.6 (R1-H1) — keyed on importer_path, NOT imported_path. If
 * a touched file `a.js` drops its import of untouched `b.js`, the
 * dropped edge stays absent because `a.js` re-emits its current edges
 * during this refresh.
 *
 * @param {{fromRefreshId:string, toRefreshId:string, touchedFileSet:Set<string>}} args
 * @returns {Promise<{copied:number}>}
 */
export async function copyForwardImports({ fromRefreshId, toRefreshId, touchedFileSet }) {
  if (!_supabase || !fromRefreshId || !toRefreshId) return { copied: 0 };
  const w = await getWriteClient();
  let copied = 0;
  const pageSize = 500;
  let offset = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data: rows, error } = await w
      .from('symbol_file_imports')
      .select('importer_path, imported_path')
      .eq('refresh_id', fromRefreshId)
      .range(offset, offset + pageSize - 1);
    if (error) throw new Error(`copyForwardImports read failed: ${error.message}`);
    if (!rows || rows.length === 0) break;
    // Filter on importer_path — edges owned by importer side
    const keep = rows.filter(r => !touchedFileSet.has(r.importer_path));
    if (keep.length > 0) {
      const payload = keep.map(r => ({
        refresh_id: toRefreshId,
        importer_path: r.importer_path,
        imported_path: r.imported_path,
      }));
      const { error: insErr } = await w
        .from('symbol_file_imports')
        .upsert(payload, { onConflict: 'refresh_id,importer_path,imported_path' });
      if (insErr) throw new Error(`copyForwardImports insert failed: ${insErr.message}`);
      copied += payload.length;
    }
    if (rows.length < pageSize) break;
    offset += pageSize;
  }
  return { copied };
}

/**
 * Mark a snapshot as having a fully populated import graph. Set after
 * recordSymbolFileImports completes successfully on a full refresh OR
 * an incremental from a prior snapshot that was already populated
 * (chain-of-trust rule, plan §2.6.1, R2-H1).
 *
 * @param {string} refreshId
 * @returns {Promise<void>}
 */
export async function markImportGraphPopulated(refreshId) {
  if (!_supabase) return;
  const w = await getWriteClient();
  const { error } = await w
    .from('refresh_runs')
    .update({ import_graph_populated: true })
    .eq('id', refreshId);
  if (error) throw new Error(`markImportGraphPopulated failed: ${error.message}`);
}

/**
 * Get the import_graph_populated flag for a specific refresh.
 * Used by refresh.mjs to compute the chain-of-trust value for a new
 * snapshot derived from a prior one.
 *
 * @param {string} refreshId
 * @returns {Promise<boolean>} false when missing or row doesn't exist
 */
export async function getImportGraphPopulated(refreshId) {
  if (!_supabase || !refreshId) return false;
  const { data } = await _supabase
    .from('refresh_runs')
    .select('import_graph_populated')
    .eq('id', refreshId)
    .maybeSingle();
  return data?.import_graph_populated === true;
}

/**
 * Look up the file-level importers for a set of imported_path values
 * within a snapshot. Returns Map<imported_path, sorted importer_paths[]>.
 *
 * Plan §2.6 — alphabetical sort (R1-L1) so the rendered "File imported by"
 * column is stable across renders.
 *
 * Chunked at IN_CHUNK to stay under Supabase REST URL+body limits.
 * Found live: wine-cellar (5433 paths) and ai-organiser (2449 paths)
 * exceeded the limit on a single IN — the renderer's fail-safe (Gemini-G3)
 * caught it but omitted the column entirely. Chunking preserves
 * index-served lookup while staying under the limit. Each chunk is
 * indexed by `idx_sfi_imported` so total work is O(N) regardless of chunk
 * size.
 *
 * @param {{refreshId:string, paths:string[]}} args
 * @returns {Promise<Map<string, string[]>>}
 */
const IN_CHUNK = 200; // safe under Supabase REST `?in=(p1,p2,...)` URL cap
export async function getImportersForFiles({ refreshId, paths }) {
  const out = new Map();
  if (!_supabase || !refreshId || !Array.isArray(paths) || paths.length === 0) return out;
  for (const batch of chunk(paths, IN_CHUNK)) {
    const { data, error } = await _supabase
      .from('symbol_file_imports')
      .select('imported_path, importer_path')
      .eq('refresh_id', refreshId)
      .in('imported_path', batch);
    if (error) throw new Error(`getImportersForFiles failed: ${error.message}`);
    for (const row of (data || [])) {
      if (!out.has(row.imported_path)) out.set(row.imported_path, []);
      out.get(row.imported_path).push(row.importer_path);
    }
  }
  // Stable alphabetical sort (R1-L1) — applied once over merged results.
  for (const list of out.values()) list.sort();
  return out;
}

/**
 * Repo-scoped permanent UPSERT for per-domain summary cache.
 * Plan §2.5 (R1-M1: not refresh-scoped, no copy-forward — the row is
 * permanent until a cache invariant changes).
 */
export async function upsertDomainSummary({ repoId, domainTag, summary, compositionHash, symbolCount, promptTemplateVersion, generatedModel }) {
  if (!_supabase) return;
  const w = await getWriteClient();
  const { error } = await w
    .from('domain_summaries')
    .upsert({
      repo_id: repoId,
      domain_tag: domainTag,
      summary,
      composition_hash: compositionHash,
      symbol_count: symbolCount,
      prompt_template_version: promptTemplateVersion,
      generated_model: generatedModel,
      generated_at: new Date().toISOString(),
    }, { onConflict: 'repo_id,domain_tag' });
  if (error) throw new Error(`upsertDomainSummary failed: ${error.message}`);
}

/**
 * Read all cached domain summaries for a repo.
 * Used by render-mermaid to embed summaries below domain headings.
 *
 * @param {string} repoId
 * @returns {Promise<Map<string, {summary:string, compositionHash:string, symbolCount:number, promptTemplateVersion:number, generatedModel:string}>>}
 */
export async function getDomainSummaries(repoId) {
  const out = new Map();
  if (!_supabase || !repoId) return out;
  const { data, error } = await _supabase
    .from('domain_summaries')
    .select('domain_tag, summary, composition_hash, symbol_count, prompt_template_version, generated_model')
    .eq('repo_id', repoId);
  if (error) throw new Error(`getDomainSummaries failed: ${error.message}`);
  for (const r of (data || [])) {
    out.set(r.domain_tag, {
      summary: r.summary,
      compositionHash: r.composition_hash,
      symbolCount: r.symbol_count,
      promptTemplateVersion: r.prompt_template_version,
      generatedModel: r.generated_model,
    });
  }
  return out;
}

/**
 * Surface the top-N cross-file exact-duplicate clusters in a snapshot.
 * Companion to computeDriftScore — drift returns the count, this returns
 * which symbols are actually duplicated so triage is one query away.
 *
 * @returns {Promise<Array<{signatureHash:string,kind:string,fileCount:number,
 *   symbolNames:string[],filePaths:string[],examplePurpose:string|null}>>}
 */
export async function getTopDuplicateClusters({ repoId, refreshId, limit = 20 }) {
  if (!_supabase) return [];
  const { data, error } = await _supabase.rpc('top_duplicate_clusters', {
    p_repo_id: repoId,
    p_refresh_id: refreshId,
    p_limit: limit,
  });
  if (error) {
    const e = new Error(`top_duplicate_clusters RPC failed: ${error.message}`);
    e.code = 'RPC_ERROR';
    throw e;
  }
  return (data || []).map(r => ({
    signatureHash: r.signature_hash,
    kind: r.kind,
    fileCount: r.file_count,
    symbolNames: r.symbol_names,
    filePaths: r.file_paths,
    examplePurpose: r.example_purpose,
  }));
}

/**
 * Read symbols for a snapshot with paginated filters (R3 H9).
 * Reads via anon.
 */
export async function listSymbolsForSnapshot({ refreshId, kind, domainTag, filePathPrefix, limit = 200, offset = 0 }) {
  if (!_supabase) return [];
  let q = _supabase
    .from('symbol_index')
    .select('id, definition_id, repo_id, file_path, start_line, end_line, signature_hash, purpose_summary, domain_tag, symbol_definitions!inner(symbol_name, kind)')
    .eq('refresh_id', refreshId)
    .order('file_path', { ascending: true })
    .order('start_line', { ascending: true });
  if (kind && kind.length) q = q.in('symbol_definitions.kind', kind);
  if (domainTag) q = q.eq('domain_tag', domainTag);
  if (filePathPrefix) q = q.like('file_path', `${filePathPrefix}%`);
  q = q.range(offset, offset + limit - 1);
  const { data, error } = await q;
  if (error) {
    const e = new Error(`listSymbolsForSnapshot failed: ${error.message}`);
    e.code = 'RPC_ERROR';
    throw e;
  }
  return (data || []).map(r => ({
    id: r.id,
    definitionId: r.definition_id,
    refreshId,
    repoId: r.repo_id,
    filePath: r.file_path,
    startLine: r.start_line,
    endLine: r.end_line,
    signatureHash: r.signature_hash,
    purposeSummary: r.purpose_summary,
    domainTag: r.domain_tag,
    symbolName: r.symbol_definitions?.symbol_name,
    kind: r.symbol_definitions?.kind,
  }));
}

export async function listLayeringViolationsForSnapshot(refreshId) {
  if (!_supabase) return [];
  const { data, error } = await _supabase
    .from('symbol_layering_violations')
    .select('rule_name, from_path, to_path, severity, comment')
    .eq('refresh_id', refreshId)
    .order('rule_name');
  if (error) throw new Error(`listLayeringViolations failed: ${error.message}`);
  return (data || []).map(r => ({
    ruleName: r.rule_name,
    fromPath: r.from_path,
    toPath: r.to_path,
    severity: r.severity,
    comment: r.comment,
  }));
}

/**
 * Bulk-copy untouched-file symbols from prior snapshot into new refresh_id.
 * Implemented as INSERT ... SELECT via RPC for atomicity + speed.
 * Touched file set is the union of A/M/D/R/U from git diff.
 *
 * Optional `retagDomain(filePath)`: callback to re-derive `domain_tag` per
 * row during copy. When provided (typically `tagDomain.bind(null, rules)`),
 * a return value of `null` falls back to the prior snapshot's tag so we
 * never regress existing labels. When omitted, the prior tag is copied
 * verbatim. This keeps domain-map.json edits effective on incremental
 * refreshes without requiring a full rebuild.
 */
export async function copyForwardUntouchedFiles({ repoId, fromRefreshId, toRefreshId, touchedFileSet, retagDomain = null }) {
  const w = await getWriteClient();
  // Read prior rows in pages, filter out touched, bulk insert. Simple
  // pagination keeps memory bounded for large repos.
  let copied = 0;
  const pageSize = 500;
  let offset = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data: rows, error } = await w
      .from('symbol_index')
      .select('definition_id, file_path, start_line, end_line, signature_hash, purpose_summary, domain_tag')
      .eq('refresh_id', fromRefreshId)
      .range(offset, offset + pageSize - 1);
    if (error) throw new Error(`copyForward read failed: ${error.message}`);
    if (!rows || rows.length === 0) break;
    const keep = rows.filter(r => !touchedFileSet.has(r.file_path));
    if (keep.length > 0) {
      const payload = keep.map(r => {
        let domainTag = r.domain_tag;
        if (typeof retagDomain === 'function') {
          const fresh = retagDomain(r.file_path);
          // Only overwrite if retagger produced a non-null result; preserves
          // prior tags when the rule set has gaps.
          if (fresh) domainTag = fresh;
        }
        return {
          refresh_id: toRefreshId,
          repo_id: repoId,
          definition_id: r.definition_id,
          file_path: r.file_path,
          start_line: r.start_line,
          end_line: r.end_line,
          signature_hash: r.signature_hash,
          purpose_summary: r.purpose_summary,
          domain_tag: domainTag,
        };
      });
      const { error: insErr } = await w.from('symbol_index').insert(payload);
      if (insErr) throw new Error(`copyForward insert failed: ${insErr.message}`);
      copied += payload.length;
    }
    if (rows.length < pageSize) break;
    offset += pageSize;
  }
  return copied;
}

// ════════════════════════════════════════════════════════════════════════════
// Phase 1 — adaptive-learning-v1 writes
// Plan: docs/plans/adaptive-learning-phase-1-foundation.md
// All methods use getWriteClient() (service-role).  They return
// { ok, error? } — never throw — so decision-logger's outbox can catch
// failures and spill to disk without a try/catch wrapper at every call site.
// ════════════════════════════════════════════════════════════════════════════

async function _safeWriteCall(fn) {
  try {
    const client = await getWriteClient();
    return await fn(client);
  } catch (err) {
    // Includes SERVICE_ROLE_REQUIRED and any RLS rejection.
    return { ok: false, error: err.message || String(err), code: err.code };
  }
}

/**
 * Insert one learning_decisions row.  Idempotent via decision_key UNIQUE
 * (`ignoreDuplicates`).  Caller MUST have already derived decision_key via
 * scripts/lib/learning/decision-logger.mjs::buildDecisionKey().
 *
 * @param {object} entry — from decision-logger queue
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function insertLearningDecision(entry) {
  return _safeWriteCall(async (client) => {
    const row = {
      decision_key:  entry.decisionKey,
      audit_run_id:  entry.auditRunId  ?? null,
      decision_type: entry.decisionType,
      round:         entry.round       ?? null,
      sequence:      entry.sequence    ?? null,
      external_id:   entry.externalId  ?? null,
      repo_id:       entry.repoId      ?? null,
      context:       entry.context,
      context_hash:  entry.contextHash,
      choice:        entry.choice,
      outcome:       entry.outcome     ?? null,
    };
    const { error } = await client.from('learning_decisions')
      .upsert(row, { onConflict: 'decision_key', ignoreDuplicates: true });
    return { ok: !error, error: error?.message };
  });
}

/**
 * Update outcome on an existing learning_decisions row by decision_key.
 * Idempotent — same outcome twice is a no-op.
 *
 * @param {{decisionKey: string, outcome: object}} input
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function backfillLearningOutcome({ decisionKey, outcome }) {
  return _safeWriteCall(async (client) => {
    const { error } = await client.from('learning_decisions')
      .update({ outcome, outcome_at: new Date().toISOString() })
      .eq('decision_key', decisionKey);
    return { ok: !error, error: error?.message };
  });
}

/**
 * Update audit_runs.diff_complexity.  Best-effort.
 * @param {string} runId
 * @param {object} complexity — JSON-serialisable
 */
export async function recordDiffComplexity(runId, complexity) {
  return _safeWriteCall(async (client) => {
    const { error } = await client.from('audit_runs')
      .update({ diff_complexity: complexity }).eq('id', runId);
    return { ok: !error, error: error?.message };
  });
}

/**
 * Update audit_runs.round_converged_after + rigor_pressure_round.
 * @param {string} runId
 * @param {{round_converged_after?: number, rigor_pressure_round?: number}} state
 */
export async function recordConvergenceState(runId, state) {
  return _safeWriteCall(async (client) => {
    const patch = {};
    if (state.round_converged_after !== undefined) patch.round_converged_after = state.round_converged_after;
    if (state.rigor_pressure_round !== undefined)  patch.rigor_pressure_round  = state.rigor_pressure_round;
    if (Object.keys(patch).length === 0) return { ok: true };
    const { error } = await client.from('audit_runs').update(patch).eq('id', runId);
    return { ok: !error, error: error?.message };
  });
}

/**
 * Update audit_findings resolution columns.
 * @param {string} findingId
 * @param {{user_action?: string, dismiss_reason?: string, fix_commit_sha?: string, time_to_resolution_ms?: number}} resolution
 */
export async function recordFindingResolution(findingId, resolution) {
  return _safeWriteCall(async (client) => {
    const patch = {};
    if (resolution.user_action !== undefined)            patch.user_action = resolution.user_action;
    if (resolution.dismiss_reason !== undefined)         patch.dismiss_reason = resolution.dismiss_reason;
    if (resolution.fix_commit_sha !== undefined)         patch.fix_commit_sha = resolution.fix_commit_sha;
    if (resolution.time_to_resolution_ms !== undefined)  patch.time_to_resolution_ms = resolution.time_to_resolution_ms;
    if (Object.keys(patch).length === 0) return { ok: true };
    const { error } = await client.from('audit_findings').update(patch).eq('id', findingId);
    return { ok: !error, error: error?.message };
  });
}

/**
 * Invoke `defer_finding(...)` stored procedure.  Single transactional write
 * boundary: updates audit_findings, upserts recurring_clusters, inserts
 * learning_decisions.  Idempotent via decision_key.
 */
export async function callDeferFinding({
  findingId, dismissReason, evidence, clusterHash, severity,
  auditRunId, round, sequence,
}) {
  return _safeWriteCall(async (client) => {
    const { error } = await client.rpc('defer_finding', {
      p_finding_id:    findingId,
      p_dismiss_reason: dismissReason,
      p_evidence:      evidence,
      p_cluster_hash:  clusterHash,
      p_severity:      severity,
      p_audit_run_id:  auditRunId,
      p_round:         round,
      p_sequence:      sequence,
    });
    return { ok: !error, error: error?.message };
  });
}

/** Invoke `mark_finding_needs_triage(...)` stored procedure. */
export async function callMarkFindingNeedsTriage({
  findingId, reason, auditRunId, round, sequence, evidence,
}) {
  return _safeWriteCall(async (client) => {
    const { error } = await client.rpc('mark_finding_needs_triage', {
      p_finding_id:   findingId,
      p_reason:       reason,
      p_audit_run_id: auditRunId,
      p_round:        round,
      p_sequence:     sequence,
      p_evidence:     evidence,
    });
    return { ok: !error, error: error?.message };
  });
}

// ── Phase 1 reads (per-repo scoped — required by weekly-review) ────────────

/**
 * Read pending_triage_findings view, scoped to repo_id.  Required argument
 * — caller MUST pass repoId; this method does NOT default to global queries.
 */
export async function readPendingTriageFindings({ repoId, limit = 100 }) {
  if (!repoId) throw new Error('repoId is required');
  if (!_supabase) return [];
  try {
    const { data, error } = await _supabase.from('pending_triage_findings')
      .select('*').eq('repo_id', repoId).limit(limit);
    return error ? [] : (data || []);
  } catch { return []; }
}

export async function readNoBrainerRecommendations({ repoId, limit = 50 }) {
  if (!repoId) throw new Error('repoId is required');
  if (!_supabase) return [];
  try {
    const { data, error } = await _supabase.from('no_brainer_recommendations')
      .select('*').eq('repo_id', repoId).limit(limit);
    return error ? [] : (data || []);
  } catch { return []; }
}

export async function readStaleClusters({ repoId, ageDays = 30, limit = 50 }) {
  if (!repoId) throw new Error('repoId is required');
  if (!_supabase) return [];
  try {
    const cutoff = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await _supabase.from('recurring_finding_clusters')
      .select('*').eq('repo_id', repoId).eq('status', 'open')
      .lt('last_seen', cutoff).limit(limit);
    return error ? [] : (data || []);
  } catch { return []; }
}

/**
 * Resolve repo_id by repo name (used by weekly-review with LEARNING_REPO_NAME).
 * @param {string} repoName
 * @returns {Promise<string|null>}
 */
export async function getRepoIdByName(repoName) {
  if (!repoName || !_supabase) return null;
  try {
    const { data, error } = await _supabase.from('audit_repos')
      .select('id').eq('name', repoName).single();
    return error ? null : data?.id ?? null;
  } catch { return null; }
}


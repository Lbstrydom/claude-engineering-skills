/**
 * @fileoverview Supabase adapter for the audit-loop learning system.
 * Wraps the existing learning-store.mjs Supabase client code behind
 * the split-interface adapter contract.
 *
 * Phase G.1 ships this as a structural refactor — the Supabase client
 * init and method implementations are extracted from learning-store.mjs.
 * Full method migration happens incrementally as callers move to the facade.
 */

import { GLOBAL_REPO_ID } from './interfaces.mjs';

let _client = null;
let _writeClient = null;
let _writeKeyMissingWarned = false;

async function getClient() {
  if (_client) return _client;
  try {
    const { createClient } = await import('@supabase/supabase-js');
    const url = process.env.SUPABASE_AUDIT_URL;
    const key = process.env.SUPABASE_AUDIT_ANON_KEY;
    if (!url || !key) return null;
    _client = createClient(url, key);
    return _client;
  } catch {
    return null;
  }
}

/**
 * Service-role-keyed client for writes against RLS-service-role-only tables
 * (`learning_decisions`, `recurring_finding_clusters`).  Anon-keyed writes
 * to those tables are silently rejected by RLS, so callers MUST use this
 * factory for any insert/update on the new Phase 1 tables.
 *
 * Graceful degradation: missing `SUPABASE_AUDIT_SERVICE_ROLE_KEY` returns
 * null with a one-time stderr warning.  Caller falls back to local outbox.
 */
export async function getWriteClient() {
  if (_writeClient) return _writeClient;
  try {
    const { createClient } = await import('@supabase/supabase-js');
    const url = process.env.SUPABASE_AUDIT_URL;
    const key = process.env.SUPABASE_AUDIT_SERVICE_ROLE_KEY;
    if (!url || !key) {
      if (!_writeKeyMissingWarned) {
        process.stderr.write(
          '[supabase-store] SUPABASE_AUDIT_SERVICE_ROLE_KEY missing — '
          + 'service-role writes will fall back to local outbox.\n'
        );
        _writeKeyMissingWarned = true;
      }
      return null;
    }
    _writeClient = createClient(url, key, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    return _writeClient;
  } catch {
    return null;
  }
}

/** @internal — test helper to reset the lazy-initialised clients */
export function _resetClientsForTest() {
  _client = null;
  _writeClient = null;
  _writeKeyMissingWarned = false;
}

export const adapter = {
  name: 'supabase',
  capabilities: {
    debt: true,
    run: true,
    learningState: true,
    globalState: true,
    repo: true,
    scopeIsolation: true,
    learning: true, // Phase 1 — adaptive-learning-v1
  },

  async init() {
    const client = await getClient();
    if (!client) return false;
    try {
      // Quick connectivity check
      const { error } = await client.from('audit_repos').select('id').limit(1);
      return !error;
    } catch {
      return false;
    }
  },

  debt: {
    async upsertDebtEntries(repoId, entries) {
      const client = await getClient();
      if (!client) return { ok: false, inserted: 0, updated: 0 };
      try {
        const { data, error } = await client.from('debt_entries')
          .upsert(entries.map(e => ({ ...e, repo_id: repoId })), { onConflict: 'topic_id,repo_id' });
        if (error) return { ok: false, inserted: 0, updated: 0, error: error.message };
        return { ok: true, inserted: entries.length, updated: 0 };
      } catch (err) {
        return { ok: false, inserted: 0, updated: 0, error: err.message };
      }
    },

    async readDebtEntries(repoId) {
      const client = await getClient();
      if (!client) return [];
      try {
        const { data, error } = await client.from('debt_entries')
          .select('*').eq('repo_id', repoId);
        return error ? [] : (data || []);
      } catch { return []; }
    },

    async removeDebtEntry(repoId, topicId) {
      const client = await getClient();
      if (!client) return { ok: false, removed: false };
      try {
        const { error } = await client.from('debt_entries')
          .delete().eq('repo_id', repoId).eq('topic_id', topicId);
        return { ok: !error, removed: !error };
      } catch { return { ok: false, removed: false }; }
    },

    async appendDebtEvents(repoId, events) {
      const client = await getClient();
      if (!client) return { inserted: 0 };
      try {
        const rows = events.map(e => ({ ...e, repo_id: repoId }));
        const { error } = await client.from('debt_events').insert(rows);
        return { inserted: error ? 0 : events.length };
      } catch { return { inserted: 0 }; }
    },

    async readDebtEvents(repoId, sinceTs) {
      const client = await getClient();
      if (!client) return [];
      try {
        let q = client.from('debt_events').select('*').eq('repo_id', repoId);
        if (sinceTs) q = q.gte('ts', sinceTs);
        const { data, error } = await q;
        return error ? [] : (data || []);
      } catch { return []; }
    },
  },

  run: {
    async recordRunStart(repoId, planFile, mode) {
      const client = await getClient();
      if (!client) return null;
      try {
        const { data, error } = await client.from('audit_runs')
          .insert({ repo_id: repoId, plan_file: planFile, mode, started_at: new Date().toISOString() })
          .select('id').single();
        return error ? null : data?.id;
      } catch { return null; }
    },

    async recordRunComplete(runId, stats) {
      const client = await getClient();
      if (!client) return;
      try {
        await client.from('audit_runs')
          .update({ ...stats, completed_at: new Date().toISOString() })
          .eq('id', runId);
      } catch { /* best effort */ }
    },

    async recordFindings(runId, findings, passName, round) {
      const client = await getClient();
      if (!client) return;
      try {
        const rows = findings.map(f => ({
          run_id: runId, pass_name: passName, round,
          finding_id: f.id, severity: f.severity, category: f.category,
          detail: f.detail?.slice(0, 500),
        }));
        await client.from('audit_findings').insert(rows);
      } catch { /* best effort */ }
    },

    async recordPassStats(runId, passName, stats) {
      const client = await getClient();
      if (!client) return;
      try {
        await client.from('audit_pass_stats')
          .insert({ run_id: runId, pass_name: passName, ...stats });
      } catch { /* best effort */ }
    },

    async recordAdjudicationEvent(runId, fingerprint, event) {
      const client = await getClient();
      if (!client) return;
      try {
        await client.from('finding_adjudication_events')
          .insert({ run_id: runId, fingerprint, ...event });
      } catch { /* best effort */ }
    },

    async recordSuppressionEvents(runId, result) {
      const client = await getClient();
      if (!client) return;
      try {
        await client.from('suppression_events')
          .insert({ run_id: runId, ...result });
      } catch { /* best effort */ }
    },
  },

  learningState: {
    async syncBanditArms(repoId, arms) {
      const client = await getClient();
      if (!client) return;
      try {
        await client.from('bandit_arms')
          .upsert({ repo_id: repoId, arms: JSON.stringify(arms), updated_at: new Date().toISOString() },
            { onConflict: 'repo_id' });
      } catch { /* best effort */ }
    },

    async loadBanditArms(repoId) {
      const client = await getClient();
      if (!client) return null;
      try {
        const { data, error } = await client.from('bandit_arms')
          .select('arms').eq('repo_id', repoId).single();
        if (error || !data) return null;
        return typeof data.arms === 'string' ? JSON.parse(data.arms) : data.arms;
      } catch { return null; }
    },

    async syncFalsePositivePatterns(repoId, patterns) {
      const client = await getClient();
      if (!client) return;
      try {
        await client.from('false_positive_patterns')
          .upsert({ repo_id: repoId, patterns: JSON.stringify(patterns), updated_at: new Date().toISOString() },
            { onConflict: 'repo_id' });
      } catch { /* best effort */ }
    },

    async loadFalsePositivePatterns(repoId) {
      const client = await getClient();
      if (!client) return { repoPatterns: {}, globalPatterns: {} };
      try {
        const { data: repoData } = await client.from('false_positive_patterns')
          .select('patterns').eq('repo_id', repoId).single();
        const { data: globalData } = await client.from('false_positive_patterns')
          .select('patterns').eq('repo_id', GLOBAL_REPO_ID).single();
        const repoPatterns = repoData?.patterns
          ? (typeof repoData.patterns === 'string' ? JSON.parse(repoData.patterns) : repoData.patterns)
          : {};
        const globalPatterns = globalData?.patterns
          ? (typeof globalData.patterns === 'string' ? JSON.parse(globalData.patterns) : globalData.patterns)
          : {};
        return { repoPatterns, globalPatterns };
      } catch { return { repoPatterns: {}, globalPatterns: {} }; }
    },
  },

  globalState: {
    async syncPromptRevision(passName, revisionId, text) {
      if (!passName || !revisionId) return;
      const client = await getClient();
      if (!client) return;
      try {
        await client.from('prompt_revisions')
          .upsert({ pass_name: passName, revision_id: revisionId, text, updated_at: new Date().toISOString() },
            { onConflict: 'pass_name,revision_id' });
      } catch { /* best effort */ }
    },

    async listGlobalPromptVariants() {
      const client = await getClient();
      if (!client) return [];
      try {
        const { data, error } = await client.from('prompt_variants').select('*');
        return error ? [] : (data || []);
      } catch { return []; }
    },
  },

  // ── Phase 1 — adaptive-learning-v1 writes ──────────────────────────────
  // ALL methods below MUST use getWriteClient() (service-role).  Anon-keyed
  // writes to learning_decisions / recurring_finding_clusters silently fail
  // at the RLS boundary.

  learning: {
    /**
     * Insert a single learning_decisions row.  Idempotent via decision_key
     * UNIQUE — duplicate keys are silently ignored.
     */
    async insertLearningDecision(entry) {
      const client = await getWriteClient();
      if (!client) return { ok: false, error: 'no-write-client' };
      try {
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
        if (error) return { ok: false, error: error.message };
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },

    /**
     * Update the `outcome` of a previously-recorded decision.  Lookup by
     * decision_key.  Idempotent — running with the same outcome is a no-op.
     */
    async backfillLearningOutcome({ decisionKey, outcome }) {
      const client = await getWriteClient();
      if (!client) return { ok: false, error: 'no-write-client' };
      try {
        const { error } = await client.from('learning_decisions')
          .update({ outcome, outcome_at: new Date().toISOString() })
          .eq('decision_key', decisionKey);
        if (error) return { ok: false, error: error.message };
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },

    /** Update audit_runs.diff_complexity.  Best-effort. */
    async recordDiffComplexity(runId, complexity) {
      const client = await getWriteClient();
      if (!client) return { ok: false };
      try {
        const { error } = await client.from('audit_runs')
          .update({ diff_complexity: complexity })
          .eq('id', runId);
        return { ok: !error };
      } catch { return { ok: false }; }
    },

    /** Update audit_runs.round_converged_after + rigor_pressure_round. */
    async recordConvergenceState(runId, { round_converged_after, rigor_pressure_round }) {
      const client = await getWriteClient();
      if (!client) return { ok: false };
      try {
        const patch = {};
        if (round_converged_after !== undefined) patch.round_converged_after = round_converged_after;
        if (rigor_pressure_round !== undefined) patch.rigor_pressure_round = rigor_pressure_round;
        if (Object.keys(patch).length === 0) return { ok: true };
        const { error } = await client.from('audit_runs').update(patch).eq('id', runId);
        return { ok: !error };
      } catch { return { ok: false }; }
    },

    /** Update audit_findings resolution columns. */
    async recordFindingResolution(findingId, { user_action, dismiss_reason, fix_commit_sha, time_to_resolution_ms }) {
      const client = await getWriteClient();
      if (!client) return { ok: false };
      try {
        const patch = {};
        if (user_action !== undefined)            patch.user_action = user_action;
        if (dismiss_reason !== undefined)         patch.dismiss_reason = dismiss_reason;
        if (fix_commit_sha !== undefined)         patch.fix_commit_sha = fix_commit_sha;
        if (time_to_resolution_ms !== undefined)  patch.time_to_resolution_ms = time_to_resolution_ms;
        if (Object.keys(patch).length === 0) return { ok: true };
        const { error } = await client.from('audit_findings').update(patch).eq('id', findingId);
        return { ok: !error };
      } catch { return { ok: false }; }
    },

    /**
     * Invoke the defer_finding stored procedure.  Single transactional
     * write boundary: updates audit_findings, upserts recurring_clusters,
     * inserts learning_decisions row.  Idempotent via decision_key.
     */
    async callDeferFinding({ findingId, dismissReason, evidence, clusterHash, severity, auditRunId, round, sequence }) {
      const client = await getWriteClient();
      if (!client) return { ok: false, error: 'no-write-client' };
      try {
        const { error } = await client.rpc('defer_finding', {
          p_finding_id: findingId,
          p_dismiss_reason: dismissReason,
          p_evidence: evidence,
          p_cluster_hash: clusterHash,
          p_severity: severity,
          p_audit_run_id: auditRunId,
          p_round: round,
          p_sequence: sequence,
        });
        if (error) return { ok: false, error: error.message };
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },

    /** Invoke mark_finding_needs_triage stored procedure. */
    async callMarkFindingNeedsTriage({ findingId, reason, auditRunId, round, sequence, evidence }) {
      const client = await getWriteClient();
      if (!client) return { ok: false, error: 'no-write-client' };
      try {
        const { error } = await client.rpc('mark_finding_needs_triage', {
          p_finding_id: findingId,
          p_reason: reason,
          p_audit_run_id: auditRunId,
          p_round: round,
          p_sequence: sequence,
          p_evidence: evidence,
        });
        if (error) return { ok: false, error: error.message };
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },

    /**
     * Read views consumed by weekly-review.mjs.  Per-repo scoped — caller
     * MUST pass repoId; this method does NOT default to global queries.
     * Service-role client bypasses RLS, but the views use security_invoker
     * so RLS still applies; the explicit repo_id filter is the second line
     * of defence against cross-tenant leakage.
     */
    async readPendingTriageFindings({ repoId, limit = 100 }) {
      const client = await getWriteClient();
      if (!client) return [];
      if (!repoId) throw new Error('repoId is required');
      try {
        const { data, error } = await client.from('pending_triage_findings')
          .select('*').eq('repo_id', repoId).limit(limit);
        return error ? [] : (data || []);
      } catch { return []; }
    },

    async readNoBrainerRecommendations({ repoId, limit = 50 }) {
      const client = await getWriteClient();
      if (!client) return [];
      if (!repoId) throw new Error('repoId is required');
      try {
        const { data, error } = await client.from('no_brainer_recommendations')
          .select('*').eq('repo_id', repoId).limit(limit);
        return error ? [] : (data || []);
      } catch { return []; }
    },

    async readStaleClusters({ repoId, ageDays = 30, limit = 50 }) {
      const client = await getWriteClient();
      if (!client) return [];
      if (!repoId) throw new Error('repoId is required');
      try {
        const cutoff = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000).toISOString();
        const { data, error } = await client.from('recurring_finding_clusters')
          .select('*').eq('repo_id', repoId).eq('status', 'open')
          .lt('last_seen', cutoff).limit(limit);
        return error ? [] : (data || []);
      } catch { return []; }
    },
  },

  repo: {
    async upsertRepo(profile, repoName) {
      const client = await getClient();
      if (!client) return null;
      try {
        const fingerprint = profile?.repoFingerprint;
        if (!fingerprint) return null;
        // Check existing
        const { data: existing } = await client.from('audit_repos')
          .select('id').eq('fingerprint', fingerprint).single();
        if (existing) return existing.id;
        // Insert new
        const { data, error } = await client.from('audit_repos')
          .insert({ fingerprint, name: repoName, profile: JSON.stringify(profile) })
          .select('id').single();
        return error ? null : data?.id;
      } catch { return null; }
    },

    async getRepoByFingerprint(fingerprint) {
      const client = await getClient();
      if (!client) return null;
      try {
        const { data, error } = await client.from('audit_repos')
          .select('id, fingerprint').eq('fingerprint', fingerprint).single();
        return error ? null : data;
      } catch { return null; }
    },
  },
};

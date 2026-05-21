/**
 * @fileoverview Bandit + false-positive + prompt-variant + experiment domain.
 *
 * Part of the postgres-parity M3 split. 9 functions covering:
 *   - Thompson Sampling bandit-arm state (bandit_arms)
 *   - False-positive pattern learning (false_positive_patterns)
 *   - Prompt variants + experiments (prompt_variants, prompt_experiments,
 *     prompt_revisions)
 *   - Pass-effectiveness analytics (audit_pass_stats)
 *
 * @module scripts/lib/store/bandit-fp
 */

import { many, upsert } from '../db/query.mjs';
import { isCloudEnabled } from './repo.mjs';

const GLOBAL_REPO_ID = '00000000-0000-0000-0000-000000000000';

// ── Bandit arms ────────────────────────────────────────────────────────────

/**
 * Sync local bandit-arm state to cloud. Idempotent on
 * `(pass_name, variant_id, context_bucket)`.
 *
 * @param {object} arms - The bandit arms map from PromptBandit
 */
export async function syncBanditArms(arms) {
  if (!await isCloudEnabled()) return;
  const rows = Object.values(arms).map((arm) => ({
    pass_name: arm.passName,
    variant_id: arm.variantId,
    alpha: arm.alpha,
    beta: arm.beta,
    pulls: arm.pulls,
    context_bucket: arm.contextBucket || null,
    updated_at: new Date().toISOString(),
  }));
  if (rows.length === 0) return;
  try {
    await upsert('bandit_arms', rows, {
      onConflict: ['pass_name', 'variant_id', 'context_bucket'],
      update: 'all',
    });
    process.stderr.write(`  [learning] Synced ${rows.length} bandit arms to cloud\n`);
  } catch (err) {
    process.stderr.write(`  [learning] syncBanditArms failed: ${err.message}\n`);
  }
}

/**
 * Load bandit arms for seeding local PromptBandit state. Returns null
 * when cloud is disabled OR no arms exist (matches legacy semantics).
 *
 * @returns {Promise<object|null>}
 */
export async function loadBanditArms() {
  if (!await isCloudEnabled()) return null;
  try {
    const rows = await many(`SELECT * FROM bandit_arms`);
    if (!rows.length) return null;
    const arms = {};
    for (const row of rows) {
      const bucket = row.context_bucket || 'global';
      const key = `${row.pass_name}:${row.variant_id}:${bucket}`;
      arms[key] = {
        passName: row.pass_name,
        variantId: row.variant_id,
        alpha: Number(row.alpha),
        beta: Number(row.beta),
        pulls: row.pulls,
        contextBucket: bucket,
      };
    }
    return arms;
  } catch (err) {
    process.stderr.write(`  [learning] loadBanditArms failed: ${err.message}\n`);
    return null;
  }
}

// ── Prompt variants ────────────────────────────────────────────────────────

/**
 * Upsert one prompt-variant effectiveness row.
 */
export async function upsertPromptVariant(repoId, passName, variantName, promptHash, stats) {
  if (!await isCloudEnabled()) return;
  try {
    await upsert('prompt_variants', [{
      repo_id: repoId || null,
      pass_name: passName,
      variant_name: variantName,
      prompt_hash: promptHash,
      total_uses: stats.totalUses || 1,
      avg_acceptance_rate: stats.avgAcceptanceRate,
      avg_findings_per_use: stats.avgFindingsPerUse,
      is_active: true,
    }], { onConflict: ['pass_name', 'variant_name'], update: 'all' });
  } catch (err) {
    process.stderr.write(`  [learning] upsertPromptVariant failed: ${err.message}\n`);
  }
}

// ── False-positive patterns ────────────────────────────────────────────────

/**
 * Sync local FP-tracker patterns to cloud. Idempotent on
 * `(repo_id, pattern_type, pattern_value)`.
 *
 * @param {string|null} repoId - The repo UUID
 * @param {object} patterns - The local FP tracker patterns map
 */
export async function syncFalsePositivePatterns(repoId, patterns) {
  if (!await isCloudEnabled()) return;
  const rows = Object.entries(patterns).map(([key, p]) => ({
    repo_id: repoId || null,
    pattern_type: 'category',
    pattern_value: key,
    dismissal_count: p.dismissed,
    last_dismissed_at: new Date().toISOString(),
    auto_suppress: (p.accepted + p.dismissed) >= 5 && p.ema < 0.15,
    suppress_threshold: 5,
  }));
  if (rows.length === 0) return;
  try {
    await upsert('false_positive_patterns', rows, {
      onConflict: ['repo_id', 'pattern_type', 'pattern_value'],
      update: 'all',
    });
    process.stderr.write(`  [learning] Synced ${rows.length} FP patterns to cloud\n`);
  } catch (err) {
    process.stderr.write(`  [learning] syncFalsePositivePatterns failed: ${err.message}\n`);
  }
}

/**
 * Load FP patterns from cloud with structured dimensions. Two queries —
 * the repo-specific patterns + the global-repo-id patterns — combined
 * into the legacy `{repoPatterns, globalPatterns}` shape.
 */
export async function loadFalsePositivePatterns(repoId) {
  if (!await isCloudEnabled()) return { repoPatterns: [], globalPatterns: [] };
  try {
    const columns = `category, severity, principle, repo_id, file_extension, scope, dismissed, accepted, ema, auto_suppress`;
    const [repo, global] = await Promise.all([
      many(
        `SELECT ${columns} FROM false_positive_patterns
           WHERE repo_id = $1 AND auto_suppress = true`,
        [repoId]
      ),
      many(
        `SELECT ${columns} FROM false_positive_patterns
           WHERE repo_id = $1 AND auto_suppress = true`,
        [GLOBAL_REPO_ID]
      ),
    ]);
    return { repoPatterns: repo, globalPatterns: global };
  } catch (err) {
    process.stderr.write(`  [learning] loadFalsePositivePatterns failed: ${err.message}\n`);
    return { repoPatterns: [], globalPatterns: [] };
  }
}

/**
 * Get FP patterns for a repo (active suppression-eligible only).
 */
export async function getFalsePositivePatterns(repoId) {
  if (!await isCloudEnabled()) return [];
  try {
    return await many(
      `SELECT * FROM false_positive_patterns
         WHERE repo_id = $1 AND auto_suppress = true`,
      [repoId]
    );
  } catch (err) {
    process.stderr.write(`  [learning] getFalsePositivePatterns failed: ${err.message}\n`);
    return [];
  }
}

// ── Experiments + revisions ────────────────────────────────────────────────

/**
 * Sync prompt-experiment records. Idempotent on `experiment_id`.
 */
export async function syncExperiments(experiments) {
  if (!await isCloudEnabled()) return;
  const rows = experiments.map((e) => ({
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
    total_pulls: e.totalPulls || 0,
  }));
  if (rows.length === 0) return;
  try {
    await upsert('prompt_experiments', rows, {
      onConflict: 'experiment_id',
      update: 'all',
    });
    process.stderr.write(`  [learning] Synced ${rows.length} experiments to cloud\n`);
  } catch (err) {
    process.stderr.write(`  [learning] syncExperiments failed: ${err.message}\n`);
  }
}

/**
 * Sync one promoted prompt revision to cloud. Idempotent on
 * `(pass_name, revision_id)`. Computes sha256 checksum client-side so
 * the cloud-stored row carries it.
 */
export async function syncPromptRevision(passName, revisionId, promptText) {
  if (!await isCloudEnabled()) return;
  const { createHash } = await import('node:crypto');
  const checksum = createHash('sha256').update(promptText).digest('hex');
  try {
    await upsert('prompt_revisions', [{
      pass_name: passName,
      revision_id: revisionId,
      prompt_text: promptText,
      checksum,
      promoted_at: new Date().toISOString(),
    }], { onConflict: ['pass_name', 'revision_id'], update: 'all' });
  } catch (err) {
    process.stderr.write(`  [learning] syncPromptRevision failed: ${err.message}\n`);
  }
}

// ── Pass-effectiveness analytics ───────────────────────────────────────────

/**
 * Read pass-effectiveness counters across all of a repo's audit_runs.
 * Two-step in the legacy path; collapsed into a single JOIN here since
 * the new SQL helpers are designed for it.
 */
export async function getPassEffectiveness(repoId) {
  if (!await isCloudEnabled()) return [];
  try {
    return await many(
      `SELECT ps.pass_name,
              ps.findings_raised,
              ps.findings_accepted,
              ps.findings_dismissed
         FROM audit_pass_stats ps
         JOIN audit_runs r ON r.id = ps.run_id
        WHERE r.repo_id = $1`,
      [repoId]
    );
  } catch (err) {
    process.stderr.write(`  [learning] getPassEffectiveness failed: ${err.message}\n`);
    return [];
  }
}

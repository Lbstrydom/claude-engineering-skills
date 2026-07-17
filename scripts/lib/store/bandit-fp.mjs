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
import { GLOBAL_REPO_ID, UNKNOWN_FILE_EXT } from '../config.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
 * Columns loadFalsePositivePatterns selects — exposed (as a function; the
 * learning-store barrel is pinned functions-only) so the schema-guard test
 * can assert every one is actually declared by a migration (the reader
 * silently returned empty for months because it selected columns that never
 * existed; the error was swallowed by the catch below).
 */
const FP_PATTERN_READ_COLUMNS = [
  'category', 'severity', 'principle', 'repo_id', 'file_extension', 'scope',
  'dismissed', 'accepted', 'ema', 'decayed_accepted', 'decayed_dismissed',
  'auto_suppress',
];

export function fpPatternReadColumns() {
  return [...FP_PATTERN_READ_COLUMNS];
}

/**
 * Build the cloud rows for an FP-pattern sync — PURE FUNCTION, exported for
 * tests. `repo_id` is NEVER null: a missing/invalid repoId (e.g. a repo
 * *fingerprint* hash instead of the audit_repos UUID) falls back to the
 * GLOBAL sentinel. An explicit NULL defeated the table's ON CONFLICT
 * (repo_id, ...) dedup — Postgres unique constraints treat NULLs as
 * distinct — so every audit run re-inserted the whole tracker as new rows
 * (the 2026-07-17 Disk IO Budget incident: 403k garbage rows in 3 days).
 *
 * @param {string|null} repoId - The audit_repos row UUID (not a fingerprint)
 * @param {object} patterns - FP tracker patterns map (pattern-key → counters)
 * @returns {object[]} Rows for the false_positive_patterns upsert
 */
export function buildFpPatternRows(repoId, patterns) {
  const repoUuid = typeof repoId === 'string' && UUID_RE.test(repoId) ? repoId : GLOBAL_REPO_ID;
  const now = new Date().toISOString();
  return Object.entries(patterns).map(([key, p]) => {
    // Legacy single-key patterns carry no structured fields; the key itself
    // is `category::SEVERITY::principle` (same backfill 20260403083803 used).
    const [keyCategory, keySeverity, keyPrinciple] = key.split('::');
    const accepted = p.accepted || 0;
    const dismissed = p.dismissed || 0;
    const ema = p.ema ?? 0.5;
    return {
      repo_id: repoUuid,
      pattern_type: 'category',
      pattern_value: key,
      category: p.category ?? keyCategory ?? '',
      severity: p.severity ?? keySeverity ?? 'UNKNOWN',
      principle: p.principle ?? keyPrinciple ?? 'unknown',
      file_extension: p.fileExtension || UNKNOWN_FILE_EXT,
      scope: p.scope || 'global',
      dismissed,
      accepted,
      ema,
      decayed_accepted: p.decayedAccepted || 0,
      decayed_dismissed: p.decayedDismissed || 0,
      dismissal_count: dismissed,
      last_dismissed_at: now,
      auto_suppress: (accepted + dismissed) >= 5 && ema < 0.15,
      suppress_threshold: 5,
    };
  });
}

/**
 * Sync local FP-tracker patterns to cloud. Idempotent on
 * `(repo_id, pattern_type, pattern_value)`; repo_id falls back to the
 * GLOBAL sentinel, never null (see buildFpPatternRows). Call sites should
 * pass `fpTracker.dirtyPatterns()` — only the patterns touched this run —
 * not the whole map, so a sync doesn't rewrite thousands of unchanged rows.
 *
 * @param {string|null} repoId - The audit_repos row UUID
 * @param {object} patterns - The local FP tracker patterns map (dirty subset)
 */
export async function syncFalsePositivePatterns(repoId, patterns) {
  if (!await isCloudEnabled()) return;
  const rows = buildFpPatternRows(repoId, patterns);
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
    const columns = FP_PATTERN_READ_COLUMNS.join(', ');
    // A non-UUID repoId (null, or a repo fingerprint hash) would fail the
    // uuid cast and take the global read down with it — skip the repo query.
    const repoQueryable = typeof repoId === 'string' && UUID_RE.test(repoId);
    const [repo, global] = await Promise.all([
      repoQueryable
        ? many(
            `SELECT ${columns} FROM false_positive_patterns
               WHERE repo_id = $1 AND auto_suppress = true`,
            [repoId]
          )
        : Promise.resolve([]),
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

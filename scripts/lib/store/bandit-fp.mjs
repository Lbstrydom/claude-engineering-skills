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
import { GLOBAL_REPO_ID, GLOBAL_CONTEXT_BUCKET, UNKNOWN_FILE_EXT, learningConfig, clampFpReadLimit } from '../config.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Bandit arms ────────────────────────────────────────────────────────────

/**
 * Build the cloud rows for a bandit-arm sync — PURE FUNCTION, exported for
 * tests. `context_bucket` is NEVER null: a missing/empty bucket falls back to
 * the `GLOBAL_CONTEXT_BUCKET` sentinel.
 *
 * The old `arm.contextBucket || null` **contradicted its own ON CONFLICT
 * target**: `syncBanditArms` upserts on `(pass_name, variant_id,
 * context_bucket)`, and Postgres treats NULLs as DISTINCT in a unique
 * constraint — so a null-bucket row could never match its own conflict target
 * and every sync would INSERT a duplicate instead of updating. That is the
 * exact defect that produced 403k garbage rows in `false_positive_patterns`
 * (fixed by 718ca90 + migration 20260717120000); nobody checked this table.
 *
 * It never fired only because `PromptBandit` normalizes twice upstream
 * (`bandit.mjs:66` legacy-arm load, `bandit.mjs:78` addArm), so `|| null` was
 * unreachable defensive code — one refactor away from a 403k-row incident.
 * Extracted as a pure function so "the bucket can never be null" is assertable
 * DB-free (INC-002 forbids a live DSN in tests), mirroring `buildFpPatternRows`.
 *
 * @param {object} arms - The bandit arms map from PromptBandit
 * @returns {object[]} Rows for the bandit_arms upsert
 */
export function buildBanditArmRows(arms) {
  const now = new Date().toISOString();
  return Object.values(arms || {}).map((arm) => ({
    pass_name: arm.passName,
    variant_id: arm.variantId,
    alpha: arm.alpha,
    beta: arm.beta,
    pulls: arm.pulls,
    // NEVER null — see above. The sentinel is the same constant addArm writes.
    context_bucket: arm.contextBucket || GLOBAL_CONTEXT_BUCKET,
    updated_at: now,
  }));
}

/**
 * Sync local bandit-arm state to cloud. Idempotent on
 * `(pass_name, variant_id, context_bucket)` — genuinely so since the row
 * builder can no longer emit a null conflict-key column.
 *
 * @param {object} arms - The bandit arms map from PromptBandit
 */
export async function syncBanditArms(arms) {
  if (!await isCloudEnabled()) return;
  const rows = buildBanditArmRows(arms);
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
      // The SAME constant the writer uses — reader and writer must agree on the
      // sentinel or a rename silently fragments arm identity across the seam.
      const bucket = row.context_bucket || GLOBAL_CONTEXT_BUCKET;
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
  // The decay anchor. Sound because syncFalsePositivePatterns only ever writes
  // dirtyPatterns() — patterns record()-ed in that same process, whose
  // lastDecayTs was set moments earlier — so the gap between the true anchor
  // and this column is one audit run (minutes) against a half-life of weeks.
  // Without it a row whose writer stops syncing keeps its ESS forever and can
  // suppress indefinitely.
  'last_dismissed_at',
];

export function fpPatternReadColumns() {
  return [...FP_PATTERN_READ_COLUMNS];
}

/**
 * Build one scope's FP-pattern read query — PURE FUNCTION, exported so the
 * query SHAPE is assertable DB-free (there is no live-DB tier here; see
 * INC-002 — a test DSN must never be able to point at production).
 *
 * The repo/global asymmetry is load-bearing, not an oversight:
 *
 *   - **repo scope carries NO `auto_suppress` predicate.** The hierarchy in
 *     `shouldSuppressFinding` relies on a sufficiently-evidenced repo pattern
 *     with `ema >= 0.15` returning "don't suppress" and STOPPING the walk,
 *     which blocks a matching global pattern. But `auto_suppress` is written as
 *     `(accepted + dismissed) >= 5 && ema < 0.15`, so every such blocker has
 *     `auto_suppress = false` — filtering on it silently deletes exactly the
 *     rows the decision depends on, and a finding matching a repo blocker AND a
 *     global suppressor would be wrongly suppressed.
 *   - **global scope keeps the predicate.** Global is the LAST scope: an unread
 *     global pattern makes `find` return undefined → loop ends → no suppression;
 *     a global blocker returns "don't suppress" → no suppression. Identical
 *     outcome, so the predicate cannot change a decision there.
 *
 * Fetches `limit + 1` so `atLimit` reflects real truncation rather than an
 * exactly-full page (a full page is not necessarily a truncated one).
 *
 * @param {string} repoId - a validated UUID (or the GLOBAL sentinel)
 * @param {number} limit - already clamped by the caller
 * @param {boolean} onlyAutoSuppress - true for the global scope only
 * @returns {{sql: string, params: unknown[]}}
 */
export function buildFpReadQuery(repoId, limit, onlyAutoSuppress) {
  const columns = FP_PATTERN_READ_COLUMNS.join(', ');
  const predicate = onlyAutoSuppress
    ? 'repo_id = $1 AND auto_suppress = true'
    : 'repo_id = $1';
  return {
    sql: `SELECT ${columns} FROM false_positive_patterns
           WHERE ${predicate}
           ORDER BY decayed_dismissed DESC, pattern_value ASC
           LIMIT $2`,
    params: [repoId, limit + 1],
  };
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
      // Threshold comes from learningConfig, NOT a literal: the global-scope
      // read filters on auto_suppress, so a writer flagging at a different
      // threshold than the reader's ESS gate silently hides rows from it (with
      // MIN_FP_SAMPLES=3 the reader would accept ESS>=3 while the writer never
      // flagged anything below raw 5). Single source of truth for the sample
      // floor — the two must not drift.
      auto_suppress: (accepted + dismissed) >= learningConfig.minFpSamples && ema < 0.15,
      suppress_threshold: learningConfig.minFpSamples,
    };
  });
}

/**
 * May this repo identity be synced under? — PURE PREDICATE.
 *
 * buildFpPatternRows' GLOBAL sentinel fallback guarantees a non-null repo_id —
 * that is the 2026-07-17 ON CONFLICT fix (an explicit NULL defeated the unique
 * constraint and produced 403k rows) and it stays, as a defensive last resort.
 * But the sentinel MEANS "deliberate cross-repo pattern", and an unresolved repo
 * is not that: syncing under it would launder repo-private patterns into the
 * cross-repo bucket.
 *
 * Only consequential since the cloud read loop landed — before it, nothing read
 * the GLOBAL bucket and the mislabelling was inert. The reader makes it live, so
 * the write side must honour the contract the reader depends on.
 *
 * @param {unknown} repoId
 * @returns {boolean} true only for a real audit_repos row UUID
 */
export function isSyncableRepoId(repoId) {
  return typeof repoId === 'string' && UUID_RE.test(repoId);
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
  // Identity guard runs FIRST — before any cloud work. Ordering is deliberate:
  //   * defence in depth — the refusal cannot depend on cloud state, so no
  //     future reordering of the cloud check can re-open the contamination path;
  //   * testability — with the guard below `isCloudEnabled()` (which opens a
  //     pool) the fingerprint path is unreachable in a DB-free suite, so only
  //     the predicate could be tested and never its WIRING. Proving the seam
  //     without proving the composition is the gap that ships bugs.
  // `null` stays silent: that is the ordinary cloud-off / unresolved-repo case,
  // already surfaced by the orchestrator's `[cloud-fp] repo unresolved` line.
  // A non-null non-UUID is a genuine mislabel attempt and is always logged.
  if (!isSyncableRepoId(repoId)) {
    if (repoId != null) {
      process.stderr.write(
        `  [learning] syncFalsePositivePatterns: skipped — repo identity unresolved ` +
        `(would mislabel ${Object.keys(patterns || {}).length} repo-scoped patterns as cross-repo GLOBAL)\n`
      );
    }
    return;
  }
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
 * Run one scope's read, converting any failure into an explicit status rather
 * than an empty array. Never throws.
 */
async function readFpScope(repoId, limit, onlyAutoSuppress) {
  const { sql, params } = buildFpReadQuery(repoId, limit, onlyAutoSuppress);
  try {
    const rows = await many(sql, params);
    const atLimit = rows.length > limit;
    return {
      status: 'ok',
      patterns: atLimit ? rows.slice(0, limit) : rows,
      atLimit,
    };
  } catch (err) {
    // errorName only — err.message can carry a DSN fragment.
    return { status: 'failed', patterns: [], atLimit: false, errorName: err.name };
  }
}

/**
 * Load FP patterns from cloud with structured dimensions — returns a per-scope
 * STATUS ENVELOPE, not bare arrays.
 *
 * An empty array cannot carry the difference between "this scope has no
 * patterns" and "this scope's read failed", and that difference is a DECISION
 * input, not telemetry: under the narrow-overrides-broad hierarchy, an
 * unavailable repo scope must not license global suppression (the absence of a
 * repo pattern would be read as "no narrow override exists"). The previous
 * shape swallowed query errors into `{repoPatterns: [], globalPatterns: []}`,
 * so a broken reader was indistinguishable from a healthy thin-data one.
 *
 * Still fail-open: never throws, never blocks an audit. The two scopes are
 * independent queries and can fail independently.
 *
 * @param {string|null} repoId - the audit_repos row UUID
 * @param {object} [opts]
 * @param {number} [opts.limit] - per-scope cap; clamped here, so an explicit
 *   caller-supplied value cannot bypass the bound (config is not the only path)
 * @returns {Promise<{repo: object, global: object}>}
 */
export async function loadFalsePositivePatterns(repoId, { limit } = {}) {
  const effectiveLimit = clampFpReadLimit(limit ?? learningConfig.fpReadLimit);
  if (!await isCloudEnabled()) {
    return {
      repo: { status: 'skipped', patterns: [], atLimit: false, reason: 'cloud-disabled' },
      global: { status: 'skipped', patterns: [], atLimit: false, reason: 'cloud-disabled' },
    };
  }
  // A non-UUID repoId (null, or a repo fingerprint hash) would fail the uuid
  // cast and take the global read down with it — skip the repo query. This is
  // 'skipped', not 'ok': the repo override set was never queried, and treating
  // "not asked" as "asked, empty" is the same absence-as-evidence bug.
  const repoQueryable = typeof repoId === 'string' && UUID_RE.test(repoId);
  const [repo, global] = await Promise.all([
    repoQueryable
      ? readFpScope(repoId, effectiveLimit, false)   // NO auto_suppress filter — blockers are decision data
      : Promise.resolve({
          status: 'skipped', patterns: [], atLimit: false, reason: 'non-uuid-repo-id',
        }),
    readFpScope(GLOBAL_REPO_ID, effectiveLimit, true), // predicate safe here — global is the last scope
  ]);
  if (repo.status === 'failed' || global.status === 'failed') {
    process.stderr.write(
      `  [learning] loadFalsePositivePatterns: repo=${repo.status} global=${global.status}\n`
    );
  }
  return { repo, global };
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

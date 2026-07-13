/**
 * @fileoverview Resolves which model answers Stage 1's cheap-triager
 * question — the piece Phase 7 documented but never built: reading Cluster
 * C's validated `cheap-triager-validation.json` manifest and selecting its
 * `candidateModel` as the Stage 1 triager, instead of always defaulting to
 * GPT-5.5.
 *
 * Precedence (operator override wins, matching this repo's established
 * `OSS_CODER_MODEL`/`OSS_REASONER_MODEL` env-override pattern):
 *   1. `tieredAuditConfig.stage1Model` (from `AUDIT_STAGE1_MODEL`) — explicit
 *      operator pin, always wins when set.
 *   2. A schema-valid, `passed:true` `cheap-triager-validation.json` —
 *      its `candidateModel` becomes the Stage 1 triager.
 *   3. Neither — `model: null`; the caller falls back to the GPT-5.5 default
 *      triager adapter (the plan's own documented safe default), with a
 *      loud, named reason for why.
 *
 * **Scoping note on "freshness" (a deliberate narrowing, not silently
 * dropped)**: the plan's Phase 5 text describes re-verifying `datasetHash`
 * against the historical validation session's raw CSVs
 * (`.audit-loop/solo-control/blind-adjudication-*.csv` + `.blind-map.json`)
 * at Phase-7 read time. Those files are source-repo-only research tooling
 * (never consumer-synced, per `cheap-triager-validate.mjs`'s own header) —
 * unavailable at production audit-run time in any consumer repo, and
 * re-hashing them on every audit run would mean shipping the entire
 * validation corpus everywhere `/audit-code` runs, wildly out of proportion
 * to what it buys. `cmdManifest` already verified that exact freshness
 * ONCE, at generation time, before committing `passed:true` — this resolver
 * instead trusts a schema-valid, committed manifest, the same trust model
 * this repo already applies to `known-defects.json` (a hand-curated,
 * non-regenerated decision record — see AGENTS.md's generated-artifact
 * policy). `datasetHash` is still read and returned for operator-visible
 * provenance/citation, just never re-derived from source here.
 *
 * Plan: docs/plans/tiered-recall-audit-pipeline.md Phase 7 (validation-manifest wiring).
 *
 * @module scripts/lib/audit/stage1-triager-resolver
 */

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

export const DEFAULT_VALIDATION_MANIFEST_PATH = path.join('docs', 'experiments', 'audit-effectiveness', 'cheap-triager-validation.json');

// .strict() per this repo's established route-catalog.mjs/contracts.mjs
// convention — a malformed/hand-edited manifest is rejected outright, never
// silently stripped down to the fields this schema happens to check.
export const ValidationManifestSchema = z.object({
  datasetHash: z.string().min(1),
  candidateModel: z.string().min(1),
  strata: z.array(z.object({
    name: z.string().min(1),
    count: z.number().int().nonnegative(),
    falseDismissalRate: z.number().min(0).max(1),
    ci95: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]),
  })).min(1),
  thresholds: z.object({
    highOrOmissionMaxFalseDismissalRate: z.number().min(0).max(1),
    overallMaxFalseDismissalRate: z.number().min(0).max(1),
  }),
  passed: z.boolean(),
  generatedAt: z.string().min(1),
}).strict();

/**
 * Load + schema-validate the Phase-5 validation manifest. Never throws — a
 * missing/malformed manifest is an expected, safely-handled state (the
 * caller falls back to GPT-5.5), not a fatal error.
 *
 * @param {string} [manifestPath]
 * @param {typeof import('node:fs')} [fsMod] - injectable for tests
 * @returns {{ok: true, manifest: object} | {ok: false, reason: 'manifest_not_found'|'manifest_invalid_json'|'manifest_schema_invalid', detail?: string}}
 */
export function loadValidationManifest(manifestPath = DEFAULT_VALIDATION_MANIFEST_PATH, fsMod = fs) {
  let raw;
  try {
    raw = fsMod.readFileSync(manifestPath, 'utf8');
  } catch (err) {
    return { ok: false, reason: 'manifest_not_found', detail: err.message };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: 'manifest_invalid_json', detail: err.message };
  }
  const result = ValidationManifestSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, reason: 'manifest_schema_invalid', detail: result.error.issues.map((i) => i.message).join('; ') };
  }
  return { ok: true, manifest: result.data };
}

/**
 * Resolve the Stage 1 triager model per the precedence documented above.
 *
 * @param {{configuredModel?: string|null, manifestPath?: string, fsMod?: typeof import('node:fs')}} [args]
 * @returns {{model: string|null, source: 'operator-override'|'validated-manifest'|'fallback', reason?: string, datasetHash?: string}}
 */
export function resolveStage1TriagerModel({ configuredModel = null, manifestPath = DEFAULT_VALIDATION_MANIFEST_PATH, fsMod = fs } = {}) {
  if (configuredModel) {
    return { model: configuredModel, source: 'operator-override' };
  }
  const loaded = loadValidationManifest(manifestPath, fsMod);
  if (!loaded.ok) {
    return { model: null, source: 'fallback', reason: loaded.reason };
  }
  if (loaded.manifest.passed !== true) {
    return { model: null, source: 'fallback', reason: 'manifest_failed' };
  }
  return { model: loaded.manifest.candidateModel, source: 'validated-manifest', datasetHash: loaded.manifest.datasetHash };
}

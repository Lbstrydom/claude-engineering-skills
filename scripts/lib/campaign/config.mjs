/**
 * @fileoverview Campaign config — parse, validate (structurally AND
 * semantically), and content-digest the collection-relevant subset.
 *
 * Plan: docs/plans/model-comparison-campaigns.md §2.5a (schema + semantic
 * rules), §2.5b (`configDigest` scope).
 *
 * Two properties this module exists to enforce, both from measured lessons:
 *
 *  - **Strict, closed validation.** A typo'd `reasoningEfort` must fail loudly
 *    rather than silently run at a provider default dial — an unpinned control
 *    is how a comparison becomes uninterpretable after the spend.
 *  - **`configDigest` covers the collection-relevant SUBSET only.** It hashes
 *    `{role, decision, arms, controls}` — what was ASKED of the models — and
 *    deliberately excludes `targetN`, `calibration` and the whole
 *    `decisionRule`. Those are analysis-time: they change how already-collected
 *    evidence is READ, never what it means. A whole-file digest would orphan
 *    every snapshot ever collected the moment someone edited a cost ceiling.
 *
 * @module scripts/lib/campaign/config
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';

/** Campaign and arm ids become path components (`.audit/campaigns/<id>/…`), so
 * they are pattern-constrained at the schema boundary. Defence-in-depth, not
 * the only guard — every derived path is additionally resolved and asserted
 * repo-root-contained before any write (INC-001's lesson, one layer out). */
export const CAMPAIGN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const ARM_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** §6.3 row 1. Not re-derived here — a campaign below this cannot support a
 * verdict, and `verdict.mjs` emits INCONCLUSIVE under it regardless of config. */
export const MIN_TARGET_N = 12;

const ArmSchema = z.object({
  id: z.string().regex(ARM_ID_PATTERN, 'arm id must match ^[a-z0-9][a-z0-9-]*$ — it is a receipt filename component'),
  model: z.string().min(1),
  mode: z.enum(['shadow', 'primary']),
  type: z.literal('replicate').optional(),
}).strict();

const ControlsSchema = z.object({
  reasoningEffort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']),
  promptTemplateId: z.string().min(1),
  outputSchemaId: z.string().min(1),
  maxOutputTokens: z.number().int().positive(),
  toolPolicy: z.string().min(1),
  temperature: z.number().finite().min(0),
}).strict();

const AdjudicatorSchema = z.object({
  model: z.string().min(1),
  promptTemplateId: z.string().min(1),
  outputSchemaId: z.string().min(1),
}).strict();

const DecisionRuleSchema = z.object({
  floorMetric: z.string().min(1),
  // A negative margin would let a strictly worse arm clear the floor.
  floorMargin: z.number().finite().min(0),
  tiebreak: z.string().min(1),
  costCeilingUsdPerAccepted: z.number().finite().positive(),
}).strict();

export const CampaignConfigSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(CAMPAIGN_ID_PATTERN, 'campaign id must match ^[a-z0-9][a-z0-9-]{0,63}$ — it is interpolated into lock and receipt paths'),
  // D7: v1 generalises role 3 only, so the enum has exactly ONE value. An open
  // string let a typo'd or invented role parse into a campaign that collects
  // happily under a role nothing dispatches on — the seam exists to be widened
  // deliberately, not to be widened by accident.
  role: z.enum(['final_review_shadow']),
  decision: z.object({
    type: z.literal('select_default'),
    incumbent: z.string().min(1),
  }).strict(),
  arms: z.array(ArmSchema).min(1),
  controls: ControlsSchema,
  adjudicator: AdjudicatorSchema,
  calibration: z.object({
    sampleRate: z.number().finite().min(0.1).max(1.0),
  }).strict(),
  targetN: z.number().int().min(MIN_TARGET_N, `targetN must be >= ${MIN_TARGET_N} — below it a campaign cannot support a verdict`),
  decisionRule: DecisionRuleSchema,
}).strict().superRefine(semanticRules);

/**
 * The rules that structural strictness cannot express. Each one describes a
 * config that PARSES and produces a meaningless campaign — §2.5a's table.
 */
function semanticRules(cfg, ctx) {
  const issue = (message, cursor) => ctx.addIssue({ code: z.ZodIssueCode.custom, message, ...(cursor ? { path: cursor } : {}) });

  const seen = new Set();
  for (const [i, arm] of cfg.arms.entries()) {
    if (seen.has(arm.id)) issue(`duplicate arm id "${arm.id}" — arm id identifies a receipt and a store row`, ['arms', i, 'id']);
    seen.add(arm.id);
  }

  const nonReplicates = cfg.arms.filter((a) => a.type !== 'replicate');
  const replicates = cfg.arms.filter((a) => a.type === 'replicate');

  // One arm is not a comparison.
  if (nonReplicates.length < 2) {
    issue(`a campaign needs >= 2 non-replicate arms (got ${nonReplicates.length}) — one arm is not a comparison`, ['arms']);
  }

  // The shadow protocol has exactly one primary.
  const primaries = cfg.arms.filter((a) => a.mode === 'primary');
  if (primaries.length > 1) {
    issue(`at most one arm may be mode:"primary" (got ${primaries.length}: ${primaries.map((a) => a.id).join(', ')})`, ['arms']);
  }

  // A "replicate" of nothing is a mislabelled scenario. Controls are
  // campaign-level, so every arm shares them by construction and the test
  // reduces to the model — if per-arm control overrides are ever added, this
  // must widen to compare them too.
  const nonReplicateModels = new Set(nonReplicates.map((a) => a.model));
  for (const [i, arm] of cfg.arms.entries()) {
    if (arm.type === 'replicate' && !nonReplicateModels.has(arm.model)) {
      issue(`replicate arm "${arm.id}" names model "${arm.model}", which no non-replicate arm uses — a replicate of nothing is a mislabelled scenario`, ['arms', i, 'model']);
    }
  }

  // The incumbent must be a real, comparable participant.
  const incumbentArms = nonReplicates.filter((a) => a.model === cfg.decision.incumbent);
  if (incumbentArms.length === 0) {
    issue(`decision.incumbent "${cfg.decision.incumbent}" names no non-replicate arm's model (available: ${[...nonReplicateModels].join(', ') || 'none'})`, ['decision', 'incumbent']);
  } else if (incumbentArms.length > 1) {
    issue(`decision.incumbent "${cfg.decision.incumbent}" matches ${incumbentArms.length} non-replicate arms (${incumbentArms.map((a) => a.id).join(', ')}) — the incumbent must be unambiguous`, ['decision', 'incumbent']);
  }

  // Unused here, referenced by the digest below — keep them in one place so a
  // future field addition has an obvious home.
  void replicates;
}

/**
 * Deterministic JSON for hashing: keys sorted at every depth, arrays kept in
 * order (arm order is not semantic, but reordering arms IS a config edit a
 * reviewer should see, so it is not normalised away), and numbers rendered at
 * fixed precision.
 *
 * Fixed order and fixed precision for the same reason `cohortDigest` uses them
 * (`bakeoff-collect.mjs`): `JSON.stringify` of an object literal is
 * insertion-ordered and a float can render differently across producers, and
 * either would split one cohort into two, silently shrinking the aggregate.
 * Not reusing `cohortDigest` itself — that is a fixed four-field literal for
 * the matcher config, not a general structural canonicaliser.
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new Error(`canonicalJson: refusing to digest a non-finite number (${value}) — it would serialize as null and silently change identity`);
      return JSON.stringify(Number(value.toFixed(6)));
    }
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

/**
 * Digest over the COLLECTION-RELEVANT subset — the fields that determine what
 * was asked of the models. See the module header for why `targetN`,
 * `calibration` and `decisionRule` are deliberately excluded: they are
 * analysis-time, and hashing them would orphan collected evidence on a cost-
 * ceiling edit. Pre-registration is protected instead by `campaign_events`
 * (`rule_changed`) plus the standings watermark, which records that the
 * goalposts moved without destroying the data.
 */
export function configDigest(cfg) {
  const subset = { role: cfg.role, decision: cfg.decision, arms: cfg.arms, controls: cfg.controls };
  return crypto.createHash('sha256').update(canonicalJson(subset)).digest('hex').slice(0, 16);
}

/** Fields deliberately outside every digest — exported so the dashboard can
 * name the analysis-time values it applied rather than leaving a reader to
 * guess which rule produced a verdict. */
export const ANALYSIS_TIME_FIELDS = Object.freeze(['targetN', 'calibration', 'decisionRule']);

/**
 * Parse + validate one campaign config from an object.
 * @returns {{config: object, configDigest: string}}
 * @throws {z.ZodError} with every structural and semantic violation at once
 */
export function parseCampaignConfig(raw) {
  const config = CampaignConfigSchema.parse(raw);
  return { config, configDigest: configDigest(config) };
}

/** Campaign configs live here, committed and consumer-owned. */
export const CAMPAIGNS_DIR = '.campaigns';

/**
 * Enumerate campaign configs. Selection semantics are §807's, and the two
 * refusals are the point: an absent directory is NOT an error (a repo may
 * never run campaigns), while ambiguity is never resolved by picking the first.
 *
 * @param {{dir?: string, campaignId?: string|null}} [opts]
 * @returns {{ok: true, config: object, configDigest: string, filePath: string}
 *          |{ok: false, code: 'none'|'ambiguous'|'unknown-id', message: string, available: string[]}}
 */
export function selectCampaignConfig({ dir = CAMPAIGNS_DIR, campaignId = null } = {}) {
  if (!fs.existsSync(dir)) {
    return { ok: false, code: 'none', message: `no ${dir}/ directory — this repo has not adopted campaigns`, available: [] };
  }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  if (files.length === 0) {
    return { ok: false, code: 'none', message: `no campaign configs in ${dir}/`, available: [] };
  }

  const loaded = files.map((f) => {
    const filePath = path.join(dir, f);
    const { config, configDigest: digest } = parseCampaignConfig(JSON.parse(fs.readFileSync(filePath, 'utf-8')));
    return { config, configDigest: digest, filePath };
  });
  const available = loaded.map((l) => l.config.id).sort();

  if (campaignId != null) {
    const hit = loaded.find((l) => l.config.id === campaignId);
    if (!hit) {
      return { ok: false, code: 'unknown-id', message: `unknown campaign "${campaignId}" — available: ${available.join(', ')}`, available };
    }
    return { ok: true, ...hit };
  }

  if (loaded.length > 1) {
    // Never "pick the first": which campaign ran is not a detail a spend-
    // bearing runner may decide on the operator's behalf.
    return { ok: false, code: 'ambiguous', message: `${loaded.length} campaigns found; pass --campaign <id>. Available: ${available.join(', ')}`, available };
  }
  return { ok: true, ...loaded[0] };
}

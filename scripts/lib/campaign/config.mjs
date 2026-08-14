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
import { z } from 'zod';
import { isXaiModel } from '../model-resolver.mjs';
import { assertEligibleSubset } from '../comparison/roles.mjs';
// Arm identity, the scored-arm oracle and the lock digest are role-agnostic and
// live in comparison/. Re-exported below so every existing importer of this
// module is unchanged — the extraction must be invisible to callers, and the
// digest must stay byte-identical (asserted in tests/comparison-core.test.mjs).
import { ArmSchema as CoreArmSchema, ARM_ID_PATTERN, isScoredArm, checkArmSetSemantics } from '../comparison/arms.mjs';
import { canonicalJson, configDigest, ANALYSIS_TIME_FIELDS } from '../comparison/lock.mjs';

/**
 * The roles the PASSIVE campaign collector accepts — a subset of the shared
 * vocabulary, never the vocabulary itself.
 *
 * It stays at one value on purpose. A role earns a campaign only when it also
 * earns a passive shadow, and AGENTS.md (2026-07-26) caps that population:
 * "only intervention-over-organic-work earns a shadow; exactly two are open …
 * do NOT add a sixth collector." Widening this array is therefore a decision
 * about collection mode, not a naming change.
 */
export const CAMPAIGN_ELIGIBLE_ROLES = Object.freeze(
  assertEligibleSubset(['final_review_shadow'], 'CAMPAIGN_ELIGIBLE_ROLES'),
);

/** Campaign and arm ids become path components (`.audit/campaigns/<id>/…`), so
 * they are pattern-constrained at the schema boundary. Defence-in-depth, not
 * the only guard — every derived path is additionally resolved and asserted
 * repo-root-contained before any write (INC-001's lesson, one layer out). */
export const CAMPAIGN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export { ARM_ID_PATTERN };

/** §6.3 row 1. Not re-derived here — a campaign below this cannot support a
 * verdict, and `verdict.mjs` emits INCONCLUSIVE under it regardless of config. */
export const MIN_TARGET_N = 12;

// ArmSchema + ARM_ID_PATTERN now live in comparison/arms.mjs (role-agnostic).
// Genuinely RE-EXPORTED, not just aliased: the first version of this line was
// `const ArmSchema = CoreArmSchema;` with a comment claiming a re-export, so
// any importer of `{ ArmSchema }` from this module would have got `undefined`
// while the comment said otherwise.
const ArmSchema = CoreArmSchema;
export { ArmSchema };

export { isScoredArm };

/**
 * The pre-flight ATTESTATION a campaign manifest cites when it declares an
 * xAI arm (plan: final-review-scoped-second-reviewer.md §8, Phase 6). Lives
 * inside `controls` — not at the manifest top level, where an earlier draft
 * inconsistently placed it — so `configDigest` covers it, making the
 * attestation part of what a re-collection must match.
 *
 * `model` is checked against the declaring arm's model STRING (semanticRules
 * below), never a live-resolved id — the schema validates a static file and
 * must not need network access or become non-deterministic when a catalog
 * moves (this is WHY the campaign manifest pins a concrete xAI model rather
 * than the `latest-grok` sentinel; see KD-4).
 */
const PreflightSchema = z.object({
  artifact: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/i, 'sha256 must be a 64-hex-char digest'),
  model: z.string().min(1),
  disposition: z.enum(['pass', 'fail', 'inconclusive']),
}).strict();

const ControlsSchema = z.object({
  reasoningEffort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']),
  promptTemplateId: z.string().min(1),
  outputSchemaId: z.string().min(1),
  maxOutputTokens: z.number().int().positive(),
  toolPolicy: z.string().min(1),
  temperature: z.number().finite().min(0),
  // Plan KD-6: which final-review envelope every arm's shadow reviewer
  // receives. Lives here (inside `controls`, therefore inside `configDigest`)
  // so scope is SIGNED cohort state, not ambient env — a mismatched snapshot
  // is structurally ineligible rather than merely discouraged.
  envelopeScope: z.enum(['full', 'thin', 'gap']),
  // Required only when an arm's model is on the xAI route — enforced below,
  // not here, because "required" is conditional on `arms`, which this schema
  // cannot see field-locally.
  preflight: PreflightSchema.optional(),
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
  // D7: v1 generalises role 3 only, so this mechanism's ELIGIBILITY set has
  // exactly ONE value. An open string let a typo'd or invented role parse into
  // a campaign that collects happily under a role nothing dispatches on — the
  // seam exists to be widened deliberately, not to be widened by accident.
  //
  // Validated against CAMPAIGN_ELIGIBLE_ROLES, NOT against the shared `ROLES`
  // vocabulary (2026-08-14). That distinction is load-bearing: `ROLES` contains
  // `auditor`, and validating against it would let an auditor manifest into the
  // PASSIVE collector — the sixth collector AGENTS.md forbids by name. The
  // vocabulary says which role names exist; this says which ones THIS mechanism
  // runs.
  role: z.enum(CAMPAIGN_ELIGIBLE_ROLES),
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

  // The arm-set rules are SHARED with the comparison manifest via the single
  // oracle in comparison/arms.mjs — unique ids, >=2 scored arms, at most one
  // primary, replicate backing, incumbent uniqueness. They lived here and in
  // manifest.mjs independently until 2026-08-14; two copies of one contract is
  // exactly how the  arm type reached one and not the other.
  checkArmSetSemantics(cfg, issue);


  // `gap` is campaign-INELIGIBLE (plan KD-5). A gap shadow is conditioned on
  // its OWN arm's stochastic primary result, so two gap arms are answering
  // different questions — the confound is structural, not a data-quality
  // issue a bigger N would fix. `gap` ships as an operator-selectable flag
  // only; it must never appear inside a signed, N-tracked cohort.
  if (cfg.controls.envelopeScope === 'gap') {
    issue(
      'controls.envelopeScope "gap" is campaign-ineligible (plan KD-5) — a gap '
      + 'shadow is conditioned on its own arm\'s primary result, so gap arms are '
      + 'not comparable to each other; use "thin" for a campaign cohort',
      ['controls', 'envelopeScope'],
    );
  }

  // xAI-arm conditional pre-flight requirement (plan KD-2's correction, §8,
  // Phase 6). A manifest declaring ANY arm on the xAI route must carry a
  // PASSING attestation naming that exact model — schema-enforced so it
  // cannot be forgotten, never a runtime-only check a manifest could bypass.
  // Keyed on `isXaiModel`, the SAME predicate `transportForModel` uses
  // (model-resolver.mjs) — one oracle, so the two can never diverge on what
  // counts as "an xAI arm".
  const xaiArms = cfg.arms.filter((a) => isXaiModel(a.model));
  if (xaiArms.length > 0) {
    const distinctModels = new Set(xaiArms.map((a) => a.model));
    if (distinctModels.size > 1) {
      // v1 supports exactly one xAI model per campaign: one pre-flight
      // artifact attests to one model, and there is no mechanism here for
      // "attest to N models" — a real future need, not a corner to cut today.
      issue(
        `multiple distinct xAI models declared (${[...distinctModels].join(', ')}) — `
        + 'one preflight artifact cannot attest to more than one model; v1 supports '
        + 'exactly one xAI model per campaign',
        ['arms'],
      );
    } else if (!cfg.controls.preflight) {
      issue(
        `arm(s) ${xaiArms.map((a) => a.id).join(', ')} declare an xAI model `
        + `("${xaiArms[0].model}") — controls.preflight is REQUIRED before a campaign `
        + 'may include a Grok arm (run scripts/grok-effort-preflight.mjs --run first)',
        ['controls', 'preflight'],
      );
    } else {
      if (cfg.controls.preflight.model !== xaiArms[0].model) {
        issue(
          `controls.preflight.model ("${cfg.controls.preflight.model}") does not match `
          + `the declared xAI arm's model ("${xaiArms[0].model}") — the attestation must `
          + 'name the exact model it measured, not a sentinel or a different release',
          ['controls', 'preflight', 'model'],
        );
      }
      if (cfg.controls.preflight.disposition !== 'pass') {
        issue(
          `controls.preflight.disposition is "${cfg.controls.preflight.disposition}", not `
          + '"pass" — a Grok arm requires a PASSING pre-flight (plan §8): the dial must be '
          + 'proven to move output before the arm may be billed inside a campaign',
          ['controls', 'preflight', 'disposition'],
        );
      }
    }
  }
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
export { canonicalJson };

/**
 * Digest over the COLLECTION-RELEVANT subset — the fields that determine what
 * was asked of the models. See the module header for why `targetN`,
 * `calibration` and `decisionRule` are deliberately excluded: they are
 * analysis-time, and hashing them would orphan collected evidence on a cost-
 * ceiling edit. Pre-registration is protected instead by `campaign_events`
 * (`rule_changed`) plus the standings watermark, which records that the
 * goalposts moved without destroying the data.
 */
export { configDigest };

/** Fields deliberately outside every digest — exported so the dashboard can
 * name the analysis-time values it applied rather than leaving a reader to
 * guess which rule produced a verdict. */
export { ANALYSIS_TIME_FIELDS };

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

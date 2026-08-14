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
import { isXaiModel } from '../model-resolver.mjs';
import { assertEligibleSubset } from '../comparison/roles.mjs';

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
export const ARM_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** §6.3 row 1. Not re-derived here — a campaign below this cannot support a
 * verdict, and `verdict.mjs` emits INCONCLUSIVE under it regardless of config. */
export const MIN_TARGET_N = 12;

const ArmSchema = z.object({
  id: z.string().regex(ARM_ID_PATTERN, 'arm id must match ^[a-z0-9][a-z0-9-]{0,63}$ (max 64 chars) — it is a receipt filename component'),
  model: z.string().min(1),
  mode: z.enum(['shadow', 'primary']),
  type: z.enum(['replicate', 'control']).optional(),
}).strict();

/**
 * Does this arm compete for the decision? The SINGLE oracle for that question.
 *
 * Two kinds of arm are collected but never scored, and they are not the same
 * thing:
 *  - **`replicate`** — the SAME model as a scored arm, run again, to read
 *    within-model reroll variance. Must duplicate a scored arm's model
 *    (enforced below); a replicate of nothing is a mislabelled scenario.
 *  - **`control`** — a DIFFERENT model included to calibrate what the
 *    comparison means, not to win it. The motivating case (2026-08-14): the
 *    incumbent primary reviewer is Gemini, and running Gemini in the shadow
 *    slot separates "is Opus the better second reviewer" from "is a fresh
 *    second look worth anything at all". It must never be scored, because the
 *    same model on both gates has correlated failure modes — the property a
 *    second gate exists to avoid — so a control that could win the slot would
 *    be recommending exactly the configuration the design rejects.
 *
 * Four sites re-derived `a.type !== 'replicate'` inline before this existed
 * (two here, two in verdict.mjs). Adding a second non-scored type to four
 * independent copies is how one gets missed and a control silently enters the
 * standings, so the predicate is exported and those sites now call it. The
 * comment below this once warned that the check "must widen" — this is that
 * widening, done once rather than four times.
 *
 * @param {{type?: string}} arm
 * @returns {boolean} true when the arm's findings count toward the verdict
 */
export function isScoredArm(arm) {
  return arm?.type !== 'replicate' && arm?.type !== 'control';
}

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

  const seen = new Set();
  for (const [i, arm] of cfg.arms.entries()) {
    if (seen.has(arm.id)) issue(`duplicate arm id "${arm.id}" — arm id identifies a receipt and a store row`, ['arms', i, 'id']);
    seen.add(arm.id);
  }

  const nonReplicates = cfg.arms.filter(isScoredArm);
  const replicates = cfg.arms.filter((a) => a.type === 'replicate');

  // One arm is not a comparison. Counts SCORED arms only — a campaign of one
  // candidate plus a control still compares nothing.
  if (nonReplicates.length < 2) {
    issue(`a campaign needs >= 2 scored arms (got ${nonReplicates.length}; replicate/control arms do not count) — one arm is not a comparison`, ['arms']);
  }

  // AT MOST one primary, not exactly one — a stale version of this comment
  // said "exactly one", which the check below never enforced (only `> 1` is
  // rejected) and a real committed campaign now depends on: `final-review-
  // scoped-2026q3.json` (KD-5) has ZERO primaries by design — a solo replicate
  // buys a within-model-variance reading the Gemini self-divergence readout
  // already estimates, at Opus's rate, for a comparison this cohort does not
  // need. Enforcing "exactly one" here would break that campaign.
  const primaries = cfg.arms.filter((a) => a.mode === 'primary');
  if (primaries.length > 1) {
    issue(`at most one arm may be mode:"primary" (got ${primaries.length}: ${primaries.map((a) => a.id).join(', ')})`, ['arms']);
  }

  // A "replicate" of nothing is a mislabelled scenario. (`controls` here means
  // the campaign-level dials block, which every arm shares by construction, so
  // the test reduces to the model — if per-arm dial overrides are ever added,
  // this must widen to compare them too. Not to be confused with a
  // `type: 'control'` ARM, which is deliberately exempt: naming a model no
  // scored arm uses is the entire point of one.)
  const nonReplicateModels = new Set(nonReplicates.map((a) => a.model));
  for (const [i, arm] of cfg.arms.entries()) {
    if (arm.type === 'replicate' && !nonReplicateModels.has(arm.model)) {
      issue(`replicate arm "${arm.id}" names model "${arm.model}", which no scored arm uses — a replicate of nothing is a mislabelled scenario`, ['arms', i, 'model']);
    }
  }

  // The incumbent must be a real, comparable participant.
  const incumbentArms = nonReplicates.filter((a) => a.model === cfg.decision.incumbent);
  if (incumbentArms.length === 0) {
    // Scored arms only — naming a control as the incumbent would make the
    // baseline something the campaign refuses to score, so every comparison
    // against it would be against an absent number.
    issue(`decision.incumbent "${cfg.decision.incumbent}" names no scored arm's model (available: ${[...nonReplicateModels].join(', ') || 'none'}; replicate/control arms are not eligible)`, ['decision', 'incumbent']);
  } else if (incumbentArms.length > 1) {
    issue(`decision.incumbent "${cfg.decision.incumbent}" matches ${incumbentArms.length} scored arms (${incumbentArms.map((a) => a.id).join(', ')}) — the incumbent must be unambiguous`, ['decision', 'incumbent']);
  }

  // Unused here, referenced by the digest below — keep them in one place so a
  // future field addition has an obvious home.
  void replicates;

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

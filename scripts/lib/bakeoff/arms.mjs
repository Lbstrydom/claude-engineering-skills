/**
 * @fileoverview Arm resolution + derivation + transport (D2).
 *
 * Moved verbatim from `scripts/bakeoff-collect.mjs` (plan:
 * comparison-tooling-consolidation.md, Phase 2) — function bodies unchanged
 * except where D1 already changed a signature in Phase 1. Per D2a: may
 * import `bakeoff/scope.mjs`, `lib/campaign/config.mjs`, `lib/comparison/*`;
 * must NOT import any `scripts/*.mjs` entry point, `bakeoff/spawn.mjs`, or
 * `bakeoff/log.mjs`.
 *
 * @module scripts/lib/bakeoff/arms
 */
import crypto from 'node:crypto';
import { ArgvError } from '../cli-io.mjs';
import { isXaiModel, isAlibabaModel, isDeepseekModel } from '../model-resolver.mjs';
import { PRICING_VERSION } from '../model-pricing.mjs';
import { selectCampaignConfig, isScoredArm } from '../campaign/config.mjs';
import { classifyArmCollisions } from '../comparison/fingerprint.mjs';
import { computeLockDigest } from '../campaign/lock.mjs';
import { createResolvedScope, UnresolvedScopeError } from './scope.mjs';

/**
 * Transport for one declared model — the HOW that the config deliberately
 * does not express.
 *
 * The split is the point of Phase 2: a campaign config declares WHAT is
 * being compared (model, mode), while reaching a provider family is runner
 * knowledge, not campaign policy. A consumer editing `.campaigns/*.json`
 * therefore cannot invent a wire shape, and adding a model family is a code
 * change with a test.
 *
 * **Refuses an unknown family rather than guessing a token.** A fabricated
 * `FINAL_REVIEW_SHADOW` value does not fail at derivation; it fails inside a
 * spawned reviewer, after the arm is already counted as attempted — the
 * late, expensive failure this pre-flight exists to convert into an early,
 * free one.
 *
 * @param {string} model
 * @returns {{route: string, shadowToken: string, providerArg: string, shadowModel: string|null, promptCache: '1'|''}}
 */
export function transportForModel(model) {
  if (typeof model !== 'string' || model.length === 0) {
    throw new ArgvError(`[bakeoff] arm model must be a non-empty string, got ${JSON.stringify(model)}`);
  }
  // Checked BEFORE the generic '/' catch-all below, on purpose: `ALIBABA_POOL`
  // is a closed, maintainer-curated allowlist (see its docstring), so a match
  // here is authoritative regardless of the id's shape — a future pool entry
  // that happens to contain '/' must never be silently swallowed by the
  // OpenRouter branch.
  if (isAlibabaModel(model)) {
    // Native Alibaba Cloud Model Studio route (qwen bake-off arm, 2026-08-17)
    // — mirrors the xai branch below: one direct workspace endpoint, not a
    // router picking among upstream backends, so no OpenRouter-style routing
    // extras apply. No prompt-cache multiplier: unverified whether this
    // workspace reports cache usage fields, so no multiplier is claimed
    // rather than assumed.
    //
    // `timeoutMs: 900000` — MEASURED, not guessed. A real end-to-end review
    // of a ~69K-token plan envelope took **465.5s** on this endpoint
    // (2026-08-17, `state:'ran'`, 8207 output tokens of which 7585 were
    // thinking). The cost driver is isolated: an otherwise-identical call
    // takes 17s WITHOUT `response_format:json_schema` and 143s WITH it — an
    // ~8.4x multiplier this workspace applies to schema-constrained output.
    // 465s therefore blows the 300s default (every early failure) and leaves
    // only 1.3x headroom at 600s, which one real code-mode snapshot — a
    // LARGER envelope than the 465s measurement — already exceeded once
    // before passing on retry. 900s restores ~1.9x over the measurement.
    //
    // Neither of the two "cheaper" fixes is available here, and for the same
    // reason: `reasoningEffort:'high'` and `outputSchemaId:'final-review@3'`
    // are BOTH declared controls hashed into the cohort lock digest. An arm
    // quietly running with thinking off, or without the schema, would
    // measure the dial instead of the model (this campaign's own measured
    // lesson: one arm found 0 findings at `low` vs 3 at `high` on an
    // identical transcript) AND make that digest attest a control the run
    // never honoured. Latency is the acceptable cost of comparability.
    return { route: 'alibaba', shadowToken: 'alibaba', providerArg: 'alibaba', shadowModel: model, promptCache: '', timeoutMs: 900000 };
  }
  if (isDeepseekModel(model)) {
    // Native DeepSeek route (2026-08-17) — REPLACES the Alibaba-workspace
    // pinned snapshot (`deepseek-v4-pro-0813`) for this model after two
    // consecutive 300s timeouts there at real review size; direct to the
    // source, like xai below, not a router.
    return { route: 'deepseek', shadowToken: 'deepseek', providerArg: 'deepseek', shadowModel: model, promptCache: '' };
  }
  // An OpenRouter id is the only one carrying a '/', and `pricingKey` returns
  // it verbatim for exactly that reason.
  if (model.includes('/')) {
    return { route: 'openrouter', shadowToken: 'openrouter', providerArg: 'openrouter', shadowModel: model, promptCache: '' };
  }
  if (model.startsWith('claude')) {
    // `claude-opus` is the PROVIDER token for the Opus shadow reviewer, not a
    // model id (AGENTS.md: FINAL_REVIEW_SHADOW=claude-opus|gemini|openrouter).
    // The concrete model rides in FINAL_REVIEW_SHADOW_MODEL, and is omitted
    // when the declaration is the bare family token so the derived arm stays
    // byte-identical to the table this replaces.
    return { route: 'anthropic', shadowToken: 'claude-opus', providerArg: 'claude-opus', shadowModel: model === 'claude-opus' ? null : model, promptCache: '1' };
  }
  if (model.startsWith('gemini')) {
    return { route: 'gemini', shadowToken: 'gemini', providerArg: 'gemini', shadowModel: model, promptCache: '' };
  }
  if (isXaiModel(model)) {
    // Native xai route (plan: final-review-scoped-second-reviewer.md, Phase 4)
    // — not the openrouter branch above, per KD-4: xAI is a single direct
    // endpoint, and the OpenRouter routing extras (provider/require_parameters)
    // have no meaning for it. No prompt-cache multiplier: xai reports no
    // cache_creation/cache_read usage fields today, so the flag would be a
    // pure no-op either way.
    return { route: 'xai', shadowToken: 'xai', providerArg: 'xai', shadowModel: model, promptCache: '' };
  }
  throw new ArgvError(`[bakeoff] no transport for model "${model}" — a campaign cannot declare a family the runner has no wire shape for. Add one to transportForModel() rather than letting it fail inside a spawned reviewer.`);
}

/**
 * Derive the wire arms from a campaign config, in declared order.
 *
 * **Declaration order is load-bearing and is preserved verbatim.** The two
 * Opus arms are adjacent so their identical prompts land inside Anthropic's
 * 5-minute cache TTL; under an `opus → kimi → solo-opus` order the second
 * Opus call lands ~8.8 min after the first, a guaranteed miss that the 1-hour
 * TTL cannot rescue (a 1h write is 2.0x base, so 2.0 + 0.1 exceeds the 2.0 it
 * replaces). Sorting these for tidiness would change no request and no
 * result — only whether the second send is billed at 1.0x or 0.1x.
 *
 * @param {object} config - a parsed campaign config
 * @returns {ReadonlyArray<{id: string, solo?: boolean, args?: string[], env: object, model: string, replicate: boolean, route: string}>}
 */
export function deriveArms(config) {
  return Object.freeze(config.arms.map((arm) => {
    const t = transportForModel(arm.model);
    // `replicate` on a DERIVED arm means "collected but not scored" — it
    // gates neither completeness nor the standings. Two declared types now
    // have that property (`replicate` and `control`), so it is derived from
    // the single `isScoredArm` oracle rather than re-tested against one
    // literal here. The literal test silently gave a control arm
    // `replicate: false`, which would have let a deliberately-unscored arm
    // gate snapshot completeness — the campaign would then stall waiting for
    // a result it must never score.
    const replicate = !isScoredArm(arm);
    if (arm.mode === 'primary') {
      // A primary arm answers "would this model ALONE have done", so it runs
      // with no shadow at all. Blanked explicitly rather than omitted: an
      // arm must be a function of the config, never of whatever the operator
      // happens to have exported into the environment.
      return {
        id: arm.id, model: arm.model, replicate, route: t.route, solo: true,
        args: ['--provider', t.providerArg],
        env: { FINAL_REVIEW_SHADOW: '', FINAL_REVIEW_PROMPT_CACHE: t.promptCache },
      };
    }
    const env = { FINAL_REVIEW_SHADOW: t.shadowToken, FINAL_REVIEW_PROMPT_CACHE: t.promptCache };
    if (t.shadowModel) env.FINAL_REVIEW_SHADOW_MODEL = t.shadowModel;
    // Key order matches the table this replaces so a derived arm is byte-identical.
    const ordered = t.shadowModel
      ? { FINAL_REVIEW_SHADOW: env.FINAL_REVIEW_SHADOW, FINAL_REVIEW_SHADOW_MODEL: env.FINAL_REVIEW_SHADOW_MODEL, FINAL_REVIEW_PROMPT_CACHE: env.FINAL_REVIEW_PROMPT_CACHE }
      : env;
    // A route with its own `timeoutMs` (currently only alibaba, see above)
    // overrides the blanket 300s default for this arm's spawn — `runArm`
    // (bakeoff/spawn.mjs) merges this LAST so it wins over the global default.
    if (t.timeoutMs) ordered.GEMINI_REVIEW_TIMEOUT_MS = String(t.timeoutMs);
    return { id: arm.id, model: arm.model, replicate, route: t.route, env: ordered };
  }));
}

/** The transcript-eligibility rule this runner applies, as a lock input —
 * widening it must orphan prior evidence rather than blend two populations. */
export const ELIGIBILITY_RULE = 'mode=code;plan-resolvable;audited_sha-present';

/**
 * The collect-time lock inputs available to the RUNNER.
 *
 * **Stated limitation, deliberately not disguised.** §2.5b specifies
 * `promptTemplateHash` as the sha256 of the *assembled* system prompt
 * template. That template is assembled inside `gemini-review.mjs`, which
 * this cluster does not touch, so what is hashed here is the template
 * *identifier the config declares*. The difference matters and must not be
 * papered over: this lock detects a DECLARED template change, and cannot
 * see an undeclared edit to the template body. Every other input is real
 * resolved reality. The stamped record carries `promptTemplateSource` so a
 * reader knows which guarantee they have rather than assuming the stronger
 * one — wiring the assembled hash is Cluster B's, where the reviewer is in
 * scope.
 */
export function computeCollectLock(config, configDigest, derivedArms) {
  const sha16 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16);
  const resolvedModels = Object.fromEntries(derivedArms.map((a) => [a.id, a.model]));
  const providerRoutes = Object.fromEntries(derivedArms.map((a) => [a.id, a.route]));
  const digest = computeLockDigest({
    schemaVersion: config.schemaVersion,
    configDigest,
    resolvedModels,
    providerRoutes,
    reasoningEffort: config.controls.reasoningEffort,
    promptTemplateHash: sha16(config.controls.promptTemplateId),
    outputSchemaHash: sha16(config.controls.outputSchemaId),
    adjudicatorModel: config.adjudicator.model,
    pricingVersion: PRICING_VERSION,
    eligibilityRule: ELIGIBILITY_RULE,
    armIds: derivedArms.map((a) => a.id),
  });
  return { lockDigest: digest, resolvedModels, providerRoutes, promptTemplateSource: 'declared-id', pricingVersion: PRICING_VERSION };
}

/**
 * The `ResolvedScope` an ENTRY's completeness must be judged against — the
 * campaign it was actually collected under, never an ambient default (D1).
 *
 * Found on the first real collection into a two-campaign repo (2026-08-14).
 * The predecessor of this function defaulted an unscoped read to
 * `resolveArms({})` with no campaign id; with two committed campaigns this
 * THROWS by design (ambiguity is never resolved by picking one), and the old
 * code's catch silently degraded to `LEGACY_ARMS` — `opus, solo-opus, kimi`.
 * The scoped campaign has no `solo-opus`, so a snapshot where all four of
 * its arms ran perfectly was judged INCOMPLETE, permanently: N could never
 * advance, and all twelve snapshots would have been paid for and counted
 * zero. D1 removes the implicit default entirely rather than patching the
 * one call site.
 *
 * `null` (unjudgeable, D1a) for BOTH a genuinely pre-campaign entry (no
 * `campaignId`) and a declared-but-unresolvable one — "cannot judge" and "an
 * arm did not run" are different facts and must not share a message, but
 * pre-campaign and unresolvable share the SAME "cannot judge" bucket (the
 * distinction a caller may want is the entry's own `campaignId` presence,
 * not a different return shape here).
 *
 * @param {object} entry - a bake-off log entry
 * @returns {import('./scope.mjs').ResolvedScope|null} null ⇒ unjudgeable
 */
export function scopeForEntry(entry) {
  const campaignId = entry?.campaignId;
  if (!campaignId) return null;
  const r = selectCampaignConfig({ campaignId });
  if (!r.ok) return null;
  return createResolvedScope(campaignId, deriveArms(r.config), r.config.controls?.envelopeScope ?? null);
}

/**
 * Did THIS arm actually run for THIS entry? The single predicate for "an arm
 * is missing" — used both by the incomplete-snapshot report and by per-arm
 * retry's arm selection (D5), which must agree on the same question or a
 * retry could skip an arm the report just named as missing.
 *
 * @param {object} arm - a declared arm (from resolveArms/deriveArms)
 * @param {object} entry - a bake-off log entry
 * @returns {boolean}
 */
export function armDidRun(arm, entry) {
  const r = entry?.arms?.[arm.id];
  if (!r || r.error) return false;
  // A solo arm has no shadow, so demanding shadowState==='ran' would report
  // it as never having run — its evidence of running is a verdict
  // (isComplete's own rule, mirrored here so the two cannot silently
  // diverge).
  return arm.solo ? Boolean(r.primaryVerdict) : r.shadowState === 'ran';
}

/**
 * Resolve the `ResolvedScope` for this run: derived from the committed
 * campaign — no other source (D1).
 *
 * **No campaign, no run.** `selected.code === 'none'` used to fall back to
 * `LEGACY_ARMS`, "not indefinite compatibility" but a real, reachable,
 * spend-bearing production path for any repo with no committed
 * `.campaigns/*.json` — measured here specifically: `sync-to-repos.mjs`
 * confirms `bakeoff-collect.mjs` ships to NO consumer, so that path has no
 * external compatibility obligation whatsoever, and this repo itself has two
 * committed campaigns, so the branch is already unreachable here. D1 deletes
 * it rather than leaving an unreachable-but-still-silent fallback in place:
 * "which campaign ran is not a detail a spend-bearing runner may decide on
 * the operator's behalf" — equally true of "no campaign at all" as it always
 * was of ambiguity. One rule, both cases, thrown as `UnresolvedScopeError`.
 *
 * `LEGACY_ARMS` itself is a frozen fixture in `tests/bakeoff-arms.test.mjs`
 * — its one remaining honest role is proving `deriveArms(the committed
 * campaign)` is byte-identical to the table it replaced; it is no longer a
 * live production symbol anywhere (Phase 2 completes what Phase 1 started).
 */
export function resolveArms({ campaignId = null, dir = undefined } = {}) {
  const selected = selectCampaignConfig({ ...(dir ? { dir } : {}), campaignId });
  if (!selected.ok) {
    // Every non-ok code (`none`, ambiguity, unknown id) is a refusal, never a
    // silent fallback — which campaign ran is not a detail a spend-bearing
    // runner may decide on the operator's behalf.
    throw new UnresolvedScopeError(`[bakeoff] ${selected.message}`);
  }
  const collision = classifyArmCollisions(selected.config);
  if (!collision.ok) throw new ArgvError(collision.message);
  const arms = deriveArms(selected.config);
  const scope = createResolvedScope(selected.config.id, arms, selected.config.controls?.envelopeScope ?? null);
  return {
    scope,
    config: selected.config,
    configDigest: selected.configDigest,
    fingerprints: collision.fingerprints,
    lock: computeCollectLock(selected.config, selected.configDigest, arms),
    source: `campaign:${selected.config.id}`,
  };
}

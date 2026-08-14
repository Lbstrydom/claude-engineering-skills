#!/usr/bin/env node
/**
 * @fileoverview Bake-off snapshot collector + progress counter.
 *
 * Runs BOTH arms of the final-review bake-off on ONE transcript and appends the
 * result to a machine-written log, so "how many snapshots do we have?" is a
 * QUERY, never a hand-maintained tally.
 *
 * **Why this script exists at all.** The activation addendum's first three
 * snapshots were recorded in a markdown table by hand, and a standalone
 * `gemini-review` invocation without `--run-id` has no audit run to attach to —
 * so nothing reached the store and the table was the only record. That is
 * precisely the manual-tally mechanism behind this repo's five prior false
 * "window met" reads (AGENTS.md, Model Swap-In Evaluation Harness). A count the
 * stopping rule depends on must be derived from data the collector wrote, not
 * from prose someone remembered to update.
 *
 * Bounded and synchronous by construction: `--progress` prints N/target and the
 * campaign has a fixed target. This is NOT a passive background collector — it
 * runs only when invoked, on a transcript you name.
 *
 * Usage:
 *   node scripts/bakeoff-collect.mjs --transcript <path> --plan <path> [--mode plan|code]
 *   node scripts/bakeoff-collect.mjs --progress
 *   node scripts/bakeoff-collect.mjs --selfcheck-relocation
 *
 * Plan: docs/plans/final-review-shadow-bakeoff.md §0 (Activation Addendum).
 *
 * @module scripts/bakeoff-collect
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { assertKnownFlags, ArgvError } from './lib/cli-io.mjs';
import { atomicWriteFileSync } from './lib/file-io.mjs';
import { costFromUsage, PRICING_VERSION } from './lib/model-pricing.mjs';
import { isXaiModel } from './lib/model-resolver.mjs';
import { canonicalJson, selectCampaignConfig, isScoredArm } from './lib/campaign/config.mjs';
import { computeLockDigest } from './lib/campaign/lock.mjs';

const KNOWN_FLAGS = Object.freeze([
  '--transcript', '--plan', '--mode', '--progress', '--target', '--campaign',
  '--force', '--selfcheck-relocation', '--help', '-h',
]);

/** Category A: accumulating run data, gitignored — never a committed artifact. */
export const LOG_PATH = '.audit/bakeoff-log.jsonl';
/**
 * Pre-registered cohort size, lowered 15 → **12** on 2026-08-03, before any
 * result under CONTRACT_EPOCH e2 was read — the only point §6.0b permits it
 * ("adjusts N ... only before run 1, never mid-campaign").
 *
 * 12 and not lower, deliberately. §6.3 row 1 makes `N < 12` terminal
 * INCONCLUSIVE — no keep/drop claim at any cost — so 8 would have bought a
 * cheaper campaign that answers nothing. 12 is the smallest N that still yields
 * a verdict, and reaching it required changing no decision rule: §0.5 states the
 * rule is inherited, not re-invented, and it is not amended here.
 *
 * What the reduction is worth: per-snapshot cost rose (three arms instead of
 * two, and matched reasoning effort made the OpenRouter arm ~5x slower), so the
 * three snapshots saved are real spend. What it is NOT: added confidence. §6.5
 * applies unchanged — this is an operating decision, not a statistical
 * inference, and 12 remains the floor the rule already set, not a new claim
 * about power.
 */
const DEFAULT_TARGET = 12;

/**
 * Evidence counts only if produced under the contract the stopping rule
 * validates (AGENTS.md, Model Swap-In Evaluation Harness). Bump on any
 * meaning-changing fix and RE-COLLECT — never backfill by date, which is the
 * relabelling that produced five false "window met" reads on the tiered
 * collector.
 *
 * e2 (2026-08-03): all three arms moved onto one reasoning dial. Under e1 the
 * arms ran at three unchosen depths — Gemini 16384, Opus 0 (forced tool_choice
 * silently disables reasoning), Kimi 'low'. Every e1 row therefore describes a
 * configuration that no longer exists, so they are ineligible rather than
 * deleted: the rows stay readable, they just cannot count.
 *
 * e3 (2026-08-14, docs/plans/final-review-scoped-second-reviewer.md): the
 * shadow envelope itself changed — `thin` drops ~32KB of repo context and
 * narrows code files to the in-scope diff, versus e2's unbounded `full`
 * envelope. A snapshot's `contractEpoch` alone cannot say WHICH envelope
 * produced it (that is `controls.envelopeScope`, now signed cohort state —
 * see `isComplete`'s scope-binding check), but the epoch bump is still
 * required: e2 rows measured a materially different request and must not
 * silently pool with e3 rows just because the reasoning dial didn't change
 * again. Every e2 row is ineligible under this epoch, same disposition as e1
 * before it — re-collect, never backfill by date.
 */
export const CONTRACT_EPOCH = 'e3-scoped-envelope';

/**
 * The LEGACY hardcoded arms — the fallback for a repo with no `.campaigns/`
 * config, and the byte-for-byte reference the derived arms are tested against.
 * The notes below describe why these three arms exist; the campaign config now
 * DECLARES them, and `deriveArms` reproduces exactly this wire shape.
 *
 * In run order. Arm 1 IS the ordinary gate config.
 *
 * `solo-opus` answers a different question from the two shadow arms: not "what
 * does a second reviewer ADD to Gemini" but "would Opus alone have done". A
 * shadow arm can never answer it — it only ever REPORTS findings bucketed
 * against a Gemini run, so a shadow that looks additive and a reviewer that
 * is simply better are indistinguishable from shadow buckets. It runs Opus as
 * PRIMARY with no shadow, so `shadowState` is inapplicable and completeness is
 * judged on the primary verdict instead (see isComplete).
 *
 * Note what that does NOT say: the two Opus REQUESTS are identical. The shadow
 * runs blind on the same transcript, plan and project context as the primary
 * (gemini-review.mjs::runShadowReview) and never sees Gemini's output; the
 * bucketing is a post-hoc set-diff on finding hashes. Measured: per snapshot the
 * two arms report the same input token count to the byte (81,182 / 81,182 on
 * 21245f6aae1c; 192,998 / 192,998 on c63035cbe740). So `solo-opus` buys a
 * SECOND SAMPLE of one distribution, differently reported — which is a real
 * thing to buy at this N, but it is a reroll, not a second scenario.
 *
 * ORDER IS LOAD-BEARING (2026-08-08): the two Opus arms are adjacent so their
 * identical prompts land inside Anthropic's 5-minute cache TTL. Under the old
 * `opus → kimi → solo-opus` order the Kimi arm sat between them for 150-286s on
 * top of Opus's own 185-244s, putting the second Opus call ~8.8 min after the
 * first — a guaranteed cache miss, and the 1-hour TTL cannot rescue it (a 1h
 * write is 2.0x base, so 2.0 + 0.1 exceeds the 2.0 it replaces). Reordering
 * changes no request and no result; it only decides whether the second send is
 * billed at 1.0x or 0.1x. Kimi last because nothing waits on it.
 */
/** Exported for the request-preservation test only: the derived arms must be
 * byte-identical to this for the committed campaign, which is what proves the
 * Phase-2 refactor changed no request. Not for production use. */
export const LEGACY_ARMS = Object.freeze([
  { id: 'opus', env: { FINAL_REVIEW_SHADOW: 'claude-opus', FINAL_REVIEW_PROMPT_CACHE: '1' } },
  { id: 'solo-opus', solo: true, args: ['--provider', 'claude-opus'], env: { FINAL_REVIEW_SHADOW: '', FINAL_REVIEW_PROMPT_CACHE: '1' } },
  // Explicitly blanked, not merely omitted: every arm must be a function of this
  // table alone, never of whatever the operator happens to have exported. The
  // flag is inert on the OpenRouter transport anyway — stating it keeps that a
  // property of the config rather than a coincidence of the wire shape.
  { id: 'kimi', env: { FINAL_REVIEW_SHADOW: 'openrouter', FINAL_REVIEW_SHADOW_MODEL: 'moonshotai/kimi-k2-thinking', FINAL_REVIEW_PROMPT_CACHE: '' } },
]);

/**
 * Transport for one declared model — the HOW that the config deliberately does
 * not express.
 *
 * The split is the point of Phase 2: a campaign config declares WHAT is being
 * compared (model, mode), while reaching a provider family is runner knowledge,
 * not campaign policy. A consumer editing `.campaigns/*.json` therefore cannot
 * invent a wire shape, and adding a model family is a code change with a test.
 *
 * **Refuses an unknown family rather than guessing a token.** A fabricated
 * `FINAL_REVIEW_SHADOW` value does not fail at derivation; it fails inside a
 * spawned reviewer, after the arm is already counted as attempted — the late,
 * expensive failure this pre-flight exists to convert into an early, free one.
 *
 * @param {string} model
 * @returns {{route: string, shadowToken: string, providerArg: string, shadowModel: string|null, promptCache: '1'|''}}
 */
export function transportForModel(model) {
  if (typeof model !== 'string' || model.length === 0) {
    throw new ArgvError(`[bakeoff] arm model must be a non-empty string, got ${JSON.stringify(model)}`);
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
 * **Declaration order is load-bearing and is preserved verbatim.** The two Opus
 * arms are adjacent so their identical prompts land inside Anthropic's 5-minute
 * cache TTL; under an `opus → kimi → solo-opus` order the second Opus call
 * lands ~8.8 min after the first, a guaranteed miss that the 1-hour TTL cannot
 * rescue (a 1h write is 2.0x base, so 2.0 + 0.1 exceeds the 2.0 it replaces).
 * Sorting these for tidiness would change no request and no result — only
 * whether the second send is billed at 1.0x or 0.1x.
 *
 * @param {object} config - a parsed campaign config
 * @returns {ReadonlyArray<{id: string, solo?: boolean, args?: string[], env: object, model: string, replicate: boolean, route: string}>}
 */
export function deriveArms(config) {
  return Object.freeze(config.arms.map((arm) => {
    const t = transportForModel(arm.model);
    // `replicate` on a DERIVED arm means "collected but not scored" — it gates
    // neither completeness nor the standings. Two declared types now have that
    // property (`replicate` and `control`), so it is derived from the single
    // `isScoredArm` oracle rather than re-tested against one literal here. The
    // literal test silently gave a control arm `replicate: false`, which would
    // have let a deliberately-unscored arm gate snapshot completeness — the
    // campaign would then stall waiting for a result it must never score.
    const replicate = !isScoredArm(arm);
    if (arm.mode === 'primary') {
      // A primary arm answers "would this model ALONE have done", so it runs
      // with no shadow at all. Blanked explicitly rather than omitted: an arm
      // must be a function of the config, never of whatever the operator
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
    return { id: arm.id, model: arm.model, replicate, route: t.route, env: ordered };
  }));
}

/**
 * D4 — the request fingerprint, computed PRE-FLIGHT.
 *
 * Over `{model, controls}` and deliberately NOT `mode`: two arms differing only
 * in shadow-vs-primary send the *same request*. Measured — per snapshot our own
 * `opus` and `solo-opus` arms report identical input token counts to the byte
 * (81,182 / 81,182; 192,998 / 192,998). They are one distribution sampled
 * twice, which is a real thing to buy at this N but is a REROLL, not a second
 * scenario, and the arithmetic must know the difference.
 */
export function armRequestFingerprint(arm, controls) {
  return crypto.createHash('sha256').update(canonicalJson({ model: arm.model, controls })).digest('hex').slice(0, 16);
}

/**
 * D4 — colliding arms are classified BEFORE spend, never discovered after.
 *
 * Two arms with the same request fingerprint are a hard refusal unless the
 * collision is *declared*: at most one arm per fingerprint may be undeclared,
 * the rest must carry `type: "replicate"`. The escape is not a loophole — our
 * own `solo-opus` is a deliberate and valuable replicate — but an UNdeclared
 * duplicate silently halves the apparent evidence for one model while looking
 * like two independent arms, which is lesson (c): a reroll discovered after the
 * spend is a reroll that already corrupted the aggregate.
 *
 * @returns {{ok: true, fingerprints: Record<string,string>} | {ok: false, message: string}}
 */
export function classifyArmCollisions(config) {
  const arms = config.arms;
  const fingerprints = {};
  const byFingerprint = new Map();
  for (const arm of arms) {
    const fp = armRequestFingerprint(arm, config.controls);
    fingerprints[arm.id] = fp;
    if (!byFingerprint.has(fp)) byFingerprint.set(fp, []);
    byFingerprint.get(fp).push(arm);
  }
  for (const [fp, group] of byFingerprint) {
    if (group.length < 2) continue;
    // A `control` declaration counts as declared here for the same reason
    // `replicate` does: both say "this duplicate request is deliberate". The
    // refusal exists to catch an UNdeclared collision (lesson c), not to
    // privilege one declaration keyword.
    const undeclared = group.filter(isScoredArm);
    if (undeclared.length > 1) {
      return {
        ok: false,
        message: `[bakeoff] D4: arms ${undeclared.map((a) => `"${a.id}"`).join(', ')} send an IDENTICAL request (fingerprint ${fp}) but none is declared type:"replicate". `
          + 'Two arms sampling one distribution are a reroll, not a comparison — declare the duplicate as a replicate, or make the requests differ. '
          + 'Refusing before spend: discovering this afterwards means the aggregate was already wrong.',
      };
    }
  }
  return { ok: true, fingerprints };
}

/**
 * The collect-time lock inputs available to the RUNNER.
 *
 * **Stated limitation, deliberately not disguised.** §2.5b specifies
 * `promptTemplateHash` as the sha256 of the *assembled* system prompt template.
 * That template is assembled inside `gemini-review.mjs`, which this cluster does
 * not touch, so what is hashed here is the template *identifier the config
 * declares*. The difference matters and must not be papered over: this lock
 * detects a DECLARED template change, and cannot see an undeclared edit to the
 * template body. Every other input is real resolved reality. The stamped record
 * carries `promptTemplateSource` so a reader knows which guarantee they have
 * rather than assuming the stronger one — wiring the assembled hash is Cluster
 * B's, where the reviewer is in scope.
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

/** The transcript-eligibility rule this runner applies, as a lock input —
 * widening it must orphan prior evidence rather than blend two populations. */
export const ELIGIBILITY_RULE = 'mode=code;plan-resolvable;audited_sha-present';

let _defaultArms = null;
/**
 * The expected arm set for the ANALYSIS functions (`isComplete`,
 * `zeroFindingArms`, `aggregateMatched`, `summarise`), which must know which
 * arms a snapshot *should* contain — reading only the arms an entry happens to
 * carry would make a missing arm invisible, and absence is never a pass.
 *
 * Lazy and memoised rather than resolved at import: a module-level filesystem
 * read would make a malformed `.campaigns/` file break every consumer of this
 * module, including ones that never collect.
 *
 * Falls back to the legacy table on ANY resolution problem, deliberately. That
 * is not the silent fallback `resolveArms` refuses to make: the COLLECT path
 * still throws loudly on the same config, so this can never let a live run
 * proceed against a wrong arm set — it only decides how already-logged history
 * is read, and the legacy table is what that history was collected under.
 * Per-cohort arm sets (so an old entry is read under ITS OWN lock rather than
 * today's) arrive with the cohort store in Cluster B.
 */
export function defaultArms() {
  if (_defaultArms) return _defaultArms;
  try { _defaultArms = resolveArms({}).arms; }
  catch { _defaultArms = LEGACY_ARMS; }
  return _defaultArms;
}

// `undefined`, not `null`, is the "not yet resolved" sentinel — a genuinely
// resolved value (including the legacy-fallback case) is `null`, which must
// stay distinguishable from "haven't looked yet" or every call after the
// first legacy-fallback resolution would re-run resolveArms() for nothing.
let _defaultScope;

/**
 * Same resolution as `defaultArms()`, exposing `controls.envelopeScope` for
 * `isComplete`'s scope-binding check (plan KD-6). `null` when no real
 * campaign is active (legacy-table fallback) — there is no scope concept to
 * bind against, so the check that consumes this treats `null` as "skip".
 */
export function defaultExpectedScope() {
  if (_defaultScope !== undefined) return _defaultScope;
  try { _defaultScope = resolveArms({}).config?.controls?.envelopeScope ?? null; }
  catch { _defaultScope = null; }
  return _defaultScope;
}

/** Test seam — mirrors the `_reset*` pattern used elsewhere in scripts/lib. */
export function _resetDefaultArms() { _defaultArms = null; _defaultScope = undefined; }

/**
 * The arm set an ENTRY's completeness must be judged against — the campaign it
 * was actually collected under, never an ambient default.
 *
 * Found on the first real collection into a two-campaign repo (2026-08-14).
 * `isComplete(entry)` defaulted to `defaultArms()`, which calls
 * `resolveArms({})` with no campaign id; with two committed campaigns that
 * THROWS by design (ambiguity is never resolved by picking one) and the catch
 * silently degrades to `LEGACY_ARMS` — `opus, solo-opus, kimi`. The scoped
 * campaign has no `solo-opus`, so a snapshot where all four of its arms ran
 * perfectly was judged INCOMPLETE, permanently: N could never advance, and all
 * twelve snapshots would have been paid for and counted zero. The measured
 * proof is the run that found it — `isComplete(entry)` false,
 * `isComplete(entry, itsOwnArms, itsOwnScope)` true, on identical data.
 *
 * The root cause is a fallback that answers a question it was never able to
 * resolve. So this returns `null` rather than guessing when an entry names a
 * campaign that cannot be resolved — "cannot judge" and "an arm did not run"
 * are different facts and must not share a message. Only a genuinely
 * pre-campaign entry (no `campaignId`) falls back to the legacy table.
 *
 * @param {object} entry - a bake-off log entry
 * @returns {{arms: object[], expectedScope: string|null}|null} null ⇒ unjudgeable
 */
export function scopeForEntry(entry) {
  const campaignId = entry?.campaignId;
  if (!campaignId) return { arms: defaultArms(), expectedScope: defaultExpectedScope() };
  const r = selectCampaignConfig({ campaignId });
  if (!r.ok) return null;
  return { arms: deriveArms(r.config), expectedScope: r.config.controls?.envelopeScope ?? null };
}

/**
 * `isComplete` scoped to the entry's own campaign. Unjudgeable ⇒ false, but
 * callers that can report WHY should ask `scopeForEntry` first.
 */
export function isCompleteForEntry(entry) {
  const scope = scopeForEntry(entry);
  if (!scope) return false;
  return isComplete(entry, scope.arms, scope.expectedScope);
}

/**
 * Resolve the arms for this run: derived from the committed campaign when one
 * exists, else the legacy hardcoded table.
 *
 * The fallback is not indefinite compatibility — it keeps a repo that has not
 * adopted campaigns collecting exactly as before, and it is what makes this
 * change provably request-preserving (a test asserts the derived arms are
 * byte-identical to `LEGACY_ARMS` for the committed campaign).
 */
export function resolveArms({ campaignId = null, dir = undefined } = {}) {
  const selected = selectCampaignConfig({ ...(dir ? { dir } : {}), campaignId });
  if (!selected.ok) {
    if (selected.code === 'none') return { arms: LEGACY_ARMS, config: null, source: 'legacy-table' };
    // Ambiguity and unknown ids are refusals, never a silent fallback to the
    // legacy table — which campaign ran is not a detail a spend-bearing runner
    // may decide on the operator's behalf.
    throw new ArgvError(selected.message);
  }
  const collision = classifyArmCollisions(selected.config);
  if (!collision.ok) throw new ArgvError(collision.message);
  const arms = deriveArms(selected.config);
  return {
    arms,
    config: selected.config,
    configDigest: selected.configDigest,
    fingerprints: collision.fingerprints,
    lock: computeCollectLock(selected.config, selected.configDigest, arms),
    source: `campaign:${selected.config.id}`,
  };
}

/**
 * Snapshot identity is the transcript's CONTENT hash, not its path — two runs
 * over the same bytes are one snapshot even if the file was copied or renamed,
 * and a re-run against edited content is correctly a NEW snapshot rather than a
 * silent overwrite.
 * @param {string} transcriptPath
 * @returns {string} first 12 hex of sha256
 */
export function snapshotId(transcriptPath) {
  const buf = fs.readFileSync(transcriptPath);
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);
}

/**
 * Distinct-finding count under the SAME rule `diffFindingBuckets` applies to a
 * shadow (dedup by `_hash`), so a primary count and a shadow count are
 * comparable numbers rather than two different measurements wearing one name.
 *
 * The shadow side is deduped before it is ever bucketed; the primary side is
 * written to the arm file raw. Comparing them directly would report a dedup
 * difference as model variance. Observed today: raw === distinct on all five
 * snapshots, so this changes no number — which is the point. It stops being
 * true silently the first time a reviewer repeats itself.
 *
 * An unhashed finding gets a per-index key rather than collapsing into one
 * bucket — same "never silently drop" rule as `dedupByHash`, without importing
 * the hashing module into a collector.
 * @param {Array<object>|null|undefined} findings
 */
export function distinctFindingCount(findings) {
  const list = Array.isArray(findings) ? findings.filter(Boolean) : [];
  return new Set(list.map((f, i) => f._hash ?? `nohash:${i}`)).size;
}

/**
 * Opus's own finding total from the `opus` arm, where it ran as SHADOW.
 *
 * `both + shadowOnly` is the shadow's whole deduped set: `diffFindingBuckets`
 * partitions it into exactly those two buckets. In practice `both` is
 * structurally ~0 because the hashes are matched across models — that makes the
 * sum equal `shadowOnly` today, but the sum is what is correct, so it is what is
 * written.
 *
 * Returns null (never 0) when the shadow did not run: a skipped arm that reads
 * as "found nothing" is the anti-green failure this campaign already tripped on.
 * @param {object|null|undefined} armResult
 */
export function shadowFindingTotal(armResult) {
  const b = armResult?.buckets;
  if (!b || typeof b.both !== 'number' || typeof b.shadowOnly !== 'number') return null;
  return b.both + b.shadowOnly;
}

/**
 * What one arm SPENT, in USD, priced through the shared cost oracle.
 *
 * An arm is one or two model calls (a primary, plus a shadow when it has one),
 * so the arm's cost is their sum. Costed here rather than left to a throwaway
 * script because spend is the constraint this campaign actually runs against:
 * answering "why is the Opus arm expensive?" previously meant hand-parsing
 * `_usage` blobs across every snapshot directory.
 *
 * Returns `{usd: null}` when ANY call in the arm is unpriced — a partial sum is
 * worse than no sum, because it reads as a complete one. `unpricedModels` names
 * what could not be priced so the gap is actionable rather than mysterious.
 *
 * @param {object} armJson - the arm's `--out` JSON
 */
export function armCostUsd(armJson) {
  const calls = [
    { model: armJson?._model, usage: armJson?._usage },
    { model: armJson?._shadow?.model, usage: armJson?._shadow?.usage },
    // Audit R1 H2 — this filtered on `c.model && c.usage`, so a call that
    // really happened but reported NO usage was dropped from `calls` entirely:
    // it never reached costFromUsage, never landed in `unpricedModels`, and the
    // arm therefore published a confident-looking total that silently omitted
    // it. Filter on the model alone — a model with no usage IS a call, and
    // costFromUsage now classifies it as unmeterable, which the loop below
    // turns into an honest null total. No model means no call was made.
  ].filter((c) => c.model);
  if (calls.length === 0) return { usd: null, unpricedModels: [] };
  let usd = 0;
  const unpricedModels = [];
  for (const c of calls) {
    const r = costFromUsage(c.usage, c.model);
    // c5808479 fix — `if (!r.priced) … else usd += r.totalUsd` now has a third
    // case: a PRICED model whose usage is unmeterable returns totalUsd:null,
    // and `usd += null` would silently add 0, quietly under-reporting the arm
    // instead of admitting the total is unknown. An unmeterable call makes the
    // arm total exactly as unknowable as an unpriced one does, so it takes the
    // same path.
    if (!r.priced || r.unmeterable) unpricedModels.push(c.model);
    else usd += r.totalUsd;
  }
  return { usd: unpricedModels.length ? null : usd, unpricedModels };
}

/** Parse one arm's `--out` JSON into the fields the stopping rule scores. */
export function readArmResult(outPath) {
  const j = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
  const shadow = j._shadow || {};
  const cost = armCostUsd(j);
  return {
    costUsd: cost.usd,
    unpricedModels: cost.unpricedModels,
    // Request identity for BOTH calls this arm makes. Two arms sharing a
    // fingerprint issued the same request and differ only in how the result is
    // reported — a reroll, not a second configuration. Null on entries written
    // before the field existed, which reads as "unknown", never "distinct".
    requestFingerprints: [j._requestFingerprint ?? null, shadow.requestFingerprint ?? null].filter(Boolean),
    primaryVerdict: j.verdict ?? null,
    primaryFindings: (j.new_findings || []).length,
    // Counted the shadow's way, so `solo-opus` can be compared against the Opus
    // shadow in the `opus` arm (see summarise → opusDivergence).
    primaryDistinct: distinctFindingCount(j.new_findings),
    shadowState: shadow.state ?? null,
    shadowModel: shadow.model ?? null,
    // Which envelope the shadow actually received (gemini-review.mjs's
    // `_shadow.scope`). This is the evidence `isComplete`'s scope-binding
    // check reads — plan KD-6: scope must be signed cohort state, and a
    // snapshot whose arm ran a DIFFERENT scope than the manifest declared is
    // ineligible, not merely annotated. Absent on entries predating the field
    // (reads as null, never coerced to a guessed scope).
    shadowScope: shadow.scope ?? null,
    // The shadow's own VERDICT, not just its finding count. Observed at N=3:
    // both shadows APPROVE nearly everything — Kimi APPROVEd a plan the primary
    // REJECTed. A shadow's verdict is therefore near-useless as a signal, and
    // its whole value rides on the findings; recording it is what makes that
    // claim checkable at N=15 instead of an impression.
    shadowVerdict: shadow.verdict ?? null,
    // `buckets` is null when the shadow skipped — distinguish that from a real
    // zero, or a skipped arm reads as "found nothing" (the anti-green class).
    buckets: shadow.buckets ?? null,
    // The matched view + the cohort identity it was computed under. Null when
    // matching was disabled, or the arm predates the field — never coerced into
    // a bucket set, which would read as a measured zero.
    bucketsMatched: shadow.bucketsMatched ?? null,
    matchCohort: cohortDigest(shadow.matchSchemaVersion, shadow.matchConfig),
  };
}

/**
 * Identity of the configuration a matched result was computed under (plan §2.5d).
 *
 * Canonical: sha256 over `{matchSchemaVersion, threshold, coverageFloor, enabled}`
 * in that FIXED key order, numbers to 4dp, first 8 hex. Fixed order and fixed
 * precision because `JSON.stringify` of an object literal is insertion-ordered
 * and a float can render differently across producers — either would split one
 * cohort into two and silently shrink the aggregate.
 *
 * `matchSchemaVersion` IS part of the identity: a schema change with an
 * unchanged threshold still changes what the buckets MEAN. `enabled` is in it
 * too, though the aggregator drops disabled rows before grouping — the digest
 * records what happened, the filter keeps the arithmetic safe.
 *
 * Returns `'v0-unstamped'` for a record written before the fields existed, so
 * those group together and report as not-re-derivable rather than silently
 * joining a real cohort.
 */
export function cohortDigest(schemaVersion, cfg) {
  if (schemaVersion == null || !cfg) return 'v0-unstamped';
  const canonical = JSON.stringify({
    matchSchemaVersion: schemaVersion,
    threshold: Number(cfg.threshold).toFixed(4),
    coverageFloor: Number(cfg.coverageFloor).toFixed(4),
    enabled: cfg.enabled !== false,
  });
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 8);
}

/** Every distinct snapshot in the log, newest entry wins per id. */
export function readLog(logPath = LOG_PATH) {
  if (!fs.existsSync(logPath)) return [];
  const byId = new Map();
  for (const line of fs.readFileSync(logPath, 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { const e = JSON.parse(t); if (e?.snapshotId) byId.set(e.snapshotId, e); }
    catch { /* a torn final line must not lose every prior snapshot */ }
  }
  return [...byId.values()];
}

/**
 * A snapshot COUNTS only when every arm actually ran. An arm that skipped
 * (`skipped-no-key`, `skipped-azure`, …) or errored leaves the snapshot
 * incomplete — counting it would inflate N with rows that cannot support a
 * uniqueness claim, which is the same "measured nothing, read as data" failure
 * the epoch gate exists to prevent elsewhere.
 */
export function isComplete(entry, arms = defaultArms(), expectedScope = defaultExpectedScope()) {
  if (entry?.contractEpoch !== CONTRACT_EPOCH) return false; // unstamped or stale ⇒ ineligible
  const armsRan = arms.every((a) => {
    const r = entry?.arms?.[a.id];
    if (!r || r.error) return false;
    // A solo arm has no shadow, so demanding shadowState==='ran' would make the
    // snapshot permanently incomplete. Its evidence of having run is a verdict.
    return a.solo ? Boolean(r.primaryVerdict) : r.shadowState === 'ran';
  });
  if (!armsRan) return false;
  if (expectedScope === null) return true; // no campaign scope declared — nothing to bind

  // Scope-binding eligibility (plan KD-6, H1's correction): every SHADOW-
  // PRODUCING arm's actual `_shadow.scope` must equal the manifest's declared
  // `controls.envelopeScope`, so a snapshot collected under a different
  // envelope (e.g. before a scope change) cannot silently mix into this
  // cohort.
  //
  // Quantified over `!a.solo` (shadow-producing arms), NEVER `arms` as a
  // whole. An earlier draft of this check used `arms.every`, which is wrong
  // by construction: the campaign schema permits one `mode:"primary"` arm
  // (the committed `final-review-2026q3` cohort has one, `solo-opus`), and a
  // primary arm runs no shadow reviewer at all — it emits no `_shadow` block
  // and therefore has no `shadowScope`. A universally-quantified check would
  // compare `undefined` against the expected scope on that arm and mark
  // EVERY snapshot in the cohort permanently ineligible — a bug that would
  // stay latent for any campaign with no primary arm and detonate the moment
  // one was added (caught in this plan's own audit trail before it shipped).
  return arms.filter((a) => !a.solo).every((a) => entry?.arms?.[a.id]?.shadowScope === expectedScope);
}

/**
 * Did an arm report ZERO findings while genuinely having reviewed?
 *
 * `shadowOnly: 0` is ambiguous on its own. Because cross-model `_hash` matching
 * makes the `both` bucket structurally ~0, a shadow that agreed with the primary
 * and a shadow that produced nothing at all BOTH read as `shadowOnly: 0`. The
 * distinguishing evidence is that it returned a verdict and spent output tokens:
 * that is a review that found nothing, not an arm that silently failed.
 *
 * Surfaced separately from `isComplete` because a broken arm and a lenient arm
 * lead to opposite conclusions, and the count alone cannot tell them apart.
 *
 * Three-way, never two-way. Entries written before `shadowVerdict` existed have
 * the key ABSENT, which is not the same as an arm that returned no verdict —
 * collapsing the two would report the campaign's own first three snapshots as
 * broken arms. `evidence` is `unrecorded` (predates the field, says nothing),
 * `reviewed` (returned a verdict ⇒ genuinely found nothing), or `no-verdict`
 * (recorded, and empty ⇒ suspect the arm, not the model).
 */
export function zeroFindingArms(entry, arms = defaultArms()) {
  const out = [];
  for (const a of arms) {
    const r = entry?.arms?.[a.id];
    if (a.solo) continue; // no shadow bucket exists; a zero here would be meaningless
    if (!r || r.shadowState !== 'ran') continue;
    if ((r.buckets?.shadowOnly ?? 0) !== 0) continue;
    const recorded = Object.hasOwn(r, 'shadowVerdict');
    out.push({
      arm: a.id,
      verdict: recorded ? (r.shadowVerdict ?? null) : undefined,
      evidence: !recorded ? 'unrecorded' : (r.shadowVerdict ? 'reviewed' : 'no-verdict'),
    });
  }
  return out;
}

/**
 * Aggregate the MATCHED view across snapshots, refusing to mix cohorts (§2.5d).
 *
 * Three rules, each closing a way the number could lie:
 *  1. Drop `bucketsMatched === null` FIRST. Those arms did not compute a
 *     matched view; grouping them would dereference `.both` on null, and
 *     counting them as zeros would invent measurements.
 *  2. Group by cohort digest and aggregate only the LARGEST group, naming the
 *     excluded ones. A mean across two thresholds is not a measurement of
 *     either — but refusing to report anything would push an operator to
 *     eyeball it, which is worse.
 *  3. Never let a `null` coverage reach an arithmetic operator. JS coerces it
 *     to 0, so a single `not-applicable` snapshot would silently drag the
 *     campaign's coverage down. Divide by the count of non-null coverages.
 */
export function aggregateMatched(complete, arms = defaultArms()) {
  const rows = [];
  let notComputed = 0;
  for (const e of complete) {
    for (const a of arms) {
      if (a.solo) continue;                       // no shadow ⇒ no matched view
      const r = e.arms?.[a.id];
      if (!r) continue;
      if (!r.bucketsMatched) { notComputed++; continue; }
      rows.push({ arm: a.id, cohort: r.matchCohort ?? 'v0-unstamped', m: r.bucketsMatched });
    }
  }
  if (rows.length === 0) {
    return { matchedCohort: null, matchedRows: 0, matchedNotComputed: notComputed, matchedExcluded: [], matchedCoverage: null, matchedTotals: null };
  }
  const groups = new Map();
  for (const r of rows) groups.set(r.cohort, [...(groups.get(r.cohort) || []), r]);
  // Largest group wins; ties break on the LOWEST digest so two runs over one
  // log always pick the same cohort (never input order).
  const ranked = [...groups.entries()].sort((a, b) => (b[1].length - a[1].length) || a[0].localeCompare(b[0]));
  const [cohort, chosen] = ranked[0];

  const covs = chosen.map((r) => r.m.coverage).filter((c) => typeof c === 'number');
  return {
    matchedCohort: cohort,
    matchedRows: chosen.length,
    matchedNotComputed: notComputed,
    matchedExcluded: ranked.slice(1).map(([c, rs]) => ({ cohort: c, rows: rs.length })),
    // null, not 0, when every row was `not-applicable`.
    matchedCoverage: covs.length ? covs.reduce((s, c) => s + c, 0) / covs.length : null,
    matchedTotals: {
      both: chosen.reduce((s, r) => s + r.m.both, 0),
      shadowOnly: chosen.reduce((s, r) => s + r.m.shadowOnly, 0),
      unmatchable: chosen.reduce((s, r) => s + r.m.unmatchablePrimary + r.m.unmatchableShadow, 0),
      unknownVerdicts: chosen.filter((r) => r.m.verdict === 'unknown').length,
      notApplicable: chosen.filter((r) => r.m.verdict === 'not-applicable').length,
    },
  };
}

export function summarise(entries, target = DEFAULT_TARGET, arms = defaultArms(), expectedScope = defaultExpectedScope()) {
  // Arrow, not a bare reference: Array#filter passes (element, index, array),
  // so `filter(isComplete)` would hand the INDEX to the optional `arms` param
  // and `arms.every` would blow up on a number. Caught by the existing suite.
  const complete = entries.filter((e) => isComplete(e, arms, expectedScope));
  const totals = {
    // Generic, arm-id-keyed tallies — the source of truth for the readout.
    uniqueByArm: {}, soloFindingsByArm: {},
    // Legacy flat fields, DERIVED from the maps below so the historical
    // three-arm campaign keeps reporting identically. They are a view, not a
    // second source: nothing writes them directly.
    opusUnique: 0, kimiUnique: 0, soloFindings: 0, primaryTotal: 0,
    primaryDivergence: [], opusDivergence: [], opusDivergenceUnpaired: 0,
    // Per-arm spend. `costByArm[x] === null` means at least one call in that arm
    // was unpriced, so no total exists — distinct from a genuine 0, which would
    // claim the arm ran for free.
    costByArm: {}, costUncostedSnapshots: 0, rerollPairs: [],
  };
  // An arm is uncostable if ANY of its snapshots is. Tracked separately from the
  // running sum so one unpriced model cannot silently deflate an arm's total.
  const armCostState = new Map();
  for (const e of complete) {
    // Tallied per DECLARED arm, never per hardcoded id. The readout named
    // `opus`/`kimi`/`solo-opus` literally, so the moment a campaign declared a
    // different arm set it reported an arm that did not exist (`solo-opus`,
    // from the other campaign) and silently omitted the ones that did (`grok`,
    // `gemini-control` contributed to spend and to the verdict while appearing
    // in no line of the only readout an operator reads). A comparison tool
    // whose summary is pinned to one historical arm set cannot be used for the
    // next comparison, which is the entire point of declaring arms in config.
    for (const a of arms) {
      const r = e.arms?.[a.id];
      if (!r) continue;
      // A solo arm has no shadow bucket, so its whole result IS its primary
      // count — the two are different measurements and must not be summed into
      // one column.
      if (a.solo) {
        totals.soloFindingsByArm[a.id] = (totals.soloFindingsByArm[a.id] ?? 0) + (r.primaryFindings ?? 0);
      } else {
        totals.uniqueByArm[a.id] = (totals.uniqueByArm[a.id] ?? 0) + (r.buckets?.shadowOnly ?? 0);
      }
    }
    const p1 = e.arms.opus?.primaryFindings ?? 0;
    const p2 = e.arms.kimi?.primaryFindings ?? 0;
    totals.primaryTotal += p1 + p2;
    // §0.4's fifth question — "is a 2nd reviewer just a reroll?" — is answered
    // by P1-vs-P2 divergence: two runs of the SAME primary on the SAME
    // transcript. Both numbers are already collected, so recording the spread
    // costs nothing and is the difference between measuring it and noticing it
    // after the cohort closes.
    totals.primaryDivergence.push(Math.abs(p1 - p2));

    // The same question for OPUS, which the Gemini spread cannot answer. The
    // `opus` and `solo-opus` arms issue a byte-identical Anthropic request (the
    // shadow runs blind on the same transcript, plan and context as the primary
    // — measured: matching input token counts on every snapshot), so the pair is
    // two samples of ONE distribution and their spread is Opus's own variance.
    //
    // Worth reading because it prices the `solo-opus` arm: if Opus diverges from
    // itself by as much as it "adds" over Gemini, the arm is buying a reroll and
    // the campaign should say so rather than let a shadow-vs-solo gap read as a
    // finding about reviewer roles.
    //
    // A snapshot missing either side is COUNTED AS UNPAIRED, never as a zero —
    // a zero here would read as "Opus agreed with itself perfectly", which is
    // the strongest possible claim and exactly what absent data cannot support.
    const shadowOpus = shadowFindingTotal(e.arms.opus);
    const soloOpus = e.arms['solo-opus']?.primaryDistinct;
    if (typeof shadowOpus === 'number' && typeof soloOpus === 'number') {
      totals.opusDivergence.push(Math.abs(shadowOpus - soloOpus));
    } else {
      totals.opusDivergenceUnpaired += 1;
    }

    // Spend, per arm.
    let snapshotFullyCosted = true;
    for (const a of arms) {
      const c = e.arms?.[a.id]?.costUsd;
      const prev = armCostState.get(a.id) ?? { usd: 0, costable: true };
      if (typeof c === 'number') prev.usd += c;
      else { prev.costable = false; snapshotFullyCosted = false; }
      armCostState.set(a.id, prev);
    }
    if (!snapshotFullyCosted) totals.costUncostedSnapshots += 1;

    // Reroll detection. Two arms whose fingerprints intersect sent the SAME
    // request, so any difference between them is sampling noise plus a
    // reporting convention — never a fact about reviewer roles. Reported as a
    // property of the data rather than left as tribal knowledge, because the
    // arm table looks like three configurations and reads like three questions.
    const byArm = arms.map((a) => [a.id, new Set(e.arms?.[a.id]?.requestFingerprints ?? [])]);
    for (let i = 0; i < byArm.length; i++) {
      for (let k = i + 1; k < byArm.length; k++) {
        const shared = [...byArm[i][1]].filter((fp) => byArm[k][1].has(fp));
        if (shared.length > 0) totals.rerollPairs.push(`${byArm[i][0]}=${byArm[k][0]}`);
      }
    }
  }
  for (const [id, s] of armCostState) totals.costByArm[id] = s.costable ? s.usd : null;
  // Derive the legacy flat fields from the generic maps. Kept so the original
  // three-arm campaign's readout and its existing assertions are unchanged;
  // they are a projection of `uniqueByArm`/`soloFindingsByArm`, never a
  // parallel tally that could disagree with them.
  totals.opusUnique = totals.uniqueByArm.opus ?? 0;
  totals.kimiUnique = totals.uniqueByArm.kimi ?? 0;
  totals.soloFindings = totals.soloFindingsByArm['solo-opus'] ?? 0;
  Object.assign(totals, aggregateMatched(complete));
  return {
    complete: complete.length,
    incomplete: entries.length - complete.length,
    target,
    remaining: Math.max(0, target - complete.length),
    met: complete.length >= target,
    totals,
  };
}

function printProgress(logPath, target, campaignId = null) {
  // Scope to ONE campaign's entries, judged against THAT campaign's arms.
  // Previously this summarised every entry in the shared log against
  // `defaultArms()` — which, with two committed campaigns, is the legacy table
  // (see scopeForEntry). The readout then quoted `solo-opus`, an arm the
  // scoped campaign does not have, while reporting its four real arms as
  // incomplete. A progress line that counts the wrong arms is worse than none:
  // it is the number the stopping rule reads.
  const all = readLog(logPath);
  const entries = campaignId ? all.filter((e) => e.campaignId === campaignId) : all;
  let arms; let expectedScope;
  if (campaignId) {
    const r = selectCampaignConfig({ campaignId });
    if (r.ok) { arms = deriveArms(r.config); expectedScope = r.config.controls?.envelopeScope ?? null; }
  }
  const s = arms ? summarise(entries, target, arms, expectedScope) : summarise(entries, target);
  process.stdout.write(`\nBake-off progress — ${s.complete}/${s.target} complete snapshot(s)\n`);
  if (s.incomplete > 0) process.stdout.write(`  ${s.incomplete} incomplete (an arm skipped or errored) — not counted\n`);
  const uniqueLine = Object.entries(s.totals.uniqueByArm).map(([id, n]) => `${id}=${n}`).join(' ');
  const soloLine = Object.entries(s.totals.soloFindingsByArm).map(([id, n]) => `${id} findings=${n}`).join(' ');
  if (uniqueLine) process.stdout.write(`  raw uniques so far: ${uniqueLine}\n`);
  if (soloLine) process.stdout.write(`  ${soloLine} (not a "unique" — no shadow to diff against)\n`);
  // Two self-divergence readouts, and they answer the SAME question about
  // different models: how much of an arm's apparent edge is just variance?
  // Reporting only Gemini's — as this did while the solo arm was already being
  // paid for — leaves the Opus number collected but unread.
  const spread = (xs) => `mean ${(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1)}, max ${Math.max(...xs)}`;
  const div = s.totals.primaryDivergence;
  if (div.length > 0) {
    process.stdout.write(`  Gemini self-divergence (P1 vs P2): ${spread(div)} findings`
      + ' — same model, same transcript, two runs. High => buy a retry, not a model.\n');
  }
  const odiv = s.totals.opusDivergence;
  if (odiv.length > 0) {
    process.stdout.write(`  Opus self-divergence (shadow vs solo): ${spread(odiv)} findings over ${odiv.length} snapshot(s)`
      + ' — a byte-identical request run twice. Compare against opus unique before crediting the role.\n');
  }
  if (s.totals.opusDivergenceUnpaired > 0) {
    process.stdout.write(`    (${s.totals.opusDivergenceUnpaired} snapshot(s) unpaired — one Opus sample missing;`
      + ' excluded rather than scored as zero divergence)\n');
  }

  // Spend. The campaign's binding constraint, and until now the only thing it
  // measured nowhere — "why is this arm expensive?" needed a throwaway script.
  const costed = Object.entries(s.totals.costByArm);
  if (costed.length > 0) {
    const known = costed.filter(([, v]) => typeof v === 'number');
    const total = known.reduce((a, [, v]) => a + v, 0);
    const parts = costed.map(([id, v]) => `${id}=${v == null ? 'unpriced' : `$${v.toFixed(2)}`}`);
    process.stdout.write(`  spend: ${parts.join(' ')} | total $${total.toFixed(2)}`
      + (s.complete ? ` ($${(total / s.complete).toFixed(2)}/snapshot)` : '') + '\n');
    // Cost per unique finding is a FLOOR on cost-effectiveness, not the verdict:
    // §6.3 scores ACCEPTED HIGH/MED clusters, which only exist after blind
    // adjudication. Printing it unlabelled would let a cheap-and-noisy arm read
    // as a win. Uniques come from the shadow buckets, so the solo arm has none.
    for (const [id, n] of Object.entries(s.totals.uniqueByArm)) {
      const v = s.totals.costByArm[id];
      if (typeof v === 'number' && n > 0) {
        process.stdout.write(`    ${id}: $${(v / n).toFixed(2)} per raw unique — a FLOOR, not the verdict`
          + ' (the rule scores accepted HIGH/MED after adjudication)\n');
      }
    }
    if (s.totals.costUncostedSnapshots > 0) {
      process.stdout.write(`    (${s.totals.costUncostedSnapshots} snapshot(s) had an unpriced call —`
        + ' those arms show `unpriced` rather than a partial sum that reads complete)\n');
    }
  }

  // The MATCHED view, beside the strict one. The strict `opus unique` above is
  // the pre-registered metric and counts VOLUME (cross-model exact-hash never
  // matches); this is the one that can distinguish "Opus added something" from
  // "Opus said N things".
  if (s.totals.matchedRows > 0) {
    const t = s.totals.matchedTotals;
    const cov = s.totals.matchedCoverage;
    process.stdout.write(`  matched view [cohort ${s.totals.matchedCohort}, ${s.totals.matchedRows} arm-run(s)]:`
      + ` both=${t.both} shadowOnly=${t.shadowOnly} unmatchable=${t.unmatchable}`
      + ` | coverage ${cov === null ? 'n/a' : (cov * 100).toFixed(0) + '%'}\n`);
    if (t.unknownVerdicts > 0) {
      process.stdout.write(`    ${t.unknownVerdicts} run(s) below the coverage floor — read as UNKNOWN, not as a number\n`);
    }
    if (t.notApplicable > 0) {
      process.stdout.write(`    ${t.notApplicable} run(s) had no findings on either side — not-applicable, excluded from the coverage mean\n`);
    }
    for (const x of s.totals.matchedExcluded) {
      process.stdout.write(`    EXCLUDED cohort ${x.cohort} (${x.rows} run(s)) — different match config; re-run or read separately, never averaged in\n`);
    }
  }
  if (s.totals.matchedNotComputed > 0) {
    process.stdout.write(`    ${s.totals.matchedNotComputed} arm-run(s) have no matched view (disabled, or collected before the field existed)\n`);
  }

  // Two arms that sent the same request are not two configurations.
  const rerolls = [...new Set(s.totals.rerollPairs)];
  if (rerolls.length > 0) {
    process.stdout.write(`  IDENTICAL REQUESTS: ${rerolls.join(', ')} — same prompt, same model, same effort.\n`
      + '    Any gap between these arms is sampling noise plus a reporting convention, NOT a role difference.\n');
  }
  // A zero is only informative once you know the arm actually reviewed. Print the
  // verdict beside it so "lenient reviewer" and "broken arm" are never conflated
  // in the one number the stopping rule reads.
  const LABEL = { unrecorded: 'verdict not recorded (pre-dates the field)', 'no-verdict': 'NO VERDICT — suspect a BROKEN arm' };
  const zeros = entries.filter((e) => isCompleteForEntry(e)).flatMap((e) => zeroFindingArms(e)
    .map((z) => `${z.arm}: ${LABEL[z.evidence] ?? `reviewed, verdict ${z.verdict}`}`));
  if (zeros.length > 0) {
    const tally = {};
    for (const z of zeros) tally[z] = (tally[z] || 0) + 1;
    process.stdout.write('  zero-finding arms — a zero means nothing until you know the arm reviewed:\n');
    for (const [k, n] of Object.entries(tally)) process.stdout.write(`    ${k} x${n}\n`);
  }
  process.stdout.write(s.met
    ? '  TARGET MET — adjudicate, then write the verdict to docs/research/ and STOP.\n'
    : `  ${s.remaining} more to go. Raw uniques are NOT the verdict — the rule scores ACCEPTED HIGH/MED clusters.\n`);
  process.stdout.write(`  log: ${logPath}\n\n`);
}

/**
 * The experiment label written to `audit_runs.experiment_tag` (migration
 * 20260808120000). Every run this script mints is a REPLAY, never an audit of
 * the working tree — the tag is what keeps them out of the per-run rate the
 * campaign compares against.
 */
export const EXPERIMENT_TAG = 'final-review-bakeoff';

/**
 * Mint one `audit_runs` row for one arm invocation, or null when the cloud is
 * off / unreachable.
 *
 * ONE ROW PER ARM, not per snapshot. The run-level final-review columns
 * (`final_review_model`, `final_review_shadow_model`, the shadow token and
 * latency sums, `gemini_verdict`) are single-valued, so three arms sharing a
 * row would leave whichever finished last as the record of all three — the
 * three-arms-one-row shape looks tidier and destroys the comparison the arms
 * exist to make.
 *
 * Never throws: a bake-off snapshot with no cloud row is degraded (findings
 * live only in the arm's `--out` JSON) but still counts, exactly as the three
 * pre-epoch snapshots did. Refusing to collect because the store is down would
 * make the campaign hostage to it.
 */
/** Is the cloud store configured? Never throws — an unreachable store is "off". */
async function cloudIsOn() {
  try {
    const store = await import('./learning-store.mjs');
    return await store.isCloudEnabled();
  } catch { return false; }
}

async function mintArmRun(arm, { plan, mode, id }) {
  try {
    const store = await import('./learning-store.mjs');
    if (!await store.isCloudEnabled()) return null;
    await store.initLearningStore?.();
    const { generateRepoProfile } = await import('./lib/context.mjs');
    const ref = await store.resolveRepoForStore({ profile: generateRepoProfile() }).catch(() => null);
    const repoId = ref?.repoRowId ?? null;
    if (!repoId) return null;
    // `commitSha` is LOAD-BEARING, not decoration. §2.5b-i makes `audited_sha`
    // part of snapshot identity, and §2.5c verifies every adjudicated finding
    // against the tree at that revision — so a run without one makes its whole
    // snapshot unadjudicatable, and `campaign.mjs reconcile` correctly refuses
    // to promote it.
    //
    // It was omitted here, so `audit_runs.commit_sha` was NULL on every bake-off
    // run ever recorded and no snapshot could reach the campaign spine. Nothing
    // caught it: unit tests mint no runs, and the refusal only appears the first
    // time a real collection is promoted. Found on exactly that run, 2026-08-10.
    const { gitCommitSha } = await import('./lib/vcs.mjs');
    const head = gitCommitSha(process.cwd());
    return await store.recordRunStart(repoId, plan, mode === 'plan' ? 'plan' : 'code', {
      scopeMode: mode === 'plan' ? 'plan' : 'diff',
      experimentTag: EXPERIMENT_TAG,
      // Structured result, never a throw — an unreadable HEAD degrades to a
      // run with no sha (unpromotable, and visibly so) rather than losing the
      // whole registration and with it the findings.
      ...(head.ok ? { commitSha: head.sha } : {}),
    });
  } catch (err) {
    process.stderr.write(`  [bakeoff] run registration failed for arm ${arm.id} (findings will be file-only): ${err.message}\n`);
    return null;
  }
}

/**
 * The argv for one arm's `gemini-review` invocation. Pure, so the `--run-id`
 * wiring is assertable without spawning a reviewer or a database.
 *
 * @param {{id: string, args?: string[]}} arm
 * @param {{transcript: string, plan: string, mode?: string|null, out: string, runId?: string|null, envelopeScope?: string|null, campaignDigest?: string|null}} ctx
 */
export function buildArmArgs(arm, { transcript, plan, mode, out, runId, envelopeScope = null, campaignDigest = null }) {
  const args = ['scripts/gemini-review.mjs', 'review', plan, transcript, '--out', out, ...(arm.args || [])];
  if (mode) args.push('--mode', mode);
  // Without this, `runShadowAndPersist` returns early at `if (!runId) return`
  // and the ENTIRE cloud write is a silent no-op — the defect that left
  // snapshots 2-3 with `final_review_shadow_model = NULL` and no findings to
  // adjudicate, so §6.3's "accepted HIGH/MED clusters" had nothing to score.
  //
  // Omitted rather than passed as an empty string when registration failed: a
  // blank `--run-id` would be consumed as the flag's VALUE and silently write
  // nowhere, which is the same silence with an extra step.
  if (runId) args.push('--run-id', runId);
  // Campaign scope binding (plan KD-6). Passed EXPLICITLY per arm rather than
  // via env — a child spawned with an env var could not be told apart from an
  // operator's own FINAL_REVIEW_SHADOW_SCOPE, which is exactly the ambient-env
  // failure mode this whole mechanism exists to close. Both flags travel
  // together: envelopeScope is meaningless provenance without knowing WHICH
  // signed cohort declared it.
  if (envelopeScope) args.push('--envelope-scope', envelopeScope);
  if (campaignDigest) args.push('--campaign-digest', campaignDigest);
  return args;
}

function runArm(arm, { transcript, plan, mode, outDir, id, runId, envelopeScope, campaignDigest }) {
  const out = path.join(outDir, `${id}-${arm.id}.json`);
  const args = buildArmArgs(arm, { transcript, plan, mode, out, runId, envelopeScope, campaignDigest });
  process.stderr.write(`  [bakeoff] arm ${arm.id}…\n`);
  const r = spawnSync(process.execPath, args, {
    encoding: 'utf-8',
    env: { ...process.env, ...arm.env, GEMINI_REVIEW_TIMEOUT_MS: process.env.GEMINI_REVIEW_TIMEOUT_MS || '300000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.status !== 0) return { error: `exit ${r.status}`, stderrTail: String(r.stderr || '').slice(-400) };
  try { return readArmResult(out); } catch (err) { return { error: `unreadable result: ${err.message}` }; }
}

/**
 * Collector-side pre-flight verification (plan §8, Phase 6). The schema's
 * semanticRules already REQUIRE a `pass` disposition for any campaign
 * declaring an xAI arm; this is the second half — RECOMPUTING the artifact's
 * sha256 rather than trusting the recorded one, because a recorded hash
 * nobody recomputes is decoration (this repo's own "control the write side,
 * not just the read" lesson). Pure modulo the injected file reads, so it is
 * unit-testable without a real campaign directory or network call.
 *
 * @param {{artifact:string, sha256:string, disposition:string}|undefined} preflight
 * @param {{exists?: (p:string)=>boolean, readFile?: (p:string)=>Buffer}} [deps]
 * @returns {{ok: boolean, checked: boolean, reason?: string, artifact?: string}}
 *   `checked:false` means no preflight was declared (no xAI arm) — nothing to verify.
 */
export function verifyPreflightArtifact(preflight, { exists = fs.existsSync, readFile = fs.readFileSync } = {}) {
  if (!preflight) return { ok: true, checked: false };
  if (!exists(preflight.artifact)) {
    return { ok: false, checked: false, reason: `campaign declares a preflight artifact that does not exist: ${preflight.artifact}` };
  }
  const actualSha256 = crypto.createHash('sha256').update(readFile(preflight.artifact)).digest('hex');
  if (actualSha256 !== preflight.sha256) {
    return {
      ok: false, checked: false,
      reason: `preflight artifact ${preflight.artifact} has been modified since the campaign was signed `
        + `(recorded sha256 ${preflight.sha256}, actual ${actualSha256}) — refusing to collect. `
        + 're-run scripts/grok-effort-preflight.mjs and update the campaign config with the new digest.',
    };
  }
  if (preflight.disposition !== 'pass') {
    // Belt-and-braces — the schema's semanticRules already reject this shape,
    // so reaching here means the config was hand-edited after validation or
    // loaded via a path that skipped it.
    return { ok: false, checked: false, reason: `preflight disposition is "${preflight.disposition}", not "pass" — refusing to collect` };
  }
  return { ok: true, checked: true, artifact: preflight.artifact };
}

async function main() {
  assertKnownFlags(process.argv, KNOWN_FLAGS, { cli: 'bakeoff-collect' });
  const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? null : (process.argv[i + 1] ?? null); };
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write('Usage: node scripts/bakeoff-collect.mjs --transcript <path> --plan <path> [--mode plan|code]\n'
      + '       node scripts/bakeoff-collect.mjs --progress\n');
    return;
  }
  const target = Number(arg('target') || DEFAULT_TARGET);
  if (process.argv.includes('--progress')) { printProgress(LOG_PATH, target, arg('campaign') ?? null); return; }

  const transcript = arg('transcript');
  const plan = arg('plan');
  if (!transcript || !plan) throw new ArgvError('--transcript <path> and --plan <path> are both required (or use --progress)');
  for (const p of [transcript, plan]) if (!fs.existsSync(p)) throw new ArgvError(`not found: ${p}`);

  const id = snapshotId(transcript);
  const force = process.argv.includes('--force');
  const existing = readLog().find((e) => e.snapshotId === id);
  if (existing && isCompleteForEntry(existing) && !force) {
    process.stderr.write(`  [bakeoff] snapshot ${id} already collected and complete — skipping (re-runs would double-count)\n`
      + '  Pass --force to re-collect: it SUPERSEDES rather than overwrites, so the prior attempt stays readable and its spend still counts.\n');
    // `resolved` is not bound yet at this early return, so scope the readout
    // by the entry's own campaign — which is the authoritative answer anyway.
    printProgress(LOG_PATH, target, existing.campaignId ?? null);
    return;
  }
  if (force && existing) {
    // §5's resume table: `--force` APPENDS a retry, it never overwrites. The
    // supersede itself happens at promotion time (`campaign.mjs reconcile`),
    // where the store can stamp the prior row `superseded_at` and insert
    // attempt N+1 in one transaction. Marking the log entry is what carries the
    // intent across that boundary — without it reconcile cannot tell a
    // deliberate re-collection from a replay of the same one, and correctly
    // refuses to double-count.
    process.stderr.write(`  [bakeoff] --force: re-collecting ${id}; the prior attempt will be superseded, never deleted\n`);
  }

  // Arms + D4 collision classification resolve BEFORE the output directory is
  // made and before any arm is spawned: a refusal must cost nothing.
  const resolved = resolveArms({ campaignId: arg('campaign') });
  const ARMS = resolved.arms;
  const envelopeScope = resolved.config?.controls?.envelopeScope ?? null;
  // `--campaign` in argv IS the campaign-active signal downstream — matches
  // gemini-review.mjs's own rule (--campaign-digest's presence, not how scope
  // arrived) so the two processes agree on what "a campaign is active" means.
  const campaignDigest = resolved.config ? resolved.configDigest : null;

  // Collector-side pre-flight verification (plan §8, Phase 6) — BEFORE any
  // arm spawns, cost nothing on refusal, same as the collision check above.
  const preflightCheck = verifyPreflightArtifact(resolved.config?.controls?.preflight);
  if (!preflightCheck.ok) throw new ArgvError(`[bakeoff] ${preflightCheck.reason}`);
  if (preflightCheck.checked) {
    process.stderr.write(`  [bakeoff] preflight verified: ${preflightCheck.artifact} (sha256 matches, disposition pass)\n`);
  }

  const outDir = path.join('.audit', 'bakeoff', id);
  fs.mkdirSync(outDir, { recursive: true });
  process.stderr.write(`  [bakeoff] snapshot ${id} — ${ARMS.length} arms on ${path.basename(transcript)} [${resolved.source}]\n`);
  if (resolved.lock) {
    process.stderr.write(`  [bakeoff] lock ${resolved.lock.lockDigest} (config ${resolved.configDigest}, prompt-template source: ${resolved.lock.promptTemplateSource})\n`);
  }

  const arms = {};
  for (const a of ARMS) {
    const runId = await mintArmRun(a, { plan, mode: arg('mode'), id });
    arms[a.id] = { ...runArm(a, { transcript, plan, mode: arg('mode'), outDir, id, runId, envelopeScope, campaignDigest }), runId: runId ?? null };
  }

  const entry = {
    snapshotId: id,
    // Both stamped, and `isComplete` still gates on CONTRACT_EPOCH alone.
    // §2.5b's plan is for the derived lock to REPLACE the hand-maintained
    // string, but flipping the gate here would orphan every existing e2 row on
    // the next read — a data-meaning change that belongs with the cohort store
    // that can record the supersession, i.e. Cluster B. Stamping both now means
    // the rows collected in between carry the digest the new gate will need,
    // so the switchover reads history rather than discarding it.
    contractEpoch: CONTRACT_EPOCH,
    ...(resolved.lock ? {
      campaignId: resolved.config.id,
      configDigest: resolved.configDigest,
      lockDigest: resolved.lock.lockDigest,
      promptTemplateSource: resolved.lock.promptTemplateSource,
      requestFingerprints: resolved.fingerprints,
      replicateArmIds: ARMS.filter((a) => a.replicate).map((a) => a.id),
    } : {}),
    collectedAt: new Date().toISOString(),
    // Read by `campaign.mjs reconcile` to promote this entry as a SUPERSEDING
    // attempt rather than skipping it as already-recorded.
    ...(force && existing ? { forced: true } : {}),
    transcript: path.basename(transcript),
    plan,
    arms,
  };
  // Append-only + atomic: a crash mid-write can lose the newest line but never
  // corrupt earlier snapshots, and readLog tolerates a torn tail.
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  const prior = fs.existsSync(LOG_PATH) ? fs.readFileSync(LOG_PATH, 'utf-8') : '';
  atomicWriteFileSync(LOG_PATH, `${prior}${JSON.stringify(entry)}\n`);

  for (const [k, v] of Object.entries(arms)) {
    process.stderr.write(`  [bakeoff] ${k}: ${v.error ? `ERROR ${v.error}` : `${v.shadowState} ${v.shadowModel} buckets=${JSON.stringify(v.buckets)}`}\n`);
  }

  // Anti-green on the CLOUD half. Registration is best-effort by design, but
  // "every arm ran and none of it was persisted" must never pass quietly: the
  // findings would exist only as files, `final-review-stats` would show nothing
  // to adjudicate, and the snapshot would still count — which is exactly the
  // state snapshots 2-3 were left in, undetected for a week. Found the hard way
  // on the first real run of this code path: a wrong import specifier made
  // every mint throw, and the failure was invisible behind a buffered pipe.
  const registered = Object.values(arms).filter((v) => v.runId).length;
  if (registered === 0 && await cloudIsOn()) {
    process.stderr.write('  [bakeoff] WARNING: cloud is enabled but NO arm registered an audit_runs row —\n'
      + '  findings are file-only and will not appear in `final-review-stats --worksheet`.\n'
      + '  Fix registration and re-collect; this snapshot cannot be adjudicated as-is.\n');
  } else if (registered < Object.keys(arms).length && await cloudIsOn()) {
    process.stderr.write(`  [bakeoff] NOTE: ${registered}/${Object.keys(arms).length} arms registered a cloud run — the rest are file-only.\n`);
  }
  // Judged against the campaign this entry was collected under, not an ambient
  // default (see scopeForEntry). And it names the arm: "an arm did not run"
  // printed directly under four lines each saying an arm HAD run, which is a
  // self-contradiction the reader has to debug rather than a diagnosis.
  const entryScope = scopeForEntry(entry);
  if (!entryScope) {
    process.stderr.write(`  [bakeoff] CANNOT JUDGE completeness — entry names campaign "${entry.campaignId}", which does not resolve.\n`
      + '  This is not "an arm did not run"; the snapshot is unjudgeable until the campaign is resolvable again.\n');
  } else if (!isComplete(entry, entryScope.arms, entryScope.expectedScope)) {
    const missing = entryScope.arms
      .filter((a) => { const r = entry?.arms?.[a.id]; return !r || r.error || (a.solo ? !r.primaryVerdict : r.shadowState !== 'ran'); })
      .map((a) => a.id);
    process.stderr.write(`  [bakeoff] INCOMPLETE — this snapshot does NOT count toward N.${missing.length ? ` Arms that did not run: ${missing.join(', ')}.` : ' Every arm ran; the envelope-scope binding or contract epoch is what failed.'}\n`);
  }
  printProgress(LOG_PATH, target, resolved.config?.id ?? null);
}

const invokedDirectly = (() => {
  try {
    const a = (process.argv[1] || '').replace(/\\/g, '/').toLowerCase();
    return a.endsWith('/bakeoff-collect.mjs');
  } catch { return false; }
})();

if (invokedDirectly) {
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }
  // `main` is async since run registration talks to the store — an unawaited
  // rejection here would exit 0 with the log unwritten, which is precisely the
  // "an arm never ran reads as found nothing" failure the counter guards against.
  main().catch((err) => {
    if (err instanceof ArgvError || err?.code === 'ARGV_ERROR') { process.stderr.write(`${err.message}\n`); process.exit(2); }
    process.stderr.write(`Error: ${err.message}\n`); process.exit(1);
  });
}

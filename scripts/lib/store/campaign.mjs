/**
 * @fileoverview Campaign store seam — the relational spine, the BLIND worksheet,
 * and the verdict/override writers.
 *
 * Plan: docs/plans/model-comparison-campaigns.md §2.5c (adjudication protocol),
 * §2.5c-i (metric attribution), §7a (persistence model).
 *
 * Mirrors `store/upstream-issues.mjs`: cloud-off is a graceful `{ok:true,
 * cloud:false}` no-op, every write is wrapped, and no SQL leaks into the CLI.
 *
 * **The blindness contract lives here, and it is a whitelist.** Omitting
 * `source_model` from a projection is necessary and nowhere near sufficient:
 * finding `detail` is model-authored prose that routinely names its own
 * provider. So the worksheet row is CONSTRUCTED from a closed field list rather
 * than derived by deleting keys from a wider row — a column added to
 * `audit_findings` next year must not auto-leak into an adjudication worksheet —
 * and every free-text field passes a redactor before it is rendered.
 *
 * @module scripts/lib/store/campaign
 */

import crypto from 'node:crypto';
import {
  many, one, insertReturning, updateWhere, upsert, withTx, query,
} from '../db/query.mjs';
// Re-exported: `promoteFromLog` (campaign/promote.mjs, §7 Phase 3) needs to
// wrap several of THIS module's own calls (acquireSnapshotLock,
// upsertSnapshot, recordArmRun, markSnapshotExcluded) in one transaction —
// a normal need for a store consumer, not a layering violation, since it
// still only ever touches persistence through this module's own functions.
export { withTx };
import { isCloudEnabled } from './repo.mjs';
import { STATIC_POOL, OSS_POOL, parseClaudeModel, parseGeminiModel, parseOpenAIModel, modelFamily } from '../model-resolver.mjs';
import { OSS_PRICING } from '../model-pricing.mjs';
import { FINDING_MATCH_SCHEMA_VERSION } from '../config.mjs';
import { terminalEvent } from '../campaign/verdict.mjs';
import { hmacKeyRefFor } from '../campaign/config.mjs';
import { verdictPairError } from '../campaign/adjudicate.mjs';

// ── The blind DTO ───────────────────────────────────────────────────────────

/**
 * The CLOSED shape of one worksheet row. Anything not listed here does not
 * reach the adjudicator, by construction rather than by review.
 *
 * `evidenceExcerpt` is present-but-usually-null and that is stated rather than
 * hidden: `audit_findings` has no separate excerpt column — `detail_snapshot`
 * (capped at 600 chars by `recordFindings`) is the only model prose the store
 * retains. The field exists for callers that DO have an excerpt (an arm's raw
 * `--out` JSON), and `detailTruncated` tells the reader the detail was capped,
 * so a short detail is never mistaken for a complete one.
 */
export const BLIND_ROW_FIELDS = Object.freeze([
  'worksheetRowId', 'category', 'section', 'detail', 'evidenceExcerpt',
  'severity', 'citedSources', 'detailTruncated',
]);

/** The cap `recordFindings` applies to `detail_snapshot`. */
const DETAIL_SNAPSHOT_CAP = 600;

/** Provider names that carry arm signal. `meta` is deliberately absent — it
 *  matches inside ordinary words ("metadata") and redacting it would corrupt
 *  the prose the adjudicator has to read. */
const PROVIDER_TERMS = Object.freeze([
  'openai', 'anthropic', 'gemini', 'claude', 'openrouter', 'moonshotai',
  'moonshot', 'deepseek', 'qwen', 'zhipu', 'mistral', 'llama', 'grok',
  'kimi', 'opus', 'sonnet', 'haiku', 'gpt', 'glm',
]);

/** Shortest term the redactor will act on. A 1-2 char token matches inside
 *  ordinary words, and over-redaction that destroys the evidence is not the
 *  safe direction — it makes the adjudication unperformable rather than blind. */
const MIN_REDACTABLE_TERM = 3;

// ── D1c: derived-per-arm redaction coverage ─────────────────────────────────
//
// `PROVIDER_TERMS` above is a hand-maintained vocabulary and stays exactly as
// it was — this section does not touch or replace it. What it closes is the
// gap `PROVIDER_TERMS` cannot: a NEW arm whose vendor was never added to that
// list still leaks its identity narratively (a finding saying "Cohere found
// three issues") even though the arm's own model STRING is already redacted
// via `armModels` below. `resolveProviderIdentity` + `PROVIDER_ALIASES` derive
// coverage from the arm's OWN declaration, so adding an arm is one edit, not
// two — the second one invisible from the file being edited.

/** Bare model ids with no parseable/slug identity (D1c source 3). Kept small
 *  and explicit rather than guessed — every entry here was hit by a real
 *  committed arm (`grok-4.6`, no vendor segment, no version-parser match). */
const STATIC_RESIDUE = Object.freeze([
  { re: /^grok(-|$)/i, provider: 'xai' },
  // Added when the qwen/deepseek bake-off arms moved off the OpenRouter
  // `vendor/model` slug onto Alibaba Cloud's native bare ids (2026-08-17,
  // `qwen3.8-max` / `deepseek-v4-pro-0813` — no `/`, so source 2 above no
  // longer matches them and they would otherwise fall through to "unresolvable").
  { re: /^qwen(-|\d|$)/i, provider: 'qwen' },
  { re: /^deepseek(-|$)/i, provider: 'deepseek' },
]);

/**
 * Narrative alias vocabulary keyed by CANONICAL provider, not by arm — a
 * handful of providers, not N arms (D1c). A provider with no curated alias
 * redacts on its own resolved name only (`moonshotai`, `deepseek`, `qwen`,
 * `xai` carry none today); this is where a genuinely new alias is added,
 * once, for every arm that provider covers.
 */
const PROVIDER_ALIASES = Object.freeze({
  anthropic: ['anthropic', 'claude', 'opus', 'sonnet', 'haiku'],
  google: ['google', 'gemini'],
  openai: ['openai', 'gpt'],
});

/**
 * Provider identity for a declared arm's MODEL STRING. Three ordered
 * sources (D1c), each tried in turn:
 *  1. **First-party parsers already in this repo** — `parseClaudeModel` /
 *     `parseGeminiModel` / `parseOpenAIModel` for a fully-versioned id, with a
 *     bare-prefix fallback for a still-first-party but unversioned/sentinel-
 *     shaped string. Needed because this repo's OWN committed campaigns
 *     declare the literal `"claude-opus"` (no version digits) — the strict
 *     parser correctly refuses to match that as a versioned release, but it
 *     is unambiguously Anthropic and must not read as unresolvable.
 *  2. **The OpenRouter `vendor/model` slug** — the segment before the first
 *     `/`, lowercased. Covers gateway ids by construction
 *     (`moonshotai/kimi-k2-thinking`, `qwen/qwen3.8-max`).
 *  3. **`STATIC_RESIDUE`** — a small explicit table for known bare ids
 *     neither source covers (`grok-4.6` → `xai`).
 *
 * @param {string} model
 * @returns {string|null} a provider key, or `null` when unresolvable
 */
export function resolveProviderIdentity(model) {
  if (typeof model !== 'string' || model.length === 0) return null;
  const m = model.toLowerCase();
  if (parseClaudeModel(model) || /^claude(-|$)/.test(m)) return 'anthropic';
  if (parseGeminiModel(model) || /^gemini(-|$)/.test(m)) return 'google';
  if (parseOpenAIModel(model) || /^gpt(-|$)/.test(m)) return 'openai';
  const slash = model.indexOf('/');
  if (slash > 0) return model.slice(0, slash).toLowerCase();
  for (const { re, provider } of STATIC_RESIDUE) {
    if (re.test(m)) return provider;
  }
  return null;
}

/**
 * The redaction term set for ONE declared arm (D1c). An explicit
 * `arm.redactionTerms` is ADDITIVE, never a replacement — bake-off-campaign
 * gate finding G2: a version that let a declared override REPLACE the
 * derived provider aliases meant any arm declaring its own extra term (e.g.
 * a project codename) silently stopped redacting the standard provider name
 * too, under-redacting the blind-adjudication worksheet. Blinding is a
 * security boundary; a declared override must only ever ADD terms, never
 * drop ones auto-derivation would have caught. When `resolveProviderIdentity`
 * can't resolve at all, the declared override is the sole (still mandatory)
 * source — **unresolvable-and-undeclared is a REFUSAL, not a silent gap** — a
 * campaign with an unredactable arm is not run half-blind, it is not run
 * (fail-closed, the same posture `resolveAndClassify` already applies to
 * path classification).
 *
 * @param {{id: string, model: string, redactionTerms?: string[]}} arm
 * @returns {string[]}
 * @throws {Error} when unresolvable and no override is declared
 */
export function armRedactionTerms(arm) {
  const override = Array.isArray(arm?.redactionTerms) ? arm.redactionTerms : [];
  const provider = resolveProviderIdentity(arm?.model);
  const derived = provider ? (PROVIDER_ALIASES[provider] ?? [provider]) : [];
  if (derived.length === 0 && override.length === 0) {
    throw new Error(
      `[campaign] arm "${arm?.id}" (model "${arm?.model}") has no resolvable provider identity for blind `
      + 'adjudication — declare an explicit "redactionTerms": ["..."] on this arm in the campaign config.',
    );
  }
  return Array.from(new Set([...derived, ...override]));
}

function flattenPool(pool) {
  const out = [];
  for (const v of Object.values(pool || {})) {
    if (Array.isArray(v)) out.push(...v);
    else if (v && typeof v === 'object') out.push(...flattenPool(v));
    else if (typeof v === 'string') out.push(v);
  }
  return out;
}

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * Build the redaction pass applied to `detail` + `evidenceExcerpt`.
 *
 * Terms: every model id the resolver knows (`STATIC_POOL` ∪ `OSS_POOL` ∪
 * `OSS_PRICING` keys) ∪ the campaign's own arm ids and arm models ∪ a provider
 * vocabulary. Longest-first so a longer id is not left half-redacted by a
 * shorter prefix.
 *
 * **One placeholder, not a per-model alias.** `[MODEL-A]` is a single literal
 * for every model id: a stable per-model alias would let the adjudicator
 * correlate rows and re-derive which arm spoke, restoring exactly the signal
 * the redaction removes.
 *
 * **`citedSources` is deliberately NOT redacted.** It is repo source at a fixed
 * sha, identical whichever arm cited it, so it carries no arm signal — and this
 * repo's own source legitimately contains model ids (`model-resolver.mjs`'s
 * `STATIC_POOL`), so redacting it would corrupt the evidence the adjudicator
 * exists to read. Blindness is about which arm spoke, not which strings exist
 * in the tree.
 *
 * **`arms` also drives D1c's derived provider coverage.** Each declared arm's
 * `resolveProviderIdentity(model)` (or its explicit `redactionTerms`
 * override) is resolved HERE, at redactor-construction time — fail-closed: an
 * arm with no resolvable provider and no override throws, refusing to build a
 * half-blind redactor rather than silently shipping one. This is additive to
 * `PROVIDER_TERMS` below, never a replacement for it.
 *
 * @param {{arms?: Array<{id:string, model:string, redactionTerms?:string[]}>, extraTerms?: string[]}} [opts]
 * @returns {(text: string|null|undefined) => string|null}
 */
export function buildModelRedactor({ arms = [], extraTerms = [] } = {}) {
  const armIds = arms.map((a) => a?.id);
  const armModels = arms.map((a) => a?.model);
  const modelTerms = new Set();
  const catalogue = [
    ...flattenPool(STATIC_POOL), ...flattenPool(OSS_POOL), ...Object.keys(OSS_PRICING),
    // Pool KEYS are provider names the resolver genuinely knows (`google`,
    // `openai`, `anthropic`) and `flattenPool` walks values only, so without
    // this a finding saying "Google's model" passed through untouched while
    // "gemini" was redacted — half a vocabulary reads as a whole one.
    ...Object.keys(STATIC_POOL), ...Object.keys(OSS_POOL),
    // A vendor namespace is a provider name: `moonshotai/kimi-k2` names its
    // vendor in the id itself.
    ...Object.keys(OSS_PRICING).map((k) => String(k).split('/')[0]),
    ...extraTerms,
  ];
  for (const id of catalogue) {
    if (typeof id === 'string' && id.length >= MIN_REDACTABLE_TERM) modelTerms.add(id.toLowerCase());
  }
  for (const t of PROVIDER_TERMS) modelTerms.add(t);
  // **Arm models are NEVER dropped for being short.** They went through the
  // same `>= MIN_REDACTABLE_TERM` filter as the catalogue, so a two-character
  // model id — which the config schema permits (`model: z.string().min(1)`) —
  // was silently excluded from the term set and stayed visible in the
  // worksheet. A length floor is a readability heuristic for the ambient
  // catalogue; it must never decide whether THIS campaign's own arms are blind.
  // Short ones join the boundary-guarded set below instead of vanishing.
  const armTerms = new Set(armIds.filter((a) => typeof a === 'string' && a.length > 0).map((a) => a.toLowerCase()));
  // D1c: each declared arm's DERIVED provider terms (or its explicit
  // override) — fail-closed, so a vendor with no coverage anywhere refuses
  // the whole redactor rather than silently shipping a partially-blind one.
  // Boundary-guarded like arm ids (below): these are discrete narrative words
  // ("claude", "grok"), not required to embed-match inside a versioned model
  // string — `armModels` above already covers that case as a plain substring.
  const derivedTerms = new Set();
  for (const arm of arms) {
    for (const t of armRedactionTerms(arm)) derivedTerms.add(String(t).toLowerCase());
  }
  for (const m of armModels) {
    if (typeof m !== 'string' || m.length === 0) continue;
    modelTerms.add(m.toLowerCase());
    // M6: an OpenRouter `vendor/model` slug redacted only as the FULL string
    // leaves the bare model alias exposed — prose naming just "command-r"
    // (no "cohere/" prefix) survived a redactor that only knew
    // "cohere/command-r". Add the post-slash segment too, in the SAME
    // boundary-guarded bucket as the provider terms above (a discrete alias,
    // not a token meant to embed-match inside an unrelated longer word) —
    // and rendered `[MODEL-A]`, never `[ARM]`: a model alias is not a
    // campaign-local label.
    const slash = m.indexOf('/');
    if (slash > 0 && slash < m.length - 1) derivedTerms.add(m.slice(slash + 1).toLowerCase());
  }

  const all = [...modelTerms, ...armTerms, ...derivedTerms].sort((a, b) => b.length - a.length);
  if (all.length === 0) return (text) => (text == null ? null : String(text));
  // **Every ARM ID is token-boundaried; every MODEL/PROVIDER term is a plain
  // substring.** The split is by KIND, not by length, and that is the precise
  // rule: an arm id is a discrete campaign-local label that appears as a whole
  // word, so bounding it costs nothing and stops it rewriting the inside of
  // ordinary words — a bare match on a one-character id `a` rewrites every
  // letter `a` in the finding, which does not make the row blind, it makes it
  // unreadable, and an adjudicator that cannot read the claim cannot verify it.
  // A model id is the opposite: it must still redact when embedded in a longer
  // token (`claude-opus-4-8-preview`), so it stays substring-matched.
  //
  // TWO independent reasons to bound a term, and the set is their UNION —
  // getting this wrong in either direction was caught by a test:
  //   - it is an ARM ID (a discrete campaign-local label, any length); and
  //   - it is SHORT (under `MIN_REDACTABLE_TERM`), whoever owns it — a
  //     two-character arm MODEL like `g5` shreds `g5x` exactly as a short arm
  //     id shreds ordinary words, and short arm models are deliberately never
  //     dropped for being short (see above), so they must be bounded instead.
  // An earlier version split on LENGTH alone, which left every arm id of three
  // or more characters matching mid-word for no reason — the length was
  // standing in for the kind. Splitting on KIND alone then un-bounded the short
  // models. Both conditions are load-bearing.
  const needsBoundary = (t) => armTerms.has(t) || derivedTerms.has(t) || t.length < MIN_REDACTABLE_TERM;
  const boundaried = all.filter(needsBoundary);
  const plain = all.filter((t) => !needsBoundary(t));
  const parts = [];
  if (plain.length > 0) parts.push(plain.map(escapeRegex).join('|'));
  if (boundaried.length > 0) parts.push(`(?<![a-z0-9-])(?:${boundaried.map(escapeRegex).join('|')})(?![a-z0-9-])`);
  const re = new RegExp(parts.join('|'), 'gi');
  return (text) => {
    if (text == null) return null;
    return String(text).replace(re, (hit) => (armTerms.has(hit.toLowerCase()) ? '[ARM]' : '[MODEL-A]'));
  };
}

/**
 * Construct one blind row BY WHITELIST from an unblinded finding row.
 *
 * @param {{worksheetRowId: string, category?: string, primaryFile?: string|null,
 *   detail?: string|null, evidenceExcerpt?: string|null, severity?: string,
 *   citedSources?: Array<object>}} src
 * @param {(t: string|null|undefined) => string|null} redact
 */
export function buildBlindRow(src, redact) {
  const detail = src.detail ?? '';
  return Object.freeze({
    worksheetRowId: src.worksheetRowId,
    category: redact(src.category ?? null),
    // `section` IS redacted, and the reasoning that said otherwise was wrong on
    // the facts. It looks like a file path — repo source, identical whichever
    // arm cited it, therefore no arm signal — but `recordFindings` stores
    // `f._primaryFile || f.section`, so whenever the resolved path is absent the
    // raw model-authored SECTION prose lands in the column. Measured against the
    // live store 2026-08-10: 43 rows already carry a provider term there, e.g.
    // "§4 phase 5; §6 'the gemini census must discover, not enumerate'" and
    // "Audit transcript (rounds: [], claude_resolutions[0])". Every one of those
    // would have reached the adjudicator naming a model.
    //
    // Redacting costs nothing that matters: citation resolution reads the
    // UNREDACTED `primary_file` straight off the store row, never this field, so
    // the paths that resolve sources are unaffected.
    section: redact(src.primaryFile ?? null),
    detail: redact(detail),
    evidenceExcerpt: redact(src.evidenceExcerpt ?? null),
    severity: src.severity ?? null,
    // Never redacted — see buildModelRedactor's docstring.
    citedSources: Array.isArray(src.citedSources) ? src.citedSources : [],
    detailTruncated: detail.length >= DETAIL_SNAPSHOT_CAP,
  });
}

// ── Worksheet identity + the calibration sample ─────────────────────────────

// `hmacKeyRefFor` MOVED to `../campaign/config.mjs` on 2026-08-18 and re-exported
// here so every existing caller is unchanged. It derives an env-var NAME from a
// campaign id — a campaign-identity concern, not a persistence one — and the
// pinned-revision fixture's credential preflight (`shared-lib`) needs the same
// derivation. Re-spelling it there would have been a second source of truth for
// a name the store writes into `campaign_worksheets`; importing it FROM the
// store would have been a `shared-lib -> stores` layering violation. Moving the
// function is the refactor the layering oracle's "refactor > retag > declare"
// order asks for.
export { hmacKeyRefFor };

/**
 * Read the campaign's HMAC key from the environment.
 *
 * **An absent key is a hard refusal, never a regenerated key.** A new key
 * produces different `worksheetRowId`s, which would orphan every human
 * disposition already recorded against the old ones — silently, since the new
 * ids would look perfectly valid. Rotation is likewise unsupported and refused
 * with an explanation rather than half-implemented: a rotated key re-randomises
 * the calibration sample, and no current requirement justifies the migration
 * machinery needed to do that safely.
 */
export function requireCampaignHmacKey(campaignKey, env = process.env) {
  const ref = hmacKeyRefFor(campaignKey);
  const key = env[ref];
  if (!key) {
    throw new Error(
      `[campaign] ${ref} is not set. The worksheet HMAC key is per-campaign and lives in your gitignored .env. `
      + 'Generate one ONCE with `node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"` and add it. '
      + 'Refusing to mint a new key: a different key produces different worksheetRowIds and would orphan every human disposition already recorded.',
    );
  }
  return key;
}

/** One-way mapping finding → worksheet row. There is no agent-reachable path
 *  back: the agent returns the opaque id and the store maps it. */
export function worksheetRowIdFor(findingId, key) {
  return crypto.createHmac('sha256', key).update(String(findingId)).digest('hex').slice(0, 24);
}

/**
 * Per-row calibration filter (§2.5c.5, Gemini/G6).
 *
 * A row is in the sample iff `HMAC(campaignId:worksheetRowId) / 2^32 < rate`.
 * Deterministic, reproducible across machines, and — the property that matters —
 * **stable as the campaign grows**, which a top-N sort is not: campaigns collect
 * snapshots continuously, so `n` grows, and a row in the top 2 at `n=10` can
 * fall out at `n=15`. That left only bad options — recompute and the assignment
 * churns, overwriting human review work already done; freeze it and the stored
 * boolean no longer means what the rule says it means. Evaluating each row
 * against its own hash removes `n` from the decision entirely.
 *
 * Expected size is `rate × n` rather than exactly `ceil(rate × n)`. That is the
 * correct trade: an exact count is worth nothing here, and stability is worth
 * the campaign's human effort.
 */
export function calibrationScore(worksheetRowId, campaignId, key) {
  const hex = crypto.createHmac('sha256', key).update(`${campaignId}:${worksheetRowId}`).digest('hex').slice(0, 8);
  return parseInt(hex, 16) / 2 ** 32;
}

export function isCalibrationSelected(worksheetRowId, campaignId, key, rate) {
  return calibrationScore(worksheetRowId, campaignId, key) < rate;
}

/** Minimum reviewed rows per arm, or all of them when the arm has fewer. */
export const CALIBRATION_MIN_PER_ARM = 5;

/**
 * Assign the calibration sample: the per-row filter, then a deterministic
 * top-up to `CALIBRATION_MIN_PER_ARM`, **stratified per arm** so a lopsided arm
 * cannot be under-sampled.
 *
 * **Two stability properties live in two different places, and the plan asserted
 * both of one.** The FILTER is a property of the row alone: `HMAC(row) < rate`
 * does not mention `n`, so a row's filter membership never changes as the
 * campaign grows — that is the churn fix, and it holds here.
 *
 * The TOP-UP cannot have that property, and no implementation of it can. An
 * exact per-arm minimum is a rank over the current population: "the 5
 * lowest-scoring rows" is a different set once a lower-scoring row arrives, so a
 * previously topped-up row is displaced. Growing the population from 8 to 12
 * demonstrably unassigns a row (asserted in `tests/campaign-adjudication.test.mjs`).
 * Choosing an exact minimum and choosing population-independence is choosing two
 * incompatible things.
 *
 * So the property that actually protects completed human review work —
 * **a row once assigned is never unassigned** — is enforced one layer down, by
 * `upsertWorksheetRows`'s `calibration_assigned OR EXCLUDED.calibration_assigned`.
 * The assignment is PERSISTED, and the persisted value only ever ratchets up.
 * This function is deterministic given a population; the store is what makes the
 * campaign's assignment monotonic across the campaign's life. Both facts are
 * tested, each where it holds.
 *
 * The frame is BOTH rulings — accepted and dismissed. Sampling only accepted
 * rows would never catch a false dismissal, which is exactly how an 86%
 * dismissal rate could hide a real finding.
 *
 * @param {Array<{worksheetRowId: string, armId: string}>} rows
 * @param {{campaignId: string, key: string, rate: number, minPerArm?: number}} opts
 * @returns {Map<string, boolean>} worksheetRowId → assigned
 */
export function assignCalibrationSample(rows, { campaignId, key, rate, minPerArm = CALIBRATION_MIN_PER_ARM }) {
  const assigned = new Map();
  const byArm = new Map();
  for (const row of rows || []) {
    const score = calibrationScore(row.worksheetRowId, campaignId, key);
    const selected = score < rate;
    assigned.set(row.worksheetRowId, selected);
    if (!byArm.has(row.armId)) byArm.set(row.armId, []);
    byArm.get(row.armId).push({ ...row, score, selected });
  }
  for (const armRows of byArm.values()) {
    const target = Math.min(minPerArm, armRows.length);
    let have = armRows.filter((r) => r.selected).length;
    if (have >= target) continue;
    const spare = armRows.filter((r) => !r.selected).sort((a, b) => (a.score - b.score) || (a.worksheetRowId < b.worksheetRowId ? -1 : 1));
    for (const r of spare) {
      if (have >= target) break;
      assigned.set(r.worksheetRowId, true);
      have += 1;
    }
  }
  return assigned;
}

/**
 * `self_family` — computed at write time from the UNBLINDED row, by the store,
 * never by the blinded agent (which by construction cannot know).
 *
 * Family, not exact id: an Opus adjudicator judging a Sonnet arm is the same
 * bias question as one judging another Opus. Bias made visible, not denied.
 *
 * Family resolution lives in `modelFamily` (model-resolver.mjs), not in a
 * local helper here. The helper it replaced read the vendor off whichever half
 * of the id was present, so the SAME model reached by two routes — the bare
 * native id vs the OpenRouter `vendor/model` slug, both of which this repo
 * deliberately keeps distinct — resolved to two families and a self-judging
 * model was recorded as unbiased. See that function's docstring for the
 * measurement and for why the two ids must stay distinct everywhere else.
 */
export function isSelfFamily(adjudicatorModel, armModel) {
  const a = modelFamily(adjudicatorModel);
  const b = modelFamily(armModel);
  if (!a || !b) return null;   // unknown, never a confident `false`
  return a === b;
}

// ── The spine: campaign → cohort → snapshot → arm-run ───────────────────────

/** Idempotent on `(repo_id, campaign_key)`. `config_digest` is refreshed so the
 *  row witnesses what was declared at the LATEST collect; historical digests
 *  live on the cohorts, which is where evidence hangs. */
export async function ensureCampaign({ repoId, campaignKey, configDigest }) {
  if (!await isCloudEnabled()) return { ok: true, cloud: false, id: null };
  try {
    return await withTx(async () => {
      const hit = await one(
        `INSERT INTO campaigns (repo_id, campaign_key, config_digest)
         VALUES ($1, $2, $3)
         ON CONFLICT (repo_id, campaign_key) DO UPDATE SET config_digest = EXCLUDED.config_digest
         RETURNING id`,
        [repoId, campaignKey, configDigest],
      );
      return { ok: true, cloud: true, id: hit?.id ?? null };
    });
  } catch (err) {
    process.stderr.write(`  [campaign] ensureCampaign failed: ${err.message}\n`);
    return { ok: false, cloud: true, error: err.message, id: null };
  }
}

/**
 * Idempotent on `(campaign_id, lock_digest)`. A NEW digest creates a NEW cohort
 * — prior evidence is orphaned into its own cohort, never deleted and never
 * relabelled. That is the whole mechanism: there is no string to remember to
 * bump, so the five-false-greens failure becomes unrepresentable rather than
 * merely discouraged.
 */
export async function ensureCohort({ campaignId, lockDigest, resolved }) {
  if (!await isCloudEnabled()) return { ok: true, cloud: false, id: null };
  try {
    const hit = await one(
      `INSERT INTO campaign_cohorts (campaign_id, lock_digest, resolved)
       VALUES ($1, $2, $3)
       ON CONFLICT (campaign_id, lock_digest) DO UPDATE SET resolved = EXCLUDED.resolved
       RETURNING id, lock_digest, superseded_at`,
      [campaignId, lockDigest, resolved == null ? null : JSON.stringify(resolved)],
    );
    return { ok: true, cloud: true, id: hit?.id ?? null, supersededAt: hit?.superseded_at ?? null };
  } catch (err) {
    process.stderr.write(`  [campaign] ensureCohort failed: ${err.message}\n`);
    return { ok: false, cloud: true, error: err.message, id: null };
  }
}

/**
 * One snapshot, one revision. The unique `(cohort_id, snapshot_id)` plus a
 * NOT NULL `audited_sha` is what makes §2.5b-i's identity claim TRUE rather
 * than merely asserted next to a schema that permitted the violation.
 *
 * A conflicting sha is a REFUSAL, not an update: the sha is what adjudication
 * verifies against, so silently taking the newer one would retroactively change
 * what every existing verdict on this snapshot was checked against.
 */
export async function upsertSnapshot({ cohortId, snapshotId, auditedSha, transcriptPath }) {
  if (!await isCloudEnabled()) return { ok: true, cloud: false, id: null };
  try {
    const existing = await one(
      'SELECT id, audited_sha FROM campaign_snapshots WHERE cohort_id = $1 AND snapshot_id = $2',
      [cohortId, snapshotId],
    );
    if (existing) {
      if (existing.audited_sha !== auditedSha) {
        return {
          ok: false, cloud: true, conflict: true, id: existing.id,
          error: `snapshot ${snapshotId} is already recorded at audited_sha ${existing.audited_sha}, not ${auditedSha} — `
            + 'a snapshot identifies one transcript at one revision, and adjudication verifies against that sha',
        };
      }
      return { ok: true, cloud: true, id: existing.id, created: false };
    }
    const row = await insertReturning('campaign_snapshots', {
      cohort_id: cohortId, snapshot_id: snapshotId, audited_sha: auditedSha, transcript_path: transcriptPath ?? null,
    }, { returning: ['id'] });
    const id = Array.isArray(row) ? row[0]?.id : row?.id;
    return { ok: true, cloud: true, id: id ?? null, created: true };
  } catch (err) {
    process.stderr.write(`  [campaign] upsertSnapshot failed: ${err.message}\n`);
    return { ok: false, cloud: true, error: err.message, id: null };
  }
}

/** Highest attempt RECORDED in the store for one arm-run. Half of
 *  `resolveNextAttempt`'s DISK ∪ DB input — the store is the authority on what
 *  was recorded, the receipt directory on what was claimed, and a crash is
 *  precisely the window where those differ. */
export async function maxArmRunAttempt({ cohortId, snapshotId, armId }) {
  if (!await isCloudEnabled()) return { ok: true, cloud: false, attempt: 0 };
  try {
    const row = await one(
      'SELECT COALESCE(MAX(attempt), 0) AS attempt FROM campaign_arm_runs WHERE cohort_id = $1 AND snapshot_id = $2 AND arm_id = $3',
      [cohortId, snapshotId, armId],
    );
    return { ok: true, cloud: true, attempt: Number(row?.attempt ?? 0) };
  } catch (err) {
    process.stderr.write(`  [campaign] maxArmRunAttempt failed: ${err.message}\n`);
    return { ok: false, cloud: true, error: err.message, attempt: 0 };
  }
}

/**
 * Record one arm-run. `--force` supersedes rather than overwrites: the prior
 * live row is stamped `superseded_at` and the new attempt is APPENDED, so a
 * re-run never double-charges the recorded spend and never destroys the
 * evidence of what the earlier attempt produced.
 *
 * The supersede and the insert are one transaction because the partial unique
 * index permits exactly one live row — doing them apart would leave a window
 * where the insert fails against a row we are about to retire.
 *
 * **Conflict-safe on `audit_run_id`** (§7 Phase 3): when `auditRunId` is
 * non-null, the insert targets the `idx_campaign_arm_runs_audit_run_id`
 * partial unique index with `DO NOTHING`, as a defense-in-depth backstop —
 * never the primary correctness mechanism, which is the caller
 * (`promoteFromLog`) checking `existingAuditRunIds` under
 * `acquireSnapshotLock` BEFORE ever calling this function for an
 * already-recorded run. Zero rows returned here is therefore a detected
 * CONTRADICTION between what that pre-check found and what the constraint
 * saw, not an expected outcome — surfaced as a thrown invariant-violation
 * error, never silently absorbed. **No `client` parameter is needed to
 * share `promoteFromLog`'s locked transaction** — `withTx` is already
 * re-entrant via `AsyncLocalStorage` (verified empirically: nested `withTx`
 * calls share one connection), so this function's own internal `withTx`
 * automatically joins the caller's transaction via `SAVEPOINT` when called
 * from inside one.
 */
export async function recordArmRun({
  cohortId, snapshotRowId, snapshotId, armId, attempt,
  auditRunId = null, usage = null, costUsd = null, costStatus = 'unknown', error = null, supersedePrior = false,
  planContentHash = null, configDigest = null,
}) {
  if (!await isCloudEnabled()) return { ok: true, cloud: false, id: null };
  // The CHECK constraint pairs these; keeping them coherent HERE means a caller
  // that forgets gets a clear refusal instead of a Postgres constraint name.
  if (costStatus === 'priced' && !Number.isFinite(costUsd)) {
    return { ok: false, cloud: true, error: `costStatus 'priced' requires a finite costUsd (got ${costUsd})` };
  }
  const price = costStatus === 'priced' ? Number(costUsd) : null;
  try {
    return await withTx(async () => {
      if (supersedePrior) {
        await updateWhere('campaign_arm_runs', { superseded_at: new Date().toISOString() },
          { cohort_id: cohortId, snapshot_id: snapshotId, arm_id: armId, superseded_at: null });
      }
      const rowValues = {
        cohort_id: cohortId, snapshot_row_id: snapshotRowId, snapshot_id: snapshotId, arm_id: armId,
        attempt, audit_run_id: auditRunId, usage, cost_usd: price, cost_status: costStatus, error,
        plan_content_hash: planContentHash, config_digest: configDigest,
      };
      let row;
      if (auditRunId != null) {
        const rows = await upsert('campaign_arm_runs', [rowValues], {
          onConflict: ['audit_run_id'], conflictWhere: 'audit_run_id IS NOT NULL', update: 'ignore', returning: ['id'],
        });
        row = rows[0];
        if (!row) {
          throw new Error(
            `invariant violated: audit_run_id ${auditRunId} was already recorded despite the pre-lock existence check finding it absent — `
            + 'the locking invariant was bypassed somewhere and needs investigation',
          );
        }
      } else {
        row = await insertReturning('campaign_arm_runs', rowValues, { returning: ['id'] });
      }
      const id = Array.isArray(row) ? row[0]?.id : row?.id;
      if (!id) {
        // An unverified write is never success in this repo.
        throw new Error('arm-run insert returned no id');
      }
      return { ok: true, cloud: true, id };
    });
  } catch (err) {
    process.stderr.write(`  [campaign] recordArmRun failed: ${err.message}\n`);
    return { ok: false, cloud: true, error: err.message, id: null };
  }
}

/**
 * Pure predicate: does this attempt's plan pairing fall under an active
 * (non-lifted) exclusion for its snapshot?
 *
 * `exclusions` is an already-fetched, already `lifted_at IS NULL`-filtered
 * list for the cohort — this is the ONE place the match rule lives
 * (single-oracle, §7 Phase 2); both `liveArmRunsForSnapshot` below and
 * `loadCohortArmRuns` (Phase 5) call it identically rather than
 * re-expressing the rule as a SQL join, which would double-count a
 * snapshot carrying both a `scope='all'` and a `scope='pairing'` exclusion.
 *
 * A `scope='all'` exclusion matches unconditionally for its snapshot; a
 * `scope='pairing'` exclusion matches only an attempt whose OWN
 * `planContentHash` is NOT DISTINCT FROM the exclusion's recorded hash
 * (NULL-vs-NULL is a match — this is what lets the legacy, pre-Phase-4
 * NULL-hash pairing be quarantined at all).
 *
 * **Two DIFFERENT shapes, deliberately** (clarified after a review pass read
 * them as one DTO needing the same fields everywhere): the `attempt` being
 * checked carries `snapshotId`/`planContentHash` ONLY — an attempt has no
 * `scope` of its own, that concept belongs solely to an EXCLUSION record
 * (`ex.scope`, read from the `exclusions` array). A caller does not, and
 * must not, pass `scope` when calling this for an attempt.
 *
 * @param {{cohortId?: string, snapshotId: string, planContentHash: string|null}} attempt
 * @param {Array<{snapshotId: string, scope: 'all'|'pairing', planContentHash: string|null}>} exclusions
 * @returns {boolean}
 */
export function isAttemptExcluded({ snapshotId, planContentHash = null }, exclusions) {
  for (const ex of exclusions || []) {
    if (ex.snapshotId !== snapshotId) continue;
    if (ex.scope === 'all') return true;
    if (ex.scope === 'pairing' && (ex.planContentHash ?? null) === (planContentHash ?? null)) return true;
  }
  return false;
}

/**
 * This cohort's active (non-lifted) exclusions, in the shape
 * `isAttemptExcluded` consumes. The ONE fetch shared by
 * `liveArmRunsForSnapshot` (below) and `promoteFromLog`'s quarantine
 * admission (§7 Phase 3) — extracted so both read the same query rather
 * than each hand-writing it.
 *
 * @param {string} cohortId
 * @returns {Promise<Array<{snapshotId: string, scope: string, planContentHash: string|null}>>}
 */
export async function activeExclusionsForCohort(cohortId) {
  const rows = await many(
    `SELECT snapshot_id, scope, plan_content_hash FROM campaign_snapshot_exclusions
      WHERE cohort_id = $1 AND lifted_at IS NULL`,
    [cohortId],
  );
  return rows.map((e) => ({ snapshotId: e.snapshot_id, scope: e.scope, planContentHash: e.plan_content_hash }));
}

/**
 * Which of these `audit_run_id` values already have a `campaign_arm_runs`
 * row — the identity-keyed promotion input (§7 Phase 3). Deliberately
 * TABLE-WIDE, matching the scope of the DB's own uniqueness guarantee
 * (`idx_campaign_arm_runs_audit_run_id`), not scoped to one arm/snapshot —
 * a given review only ever happens once, so its run id cannot legitimately
 * belong to two different arm-runs.
 *
 * @param {string[]} runIds
 * @returns {Promise<{ok: boolean, cloud: boolean, ids: Set<string>}>}
 */
export async function existingAuditRunIds(runIds) {
  const ids = [...new Set((runIds || []).filter(Boolean))];
  if (!await isCloudEnabled()) return { ok: true, cloud: false, ids: new Set() };
  if (ids.length === 0) return { ok: true, cloud: true, ids: new Set() };
  try {
    const rows = await many('SELECT audit_run_id FROM campaign_arm_runs WHERE audit_run_id = ANY($1::uuid[])', [ids]);
    return { ok: true, cloud: true, ids: new Set(rows.map((r) => r.audit_run_id)) };
  } catch (err) {
    process.stderr.write(`  [campaign] existingAuditRunIds failed: ${err.message}\n`);
    return { ok: false, cloud: true, ids: new Set(), error: err.message };
  }
}

/**
 * Serialize promotion for ONE snapshot (§7 Phase 3, round 4 H1+H4). Holds a
 * `pg_advisory_xact_lock` for the caller's transaction — auto-released at
 * commit/rollback — keyed on `(cohortId, snapshotId)`, so classification,
 * quarantine admission, and every write they gate happen atomically together
 * for one snapshot. Reconciliation ACROSS different snapshots in the same
 * cohort remains unserialized: each snapshot's arms are independent, and
 * there is nothing to race there.
 *
 * MUST be called from inside an active `withTx` frame — the lock is
 * meaningless (and immediately released) outside a transaction.
 *
 * `cohortId` is a UUID; `hashtext` has no implicit UUID→text cast, so the
 * explicit `::text` is required (Gemini gate round 4, G2) — `snapshotId` is
 * already text and needs none.
 *
 * @param {string} cohortId
 * @param {string} snapshotId
 */
export async function acquireSnapshotLock(cohortId, snapshotId) {
  await query('SELECT pg_advisory_xact_lock(hashtext($1::text), hashtext($2))', [cohortId, snapshotId]);
}

/**
 * Every LIVE arm-run row for one snapshot, `arm_id`/`plan_content_hash`
 * only — the raw input `promoteFromLog`'s plan-hash consistency check
 * (§7 Phase 4) groups into `{armId: Set<hash|null>}` after filtering
 * through `isAttemptExcluded`. A separate, narrower read from
 * `liveArmRunsForSnapshot` because that function's `succeeded` boolean
 * already collapses away the raw hash the consistency check needs to see
 * per LIVE attempt, quarantined or not.
 *
 * @param {{cohortId: string, snapshotId: string}} args
 * @returns {Promise<{ok: boolean, cloud: boolean, rows: Array<{armId: string, planContentHash: string|null}>}>}
 */
export async function liveArmRunRows({ cohortId, snapshotId }) {
  if (!await isCloudEnabled()) return { ok: true, cloud: false, rows: [] };
  try {
    const rows = await many(
      `SELECT arm_id, plan_content_hash FROM campaign_arm_runs
        WHERE cohort_id = $1 AND snapshot_id = $2 AND superseded_at IS NULL`,
      [cohortId, snapshotId],
    );
    return { ok: true, cloud: true, rows: rows.map((r) => ({ armId: r.arm_id, planContentHash: r.plan_content_hash })) };
  } catch (err) {
    process.stderr.write(`  [campaign] liveArmRunRows failed: ${err.message}\n`);
    return { ok: false, cloud: true, rows: [], error: err.message };
  }
}

/**
 * Quarantine a snapshot pairing (§7 Phase 5). A plain, synchronous store
 * write with a discriminated result — NOT routed through `durableWrite`:
 * verified against `.requirements/ledger.json`'s `REQ-persistence-7bc1224d`
 * that only `audit.findings`/`audit.runComplete` durable writers may
 * declare `rowKey` values, and every other campaign-harness write
 * (`recordArmRun`, `upsertSnapshot`, and siblings) is exempted on the same
 * ground: a synchronous, operator-initiated (or promotion-internal) CLI
 * write is outside the fire-and-forget orchestrator telemetry contract
 * `durableWrite` exists for.
 *
 * `allPairings: true` writes `scope='all'`; otherwise `scope='pairing'`
 * with `plan_content_hash: planContentHash` (defaulting to `null`, which
 * matches exactly the legacy pre-Phase-4 rows this plan's own Close-out
 * needs to quarantine). Each branch's `ON CONFLICT` clause repeats its
 * target partial index's FULL predicate, predicate-for-predicate — a
 * generic upsert cannot target all three arbiter indexes from Phase 1 at
 * once, and Postgres refuses to infer a partial index from a conflict
 * target whose predicate does not match exactly. Zero rows affected is
 * SUCCESS ("already quarantined"), never an error — the ONLY idempotency
 * mechanism here, no `durableWrite` replay involved.
 *
 * @param {{cohortId: string, snapshotId: string, planContentHash?: string|null, allPairings?: boolean, reason: string}} args
 * @returns {Promise<{ok: boolean, cloud: boolean, applied: boolean}>}
 */
export async function markSnapshotExcluded({ cohortId, snapshotId, planContentHash = null, allPairings = false, reason }) {
  if (!await isCloudEnabled()) return { ok: true, cloud: false, applied: false };
  try {
    let row;
    if (allPairings) {
      row = await one(
        `INSERT INTO campaign_snapshot_exclusions (cohort_id, snapshot_id, scope, excluded_reason)
         VALUES ($1, $2, 'all', $3)
         ON CONFLICT (cohort_id, snapshot_id) WHERE scope = 'all' AND lifted_at IS NULL DO NOTHING
         RETURNING id`,
        [cohortId, snapshotId, reason],
      );
    } else if (planContentHash != null) {
      row = await one(
        `INSERT INTO campaign_snapshot_exclusions (cohort_id, snapshot_id, scope, plan_content_hash, excluded_reason)
         VALUES ($1, $2, 'pairing', $3, $4)
         ON CONFLICT (cohort_id, snapshot_id, plan_content_hash)
           WHERE scope = 'pairing' AND plan_content_hash IS NOT NULL AND lifted_at IS NULL DO NOTHING
         RETURNING id`,
        [cohortId, snapshotId, planContentHash, reason],
      );
    } else {
      row = await one(
        `INSERT INTO campaign_snapshot_exclusions (cohort_id, snapshot_id, scope, excluded_reason)
         VALUES ($1, $2, 'pairing', $3)
         ON CONFLICT (cohort_id, snapshot_id) WHERE scope = 'pairing' AND plan_content_hash IS NULL AND lifted_at IS NULL DO NOTHING
         RETURNING id`,
        [cohortId, snapshotId, reason],
      );
    }
    return { ok: true, cloud: true, applied: Boolean(row) };
  } catch (err) {
    process.stderr.write(`  [campaign] markSnapshotExcluded failed: ${err.message}\n`);
    return { ok: false, cloud: true, applied: false, error: err.message };
  }
}

/**
 * Lift a quarantine (§7 Phase 5, round 5 M2). Same scope/hash targeting
 * logic as `markSnapshotExcluded`. Zero rows affected is disambiguated
 * (round 6, Gemini gate LOW correction) before it becomes an error: a
 * matching row that is ALREADY lifted is a benign no-op (retry-after-
 * timeout must be idempotent, symmetric with `markSnapshotExcluded`'s own
 * `ON CONFLICT ... DO NOTHING`); no matching row at all is the genuine
 * "nothing to lift" error.
 *
 * @param {{cohortId: string, snapshotId: string, planContentHash?: string|null, allPairings?: boolean, reason: string}} args
 * @returns {Promise<{ok: boolean, cloud: boolean, applied: boolean, alreadyLifted?: boolean, notFound?: boolean}>}
 */
export async function liftSnapshotExclusion({ cohortId, snapshotId, planContentHash = null, allPairings = false, reason }) {
  if (!await isCloudEnabled()) return { ok: true, cloud: false, applied: false };
  const scopeWhere = allPairings
    ? "scope = 'all'"
    : (planContentHash != null ? "scope = 'pairing' AND plan_content_hash = $3" : "scope = 'pairing' AND plan_content_hash IS NULL");
  const matchParams = allPairings || planContentHash == null ? [cohortId, snapshotId] : [cohortId, snapshotId, planContentHash];
  try {
    const updated = await one(
      `UPDATE campaign_snapshot_exclusions SET lifted_at = NOW(), lifted_reason = $${matchParams.length + 1}
        WHERE cohort_id = $1 AND snapshot_id = $2 AND ${scopeWhere} AND lifted_at IS NULL
        RETURNING id`,
      [...matchParams, reason],
    );
    if (updated) return { ok: true, cloud: true, applied: true };
    const existing = await one(
      `SELECT id FROM campaign_snapshot_exclusions WHERE cohort_id = $1 AND snapshot_id = $2 AND ${scopeWhere}`,
      matchParams,
    );
    if (existing) return { ok: true, cloud: true, applied: false, alreadyLifted: true };
    return { ok: true, cloud: true, applied: false, notFound: true };
  } catch (err) {
    process.stderr.write(`  [campaign] liftSnapshotExclusion failed: ${err.message}\n`);
    return { ok: false, cloud: true, applied: false, error: err.message };
  }
}

/**
 * Resolve and validate a (campaign, snapshot) target exists before a
 * quarantine/unquarantine write — a friendly, named error for a typo'd
 * `--snapshot` rather than a raw FK-violation surfacing from the
 * migration's composite foreign key (§7 Phase 5, round 4 M1).
 *
 * @param {{repoId: string, campaignKey: string, snapshotId: string}} args
 * @returns {Promise<{ok: boolean, cloud: boolean, cohortId?: string, error?: string}>}
 */
export async function resolveQuarantineTarget({ repoId: rid, campaignKey, snapshotId }) {
  const cohort = await resolveCohort({ repoId: rid, campaignKey });
  if (cohort.cloud === false) return { ok: true, cloud: false };
  if (!cohort.ok) return { ok: false, cloud: true, error: cohort.error };
  if (!cohort.cohortId) {
    return { ok: false, cloud: true, error: `no cohort found for campaign "${campaignKey}"` };
  }
  if (!await isCloudEnabled()) return { ok: true, cloud: false };
  const row = await one(
    'SELECT id FROM campaign_snapshots WHERE cohort_id = $1 AND snapshot_id = $2',
    [cohort.cohortId, snapshotId],
  );
  if (!row) {
    return { ok: false, cloud: true, error: `snapshot "${snapshotId}" not found in cohort ${cohort.cohortId} (campaign "${campaignKey}") — check the id` };
  }
  return { ok: true, cloud: true, cohortId: cohort.cohortId };
}

/**
 * Every LIVE arm-run for one snapshot, success-gated for retry-scoping
 * decisions (§7 Phase 2).
 *
 * `succeeded` is `error IS NULL AND audit_run_id IS NOT NULL AND
 * (config_digest IS NULL OR config_digest = expectedConfigDigest) AND
 * (plan_content_hash IS NULL OR plan_content_hash = expectedPlanContentHash)
 * AND NOT isAttemptExcluded(...)`. Both provenance columns share ONE
 * permissive-NULL policy (round 6, M1 — see the plan's fuller rationale):
 * a legacy row that predates either column is TRUSTED, never treated as
 * suspect on that basis alone; only a REAL, differing value forces
 * re-collection, and quarantine alone is what distrusts a specific bad
 * legacy pairing.
 *
 * Cloud-off returns `{ok:true, cloud:false, rows:{}}`, mirroring every
 * other read in this file.
 *
 * @param {{cohortId: string, snapshotId: string, expectedConfigDigest: string|null, expectedPlanContentHash: string|null}} args
 * @returns {Promise<{ok: boolean, cloud: boolean, rows: Record<string, {runId: string|null, attempt: number, auditRunId: string|null, succeeded: boolean}>}>}
 */
export async function liveArmRunsForSnapshot({ cohortId, snapshotId, expectedConfigDigest = null, expectedPlanContentHash = null }) {
  if (!await isCloudEnabled()) return { ok: true, cloud: false, rows: {}, exclusions: [] };
  try {
    const [armRows, activeExclusions] = await Promise.all([
      many(
        `SELECT arm_id, attempt, audit_run_id, error, config_digest, plan_content_hash
           FROM campaign_arm_runs
          WHERE cohort_id = $1 AND snapshot_id = $2 AND superseded_at IS NULL`,
        [cohortId, snapshotId],
      ),
      activeExclusionsForCohort(cohortId),
    ]);
    const rows = {};
    for (const r of armRows) {
      const succeeded = r.error == null && r.audit_run_id != null
        && (r.config_digest == null || r.config_digest === expectedConfigDigest)
        && (r.plan_content_hash == null || r.plan_content_hash === expectedPlanContentHash)
        && !isAttemptExcluded({ snapshotId, planContentHash: r.plan_content_hash }, activeExclusions);
      rows[r.arm_id] = { runId: r.audit_run_id, attempt: r.attempt, auditRunId: r.audit_run_id, succeeded };
    }
    // Exclusions are returned alongside `rows` so the caller (`main()`'s
    // own abort-before-spawn quarantine check) can reuse this ONE fetch
    // rather than issuing a second query for the same cohort.
    return { ok: true, cloud: true, rows, exclusions: activeExclusions };
  } catch (err) {
    process.stderr.write(`  [campaign] liveArmRunsForSnapshot failed: ${err.message}\n`);
    return { ok: false, cloud: true, rows: {}, exclusions: [], error: err.message };
  }
}

/** Append-only lifecycle log. Enforced by a trigger, not merely documented:
 *  a log that can be edited cannot evidence that a rule change happened. */
export async function appendCampaignEvent({ campaignId, kind, actor = null, detail = null }) {
  if (!await isCloudEnabled()) return { ok: true, cloud: false, id: null };
  try {
    const row = await insertReturning('campaign_events',
      { campaign_id: campaignId, kind, actor, detail }, { returning: ['id'] });
    const id = Array.isArray(row) ? row[0]?.id : row?.id;
    return { ok: true, cloud: true, id: id ?? null };
  } catch (err) {
    process.stderr.write(`  [campaign] appendCampaignEvent failed: ${err.message}\n`);
    return { ok: false, cloud: true, error: err.message, id: null };
  }
}

export async function listCampaignEvents(campaignId, { limit = 200 } = {}) {
  if (!await isCloudEnabled()) return { ok: true, cloud: false, rows: [] };
  try {
    const rows = await many(
      'SELECT id, kind, actor, detail, created_at FROM campaign_events WHERE campaign_id = $1 ORDER BY created_at ASC, id ASC LIMIT $2',
      [campaignId, Math.min(Math.max(1, limit), 1000)],
    );
    return { ok: true, cloud: true, rows };
  } catch (err) {
    process.stderr.write(`  [campaign] listCampaignEvents failed: ${err.message}\n`);
    return { ok: false, cloud: true, rows: [], error: err.message };
  }
}

// ── Findings + adjudication ─────────────────────────────────────────────────

/**
 * Every finding produced by this cohort's arm-runs, UNBLINDED — the input to
 * worksheet construction and to metric attribution. Never rendered directly.
 *
 * `source_model` IS selected here, deliberately: this is the store-side view
 * that computes `self_family` and credits arms. The blind projection is
 * `loadBlindWorksheet`, and the two are separate functions precisely so the
 * blindness contract is a property of one named query rather than a habit.
 */
export async function loadCohortFindings(cohortId, { liveOnly = true } = {}) {
  if (!await isCloudEnabled()) return { ok: true, cloud: false, rows: [] };
  try {
    // `r.plan_file` / `r.mode` are selected for CITATION RESOLUTION, not for
    // display. A plan-mode finding cites a `§`-section of a plan document, not
    // a file path, so `affectedFilesOf` returns nothing and the row reaches the
    // adjudicator with no source at all — measured on this cohort 2026-08-19:
    // **89 of 201 findings (44%), and 171 of the 201 are plan-mode**. The run
    // row is the only place the document's identity survives.
    const rows = await many(
      `SELECT f.id            AS finding_id,
              f.severity, f.category, f.primary_file, f.detail_snapshot, f.source_model,
              ar.id           AS arm_run_id,
              ar.arm_id, ar.snapshot_id, ar.attempt, ar.superseded_at,
              cs.audited_sha,
              r.plan_file, r.mode
         FROM campaign_arm_runs ar
         JOIN campaign_snapshots cs ON cs.id = ar.snapshot_row_id
         JOIN audit_runs r          ON r.id = ar.audit_run_id
         JOIN audit_findings f       ON f.run_id = ar.audit_run_id
        WHERE ar.cohort_id = $1
          AND ($2::bool IS NOT TRUE OR ar.superseded_at IS NULL)
        ORDER BY ar.snapshot_id, ar.arm_id, f.id`,
      [cohortId, liveOnly],
    );
    return { ok: true, cloud: true, rows };
  } catch (err) {
    process.stderr.write(`  [campaign] loadCohortFindings failed: ${err.message}\n`);
    return { ok: false, cloud: true, rows: [], error: err.message };
  }
}

/**
 * Every arm-run row for a cohort — read SEPARATELY from the findings, and that
 * is load-bearing: an arm-run that produced zero findings has no row in the
 * finding join, so deriving the arm set from findings alone would make a silent
 * arm indistinguishable from an absent one. Absence is never a pass.
 *
 * Superseded rows are INCLUDED: they were paid for, and the spend rule sums all
 * attempts (§7a shadow/S4). The caller filters for effectiveness.
 */
export async function loadCohortArmRuns(cohortId) {
  if (!await isCloudEnabled()) return { ok: true, cloud: false, rows: [] };
  try {
    const [rows, exclusions] = await Promise.all([
      many(
        `SELECT id, snapshot_id, arm_id, attempt, superseded_at, audit_run_id,
                cost_usd, cost_status, error, plan_content_hash, created_at
           FROM campaign_arm_runs
          WHERE cohort_id = $1
          ORDER BY snapshot_id, arm_id, attempt`,
        [cohortId],
      ),
      activeExclusionsForCohort(cohortId),
    ]);
    // §7 Phase 5: an arm-run row is dropped when it falls under an active
    // exclusion — filtered in application code via the single
    // `isAttemptExcluded` oracle, NOT a SQL join (a join against a table
    // that can hold both an `all` row and a `pairing` row for one snapshot
    // would emit a duplicate arm-run row per match, corrupting the
    // completion/cost/coverage counts this function feeds).
    const filtered = exclusions.length
      ? rows.filter((r) => !isAttemptExcluded({ snapshotId: r.snapshot_id, planContentHash: r.plan_content_hash }, exclusions))
      : rows;
    return { ok: true, cloud: true, rows: filtered };
  } catch (err) {
    process.stderr.write(`  [campaign] loadCohortArmRuns failed: ${err.message}\n`);
    return { ok: false, cloud: true, rows: [], error: err.message };
  }
}

/** Every adjudication event for a set of findings, for the terminal-event
 *  total order in `verdict.mjs`. */
export async function loadAdjudicationEvents(findingIds) {
  if (!await isCloudEnabled()) return { ok: true, cloud: false, rows: [] };
  const ids = [...new Set((findingIds || []).filter(Boolean))];
  if (ids.length === 0) return { ok: true, cloud: true, rows: [] };
  try {
    const rows = await many(
      `SELECT id, finding_id, adjudication_outcome, adjudicator_kind, adjudicator_model,
              method, self_family, overrides_event_id, superseded_at, evidence, created_at
         FROM finding_adjudication_events
        WHERE finding_id = ANY($1::uuid[])
        ORDER BY created_at ASC, id ASC`,
      [ids],
    );
    return { ok: true, cloud: true, rows };
  } catch (err) {
    process.stderr.write(`  [campaign] loadAdjudicationEvents failed: ${err.message}\n`);
    return { ok: false, cloud: true, rows: [], error: err.message };
  }
}

/**
 * Create (or reuse) the adjudication session for a cohort.
 *
 * `create: false` makes it a pure READ — same lookup, same key-ref refusal, no
 * insert — which is what `adjudicate --dry-run` needs. A dry run that created
 * the worksheet would be a preview that mutates the thing it previews, and the
 * key-ref check is the reason this is a flag rather than a second function:
 * two lookups would be two places for that refusal to drift.
 */
export async function ensureWorksheet({ cohortId, hmacKeyRef, create = true }) {
  if (!await isCloudEnabled()) return { ok: true, cloud: false, id: null };
  try {
    const existing = await one(
      'SELECT id, hmac_key_ref FROM campaign_worksheets WHERE cohort_id = $1 ORDER BY created_at ASC LIMIT 1',
      [cohortId],
    );
    if (!existing && !create) return { ok: true, cloud: true, id: null, created: false, exists: false };
    if (existing) {
      if (existing.hmac_key_ref !== hmacKeyRef) {
        return {
          ok: false, cloud: true,
          error: `this cohort's worksheet was created under key ref ${existing.hmac_key_ref}, not ${hmacKeyRef} — `
            + 'key rotation is not supported: a rotated key re-randomises the calibration sample and orphans every recorded disposition',
        };
      }
      return { ok: true, cloud: true, id: existing.id, created: false };
    }
    const row = await insertReturning('campaign_worksheets', { cohort_id: cohortId, hmac_key_ref: hmacKeyRef }, { returning: ['id'] });
    const id = Array.isArray(row) ? row[0]?.id : row?.id;
    return { ok: true, cloud: true, id: id ?? null, created: true };
  } catch (err) {
    process.stderr.write(`  [campaign] ensureWorksheet failed: ${err.message}\n`);
    return { ok: false, cloud: true, error: err.message, id: null };
  }
}

/**
 * Persist the row↔finding mapping and the calibration assignment.
 *
 * Both are STORED, not recomputed. Without persistence the "deterministic
 * sample" of §2.5c.5 was reproducible only by accident, and the stored boolean
 * is what keeps the assignment stable if the key ever became unreadable.
 *
 * `calibration_assigned` is monotonic: an existing TRUE is never lowered, which
 * is the property protecting completed human review work.
 */
export async function upsertWorksheetRows(worksheetId, rows) {
  if (!await isCloudEnabled()) return { ok: true, cloud: false, inserted: 0 };
  if (!rows?.length) return { ok: true, cloud: true, inserted: 0 };
  try {
    return await withTx(async () => {
      let inserted = 0;
      for (const r of rows) {
        const hit = await one(
          `INSERT INTO campaign_worksheet_rows (worksheet_id, worksheet_row_id, finding_id, calibration_assigned)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (worksheet_id, finding_id)
             DO UPDATE SET calibration_assigned = campaign_worksheet_rows.calibration_assigned OR EXCLUDED.calibration_assigned
           RETURNING id, (xmax = 0) AS was_insert`,
          [worksheetId, r.worksheetRowId, r.findingId, r.calibrationAssigned === true],
        );
        if (hit?.was_insert) inserted += 1;
      }
      return { ok: true, cloud: true, inserted };
    });
  } catch (err) {
    process.stderr.write(`  [campaign] upsertWorksheetRows failed: ${err.message}\n`);
    return { ok: false, cloud: true, inserted: 0, error: err.message };
  }
}

/**
 * The BLIND projection. `source_model` is structurally absent from the SELECT —
 * not selected-and-unused — so a future edit that starts rendering "everything
 * the query returns" cannot leak it.
 *
 * Ordering is a **seeded hash shuffle**: insert order is arm-ordered, so
 * returning rows in it would carry the signal the redactor just removed.
 */
export async function loadBlindWorksheet(worksheetId, { key, campaignId }) {
  if (!await isCloudEnabled()) return { ok: true, cloud: false, rows: [] };
  try {
    const rows = await many(
      `SELECT wr.worksheet_row_id, wr.calibration_assigned, wr.agent_event_id,
              f.severity, f.category, f.primary_file, f.detail_snapshot
         FROM campaign_worksheet_rows wr
         JOIN audit_findings f ON f.id = wr.finding_id
        WHERE wr.worksheet_id = $1`,
      [worksheetId],
    );
    const shuffled = rows
      .map((r) => ({ r, k: crypto.createHmac('sha256', key).update(`shuffle:${campaignId}:${r.worksheet_row_id}`).digest('hex') }))
      .sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0))
      .map((x) => x.r);
    return { ok: true, cloud: true, rows: shuffled };
  } catch (err) {
    process.stderr.write(`  [campaign] loadBlindWorksheet failed: ${err.message}\n`);
    return { ok: false, cloud: true, rows: [], error: err.message };
  }
}

/**
 * `finding_adjudication_events.remediation_state` and `round` are NOT NULL with
 * no campaign-meaningful value, so campaign writers supply them explicitly.
 * Papering over the omission with a default would manufacture a remediation
 * claim this workflow never makes.
 *
 * `ruling` is deliberately NULL and stays that way. It is a DIFFERENT AXIS —
 * `(sustain, overrule, compromise)` is the GPT-vs-Gemini deliberation ruling —
 * and a campaign verdict is not a deliberation. The verdict lands in
 * `adjudication_outcome`; writing it to both would put one fact in two
 * vocabularies, and the CHECK constraints would disagree about it.
 */
const CAMPAIGN_EVENT_DEFAULTS = Object.freeze({ remediation_state: 'pending', round: 1, ruling: null });

/** Outcomes a campaign verdict may record. `needs_triage` is the honest value
 *  for a claim the instrument could not settle — never `dismissed`, which a
 *  reader who skips `method` would take for a real dismissal. */
export const CAMPAIGN_OUTCOMES = Object.freeze(['accepted', 'dismissed', 'severity_adjusted', 'needs_triage']);

/** The two methods an AGENT verdict may carry. A human disposition writes
 *  `override`, which is a different act and not in this set. */
export const CAMPAIGN_AGENT_METHODS = Object.freeze(['verified', 'unverifiable']);

/**
 * Refuse a row the schema would refuse — or, worse, would NOT refuse.
 *
 * Shared by both writers and run BEFORE the cloud gate, deliberately: a verdict
 * whose `(method, outcome)` pair is incoherent is malformed whether or not a
 * store is configured, and validating after the gate would make the guard
 * unreachable on every local-only install — the one place a caller could
 * develop against it without ever meeting the constraint.
 *
 * `verdictPairError` (lib/campaign/adjudicate.mjs) is the ONE oracle for the
 * pair rule; this function must never grow a second copy of it.
 */
function verdictRowRefusal({ method, outcome, methods = null }) {
  if (!CAMPAIGN_OUTCOMES.includes(outcome)) {
    return `outcome must be one of ${CAMPAIGN_OUTCOMES.join(', ')} (got ${JSON.stringify(outcome)})`;
  }
  if (methods && !methods.includes(method)) {
    return `method must be one of ${methods.join(', ')} (got ${JSON.stringify(method)})`;
  }
  return verdictPairError({ method, outcome });
}

/**
 * Record the agent's verdict, superseding any prior live agent verdict for the
 * same finding.
 *
 * The partial unique index permits exactly one live agent verdict per finding,
 * so a re-run of `adjudicate` cannot silently stack duplicate PAID verdicts and
 * inflate the calibration denominator. Supersede + insert in one transaction,
 * for the same reason as the arm-run.
 */
export async function recordAgentVerdict({
  findingId, worksheetRowId, worksheetId, armRunId, adjudicatorModel,
  method, outcome, evidence = null, selfFamily = null, rationale = null,
}) {
  const refusal = verdictRowRefusal({ method, outcome, methods: CAMPAIGN_AGENT_METHODS });
  if (refusal) return { ok: false, cloud: null, error: refusal, id: null };
  if (!await isCloudEnabled()) return { ok: true, cloud: false, id: null };
  try {
    return await withTx(async () => {
      await updateWhere('finding_adjudication_events', { superseded_at: new Date().toISOString() },
        { finding_id: findingId, adjudicator_kind: 'agent', superseded_at: null });
      const row = await insertReturning('finding_adjudication_events', {
        finding_id: findingId,
        adjudication_outcome: outcome,
        ...CAMPAIGN_EVENT_DEFAULTS,
        ruling_rationale: rationale,
        adjudicator_kind: 'agent',
        adjudicator_model: adjudicatorModel,
        method,
        self_family: selfFamily,
        campaign_arm_run_id: armRunId ?? null,
        evidence,
      }, { returning: ['id'] });
      const id = Array.isArray(row) ? row[0]?.id : row?.id;
      if (!id) throw new Error('agent verdict insert returned no id');
      if (worksheetId && worksheetRowId) {
        await updateWhere('campaign_worksheet_rows', { agent_event_id: id },
          { worksheet_id: worksheetId, worksheet_row_id: worksheetRowId });
      }
      return { ok: true, cloud: true, id };
    });
  } catch (err) {
    process.stderr.write(`  [campaign] recordAgentVerdict failed: ${err.message}\n`);
    return { ok: false, cloud: true, error: err.message, id: null };
  }
}

/**
 * Which of these findings already carry a HUMAN adjudication event.
 *
 * The guard for re-adjudication. A human override names the agent verdict it
 * overrides, and that PAIR is the campaign's published calibration figure — so
 * superseding the named verdict with a fresh machine run would leave the
 * override pointing at a superseded row and silently corrupt the override rate.
 * A human decision is also simply worth more than a re-run: if a person has
 * dispositioned the row, the machine does not get to answer again.
 */
export async function findingsWithHumanDisposition(findingIds) {
  const ids = [...new Set((findingIds || []).filter(Boolean))];
  if (ids.length === 0) return { ok: true, cloud: true, ids: new Set() };
  if (!await isCloudEnabled()) return { ok: true, cloud: false, ids: new Set() };
  try {
    const rows = await many(
      `SELECT DISTINCT finding_id FROM finding_adjudication_events
        WHERE finding_id = ANY($1::uuid[]) AND adjudicator_kind = 'human'`,
      [ids],
    );
    return { ok: true, cloud: true, ids: new Set(rows.map((r) => r.finding_id)) };
  } catch (err) {
    process.stderr.write(`  [campaign] findingsWithHumanDisposition failed: ${err.message}\n`);
    // Fails CLOSED: an unreadable guard must not read as "no human touched
    // these" on a path whose whole job is to protect human dispositions.
    return { ok: false, cloud: true, ids: new Set(ids), error: err.message };
  }
}

/**
 * A human override is APPEND-ONLY and TERMINAL: it writes a new event naming
 * the agent verdict it overrides, and the original stays visible. Override rate
 * per arm IS the campaign's published calibration figure, so an override that
 * quietly replaced its target would destroy the measurement it produces.
 *
 * The agent verdict it names is deliberately NOT superseded — the pair is the
 * datum.
 */
export async function recordHumanOverride({ findingId, outcome, note = null, actor = null, overridesEventId = null }) {
  // `method: 'override'` is written below, so the pair rule rejects
  // `needs_triage` here for free: a human disposition that routes the row back
  // to the human queue is a no-op wearing a verdict's clothes, and the DB
  // constraint would reject it as a bare constraint name.
  const refusal = verdictRowRefusal({ method: 'override', outcome });
  if (refusal) return { ok: false, cloud: null, error: refusal, id: null };
  if (!await isCloudEnabled()) return { ok: true, cloud: false, id: null };
  try {
    return await withTx(async () => {
      let target = overridesEventId;
      if (!target) {
        const live = await one(
          `SELECT id FROM finding_adjudication_events
            WHERE finding_id = $1 AND adjudicator_kind = 'agent' AND superseded_at IS NULL
            ORDER BY created_at DESC, id DESC LIMIT 1`,
          [findingId],
        );
        target = live?.id ?? null;
      }
      if (!target) {
        // The CHECK constraint would reject this anyway; refusing here names WHY.
        return {
          ok: false, cloud: true, notFound: true,
          error: `no live agent verdict exists for finding ${findingId} — an override must NAME the verdict it overrides, `
            + 'or the override rate (the campaign\'s calibration figure) is computed from a guess about which rows pair up. '
            + 'Run `campaign.mjs adjudicate` first, or record a direct human disposition instead.',
        };
      }
      const row = await insertReturning('finding_adjudication_events', {
        finding_id: findingId,
        adjudication_outcome: outcome,
        ...CAMPAIGN_EVENT_DEFAULTS,
        ruling_rationale: note,
        adjudicator_kind: 'human',
        method: 'override',
        overrides_event_id: target,
      }, { returning: ['id'] });
      const id = Array.isArray(row) ? row[0]?.id : row?.id;
      if (!id) throw new Error('override insert returned no id');
      // `finding_adjudication_events` has no `actor` column, and adding one for
      // this would duplicate a fact `campaign_events` already holds. The CLI
      // appends the actor there; it is returned so the caller can do so without
      // re-deriving it.
      return { ok: true, cloud: true, id, overrides: target, actor: actor ?? null };
    });
  } catch (err) {
    process.stderr.write(`  [campaign] recordHumanOverride failed: ${err.message}\n`);
    return { ok: false, cloud: true, error: err.message, id: null };
  }
}

/**
 * Adjudication spend, per attempt, because it IS spend. The same
 * all-attempts-count rule as arm-runs: a superseded attempt was paid for.
 *
 * Reported as campaign OVERHEAD on its own line and never folded into per-arm
 * cost-per-accepted — adjudication is paid once per finding regardless of which
 * arm produced it, so charging it to an arm would penalise the arm that found
 * more.
 */
export async function recordAdjudicationAttempt({ worksheetRowUuid, attempt, status, usage = null, costUsd = null, costStatus = 'unknown' }) {
  if (!await isCloudEnabled()) return { ok: true, cloud: false, id: null };
  if (costStatus === 'priced' && !Number.isFinite(costUsd)) {
    return { ok: false, cloud: true, error: `costStatus 'priced' requires a finite costUsd (got ${costUsd})` };
  }
  try {
    const row = await insertReturning('campaign_adjudication_attempts', {
      worksheet_row_id: worksheetRowUuid, attempt, status, usage,
      cost_usd: costStatus === 'priced' ? Number(costUsd) : null, cost_status: costStatus,
    }, { returning: ['id'] });
    const id = Array.isArray(row) ? row[0]?.id : row?.id;
    return { ok: true, cloud: true, id: id ?? null };
  } catch (err) {
    process.stderr.write(`  [campaign] recordAdjudicationAttempt failed: ${err.message}\n`);
    return { ok: false, cloud: true, error: err.message, id: null };
  }
}

/**
 * The worksheet row's UUID plus the highest adjudication attempt RECORDED for
 * it — the DB half of `resolveNextAttempt`'s DISK ∪ DB input, for the same
 * reason the arm-run has one: a crash between the receipt claim and the store
 * write is exactly the window where disk and database disagree, and consulting
 * only the database wedges the row permanently at `attempt = 1`.
 */
export async function resolveWorksheetRowAttempt({ worksheetId, worksheetRowId }) {
  if (!await isCloudEnabled()) return { ok: true, cloud: false, id: null, attempt: 0 };
  try {
    const row = await one(
      `SELECT wr.id, COALESCE(MAX(a.attempt), 0) AS attempt
         FROM campaign_worksheet_rows wr
         LEFT JOIN campaign_adjudication_attempts a ON a.worksheet_row_id = wr.id
        WHERE wr.worksheet_id = $1 AND wr.worksheet_row_id = $2
        GROUP BY wr.id`,
      [worksheetId, worksheetRowId],
    );
    return { ok: true, cloud: true, id: row?.id ?? null, attempt: Number(row?.attempt ?? 0) };
  } catch (err) {
    process.stderr.write(`  [campaign] resolveWorksheetRowAttempt failed: ${err.message}\n`);
    return { ok: false, cloud: true, id: null, attempt: 0, error: err.message };
  }
}

/** Total adjudication overhead for a cohort, all attempts, unknown-honest. */
export async function adjudicationOverhead(cohortId) {
  if (!await isCloudEnabled()) return { ok: true, cloud: false, spendUsd: null, costEvidence: 'unknown' };
  try {
    const row = await one(
      `SELECT COALESCE(SUM(a.cost_usd), 0)                                  AS spend_usd,
              COUNT(*)                                                       AS attempts,
              COUNT(*) FILTER (WHERE a.cost_status <> 'priced')              AS unpriced
         FROM campaign_adjudication_attempts a
         JOIN campaign_worksheet_rows wr ON wr.id = a.worksheet_row_id
         JOIN campaign_worksheets w      ON w.id = wr.worksheet_id
        WHERE w.cohort_id = $1`,
      [cohortId],
    );
    const unpriced = Number(row?.unpriced ?? 0);
    return {
      ok: true, cloud: true,
      attempts: Number(row?.attempts ?? 0),
      // Postgres NUMERIC arrives as a STRING over node-pg — Number() it, or a
      // later sum concatenates instead of adding.
      spendUsd: unpriced > 0 ? null : Number(row?.spend_usd ?? 0),
      costEvidence: unpriced > 0 ? 'unknown' : 'known',
    };
  } catch (err) {
    process.stderr.write(`  [campaign] adjudicationOverhead failed: ${err.message}\n`);
    return { ok: false, cloud: true, spendUsd: null, costEvidence: 'unknown', error: err.message };
  }
}

// ── Clusters ────────────────────────────────────────────────────────────────

/**
 * Persist one snapshot's cluster set with the matcher version + threshold that
 * produced it. Re-running at a new threshold writes a NEW set; the old one
 * stays readable, because the matcher is a post-hoc analytical transform over
 * evidence already paid for — which is exactly why it is not a lock input.
 *
 * Idempotent by `(cohort, snapshot, matcher_version, canonical_finding)`.
 */
export async function writeClusterSet({ cohortId, snapshotId, matcherVersion, matcherThreshold, clusters }) {
  if (!await isCloudEnabled()) return { ok: true, cloud: false, written: 0 };
  try {
    return await withTx(async () => {
      let written = 0;
      for (const cluster of clusters || []) {
        const hit = await one(
          `INSERT INTO campaign_clusters (cohort_id, snapshot_id, matcher_version, matcher_threshold, canonical_finding_id)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (cohort_id, snapshot_id, matcher_version, canonical_finding_id) DO UPDATE SET matcher_threshold = EXCLUDED.matcher_threshold
           RETURNING id`,
          [cohortId, snapshotId, matcherVersion, matcherThreshold, cluster.canonicalFindingId],
        );
        if (!hit?.id) throw new Error(`cluster upsert returned no id for ${cluster.canonicalFindingId}`);
        for (const m of cluster.members) {
          await one(
            `INSERT INTO campaign_cluster_members (cluster_id, finding_id, arm_id)
             VALUES ($1, $2, $3) ON CONFLICT (cluster_id, finding_id) DO UPDATE SET arm_id = EXCLUDED.arm_id
             RETURNING cluster_id`,
            [hit.id, m.findingId, m.armId],
          );
        }
        written += 1;
      }
      return { ok: true, cloud: true, written };
    });
  } catch (err) {
    process.stderr.write(`  [campaign] writeClusterSet failed: ${err.message}\n`);
    return { ok: false, cloud: true, written: 0, error: err.message };
  }
}

/** Cluster sets for a cohort under ONE matcher version — never a blend of two,
 *  which would silently mix incompatible attributions. */
export async function loadClusters(cohortId, matcherVersion) {
  if (!await isCloudEnabled()) return { ok: true, cloud: false, rows: [] };
  try {
    const rows = await many(
      `SELECT c.id AS cluster_id, c.snapshot_id, c.matcher_threshold,
              m.finding_id, m.arm_id, f.severity
         FROM campaign_clusters c
         JOIN campaign_cluster_members m ON m.cluster_id = c.id
         JOIN audit_findings f            ON f.id = m.finding_id
        WHERE c.cohort_id = $1 AND c.matcher_version = $2
        ORDER BY c.snapshot_id, c.id, m.finding_id`,
      [cohortId, String(matcherVersion)],
    );
    return { ok: true, cloud: true, rows };
  } catch (err) {
    process.stderr.write(`  [campaign] loadClusters failed: ${err.message}\n`);
    return { ok: false, cloud: true, rows: [], error: err.message };
  }
}

/** Per-arm calibration figures: assigned, dispositioned, override rate,
 *  `self_family` share. The override rate IS the campaign's calibration
 *  measurement, so it is computed from the paired rows, never estimated. */
export async function calibrationSummary(cohortId) {
  if (!await isCloudEnabled()) return { ok: true, cloud: false, perArm: {} };
  try {
    const rows = await many(
      `WITH rows AS (
         SELECT wr.id AS wr_id, wr.finding_id, wr.calibration_assigned,
                ar.arm_id,
                ae.id AS agent_event_id, ae.self_family,
                he.id AS human_event_id
           FROM campaign_worksheet_rows wr
           JOIN campaign_worksheets w ON w.id = wr.worksheet_id
           JOIN audit_findings f      ON f.id = wr.finding_id
           JOIN campaign_arm_runs ar  ON ar.audit_run_id = f.run_id AND ar.cohort_id = w.cohort_id
           LEFT JOIN LATERAL (
             SELECT e.id, e.self_family FROM finding_adjudication_events e
              WHERE e.finding_id = wr.finding_id AND e.adjudicator_kind = 'agent' AND e.superseded_at IS NULL
              ORDER BY e.created_at DESC, e.id DESC LIMIT 1) ae ON TRUE
           LEFT JOIN LATERAL (
             SELECT e.id FROM finding_adjudication_events e
              WHERE e.finding_id = wr.finding_id AND e.adjudicator_kind = 'human'
              ORDER BY e.created_at DESC, e.id DESC LIMIT 1) he ON TRUE
          WHERE w.cohort_id = $1
       )
       SELECT arm_id,
              COUNT(*)                                                           AS rows_total,
              COUNT(*) FILTER (WHERE agent_event_id IS NOT NULL)                  AS agent_verdicts,
              COUNT(*) FILTER (WHERE calibration_assigned)                        AS assigned,
              COUNT(*) FILTER (WHERE calibration_assigned AND human_event_id IS NOT NULL) AS dispositioned,
              COUNT(*) FILTER (WHERE human_event_id IS NOT NULL AND agent_event_id IS NOT NULL) AS overrides,
              COUNT(*) FILTER (WHERE self_family)                                 AS self_family
         FROM rows GROUP BY arm_id ORDER BY arm_id`,
      [cohortId],
    );
    const perArm = {};
    for (const r of rows) {
      const agentVerdicts = Number(r.agent_verdicts);
      perArm[r.arm_id] = {
        rowsTotal: Number(r.rows_total),
        agentVerdicts,
        assigned: Number(r.assigned),
        dispositioned: Number(r.dispositioned),
        overrides: Number(r.overrides),
        // A rate over zero verdicts is `null`, never 0 — "we never measured" and
        // "we measured no disagreement" are different facts and read identically
        // as a zero.
        overrideRate: agentVerdicts > 0 ? Number(r.overrides) / agentVerdicts : null,
        selfFamily: Number(r.self_family),
        selfFamilyShare: agentVerdicts > 0 ? Number(r.self_family) / agentVerdicts : null,
      };
    }
    return { ok: true, cloud: true, perArm };
  } catch (err) {
    process.stderr.write(`  [campaign] calibrationSummary failed: ${err.message}\n`);
    return { ok: false, cloud: true, perArm: {}, error: err.message };
  }
}

/**
 * The commit each arm-run's `audit_runs` row was taken at.
 *
 * This is where `audited_sha` comes from, and it is a LOOKUP rather than a
 * field on the bake-off log, deliberately: the log records what the collector
 * observed, while the sha is a property of the audit the arm actually ran, and
 * only the run row knows it. A snapshot whose arms disagree about the commit is
 * not one snapshot (§2.5b-i) — the caller refuses it rather than picking one.
 *
 * @param {string[]} runIds
 * @returns {Promise<{ok: boolean, cloud: boolean, byRunId: Record<string, string|null>}>}
 */
export async function auditedShasForRuns(runIds) {
  if (!await isCloudEnabled()) return { ok: true, cloud: false, byRunId: {} };
  const ids = [...new Set((runIds || []).filter(Boolean))];
  if (ids.length === 0) return { ok: true, cloud: true, byRunId: {} };
  try {
    const rows = await many('SELECT id, commit_sha FROM audit_runs WHERE id = ANY($1::uuid[])', [ids]);
    return { ok: true, cloud: true, byRunId: Object.fromEntries(rows.map((r) => [r.id, r.commit_sha ?? null])) };
  } catch (err) {
    process.stderr.write(`  [campaign] auditedShasForRuns failed: ${err.message}\n`);
    return { ok: false, cloud: true, byRunId: {}, error: err.message };
  }
}

/** Resolve a campaign + its live cohort by campaign key. */
export async function resolveCohort({ repoId, campaignKey, lockDigest = null }) {
  if (!await isCloudEnabled()) return { ok: true, cloud: false, campaignId: null, cohortId: null };
  try {
    const campaign = await one(
      'SELECT id, config_digest FROM campaigns WHERE repo_id = $1 AND campaign_key = $2',
      [repoId, campaignKey],
    );
    if (!campaign) return { ok: true, cloud: true, campaignId: null, cohortId: null };
    const cohort = lockDigest
      ? await one('SELECT id, lock_digest, superseded_at, resolved FROM campaign_cohorts WHERE campaign_id = $1 AND lock_digest = $2', [campaign.id, lockDigest])
      : await one('SELECT id, lock_digest, superseded_at, resolved FROM campaign_cohorts WHERE campaign_id = $1 ORDER BY created_at DESC LIMIT 1', [campaign.id]);
    return {
      ok: true, cloud: true, campaignId: campaign.id,
      cohortId: cohort?.id ?? null, lockDigest: cohort?.lock_digest ?? null,
      cohortSuperseded: cohort?.superseded_at != null,
    };
  } catch (err) {
    process.stderr.write(`  [campaign] resolveCohort failed: ${err.message}\n`);
    return { ok: false, cloud: true, campaignId: null, cohortId: null, error: err.message };
  }
}

// ── The one cohort reader ───────────────────────────────────────────────────

/**
 * Assemble everything `evaluateCampaign` needs from the  One read path,
 * shared by `status`, `verdict` and (Cluster C) the dashboard collector — so
 * three surfaces cannot disagree about what a campaign's state is.
 */
export async function loadCohortEvidence({ repoId: rid, config, lock }) {
  const resolved = await resolveCohort({ repoId: rid, campaignKey: config.id, lockDigest: lock?.lockDigest ?? null });
  if (!resolved.cohortId) {
    return {
      ok: false,
      reason: 'no cohort recorded for this campaign under the current lock',
      campaignId: resolved.campaignId,
      lockDigest: resolved.lockDigest ?? null,
    };
  }
  const findings = await loadCohortFindings(resolved.cohortId);
  const events = await loadAdjudicationEvents(findings.rows.map((r) => r.finding_id));
  const clusters = await loadClusters(resolved.cohortId, FINDING_MATCH_SCHEMA_VERSION);
  const calibration = await calibrationSummary(resolved.cohortId);
  const overhead = await adjudicationOverhead(resolved.cohortId);
  const eventLog = await listCampaignEvents(resolved.campaignId);

  const eventsByFinding = new Map();
  for (const e of events.rows) {
    if (!eventsByFinding.has(e.finding_id)) eventsByFinding.set(e.finding_id, []);
    eventsByFinding.get(e.finding_id).push({
      id: e.id, adjudicationOutcome: e.adjudication_outcome, adjudicatorKind: e.adjudicator_kind,
      method: e.method, supersededAt: e.superseded_at, createdAt: e.created_at,
    });
  }

  // Snapshots + arm-runs, assembled from the finding rows' arm-run join plus a
  // direct arm-run read (an arm-run with zero findings must still appear, or a
  // silent arm looks like an absent one).
  const armRunRows = await loadCohortArmRuns(resolved.cohortId);
  const bySnapshot = new Map();
  for (const r of armRunRows.rows) {
    if (!bySnapshot.has(r.snapshot_id)) bySnapshot.set(r.snapshot_id, { snapshotId: r.snapshot_id, armRuns: [] });
    bySnapshot.get(r.snapshot_id).armRuns.push({
      armId: r.arm_id, attempt: r.attempt, error: r.error, supersededAt: r.superseded_at,
      costUsd: r.cost_usd == null ? null : Number(r.cost_usd), costStatus: r.cost_status,
    });
  }

  const clusterMap = new Map();
  for (const r of clusters.rows) {
    if (!clusterMap.has(r.cluster_id)) clusterMap.set(r.cluster_id, { clusterId: r.cluster_id, snapshotId: r.snapshot_id, members: [] });
    clusterMap.get(r.cluster_id).members.push({
      findingId: r.finding_id, armId: r.arm_id, severity: r.severity, events: eventsByFinding.get(r.finding_id) ?? [],
    });
  }

  let unadjudicated = 0;
  let humanQueuePending = 0;
  for (const f of findings.rows) {
    const term = terminalEvent(eventsByFinding.get(f.finding_id) ?? []);
    if (!term) { unadjudicated += 1; continue; }
    if (term.adjudicatorKind === 'agent' && (term.method === 'unverifiable' || term.adjudicationOutcome === 'needs_triage')) {
      humanQueuePending += 1;
    }
  }

  const snapshots = [...bySnapshot.values()];
  const completeIds = new Set();
  const nonReplicateArmIds = config.arms.filter((a) => a.type !== 'replicate').map((a) => a.id);
  for (const s of snapshots) {
    const ok = new Set(s.armRuns.filter((r) => r.supersededAt == null && !r.error).map((r) => r.armId));
    if (nonReplicateArmIds.every((id) => ok.has(id))) completeIds.add(s.snapshotId);
  }
  const clusteredSnapshots = new Set(clusters.rows.map((r) => r.snapshot_id));
  const snapshotsMissingClusters = [...completeIds].filter((id) => !clusteredSnapshots.has(id)).sort();

  const declared = eventLog.rows.find((e) => e.kind === 'declared-inconclusive') ?? null;
  const firstArmRunAt = armRunRows.rows.length > 0
    ? armRunRows.rows.map((r) => r.created_at).sort()[0]
    : null;
  const ruleChangedAfterFirstArmRun = firstArmRunAt != null
    && eventLog.rows.some((e) => e.kind === 'rule_changed' && String(e.created_at) > String(firstArmRunAt));

  return {
    ok: true,
    campaignId: resolved.campaignId,
    cohortId: resolved.cohortId,
    // The cohort's OWN digest, so a reader sees the contract the evidence was
    // collected under rather than one re-resolved at read time.
    lockDigest: resolved.lockDigest ?? null,
    cohortSuperseded: resolved.cohortSuperseded,
    findings: findings.rows,
    // The event map for EVERY finding, keyed by finding id — not only the ones
    // that landed in a cluster. Clusters are written per COMPLETE snapshot, so
    // reading adjudication state out of the cluster projection silently hid
    // every verdict on an incomplete snapshot and rendered those findings as
    // permanently unadjudicated, breaking the human review workflow for exactly
    // the snapshots most likely to need it.
    eventsByFinding: Object.fromEntries(eventsByFinding),
    snapshots,
    clusters: [...clusterMap.values()],
    adjudication: { unadjudicatedFindings: unadjudicated, humanQueuePending },
    calibration: { perArm: calibration.perArm },
    clustering: {
      snapshotsMissingClusters,
      matcherVersion: String(FINDING_MATCH_SCHEMA_VERSION),
      // The threshold RECORDED on the cluster rows, not the one this process
      // happens to be configured with. Reporting the live config as the
      // provenance of already-written clusters is precisely the mislabelling
      // the provenance row exists to prevent — and it would be invisible,
      // because the two agree until someone retunes.
      recordedThresholds: [...new Set(clusters.rows.map((r) => Number(r.matcher_threshold)))].sort((x, y) => x - y),
    },
    overhead,
    declaredInconclusive: declared ? { reason: declared.detail?.reason ?? 'declared by operator' } : null,
    ruleChangedAfterFirstArmRun,
  };
}

/**
 * @fileoverview Gap-challenge — an advisory LLM pass that classifies each
 * extracted candidate against four gap classes.
 * Plan: docs/plans/requirements-layer.md — Plan-Phase A.
 *
 * Emits `GapAssessment`s, never blocks. Note `intended-but-unobserved` is
 * deliberately NOT a class here — intent absent from code is unextractable
 * (audit H2); that is a refine-step / Phase-2 concern.
 *
 * @module scripts/lib/requirements/gap-challenge
 */
import { callOpenAI } from '../brainstorm/openai-adapter.mjs';
import { resolveModel, refreshModelCatalog } from '../model-resolver.mjs';
import { GAP_CLASSES, GapAssessmentSchema } from './schema.mjs';
import { parseLlmJson } from './llm-json.mjs';

// One assessment is ~50-70 output tokens; 16k comfortably covers a few
// hundred candidates. Beyond that the prompt needs true batching — a
// documented Phase-2 item (plan §8). Until then an over-large candidate
// set degrades loudly to all-`none` rather than silently truncating.
const GAP_MAX_OUTPUT_TOKENS = 16_000;

export const GAP_PROMPT = `You are gap-analysing extracted DE-FACTO requirements. For EACH requirement
below, assign exactly one gap class:
- "none"                    — a sound, intended-looking invariant.
- "observed-but-unintended" — the code does this but it looks like a BUG or
  accidental behaviour, not a deliberate invariant.
- "untested"                — a real invariant with no linked test in its
  evidence.tests.
- "contradictory"           — it conflicts with another requirement in the
  list (give the conflicting ids in conflictsWith).

Output STRICT JSON ONLY:
{"assessments":[{"requirementId":"REQ-...","gap":"none|observed-but-unintended|untested|contradictory",
  "conflictsWith":["REQ-..."],"rationale":"one short sentence"}]}`;

/**
 * Classify each candidate's gap. Advisory — on any failure, returns a
 * benign all-`none` assessment set rather than throwing (#16).
 *
 * @param {object[]} candidates - `RequirementCandidate`s
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<object[]>} one `GapAssessment` per candidate
 */
export async function classifyGaps(candidates, { timeoutMs = 120_000 } = {}) {
  const benign = (reason) => candidates.map((c) => ({
    requirementId: c.id, gap: 'none', conflictsWith: [],
    rationale: reason || 'not assessed',
  }));
  if (!Array.isArray(candidates) || candidates.length === 0) return [];

  const list = candidates.map((c) => ({
    id: c.id, assertion: c.assertion, kind: c.kind,
    hasTests: (c.evidence?.tests || []).length > 0,
  }));

  let parsed;
  try {
    await refreshModelCatalog().catch(() => {});
    const model = resolveModel('latest-gpt');
    const r = await callOpenAI({
      topic: `${GAP_PROMPT}\n\nREQUIREMENTS:\n${JSON.stringify(list, null, 1)}`,
      model, maxTokens: GAP_MAX_OUTPUT_TOKENS, timeoutMs,
    });
    if (r.state !== 'success') {
      // Advisory pass — degrade rather than block (#16) — but LOUDLY: a
      // silent all-`none` set would hide a systematic LLM outage (audit
      // H1/H3). The `none` fallback still records the reason in rationale.
      process.stderr.write(`  [requirements] WARN: gap-challenge LLM ${r.state} — degraded: all ${candidates.length} candidate(s) marked gap:'none' (advisory pass not run)\n`);
      return benign(`gap-challenge LLM ${r.state}`);
    }
    parsed = parseLlmJson(r.text);
  } catch (err) {
    process.stderr.write(`  [requirements] WARN: gap-challenge degraded — ${err.message} (all ${candidates.length} candidate(s) marked gap:'none')\n`);
    return benign('gap-challenge errored');
  }

  // Top-level shape guard (audit M3) — a response lacking the `assessments`
  // array is malformed; degrade loudly rather than silently to `[]`.
  if (!Array.isArray(parsed?.assessments)) {
    process.stderr.write(`  [requirements] WARN: gap-challenge response missing an 'assessments' array — degraded: all ${candidates.length} candidate(s) marked gap:'none'\n`);
    return benign('gap-challenge malformed response');
  }

  // gap-challenge is an ADVISORY pass — it must NEVER emit an assessment
  // that fails GapAssessmentSchema, or `GapsFileSchema.parse` in cmdExtract
  // would crash extraction outright (audit H6). Every assessment below is
  // sanitised to schema-valid shape, then safeParse-guarded as a backstop.
  const candidateIds = new Set(candidates.map((c) => c.id));
  const byId = new Map();
  for (const a of parsed.assessments) {
    if (!a || typeof a.requirementId !== 'string') continue;
    let gap = GAP_CLASSES.includes(a.gap) ? a.gap : 'none';
    // conflictsWith: keep only REAL peer candidate ids — never self, never a
    // hallucinated/non-existent id (audit M1/H6).
    const conflictsWith = (Array.isArray(a.conflictsWith) ? a.conflictsWith : [])
      .filter((x) => typeof x === 'string' && x !== a.requirementId && candidateIds.has(x));
    // A 'contradictory' verdict with nothing left to contradict is malformed
    // — coerce to 'none' so the contradictory⇒conflictsWith invariant holds.
    if (gap === 'contradictory' && conflictsWith.length === 0) gap = 'none';
    const assessment = {
      requirementId: a.requirementId, gap, conflictsWith,
      rationale: String(a.rationale || '').slice(0, 400),
    };
    byId.set(a.requirementId, GapAssessmentSchema.safeParse(assessment).success
      ? assessment
      : { requirementId: a.requirementId, gap: 'none', conflictsWith: [], rationale: 'coerced — malformed assessment' });
  }
  // Every candidate gets an assessment — default `none` for any the LLM
  // missed. Retrieval is keyed by the candidate's own id, so each emitted
  // assessment carries a valid `requirementId` regardless of byId contents.
  return candidates.map((c) => byId.get(c.id) || {
    requirementId: c.id, gap: 'none', conflictsWith: [], rationale: 'not assessed',
  });
}

/**
 * True when a persisted `gap` assessment is a DEGRADED placeholder, never a
 * genuine LLM judgement — i.e. it came from one of `classifyGaps`'s `benign()`
 * fallbacks, not from a parsed response.
 *
 * **Why this exists.** `classifyGaps` makes ONE unbatched LLM call over every
 * candidate handed to it, and the module's own comment already named the
 * ceiling: "~50-70 output tokens per assessment; 16k comfortably covers a few
 * hundred candidates... an over-large set degrades loudly to all-`none`."
 * Measured against the 2026-08-12 whole-repo extract: 8 of 10 tranches (up to
 * 1,460 candidates each) exceeded that ceiling, and `gap:'none'` — the SAME
 * value a genuinely sound, LLM-assessed invariant gets — is indistinguishable
 * from "never assessed" without reading `rationale`. Of 4,051 ledger entries,
 * 2,083 (51%) carried exactly this placeholder. `needs-review` in the ledger
 * (14 entries) was therefore drawn from the ~2,000 candidates small enough to
 * actually get assessed, not from the whole ledger — a believable false zero
 * hiding behind a real-looking status count.
 *
 * Matched on RATIONALE, not on `gap: 'none'` alone, because `'none'` is also
 * the correct, genuine verdict for a sound invariant — collapsing the two
 * would either flag every clean requirement for re-review (false positives
 * drowning the real signal) or, read the other way round, do nothing at all.
 * The degraded markers are exact strings `classifyGaps` itself emits — no
 * genuine LLM rationale can collide with them, since the prompt's own example
 * output never uses the literal phrase "gap-challenge" and the code coerces
 * every other malformed case to one of these same fixed strings.
 *
 * @param {{gap?: string, rationale?: string}|null|undefined} gap
 * @returns {boolean}
 */
export function isDegradedGapAssessment(gap) {
  if (!gap) return true; // no assessment at all — never ran
  const r = String(gap.rationale ?? '');
  return r === 'not assessed'
    || r === 'coerced — malformed assessment'
    || r.startsWith('gap-challenge ');
}

/**
 * `GAP_BATCH_SIZE` is derived the same way `CHUNK_TOKEN_BUDGET` is in
 * `extract.mjs`: `GAP_MAX_OUTPUT_TOKENS` (16,000) divided by the per-assessment
 * cost the module's own docstring states (~50-70 tokens), giving a realistic
 * ceiling of ~228-320 candidates per call. 180 leaves margin for JSON
 * structural overhead and the longer end of that per-assessment range —
 * conservative on purpose, since the failure mode on the wrong side (silent
 * `none`-degrade) is the whole reason this constant exists.
 */
export const GAP_BATCH_SIZE = 180;

/**
 * Split candidates into `GAP_BATCH_SIZE`-sized groups. Pure, so it is
 * unit-testable without touching the network — the thing that actually needs
 * verifying here is the arithmetic, not the LLM call.
 *
 * @param {object[]} candidates
 * @returns {object[][]}
 */
export function chunkForGapChallenge(candidates, batchSize = GAP_BATCH_SIZE) {
  const batches = [];
  for (let i = 0; i < candidates.length; i += batchSize) batches.push(candidates.slice(i, i + batchSize));
  return batches;
}

/**
 * `classifyGaps`, batched to stay under the ceiling that caused the whole
 * class of degradation `isDegradedGapAssessment` exists to detect.
 *
 * **Named limitation, not a silent one**: `gap: 'contradictory'` requires
 * `conflictsWith` to name a REAL peer id, and `classifyGaps` only ever sees
 * peers within the SAME call — so a contradiction between two requirements
 * placed in different batches is structurally undetectable here. That is a
 * real ceiling on this pass, not a bug; `classifyGaps`'s own per-item
 * validation (dropping a `conflictsWith` id absent from ITS batch) already
 * enforces it defensively, this docstring just names it as a property of
 * batching rather than leaving it implicit.
 *
 * @param {object[]} candidates
 * @param {{timeoutMs?: number, batchSize?: number}} [opts]
 * @returns {Promise<object[]>}
 */
export async function classifyGapsBatched(candidates, { timeoutMs, batchSize = GAP_BATCH_SIZE } = {}) {
  const out = [];
  for (const batch of chunkForGapChallenge(candidates, batchSize)) {
    out.push(...await classifyGaps(batch, { timeoutMs }));
  }
  return out;
}

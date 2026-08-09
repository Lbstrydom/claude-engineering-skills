/**
 * @fileoverview The single oracle for what a Gemini call actually BILLED.
 *
 * ## The defect this centralises away
 *
 * `usageMetadata.candidatesTokenCount` counts only the emitted answer;
 * `thoughtsTokenCount` counts reasoning. They are **disjoint**, and Google bills
 * **both** at the output rate. Six call sites independently read candidates
 * alone, so every one of them under-reported Gemini's output — measured on
 * bake-off snapshot `21245f6aae1c`: 310 candidate tokens beside 17,792 thought
 * tokens. If candidates already included thoughts it could not be the smaller
 * number. That is a ~2.5x understatement of the arm's cost, in the readout whose
 * whole job is comparing arms on cost.
 *
 * ## Why a function and not six edits
 *
 * The first draft of the plan proposed editing each adapter identically and
 * locking them with a source-text census over `candidatesTokenCount`. That was
 * wrong twice: the census false-*fails* on legitimate single-field references
 * (logging, diagnostics) and false-*passes* a new call site that reads
 * `promptTokenCount`/`thoughtsTokenCount` and never mentions candidates at all.
 * A census over source text cannot express a behavioural contract; one function
 * can (#1 DRY, #5 SSoT).
 *
 * ## The shape contract
 *
 * This owns the READ. Each call site MAPS the result into its own established
 * shape — they genuinely differ (`brainstorm/gemini-adapter.mjs` returns
 * camelCase `inputTokens`/`outputTokens`; `arm-eval/producers/model-call.mjs`
 * returns snake_case with `reasoning_tokens`) and forcing convergence would
 * break their consumers, replacing an under-metering bug with a zeroed-field
 * bug. What every site MUST carry through is `usageMissing`: it is the only
 * thing that keeps an unmeterable call from reconciling to a fake €0 against the
 * spend ceiling.
 *
 * Plan: docs/plans/cross-model-finding-matching.md §9 "One Gemini usage
 * normaliser, not five copies".
 *
 * @module scripts/lib/gemini-usage
 */

/** A count is trustworthy only if it is an actual finite non-negative number. */
function isCount(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/**
 * Normalise Google's `usageMetadata` into the repo's canonical usage triple
 * plus a provenance flag.
 *
 * @param {{promptTokenCount?: number, candidatesTokenCount?: number,
 *          thoughtsTokenCount?: number}|null|undefined} usageMetadata
 * @returns {{input_tokens: number, output_tokens: number,
 *            thinking_tokens: number, usageMissing: boolean}}
 *   `output_tokens` is BILLED output (candidates + thoughts).
 *   `thinking_tokens` is the reasoning share WITHIN that total — never an
 *   addend. Summing the two double-counts, which is why the shared cost oracle
 *   (`model-pricing.mjs::costFromUsage`) deliberately does not.
 *   `usageMissing` is true when the provider reported nothing usable; the
 *   token fields are then 0 and are NOT authoritative.
 */
export function normalizeGeminiUsage(usageMetadata) {
  const prompt = usageMetadata?.promptTokenCount;
  const candidates = usageMetadata?.candidatesTokenCount;
  // Thoughts are OPTIONAL — a non-thinking model omits the field entirely, and
  // that is a complete response, not a missing one. So absence is tolerated
  // while the other two fields are not.
  //
  // ABSENT and PRESENT-BUT-INVALID are different facts, though (audit M4).
  // `{thoughtsTokenCount: 'invalid'}` silently becoming 0 with
  // `usageMissing: false` would report a confidently-wrong billed total — the
  // provider said something and we could not read it, which is exactly the
  // condition the flag exists to surface. Only a genuinely absent field is
  // benign.
  const rawThoughts = usageMetadata?.thoughtsTokenCount;
  const thoughtsPresent = rawThoughts !== undefined && rawThoughts !== null;
  const thoughtsUnreadable = thoughtsPresent && !isCount(rawThoughts);
  const thoughts = isCount(rawThoughts) ? rawThoughts : 0;

  // Missing means "the provider told us nothing usable", NOT "the counts were
  // zero". A real `{candidates: 0, thoughts: 0}` response is a MEASURED zero and
  // must survive as one — conflating the two is the exact anti-green failure
  // this whole change set exists to remove.
  const usageMissing = !usageMetadata || !isCount(prompt) || !isCount(candidates) || thoughtsUnreadable;

  // The DERIVED total needs its own check (audit M2). Two individually-finite
  // counts can still overflow when summed — `Number.MAX_VALUE + Number.MAX_VALUE`
  // is `Infinity` — and an Infinity flowing into `costFromUsage` produces an
  // Infinite cost that would blow past the € ceiling as a "measurement". Validate
  // what is actually consumed, not only the inputs it was built from.
  const billedOutput = (isCount(candidates) ? candidates : 0) + thoughts;
  const outputUsable = Number.isFinite(billedOutput);

  return {
    input_tokens: isCount(prompt) ? prompt : 0,
    output_tokens: outputUsable ? billedOutput : 0,
    thinking_tokens: thoughts,
    usageMissing: usageMissing || !outputUsable,
  };
}

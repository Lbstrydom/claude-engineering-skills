/**
 * @fileoverview Structured extraction for Tier-C evaluation — owns the
 * extraction Zod schemas, role-specific prompt builders, egress gating, and
 * the retry-once-on-malformed-output policy. Calls provider-adapter.mjs for
 * the actual invocation; never builds a provider SDK call directly.
 *
 * Ground-truth leakage guard (round-6 audit H1, CRITICAL): the auditor
 * role's `rawContext` is split into `visibleInput` (production-equivalent
 * evidence) and `hiddenGroundTruth` (the known-defect's own answer label).
 * Prompt builders below receive ONLY `approvedContext.visibleInput` —
 * `hiddenGroundTruth` never enters `extractStructured` at all; callers pass
 * it straight to `deterministic-scorer.mjs` instead.
 *
 * Plan: docs/plans/model-swap-eval-harness.md — File-Level Plan Phase 1.
 *
 * @module scripts/lib/model-eval/structured-extractor
 */

import { z } from 'zod';
import { assertEgressSafe, isPathSensitive } from '../sensitive-egress-gate.mjs';
import { findSensitivePathMentions, EgressGateError } from './egress-path-scan.mjs';
import { redactObject } from '../redact.mjs';
import { invokeStructured, MalformedProviderOutputError } from './provider-adapter.mjs';
import { RoleSchema } from './contracts.mjs';
import { classifyLlmError } from '../robustness.mjs';

// Round-14 audit M11 fix — EgressGateError now lives in egress-path-scan.mjs
// (see that file's header) so provider-adapter.mjs can throw the SAME class;
// re-exported here for backward compatibility with existing importers of
// this module.
export { EgressGateError };

export class InvalidEvaluationInputError extends Error {
  constructor(message) { super(message); this.name = 'InvalidEvaluationInputError'; }
}

// Round-5 H3 fix — mirrors AGENTS.md's model-resolution anti-pattern note
// ("surface err.status + the real provider error.message — don't collapse
// to 'API error <status>'"): the wrapper preserves the provider's status,
// code, and retryability so callers classify errors without parsing
// messages or traversing provider-specific shapes.
export class ExtractionInvocationError extends Error {
  constructor(message, { cause, retryable = false } = {}) {
    super(message, { cause });
    this.name = 'ExtractionInvocationError';
    this.status = cause?.status ?? cause?.response?.status ?? null;
    this.code = cause?.code ?? cause?.error?.code ?? null;
    this.retryable = retryable;
  }
}

// Implementation M13 fix — narrowed to Zod validation failures and JSON
// SyntaxError specifically (provider-adapter.mjs throws these when
// JSON.parse/schema.parse fails on the Anthropic/Gemini paths), never a
// broad keyword regex that could match an unrelated provider error message.
function isRetryableMalformedOutput(err) {
  return err instanceof z.ZodError || err instanceof SyntaxError || err instanceof MalformedProviderOutputError;
}

// Round-8 audit H2 fix — unconstrained z.string() accepted an empty string as
// a "successful" extraction (defectLocation.file:'', description:''), a
// success-shaped but vacuous model response passing as valid.
// Round-9 audit H6 fix — .min(1) alone still accepted a whitespace-only
// string ("   " has length 3), which deterministic-scorer.mjs's normalize()
// then reduced to '' anyway. Trim before the length check.
const nonBlankString = (maxLen) => {
  const s = z.string().trim().min(1);
  return maxLen ? s.max(maxLen) : s;
};
// Round-11 audit M3 fix — deterministic-scorer.mjs's fuzzy matcher runs a
// tokenize+set-overlap comparison (jaccardSimilarity, round-15) per
// candidate/rubric pair; an unbounded model-output description could still
// drive disproportionate CPU/memory cost. 2000 chars is generous for a
// one-paragraph defect description — bounding at the SOURCE (extraction) is
// cheaper and more correct than adding a length-cap escape hatch inside the
// scoring algorithm itself.
export const AuditorExtractionSchema = z.object({
  defectLocation: z.object({ file: nonBlankString(500), description: nonBlankString(2000) }),
});

export const AdjudicatorExtractionSchema = z.object({
  verdict: z.enum(['true_positive', 'false_positive']),
  rationale: nonBlankString(2000),
});

// Implementation H9 fix — load-bearing evidence fields fail preflight when
// missing, never silently coalesce to '' /[] and produce a result that looks
// like a legitimate evaluation of an impoverished/empty prompt.
// Round-10 audit M1 fix — the OUTPUT (extraction) schemas already use
// nonBlankString() (round-9 H6) so a whitespace-only model response fails;
// these INPUT schemas still used bare .min(1), which a whitespace-only
// evidenceHunk/findingText/severity/filePaths entry would pass.
// Round-13 audit M3/H5 fix — .strict() so an unexpected extra field on the
// visible-input object is rejected at this boundary, not silently stripped
// — the same recurring class of fix already applied to config/schema.mjs,
// AzureRouteEntrySchema, ThresholdsSchema, and CandidateSpecSchema.
const AuditorVisibleInputSchema = z.object({
  evidenceHunk: nonBlankString(),
  filePaths: z.array(nonBlankString()).min(1),
}).strict();
const AdjudicatorVisibleInputSchema = z.object({
  findingText: nonBlankString(),
  severity: nonBlankString(),
}).strict();

/** Strip git's C-style quoting from a header path segment (round-11 audit
 * H3/H6 fix). Git quotes a path containing spaces/special/non-ASCII chars
 * as `"a/some\"escaped path.js"`; unescape just enough (\" and \\) for a
 * sensitive-name substring/pattern check to work — full octal-byte
 * decoding isn't needed since classifyPath matches on readable ASCII
 * patterns (.env, secrets/, id_rsa, etc.), not exact byte reconstruction. */
function unquoteDiffPath(raw) {
  const s = raw.trim();
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return s;
}

/** Extract file paths touched by a unified diff's own headers
 * (`diff --git a/X b/X`, `--- a/X`, `+++ b/X`, `rename/copy from/to X`,
 * and git's C-style quoted-path form for names with spaces/special chars —
 * round-9 audit H2/H9, round-10 M10, round-11 H3/H6 fixes). */
function extractDiffHeaderPaths(evidenceHunk) {
  if (typeof evidenceHunk !== 'string' || !evidenceHunk) return [];
  const paths = new Set();
  // Unquote FIRST, then strip the a/ or b/ prefix from the RESULT — git's
  // C-style quoting wraps the whole "a/some path.js" token, so the prefix
  // is inside the quotes, not outside them.
  const addPath = (raw) => {
    const unquoted = unquoteDiffPath(raw);
    if (unquoted === '/dev/null') return;
    paths.add(unquoted.replace(/^[ab]\//, ''));
  };
  for (const line of evidenceHunk.split('\n')) {
    const gitHeaderQuoted = line.match(/^diff --git ("(?:[^"\\]|\\.)*"|a\/\S+) ("(?:[^"\\]|\\.)*"|b\/\S+)$/);
    if (gitHeaderQuoted) { addPath(gitHeaderQuoted[1]); addPath(gitHeaderQuoted[2]); continue; }
    const minusHeader = line.match(/^--- (a\/.+|"(?:[^"\\]|\\.)*")$/);
    if (minusHeader) addPath(minusHeader[1]);
    const plusHeader = line.match(/^\+\+\+ (b\/.+|"(?:[^"\\]|\\.)*")$/);
    if (plusHeader) addPath(plusHeader[1]);
    const renameOrCopy = line.match(/^(?:rename|copy) (?:from|to) (.+)$/);
    if (renameOrCopy) addPath(renameOrCopy[1]);
  }
  return [...paths];
}

/**
 * Round-6 H1: only ever called with visible fields — hiddenGroundTruth is
 * never passed to this function or anything downstream of it.
 * @param {{route: object, visibleInput: Record<string, unknown>}} args
 * @returns {{approvedContext: object, redactionReport: object, egressDecision: 'send-as-is'|'send-redacted'|'blocked'}}
 */
export function prepareModelEvalPayloadForEgress({ route, visibleInput }) {
  // Round-10 audit M9 fix — this is an EXPORTED egress boundary, callable
  // directly (not just via extractStructured's already-validated path — the
  // test suite itself calls it directly). It must not trust its own
  // shape assumptions (visibleInput is an object, filePaths is an array).
  if (typeof visibleInput !== 'object' || visibleInput === null) {
    return { approvedContext: null, redactionReport: { blocked: true, reason: 'prepareModelEvalPayloadForEgress: visibleInput must be a non-null object' }, egressDecision: 'blocked' };
  }
  if (visibleInput.filePaths !== undefined && !Array.isArray(visibleInput.filePaths)) {
    return { approvedContext: null, redactionReport: { blocked: true, reason: 'prepareModelEvalPayloadForEgress: visibleInput.filePaths must be an array when present' }, egressDecision: 'blocked' };
  }
  // Round-8b audit H2 fix — assertEgressSafe only scans for secret-SHAPED
  // TEXT CONTENT (API-key/token regex patterns); it never classifies
  // filePaths entries as sensitive PATHS. A file path string like `.env` or
  // `secrets/api-keys.json` doesn't match a secret-content pattern, so it
  // could reach buildAuditorPrompt's `## Files` list unblocked even though
  // sensitive-paths.mjs's own classifier (already used elsewhere in this
  // repo for exactly this purpose) would flag it.
  // Round-9 audit H2/H9 fix — a diff's own headers can touch a sensitive
  // file without that path appearing in the (separately-supplied) filePaths
  // array — e.g. a caller that builds filePaths from a different source than
  // the raw diff text. Standard unified-diff headers (`diff --git a/X b/X`,
  // `--- a/X`, `+++ b/X`) are a well-defined, parseable format — extract the
  // paths they touch and classify those too. Free-text prose (findingText)
  // has no equivalent structured signal to parse; assertEgressSafe's
  // content-pattern scan below is what covers that field.
  // Round-11 audit H7 fix — the auditor role gets structured filePaths +
  // diff-header path classification; the adjudicator role's findingText was
  // ENTIRELY unclassified for paths (only assertEgressSafe's secret-CONTENT
  // scan ran on it), a real asymmetry. Free prose has no fixed format to
  // parse exactly like a diff header, but a bounded token scan (split on
  // whitespace/quotes/punctuation, classify tokens that look path-shaped) is
  // a well-scoped middle ground — catches "the file .env has..." without
  // attempting full NLP-grade path extraction from arbitrary prose.
  const findingTextPaths = findSensitivePathMentions(visibleInput.findingText);
  const declaredPaths = visibleInput.filePaths || [];
  const diffHeaderPaths = extractDiffHeaderPaths(visibleInput.evidenceHunk);
  const sensitivePaths = [...new Set([...declaredPaths, ...diffHeaderPaths, ...findingTextPaths])].filter(isPathSensitive);
  if (sensitivePaths.length > 0) {
    return { approvedContext: null, redactionReport: { blocked: true, reason: `sensitive file path(s): ${sensitivePaths.join(', ')}` }, egressDecision: 'blocked' };
  }
  try {
    assertEgressSafe(visibleInput, { label: `model-eval:${route.role || 'unknown'}` });
  } catch (err) {
    return { approvedContext: null, redactionReport: { blocked: true, reason: err.message }, egressDecision: 'blocked' };
  }
  const { redacted, count } = redactObject(visibleInput);
  return {
    approvedContext: redacted,
    redactionReport: { count },
    egressDecision: count > 0 ? 'send-redacted' : 'send-as-is',
  };
}

function buildAuditorPrompt(approvedContext) {
  return [
    { role: 'system', content: 'You are auditing a code diff for defects. Report the file and a description of any defect you find.' },
    { role: 'user', content: `## Diff\n${approvedContext.evidenceHunk}\n\n## Files\n${approvedContext.filePaths.join(', ')}` },
  ];
}

function buildAdjudicatorPrompt(approvedContext) {
  return [
    { role: 'system', content: 'You are adjudicating whether a reported finding is a true or false positive.' },
    { role: 'user', content: `## Finding\n${approvedContext.findingText}\n\n## Severity\n${approvedContext.severity}` },
  ];
}

/**
 * Round-8 audit M1 fix — `schema` used to be a caller-supplied param,
 * independent of `role`; a caller could pass role:'auditor' with
 * AdjudicatorExtractionSchema and nothing would catch the mismatch. The
 * output schema is now DERIVED from role internally (same fixed pair the
 * prompt/visible-input schema selection already uses) — one selector, not two
 * independently-suppliable ones.
 * Round-8b audit M12 fix — invokeStructured has always accepted a cancellation
 * `signal` (passed through to the OpenAI/Anthropic SDK's request options),
 * but this function had no way to receive one from its own caller — the one
 * layer between a caller and the provider call dropped cancellation on the
 * floor. Now propagated straight through (optional, defaults to none).
 * @param {{role: 'auditor'|'adjudicator', route: object, rawContext: object, signal?: AbortSignal}} args
 */
export async function extractStructured({ role, route, rawContext, signal }) {
  // Round-7 audit M5 fix — every branch below is `role === 'auditor' ? A : B`,
  // so an unrecognized role (typo, malformed caller input) silently fell into
  // the adjudicator branch instead of failing. Validate against the shared
  // enum up front.
  const roleParsed = RoleSchema.safeParse(role);
  if (!roleParsed.success) {
    throw new InvalidEvaluationInputError(`extractStructured: invalid role "${role}" — must be "auditor" or "adjudicator"`);
  }
  // Round-8 audit M2/L1 fix — rawContext.evidenceHunk/.filePaths used to be
  // dereferenced BEFORE validating rawContext itself is an object, so a
  // null/undefined rawContext threw a raw TypeError instead of the expected
  // structured InvalidEvaluationInputError.
  if (typeof rawContext !== 'object' || rawContext === null) {
    throw new InvalidEvaluationInputError(`extractStructured: rawContext must be a non-null object for role "${role}"`);
  }
  const schema = role === 'auditor' ? AuditorExtractionSchema : AdjudicatorExtractionSchema;
  const visibleSchema = role === 'auditor' ? AuditorVisibleInputSchema : AdjudicatorVisibleInputSchema;
  const visibleParsed = visibleSchema.safeParse(role === 'auditor'
    ? { evidenceHunk: rawContext.evidenceHunk, filePaths: rawContext.filePaths }
    : rawContext);
  if (!visibleParsed.success) {
    throw new InvalidEvaluationInputError(`extractStructured: missing/empty load-bearing evidence for role "${role}" — ${visibleParsed.error.issues.map((i) => i.path.join('.')).join(', ')}`);
  }
  const visibleInput = visibleParsed.data;
  const { approvedContext, egressDecision } = prepareModelEvalPayloadForEgress({ route: { ...route, role }, visibleInput });
  if (egressDecision === 'blocked') {
    throw new EgressGateError(`extractStructured: payload blocked by sensitive-egress-gate for role "${role}"`);
  }
  const messages = role === 'auditor' ? buildAuditorPrompt(approvedContext) : buildAdjudicatorPrompt(approvedContext);

  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await invokeStructured({ route, messages, schema, signal });
      // Round-10 audit H7 fix — the retry-once-on-malformed-output policy
      // stays (a single dropped comma shouldn't zero out an otherwise-good
      // model, and retrying transient formatting glitches is reasonable
      // production behavior), but silently returning an identical-looking
      // success regardless of attempt count DISCARDS a real capability
      // signal for an EVALUATION harness: a candidate needing a retry to
      // satisfy the schema is meaningfully different from one that didn't.
      // Expose it; don't decide the scoring policy here (Cluster B's job).
      return { ...result, requiredRetry: attempt > 0 };
    } catch (err) {
      lastErr = err;
      if (!isRetryableMalformedOutput(err)) {
        // Round-8 audit H1 fix — a genuinely transient provider error
        // (429/503/timeout/network) was previously always wrapped with
        // retryable:false, indistinguishable from a permanent failure. Reuse
        // the repo's canonical retry classifier (robustness.mjs, already
        // used for the same 429/5xx/timeout/network categories elsewhere)
        // instead of a second, narrower classification scheme.
        const { retryable } = classifyLlmError(err);
        throw new ExtractionInvocationError(`extractStructured: non-retryable invocation failure — ${err.message}`, { cause: err, retryable });
      }
    }
  }
  throw new ExtractionInvocationError(`extractStructured: malformed output after retry — ${lastErr?.message}`, { cause: lastErr, retryable: true });
}

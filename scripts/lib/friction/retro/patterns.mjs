/**
 * @fileoverview Harness-retro signal patterns — DATA, not logic (plan
 * docs/plans/harness-retro.md §2 component 2). A new phrasing is one entry here;
 * the extractors in `signals.mjs` never change for it.
 *
 * Each pattern is matched against the FIRST meaningful line of a tool result /
 * hook stderr (see `fingerprint.mjs#meaningfulLine`) unless noted. Patterns are
 * deliberately specific: a false positive here is a mis-classified kind, which
 * the judge can still see, but a too-broad `refusal` would swallow ordinary errors.
 *
 * @module scripts/lib/friction/retro/patterns
 */

/** Permission / classifier / safety-check denials (text fallback when the
 *  structured `permissionDecision` field is absent). */
export const DENIAL_PATTERNS = Object.freeze([
  /Permission for this (?:action|command) was denied/i,
  /denied by the Claude Code auto mode classifier/i,
  /built-in Claude Code safety check/i,
  /needs a person's approval/i,
  /classifier gave no verdict/i,
  /The user doesn't want to proceed with this tool use/i,
]);

/** A hook rewrote the call's input and the classifier then could not judge it —
 *  the "hook-rewrite retry" family. Checked BEFORE denials (it is more specific). */
export const HOOK_REWRITE_PATTERN = /a hook changed this call's input/i;

/** A PreToolUse hook refusing the call BEFORE it ran — enforcement that FIRED. */
export const HOOK_BLOCK_PATTERN = /^PreToolUse(?::[A-Za-z_]+)? hook error:/;
/** A post-execution hook reporting an error: the tool already ran, so this is a
 *  hook failure/feedback, not a refusal (cluster-A audit M10). */
export const POST_HOOK_ERROR_PATTERN = /^(?:PostToolUse|UserPromptSubmit|Stop)(?::[A-Za-z_]+)? hook error:/;

/** Tooling refusals — a check saying no, in an error OR a successful result.
 *  Verb PHRASES, not the bare word: a grep over docs that merely mention
 *  "refuses" must not read as a refusal (measured on the real corpus, 2026-11-16).
 *  On a non-error result only the first meaningful line is tested. */
export const REFUSAL_PATTERNS = Object.freeze([
  /\bmust be owner of\b/i,
  /\b(?:database|store|schema|checkout|branch) is behind\b/i,
  /\brefus(?:ed|es|ing) to\b/i,
  /\brefus(?:ed|ing):/i,
  /\bREFUSED\b/,
  /\bnot (?:allowed|permitted)\b/i,
  /\bblocked:/i,
]);

/** Opening phrases of a HUMAN turn that correct the agent. Only the KIND is ever
 *  kept — the user's text never leaves the reader. Anchored at the start. */
export const CORRECTION_PATTERNS = Object.freeze([
  /^(?:no|nope|stop|wait)\b[,.! ]/i,
  /^(?:don't|do not|never)\b/i,
  /^(?:that's|that is) (?:not|wrong)\b/i,
  /^(?:wrong|incorrect)\b/i,
  /^(?:i said|i told you|why did you|why are you)\b/i,
  /^not what i\b/i,
]);

/** Lines that carry no information and are skipped when picking the line to fingerprint. */
export const NOISE_LINE_PATTERNS = Object.freeze([
  /^Exit code \d+\s*$/i,
  /^\s*$/,
  /^<\/?tool_use_error>\s*$/,
  /^Failed with non-blocking status code:\s*$/i,
]);

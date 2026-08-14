/**
 * @fileoverview Final-review envelope SCOPE resolution — which envelope, and
 * which files go in it. Pure: no fs, no env reads, no I/O. Every input is a
 * parameter so the four resolution cases and the file-selection rules are
 * unit-testable without spawning the CLI.
 *
 * Plan: docs/plans/final-review-scoped-second-reviewer.md (KD-2, KD-6, §2).
 *
 * WHY THIS IS A MODULE AND NOT A BRANCH IN gemini-review.mjs: the resolution
 * has to have exactly ONE home. The failure it guards against is a library
 * caller silently re-deriving scope from ambient env while a campaign believes
 * it pinned one — see the plan's KD-6. A function nobody can bypass is the
 * cheapest form of that guarantee.
 *
 * @module scripts/lib/final-review/scope
 */

/** The closed set of envelope scopes. Order is significance, not preference. */
export const ENVELOPE_SCOPES = Object.freeze(['full', 'thin', 'gap']);

/** Default when nothing is specified anywhere — today's behaviour, unchanged. */
export const DEFAULT_ENVELOPE_SCOPE = 'full';

/**
 * Resolve the envelope scope from its two possible sources.
 *
 * ABSENT AND INVALID ARE DIFFERENT, AND THAT ASYMMETRY IS THE POINT. The
 * sibling `finalReviewConfig.reasoningEffort` silently falls back on a bad
 * value, and copying that here was a defect the plan audit caught: a wrong
 * reasoning value costs depth, whereas a wrong SCOPE value changes egress
 * volume, blindness, and how a whole cohort is interpreted. Silently resolving
 * a typo to `full` converts a deliberately cheap blind experiment into the most
 * expensive behaviour available — the exact outcome the plan exists to prevent.
 *
 * So this returns a typed result and lets the CALLER pick the disposition:
 * an interactive run warns and proceeds, a campaign run refuses before spending
 * anything. Neither decision belongs in a config module, and neither may throw
 * at import — an OPTIONAL feature must never break the MANDATORY audit path.
 *
 * `ok` exists so the failure is awkward to ignore. `scope` alone is always a
 * usable value, which means a caller reading only `scope` silently converts a
 * misspelled reduced scope into the broadest, most expensive envelope — the
 * audit's point. `ok === false` is the one field whose meaning cannot be
 * mistaken for a successful resolution, and Cluster B's campaign path hard-
 * rejects on it before spending anything.
 *
 * @param {{cliScope?: string|null, envScope?: string|null}} [sources]
 * @returns {{scope: string, source: 'cli'|'env'|'default', invalid: string|null, ok: boolean}}
 *   `invalid` carries the rejected raw value (never null-on-typo silence);
 *   `scope` is always a member of ENVELOPE_SCOPES so callers can rely on it.
 */
export function resolveEnvelopeScope({ cliScope = null, envScope = null } = {}) {
  // CLI wins over env: an explicit argv value is evidence of intent in a way an
  // inherited environment variable is not, and it appears in the process record.
  for (const [raw, source] of [[cliScope, 'cli'], [envScope, 'env']]) {
    const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (!v) continue;
    if (ENVELOPE_SCOPES.includes(v)) return { scope: v, source, invalid: null, ok: true };
    // Invalid is reported, never silently swallowed. `scope` still resolves so
    // a caller that chooses to proceed has a usable value.
    return { scope: DEFAULT_ENVELOPE_SCOPE, source, invalid: raw, ok: false };
  }
  return { scope: DEFAULT_ENVELOPE_SCOPE, source: 'default', invalid: null, ok: true };
}

/** True when this scope sends a reduced envelope (drops repo context, narrows code). */
export function isReducedScope(scope) {
  return scope === 'thin' || scope === 'gap';
}

/** True when this scope shows the reviewer the primary's findings (non-blind). */
export function isNonBlindScope(scope) {
  return scope === 'gap';
}

/**
 * Select the in-scope code files for a reduced envelope.
 *
 * "In-scope diff files only" is a slogan, not an algorithm — `changed_files`
 * legitimately contains paths that do not exist at HEAD, and leaning on the
 * reader's incidental missing-file handling makes the behaviour accidental.
 * These rules are explicit so two implementations cannot disagree, and so the
 * exclusion counts can be surfaced (a thin envelope with little code must be
 * distinguishable from a bug).
 *
 * Rename handling deserves a note: `changed_files` may carry either operand.
 * We keep whatever EXISTS on disk, which is the destination — the source is
 * gone and its content lives at the new path, so reviewing the destination
 * reviews the change.
 *
 * **`isSensitive` MUST be a CANONICALISING oracle — a lexical one is a
 * security defect here, not a simplification.** `changed_files` is
 * transcript-supplied, so a path can be named innocently and resolve, via a
 * symlink, somewhere it must never be read from; and this selector's output is
 * read into a prompt that egresses to a third party. `classifyPath` matches on
 * the visible string only and would pass such a path. Use
 * `resolveAndClassify(p, {repoRoot})`, which realpaths first, re-classifies the
 * canonical target, and fails CLOSED on a repo-escaping or unresolvable path.
 * This is INC-001's exact class (docs/security-strategy.md) and the audit
 * caught this module shipping the lexical oracle.
 *
 * @param {string[]} changedFiles - transcript.changed_files (the PR diff set)
 * @param {object} deps
 * @param {(p:string)=>boolean} deps.exists - path is a readable regular file
 * @param {(p:string)=>boolean} deps.isSensitive - CANONICALISING oracle (see above);
 *   must return true for repo-escaping and unresolvable paths, not just named ones.
 *   **Must only be called on paths that EXIST** — see `isSensitiveLexical` below.
 * @param {(p:string)=>boolean} [deps.isSensitiveLexical] - a CHEAP, NON-THROWING,
 *   name-only check (e.g. `classifyPath(p) === 'sensitive'`), used for paths
 *   that do not exist. Defaults to `isSensitive` if omitted, which is only
 *   safe when the caller's `isSensitive` never resolves the filesystem.
 * @param {(p:string)=>boolean} [deps.isAllowedExt] - extension allowlist (binary filter)
 * @param {(p:string)=>boolean} [deps.isInfra] - audit-infrastructure filter
 * @returns {{files: string[], excluded: {absent:number, sensitive:number, binary:number, infra:number}}}
 */
export function selectInScopeCodeFiles(changedFiles, {
  exists,
  isSensitive,
  isSensitiveLexical = isSensitive,
  isAllowedExt = () => true,
  isInfra = () => false,
} = {}) {
  const excluded = { absent: 0, sensitive: 0, binary: 0, infra: 0 };
  const files = [];
  const seen = new Set();

  for (const raw of Array.isArray(changedFiles) ? changedFiles : []) {
    if (typeof raw !== 'string' || !raw) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);

    // Existence gates WHICH sensitivity check runs, and that split is
    // deliberate: a canonicalising oracle (the one docs/plans/…KD-8 requires)
    // resolves the path via realpath, which THROWS on plain ENOENT — a
    // perfectly ordinary git-diff deletion. Calling it on a deleted path would
    // fail-closed to "sensitive" for every deletion, which is not what the
    // filter means to say (fixed 2026-08-14: exactly this bug, caught by the
    // cluster audit).
    //
    // The cheap lexical check needs no filesystem access and never throws, so
    // it is safe to run on a deleted path — and it still catches the case the
    // canonicalising check exists FOR: a deleted-but-suspiciously-named path
    // (`.env`, `secrets.yaml`, …) is still counted `sensitive`, not `absent`.
    // Only a path that both EXISTS and resolves outside the repo (a live
    // symlink escape) needs the full canonicalising check — and that check
    // only runs where it cannot spuriously throw on absence.
    if (!exists(raw)) {
      if (isSensitiveLexical(raw)) excluded.sensitive++;
      else excluded.absent++;
      continue;
    }
    if (isSensitive(raw)) { excluded.sensitive++; continue; }
    if (isInfra(raw)) { excluded.infra++; continue; }
    if (!isAllowedExt(raw)) { excluded.binary++; continue; }
    files.push(raw);
  }

  return { files, excluded };
}

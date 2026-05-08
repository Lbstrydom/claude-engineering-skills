/**
 * @fileoverview Pure classifier deciding whether a finding may be
 * auto-deferred at audit triage time.  Returns a deterministic
 * classification or null when no auto-defer is permitted (caller routes
 * the finding to `needs_triage` instead).
 *
 * Two gates BOTH must hold for auto-defer to fire:
 *   Gate 1 — class allowlist:    is the finding's category one we trust to
 *                                  defer mechanically?
 *   Gate 2 — deterministic SCM:  out-of-scope / pre-existing / accepted-v1
 *                                  / rigor-pressure evidence chain is solid?
 *
 * In addition, a SCOPE-MODE gate restricts auto-deferral to `--scope diff`
 * runs only.  In `--scope plan` and `--scope full` runs, the SCM evidence
 * paths (e.g. "cited file not in HEAD~1..HEAD") are uninformative because
 * the audit deliberately scoped pre-existing code IN.
 *
 * Plan: docs/plans/adaptive-learning-phase-1-foundation.md §2 (deferral-classifier)
 * Master: docs/plans/adaptive-learning-v1.md §2 data-flow item 3.
 *
 * @module scripts/lib/audit/deferral-classifier
 */

// ── Class allowlist ───────────────────────────────────────────────────────
// Categories permitted for mechanical auto-deferral.  These are local-only,
// non-semantic, non-cross-file rule types.  Anything tagged with semantic,
// security, correctness, performance, concurrency, data-integrity, or
// api-contract concerns is NEVER auto-deferred — it routes to needs_triage
// regardless of SCM evidence.

export const AUTO_DEFERRABLE_CLASSES = Object.freeze([
  'style',
  'formatting',
  'unused-import',
  'dead-code-local',
  'comment-quality',
  'naming-local',
  'magic-number-local',
]);

// Categories explicitly forbidden — even if the SCM evidence is solid,
// these always need a human eye.
export const FORBIDDEN_CLASSES = Object.freeze([
  'security',
  'correctness',
  'performance-critical',
  'concurrency',
  'data-integrity',
  'api-contract',
  'cross-file-coupling',
]);

const DEFERRAL_CLASS_VALUES = Object.freeze([
  'out-of-scope',
  'pre-existing',
  'accepted-v1',
  'rigor-pressure',
]);

// ── Plan-marker syntax ─────────────────────────────────────────────────────
// Operators may explicitly accept findings as known v1 limits by inlining
// markers in the plan markdown:
//
//   <!-- audit:accept-v1: <file-glob> :: <reason> -->
//
// The classifier matches a finding's primary file against these globs.

const ACCEPT_V1_RE = /<!--\s*audit:accept-v1:\s*([^:]+?)\s*::\s*(.+?)\s*-->/g;

/**
 * Parse `<!-- audit:accept-v1: ... -->` markers out of a plan document.
 * Returns the list of {fileGlob, reason} pairs in order.
 *
 * @param {string} planContent
 * @returns {Array<{fileGlob: string, reason: string}>}
 */
export function parseAcceptV1Markers(planContent) {
  if (!planContent || typeof planContent !== 'string') return [];
  const out = [];
  // Reset lastIndex for /g regex reuse.
  ACCEPT_V1_RE.lastIndex = 0;
  let m;
  while ((m = ACCEPT_V1_RE.exec(planContent)) !== null) {
    out.push({ fileGlob: m[1].trim(), reason: m[2].trim() });
  }
  return out;
}

/**
 * Tiny glob matcher — supports `*` (any chars excluding `/`) and `**` (any
 * chars including `/`).  Sufficient for plan-marker file globs without
 * pulling in a dependency.
 *
 * @param {string} glob
 * @param {string} filePath
 * @returns {boolean}
 */
function globMatch(glob, filePath) {
  if (!glob || !filePath) return false;
  // Translate glob to regex.  Order matters:
  //   1. Escape regex metacharacters (preserve * for the next steps).
  //   2. `**/` → `(?:.*/)?`  — zero-or-more directory segments (so
  //      `src/**/*.js` matches both `src/foo.js` AND `src/a/b/foo.js`).
  //   3. `**`  → `.*`        — bare double-star matches anything.
  //   4. `*`   → `[^/]*`     — single-star matches within one segment.
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '__DOUBLE_STAR_SLASH__')
    .replace(/\*\*/g, '__DOUBLE_STAR__')
    .replace(/\*/g, '[^/]*')
    .replace(/__DOUBLE_STAR_SLASH__/g, '(?:.*/)?')
    .replace(/__DOUBLE_STAR__/g, '.*');
  const re = new RegExp(`^${escaped}$`);
  return re.test(filePath);
}

// ── Main classifier ────────────────────────────────────────────────────────

/**
 * @typedef {object} ClassifyResult
 * @property {string} class - One of DEFERRAL_CLASS_VALUES
 * @property {object} evidence - Structured evidence chain (persisted in learning_decisions)
 * @property {boolean} isDeterministic - Always true when this fn returns a result
 */

/**
 * Decide whether a finding may be auto-deferred.  Returns null when the
 * finding fails ANY gate (class allowlist, scope-mode, deterministic SCM
 * evidence) — caller routes to `needs_triage`.
 *
 * Gates are checked in order; the first failure short-circuits to null
 * with the failing gate recorded in `_diagnostic` (test-visible).
 *
 * @param {object} finding
 * @param {string} finding.category
 * @param {string} finding.severity
 * @param {string} [finding.primary_file]   - Single TEXT (matches DB column)
 * @param {string} [finding.cited_lines]    - line citations from the LLM (free-text)
 * @param {string} [finding._hash]          - finding fingerprint for rigor-pressure
 * @param {boolean} [finding.is_mechanical]
 * @param {object} runContext
 * @param {string} runContext.scopeMode     - 'diff' | 'plan' | 'full'
 * @param {Array<string>} [runContext.changedFiles]    - from `git diff --name-only`.
 *   Pass `null` (NOT `[]`) when the diff is unknown — empty array is treated as
 *   authoritative "no files changed" and would NOT trigger the out-of-scope path.
 * @param {string} [runContext.runStartCommit]
 * @param {Array<Set<string>>} [runContext.priorRoundHashes] - per-round finding-hash sets,
 *   most-recent last.  Each round's hashes must be in a SEPARATE inner array/Set so
 *   rigor-pressure can verify the same hash appeared in DIFFERENT rounds (not 2× in 1 round).
 *   Legacy flat-array form is still accepted for backwards compatibility but logs a
 *   one-time deprecation warning.
 * @param {string} [runContext.planContent]            - raw plan markdown (for accept-v1 markers)
 * @returns {ClassifyResult|null}
 */
export function classifyDeferralEvidence(finding, runContext) {
  if (!finding || typeof finding !== 'object') return null;
  if (!runContext || typeof runContext !== 'object') return null;

  // ── Gate: scope mode ────────────────────────────────────────────────────
  // Auto-deferral is only valid in --scope diff runs.  In plan/full scopes,
  // the SCM evidence paths produce false negatives.
  if (runContext.scopeMode !== 'diff') {
    return null;
  }

  // ── Gate: class allowlist ───────────────────────────────────────────────
  const cat = finding.category || '';
  if (FORBIDDEN_CLASSES.includes(cat)) return null;
  if (!AUTO_DEFERRABLE_CLASSES.includes(cat)) return null;

  // ── Gate: deterministic SCM evidence ────────────────────────────────────
  // Evaluated in priority order; first match wins.

  // (a) accepted-v1 plan markers
  const planContent = runContext.planContent || '';
  const filePath = finding.primary_file || '';
  if (filePath && planContent) {
    const markers = parseAcceptV1Markers(planContent);
    const match = markers.find(m => globMatch(m.fileGlob, filePath));
    if (match) {
      return {
        class: 'accepted-v1',
        evidence: { type: 'plan-marker', fileGlob: match.fileGlob, reason: match.reason, file: filePath },
        isDeterministic: true,
      };
    }
  }

  // (b) out-of-scope: cited file NOT in --changed.
  // Audit-fix H3: empty array `changedFiles=[]` is suspicious — it can mean
  // "diff resolution failed" rather than "the audit truly touched zero files".
  // Treat empty as "unknown" (not authoritative) so we don't silently mass-
  // defer everything as out-of-scope.  Callers that genuinely want to express
  // "no files changed" should not be running auto-deferral at all.
  const changedFiles = Array.isArray(runContext.changedFiles) && runContext.changedFiles.length > 0
    ? runContext.changedFiles
    : null;
  if (changedFiles && filePath) {
    if (!changedFiles.includes(filePath)) {
      return {
        class: 'out-of-scope',
        evidence: {
          type: 'file-not-in-diff',
          file: filePath,
          changedCount: changedFiles.length,
        },
        isDeterministic: true,
      };
    }
  }

  // (c) rigor-pressure: same finding hash in TWO DIFFERENT prior rounds.
  // Audit-fix H2: priorRoundHashes is a list of per-round Sets/arrays, NOT
  // a flat list.  This prevents a duplicate hash within the same round from
  // satisfying the "appeared in 2 rounds" check.
  const priorRounds = runContext.priorRoundHashes;
  const findingHash = finding._hash || finding.hash || null;
  if (findingHash && Array.isArray(priorRounds) && priorRounds.length >= 2) {
    const lastTwoRounds = priorRounds.slice(-2);
    // Detect legacy flat-array form (an array of strings rather than of Sets/arrays).
    const isLegacyFlat = lastTwoRounds.every(h => typeof h === 'string');
    let appearedInRound1 = false;
    let appearedInRound2 = false;
    if (isLegacyFlat) {
      // Legacy: each entry IS a single hash; need 2 distinct rounds with the same hash.
      // We can't actually verify "different rounds" from a flat array, so the result
      // is unreliable — we fall back to the prior (over-permissive) behavior with a
      // deprecation hint inlined into the evidence so callers can see the gap.
      const matches = lastTwoRounds.filter(h => h === findingHash).length;
      if (matches >= 2) {
        return {
          class: 'rigor-pressure',
          evidence: {
            type: 'recurring-finding-hash',
            hash: findingHash,
            rounds: priorRounds.length,
            _deprecated: 'priorRoundHashes was a flat array; cannot verify distinct-round presence',
          },
          isDeterministic: true,
        };
      }
    } else {
      // Modern: each entry is an array OR Set of that round's hashes.
      const hasHashIn = (round) => {
        if (round instanceof Set) return round.has(findingHash);
        if (Array.isArray(round)) return round.includes(findingHash);
        return false;
      };
      appearedInRound1 = hasHashIn(lastTwoRounds[0]);
      appearedInRound2 = hasHashIn(lastTwoRounds[1]);
      if (appearedInRound1 && appearedInRound2) {
        return {
          class: 'rigor-pressure',
          evidence: {
            type: 'recurring-finding-hash',
            hash: findingHash,
            rounds: priorRounds.length,
            verifiedDistinctRounds: true,
          },
          isDeterministic: true,
        };
      }
    }
  }

  // (d) pre-existing — requires git blame, which we treat as advisory only
  // for v1.  The classifier returns null for findings that might be pre-
  // existing but aren't otherwise classified; weekly review surfaces them.
  // (Implementing git-blame check inline would couple the classifier to a
  // git subprocess on the audit hot path; deferred to a v1.x enhancement.)

  return null;
}

// ── Public introspection helpers ───────────────────────────────────────────

export function isAutoDeferrableClass(category) {
  return AUTO_DEFERRABLE_CLASSES.includes(category);
}

export function isForbiddenClass(category) {
  return FORBIDDEN_CLASSES.includes(category);
}

export const _internals = Object.freeze({
  AUTO_DEFERRABLE_CLASSES,
  FORBIDDEN_CLASSES,
  DEFERRAL_CLASS_VALUES,
  globMatch,
});

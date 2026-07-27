/**
 * @fileoverview Pattern matrix + matcher for the prospective quickfix hook.
 * Plan: docs/plans/brainstorm-quickfix-v1.md §B1, §11.D, §12.D, §12.F, §13.A, §15.A.
 *
 * Pure pattern matcher — `matchPatterns()` does no network I/O on the hot
 * path.  Phase 2 added an opt-in synchronous file read (`loadSkippedPatternSet`)
 * to consult the adaptive-learning cache (`.audit/quickfix-pattern-stats.json`)
 * for low-acceptance patterns the user has effectively suppressed; the hook
 * loads this once per session and passes the skip-set to matchPatterns.
 *
 * Plan (Phase 2): docs/plans/adaptive-learning-phase-2-quickfix.md §2 — hot-path
 * stays synchronous; cache freshness enforced by the out-of-band reconciler.
 *
 * @module scripts/lib/quickfix-patterns
 */
import fs from 'node:fs';
import path from 'node:path';
import { redactSecrets } from './secret-patterns.mjs';
import { classifyPath, normalisePath as canonicalNormalisePath } from './sensitive-paths.mjs';
import {
  parseValidatedThreshold, parseValidatedMinHits,
  QUICKFIX_SKIP_THRESHOLD_DEFAULT, QUICKFIX_MIN_HITS_DEFAULT,
} from './quickfix-policy.mjs';

const STATS_CACHE_PATH = '.audit/quickfix-pattern-stats.json';

const MAX_INPUT_CHARS = 80_000;            // §B1 — bail at >2000 lines
const SNIPPET_MAX_CHARS = 80;              // §10.G — display cap

// Shared identifier-vocabulary constants for `valid-zero-coercion` and the
// `fail-open-auth-*` patterns (round-1 audit "Single Source of Truth /
// Maintainability" — the numeric/auth token lists previously appeared
// hand-duplicated across 4 alternation branches per pattern; a future
// addition risked updating one branch but not another). Each pair is the
// same word list in lowercase (for the exact-word/snake_case branches) and
// Capitalized (for the camelCase-suffix branch).
const NUMERIC_TERMS = ['count', 'total', 'amount', 'quantity', 'qty', 'price', 'sum', 'index', 'idx', 'size', 'len'];
const NUMERIC_TERMS_CAP = ['Count', 'Total', 'Amount', 'Quantity', 'Qty', 'Price', 'Sum', 'Index', 'Idx', 'Size', 'Len'];
const AUTH_TERMS = ['auth', 'authorized', 'authenticated', 'authorization', 'allow', 'allowed', 'permit', 'permitted', 'permission', 'grant', 'granted', 'access', 'accessed'];
const AUTH_TERMS_CAP = ['Auth', 'Authorized', 'Authenticated', 'Authorization', 'Allow', 'Allowed', 'Permit', 'Permitted', 'Permission', 'Grant', 'Granted', 'Access', 'Accessed'];

/**
 * Builds the 4-branch identifier-boundary regex SOURCE (exact whole-word,
 * camelCase suffix, snake_case prefix, snake_case suffix) from a lowercase
 * term list + its Capitalized counterpart. Each token can only start a
 * match at a real word/case/underscore boundary — never mid-word inside an
 * unrelated identifier (e.g. `count` must not match inside `country`).
 * Round-1 audit "Single Source of Truth" — the ONE place this shape is
 * defined; `valid-zero-coercion` and both `fail-open-auth-*` patterns
 * compose their regex from this instead of hand-duplicating it.
 *
 * @param {string[]} terms - lowercase words
 * @param {string[]} termsCap - same words, Capitalized
 * @returns {string} regex source (no delimiters/flags)
 */
function identifierBoundaryFragment(terms, termsCap) {
  const words = terms.join('|');
  const wordsCap = termsCap.join('|');
  return `(?:\\b(?:${words})\\b|\\b[a-z]\\w*(?:${wordsCap})\\b|\\b\\w+_(?:${words})\\b|\\b(?:${words})_\\w+\\b)`;
}

const NUMERIC_BOUNDARY = identifierBoundaryFragment(NUMERIC_TERMS, NUMERIC_TERMS_CAP);
const AUTH_BOUNDARY = identifierBoundaryFragment(AUTH_TERMS, AUTH_TERMS_CAP);

/**
 * Pattern matrix. Each entry has:
 *   - name: stable id used in telemetry + system message
 *   - severity: 'low' | 'medium' | 'high'
 *   - regex: matcher applied per line by default
 *   - multiline: if true, regex is evaluated against the WHOLE diff text
 *     instead of line-by-line — used for patterns that span newlines
 *     like `catch (e) {\n  return null;\n}` (Audit Gemini-G3-M1)
 *   - suggestion: shown to the user
 *   - langGuard: optional regex on the file extension; if set, pattern
 *                only fires for matching extensions
 *   - nearby: optional {tokens: RegExp[], windowChars: number} — when set,
 *             a multiline candidate match only counts if the text within
 *             windowChars of the match satisfies at least one token
 *             (plan: docs/plans/quickfix-blindspot-patterns.md
 *             Pattern Contract "The `nearby` field")
 */
export const PATTERNS = Object.freeze([
  {
    name: 'empty-catch',
    severity: 'medium',
    // Multiline-aware: matches `catch (e) {}` AND `catch (e) {\n}` AND `catch (e) {\n  \n}`.
    regex: /catch\s*(?:\([^)]*\))?\s*\{\s*\}/m,
    multiline: true,
    suggestion: 'Empty catch swallows errors silently. Either log + rethrow, fix the underlying cause, or annotate why ignoring is safe.',
  },
  {
    name: 'todo-fixme-hack',
    severity: 'low',
    regex: /(?:^|[^a-zA-Z0-9_])(TODO|FIXME|HACK|XXX)(?:\b|:)/,
    suggestion: 'Marker comment indicates incomplete work. Track in an issue or remove before merge.',
  },
  {
    name: 'ts-ignore-no-justification',
    severity: 'medium',
    regex: /@ts-ignore\s*$|@ts-ignore[^\S\n]*$/m,
    suggestion: '@ts-ignore without a trailing explanation hides type errors. Add a comment explaining why, or fix the underlying type.',
    langGuard: /\.(ts|tsx|mts|cts)$/,
  },
  {
    name: 'ts-expect-error-no-justification',
    severity: 'medium',
    regex: /@ts-expect-error\s*$|@ts-expect-error[^\S\n]*$/m,
    suggestion: '@ts-expect-error without a trailing explanation. Add a comment explaining the expected error.',
    langGuard: /\.(ts|tsx|mts|cts)$/,
  },
  {
    name: 'eslint-disable-no-rule',
    severity: 'medium',
    regex: /eslint-disable-next-line\s*$|eslint-disable-line\s*$/m,
    suggestion: 'eslint-disable without a rule name disables ALL rules. Specify the rule(s) being disabled and why.',
  },
  {
    name: 'py-noqa-no-code',
    severity: 'low',
    regex: /#\s*noqa\s*$/m,
    suggestion: '`# noqa` without an error code suppresses everything. Specify codes (e.g. `# noqa: E501`).',
    langGuard: /\.py$/,
  },
  {
    name: 'py-pylint-disable-no-reason',
    severity: 'low',
    regex: /#\s*pylint:\s*disable=[\w,-]+\s*$/m,
    suggestion: 'pylint disable without a trailing reason comment. Add `  # reason: ...` so reviewers know why.',
    langGuard: /\.py$/,
  },
  {
    name: 'magic-number-conditional',
    severity: 'low',
    // Captures `if/while/for (...) X` where X is a digit literal NOT 0/1/-1
    regex: /\b(if|while|for)\s*\([^)]*?\b(?!(?:0|1|-1)\b)\d{2,}\b/,
    suggestion: 'Magic number in a condition. Extract to a named constant so the threshold is documented.',
  },
  {
    name: 'masked-error',
    severity: 'high',
    // Multiline-aware: `catch (e) {\n  return null;\n}` should match.
    regex: /catch\s*\(\s*\w+\s*\)\s*\{\s*return\s*(?:null|undefined|\[\]|\{\})\s*;?\s*\}/m,
    multiline: true,
    suggestion: 'Catch-and-return-empty masks the real failure. Surface the error or fix root cause.',
  },
  {
    name: 'disabled-assertion',
    severity: 'medium',
    regex: /(?:\/\/\s*expect\s*\(|\/\/\s*assert\s*\(|\bxit\s*\(|\bxdescribe\s*\(|\.skip\s*\()/,
    suggestion: 'Disabled or skipped test assertion. If intentional, document why. If temporary, track in an issue.',
  },
  {
    name: 'hardcoded-localhost',
    severity: 'medium',
    regex: /\|\|\s*['"]localhost(?::\d+)?['"]/,
    suggestion: 'Hardcoded localhost fallback. Move to config (env var) so non-local environments work.',
  },
  {
    name: 'hardcoded-http-url',
    severity: 'medium',
    regex: /\|\|\s*['"]http:\/\/[^'"]+['"]/,
    suggestion: 'Hardcoded HTTP URL fallback. Move to config; prefer HTTPS.',
  },
  {
    name: 'transaction-empty-catch',
    severity: 'high',
    // Fires on any catch (inside a transaction/lock nearby window) that
    // does NOT rollback or rethrow — logging alone does not release a
    // held transaction/lock, unlike the generic masked-error case.
    regex: /catch\s*(?:\([^)]*\))?\s*\{(?![^{}]*\b(?:rollback|throw)\b)[^{}]*\}/im,
    multiline: true,
    nearby: { tokens: [/\.transaction\(/, /\b(?:begin|commit|rollback)\b/i], windowChars: 200 },
    suggestion: 'Catch inside a transaction or lock scope neither rolls back nor rethrows — the transaction can stay open or the lock held even if the error is logged. Roll back or release explicitly, then rethrow.',
    langGuard: /\.(js|mjs|cjs|ts|tsx|jsx)$/,
  },
  {
    name: 'valid-zero-coercion',
    severity: 'medium',
    // Only fires in a value-producing position (assignment/property/return)
    // so it never suggests replacing || with ?? inside a boolean conditional
    // (Gemini gate G3 round 4 — that swap silently changes truthy/falsy semantics).
    // Allows an optional dotted-member prefix between the anchor and the
    // identifier (code-audit R1 — `return row.count || 10`, `stats.totalCount`,
    // `item.price` are the common real-world shape; the anchor previously
    // required the identifier immediately after `=`/`:`/`return`).
    // The `=` anchor is a genuine assignment ONLY — `(?<![=!<>])=(?!=)`
    // excludes the trailing `=` of `===`/`!==`/`<=`/`>=` and the 2nd `=`
    // of `==` (code-audit Gemini gate G2, round 2: `if (itemCount === qty
    // || totalItems)` previously matched via the last `=` of `===`,
    // re-opening the exact harmful-boolean-conditional false positive the
    // round-4 G3 anchor was added to close).
    regex: new RegExp(`(?:(?<![=!<>])=(?!=)|:|\\breturn\\b)\\s*(?:[\\w$]+\\.)*${NUMERIC_BOUNDARY}\\s*\\|\\|\\s*(?!0\\b(?!\\.))(?:-?[\\d.]+|[\`'"][^\`'"]*[\`'"]|[\\w$]+)`),
    suggestion: 'Coercing a falsy value here silently overwrites a valid 0 with a different default. Use `??` (nullish coalescing) so 0 survives and only null/undefined are replaced.',
    langGuard: /\.(js|mjs|cjs|ts|tsx|jsx)$/,
  },
  {
    name: 'fail-open-auth-return-true',
    severity: 'high',
    regex: /catch\s*(?:\([^)]*\))?\s*\{[^{}]*?\breturn\s+true\b[^{}]*\}/m,
    multiline: true,
    nearby: {
      tokens: [new RegExp(AUTH_BOUNDARY), /\bcan[A-Z]\w*\b/],
      windowChars: 200,
    },
    suggestion: 'Catch-and-return-true near an authorization check fails OPEN — an error becomes "access granted." Fail closed: return/throw the real error, or return false.',
    langGuard: /\.(js|mjs|cjs|ts|tsx|jsx)$/,
  },
  {
    name: 'fail-open-auth-assignment',
    severity: 'high',
    // Same AUTH_BOUNDARY fragment as fail-open-auth-return-true's nearby
    // check, composed here (self-scoped — no nearby needed since the auth
    // context lives in the matched identifier itself).
    regex: new RegExp(`catch\\s*(?:\\([^)]*\\))?\\s*\\{[^{}]*?(?:[\\w$]+\\.)*${AUTH_BOUNDARY}\\s*=\\s*true\\b[^{}]*\\}`, 'm'),
    multiline: true,
    suggestion: 'Catch block sets an auth-sounding flag to true — fails OPEN on error. Fail closed: set it false (or leave unset) and surface/log the real failure.',
    langGuard: /\.(js|mjs|cjs|ts|tsx|jsx)$/,
  },
]);

/**
 * Per-file-ext suppression syntax. Default fallback accepts either
 * `// quickfix-hook:ignore` or `# quickfix-hook:ignore`.
 */
export const SUPPRESS_BY_EXT = Object.freeze({
  '.js': /\/\/\s*quickfix-hook:ignore/,
  '.mjs': /\/\/\s*quickfix-hook:ignore/,
  '.cjs': /\/\/\s*quickfix-hook:ignore/,
  '.ts': /\/\/\s*quickfix-hook:ignore/,
  '.tsx': /\/\/\s*quickfix-hook:ignore/,
  '.jsx': /\/\/\s*quickfix-hook:ignore/,
  '.py': /#\s*quickfix-hook:ignore/,
  '.sh': /#\s*quickfix-hook:ignore/,
  '.rb': /#\s*quickfix-hook:ignore/,
  '.html': /<!--\s*quickfix-hook:ignore\s*-->/,
  '.css': /\/\*\s*quickfix-hook:ignore\s*\*\//,
  '.scss': /\/\/\s*quickfix-hook:ignore/,
  __default__: /(?:\/\/|#)\s*quickfix-hook:ignore/,
});

/**
 * Re-export of the canonical `normalisePath` from `sensitive-paths.mjs`.
 * Kept here so legacy importers (`tests/quickfix-patterns.test.mjs`,
 * downstream consumers) don't have to change their import sites.
 *
 * @param {string} pathInput
 * @returns {string}
 */
export function normalisePath(pathInput) {
  return canonicalNormalisePath(pathInput);
}

/**
 * True iff the path matches the canonical `sensitive` category. Thin
 * delegate to `scripts/lib/sensitive-paths.mjs::classifyPath` — the
 * single source of truth (plan: docs/plans/sustainability-cleanup-batch.md
 * WS3, R1-H4).
 *
 * @param {string} pathInput
 * @returns {boolean}
 */
export function isSensitivePath(pathInput) {
  return classifyPath(pathInput) === 'sensitive';
}

/**
 * True iff the line contains a per-line suppression marker for the
 * file's language.
 *
 * @param {string} line
 * @param {string} filePath
 * @returns {boolean}
 */
export function hasSuppression(line, filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  const re = SUPPRESS_BY_EXT[ext] || SUPPRESS_BY_EXT.__default__;
  return re.test(line);
}

/**
 * Returns a NEW RegExp with the same source and flags as `regex` plus
 * `g` (added only if not already present). Never mutates `regex` itself,
 * so a pattern's `PATTERNS.regex` object stays safe to reuse elsewhere
 * (round-3 audit L1 — robustness invariant for the `nearby` extension
 * point). Internal — not part of the stable hook API (plan: File-Level
 * Plan "two internal (non-exported) helpers"; code-audit R1 Structure
 * finding — this was mistakenly exported).
 *
 * @param {RegExp} regex
 * @returns {RegExp}
 */
function toGlobalRegex(regex) {
  const flags = regex.flags.includes('g') ? regex.flags : regex.flags + 'g';
  return new RegExp(regex.source, flags);
}

/**
 * Generator over every match of `regex` against `text`, using a
 * global-flag clone (via `toGlobalRegex`) so the source regex's own
 * `lastIndex` is never touched. Advances past a zero-length match by 1
 * char to avoid an infinite loop. Internal — see `toGlobalRegex`.
 *
 * @param {RegExp} regex
 * @param {string} text
 * @yields {RegExpExecArray}
 */
function* iterateRegexMatches(regex, text) {
  const re = toGlobalRegex(regex);
  let m;
  while ((m = re.exec(text)) !== null) {
    yield m;
    if (m[0].length === 0) re.lastIndex += 1;
  }
}

/**
 * Run pattern matcher on diff text. Returns array of matches (possibly
 * empty). REDACTS each matched line BEFORE truncation (§15.A) so partial
 * secrets cannot leak into the output.
 *
 * @param {string} diffText - new lines from the edit (Edit.new_string or Write.content)
 * @param {{filePath?: string, skipPatterns?: Set<string>|null, fullFileText?: string}} [opts]
 *   skipPatterns: optional set of pattern names to skip (Phase 2 adaptive-learning).
 *   Computed once per hook session via `loadSkippedPatternSet()` and passed in;
 *   matchPatterns itself remains free of cache I/O on the hot path.
 *   fullFileText: optional full post-edit file content (code-audit Gemini gate
 *   G1, round 2 — an `Edit` call's `diffText` is just `new_string`, the
 *   isolated snippet being written, which usually does NOT contain 200 chars
 *   of surrounding context. When provided, a `nearby` pattern's window is
 *   computed from `fullFileText` (locating the match there) instead of from
 *   the isolated `diffText`, so `nearby` can see context outside the edited
 *   region — e.g. a `.transaction(` wrapper the edit itself didn't touch.
 *   The primary `pattern.regex` search always stays scoped to `diffText`
 *   (only flag shapes actually in the edited region); `fullFileText` is
 *   consulted ONLY for the `nearby` context check. Falls back to the
 *   `diffText`-only window when absent (`Write` calls, or when the hook
 *   can't read the file) or when the match text isn't found there.
 * @returns {Array<{name: string, severity: string, snippet: string, suggestion: string}>}
 */
export function matchPatterns(diffText, opts = {}) {
  if (typeof diffText !== 'string' || diffText.length === 0) return [];
  // Audit R1-M8: surface bypass on huge inputs (was silent before)
  if (diffText.length > MAX_INPUT_CHARS) {
    process.stderr.write(`  [quickfix-patterns] WARN: input ${diffText.length} chars > ${MAX_INPUT_CHARS} cap — coverage skipped for this edit\n`);
    return [];
  }
  const filePath = opts.filePath || '';
  // Audit R1-M12 + R4-M6: enforce sensitive-path exclusion inside the
  // public API. NO escape hatch — sensitive-file scanning is a project
  // policy, not a per-call option. Callers that genuinely need to test
  // pattern matching against synthetic content can pass an empty
  // filePath (which falls through this guard).
  if (filePath && isSensitivePath(filePath)) {
    return [];
  }
  const lines = diffText.split('\n');
  const matches = [];
  const skipSet = (opts.skipPatterns instanceof Set) ? opts.skipPatterns : null;

  // Suppression check for a multiline candidate match — the match-line
  // itself, OR the preceding line (Audit Gemini-G4-L1: a multi-line
  // `catch (e) {…}` block can't have the marker on the brace line, so
  // users naturally place it on the line above, e.g. the try block's own
  // closing `}` line: `} // quickfix-hook:ignore\ncatch (e) {\n}`). The
  // preceding-line check is skipped when that line itself contains another
  // `catch` — code-audit Gemini gate G1 follow-up: once multiple candidates
  // are actually iterated (rather than the pre-fix single-`exec()`
  // short-circuit), a DIFFERENT, already-matched catch statement's own
  // trailing `// quickfix-hook:ignore` would otherwise also suppress the
  // NEXT, unrelated catch merely because it sits on the line above.
  const isSuppressedCandidate = (candidateIndex) => {
    const lineStart = diffText.lastIndexOf('\n', candidateIndex - 1) + 1;
    const lineEnd = diffText.indexOf('\n', candidateIndex);
    const matchLine = diffText.slice(lineStart, lineEnd === -1 ? diffText.length : lineEnd);
    if (hasSuppression(matchLine, filePath)) return true;
    const prevLineEnd = lineStart > 0 ? lineStart - 1 : 0;
    const prevLineStart = diffText.lastIndexOf('\n', prevLineEnd - 1) + 1;
    const prevLine = prevLineEnd > 0 ? diffText.slice(prevLineStart, prevLineEnd) : '';
    return !!prevLine && !/\bcatch\b/.test(prevLine) && hasSuppression(prevLine, filePath);
  };

  // Audit Gemini-G3-M1: multiline patterns evaluate against the WHOLE
  // diff so `catch (e) {\n  return null;\n}` style code (which spans
  // newlines after formatting) is detected. We still scan line-by-line
  // for non-multiline patterns to keep snippets focused.
  for (const pattern of PATTERNS) {
    if (!pattern.multiline) continue;
    if (skipSet && skipSet.has(pattern.name)) continue; // Phase 2 adaptive-learning skip
    if (pattern.langGuard && !pattern.langGuard.test(filePath)) continue;
    // Iterate ALL candidate matches — not just the first `exec()` result —
    // because a non-qualifying (nearby-unsatisfied OR suppressed) candidate
    // earlier in the diff must not shadow a qualifying one later on
    // (round-2 audit M1 for `nearby`; code-audit Gemini gate G1 for
    // suppression — a suppressed match previously short-circuited the
    // WHOLE pattern instead of just that one candidate).
    let m = null;
    const { tokens, windowChars } = pattern.nearby || {};
    for (const candidate of iterateRegexMatches(pattern.regex, diffText)) {
      if (isSuppressedCandidate(candidate.index)) continue;
      if (pattern.nearby) {
        // Prefer fullFileText for the nearby window (code-audit Gemini gate
        // G1, round 2) — an isolated Edit snippet often lacks 200 chars of
        // surrounding context. Locate this candidate's matched text in the
        // full file; fall back to the diffText-relative window if absent
        // or not found there.
        let winStart = Math.max(0, candidate.index - windowChars);
        let winEnd = Math.min(diffText.length, candidate.index + candidate[0].length + windowChars);
        let window = diffText.slice(winStart, winEnd);
        if (typeof opts.fullFileText === 'string') {
          const fullIndex = opts.fullFileText.indexOf(candidate[0]);
          if (fullIndex !== -1) {
            const fWinStart = Math.max(0, fullIndex - windowChars);
            const fWinEnd = Math.min(opts.fullFileText.length, fullIndex + candidate[0].length + windowChars);
            window = opts.fullFileText.slice(fWinStart, fWinEnd);
          }
        }
        if (!tokens.some(t => t.test(window))) continue;
      }
      m = candidate;
      break;
    }
    if (!m) continue;
    // For multiline matches, snippet shows the matched range itself
    // (truncated) rather than the single line — gives the reviewer the full
    // pattern that fired.
    const matched = m[0];
    const redacted = redactSecrets(matched).text;
    const snippet = redacted.length > SNIPPET_MAX_CHARS
      ? redacted.slice(0, SNIPPET_MAX_CHARS - 3) + '...'
      : redacted;
    matches.push({
      name: pattern.name,
      severity: pattern.severity,
      snippet,
      suggestion: pattern.suggestion,
    });
  }

  // Per-line patterns (the default)
  for (const line of lines) {
    if (hasSuppression(line, filePath)) continue;
    for (const pattern of PATTERNS) {
      if (pattern.multiline) continue;  // already handled above
      if (skipSet && skipSet.has(pattern.name)) continue; // Phase 2 adaptive-learning skip
      if (pattern.langGuard && !pattern.langGuard.test(filePath)) continue;
      if (!pattern.regex.test(line)) continue;
      // §15.A — redact full line FIRST, then truncate
      const redacted = redactSecrets(line).text;
      const snippet = redacted.length > SNIPPET_MAX_CHARS
        ? redacted.slice(0, SNIPPET_MAX_CHARS - 3) + '...'
        : redacted;
      matches.push({
        name: pattern.name,
        severity: pattern.severity,
        snippet,
        suggestion: pattern.suggestion,
      });
    }
  }
  return matches;
}

// ── Phase 2 — adaptive-learning hooks ──────────────────────────────────────
//
// `loadSkippedPatternSet()` is the ONLY I/O-bearing API in this module.
// The hook calls it once per session and passes the resulting Set into
// `matchPatterns()`.  matchPatterns itself stays purely synchronous +
// in-memory on the hot path (no fs/network calls per Edit/Write).
//
// Cache freshness is enforced by the out-of-band reconciler (`backfill-
// outcomes.mjs`) which periodically rebuilds the cache file.  A stale cache
// here at worst causes one session of slightly-out-of-date pattern weights —
// acceptable trade-off vs. blocking the editor hook on a Supabase round trip.
//
// Plan: docs/plans/adaptive-learning-phase-2-quickfix.md §2 (synchronous
// hot-path contract).

const _SKIP_THRESHOLD = parseValidatedThreshold(process.env.LEARNING_QUICKFIX_SKIP_THRESHOLD, QUICKFIX_SKIP_THRESHOLD_DEFAULT);
const _MIN_HITS       = parseValidatedMinHits(process.env.LEARNING_QUICKFIX_MIN_HITS, QUICKFIX_MIN_HITS_DEFAULT);

/**
 * Synchronously load the skip-set from the adaptive-learning cache.
 * Returns an empty Set when:
 *   - LEARNING_DISABLE=1 or LEARNING_QUICKFIX=off
 *   - cache file missing or unreadable
 *   - any individual pattern entry malformed
 *
 * Skip rule mirrors `quickfix-stats.shouldSkipPattern`: a pattern is
 * skipped when `acceptanceRate < threshold AND totalHits >= minHits`.
 *
 * @param {object} [opts]
 * @param {string} [opts.cachePath] — defaults to `.audit/quickfix-pattern-stats.json`
 * @param {object} [opts.env]       — defaults to process.env (test injection)
 * @returns {Set<string>} — pattern names to skip on the hot path
 */
export function loadSkippedPatternSet({
  cachePath = STATS_CACHE_PATH,
  env = process.env,
} = {}) {
  if (env.LEARNING_DISABLE === '1' || env.LEARNING_QUICKFIX === 'off') return new Set();
  let raw;
  try {
    if (!fs.existsSync(cachePath)) return new Set();
    raw = fs.readFileSync(cachePath, 'utf-8');
  } catch { return new Set(); }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return new Set(); }
  if (!parsed || typeof parsed !== 'object' || !parsed.patterns) return new Set();
  const skip = new Set();
  for (const [name, entry] of Object.entries(parsed.patterns)) {
    if (!entry || typeof entry !== 'object') continue;
    const rate = typeof entry.acceptanceRate === 'number' ? entry.acceptanceRate : null;
    const hits = typeof entry.totalHits === 'number' ? entry.totalHits : 0;
    if (rate === null) continue;
    if (rate < _SKIP_THRESHOLD && hits >= _MIN_HITS) skip.add(name);
  }
  return skip;
}

/**
 * @internal — exposed for tests + diagnostics; not part of the stable
 * hook API.  Returns the loaded cache snapshot (or null) without
 * applying the skip threshold.
 */
export function _loadStatsForTest(cachePath = STATS_CACHE_PATH) {
  try {
    if (!fs.existsSync(cachePath)) return null;
    return JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
  } catch { return null; }
}

/**
 * @internal — exposed for tests only (failure-contract refactor, Round 2
 * fix M3). `_SKIP_THRESHOLD`/`_MIN_HITS` are module-level `const`s computed
 * once at import time, so a test cannot retroactively change them by
 * mutating `process.env` after this module has already been evaluated —
 * the migration-regression test spawns a fresh child process and reads
 * this export's JSON output instead.
 * @returns {{ skipThreshold: number, minHits: number }}
 */
export function _getResolvedPolicyForTest() {
  return { skipThreshold: _SKIP_THRESHOLD, minHits: _MIN_HITS };
}

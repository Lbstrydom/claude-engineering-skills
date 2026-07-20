/**
 * @fileoverview Phase D — secret-pattern scanner for debt capture (fix R2-H5).
 *
 * Debt entries include free-text fields (detailSnapshot, section, category,
 * rationale) that can accidentally carry secrets copied from source files —
 * even when the source file itself isn't flagged as sensitive.
 *
 * This is a defense-in-depth check, NOT a full secret-scanning tool. It
 * catches common secret shapes and redacts them before persistence. High-security
 * repos should still run dedicated secret scanning in CI.
 *
 * Patterns are deliberately conservative — false positives cost less than
 * persisting a real secret. We err toward redacting.
 *
 * @module scripts/lib/secret-patterns
 */

/**
 * Pattern registry. Each entry matches a specific secret shape.
 * name is used in the redaction placeholder.
 */
export const SECRET_PATTERNS = Object.freeze([
  // OpenAI / Anthropic / Google / Supabase API keys (modern formats)
  { name: 'openai-key', re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'google-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'supabase-key', re: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g }, // JWT-shaped
  // AWS
  { name: 'aws-access-key-id', re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { name: 'aws-secret-key', re: /\baws_secret_access_key\s*[:=]\s*['"]?[A-Za-z0-9/+=]{40}['"]?/gi },
  // GitHub
  { name: 'github-pat', re: /\bghp_[A-Za-z0-9]{36}\b/g },
  { name: 'github-oauth', re: /\bgho_[A-Za-z0-9]{36}\b/g },
  { name: 'github-app', re: /\b(?:ghu|ghs)_[A-Za-z0-9]{36}\b/g },
  // Slack
  { name: 'slack-token', re: /\bxox[abpr]-[A-Za-z0-9-]{10,}\b/g },
  // Stripe
  { name: 'stripe-key', re: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{24,}\b/g },
  // Generic high-entropy token after keywords (conservative — requires the keyword)
  {
    name: 'generic-token',
    re: /\b(?:api[_-]?key|api[_-]?secret|auth[_-]?token|access[_-]?token|secret[_-]?key|private[_-]?key|password|passwd|pwd)\s*[:=]\s*['"]?([A-Za-z0-9+/=_-]{32,})['"]?/gi,
    captureGroup: 1,
  },
  // Private-key PEM blocks
  // The body is charset-bounded to what a PEM block can actually contain —
  // base64, whitespace, and the `Proc-Type:`/`DEK-Info:` header punctuation of an
  // encrypted key. It was `[\s\S]*?`, which spans ANYTHING between the two
  // markers, and the markers do not have to belong to the same block.
  //
  // That is not theoretical. `readFilesAsContext` redacts file bodies before they
  // reach the LLM auditor, so a file whose `BEGIN` and `END` sat in two unrelated
  // fixtures ~80 lines apart had all the code between them collapsed into one
  // placeholder. Three reviewers then reported the file as syntactically broken —
  // correctly, for the mangled input they received. Silently shortening the thing
  // under review is worse than noise: it produces confident findings about code
  // that is not on disk.
  //
  // Excluding `{}()'";` is what does the work — any real code between two markers
  // now breaks the match, while every PEM form still matches (verified: plain,
  // long-body, and ENCRYPTED-with-headers). The length cap is a secondary bound,
  // set generously at 20000 because the failure direction matters: missing a real
  // key is a security failure, whereas over-spanning is only a review-quality one.
  // A 16384-bit key body is ~3KB, so the cap has ~6x headroom. Verified
  // backtracking-safe (1ms on an 80KB unterminated input).
  { name: 'pem-private-key', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----[A-Za-z0-9+/=\s:,.-]{0,20000}?-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/g },
  // Connection-string password (postgres/mysql/mongo/redis/amqp DSNs). This
  // repo's own threat model names it: "the runtime DSN's password IS the
  // secret" (AGENTS.md, AUDIT_DB_URL). Redacts ONLY the password segment so
  // the host/db stay readable for operators.
  {
    name: 'dsn-password',
    re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?):\/\/[^:\s/@]+:([^@\s]+)@/gi,
    captureGroup: 1,
  },
]);

/**
 * Scan text for secret patterns.
 *
 * Already-redacted markers (`[REDACTED:pattern-name]`, produced by
 * `redactSecrets` below) must not re-trigger detection here — the marker
 * text itself can satisfy a pattern's structural shape (e.g. `dsn-password`'s
 * password capture group `[^@\s]+` doesn't exclude `[`/`]`/`:`/`-`, so
 * `postgresql://user:[REDACTED:dsn-password]@host` still matches the full
 * DSN shape). Stripped with a single space, not an empty string, so the text
 * immediately before/after a marker can't concatenate into a new,
 * coincidental secret-shaped token.
 *
 * @param {string} text
 * @returns {{matched: boolean, patterns: string[]}} - Pattern names that matched
 */
export function scanForSecrets(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return { matched: false, patterns: [] };
  }
  const stripped = text.replace(/\[REDACTED:[\w-]+\]/g, ' ');
  const matched = [];
  for (const { name, re } of SECRET_PATTERNS) {
    // Clone regex to reset lastIndex (all patterns have the 'g' flag)
    const localRe = new RegExp(re.source, re.flags);
    if (localRe.test(stripped)) {
      matched.push(name);
    }
  }
  return { matched: matched.length > 0, patterns: matched };
}

/**
 * True iff the runtime's RegExp supports the `d` (hasIndices) flag, computed
 * once at module load. `d` gives `matchAll` results a `.indices` array with
 * exact `[start,end)` offsets for the full match and every capture group,
 * relative to the string `matchAll` was called on.
 */
const D_FLAG_SUPPORTED = (() => {
  try { new RegExp('', 'gd'); return true; } catch { return false; }
})();

/**
 * Resolve which `[start, end)` span to redact for one match: the capture
 * group's span if `captureGroup` is set AND that group participated in the
 * match, else the full match's span. Fails closed (never "leave
 * unredacted") — a non-participating group (`indices[captureGroup]` is
 * `undefined`, e.g. a future pattern with the group inside an alternation)
 * or an out-of-range `captureGroup` both fall back to `indices[0]` (the
 * full match).
 *
 * @param {Array<[number,number]|undefined>} indices - a `d`-flagged match's `.indices`
 * @param {number|undefined} captureGroup - 1-based group index, or falsy for full-match patterns
 * @returns {[number, number]}
 */
function resolveRedactionSpan(indices, captureGroup) {
  if (captureGroup && indices[captureGroup]) return indices[captureGroup];
  return indices[0];
}

/**
 * Core replacement loop, parameterized on `dFlagSupported` so it's testable
 * without relying on the real (immutable, closed-over) runtime detection —
 * an ESM named export is a read-only binding and can't be monkeypatched by
 * a test, so the flag is threaded as an explicit argument instead.
 *
 * Patterns are processed **sequentially against an accumulating string**
 * (same semantics as the pre-fix algorithm): each pattern's `matchAll` runs
 * against `result` as it stands at the start of that pattern's turn: every
 * match for THIS pattern is computed against that snapshot before any
 * splice happens (`matchAll` is lazy over the string it was called on, and
 * the loop below only reassigns `result` after the whole pattern's pass
 * completes), so within one pattern's pass, indices never need adjustment
 * for an earlier splice in the same pass.
 *
 * When `dFlagSupported` is `false` (module-load feature-detection found no
 * `d`-flag support — e.g. a synced consumer repo on an old Node, since
 * `engines` in package.json is advisory and does not prevent execution):
 * the per-pattern `RegExp` omits `'d'` entirely (so construction never
 * throws), and every match — including `captureGroup` ones — redacts its
 * FULL match span via `match.index`/`match[0].length` (available with or
 * without the `d` flag), never attempting group-only isolation. This is
 * safe (never under-redacts) even though it's more conservative than the
 * indices-based path.
 *
 * @param {string} text
 * @param {typeof SECRET_PATTERNS} patterns
 * @param {{dFlagSupported: boolean}} opts
 * @returns {{text: string, redacted: string[]}}
 */
function redactWithPatterns(text, patterns, { dFlagSupported }) {
  if (typeof text !== 'string' || text.length === 0) {
    return { text: text ?? '', redacted: [] };
  }
  let result = text;
  const matched = [];
  for (const { name, re, captureGroup } of patterns) {
    const flags = dFlagSupported
      ? (re.flags.includes('d') ? re.flags : re.flags + 'd')
      : re.flags;
    const localRe = new RegExp(re.source, flags);
    let found = false;
    let out = '';
    let lastEnd = 0;
    for (const m of result.matchAll(localRe)) {
      found = true;
      let start; let end;
      if (dFlagSupported) {
        [start, end] = resolveRedactionSpan(m.indices, captureGroup);
      } else {
        start = m.index;
        end = m.index + m[0].length;
      }
      out += result.slice(lastEnd, start) + `[REDACTED:${name}]`;
      const newlineCount = (m[0].match(/\n/g) || []).length;
      out += '\n'.repeat(newlineCount);
      lastEnd = end;
    }
    out += result.slice(lastEnd);
    if (found) { result = out; matched.push(name); }
  }
  return { text: result, redacted: matched };
}

/**
 * Redact secrets from text, replacing each match with `[REDACTED:pattern-name]`.
 * Returns the redacted text and the list of pattern names that were redacted.
 *
 * For the `generic-token` and `dsn-password` patterns we only replace the
 * captured group (the token/password itself), preserving the surrounding
 * context so operators can see WHAT was redacted without exposing the
 * value — redacted at the group's EXACT position via `RegExp`'s `d` flag
 * (`hasIndices`), not a nested string search (which could hit an earlier,
 * unrelated occurrence of the same value elsewhere in the match — e.g. a
 * password equal to the DSN's scheme name or username; see
 * docs/plans/redact-secrets-positional-collision-fix.md).
 *
 * **Line-count-preserving** (found reviewing `docs/plans/discovery-portfolio-secret-redaction.md`):
 * a whole-match replacement (the non-`captureGroup` path) appends trailing
 * newlines equal to the number of `\n` characters in the original match, so
 * a caller that maps line numbers (e.g. diff-hunk annotation against the
 * original file) stays correctly aligned after redaction. This matters only
 * for `pem-private-key` — the one pattern in `SECRET_PATTERNS` that can span
 * multiple lines (`[\s\S]*?`); every other pattern's match never contains a
 * newline, so this is a no-op for them (0 newlines to preserve). The
 * `captureGroup` path is unaffected — every pattern using it has a
 * non-whitespace character class, so its captured value is always single-line.
 *
 * @param {string} text
 * @returns {{text: string, redacted: string[]}}
 */
export function redactSecrets(text) {
  return redactWithPatterns(text, SECRET_PATTERNS, { dFlagSupported: D_FLAG_SUPPORTED });
}

/**
 * Redact an object's string fields in place (returns a new copy).
 * @param {object} obj
 * @param {string[]} fields - Field names to scan + redact
 * @returns {{obj: object, redacted: {field: string, patterns: string[]}[]}}
 */
export function redactFields(obj, fields) {
  const copy = { ...obj };
  const redacted = [];
  for (const field of fields) {
    const value = copy[field];
    if (typeof value !== 'string') continue;
    const { text, redacted: patterns } = redactSecrets(value);
    if (patterns.length > 0) {
      copy[field] = text;
      redacted.push({ field, patterns });
    }
  }
  return { obj: copy, redacted };
}

export const _internals = Object.freeze({
  resolveRedactionSpan,
  redactWithPatterns,
  isDFlagSupported: D_FLAG_SUPPORTED,
});

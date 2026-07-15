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
  { name: 'pem-private-key', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/g },
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
 * Redact secrets from text, replacing each match with `[REDACTED:pattern-name]`.
 * Returns the redacted text and the list of pattern names that were redacted.
 *
 * For the `generic-token` pattern we only replace the captured group (the
 * token itself), preserving the keyword context so operators can see WHAT was
 * redacted without exposing the value.
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
  if (typeof text !== 'string' || text.length === 0) {
    return { text: text ?? '', redacted: [] };
  }
  let redacted = text;
  const matches = [];
  for (const { name, re, captureGroup } of SECRET_PATTERNS) {
    const localRe = new RegExp(re.source, re.flags);
    let found = false;
    redacted = redacted.replace(localRe, (match, ...groups) => {
      found = true;
      if (captureGroup) {
        // Replace only the captured group within the match
        const group = groups[captureGroup - 1];
        if (typeof group === 'string') {
          return match.replace(group, `[REDACTED:${name}]`);
        }
      }
      const newlineCount = (match.match(/\n/g) || []).length;
      return `[REDACTED:${name}]` + '\n'.repeat(newlineCount);
    });
    if (found) matches.push(name);
  }
  return { text: redacted, redacted: matches };
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

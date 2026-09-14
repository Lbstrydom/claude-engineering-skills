/**
 * Save/clear/restore the two DB-URL env vars — call this at the TOP of a
 * test file, immediately after importing it. So a test suite that must
 * never resolve to a real database (e.g. tiered-shadow-compare.test.mjs,
 * which now writes to the audit store — 2026-07-13) doesn't pick up
 * either the canonical `AUDIT_DB_URL` or its alias `AUDIT_POSTGRES_URL`
 * fallback (client.mjs's `resolveDbUrl()` reads the alias when the
 * canonical var is empty).
 *
 * Extracted from tiered-shadow-compare.test.mjs's inline block so the
 * air-gap itself is directly testable (a probe script importing this
 * helper, rather than the production module under test) — see
 * docs/plans/refactor-misc-small-items-2026-07.md, topicId a5f8c94f.
 */
// Module-level, captured on the FIRST call only (final-review-credit-queue fp
// c8be2a96). A second call used to re-read `process.env` — already blanked by
// the first call — as its own "prior" value, and register a SECOND `exit`
// listener that re-blanked whatever the first listener had just correctly
// restored ('exit' listeners fire in registration order, so the second one
// always ran last). Capturing once means every subsequent call just re-blanks
// (harmless — the vars are already blank) instead of capturing a stale
// snapshot and stacking another restorer.
let captured = false;
let priorDbUrl;
let priorPostgresUrl;

export function airGapDbUrl() {
  if (!captured) {
    captured = true;
    priorDbUrl = process.env.AUDIT_DB_URL;
    priorPostgresUrl = process.env.AUDIT_POSTGRES_URL;
    process.on('exit', () => {
      if (priorDbUrl === undefined) delete process.env.AUDIT_DB_URL;
      else process.env.AUDIT_DB_URL = priorDbUrl;
      if (priorPostgresUrl === undefined) delete process.env.AUDIT_POSTGRES_URL;
      else process.env.AUDIT_POSTGRES_URL = priorPostgresUrl;
    });
  }
  process.env.AUDIT_DB_URL = '';
  process.env.AUDIT_POSTGRES_URL = '';
}

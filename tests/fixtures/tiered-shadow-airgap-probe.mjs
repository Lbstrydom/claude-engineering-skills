// No node:test import, no describe/it — this is a plain script, not a test
// file, so it produces zero test-reporter output on stdout. Its ONLY job is
// to import + call the air-gap helper (triggering its env-clearing side
// effect, exactly like a real test file does immediately after importing
// it) and report what survived. Run as a child process from
// tests/tiered-shadow-compare-airgap.test.mjs
// with both AUDIT_DB_URL and AUDIT_POSTGRES_URL pre-set in its env, so the
// parent can assert both come back cleared regardless of what the ambient
// environment had.
import { airGapDbUrl } from '../helpers/air-gap.mjs';

airGapDbUrl();

process.stdout.write(JSON.stringify({
  auditDbUrl: process.env.AUDIT_DB_URL,
  auditPostgresUrl: process.env.AUDIT_POSTGRES_URL,
}));

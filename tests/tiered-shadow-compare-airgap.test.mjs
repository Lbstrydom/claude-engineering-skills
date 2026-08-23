/**
 * @fileoverview Regression for a5f8c94f — proves the extracted air-gap
 * helper (tests/helpers/air-gap.mjs) actually clears BOTH AUDIT_DB_URL and
 * its alias AUDIT_POSTGRES_URL, regardless of what the ambient environment
 * had set. Standalone file (not a case inside tiered-shadow-compare.test.mjs
 * itself) because that file's own air-gap has already run by the time any
 * of its own tests execute — testing "did importing this file clear both
 * vars" from inside the already-air-gapped file would prove nothing.
 *
 * Uses a plain-script probe (tests/fixtures/tiered-shadow-airgap-probe.mjs),
 * not a nested `node --test` invocation, so there's no TAP-reporter stdout
 * mangling and no NODE_TEST_CONTEXT recursive-run detection to work around.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

test('the air-gap helper clears AUDIT_DB_URL and AUDIT_POSTGRES_URL regardless of ambient env', () => {
  const probe = path.join(import.meta.dirname, 'fixtures', 'tiered-shadow-airgap-probe.mjs');
  const stdout = execFileSync(process.execPath, [probe], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      AUDIT_DB_URL: 'postgresql://placeholder/db',
      AUDIT_POSTGRES_URL: 'postgresql://placeholder-alias/db',
    },
  });
  const { auditDbUrl, auditPostgresUrl } = JSON.parse(stdout);
  assert.equal(auditDbUrl, '', 'AUDIT_DB_URL must be cleared even though the ambient env set it');
  assert.equal(auditPostgresUrl, '', 'AUDIT_POSTGRES_URL (the alias) must be cleared too — this is the a5f8c94f gap');
});

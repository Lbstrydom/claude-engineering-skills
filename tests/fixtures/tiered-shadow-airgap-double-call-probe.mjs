// Plain script (no node:test import) — calls airGapDbUrl() TWICE, then
// writes what the exit-time restoration actually leaves behind to the file
// path given as argv[2]. A restore-on-exit handler cannot be observed from
// the OUTSIDE except by letting the process actually exit, so this writes
// synchronously from the process's own final 'exit' handler (registered
// AFTER both airGapDbUrl() calls, so it runs after theirs — 'exit' listeners
// fire in registration order).
//
// Run as a child process from tests/tiered-shadow-compare-airgap.test.mjs
// (final-review-credit-queue fp c8be2a96).
import fs from 'node:fs';
import { airGapDbUrl } from '../helpers/air-gap.mjs';

const outPath = process.argv[2];

airGapDbUrl();
airGapDbUrl(); // the second call is the case under test

process.on('exit', () => {
  fs.writeFileSync(outPath, JSON.stringify({
    auditDbUrl: process.env.AUDIT_DB_URL,
    auditPostgresUrl: process.env.AUDIT_POSTGRES_URL,
  }));
});

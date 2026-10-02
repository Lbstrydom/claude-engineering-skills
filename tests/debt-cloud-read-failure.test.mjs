/**
 * @fileoverview A failed cloud read of the debt ledger is NOT an empty ledger.
 *
 * `readDebtEntriesCloud` / `readDebtEventsCloud` used to catch every query
 * error and return `[]` — the same value as "cloud off" and "genuinely no
 * rows". Their callers were written for a reader that THROWS:
 * `loadAuthoritativeDebt` wraps the read in try/catch to report
 * `source:'unavailable'`, and `debt-ledger-claims-check` does the same. With the
 * reader swallowing, a store outage was reported as `source:'cloud'` with zero
 * entries — "there is no debt", the claim that contract exists to forbid
 * (AGENTS.md: a schema error is not an empty result).
 *
 * Runs in a child process against an UNREACHABLE store (127.0.0.1:1 refuses
 * immediately): the DSN must be in the environment before the db client module
 * loads, and a refused connection is a real query failure with no database.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lib = (p) => pathToFileURL(path.join(REPO, 'scripts', 'lib', p)).href;

const PROBE = `
const debt = await import(${JSON.stringify(lib('store/debt.mjs'))});
const mem = await import(${JSON.stringify(lib('debt-memory.mjs'))});
const out = {};
const REPO_ID = '00000000-0000-0000-0000-000000000000';
for (const fn of ['readDebtEntriesCloud', 'readDebtEventsCloud']) {
  try { out[fn] = { returned: await debt[fn](REPO_ID) }; }
  catch (e) { out[fn] = { threw: e.code || e.message }; }
}
out.noRepo = await debt.readDebtEntriesCloud(null);
out.authoritative = await mem.loadAuthoritativeDebt({ source: 'cloud', repoId: REPO_ID, canWrite: false });
const led = await mem.loadDebtLedger({ source: 'cloud', repoId: REPO_ID, canWrite: false },
  { ledgerPath: ${JSON.stringify(path.join(REPO, '.audit', '__absent__', 'tech-debt.json'))} });
out.ledger = { eventSource: led.eventSource, eventsUnavailable: led.eventsUnavailable ?? null };
process.stdout.write(JSON.stringify(out));
process.exit(0);
`;

function runProbe() {
  const env = { ...process.env, AUDIT_DB_URL: 'postgresql://u:p@127.0.0.1:1/unreachable' };
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', PROBE], { cwd: REPO, env, encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, `probe crashed: ${r.stderr.slice(-800)}`);
  return { out: JSON.parse(r.stdout), stderr: r.stderr };
}

test('a store that cannot be reached is reported as unavailable, never as an empty ledger', () => {
  const { out, stderr } = runProbe();

  // The readers raise the failure instead of answering [].
  assert.ok(out.readDebtEntriesCloud.threw, `readDebtEntriesCloud returned ${JSON.stringify(out.readDebtEntriesCloud.returned)}`);
  assert.ok(out.readDebtEventsCloud.threw, `readDebtEventsCloud returned ${JSON.stringify(out.readDebtEventsCloud.returned)}`);

  // Negative control: "no repo identity" is still a quiet [] — the not-asked case.
  assert.deepEqual(out.noRepo, []);

  // The consumer contract the throw exists to serve.
  assert.equal(out.authoritative.source, 'unavailable', JSON.stringify(out.authoritative));
  assert.match(out.authoritative.reason, /^cloud-read-failed:/);
  assert.equal(out.authoritative.degraded, true);

  // The audit's own load does not crash on it, but says the events were not read.
  assert.equal(out.ledger.eventSource, 'cloud');
  assert.match(String(out.ledger.eventsUnavailable), /ECONNREFUSED|cloud-read-failed/);
  assert.match(stderr, /debt events could not be read/i);
});

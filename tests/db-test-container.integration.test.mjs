/**
 * Opt-in Docker integration smoke for scripts/db-test-container.mjs
 * (docs/plans/local-db-test-container.md §9, R2-M1). Env-gated on
 * DB_TEST_CONTAINER_IT=1 — skips cleanly otherwise (same gating pattern
 * as AUDIT_DB_TEST_URL for the destructive suites).
 *
 * Deliberately does NOT run the full `suites` workload (CI's
 * postgres-parity job owns that) — this covers only the wrapper's own
 * lifecycle behaviour: up → connects → down → no leaked volume. That is
 * the class of bug the hermetic (fake-exec) unit tests structurally
 * cannot reach.
 *
 * Run: DB_TEST_CONTAINER_IT=1 node --test tests/db-test-container.integration.test.mjs
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { CONTAINER_NAME, DEFAULT_PORT, buildDsn } from '../scripts/db-test-container.mjs';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const CLI = path.join(REPO_ROOT, 'scripts', 'db-test-container.mjs');
const RUN_IT = process.env.DB_TEST_CONTAINER_IT === '1';

async function listVolumeNames() {
  const { stdout } = await execFileAsync('docker', ['volume', 'ls', '-q']);
  return new Set(stdout.trim().split('\n').filter(Boolean));
}

describe(
  'db-test-container.mjs — Docker integration smoke',
  { skip: !RUN_IT && 'set DB_TEST_CONTAINER_IT=1 to run (needs Docker Desktop)' },
  () => {
    // Ownership-scoped cleanup (audit H2/H3): `down` removes by NAME, so an
    // unconditional after() would tear down someone else's already-running
    // container if this suite's own `up` lost the exit-3 name-conflict race
    // — the same class of bug the CLI itself guards against for real
    // invocations. Only clean up when THIS suite's `up` actually succeeded.
    let ownsContainer = false;

    after(async () => {
      if (!ownsContainer) return;
      try {
        await execFileAsync(process.execPath, [CLI, 'down'], { cwd: REPO_ROOT });
      } catch (err) {
        // Audit M2/M4 (round 2): logging alone let the test PASS while a
        // container/volume leaked — a diagnostic isn't enough, this must
        // actually fail the run. Throwing from after() fails the suite.
        process.stderr.write(`[integration-test] cleanup failed (container ${CONTAINER_NAME} may still be running): ${err.message}\n`);
        throw err;
      }
    });

    it('up starts a reachable container; down removes it and leaves no anonymous volume behind', async () => {
      const volumesBefore = await listVolumeNames();

      const upRes = await execFileAsync(process.execPath, [CLI, 'up', '--port', String(DEFAULT_PORT)], { cwd: REPO_ROOT, timeout: 180000 });
      // Reached only when `up` exited 0 — a non-zero exit (e.g. exit 3, lost
      // the name-conflict race against an already-running container) rejects
      // the promise above and this line never runs, so ownsContainer stays
      // false and after() correctly leaves the other container alone.
      ownsContainer = true;
      assert.match(upRes.stderr, /up — container/);

      const client = new pg.Client({ connectionString: buildDsn(DEFAULT_PORT) });
      await client.connect();
      try {
        const { rows } = await client.query('SELECT 1 AS ok');
        assert.equal(rows[0].ok, 1);
      } finally {
        // Gemini gate G2 — must run even if the assertion above throws.
        await client.end();
      }

      const inspectBefore = await execFileAsync('docker', ['inspect', CONTAINER_NAME, '--format', '{{.State.Running}}']);
      assert.equal(inspectBefore.stdout.trim(), 'true');

      await execFileAsync(process.execPath, [CLI, 'down'], { cwd: REPO_ROOT, timeout: 30000 });
      ownsContainer = false; // already torn down — after() has nothing left to do

      await assert.rejects(execFileAsync('docker', ['inspect', CONTAINER_NAME]));

      // R2-H1: `docker rm -f -v` must remove the image's anonymous data
      // volume along with the container — assert the volume set is
      // unchanged after a full up/down cycle, not merely that it's small.
      const volumesAfter = await listVolumeNames();
      const leaked = [...volumesAfter].filter((v) => !volumesBefore.has(v));
      assert.deepEqual(leaked, [], `down leaked volume(s): ${leaked.join(', ')}`);
    });
  },
);

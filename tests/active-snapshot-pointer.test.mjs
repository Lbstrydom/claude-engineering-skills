/**
 * @fileoverview `getActiveSnapshot` must not hand back a refresh id it did not
 * verify belongs to the repo that asked.
 *
 * Audit trail, because the shape of the mistake is the lesson. R2 H1 said the
 * `refresh_runs` read was filtered only by `id`; the fix added
 * `AND repo_id = $2`. R3 H1 then observed that the fix was **decorative**: the
 * bound lookup's failure changed nothing, because the function still returned
 * `refreshId: data.active_refresh_id` regardless. A guard whose failure has no
 * consequence is the exact class this whole change exists to remove, and it was
 * reintroduced one round after being fixed elsewhere.
 *
 * It survived a round because it was untestable — welded between two `await`s
 * in a store module with no injection seam. So the DECISION was extracted as
 * `resolveActiveSnapshot`, the same split `drift.mjs` already uses for
 * `resolveStoreGateExit`. The lesson generalises: when a defect hides behind
 * I/O, the fix is a seam, not a bigger fixture.
 *
 * **But a seam is not a substitute for touching the database.** An earlier
 * draft of this file claimed "no live-DB harness exists for this file"; that
 * was FALSE. `tests/refresh-provenance-promotion.test.mjs` runs against a real
 * Postgres under `npm run db:local`, and it is what caught the fix below
 * selecting a `commit_sha` column that does not exist — the query threw, the
 * surrounding `catch` returned null, and `getActiveSnapshot` answered "no
 * snapshot" for every healthy repo. The pure tests here all passed throughout:
 * they exercise the decision, and the defect was in the QUERY. Five audit
 * rounds and two Gemini gates missed it; the container caught it in 80s.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import path from 'node:path';
import {
  resolveActiveSnapshot, sampleSnapshotEmbeddings,
} from '../scripts/lib/store/arch/snapshots.mjs';

const SNAPSHOTS_SRC = path.resolve(
  import.meta.dirname, '..', 'scripts', 'lib', 'store', 'arch', 'snapshots.mjs',
);

const repoRow = {
  active_refresh_id: 'refresh-1',
  active_embedding_model: 'text-embedding-3-large',
  active_embedding_dim: 768,
};

describe('resolveActiveSnapshot', () => {
  it('returns the snapshot when the run row is present and bound', () => {
    // The direction that must NOT fire. A healthy repo has to keep working;
    // a guard that rejects the normal case is worse than no guard.
    const { snapshot, corruptPointer } = resolveActiveSnapshot(repoRow, {
      import_graph_populated: true, walk_start_commit: 'abc123',
    });
    assert.equal(corruptPointer, false);
    assert.equal(snapshot.refreshId, 'refresh-1');
    assert.equal(snapshot.importGraphPopulated, true);
    assert.equal(snapshot.commitSha, 'abc123');
    assert.equal(snapshot.activeEmbeddingDim, 768);
  });

  it('REFUSES to return a refresh id whose bound lookup found nothing', () => {
    // The R3 H1 defect, stated as an assertion: with the pointer set and no
    // matching repo-owned run, the old code returned
    // `{refreshId:'refresh-1', commitSha:null}` — a foreign or deleted run
    // presented as this repo's active snapshot.
    const { snapshot, corruptPointer } = resolveActiveSnapshot(repoRow, null);
    assert.equal(snapshot, null, 'an unverified pointer must not be returned');
    assert.equal(corruptPointer, true, 'and the fault must be reportable, not silent');
  });

  it('treats undefined from the driver the same as null', () => {
    assert.equal(resolveActiveSnapshot(repoRow, undefined).snapshot, null);
  });

  it('a repo that was never indexed is EMPTY, not corrupt', () => {
    // No pointer at all is a normal state. Calling it corruption would make
    // every fresh repo emit a data-integrity warning — a cried-wolf guard.
    const { snapshot, corruptPointer } = resolveActiveSnapshot(
      { ...repoRow, active_refresh_id: null }, null,
    );
    assert.equal(corruptPointer, false);
    assert.equal(snapshot.refreshId, null);
    assert.equal(snapshot.importGraphPopulated, false);
    assert.equal(snapshot.commitSha, null);
  });

  it('no repo row at all is null, and not corruption either', () => {
    assert.deepEqual(resolveActiveSnapshot(null, null), { snapshot: null, corruptPointer: false });
  });

  it('reads import_graph_populated strictly — a truthy non-true is false', () => {
    // Mirrors the original `=== true`; a driver returning 't' or 1 must not
    // silently promote a graph to "populated".
    for (const v of ['t', 1, 'true', {}]) {
      assert.equal(resolveActiveSnapshot(repoRow, { import_graph_populated: v }).snapshot.importGraphPopulated, false);
    }
  });

  it('a run row with no walk_start_commit yields null, not undefined', () => {
    const { snapshot } = resolveActiveSnapshot(repoRow, { import_graph_populated: false });
    assert.equal(snapshot.commitSha, null);
  });
});

describe('sampleSnapshotEmbeddings — tenant-bound, fail-closed', () => {
  // Deferred five times across this audit (R1 H1 → R4 M2 → R5 H1) on a stated
  // cost — "a signature change and every caller changes" — that was never
  // measured. Measured: ONE caller, which already holds `repoId` on the very
  // next line, where it passes it to `recordBandCalibration`.
  it('refuses to query without a tenant key, and without a snapshot', async () => {
    // Cloud is off in tests, so this asserts the guard ORDER is harmless and
    // the function is total. The load-bearing half is the source contract
    // below: a missing repoId must not fall through to an unbound query.
    assert.deepEqual(await sampleSnapshotEmbeddings(null, 'refresh-1'), []);
    assert.deepEqual(await sampleSnapshotEmbeddings('repo-1', null), []);
    assert.deepEqual(await sampleSnapshotEmbeddings(null, null), []);
  });

  it('takes repoId FIRST, like every sibling in the module', () => {
    // An appended optional tenant key is a guard you can forget. A leading
    // required one makes omission a visible call-site error — and this is what
    // stops a future caller reintroducing the unbound form.
    assert.equal(sampleSnapshotEmbeddings.length >= 2, true);
    const src = fs.readFileSync(SNAPSHOTS_SRC, 'utf8');
    assert.match(src, /export async function sampleSnapshotEmbeddings\(repoId, refreshId/);
  });

  it('the query filters on repo_id, not refresh_id alone', () => {
    // A source assertion, deliberately: the binding lives entirely in SQL and
    // this suite is hermetic. It is WEAKER than executing the query, and
    // labelled as such — it catches the clause being dropped, not the database
    // honouring it. (An earlier draft justified it by claiming
    // `scripts/lib/store/arch/**` has no live-DB harness. That was false, and
    // believing it is what let a phantom-column query ship: `npm run db:local`
    // does cover this module. Prefer adding a case there when the claim is
    // about what Postgres will actually do.)
    const src = fs.readFileSync(SNAPSHOTS_SRC, 'utf8');
    const query = src.slice(src.indexOf('FROM symbol_index si'), src.indexOf('ORDER BY random()'));
    assert.match(query, /si\.refresh_id = \$1/);
    assert.match(query, /si\.repo_id = \$2/, 'the tenant clause must be present');
  });
});

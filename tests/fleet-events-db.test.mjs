/**
 * @fileoverview `fleet_events` (migration 20261010120000) — recordFleetEvents,
 * readFleetTelemetry and the census window count against a real Postgres.
 * Env-gated on AUDIT_DB_TEST_URL; skips cleanly without it.
 *
 * Why a DB suite: the idempotent re-drain (ON CONFLICT on event_id), the
 * outcome CHECK, and every derived metric (percentile_cont with FILTER, jsonb
 * extraction, the per-session lead-time CTE) are properties only Postgres has.
 *
 * Enrolled in scripts/db-test-container.mjs ISOLATED_SUITE_FILES AND
 * .github/workflows/postgres-parity.yml — two edits, always.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { getPool, closePool, _resetForTest, assertDisposableDbUrl } from '../scripts/lib/db/client.mjs';
import { upsertRepoByUuid } from '../scripts/lib/store/repo.mjs';
import { recordFleetEvents, readFleetTelemetry, getFleetEventWindowCounts } from '../scripts/lib/store/fleet-events.mjs';
import { deriveWeaknesses } from '../scripts/lib/fleet/telemetry-insights.mjs';

const TEST_URL = process.env.AUDIT_DB_TEST_URL;
const skip = TEST_URL ? false : 'AUDIT_DB_TEST_URL not set';

let savedUrl;
let repoId;

const T0 = Date.parse('2026-10-10T08:00:00Z');
const ev = (o) => ({
  v: 1, eventId: crypto.randomUUID(), occurredAt: new Date(T0).toISOString(), verb: 'status', mode: null,
  outcome: 'ok', exitCode: 0, durationMs: 100, sessionId: null, reasonClass: null, toolSha: null, detail: {}, ...o,
});
const at = (h) => new Date(T0 + h * 3_600_000).toISOString();

describe('fleet_events (disposable DB)', { skip }, () => {
  before(async () => {
    savedUrl = process.env.AUDIT_DB_URL;
    assertDisposableDbUrl(TEST_URL, { productionUrl: savedUrl });
    await _resetForTest();
    process.env.AUDIT_DB_URL = TEST_URL;
    repoId = (await upsertRepoByUuid({ repoUuid: `test-fleet-${crypto.randomUUID()}`, name: 'fleet-events-db', fingerprint: null })).id;
  });

  after(async () => {
    try {
      const pool = await getPool();
      await pool.query('DELETE FROM fleet_events WHERE repo_id = $1', [repoId]);
      await pool.query('DELETE FROM audit_repos WHERE id = $1', [repoId]);
    } finally {
      await closePool();
      if (savedUrl === undefined) delete process.env.AUDIT_DB_URL;
      else process.env.AUDIT_DB_URL = savedUrl;
      await _resetForTest();
    }
  });

  it('writes events and a re-drain of the same ids is a no-op', async () => {
    const batch = [ev({ durationMs: 120 }), ev({ durationMs: 15_000, detail: { items: 23, held: true, itemsByState: { ready: 2 } } })];
    const first = await recordFleetEvents(repoId, 'o/fleet', batch);
    assert.deepEqual(first, { ok: true, cloud: true, written: 2 });
    const again = await recordFleetEvents(repoId, 'o/fleet', batch);
    assert.deepEqual(again, { ok: true, cloud: true, written: 0 });
  });

  it('a write without a repo id is refused before it reaches the table', async () => {
    const res = await recordFleetEvents(null, null, [ev({})]);
    assert.deepEqual(res, { ok: false, cloud: false, reason: 'missing-repo-id' });
  });

  it('an outcome outside the vocabulary is refused by the CHECK, reported as a failed write', async () => {
    const res = await recordFleetEvents(repoId, 'o/fleet', [ev({ outcome: 'weird' })]);
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'write-failed');
  });

  it('derives golden signals, session flow, reasons, saturation and versions', async () => {
    await recordFleetEvents(repoId, 'o/fleet', [
      ev({ verb: 'claim', sessionId: 's1', occurredAt: at(1) }),
      ev({ verb: 'restack', sessionId: 's1', occurredAt: at(2) }),
      ev({ verb: 'ready', sessionId: 's1', occurredAt: at(3) }),
      ev({ verb: 'release', mode: 'done', sessionId: 's1', occurredAt: at(5) }),
      // After s1's release and with no later claim: belongs to no lifecycle.
      ev({ verb: 'ready', sessionId: 's1', outcome: 'refused', occurredAt: at(7) }),
      ev({ verb: 'claim', sessionId: 's2', occurredAt: at(1) }),
      ev({ verb: 'release', mode: 'abandoned', sessionId: 's2', occurredAt: at(3) }),
      ev({ verb: 'claim', sessionId: 's3', outcome: 'refused', reasonClass: 'overlaps <path>', occurredAt: at(1) }),
      ev({ verb: 'land', mode: 'approve', outcome: 'pending', reasonClass: 'WAIT checks', occurredAt: at(1) }),
      ev({ verb: 'status', outcome: 'error', detail: { errorKind: 'TypeError' }, toolSha: 'abcdef1', occurredAt: at(1) }),
      // A reused session id: two lifecycles (1h and 3h), each release paired with the claim before it.
      ev({ verb: 'claim', sessionId: 's4', occurredAt: at(1) }),
      ev({ verb: 'release', mode: 'done', sessionId: 's4', occurredAt: at(2) }),
      ev({ verb: 'claim', sessionId: 's4', occurredAt: at(3) }),
      ev({ verb: 'release', mode: 'done', sessionId: 's4', occurredAt: at(6) }),
      // Outside [since, until): must not count.
      ev({ verb: 'status', durationMs: 999_999, occurredAt: at(48) }),
    ]);
    const m = await readFleetTelemetry(repoId, { sinceIso: new Date(T0 - 3_600_000).toISOString(), untilIso: at(24) });
    assert.equal(m.error, undefined, m.error);
    const status = m.goldenSignals.find((v) => v.verb === 'status');
    assert.equal(status.n, 3);
    assert.equal(status.error, 1);
    assert.equal(status.maxMs, 15_000, 'the event after untilIso is excluded');
    assert.ok(status.p95Ms > status.p50Ms);
    assert.equal(m.sessionFlow.started, 4, 's1, s2 and two s4 lifecycles; s3 was refused, so it never started');
    assert.equal(m.sessionFlow.released, 3);
    assert.equal(m.sessionFlow.abandoned, 1);
    assert.equal(m.sessionFlow.leadTimeP50Hours, 3, 'leads 4h (s1), 1h and 3h (s4) → median 3h');
    assert.equal(m.sessionFlow.readiesPerSession, 0.25, 'one ready inside s1, none elsewhere, over 4 lifecycles');
    assert.equal(m.sessionFlow.refusalsPerSession, 0, 'the refusal after s1 released is outside every lifecycle');
    assert.ok(m.topReasons.some((r) => r.reason_class === 'overlaps <path>' && r.outcome === 'refused'));
    assert.deepEqual(m.errorKinds, [{ kind: 'TypeError', n: 1 }]);
    assert.equal(m.saturation.itemsMax, 23);
    assert.ok(m.versions.some((v) => v.tool === 'abcdef1'));
    const w = deriveWeaknesses(m, null);
    assert.equal(w.state, 'insufficient', 'a handful of events judges no rate-based rule');
    assert.ok(w.findings.some((f) => f.message.includes('TypeError')), 'a crash kind needs no sample size');
  });

  it('census window counts read created_at (when the event happened)', async () => {
    const counts = await getFleetEventWindowCounts(repoId, {
      currentStart: new Date(T0 - 3_600_000).toISOString(), now: new Date(T0 + 86_400_000).toISOString(),
      priorStart: new Date(T0 - 86_400_000).toISOString(),
    });
    assert.ok(counts.current >= 10);
    assert.equal(counts.prior, 0);
  });
});

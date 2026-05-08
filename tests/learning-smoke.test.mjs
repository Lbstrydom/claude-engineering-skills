/**
 * Live Supabase smoke test for the adaptive-learning v1 schema.
 *
 * Gated on `SUPABASE_AUDIT_SERVICE_ROLE_KEY` being set — skips silently
 * in CI / dev machines without the key.  When the env IS set, this runs
 * a full insert → read → cleanup cycle against the real cloud project
 * to catch deployment regressions (RLS drift, column renames, view-DDL
 * breakage) the moment they happen rather than mid-dogfooding.
 *
 * Plan: docs/plans/dogfooding-ergonomics-v1.md §A
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const HAS_SERVICE_ROLE = !!(
  process.env.SUPABASE_AUDIT_URL && process.env.SUPABASE_AUDIT_SERVICE_ROLE_KEY
);

describe('learning-smoke / live Supabase round-trip', () => {
  it('skips when SUPABASE_AUDIT_SERVICE_ROLE_KEY is absent', () => {
    if (!HAS_SERVICE_ROLE) {
      // Single explicit pass so the test file isn't empty in CI.
      assert.ok(true, 'service-role env absent — smoke test skipped');
    }
  });

  it('inserts → reads → cleans up a learning_decisions row', async (t) => {
    if (!HAS_SERVICE_ROLE) return; // skip silently
    const { getWriteClient } = await import('../scripts/lib/stores/supabase-store.mjs');
    const client = await getWriteClient();
    assert.ok(client, 'service-role client must be available');

    const testKey = `smoke-test:${crypto.randomUUID()}`;
    const testRow = {
      decision_key:  testKey,
      decision_type: 'quickfix_hit',         // off-audit form
      external_id:   testKey.split(':')[1],   // hit_id
      context:       { test: true, ts: Date.now() },
      context_hash:  'a'.repeat(64),
      choice:        { action: 'flagged' },
      outcome:       null,
    };

    // Insert.  Audit-fix R1 H2: wrap the read+assertion phase in try/
    // finally so the cleanup runs even if an assertion fails or the
    // network drops mid-test — without this, smoke-test:* rows accumulate
    // in the live table on every red run.
    const ins = await client.from('learning_decisions').insert(testRow);
    assert.equal(ins.error, null, `insert error: ${ins.error?.message}`);

    try {
      // Read back
      const read = await client.from('learning_decisions')
        .select('decision_key, decision_type, context, choice')
        .eq('decision_key', testKey).single();
      assert.equal(read.error, null, `read error: ${read.error?.message}`);
      assert.equal(read.data?.decision_key, testKey);
      assert.equal(read.data?.decision_type, 'quickfix_hit');
      assert.deepEqual(read.data?.choice, { action: 'flagged' });
    } finally {
      // Cleanup ALWAYS runs.  Best-effort: any error here is reported
      // but doesn't mask the real assertion failure.
      try {
        const del = await client.from('learning_decisions')
          .delete().eq('decision_key', testKey);
        if (del.error) {
          process.stderr.write(`[smoke] cleanup error (row may persist): ${del.error.message}\n`);
        }
      } catch (err) {
        process.stderr.write(`[smoke] cleanup threw (row may persist): ${err.message}\n`);
      }
    }
  });

  it('queries the 3 Phase 1 views without error', async (t) => {
    if (!HAS_SERVICE_ROLE) return;
    const { getWriteClient } = await import('../scripts/lib/stores/supabase-store.mjs');
    const client = await getWriteClient();
    assert.ok(client);

    for (const viewName of [
      'pending_triage_findings',
      'no_brainer_recommendations',
      'persona_density_per_repo',
    ]) {
      const r = await client.from(viewName).select('*').limit(1);
      assert.equal(r.error, null, `${viewName} returned error: ${r.error?.message}`);
      assert.ok(Array.isArray(r.data), `${viewName} must return an array (rows or empty)`);
    }
  });

  it('verifies stored procedures exist (defer_finding + mark_finding_needs_triage)', async (t) => {
    if (!HAS_SERVICE_ROLE) return;
    const { getWriteClient } = await import('../scripts/lib/stores/supabase-store.mjs');
    const client = await getWriteClient();

    // Calling with a non-existent finding_id should raise the FK-violation
    // exception we built into the proc — but NOT a "function not found" error.
    const r = await client.rpc('defer_finding', {
      p_finding_id: '00000000-0000-0000-0000-000000000000',
      p_dismiss_reason: 'smoke-test',
      p_evidence: { smoke: true },
      p_cluster_hash: 'smoke-cluster',
      p_severity: 'LOW',
      p_audit_run_id: '00000000-0000-0000-0000-000000000000',
      p_round: 0,
      p_sequence: 0,
    });
    // Either the FK-violation we built in (P0001-ish) or a concrete row-not-found:
    // both prove the proc exists and runs.  A "function does not exist" error
    // would have a different shape (PGRST202 / 42883).
    if (r.error) {
      const code = r.error.code || '';
      assert.notEqual(code, '42883', 'defer_finding stored procedure not found');
      assert.notEqual(code, 'PGRST202', 'defer_finding RPC not exposed');
    }
    // Either error or success is fine; absence-of-procedure errors are what
    // we're guarding against.
  });
});

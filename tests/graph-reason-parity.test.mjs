/**
 * @fileoverview Mechanical parity guard between the THREE places the observed
 * graph's coverage-verdict reason enum is duplicated (fp=d0c0d2ba, 2026-08-20
 * unremediated-acceptances triage):
 *
 *   1. `GRAPH_REASON` (scripts/lib/symbol-index/graph-verdict.mjs) — the
 *      arch-memory-domain PRODUCER of the reason.
 *   2. `CoverageSchema`'s `verdict.reason` enum (scripts/lib/coverage-schema.mjs)
 *      — the shared-lib-domain write-boundary CONSUMER.
 *   3. `symbol_refresh_coverage`'s `reason` CHECK constraint (supabase/migrations)
 *      — the DB-layer backstop.
 *
 * All three are hand-duplicated on purpose (domain-map.json's allowedDeps
 * permits arch-memory -> shared-lib only, so shared-lib cannot import
 * GRAPH_REASON) — but hand-duplicated literals drift. `malformed_measurement`
 * (GRAPH_REASON's 11th value, returned by `graphVerdict()` whenever
 * extraction.elapsedMs/ratio or attribution.ratio comes back non-finite) was
 * missing from #2 and #3 for the feature's entire life: `recordGraphCoverage`
 * silently refused to persist that verdict (`schema-invalid`), and
 * `render-mermaid.mjs`'s THROWING `ObservedDepsSchema.parse(envelope)` would
 * have crashed `arch:render` outright the one time this path went live.
 *
 * This test asserts #1 and #2 agree as SETS so the next reason added to
 * GRAPH_REASON fails HERE instead of drifting silently again. It cannot
 * mechanically check #3 (the DB CHECK constraint) without a live Postgres —
 * see the note at the bottom of this file.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GRAPH_REASON, GRAPH_STATUS } from '../scripts/lib/symbol-index/graph-verdict.mjs';
import { CoverageSchema } from '../scripts/lib/coverage-schema.mjs';

function coverageSchemaReasonValues() {
  // Zod 4: `.nullable()` wraps the enum; `.unwrap()` reaches it, and an
  // enum's allowed values live at `_def.entries` (NOT `_def.values` — that is
  // the Zod 3 spelling; see AGENTS.md's Zod dependency table).
  const reasonSchema = CoverageSchema.shape.verdict.shape.reason;
  return Object.values(reasonSchema.unwrap()._def.entries);
}

function coverageSchemaStatusValues() {
  return Object.values(CoverageSchema.shape.verdict.shape.status._def.entries);
}

describe('GRAPH_REASON <-> CoverageSchema.verdict.reason parity', () => {
  it('every GRAPH_REASON value is accepted by CoverageSchema (the drift this fp guards against)', () => {
    const schemaValues = new Set(coverageSchemaReasonValues());
    const missing = Object.values(GRAPH_REASON).filter((v) => !schemaValues.has(v));
    assert.deepEqual(missing, [],
      `GRAPH_REASON has value(s) CoverageSchema's reason enum rejects: ${JSON.stringify(missing)} — ` +
      `a legitimate graphVerdict() output would fail to persist (recordGraphCoverage) or crash ` +
      `arch:render (render-mermaid.mjs's throwing ObservedDepsSchema.parse)`);
  });

  it('CoverageSchema never accepts a reason GRAPH_REASON does not produce (no stale/orphaned literal)', () => {
    const graphValues = new Set(Object.values(GRAPH_REASON));
    const extra = coverageSchemaReasonValues().filter((v) => !graphValues.has(v));
    assert.deepEqual(extra, [], `CoverageSchema accepts reason(s) GRAPH_REASON never produces: ${JSON.stringify(extra)}`);
  });

  it('GRAPH_STATUS <-> CoverageSchema.verdict.status parity (the sibling enum, same drift class)', () => {
    const schemaValues = new Set(coverageSchemaStatusValues());
    const graphValues = new Set(Object.values(GRAPH_STATUS));
    assert.deepEqual(
      [...graphValues].filter((v) => !schemaValues.has(v)),
      [],
      'GRAPH_STATUS has a value CoverageSchema.verdict.status rejects',
    );
    assert.deepEqual(
      [...schemaValues].filter((v) => !graphValues.has(v)),
      [],
      'CoverageSchema.verdict.status accepts a value GRAPH_STATUS never produces',
    );
  });

  it('CoverageSchema now ACCEPTS a well-formed malformed_measurement verdict (the concrete regression, fp=d0c0d2ba)', () => {
    const record = {
      schemaVersion: 1,
      verdict: { status: 'unknown', reason: 'malformed_measurement' },
      measuredAt: new Date().toISOString(),
      refreshId: 'r1',
      stale: false,
      extraction: {
        outcome: 'ok', eligible: 10, cruised: 10, ratio: null, elapsedMs: null,
        edges: { external: 0, selfEdge: 0, escaping: 0, persisted: 5 },
        samples: { uncruised: [] },
      },
      attribution: null,
    };
    const result = CoverageSchema.safeParse(record);
    assert.ok(result.success, () => `expected acceptance, got: ${JSON.stringify(result.error?.issues)}`);
  });

  // NOTE: the DB CHECK constraint itself (supabase/migrations/
  // 20260820080000_symbol_refresh_coverage_malformed_measurement.sql) is the
  // third leg of this parity triangle. tests/fixtures/expected-schema.json is
  // a snapshot from a REAL replay (AGENTS.md: "regenerate only from a fresh
  // replay, npm run db:local:regen") and is now stale relative to that
  // migration until someone re-runs it against a disposable Postgres — no
  // live DB was available in this session to do that, so it is intentionally
  // NOT asserted here (asserting it now would just encode today's stale
  // fixture as the expectation). Follow-up: `npm run db:local:regen`, or the
  // next real migrate/adopt cycle.
});

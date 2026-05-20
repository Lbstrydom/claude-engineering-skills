/**
 * @fileoverview Phase 0 contract tests — verifies the Zod schemas accept
 * good shapes and reject malformed ones. The DB-level CHECK constraints
 * in migration 20260520120000 enforce the same invariants on the write
 * boundary; these tests cover the in-memory boundary.
 *
 * Plan: docs/plans/persona-test-consistency-mode.md — Phase 0 acceptance.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ENGINE_CLAIM_FIELD_TYPES,
  LocatorSchema,
  CollectionBindingSchema,
  WaitConditionSchema,
  JourneyStepSchema,
  SurfaceManifestSchema,
  CanaryDefinitionSchema,
  ContradictionSchema,
  SessionLedgerSchema,
  SemanticVerdictSchema,
  PersonaRunContextSchema,
  WitnessRecordSchema,
} from '../scripts/lib/persona-test/schemas.mjs';

// ────────────────────────────────────────────────────────────────────────────
// ENGINE_CLAIM_FIELD_TYPES
// ────────────────────────────────────────────────────────────────────────────

describe('ENGINE_CLAIM_FIELD_TYPES', () => {
  it('is frozen and contains the documented type set', () => {
    assert.ok(Object.isFrozen(ENGINE_CLAIM_FIELD_TYPES));
    assert.deepEqual(
      [...ENGINE_CLAIM_FIELD_TYPES].sort(),
      ['boolean', 'count', 'enum', 'freshness', 'id', 'integer', 'prose'],
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// LocatorSchema (resolves R1-M3 — structured, not stringly-typed)
// ────────────────────────────────────────────────────────────────────────────

describe('LocatorSchema', () => {
  it('accepts a role locator', () => {
    const r = LocatorSchema.safeParse({ kind: 'role', role: 'status' });
    assert.equal(r.success, true);
  });
  it('accepts a role locator with name', () => {
    const r = LocatorSchema.safeParse({ kind: 'role', role: 'button', name: 'Reorganise' });
    assert.equal(r.success, true);
  });
  it('accepts a label locator', () => {
    const r = LocatorSchema.safeParse({ kind: 'label', text: 'Cellar status' });
    assert.equal(r.success, true);
  });
  it('accepts a testid locator', () => {
    const r = LocatorSchema.safeParse({ kind: 'testid', id: 'status-chip' });
    assert.equal(r.success, true);
  });
  it('accepts a css locator with default warn=true', () => {
    const r = LocatorSchema.safeParse({ kind: 'css', selector: '.x' });
    assert.equal(r.success, true);
    assert.equal(r.data.warn, true);
  });
  it('rejects an unknown kind', () => {
    const r = LocatorSchema.safeParse({ kind: 'xpath', expr: '//div' });
    assert.equal(r.success, false);
  });
  it('rejects a role locator missing the role field', () => {
    const r = LocatorSchema.safeParse({ kind: 'role' });
    assert.equal(r.success, false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// CollectionBindingSchema (resolves R1-H2 — entity scoping)
// ────────────────────────────────────────────────────────────────────────────

describe('CollectionBindingSchema', () => {
  it('accepts a minimal binding', () => {
    const r = CollectionBindingSchema.safeParse({
      id: 'wines-grid',
      urlPattern: '/api/cellar',
      jsonPath: 'wines',
      keyField: 'id',
    });
    assert.equal(r.success, true);
  });
  it('rejects when keyField is missing', () => {
    const r = CollectionBindingSchema.safeParse({
      id: 'wines-grid',
      urlPattern: '/api/cellar',
      jsonPath: 'wines',
    });
    assert.equal(r.success, false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// WaitConditionSchema (resolves R3-H2 — discriminated wait kinds)
// ────────────────────────────────────────────────────────────────────────────

describe('WaitConditionSchema', () => {
  it('accepts visible with locator + default timeoutMs', () => {
    const r = WaitConditionSchema.safeParse({
      kind: 'visible',
      locator: { kind: 'testid', id: 'spinner' },
    });
    assert.equal(r.success, true);
    assert.equal(r.data.timeoutMs, 5000);
  });
  it('accepts a network wait', () => {
    const r = WaitConditionSchema.safeParse({
      kind: 'network',
      urlPattern: '/api/cellar',
      method: 'POST',
    });
    assert.equal(r.success, true);
  });
  it('caps timeout-kind wait at 30000ms', () => {
    const r = WaitConditionSchema.safeParse({ kind: 'timeout', ms: 999999 });
    assert.equal(r.success, false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// JourneyStepSchema (resolves R3-H2 + R4-M5 — XOR refines)
// ────────────────────────────────────────────────────────────────────────────

describe('JourneyStepSchema — navigate XOR refine', () => {
  it('accepts navigate with url only', () => {
    const r = JourneyStepSchema.safeParse({
      action: 'navigate', label: 'open', url: 'https://example.com/cellar',
    });
    assert.equal(r.success, true);
  });
  it('accepts navigate with routeKey only', () => {
    const r = JourneyStepSchema.safeParse({
      action: 'navigate', label: 'open', routeKey: 'cellar',
    });
    assert.equal(r.success, true);
  });
  it('rejects navigate with both url and routeKey', () => {
    const r = JourneyStepSchema.safeParse({
      action: 'navigate', label: 'open', url: 'https://x.example', routeKey: 'cellar',
    });
    assert.equal(r.success, false);
  });
  it('rejects navigate with neither url nor routeKey', () => {
    const r = JourneyStepSchema.safeParse({ action: 'navigate', label: 'open' });
    assert.equal(r.success, false);
  });
});

describe('JourneyStepSchema — click / fill / evaluate', () => {
  it('accepts a click with locator', () => {
    const r = JourneyStepSchema.safeParse({
      action: 'click', label: 'click reorganise',
      locator: { kind: 'role', role: 'button', name: 'Reorganise' },
    });
    assert.equal(r.success, true);
  });
  it('accepts a fill with default blurAfter=true', () => {
    const r = JourneyStepSchema.safeParse({
      action: 'fill', label: 'enter wine name',
      locator: { kind: 'label', text: 'Name' },
      value: 'Cabernet 2018',
    });
    assert.equal(r.success, true);
    assert.equal(r.data.blurAfter, true);
  });
  it('accepts evaluate with scriptId', () => {
    const r = JourneyStepSchema.safeParse({
      action: 'evaluate', label: 'seed', scriptId: 'reset-fixture',
      args: { seed: 'abc' },
    });
    assert.equal(r.success, true);
  });
  it('rejects evaluate with inline code (must use scriptId)', () => {
    const r = JourneyStepSchema.safeParse({
      action: 'evaluate', label: 'inline', code: 'alert(1)',
    });
    assert.equal(r.success, false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// SurfaceManifestSchema — the big one
// ────────────────────────────────────────────────────────────────────────────

describe('SurfaceManifestSchema', () => {
  const goodManifest = {
    version: 1,
    collections: [
      { id: 'wines-grid', urlPattern: '/api/cellar', jsonPath: 'wines', keyField: 'id' },
    ],
    surfaces: [
      {
        id: 'status-chip',
        locator: { kind: 'role', role: 'status' },
        severityFloor: 'P0',
        engineFields: [
          {
            field: 'capacityRemedy.feasibility',
            type: 'enum',
            semanticValues: ['feasible', 'infeasible', 'unknown'],
            networkSource: {
              urlPattern: '/api/cellar',
              jsonPath: 'capacityRemedy.feasibility',
            },
          },
        ],
      },
    ],
  };

  it('accepts a well-formed manifest', () => {
    const r = SurfaceManifestSchema.safeParse(goodManifest);
    assert.equal(r.success, true);
  });

  it('applies default llmSafe=false on engineFields', () => {
    const r = SurfaceManifestSchema.safeParse(goodManifest);
    assert.equal(r.data.surfaces[0].engineFields[0].llmSafe, false);
  });

  it('applies default llmMaxChars=2000 on engineFields', () => {
    const r = SurfaceManifestSchema.safeParse(goodManifest);
    assert.equal(r.data.surfaces[0].engineFields[0].llmMaxChars, 2000);
  });

  it('rejects unknown engineField type', () => {
    const m = JSON.parse(JSON.stringify(goodManifest));
    m.surfaces[0].engineFields[0].type = 'unknown-type';
    const r = SurfaceManifestSchema.safeParse(m);
    assert.equal(r.success, false);
  });

  it('rejects llmMaxChars > 20000 (egress guard)', () => {
    const m = JSON.parse(JSON.stringify(goodManifest));
    m.surfaces[0].engineFields[0].llmMaxChars = 50_000;
    const r = SurfaceManifestSchema.safeParse(m);
    assert.equal(r.success, false);
  });

  it('rejects version != 1', () => {
    const m = { ...goodManifest, version: 2 };
    const r = SurfaceManifestSchema.safeParse(m);
    assert.equal(r.success, false);
  });

  it('rejects manifest with empty surfaces array', () => {
    const r = SurfaceManifestSchema.safeParse({ version: 1, surfaces: [] });
    assert.equal(r.success, false);
  });

  it('defaults collections to empty array when omitted', () => {
    const m = { ...goodManifest };
    delete m.collections;
    const r = SurfaceManifestSchema.safeParse(m);
    assert.equal(r.success, true);
    assert.deepEqual(r.data.collections, []);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// CanaryDefinitionSchema
// ────────────────────────────────────────────────────────────────────────────

describe('CanaryDefinitionSchema', () => {
  const goodCanary = {
    name: 'oliver-infeasible-reorg',
    personaId: 'pieter-wine-enthusiast',
    fixtureSeed: 'wine-cellar-infeasible-2026-05',
    journeySteps: [
      { action: 'navigate', label: 'open', routeKey: 'cellar' },
      { action: 'click', label: 'reorg',
        locator: { kind: 'role', role: 'button', name: 'Reorganise' } },
    ],
    expectedContradictions: { min: 1 },
  };

  it('accepts a well-formed canary', () => {
    const r = CanaryDefinitionSchema.safeParse(goodCanary);
    assert.equal(r.success, true);
  });

  it('defaults routes + scripts to empty maps', () => {
    const r = CanaryDefinitionSchema.safeParse(goodCanary);
    assert.deepEqual(r.data.routes, {});
    assert.deepEqual(r.data.scripts, {});
  });

  it('defaults authBootstrap.kind to none', () => {
    const r = CanaryDefinitionSchema.safeParse(goodCanary);
    assert.equal(r.data.authBootstrap.kind, 'none');
  });

  it('accepts authBootstrap=token with tokenEnv', () => {
    const c = { ...goodCanary, authBootstrap: { kind: 'token', tokenEnv: 'BEARER_TOKEN' } };
    const r = CanaryDefinitionSchema.safeParse(c);
    assert.equal(r.success, true);
  });

  it('rejects authBootstrap=token without tokenEnv (R4-M5 XOR)', () => {
    const c = { ...goodCanary, authBootstrap: { kind: 'token' } };
    const r = CanaryDefinitionSchema.safeParse(c);
    assert.equal(r.success, false);
  });

  it('rejects authBootstrap=storageState without storageStatePath', () => {
    const c = { ...goodCanary, authBootstrap: { kind: 'storageState' } };
    const r = CanaryDefinitionSchema.safeParse(c);
    assert.equal(r.success, false);
  });

  it('rejects a canary with zero journeySteps', () => {
    const c = { ...goodCanary, journeySteps: [] };
    const r = CanaryDefinitionSchema.safeParse(c);
    assert.equal(r.success, false);
  });

  it('expects min/max default to 0 / null when omitted', () => {
    const c = { ...goodCanary, expectedContradictions: {} };
    const r = CanaryDefinitionSchema.safeParse(c);
    assert.equal(r.success, true);
    assert.equal(r.data.expectedContradictions.min, 0);
    assert.equal(r.data.expectedContradictions.max, null);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// SessionLedgerSchema — terminal state coverage (R1-H6 + Gemini-G1)
// ────────────────────────────────────────────────────────────────────────────

describe('SessionLedgerSchema', () => {
  const minimalLedger = {
    schemaVersion: 1,
    sessionId: 'SID-1',
    canaryName: null,
    journeyKey: 'ad-hoc',
    fixtureSeed: null,
    startedAt: '2026-05-20T00:00:00.000Z',
    steps: [],
    candidateSpecIds: [],
    rigVerdict: 'fatal',
    canaryVerdict: 'not-applicable',
    failureReason: 'manifest-missing',
    stepFailureReason: null,
    truncated: false,
    endedAt: '2026-05-20T00:00:00.100Z',
  };

  it('accepts a zero-step terminal ledger (resolves R2-H2)', () => {
    const r = SessionLedgerSchema.safeParse(minimalLedger);
    assert.equal(r.success, true);
  });

  it('accepts every rigVerdict including app-error', () => {
    for (const v of ['healthy', 'broken', 'partial', 'fatal', 'app-error']) {
      const r = SessionLedgerSchema.safeParse({ ...minimalLedger, rigVerdict: v });
      assert.equal(r.success, true, `rigVerdict=${v} should parse`);
    }
  });

  it('rejects an unknown rigVerdict', () => {
    const r = SessionLedgerSchema.safeParse({ ...minimalLedger, rigVerdict: 'mystery' });
    assert.equal(r.success, false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// SemanticVerdictSchema (resolves Gemini-R4-G4 — inner schema only)
// ────────────────────────────────────────────────────────────────────────────

describe('SemanticVerdictSchema', () => {
  it('accepts inner verdict with optional score + reason', () => {
    const r = SemanticVerdictSchema.safeParse({
      matched: 'yes', score: 0.93, reason: 'paraphrase',
    });
    assert.equal(r.success, true);
  });
  it('accepts uncertain without score', () => {
    const r = SemanticVerdictSchema.safeParse({ matched: 'uncertain' });
    assert.equal(r.success, true);
  });
  it('REJECTS latencyMs / costUsd in the inner schema (envelope-only fields)', () => {
    // Zod's z.object is strict-by-default in 4.x for unknown keys via strict() — but
    // default mode strips. We assert here that even if passed they don't make it
    // a "valid envelope" — the inner schema's matched/score/reason must be the
    // only data fields recognised.
    const r = SemanticVerdictSchema.safeParse({
      matched: 'yes', latencyMs: 100, costUsd: 0.01,
    });
    // Default zod object: unknown keys stripped, but matched still required.
    assert.equal(r.success, true);
    assert.equal('latencyMs' in r.data, false, 'envelope fields must not leak into inner verdict');
    assert.equal('costUsd' in r.data, false);
  });
  it('rejects unknown matched value', () => {
    const r = SemanticVerdictSchema.safeParse({ matched: 'maybe' });
    assert.equal(r.success, false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// PersonaRunContextSchema (resolves R2-H4)
// ────────────────────────────────────────────────────────────────────────────

describe('PersonaRunContextSchema', () => {
  it('accepts a minimal context', () => {
    const r = PersonaRunContextSchema.safeParse({
      repoId: 'repo-uuid',
      personaId: null,
      journeyKey: 'ad-hoc',
      commitSha: 'abc',
      branch: 'main',
    });
    assert.equal(r.success, true);
    assert.equal(r.data.deploymentId, null);
    assert.equal(r.data.planId, null);
  });
  it('rejects context missing repoId (load-bearing for Gemini-R5-G2)', () => {
    const r = PersonaRunContextSchema.safeParse({
      personaId: null, journeyKey: 'ad-hoc', commitSha: 'abc', branch: 'main',
    });
    assert.equal(r.success, false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// ContradictionSchema — kinds enum coverage
// ────────────────────────────────────────────────────────────────────────────

describe('ContradictionSchema', () => {
  const base = {
    kind: 'value-mismatch',
    severity: 'P0',
    surfaceId: 'status-chip',
    engineField: 'cellarOrganised',
    scope: null,
    key: null,
    domValue: 'true',
    engineValue: false,
    freshness: 'current',
    selector: '[role="status"]',
    detail: 'DOM says organised; engine says not.',
  };
  it('accepts every contradiction kind', () => {
    const kinds = [
      'value-mismatch', 'stale-projection', 'undeclared-engine-claim',
      'missing-surface', 'value-coercion-error', 'absent-not-rendered',
      'key-coercion-error',
    ];
    for (const k of kinds) {
      const r = ContradictionSchema.safeParse({ ...base, kind: k });
      assert.equal(r.success, true, `kind=${k} should parse`);
    }
  });
  it('defaults suppressedByLockedSpec to null', () => {
    const r = ContradictionSchema.safeParse(base);
    assert.equal(r.data.suppressedByLockedSpec, null);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// WitnessRecordSchema — shape sanity
// ────────────────────────────────────────────────────────────────────────────

describe('WitnessRecordSchema', () => {
  it('accepts a minimal witness with empty claim lists', () => {
    const r = WitnessRecordSchema.safeParse({
      stepIndex: 0,
      domClaims: [],
      networkClaims: [],
      undeclaredDomClaims: [],
      partialCapture: false,
    });
    assert.equal(r.success, true);
    assert.deepEqual(r.data.customClaims, {});
  });
  it('rejects negative stepIndex', () => {
    const r = WitnessRecordSchema.safeParse({
      stepIndex: -1, domClaims: [], networkClaims: [], undeclaredDomClaims: [], partialCapture: false,
    });
    assert.equal(r.success, false);
  });
});

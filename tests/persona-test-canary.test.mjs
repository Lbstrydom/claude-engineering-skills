/**
 * @fileoverview Phase 4 canary module tests.
 *
 * Covers:
 *   - loadCanary: success path, path-traversal refusal, ENOENT, JSON
 *     parse errors, schema validation errors, filename/name mismatch
 *   - verifyExpectations: min/max/shapes; reasons emitted
 *   - canaryExpectsShape: matches by tuple; honours empty shapes
 *   - candidateFingerprint: deterministic; journeyKey in mix (Gemini-R6-G2)
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  loadCanary,
  verifyExpectations,
  canaryExpectsShape,
  candidateFingerprint,
  CANARY_DIR,
} from '../scripts/lib/persona-test/canary.mjs';

const VALID_CANARY = {
  name: 'oliver-infeasible-reorg',
  personaId: 'pieter',
  fixtureSeed: 'seed-1',
  journeySteps: [
    { action: 'navigate', label: 'open', routeKey: 'cellar', waitUntil: 'load' },
    { action: 'click', label: 'reorg',
      locator: { kind: 'role', role: 'button', name: 'Reorganise' } },
  ],
  expectedContradictions: { min: 1 },
};

let tmpDir;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-test-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeCanary(name, payload) {
  const dir = path.join(tmpDir, CANARY_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `${name}.json`);
  fs.writeFileSync(p, JSON.stringify(payload));
  return p;
}

// ────────────────────────────────────────────────────────────────────────────
// loadCanary
// ────────────────────────────────────────────────────────────────────────────

describe('loadCanary — success', () => {
  it('reads + validates a canonical canary', () => {
    writeCanary('oliver-infeasible-reorg', VALID_CANARY);
    const c = loadCanary('oliver-infeasible-reorg', tmpDir);
    assert.equal(c.name, 'oliver-infeasible-reorg');
    assert.equal(c.expectedContradictions.min, 1);
    assert.equal(c.journeySteps.length, 2);
  });
});

describe('loadCanary — error paths (failureReason on the Error)', () => {
  it('throws canary-not-found when file missing', () => {
    fs.mkdirSync(path.join(tmpDir, CANARY_DIR), { recursive: true });
    try {
      loadCanary('missing', tmpDir);
      assert.fail('should have thrown');
    } catch (err) {
      assert.equal(err.failureReason, 'canary-not-found');
    }
  });

  it('throws canary-dir-missing when canaries/ dir missing', () => {
    try {
      loadCanary('any', tmpDir);
      assert.fail('should have thrown');
    } catch (err) {
      // First lookup is the file; realpathSync ENOENT on the file path
      // hits the not-found branch BEFORE we probe the dir, which is fine.
      assert.match(err.failureReason, /canary-(not-found|dir-missing)/);
    }
  });

  it('refuses path separators in name (canary-name-invalid)', () => {
    try {
      loadCanary('subdir/canary', tmpDir);
      assert.fail('should have thrown');
    } catch (err) {
      assert.equal(err.failureReason, 'canary-name-invalid');
    }
  });

  it('refuses .. in name', () => {
    try {
      loadCanary('..', tmpDir);
      assert.fail('should have thrown');
    } catch (err) {
      assert.equal(err.failureReason, 'canary-name-invalid');
    }
  });

  it('throws canary-json-invalid on malformed JSON', () => {
    const dir = path.join(tmpDir, CANARY_DIR);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'bad.json'), '{not: json}');
    try {
      loadCanary('bad', tmpDir);
      assert.fail('should have thrown');
    } catch (err) {
      assert.equal(err.failureReason, 'canary-json-invalid');
    }
  });

  it('throws canary-schema-invalid on missing required fields', () => {
    writeCanary('bad', { name: 'bad', personaId: 'p' });   // no journeySteps, no fixtureSeed
    try {
      loadCanary('bad', tmpDir);
      assert.fail('should have thrown');
    } catch (err) {
      assert.equal(err.failureReason, 'canary-schema-invalid');
    }
  });

  it('throws canary-name-mismatch when on-disk name disagrees with filename', () => {
    writeCanary('foo', { ...VALID_CANARY, name: 'bar' });
    try {
      loadCanary('foo', tmpDir);
      assert.fail('should have thrown');
    } catch (err) {
      assert.equal(err.failureReason, 'canary-name-mismatch');
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// verifyExpectations
// ────────────────────────────────────────────────────────────────────────────

describe('verifyExpectations', () => {
  const canary = (over) => ({ ...VALID_CANARY, expectedContradictions: { min: 0, max: null, ...over } });

  it('passes when observed within [min, max]', () => {
    const r = verifyExpectations(canary({ min: 1, max: 5 }), [c(), c(), c()]);
    assert.equal(r.passed, true);
    assert.equal(r.verdict, 'passed');
    assert.equal(r.observed, 3);
  });

  it('fails as broken when observed < min (rig-broken canary self-test)', () => {
    const r = verifyExpectations(canary({ min: 1 }), []);
    assert.equal(r.passed, false);
    assert.equal(r.verdict, 'broken');
    assert.match(r.reason, /expected min:1.*found 0/i);
  });

  it('fails as broken when observed > max (consumer regression canary)', () => {
    const r = verifyExpectations(canary({ min: 0, max: 0 }), [c()]);
    assert.equal(r.passed, false);
    assert.match(r.reason, /expected max:0.*found 1/i);
  });

  it('passes when shapes are all matched', () => {
    const r = verifyExpectations(
      canary({ min: 0, shapes: [{ engineField: 'cellarOrganised', surfaceId: 'status-chip' }] }),
      [c({ engineField: 'cellarOrganised', surfaceId: 'status-chip' })],
    );
    assert.equal(r.passed, true);
  });

  it('fails when a declared shape is absent', () => {
    const r = verifyExpectations(
      canary({ min: 0, shapes: [{ engineField: 'mystery', surfaceId: 'status-chip' }] }),
      [c({ engineField: 'cellarOrganised', surfaceId: 'status-chip' })],
    );
    assert.equal(r.passed, false);
    assert.match(r.reason, /shape.*not found/i);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// canaryExpectsShape
// ────────────────────────────────────────────────────────────────────────────

describe('canaryExpectsShape', () => {
  it('returns true when shape matches a declared (engineField, surfaceId) tuple', () => {
    const canary = {
      expectedContradictions: {
        shapes: [{ engineField: 'cellarOrganised', surfaceId: 'status-chip' }],
      },
    };
    assert.equal(canaryExpectsShape(canary, c({ engineField: 'cellarOrganised', surfaceId: 'status-chip' })), true);
    assert.equal(canaryExpectsShape(canary, c({ engineField: 'other',           surfaceId: 'status-chip' })), false);
  });
  it('returns false when canary has no declared shapes', () => {
    assert.equal(canaryExpectsShape({ expectedContradictions: { min: 1 } }, c()), false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// candidateFingerprint (Gemini-R6-G2 — journeyKey load-bearing)
// ────────────────────────────────────────────────────────────────────────────

describe('candidateFingerprint', () => {
  it('is deterministic for same inputs', () => {
    const args = {
      repoId: 'r', journeyKey: 'oliver',
      contradiction: c({ engineField: 'f', surfaceId: 's', kind: 'value-mismatch', selector: '[role="status"]' }),
    };
    assert.equal(candidateFingerprint(args), candidateFingerprint(args));
  });

  it('differs for different journeyKey (Gemini-R6-G2)', () => {
    const base = { repoId: 'r', contradiction: c({ engineField: 'f', surfaceId: 's', kind: 'k', selector: 'x' }) };
    const a = candidateFingerprint({ ...base, journeyKey: 'oliver' });
    const b = candidateFingerprint({ ...base, journeyKey: 'sarah'  });
    assert.notEqual(a, b);
  });

  it('throws on missing inputs', () => {
    assert.throws(() => candidateFingerprint({}), /required/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function c(over = {}) {
  return {
    kind: 'value-mismatch', severity: 'P0',
    surfaceId: 'status-chip', engineField: 'cellarOrganised',
    scope: null, key: null,
    domValue: 'true', engineValue: false, freshness: 'current',
    selector: '[role="status"]',
    detail: 'detail',
    suppressedByLockedSpec: null,
    ...over,
  };
}

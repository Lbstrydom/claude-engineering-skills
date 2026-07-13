import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  loadValidationManifest, resolveStage1TriagerModel, ValidationManifestSchema,
} from '../scripts/lib/audit/stage1-triager-resolver.mjs';

const VALID_MANIFEST = {
  datasetHash: 'abc123',
  candidateModel: 'z-ai/glm-5.2',
  strata: [{ name: 'high-dismissal', count: 126, falseDismissalRate: 0, ci95: [0, 0.0296] }],
  thresholds: { highOrOmissionMaxFalseDismissalRate: 0.05, overallMaxFalseDismissalRate: 0.1 },
  passed: true,
  generatedAt: '2026-07-12T13:12:41.400Z',
};

function fakeFs(contents) {
  return { readFileSync: () => contents };
}
function throwingFs(err) {
  return { readFileSync: () => { throw err; } };
}

describe('loadValidationManifest', () => {
  test('a valid, passed manifest loads ok', () => {
    const r = loadValidationManifest('x', fakeFs(JSON.stringify(VALID_MANIFEST)));
    assert.equal(r.ok, true);
    assert.equal(r.manifest.candidateModel, 'z-ai/glm-5.2');
  });

  test('missing file → manifest_not_found, never throws', () => {
    const r = loadValidationManifest('x', throwingFs(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })));
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'manifest_not_found');
  });

  test('invalid JSON → manifest_invalid_json, never throws', () => {
    const r = loadValidationManifest('x', fakeFs('{not json'));
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'manifest_invalid_json');
  });

  test('schema-invalid (missing required field) → manifest_schema_invalid, not silently trusted', () => {
    const { passed, ...missingPassed } = VALID_MANIFEST;
    const r = loadValidationManifest('x', fakeFs(JSON.stringify(missingPassed)));
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'manifest_schema_invalid');
  });

  test('a stray unknown field is rejected (.strict()) — a hand-edited/corrupted manifest is not silently stripped', () => {
    const r = loadValidationManifest('x', fakeFs(JSON.stringify({ ...VALID_MANIFEST, unknownField: 'x' })));
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'manifest_schema_invalid');
  });

  test('ValidationManifestSchema is exported and matches the committed manifest shape', () => {
    assert.doesNotThrow(() => ValidationManifestSchema.parse(VALID_MANIFEST));
  });
});

describe('resolveStage1TriagerModel', () => {
  test('operator override (configuredModel) always wins, even with a valid manifest present', () => {
    const r = resolveStage1TriagerModel({ configuredModel: 'my-pinned-model', fsMod: fakeFs(JSON.stringify(VALID_MANIFEST)) });
    assert.equal(r.model, 'my-pinned-model');
    assert.equal(r.source, 'operator-override');
  });

  test('no override + valid passed manifest → resolves the validated candidate model', () => {
    const r = resolveStage1TriagerModel({ fsMod: fakeFs(JSON.stringify(VALID_MANIFEST)) });
    assert.equal(r.model, 'z-ai/glm-5.2');
    assert.equal(r.source, 'validated-manifest');
    assert.equal(r.datasetHash, 'abc123');
  });

  test('manifest present but passed:false → falls back to GPT-5.5 (model:null), never silently trusts a failed validation', () => {
    const r = resolveStage1TriagerModel({ fsMod: fakeFs(JSON.stringify({ ...VALID_MANIFEST, passed: false })) });
    assert.equal(r.model, null);
    assert.equal(r.source, 'fallback');
    assert.equal(r.reason, 'manifest_failed');
  });

  test('manifest missing → falls back to GPT-5.5 with a named reason', () => {
    const r = resolveStage1TriagerModel({ fsMod: throwingFs(new Error('ENOENT')) });
    assert.equal(r.model, null);
    assert.equal(r.source, 'fallback');
    assert.equal(r.reason, 'manifest_not_found');
  });

  test('malformed manifest → falls back to GPT-5.5, not a crash', () => {
    const r = resolveStage1TriagerModel({ fsMod: fakeFs('not json') });
    assert.equal(r.model, null);
    assert.equal(r.source, 'fallback');
    assert.equal(r.reason, 'manifest_invalid_json');
  });
});

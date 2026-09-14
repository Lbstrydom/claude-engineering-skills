/**
 * @fileoverview Tests for `scripts/check-visual-contract-doc-drift.mjs` —
 * the doc↔schema drift gate for the visual-audit contract reference
 * (aged-out-acceptance-remainder.md §4, `e3da8d42`).
 *
 * Two levels: `diffContractDoc` is exercised directly against synthetic
 * fixtures (proves the comparator itself, both directions, nested and
 * top-level); a live check against the REAL doc + REAL schema proves the
 * two are not currently drifted — a green run against a genuinely broken
 * pair would be the vacuous-pass this gate exists to prevent.
 *
 * Gate contract: scripts/gate-contracts/visual-contract-doc-gate.json,
 * gate id `visual-contract-doc-drift-detected` — its poison pill overlays
 * tests/fixtures/poison/visual-contract-doc-drifted.md (the doc's actual
 * pre-fix state) and asserts exit 1 with this file's own stderr message.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  stripJsoncComments, extractDocExample, docKeyPaths, schemaKeyPaths, diffContractDoc,
} from '../scripts/check-visual-contract-doc-drift.mjs';
import { VisualContractSchema } from '../scripts/lib/visual/schema.mjs';

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const CLI = path.join(REPO_ROOT, 'scripts', 'check-visual-contract-doc-drift.mjs');
const DOC_PATH = path.join(REPO_ROOT, 'skills/visual-audit/references/contract-and-bootstrap.md');

const GOOD_DOC = {
  version: 1,
  _note: 'x',
  _comment: 'x',
  appRoots: ['apps/web'],
  exclude: [],
  surfaces: [{
    id: 'a', label: 'a', selector: '.a', sourceGlobs: [], component: 'a',
    excludeSelectors: [], allowOverlapWith: [], nodeBudget: 1, interactiveBudget: 1,
  }],
  tokenSources: [{ type: 'css-vars', path: 'x', theme: null, families: ['colors'] }],
  themes: [{ name: 'light', apply: { mode: 'class', target: 'html', value: 'light' } }],
  globalStyleGlobs: [],
  tolerances: { geometryPx: 1, contrastRatio: 1 },
  propertyPolicy: { tokenAudited: [], mustMatchGeometry: [] },
};

describe('stripJsoncComments', () => {
  it('strips a line comment', () => {
    assert.equal(stripJsoncComments('{ "a": 1 } // trailing'), '{ "a": 1 } \n');
  });

  it('does not strip a // inside a string value', () => {
    const src = '{ "url": "https://example.com" }';
    assert.equal(JSON.parse(stripJsoncComments(src)).url, 'https://example.com');
  });

  it('preserves an escaped quote inside a string without ending it early', () => {
    const src = '{ "a": "he said \\"hi\\" // not a comment" }';
    assert.equal(JSON.parse(stripJsoncComments(src)).a, 'he said "hi" // not a comment');
  });
});

describe('extractDocExample', () => {
  it('throws when the heading is missing', () => {
    assert.throws(() => extractDocExample('# no such heading here'), /Schema \(v1\)/);
  });

  it('throws when the heading exists but no jsonc fence follows', () => {
    assert.throws(() => extractDocExample('## Schema (v1)\n\nno fence here'), /jsonc fence/);
  });

  it('parses the real doc without throwing', () => {
    const markdown = fs.readFileSync(DOC_PATH, 'utf-8');
    const example = extractDocExample(markdown);
    assert.equal(example.version, 1);
    assert.ok(Array.isArray(example.surfaces));
  });
});

describe('diffContractDoc — comparator soundness', () => {
  const jsonSchema = z.toJSONSchema(VisualContractSchema);

  it('a doc matching the schema exactly is clean', () => {
    assert.deepEqual(diffContractDoc(GOOD_DOC, jsonSchema), { ok: true, docOnly: [], schemaOnly: [] });
  });

  it('a top-level typo in the doc is caught as doc-only', () => {
    const bad = { ...GOOD_DOC };
    delete bad.appRoots;
    bad.appRotos = ['x'];
    const result = diffContractDoc(bad, jsonSchema);
    assert.equal(result.ok, false);
    assert.deepEqual(result.docOnly, ['appRotos']);
    assert.deepEqual(result.schemaOnly, ['appRoots']);
  });

  it('a real schema field the doc never shows is caught as schema-only', () => {
    const bad = { ...GOOD_DOC };
    delete bad._comment;
    const result = diffContractDoc(bad, jsonSchema);
    assert.equal(result.ok, false);
    assert.deepEqual(result.schemaOnly, ['_comment']);
  });

  it('a nested typo inside surfaces[] is caught as doc-only, path-qualified', () => {
    const bad = { ...GOOD_DOC, surfaces: [{ ...GOOD_DOC.surfaces[0], nodeBudgt: 1 }] };
    delete bad.surfaces[0].nodeBudget;
    const result = diffContractDoc(bad, jsonSchema);
    assert.ok(result.docOnly.includes('surfaces[].nodeBudgt'));
    assert.ok(result.schemaOnly.includes('surfaces[].nodeBudget'));
  });

  it('a nested typo inside tokenSources[] is caught the same way', () => {
    const bad = { ...GOOD_DOC, tokenSources: [{ ...GOOD_DOC.tokenSources[0], famlies: ['colors'] }] };
    delete bad.tokenSources[0].families;
    const result = diffContractDoc(bad, jsonSchema);
    assert.ok(result.docOnly.includes('tokenSources[].famlies'));
    assert.ok(result.schemaOnly.includes('tokenSources[].families'));
  });

  it('themes[].apply\'s own variant fields are NOT compared — deliberate scope boundary', () => {
    // The doc's example only ever shows the `class` mode; `attribute` mode's
    // `attribute` field must never surface as a false "schema-only" finding.
    const result = diffContractDoc(GOOD_DOC, jsonSchema);
    assert.ok(!result.schemaOnly.some((k) => k.startsWith('themes[].apply')));
  });

  it('an empty surfaces[]/tokenSources[]/themes[] array does not crash — no item to read keys from', () => {
    const bad = { ...GOOD_DOC, surfaces: [], tokenSources: [], themes: [] };
    assert.doesNotThrow(() => diffContractDoc(bad, jsonSchema));
  });
});

describe('the REAL doc and the REAL schema agree (negative-control-shaped: this must be able to fail)', () => {
  it('docKeyPaths/schemaKeyPaths of the live pair produce an empty diff', () => {
    const markdown = fs.readFileSync(DOC_PATH, 'utf-8');
    const docExample = extractDocExample(markdown);
    const jsonSchema = z.toJSONSchema(VisualContractSchema);
    const result = diffContractDoc(docExample, jsonSchema);
    assert.deepEqual(result, { ok: true, docOnly: [], schemaOnly: [] });
  });

  it('sanity: docKeyPaths and schemaKeyPaths are not trivially empty (vacuous-pass guard)', () => {
    const markdown = fs.readFileSync(DOC_PATH, 'utf-8');
    const doc = docKeyPaths(extractDocExample(markdown));
    const schema = schemaKeyPaths(z.toJSONSchema(VisualContractSchema));
    assert.ok(doc.size > 10, `expected a real key set, got ${doc.size}`);
    assert.ok(schema.size > 10, `expected a real key set, got ${schema.size}`);
  });
});

describe('check-visual-contract-doc-drift CLI', () => {
  it('the canonical bare invocation exits 0 and prints OK', () => {
    const r = spawnSync(process.execPath, [CLI, '--selfcheck-relocation'], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.stdout.trim(), 'OK');
  });

  it('an unknown flag is an invocation error (exit 2)', () => {
    const r = spawnSync(process.execPath, [CLI, '--totally-bogus-flag'], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(r.status, 2, `stdout: ${r.stdout}, stderr: ${r.stderr}`);
    assert.match(r.stderr, /unknown flag/);
  });

  it('running against the real repo state exits 0, clean', () => {
    const r = spawnSync(process.execPath, [CLI, '--json'], { encoding: 'utf8', timeout: 30_000, cwd: REPO_ROOT });
    assert.equal(r.status, 0, `stdout: ${r.stdout}, stderr: ${r.stderr}`);
    const envelope = JSON.parse(r.stdout);
    assert.deepEqual(envelope, { ok: true, docOnly: [], schemaOnly: [] });
  });
});

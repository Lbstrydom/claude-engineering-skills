/**
 * @fileoverview Tier-1 tests for scripts/lib/visual/contract.mjs's
 * readContract()/writeContract() semantic-validation symmetry — the two
 * boundaries must agree on validity for every fixture, and `allowDraft`
 * must never bypass the theme-reference referential-integrity check, only
 * the sourceGlobs-completeness rule a review-queue draft cannot yet satisfy.
 * Plan: docs/plans/visual-contract-semantic-validation.md
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { atomicWriteFileSync } from '../scripts/lib/file-io.mjs';
import { readContract, writeContract, bootstrapContract } from '../scripts/lib/visual/contract.mjs';
import { CONTRACT_FILE } from '../scripts/lib/visual/schema.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

/** Creates a temp root and registers its cleanup on the test context. */
function mkRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-contract-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
  return root;
}

function contractPath(root) {
  return path.join(root, CONTRACT_FILE);
}

const baseSurface = { id: 's1', selector: '.grid', sourceGlobs: ['src/a/**'] };
const baseTokenSource = { type: 'css-vars', path: 'src/tokens.css' };
const baseTheme = { name: 'light', apply: { mode: 'class', target: 'html', value: 'light' } };

/** Four base fixtures spanning both invariants. */
const FIXTURES = {
  valid: {
    version: 1,
    surfaces: [baseSurface],
    tokenSources: [{ ...baseTokenSource, theme: 'light' }],
    themes: [baseTheme],
  },
  'undeclared-theme': {
    version: 1,
    surfaces: [baseSurface],
    tokenSources: [{ ...baseTokenSource, theme: 'dark' }], // 'dark' not declared below
    themes: [baseTheme],
  },
  'empty-sourceGlobs': {
    version: 1,
    surfaces: [{ ...baseSurface, sourceGlobs: [] }],
    tokenSources: [{ ...baseTokenSource, theme: 'light' }],
    themes: [baseTheme],
  },
  'both-invalid': {
    version: 1,
    surfaces: [{ ...baseSurface, sourceGlobs: [] }],
    tokenSources: [{ ...baseTokenSource, theme: 'dark' }],
    themes: [baseTheme],
  },
};

// ── Table-driven semantic-validation matrix ─────────────────────────────────

test('readContract() boundary: raw fixtures written directly to disk', (t) => {
  for (const [name, fixture] of Object.entries(FIXTURES)) {
    const root = mkRoot(t);
    atomicWriteFileSync(contractPath(root), `${JSON.stringify(fixture, null, 2)}\n`);
    const { contract, error } = readContract(root);
    if (name === 'valid') {
      assert.equal(error, null, `${name}: expected no error, got ${error}`);
      assert.ok(contract, `${name}: expected a parsed contract`);
    } else if (name === 'undeclared-theme') {
      assert.match(error, /theme 'dark' not declared/, `${name}: wrong error — ${error}`);
    } else if (name === 'empty-sourceGlobs') {
      assert.match(error, /surface 's1' has no sourceGlobs/, `${name}: wrong error — ${error}`);
    } else if (name === 'both-invalid') {
      // Theme check runs first — deterministic, named error, not "some error".
      assert.match(error, /theme 'dark' not declared/, `${name}: wrong error — ${error}`);
    }
  }
});

test('writeContract() boundary (strict, no allowDraft) agrees with readContract() per fixture', (t) => {
  for (const [name, fixture] of Object.entries(FIXTURES)) {
    const root = mkRoot(t);
    const res = writeContract(root, fixture, { force: true });
    if (name === 'valid') {
      assert.equal(res.ok, true, `${name}: expected write to succeed, got ${res.error}`);
    } else if (name === 'undeclared-theme' || name === 'both-invalid') {
      assert.equal(res.ok, false);
      assert.match(res.error, /theme 'dark' not declared/, `${name}: wrong error — ${res.error}`);
    } else if (name === 'empty-sourceGlobs') {
      assert.equal(res.ok, false);
      assert.match(res.error, /surface 's1' has no sourceGlobs/, `${name}: wrong error — ${res.error}`);
    }
  }
});

// ── No-write-on-rejection (strict mode) ──────────────────────────────────────

test('strict writeContract() rejection never creates the destination file (absent case)', (t) => {
  for (const name of ['undeclared-theme', 'empty-sourceGlobs', 'both-invalid']) {
    const root = mkRoot(t);
    const res = writeContract(root, FIXTURES[name], { force: true });
    assert.equal(res.ok, false, name);
    assert.equal(fs.existsSync(contractPath(root)), false, `${name}: destination must not be created on rejection`);
  }
});

test('strict writeContract() rejection preserves an existing destination byte-for-byte (pre-existing case)', (t) => {
  for (const name of ['undeclared-theme', 'empty-sourceGlobs', 'both-invalid']) {
    const root = mkRoot(t);
    const sentinel = `${JSON.stringify(FIXTURES.valid, null, 2)}\n`;
    atomicWriteFileSync(contractPath(root), sentinel);
    const res = writeContract(root, FIXTURES[name], { force: true });
    assert.equal(res.ok, false, name);
    assert.equal(fs.readFileSync(contractPath(root), 'utf-8'), sentinel, `${name}: destination bytes must be unchanged on rejection`);
  }
});

// ── allowDraft: only sourceGlobs completeness is relaxed ─────────────────────

test('writeContract(..., {allowDraft: true}) accepts empty sourceGlobs but STILL rejects an undeclared theme', (t) => {
  const rootA = mkRoot(t);
  const draftOk = writeContract(rootA, FIXTURES['empty-sourceGlobs'], { force: true, allowDraft: true });
  assert.equal(draftOk.ok, true, `expected allowDraft to accept empty sourceGlobs, got ${draftOk.error}`);

  for (const name of ['undeclared-theme', 'both-invalid']) {
    const root = mkRoot(t);
    const res = writeContract(root, FIXTURES[name], { force: true, allowDraft: true });
    assert.equal(res.ok, false, `${name}: allowDraft must never bypass the theme-reference check`);
    assert.match(res.error, /theme 'dark' not declared/, `${name}: wrong error — ${res.error}`);
    assert.equal(fs.existsSync(contractPath(root)), false, `${name}: destination must not be created on rejection even with allowDraft`);
  }
});

// ── bootstrap() round-trip: intentionally-incomplete, never silently valid ──

test('bootstrapContract() output is accepted by writeContract(allowDraft) but rejected by a normal readContract()', (t) => {
  const root = mkRoot(t);
  const draft = bootstrapContract();
  const written = writeContract(root, draft, { force: true, allowDraft: true });
  assert.equal(written.ok, true, `bootstrap draft should write cleanly: ${written.error}`);

  const { contract, error } = readContract(root);
  assert.equal(contract, null);
  assert.match(error, /surface '.+' has no sourceGlobs/, `unedited draft should be rejected with a sourceGlobs-specific error, got: ${error}`);
});

// ── Real-world compliance fixture (wine-cellar-app's actual shape) ──────────

test('the real wine-cellar-app visual-contract.json shape stays valid (round-1 audit finding H2)', (t) => {
  const wineShape = {
    version: 1,
    surfaces: [
      { id: 'auth-card', selector: '#auth-screen .auth-card', sourceGlobs: ['public/css/themes.css', 'public/css/pairing.css'] },
      { id: 'app-header', selector: 'header', sourceGlobs: ['public/css/layout.css'] },
      { id: 'drink-tonight-panel', selector: '#drink-tonight-panel', sourceGlobs: ['public/css/analysis.css'] },
    ],
    tokenSources: [
      { type: 'css-vars', path: 'public/css/themes.css', theme: null },
      { type: 'css-vars', path: 'public/css/token-aliases.css', theme: null },
    ],
    themes: [
      { name: 'light', apply: { mode: 'attribute', target: 'html', attribute: 'data-theme', value: 'light' } },
      { name: 'dark', apply: { mode: 'attribute', target: 'html', attribute: 'data-theme', value: 'dark' } },
    ],
  };
  const root = mkRoot(t);
  const res = writeContract(root, wineShape, { force: true });
  assert.equal(res.ok, true, `expected the real wine-cellar-app shape to pass strict validation, got ${res.error}`);
  const { error } = readContract(root);
  assert.equal(error, null);
});

// ── CLI-level: proves the --bootstrap wiring, not just the direct call ──────

test('CLI: --bootstrap writes an allowDraft draft; a subsequent normal run rejects it (exit 2)', (t) => {
  const root = mkRoot(t);
  const cli = path.join(REPO_ROOT, 'scripts', 'visual-audit.mjs');

  // The success message is written to stderr (visual-audit.mjs's convention —
  // stdout is reserved for machine-readable output); execFileSync only
  // returns stdout, so the real assertion of CLI-level success is that the
  // process didn't throw (exit 0) AND the file actually landed on disk.
  execFileSync('node', [cli, '--bootstrap', '--root', root], { encoding: 'utf-8', stdio: 'pipe' });
  assert.equal(fs.existsSync(contractPath(root)), true);

  let code = 0, stderr = '';
  try {
    execFileSync('node', [cli, '--root', root], { encoding: 'utf-8', stdio: 'pipe' });
  } catch (err) {
    code = err.status;
    stderr = String(err.stderr || '');
  }
  assert.equal(code, 2, `expected the normal run to reject the un-edited draft (exit 2), stderr: ${stderr}`);
  assert.match(stderr, /sourceGlobs/, `stderr should name the missing field, got: ${stderr}`);
});

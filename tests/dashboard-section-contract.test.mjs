/**
 * @fileoverview WS2 regression — dashboard renderer decomposed into
 * `helpers.mjs` + 8 section modules + slim orchestrator.
 *
 * Plan: docs/plans/sustainability-cleanup-batch.md (WS2 §6 / §8).
 *
 * Enforces three contracts at the file/AST level (cheaper than a
 * dep-cruiser CLI step per Gemini-r4-G3):
 *   1. Import direction one-way only:
 *        render.mjs → helpers.mjs
 *        render.mjs → sections/*.mjs
 *        sections/*.mjs → (no render, no helpers)
 *      Sections receive the helper bundle via the `ui` arg.
 *   2. Every section module exports `default` with arity 2.
 *   3. The `ui` bundle that the orchestrator builds has exactly the
 *      documented keys — drift detection.
 */
import { describe, it, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECTIONS_DIR = path.join(REPO_ROOT, 'scripts/lib/dashboard/sections');
const HELPERS_PATH = path.join(REPO_ROOT, 'scripts/lib/dashboard/helpers.mjs');
const RENDER_PATH = path.join(REPO_ROOT, 'scripts/lib/dashboard/render.mjs');

const SECTION_FILES = [
  'skills.mjs',
  'cli.mjs',
  'flows.mjs',
  'architecture.mjs',
  'plans.mjs',
  'audit-runs.mjs',
  'requirements.mjs',
  'learning.mjs',
];

const FORBIDDEN_IN_SECTIONS = [
  "from '../render.mjs'",
  'from "../render.mjs"',
  "from '../helpers.mjs'",
  'from "../helpers.mjs"',
  "from './render.mjs'",     // defensive — shouldn't happen, but catches typos
  'from "./render.mjs"',
];

const EXPECTED_UI_KEYS = [
  'escapeHtml',
  'warningPanel',
  'emptyPanel',
  'statusDot',
  'tab',
  'panel',
  'splitUsage',
  'NON_OK',
];

// ── 1. Import direction — sections/*.mjs DO NOT import render or helpers ────

describe('section modules — one-way import direction', () => {
  for (const file of SECTION_FILES) {
    test(`sections/${file} does not import render.mjs or helpers.mjs`, () => {
      const src = fs.readFileSync(path.join(SECTIONS_DIR, file), 'utf-8');
      for (const fragment of FORBIDDEN_IN_SECTIONS) {
        assert.ok(!src.includes(fragment),
          `${file} must not contain ${fragment} — sections receive helpers via the ui arg`);
      }
    });
  }

  test('helpers.mjs does not import render.mjs nor any section', () => {
    const src = fs.readFileSync(HELPERS_PATH, 'utf-8');
    assert.ok(!src.includes("from './render"), 'helpers.mjs cannot import render');
    assert.ok(!src.includes('from "./render'), 'helpers.mjs cannot import render');
    assert.ok(!src.includes("from './sections/"), 'helpers.mjs cannot import sections');
    assert.ok(!src.includes('from "./sections/'), 'helpers.mjs cannot import sections');
  });
});

// ── 2. Every section module exports default with arity 2 ───────────────────

describe('section modules — shape contract', () => {
  for (const file of SECTION_FILES) {
    test(`sections/${file} exports default as a function with arity 2`, async () => {
      const mod = await import(`../scripts/lib/dashboard/sections/${file.replace('.mjs', '.mjs')}`);
      assert.equal(typeof mod.default, 'function', `${file} must export a default function`);
      assert.equal(mod.default.length, 2, `${file}'s default must take exactly (viewModel, ui)`);
    });
  }
});

// ── 3. `ui` bundle drift detection ──────────────────────────────────────────

describe('helpers.buildUi() — documented contract', () => {
  test('buildUi returns exactly the documented keys', async () => {
    const { buildUi } = await import('../scripts/lib/dashboard/helpers.mjs');
    const ui = buildUi();
    const actualKeys = Object.keys(ui).sort();
    const expectedKeys = [...EXPECTED_UI_KEYS].sort();
    assert.deepEqual(actualKeys, expectedKeys,
      'helpers.buildUi() shape drifted — update EXPECTED_UI_KEYS or fix the builder');
  });

  test('buildUi returns a frozen object (sections cannot mutate)', async () => {
    const { buildUi } = await import('../scripts/lib/dashboard/helpers.mjs');
    const ui = buildUi();
    assert.ok(Object.isFrozen(ui), 'ui bundle must be frozen so sections cannot tamper with helpers');
  });
});

// ── 4. render.mjs re-exports the backward-compat surface ─────────────────────

describe('render.mjs — public surface', () => {
  test('exports escapeHtml + jsonScriptSafe + renderDocument', async () => {
    const mod = await import('../scripts/lib/dashboard/render.mjs');
    assert.equal(typeof mod.escapeHtml, 'function');
    assert.equal(typeof mod.jsonScriptSafe, 'function');
    assert.equal(typeof mod.renderDocument, 'function');
  });

  test('render.mjs imports helpers.mjs (orchestrator IS allowed to)', () => {
    const src = fs.readFileSync(RENDER_PATH, 'utf-8');
    assert.ok(src.includes("from './helpers.mjs'") || src.includes('from "./helpers.mjs"'),
      'render.mjs must import from helpers.mjs');
  });

  test('render.mjs imports every section module', () => {
    const src = fs.readFileSync(RENDER_PATH, 'utf-8');
    for (const file of SECTION_FILES) {
      const stem = file.replace('.mjs', '');
      assert.ok(src.includes(`./sections/${stem}.mjs`),
        `render.mjs must import ./sections/${stem}.mjs`);
    }
  });
});

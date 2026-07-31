/**
 * @fileoverview Committed, freshness-verified (Category-B) artifacts must be
 * written ATOMICALLY.
 *
 * Why this is a class and not a preference: a Category-B artifact is *tracked*
 * and *gate-checked*. `fs.writeFileSync` truncates the destination before the
 * replacement bytes are durably written, so an interrupted generator leaves a
 * TRACKED file empty or half-written — and the pre-push gate that verifies it
 * then fails on a file the repo itself corrupted. `atomicWriteFileSync`
 * (temp + rename in the same directory) makes the replacement all-or-nothing.
 *
 * An audit flagged ONE of these (`skills.manifest.json`). Censusing the class
 * found FOUR non-atomic writers against a fifth (`requirements.mjs`) that had
 * always been correct — which is the whole reason this test exists: the fix was
 * never "add a temp file to build-manifest", it was "make the rule uniform and
 * keep it that way".
 *
 * Plan: docs/plans/layering-and-mutation-contracts.md (follow-up census).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { atomicWriteFileSync } from '../scripts/lib/file-io.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

/**
 * Generator → the committed artifact it owns.
 *
 * Category B is defined in AGENTS.md as "a pure, deterministic function of
 * committed source → committed AND freshness-verified in the pre-push check".
 * Adding a generator for a new committed artifact means adding it here.
 */
const CATEGORY_B_WRITERS = [
  ['scripts/build-manifest.mjs', 'skills.manifest.json'],
  ['scripts/generate-plans-index.mjs', 'docs/plans/README.md'],
  ['scripts/regenerate-skill-copies.mjs', '.claude/skills/**'],
  ['scripts/postgres-parity/generate-expected-schema.mjs', 'tests/fixtures/expected-schema.json'],
  ['scripts/requirements.mjs', 'docs/requirements-map.md'],
];

for (const [writer, artifact] of CATEGORY_B_WRITERS) {
  test(`${writer} writes ${artifact} atomically`, () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, writer), 'utf-8');
    // Strip comments so a passage *describing* the hazard is not mistaken for it.
    const code = src.replace(/^\s*(\/\/|\*|\/\*).*$/gm, '');

    assert.ok(
      /atomicWriteFileSync\s*\(/.test(code),
      `${writer} must use atomicWriteFileSync for its committed artifact`,
    );
    assert.ok(
      !/\bfs\.writeFileSync\s*\(|(?<![.\w])writeFileSync\s*\(/.test(
        code.replace(/atomicWriteFileSync\s*\(/g, ''),
      ),
      `${writer} still contains a raw writeFileSync — a torn write here corrupts a TRACKED file`,
    );
  });
}

test('atomicWriteFileSync actually replaces content in place', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ces-atomic-'));
  try {
    const target = path.join(dir, 'artifact.json');
    atomicWriteFileSync(target, '{"v":1}\n');
    assert.equal(fs.readFileSync(target, 'utf-8'), '{"v":1}\n');
    atomicWriteFileSync(target, '{"v":2}\n');
    assert.equal(fs.readFileSync(target, 'utf-8'), '{"v":2}\n', 'a rewrite must replace, not append');

    // No temp files left behind — a stray `.tmp` beside a committed artifact
    // would itself dirty the tree the gates check.
    assert.deepEqual(fs.readdirSync(dir), ['artifact.json']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

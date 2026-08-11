/**
 * The managed .gitattributes EOL-pin block (consumer-deployment-hardening).
 * Reuses the content-agnostic managed-block machinery (updateManagedBlock +
 * parseGitignoreState) — those are unit-tested in sync-gitignore.test.mjs; here
 * we pin the EOL-pin CONTENT shape + the sync-to-repos wiring presence.
 *
 * **Plus COMPLETENESS**, which this file could not previously assert. The pins
 * used to be a hand-kept inline list in sync-to-repos.mjs and the shape tests
 * below ran against a 2-element illustrative list — so a tracked synced surface
 * missing from the real list was structurally invisible, and one was:
 * `.audit-loop/expected-schema.json` shipped unpinned and churned on every
 * Windows consumer. Now the pins are derived from the bundle's own destinations
 * (lib/sync-eol-pins.mjs) and the completeness block asserts the real bundle
 * leaves nothing uncovered.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { updateManagedBlock, parseGitignoreState } from '../scripts/lib/sync-gitignore.mjs';
import {
  EOL_PIN_GLOBS, computeEolPins, renderEolPinLines, globToRegExp, isPinExempt,
} from '../scripts/lib/sync-eol-pins.mjs';
import { LAYOUT_CONSTANTS, sourceRelToDestRel } from '../scripts/lib/sync-path-map.mjs';
import { getAllConsumerInventories } from '../scripts/lib/sync-inventory.mjs';

describe('sync .gitattributes EOL pins', () => {
  it('EOL pins render as one valid managed block of `<glob> text eol=lf` lines', () => {
    const pins = [
      '.claude/skills/**',
      'docs/reference/consistency-contract.md',
    ];
    const lines = renderEolPinLines(pins);
    const r = updateManagedBlock(null, lines);
    assert.equal(r.action, 'create');
    for (const l of lines) assert.ok(r.content.includes(l), `block must pin ${l}`);
    const st = parseGitignoreState(r.content);
    assert.ok(st.beginIndices.length === 1 && st.endIndices.length === 1 && st.orderValid,
      'must be a single well-formed managed block');
  });

  it('merging into an existing .gitattributes replaces only the managed block', () => {
    const before = '*.png binary\n' + updateManagedBlock(null, ['old text eol=lf']).content + '\n';
    const r = updateManagedBlock(before, ['.claude/skills/** text eol=lf']);
    assert.equal(r.action, 'replace');
    assert.ok(r.content.includes('*.png binary'), 'consumer-owned rules preserved');
    assert.ok(r.content.includes('.claude/skills/** text eol=lf'));
    assert.ok(!r.content.includes('old text eol=lf'), 'stale managed lines replaced');
  });

  it('sync-to-repos wires a managed .gitattributes write from the DERIVED pins', () => {
    const src = fs.readFileSync(
      fileURLToPath(new URL('../scripts/sync-to-repos.mjs', import.meta.url)), 'utf-8');
    assert.ok(src.includes("'.gitattributes'"), 'must target .gitattributes');
    assert.ok(src.includes('computeEolPins') && src.includes('renderEolPinLines'),
      'must derive the pins rather than inline a hand-kept list');
    assert.ok(src.includes('eolPins.uncovered'),
      'must act on the uncovered set — a derivation nobody checks is a list with extra steps');
    assert.ok(src.includes('atomicWriteFileSync(gaPath'), 'must write the .gitattributes block');
  });
});

describe('sync EOL-pin glob semantics', () => {
  it('`**` crosses a separator; a single `*` does not', () => {
    assert.ok(globToRegExp('.claude/skills/**').test('.claude/skills/plan/references/a.md'));
    assert.ok(!globToRegExp('docs/*.md').test('docs/nested/a.md'));
    assert.ok(globToRegExp('docs/*.md').test('docs/a.md'));
  });

  it('a literal `.` in a glob is not a wildcard', () => {
    assert.ok(globToRegExp('.vscode/mcp.json').test('.vscode/mcp.json'));
    assert.ok(!globToRegExp('.vscode/mcp.json').test('.vscode/mcpXjson'));
  });

  it('only the gitignored tooling dir is pin-exempt', () => {
    assert.ok(isPinExempt(`${LAYOUT_CONSTANTS.CONSUMER_TOOLING_DIR}/openai-audit.mjs`));
    // Ignore-listed but never force-untracked, so a consumer may still track it.
    assert.ok(!isPinExempt(LAYOUT_CONSTANTS.MANIFEST_PATH));
    assert.ok(!isPinExempt(LAYOUT_CONSTANTS.EXPECTED_SCHEMA_DEST));
  });
});

describe('sync EOL-pin completeness (the guard the old shape test could not make)', () => {
  it('every trackable destination of every real consumer bundle is covered', () => {
    const inventories = getAllConsumerInventories();
    assert.ok(inventories.size > 0, 'no consumer inventories — the assertion would be vacuous');
    for (const [alias, inv] of inventories) {
      assert.ok(inv.files.length > 0, `bundle for "${alias}" is empty — vacuous pass`);
      const { pins, uncovered } = computeEolPins(inv.files.map(sourceRelToDestRel));
      assert.deepEqual(uncovered, [],
        `"${alias}" has trackable synced destinations with no EOL pin — add a covering glob to EOL_PIN_GLOBS`);
      assert.ok(pins.length > 0, `"${alias}" derived no pins at all`);
    }
  });

  it('the expected-schema fixture is pinned (the surface that drifted)', () => {
    // Named explicitly rather than relying on the sweep above: this is the
    // regression under repair, and it must fail loudly if the destination
    // constant is renamed out from under the covering glob.
    const { pins } = computeEolPins([LAYOUT_CONSTANTS.EXPECTED_SCHEMA_DEST]);
    assert.deepEqual(pins, [LAYOUT_CONSTANTS.EXPECTED_SCHEMA_DEST]);
    assert.ok(EOL_PIN_GLOBS.includes(LAYOUT_CONSTANTS.EXPECTED_SCHEMA_DEST));
  });

  it('an unpinned trackable destination is REPORTED, not silently dropped', () => {
    // Negative control: without this, "uncovered is empty" could pass because
    // the function never populates it.
    const { pins, uncovered } = computeEolPins([
      'docs/some-new-tracked-surface.md',
      `${LAYOUT_CONSTANTS.CONSUMER_TOOLING_DIR}/whatever.mjs`,
    ]);
    assert.deepEqual(uncovered, ['docs/some-new-tracked-surface.md']);
    assert.deepEqual(pins, [], 'the exempt tooling-dir path must not produce a pin');
  });

  it('only globs that matched something are emitted', () => {
    const { pins } = computeEolPins(['.vscode/mcp.json']);
    assert.deepEqual(pins, ['.vscode/mcp.json'],
      'the block must be a function of the bundle, not a static list');
  });
});

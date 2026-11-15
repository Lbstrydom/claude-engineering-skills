/**
 * Work-consumer feedback 2026-11-15, item 2: on Azure the final gate was called
 * "Gemini" while `_provider` recorded azure-claude. The gate is named by role and
 * resolved provider; a same-family reviewer is disclosed as a weaker check.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeFinalGate, WEAKER_CHECK_SENTENCE } from '../scripts/lib/final-review/gate-label.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

describe('describeFinalGate', () => {
  test('labels by role + resolved provider, never by the artefact name', () => {
    const g = describeFinalGate({ provider: 'azure-claude', model: 'my-opus-deployment' });
    assert.equal(g.label, 'final gate (azure-claude / my-opus-deployment)');
    assert.doesNotMatch(g.label, /gemini/i);
    assert.equal(g.reviewerFamily, 'anthropic', 'a bare Azure deployment name still resolves its family from the provider');
  });

  test('same family as a declared author → plain weaker-check sentence', () => {
    const g = describeFinalGate({ provider: 'azure-claude', model: 'claude-opus-4-8', authorModel: 'claude-opus-5-5' });
    assert.equal(g.sameFamilyAsAuthor, true);
    assert.ok(g.independenceNote.includes(WEAKER_CHECK_SENTENCE));
  });

  test('cross-vendor → no note', () => {
    const g = describeFinalGate({ provider: 'gemini', model: 'gemini-3.1-pro-preview', authorModel: 'claude-opus-5-5' });
    assert.equal(g.sameFamilyAsAuthor, false);
    assert.equal(g.independenceNote, null);
  });

  test('undeclared author + Anthropic reviewer → unmeasured (null), still disclosed', () => {
    const g = describeFinalGate({ provider: 'claude-opus', model: 'claude-opus-4-8' });
    assert.equal(g.sameFamilyAsAuthor, null);
    assert.match(g.independenceNote, /author model undeclared/);
    assert.ok(g.independenceNote.includes(WEAKER_CHECK_SENTENCE));
  });

  test('undeclared author + Gemini reviewer → no note', () => {
    assert.equal(describeFinalGate({ provider: 'gemini', model: 'gemini-3.1-pro-preview' }).independenceNote, null);
  });
});

describe('the surfaces a human reads use the label', () => {
  test('gemini-review stamps _gate on the result and the --out summary line', () => {
    const src = read('scripts/gemini-review.mjs');
    assert.match(src, /data\._gate = gateOf\(provider, data\._model\)/);
    assert.match(src, /\| \$\{data\._gate\.label\}/);
    assert.doesNotMatch(src, /— Independent Final Review`/, 'the human title names the gate by role');
  });
  test('the shared gemini-gate reference says to name it by role', () => {
    const ref = read('docs/audit/shared-references/gemini-gate.md');
    assert.match(ref, /\*\*Name it\s+by role\*\*/);
    assert.match(ref, /never "Gemini" unless `_provider` is `gemini`/);
  });
  test('/cycle report templates print the provider, not "Gemini APPROVE"', () => {
    for (const p of ['skills/cycle/SKILL.md', 'skills/cycle/references/remediate-mode.md']) {
      assert.doesNotMatch(read(p), /Final gate:\s+Gemini APPROVE/, p);
    }
  });
});

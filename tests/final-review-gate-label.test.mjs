/**
 * Work-consumer feedback 2026-11-15, item 2: on Azure the final gate was called
 * "Gemini" while `_provider` recorded azure-claude. The gate is named by role and
 * resolved provider; a same-family reviewer is disclosed as a weaker check.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
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

  test('an author model that cannot be classified is named as such, not as undeclared', () => {
    const h = describeFinalGate({ provider: 'azure-claude', model: 'x', authorModel: '/' });
    assert.equal(h.sameFamilyAsAuthor, null);
    assert.match(h.independenceNote, /author model "\/" unclassified/);
  });

  test('undeclared author + Gemini reviewer → no note', () => {
    assert.equal(describeFinalGate({ provider: 'gemini', model: 'gemini-3.1-pro-preview' }).independenceNote, null);
  });
});

describe('the surfaces a human reads use the label', () => {
  test('gemini-review stamps _gate on the --out result and names it on the summary line (real CLI, fixture provider)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-label-'));
    try {
      fs.writeFileSync(path.join(dir, 'plan.md'), '# plan\n');
      fs.writeFileSync(path.join(dir, 't.json'), JSON.stringify({ changed_files: ['src/a.mjs'], rounds: [] }));
      const out = path.join(dir, 'r.json');
      const r = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'gemini-review.mjs'), 'review', path.join(dir, 'plan.md'), path.join(dir, 't.json'), '--provider', 'fixture', '--out', out], {
        cwd: REPO, encoding: 'utf-8',
        env: { ...process.env, NODE_ENV: 'test', AUDIT_DB_URL: '', GEMINI_API_KEY: '', ANTHROPIC_API_KEY: '', AUDIT_AUTHOR_TIER_HINT: '' },
      });
      assert.equal(r.status, 0, r.stderr);
      const data = JSON.parse(fs.readFileSync(out, 'utf8'));
      assert.equal(data._gate.label, 'final gate (fixture / fixture)');
      assert.match(r.stdout, /\| final gate \(fixture \/ fixture\)/);
    } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  test('the shared gemini-gate reference says to name it by role', () => {
    const ref = read('docs/audit/shared-references/gemini-gate.md');
    assert.match(ref, /\*\*Name it\s+by role\*\*/);
    assert.match(ref, /never "Gemini" unless `_provider` is `gemini`/);
  });
  test('/cycle report templates print the provider, not "Gemini APPROVE"', () => {
    for (const p of ['skills/cycle/SKILL.md', 'skills/cycle/references/remediate-mode.md']) {
      assert.doesNotMatch(read(p), /Final (gate|review):\s+Gemini APPROVE/, p);
      assert.ok(read(p).includes('APPROVE (<provider> / <model>)'), p);
    }
  });
});

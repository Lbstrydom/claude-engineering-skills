/**
 * The managed .gitattributes EOL-pin block (consumer-deployment-hardening).
 * Reuses the content-agnostic managed-block machinery (updateManagedBlock +
 * parseGitignoreState) — those are unit-tested in sync-gitignore.test.mjs; here
 * we pin the EOL-pin CONTENT shape + the sync-to-repos wiring presence.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { updateManagedBlock, parseGitignoreState } from '../scripts/lib/sync-gitignore.mjs';

describe('sync .gitattributes EOL pins', () => {
  it('EOL pins render as one valid managed block of `<glob> text eol=lf` lines', () => {
    const pins = [
      '.claude/skills/** text eol=lf',
      '.github/prompts/** text eol=lf',
      'docs/consistency-contract.md text eol=lf',
    ];
    const r = updateManagedBlock(null, pins);
    assert.equal(r.action, 'create');
    for (const p of pins) assert.ok(r.content.includes(p), `block must pin ${p}`);
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

  it('sync-to-repos wires a managed .gitattributes write (eol=lf) — presence guard', () => {
    const src = fs.readFileSync(
      fileURLToPath(new URL('../scripts/sync-to-repos.mjs', import.meta.url)), 'utf-8');
    assert.ok(src.includes("'.gitattributes'"), 'must target .gitattributes');
    assert.ok(src.includes('gaPreview') && src.includes('text eol=lf'),
      'must compute a managed .gitattributes block of eol=lf pins');
    assert.ok(src.includes('atomicWriteFileSync(gaPath'), 'must write the .gitattributes block');
  });
});

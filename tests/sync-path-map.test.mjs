/**
 * @fileoverview Unit tests for the bidirectional path mapper.
 * Plan §2 KD #3, #3.5; tests/relocation-guard.test.mjs covers the
 * inventory-driven coverage assertion separately.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sourceRelToDestRel,
  destRelToSourceRel,
  isExplicitException,
  LAYOUT_CONSTANTS,
} from '../scripts/lib/sync-path-map.mjs';

test('sourceRelToDestRel: scripts/X.mjs → scripts/.claude-skills/X.mjs', () => {
  assert.equal(sourceRelToDestRel('scripts/openai-audit.mjs'), 'scripts/.claude-skills/openai-audit.mjs');
});

test('sourceRelToDestRel: scripts/lib/Y.mjs → scripts/.claude-skills/lib/Y.mjs', () => {
  assert.equal(sourceRelToDestRel('scripts/lib/redact.mjs'), 'scripts/.claude-skills/lib/redact.mjs');
});

test('sourceRelToDestRel: scripts/symbol-index/Z.mjs → preserves subdir', () => {
  assert.equal(sourceRelToDestRel('scripts/symbol-index/drift.mjs'), 'scripts/.claude-skills/symbol-index/drift.mjs');
});

test('sourceRelToDestRel: scripts/postgres-parity/X.mjs covered by default rule', () => {
  assert.equal(sourceRelToDestRel('scripts/postgres-parity/foo.mjs'), 'scripts/.claude-skills/postgres-parity/foo.mjs');
});

test('sourceRelToDestRel: scripts/.sync-manifest.json is an explicit exception', () => {
  assert.equal(sourceRelToDestRel('scripts/.sync-manifest.json'), 'scripts/.sync-manifest.json');
});

test('sourceRelToDestRel: supabase/migrations/X.sql → .audit-loop/migrations/X.sql', () => {
  assert.equal(sourceRelToDestRel('supabase/migrations/2026_01_01.sql'), '.audit-loop/migrations/2026_01_01.sql');
});

test('sourceRelToDestRel: .claude/skills/foo/SKILL.md unchanged', () => {
  assert.equal(sourceRelToDestRel('.claude/skills/audit-code/SKILL.md'), '.claude/skills/audit-code/SKILL.md');
});

test('sourceRelToDestRel: .claude/hooks/X unchanged', () => {
  assert.equal(sourceRelToDestRel('.claude/hooks/arch-memory-check.sh'), '.claude/hooks/arch-memory-check.sh');
});

test('sourceRelToDestRel: .claude/settings.json unchanged', () => {
  assert.equal(sourceRelToDestRel('.claude/settings.json'), '.claude/settings.json');
});

test('sourceRelToDestRel: .vscode/mcp.json unchanged', () => {
  assert.equal(sourceRelToDestRel('.vscode/mcp.json'), '.vscode/mcp.json');
});

test('sourceRelToDestRel: .github/prompts/X.prompt.md unchanged', () => {
  assert.equal(sourceRelToDestRel('.github/prompts/plan.prompt.md'), '.github/prompts/plan.prompt.md');
});

test('sourceRelToDestRel: unknown top-level path → passthrough', () => {
  assert.equal(sourceRelToDestRel('docs/README.md'), 'docs/README.md');
});

test('sourceRelToDestRel: already-isolated dest path → no double prefix', () => {
  assert.equal(
    sourceRelToDestRel('scripts/.claude-skills/openai-audit.mjs'),
    'scripts/.claude-skills/openai-audit.mjs',
  );
});

test('sourceRelToDestRel: Windows backslashes normalised', () => {
  assert.equal(sourceRelToDestRel('scripts\\openai-audit.mjs'), 'scripts/.claude-skills/openai-audit.mjs');
});

test('destRelToSourceRel: inverse of scripts → .claude-skills', () => {
  assert.equal(destRelToSourceRel('scripts/.claude-skills/openai-audit.mjs'), 'scripts/openai-audit.mjs');
});

test('destRelToSourceRel: inverse of migrations', () => {
  assert.equal(destRelToSourceRel('.audit-loop/migrations/2026_01_01.sql'), 'supabase/migrations/2026_01_01.sql');
});

test('destRelToSourceRel: explicit exceptions are fixed points', () => {
  assert.equal(destRelToSourceRel('.claude/skills/audit-code/SKILL.md'), '.claude/skills/audit-code/SKILL.md');
  assert.equal(destRelToSourceRel('scripts/.sync-manifest.json'), 'scripts/.sync-manifest.json');
});

test('round-trip invariant: destRelToSourceRel(sourceRelToDestRel(p)) === p', () => {
  const samples = [
    'scripts/openai-audit.mjs',
    'scripts/lib/redact.mjs',
    'scripts/symbol-index/drift.mjs',
    'scripts/postgres-parity/check.mjs',
    'supabase/migrations/2026_01_01.sql',
    '.claude/skills/plan/SKILL.md',
    '.claude/hooks/arch-memory-check.sh',
    '.vscode/mcp.json',
    '.github/prompts/audit-code.prompt.md',
    'scripts/.sync-manifest.json',
  ];
  for (const p of samples) {
    const dst = sourceRelToDestRel(p);
    const back = destRelToSourceRel(dst);
    assert.equal(back, p, `round-trip failed for ${p}: ${p} → ${dst} → ${back}`);
  }
});

test('isExplicitException covers all known canonical-path surfaces', () => {
  assert.equal(isExplicitException('.claude/skills/foo/SKILL.md'), true);
  assert.equal(isExplicitException('.claude/hooks/X.sh'), true);
  assert.equal(isExplicitException('.claude/settings.json'), true);
  assert.equal(isExplicitException('.vscode/mcp.json'), true);
  assert.equal(isExplicitException('.github/prompts/X.prompt.md'), true);
  assert.equal(isExplicitException('scripts/.sync-manifest.json'), true);
  assert.equal(isExplicitException('scripts/openai-audit.mjs'), false);
  assert.equal(isExplicitException('docs/foo.md'), false);
});

test('LAYOUT_CONSTANTS is frozen', () => {
  assert.throws(() => { LAYOUT_CONSTANTS.CONSUMER_TOOLING_DIR = 'evil'; }, TypeError);
});

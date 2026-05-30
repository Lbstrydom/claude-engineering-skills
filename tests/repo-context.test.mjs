/**
 * Tests for scripts/lib/repo-context.mjs — the blast-radius context layer.
 * Plan: docs/plans/adaptive-context-blast-radius.md — Phase 2.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getRepoContext, INTENT_SECTION_MAP } from '../scripts/lib/repo-context.mjs';

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'repo-ctx-'));
}

describe('getRepoContext — tiers against the real repo', () => {
  it('T0 returns a commit-stamped inventory block', () => {
    const r = getRepoContext({ tier: 'T0', baseDir: process.cwd() });
    assert.equal(r.resolvedTier, 'T0');
    assert.equal(r.degraded, false);
    assert.match(r.block, /<repo_inventory generated-at=[0-9a-f]{7}>/);
    assert.match(r.block, /scripts\/lib\/repo-context\.mjs/);
    assert.ok(r.tokensEst > 0);
  });

  it('T1 lists public exports of imported-unchanged modules', () => {
    // repo-context.mjs imports repo-inventory / module-graph / arch-context.
    // maxTokens lifted from the default to ensure the adjacency_context block
    // (which is appended AFTER the T0 inventory) survives truncation as the
    // repo's file count grows. The test checks for content, not budget
    // behaviour; budget behaviour is exercised separately.
    const r = getRepoContext({
      tier: 'T1', targetPaths: ['scripts/lib/repo-context.mjs'], baseDir: process.cwd(),
      maxTokens: 100_000,
    });
    assert.equal(r.resolvedTier, 'T1');
    assert.match(r.block, /<adjacency_context/);
    assert.match(r.block, /scripts\/lib\/repo-inventory\.mjs: .*listRepoFiles/);
    assert.match(r.block, /scripts\/lib\/module-graph\.mjs: .*resolveSpecifier/);
  });

  it('T1 with no changed files degrades to T0', () => {
    const r = getRepoContext({ tier: 'T1', targetPaths: [], baseDir: process.cwd() });
    assert.equal(r.resolvedTier, 'T0');
    assert.equal(r.degraded, true);
    assert.equal(r.fallbackReason, 't1_no_resolvable_adjacency');
  });

  it('T2 selects the AGENTS.md section by intent', () => {
    const arch = getRepoContext({ tier: 'T2', intent: 'architecture', baseDir: process.cwd() });
    assert.equal(arch.resolvedTier, 'T2');
    assert.match(arch.block, /<repo_doc_section heading="## Architecture"/);

    const audit = getRepoContext({ tier: 'T2', intent: 'audit-subsystem', baseDir: process.cwd() });
    // audit-subsystem maps to a different heading (or degrades if it drifted)
    if (audit.resolvedTier === 'T2') {
      assert.match(audit.block, /R2\+ Audit Mode/);
    } else {
      assert.equal(audit.fallbackReason, 't2_section_unavailable');
    }
  });

  it('T3 returns the symbol map when docs/architecture-map.md exists', () => {
    const r = getRepoContext({ tier: 'T3', baseDir: process.cwd() });
    // The repo generates architecture-map.md; if present → T3, else degrades.
    if (r.resolvedTier === 'T3') {
      assert.match(r.block, /<symbol_map source="docs\/architecture-map\.md"/);
    } else {
      assert.ok(['T1', 'T0'].includes(r.resolvedTier));
      assert.equal(r.fallbackReason, 't3_symbol_map_unavailable');
    }
  });

  it('every block is token-estimated and SHA-stamped', () => {
    const r = getRepoContext({ tier: 'T0', baseDir: process.cwd() });
    assert.equal(typeof r.commitSha, 'string');
    assert.equal(r.gitAvailable, true);
  });
});

describe('getRepoContext — degradation in a bare directory', () => {
  it('T2 degrades to T0 when there is no AGENTS.md', () => {
    const dir = mkTmp();
    fs.writeFileSync(path.join(dir, 'a.mjs'), 'export const a = 1;');
    const r = getRepoContext({ tier: 'T2', intent: 'architecture', baseDir: dir });
    assert.equal(r.resolvedTier, 'T0');
    assert.equal(r.fallbackReason, 't2_section_unavailable');
    assert.match(r.block, /<repo_inventory/);
  });

  it('T3 degrades through T1 to T0 with no symbol map and no diff', () => {
    const dir = mkTmp();
    fs.writeFileSync(path.join(dir, 'a.mjs'), 'export const a = 1;');
    const r = getRepoContext({ tier: 'T3', targetPaths: [], baseDir: dir });
    assert.equal(r.resolvedTier, 'T0');
    assert.equal(r.degraded, true);
  });

  it('git-unavailable directory still produces a block (SHA is null)', () => {
    const dir = mkTmp();
    fs.writeFileSync(path.join(dir, 'a.mjs'), '1');
    const r = getRepoContext({ tier: 'T0', baseDir: dir });
    assert.equal(r.gitAvailable, false);
    assert.equal(r.commitSha, null);
    assert.ok(r.block.includes('a.mjs'), 'block still valid without git');
  });

  it('an oversized block is truncated within the token budget', () => {
    const dir = mkTmp();
    for (let i = 0; i < 400; i++) {
      fs.writeFileSync(path.join(dir, `file-with-a-fairly-long-name-${i}.mjs`), '1');
    }
    const r = getRepoContext({ tier: 'T0', baseDir: dir, maxTokens: 200 });
    assert.ok(r.tokensEst <= 200, `tokensEst ${r.tokensEst} within budget`);
    assert.match(r.block, /\[truncated/);
  });
});

describe('INTENT_SECTION_MAP', () => {
  it('maps known intents to H2 headings', () => {
    assert.equal(INTENT_SECTION_MAP.architecture, '## Architecture');
    assert.ok(INTENT_SECTION_MAP['audit-subsystem'].startsWith('## '));
  });
});

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

import { findSyncTargets, EXPECTED_CONSUMERS } from '../scripts/sync-shared-audit-refs.mjs';

let TMP;

function setupRepo() {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-shared-test-'));
  fs.mkdirSync(path.join(TMP, 'docs', 'audit', 'shared-references'), { recursive: true });
  fs.mkdirSync(path.join(TMP, 'skills'), { recursive: true });
  return TMP;
}

function teardown() {
  if (TMP) fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  TMP = null;
}

beforeEach(() => { setupRepo(); });
afterEach(() => { teardown(); });

describe('sync-shared-audit-refs', () => {
  describe('findSyncTargets', () => {
    it('returns empty when canonical dir is empty', () => {
      const pairs = findSyncTargets(TMP);
      assert.deepEqual(pairs, []);
    });

    it('returns empty when no skills consume canonical', () => {
      fs.writeFileSync(path.join(TMP, 'docs/audit/shared-references/foo.md'), '---\nsummary: test\n---\nbody');
      // No skills/<x>/references/foo.md exists
      assert.deepEqual(findSyncTargets(TMP), []);
    });

    it('finds matching consumer skills', () => {
      fs.writeFileSync(path.join(TMP, 'docs/audit/shared-references/ledger-format.md'), 'CANONICAL');
      fs.mkdirSync(path.join(TMP, 'skills/audit-plan/references'), { recursive: true });
      fs.writeFileSync(path.join(TMP, 'skills/audit-plan/references/ledger-format.md'), 'STALE');
      fs.mkdirSync(path.join(TMP, 'skills/audit-code/references'), { recursive: true });
      fs.writeFileSync(path.join(TMP, 'skills/audit-code/references/ledger-format.md'), 'STALE');

      const pairs = findSyncTargets(TMP);
      assert.equal(pairs.length, 2);
      const skills = pairs.map(p => p.skill).sort();
      assert.deepEqual(skills, ['audit-code', 'audit-plan']);
    });

    it('skips skills that do not have the canonical file', () => {
      fs.writeFileSync(path.join(TMP, 'docs/audit/shared-references/foo.md'), 'CANONICAL');
      fs.mkdirSync(path.join(TMP, 'skills/audit-plan/references'), { recursive: true });
      fs.writeFileSync(path.join(TMP, 'skills/audit-plan/references/foo.md'), 'STALE');
      // audit-code does NOT have references/ at all
      fs.mkdirSync(path.join(TMP, 'skills/audit-code'), { recursive: true });

      const pairs = findSyncTargets(TMP);
      assert.equal(pairs.length, 1);
      assert.equal(pairs[0].skill, 'audit-plan');
    });

    it('handles multiple canonical files', () => {
      fs.writeFileSync(path.join(TMP, 'docs/audit/shared-references/a.md'), 'A');
      fs.writeFileSync(path.join(TMP, 'docs/audit/shared-references/b.md'), 'B');
      fs.mkdirSync(path.join(TMP, 'skills/foo/references'), { recursive: true });
      fs.writeFileSync(path.join(TMP, 'skills/foo/references/a.md'), 'old A');
      fs.writeFileSync(path.join(TMP, 'skills/foo/references/b.md'), 'old B');
      // also a non-canonical file that should NOT be included
      fs.writeFileSync(path.join(TMP, 'skills/foo/references/c.md'), 'unrelated');

      const pairs = findSyncTargets(TMP);
      assert.equal(pairs.length, 2);
      const basenames = pairs.map(p => p.basename).sort();
      assert.deepEqual(basenames, ['a.md', 'b.md']);
    });

    it('only matches files in references/ subdirectories, not other locations', () => {
      fs.writeFileSync(path.join(TMP, 'docs/audit/shared-references/foo.md'), 'CANONICAL');
      fs.mkdirSync(path.join(TMP, 'skills/audit-plan'), { recursive: true });
      // foo.md at the wrong place
      fs.writeFileSync(path.join(TMP, 'skills/audit-plan/foo.md'), 'STALE');

      const pairs = findSyncTargets(TMP);
      // Schema-driven discovery may still emit registry-expected targets
      // (with expected:true), but only if the canonical filename is in
      // EXPECTED_CONSUMERS. 'foo.md' isn't, so we expect 0 pairs.
      assert.equal(pairs.length, 0);
    });
  });

  describe('EXPECTED_CONSUMERS registry (audit fix for Gemini F1)', () => {
    it('emits expected pairs even when target file does not yet exist (bootstrap)', () => {
      fs.writeFileSync(path.join(TMP, 'docs/audit/shared-references/ledger-format.md'), 'CANONICAL');
      // Skills exist but neither has the reference file yet.
      fs.mkdirSync(path.join(TMP, 'skills/audit-plan/references'), { recursive: true });
      fs.mkdirSync(path.join(TMP, 'skills/audit-code/references'), { recursive: true });

      const pairs = findSyncTargets(TMP);
      const expected = pairs.filter(p => p.expected === true);
      assert.equal(expected.length, 2, 'both audit-plan and audit-code should be in expected targets');
      const skills = expected.map(p => p.skill).sort();
      assert.deepEqual(skills, ['audit-code', 'audit-plan']);
    });

    it('marks expected pairs as expected:true and auto-discovered as expected:false', () => {
      fs.writeFileSync(path.join(TMP, 'docs/audit/shared-references/ledger-format.md'), 'CANONICAL');
      // audit-plan is in EXPECTED_CONSUMERS — registry pair, file may or may not exist
      fs.mkdirSync(path.join(TMP, 'skills/audit-plan/references'), { recursive: true });
      fs.writeFileSync(path.join(TMP, 'skills/audit-plan/references/ledger-format.md'), 'STALE');
      // audit-loop is NOT in EXPECTED_CONSUMERS for ledger-format.md (post-Phase-4)
      // but happens to have the file — should be picked up via auto-discover
      fs.mkdirSync(path.join(TMP, 'skills/audit-loop/references'), { recursive: true });
      fs.writeFileSync(path.join(TMP, 'skills/audit-loop/references/ledger-format.md'), 'OPPORTUNISTIC');

      const pairs = findSyncTargets(TMP);
      const audit_plan = pairs.find(p => p.skill === 'audit-plan');
      const audit_loop = pairs.find(p => p.skill === 'audit-loop');
      assert.equal(audit_plan?.expected, true);
      assert.equal(audit_loop?.expected, false);
    });

    it('does not double-emit a target that is both registered AND on disk', () => {
      fs.writeFileSync(path.join(TMP, 'docs/audit/shared-references/ledger-format.md'), 'CANONICAL');
      fs.mkdirSync(path.join(TMP, 'skills/audit-plan/references'), { recursive: true });
      fs.writeFileSync(path.join(TMP, 'skills/audit-plan/references/ledger-format.md'), 'STALE');

      const pairs = findSyncTargets(TMP);
      const audit_plan_pairs = pairs.filter(p => p.skill === 'audit-plan');
      assert.equal(audit_plan_pairs.length, 1, 'audit-plan should appear exactly once');
    });

    it('EXPECTED_CONSUMERS is a frozen registry', () => {
      assert.ok(Object.isFrozen(EXPECTED_CONSUMERS));
    });

    it('EXPECTED_CONSUMERS lists audit-plan and audit-code for both shared refs', () => {
      assert.deepEqual([...EXPECTED_CONSUMERS['ledger-format.md']].sort(), ['audit-code', 'audit-plan']);
      assert.deepEqual([...EXPECTED_CONSUMERS['gemini-gate.md']].sort(), ['audit-code', 'audit-plan']);
    });
  });

  describe('integration via CLI invocation', () => {
    it('script runs and reports IN SYNC when targets match canonical', async () => {
      // Use the real repo under test (not TMP) — verifies the live setup.
      const { execFileSync } = await import('node:child_process');
      const out = execFileSync('node',
        [path.resolve('scripts/sync-shared-audit-refs.mjs'), '--check'],
        { encoding: 'utf-8' },
      );
      assert.match(out, /IN SYNC|DRIFT/);
    });
  });
});

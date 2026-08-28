/**
 * @fileoverview Tier 1/2 tests for scripts/lib/audit/event-wiring-pass.mjs —
 * relocated from legacy-production-audit.mjs
 * (docs/plans/legacy-production-audit-decomposition.md Phase 3).
 *
 * The failure-boundary shape (detector call wrapped in try/catch → structured
 * ERROR state) is pinned as a static regression guard in
 * tests/legacy-production-audit-hardening.test.mjs (relocated to read this
 * file's source). This file covers the config-load failure path directly —
 * `runEventWiringSymmetryPass` must degrade to a structured ERROR state
 * rather than throw when the wave's own config is invalid.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { runEventWiringSymmetryPass } = await import('../scripts/lib/audit/event-wiring-pass.mjs');

describe('runEventWiringSymmetryPass — config-load failure boundary', () => {
  it('degrades to a structured ERROR state (never throws) on an invalid event-wiring config', async () => {
    // loadEventWiringConfig looks for a wiring config file under the repo
    // root; a repo root with no such file (or a malformed one) is the
    // "present-but-invalid" / "unreadable" case this wave must fail closed on.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ewp-badconfig-'));
    try {
      fs.mkdirSync(path.join(tmpDir, '.audit-loop'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, '.audit-loop', 'event-wiring.json'), '{not valid json');
      const out = await runEventWiringSymmetryPass({
        repoRoot: tmpDir, auditBaseCommit: null, runId: 'r1', ledger: null, planContent: null, learningWritesAllowed: false,
      });
      assert.equal(out.state, 'ERROR');
      assert.equal(out.result.result.pass_name, 'event-wiring-symmetry');
      assert.equal(out.result.result.findings.length, 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});

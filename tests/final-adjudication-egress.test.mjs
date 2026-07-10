/**
 * @fileoverview Tier 3 test-first (AGENTS.md non-negotiable — lands in the
 * SAME commit as the production adapter it guards) for `final-adjudication.mjs`'s
 * mandatory sensitive-egress gate (tiered-recall audit pipeline Phase 12,
 * audit-plan fix H2 round 3/4).
 *
 * Asserts a `.env`-path anchor, a configured-sensitive-path anchor, and a
 * symlink resolving into a sensitive path (mirroring
 * `tests/sensitive-paths-canonical.test.mjs`'s own symlink fixtures) all
 * correctly produce `pending_security_review` — NEVER a transcript
 * containing the sensitive content, and NEVER a `'clean'`/`confirmed_dismissal`
 * verdict for an item that was never actually sent.
 *
 * "No transcript is ever written" is proven via a THROWING `execFileImpl`
 * spy: `reviewCall`/`cleanRegionCall`'s sensitive-path check returns
 * `{verdict:'pending_security_review'}` BEFORE `invokeGeminiReviewSubprocess`
 * (the function that mkdtemps + writes the transcript file) is ever called
 * at all — so if a regression ever removed that early return, execution
 * WOULD reach `invokeGeminiReviewSubprocess` and, downstream of the write,
 * reach this spy, which throws and fails the test loudly. (An earlier draft
 * asserted this more directly via an os.tmpdir() before/after directory
 * listing diff — dropped as flaky: `node --test` runs test FILES
 * concurrently by default, and this repo's OWN subprocess-adapter test file
 * legitimately creates `audit-adjudication-*` dirs via the SAME shared
 * `os.tmpdir()` prefix at the same time, so a generic-prefix directory scan
 * can't tell "this call's own leftover" apart from "an unrelated concurrent
 * call's in-flight dir.")
 *
 * Plan: docs/plans/tiered-recall-audit-pipeline.md Phase 12.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createGeminiReviewSubprocessAdapters,
  runFinalAdjudication,
} from '../scripts/lib/audit/final-adjudication.mjs';

const skipOnWin = process.platform === 'win32';

/** execFileImpl spy that FAILS the test if the subprocess is ever spawned —
 * the strongest available proof that no transcript was ever written/sent
 * (invokeGeminiReviewSubprocess's mkdtemp + transcript write both happen
 * strictly BEFORE it would call this). */
function neverCallExecFile() {
  return (..._args) => {
    throw new Error('execFileImpl must NEVER be invoked for a sensitive-evidence item — no subprocess may be spawned');
  };
}

function mkEnvelope({ id = 'H1', anchorFile, triggerAnchorFile } = {}) {
  const canonicalFinding = {
    id, severity: 'HIGH', category: 'Test', detail: 'sensitive content must never leak',
  };
  if (anchorFile) {
    canonicalFinding.section = anchorFile;
    canonicalFinding.anchor = { oldFile: anchorFile, newFile: anchorFile };
  }
  if (triggerAnchorFile) {
    canonicalFinding.section = triggerAnchorFile;
    canonicalFinding.triggerAnchor = { oldFile: triggerAnchorFile, newFile: triggerAnchorFile };
  }
  return { candidateId: `envelope:${id}`, canonicalFinding, evidenceAlternatives: [], stageDecisions: [] };
}

describe('sensitive-egress gate — .env-path anchor', () => {
  const CASES = [
    { label: '.env at repo root', file: '.env' },
    { label: '.env.production', file: '.env.production' },
  ];

  for (const { label, file } of CASES) {
    it(`reviewCall: ${label} → pending_security_review, no subprocess spawned`, async () => {
      const adapters = createGeminiReviewSubprocessAdapters({
        repoRoot: process.cwd(), execFileImpl: neverCallExecFile(),
      });
      const response = await adapters.reviewCall(mkEnvelope({ anchorFile: file }));
      assert.deepEqual(response, { verdict: 'pending_security_review' });
    });

    it(`cleanRegionCall: ${label} → pending_security_review, no subprocess spawned`, async () => {
      const adapters = createGeminiReviewSubprocessAdapters({
        repoRoot: process.cwd(), execFileImpl: neverCallExecFile(),
      });
      const response = await adapters.cleanRegionCall(file);
      assert.deepEqual(response, { verdict: 'pending_security_review' });
    });
  }

  it('an omission finding\'s triggerAnchor pointing at .env also produces pending_security_review', async () => {
    const adapters = createGeminiReviewSubprocessAdapters({ repoRoot: process.cwd(), execFileImpl: neverCallExecFile() });
    const response = await adapters.reviewCall(mkEnvelope({ triggerAnchorFile: '.env' }));
    assert.deepEqual(response, { verdict: 'pending_security_review' });
  });
});

describe('sensitive-egress gate — configured-sensitive-path anchor', () => {
  const CASES = ['secrets/db.yaml', 'config/credentials.json', '.aws/config', '.ssh/id_rsa'];

  for (const file of CASES) {
    it(`reviewCall: ${file} → pending_security_review, no subprocess spawned`, async () => {
      const adapters = createGeminiReviewSubprocessAdapters({ repoRoot: process.cwd(), execFileImpl: neverCallExecFile() });
      const response = await adapters.reviewCall(mkEnvelope({ anchorFile: file }));
      assert.deepEqual(response, { verdict: 'pending_security_review' });
    });
  }
});

describe('sensitive-egress gate — symlink resolving into a sensitive path (WS-CANON)', () => {
  it('reviewCall: a lexically-innocent path whose symlink target resolves into secrets/ → pending_security_review', async () => {
    if (skipOnWin) return;
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-repo-'));
    try {
      const secretsDir = path.join(repoRoot, 'secrets');
      fs.mkdirSync(secretsDir);
      const realTarget = path.join(secretsDir, 'db.yaml');
      fs.writeFileSync(realTarget, 'super-secret-content');
      fs.symlinkSync(realTarget, path.join(repoRoot, 'innocent.ts'));

      const adapters = createGeminiReviewSubprocessAdapters({ repoRoot, execFileImpl: neverCallExecFile() });
      const response = await adapters.reviewCall(mkEnvelope({ anchorFile: 'innocent.ts' }));
      assert.deepEqual(response, { verdict: 'pending_security_review' });
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('cleanRegionCall: same symlink-escape shape → pending_security_review', async () => {
    if (skipOnWin) return;
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-repo-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-outside-'));
    try {
      const target = path.join(outside, 'secret-target.txt');
      fs.writeFileSync(target, 'pretend-secret');
      fs.symlinkSync(target, path.join(repoRoot, 'notes.txt'));

      const adapters = createGeminiReviewSubprocessAdapters({ repoRoot, execFileImpl: neverCallExecFile() });
      const response = await adapters.cleanRegionCall('notes.txt');
      assert.deepEqual(response, { verdict: 'pending_security_review' });
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('an innocent file that is genuinely not sensitive is NOT gated (control case — the gate is not over-broad; the real subprocess+fixture IS reached)', async () => {
    // Uses the REAL repo root (not a fake temp dir) so `cwd` matches
    // `assertRepoRoot`'s own expectation when the real gemini-review.mjs
    // script is spawned — AGENTS.md is a real, definitely-non-sensitive file.
    const repoRoot = path.resolve(import.meta.dirname, '..');
    const adapters = createGeminiReviewSubprocessAdapters({
      repoRoot,
      extraCliArgs: ['--provider', 'fixture'],
      env: { ...process.env, NODE_ENV: 'test', GEMINI_API_KEY: '', ANTHROPIC_API_KEY: '' },
      perCallTimeoutMs: 60000,
    });
    const response = await adapters.reviewCall(mkEnvelope({ anchorFile: 'AGENTS.md' }));
    assert.notEqual(response.verdict, 'pending_security_review');
  });
});

describe('sensitive-egress gate — runFinalAdjudication routing (integration)', () => {
  it('a sensitive-evidence envelope routes to pendingSecurityReview, NEVER reversed/confirmedDismissal/verified/unresolved', async () => {
    const envelope = mkEnvelope({ anchorFile: '.env', id: 'H1' });
    envelope.stageDecisions.push({ stage: 'stage1', outcome: 'mechanical_dismissed', reasonCode: 'x', hasDeterministicDisproof: true, createdAt: '2026-01-01T00:00:00.000Z' });
    const adapters = createGeminiReviewSubprocessAdapters({ repoRoot: process.cwd(), execFileImpl: neverCallExecFile() });

    const result = await runFinalAdjudication(
      { escalated: [], mechanicalDismissed: [envelope] }, [],
      { reviewCall: adapters.reviewCall, cleanRegionCall: adapters.cleanRegionCall, clock: () => '2026-01-01T00:00:00.000Z' },
      { seed: 1 }
    );

    assert.equal(result.reversed.length, 0);
    assert.equal(result.confirmedDismissal.length, 0);
    assert.equal(result.verified.length, 0);
    assert.equal(result.unresolved.length, 0);
    assert.equal(result.pendingSecurityReview.length, 1);
    assert.equal(result.pendingSecurityReview[0].candidateId, envelope.candidateId);
    assert.equal(envelope.stageDecisions.at(-1).outcome, 'pending_security_review');
  });

  it('a sensitive clean-region file routes to cleanRegionFailures with reason:"sensitive_path", NEVER missedCandidates/clean', async () => {
    const adapters = createGeminiReviewSubprocessAdapters({ repoRoot: process.cwd(), execFileImpl: neverCallExecFile() });

    const result = await runFinalAdjudication(
      { escalated: [], mechanicalDismissed: [] }, ['.env'],
      { reviewCall: adapters.reviewCall, cleanRegionCall: adapters.cleanRegionCall, clock: () => '2026-01-01T00:00:00.000Z' },
      { cleanRegionRate: 1, seed: 1 }
    );

    assert.equal(result.missedCandidates.length, 0);
    assert.equal(result.cleanRegionFailures.length, 1);
    assert.equal(result.cleanRegionFailures[0].file, '.env');
    assert.equal(result.cleanRegionFailures[0].reason, 'sensitive_path');
  });
});

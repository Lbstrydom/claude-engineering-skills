/**
 * @fileoverview `buildArmArgs`, `verifyPreflightArtifact`, `EXPERIMENT_TAG` —
 * arg construction, subprocess-result verification (D2).
 *
 * Split out of `tests/final-review-bakeoff.test.mjs` in the SAME commit that
 * moves the implementations into `scripts/lib/bakeoff/spawn.mjs` (Phase 2,
 * plan: comparison-tooling-consolidation.md) — never split a test from its
 * own implementation across a phase boundary, the rule Phase 1 already
 * applied to the arms/summary blocks. This lands earlier than the original
 * D3 matrix's "Phase 4" placement for `verifyPreflightArtifact` (which
 * assumed the function would still be entry-point-local at that point);
 * superseded by the same "moves with its implementation" rule.
 *
 * @module tests/bakeoff-spawn
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import nodeCrypto from 'node:crypto';

import { buildArmArgs, EXPERIMENT_TAG, verifyPreflightArtifact } from '../scripts/lib/bakeoff/spawn.mjs';
import { parseCampaignConfig } from '../scripts/lib/campaign/config.mjs';

describe('verifyPreflightArtifact — collector-side sha256 recomputation (plan §8)', () => {
  const PREFLIGHT = { artifact: 'docs/research/grok-effort-preflight-2026q3.json', sha256: 'a'.repeat(64), disposition: 'pass' };
  const content = Buffer.from('{"trials":[]}');
  const realSha256 = nodeCrypto.createHash('sha256').update(content).digest('hex');

  it('no preflight declared -> not checked, ok (no xAI arm, nothing to verify)', () => {
    const r = verifyPreflightArtifact(undefined);
    assert.equal(r.ok, true);
    assert.equal(r.checked, false);
  });

  it('artifact missing on disk -> refused, never silently skipped', () => {
    const r = verifyPreflightArtifact(PREFLIGHT, { exists: () => false });
    assert.equal(r.ok, false);
    assert.match(r.reason, /does not exist/);
  });

  it('RECOMPUTED sha256 mismatches the recorded one -> refused (tamper/edit detection)', () => {
    // This is the whole point of "collector-side RECOMPUTATION" — a recorded
    // hash nobody recomputes is decoration. The artifact on disk here does NOT
    // match PREFLIGHT.sha256 ('a'.repeat(64)), simulating a post-signing edit.
    const r = verifyPreflightArtifact(PREFLIGHT, { exists: () => true, readFile: () => content });
    assert.equal(r.ok, false);
    assert.match(r.reason, /has been modified since the campaign was signed/);
  });

  it('sha256 matches but disposition is not "pass" -> refused (belt-and-braces)', () => {
    const withRealSha = { ...PREFLIGHT, sha256: realSha256, disposition: 'fail' };
    const r = verifyPreflightArtifact(withRealSha, { exists: () => true, readFile: () => content });
    assert.equal(r.ok, false);
    assert.match(r.reason, /disposition is "fail"/);
  });

  it('sha256 matches AND disposition is "pass" -> verified, checked:true', () => {
    const withRealSha = { ...PREFLIGHT, sha256: realSha256 };
    const r = verifyPreflightArtifact(withRealSha, { exists: () => true, readFile: () => content });
    assert.equal(r.ok, true);
    assert.equal(r.checked, true);
    assert.equal(r.artifact, PREFLIGHT.artifact);
  });

  it('the REAL committed artifact verifies against the REAL campaign config (end-to-end, no mocks)', () => {
    // No injected deps — reads the actual files this repo ships. If this ever
    // fails, either the artifact was edited without re-running the pre-flight,
    // or the campaign config's recorded sha256 is stale.
    const { config } = parseCampaignConfig(
      JSON.parse(nodeFs.readFileSync('.campaigns/final-review-scoped-2026q3.json', 'utf-8')),
    );
    const r = verifyPreflightArtifact(config.controls.preflight);
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.checked, true);
  });
});

describe('cloud run wiring (bakeoff/spawn buildArmArgs)', () => {
  const arm = { id: 'kimi', args: ['--provider', 'openrouter'] };
  const ctx = { transcript: 't.json', plan: 'p.md', mode: 'code', out: 'o.json' };

  it('threads --run-id so the final-review cloud write is armed', () => {
    // `runShadowAndPersist` bails at `if (!runId) return`, so omitting this
    // makes the ENTIRE persist a silent no-op — snapshots 2-3 of this campaign
    // reached the store with final_review_shadow_model NULL and zero findings
    // for exactly this reason, leaving nothing to adjudicate.
    const args = buildArmArgs(arm, { ...ctx, runId: 'run-abc' });
    const i = args.indexOf('--run-id');
    assert.notEqual(i, -1, '--run-id absent — the cloud write would be a no-op');
    assert.equal(args[i + 1], 'run-abc');
  });

  it('OMITS --run-id when registration failed, never passing a blank', () => {
    // A trailing `--run-id` with no value (or an empty string) is consumed as
    // the flag's VALUE by the argv parser and writes nowhere — the same silence
    // as omitting it, but harder to see.
    for (const runId of [null, undefined, '']) {
      const args = buildArmArgs(arm, { ...ctx, runId });
      assert.equal(args.includes('--run-id'), false, `blank run-id leaked for ${JSON.stringify(runId)}`);
    }
  });

  it('keeps the arm’s own provider flags intact alongside the run id', () => {
    const args = buildArmArgs(arm, { ...ctx, runId: 'r1' });
    assert.ok(args.includes('--provider') && args.includes('openrouter'));
    assert.equal(args[args.indexOf('--mode') + 1], 'code');
  });

  it('tags every minted run as an experiment, so per-run rates can exclude it', () => {
    // The campaign quotes "~1.1 accepted HIGH/MED per RUN" — a rate whose
    // denominator is COUNT(*) over audit_runs. Replays are not audits; an
    // untagged replay deflates the rate it is being compared against.
    assert.equal(EXPERIMENT_TAG, 'final-review-bakeoff');
  });

  it('threads --envelope-scope and --campaign-digest when a campaign is active (plan KD-6)', () => {
    const args = buildArmArgs(arm, { ...ctx, runId: 'r1', envelopeScope: 'thin', campaignDigest: 'deadbeef' });
    assert.equal(args[args.indexOf('--envelope-scope') + 1], 'thin');
    assert.equal(args[args.indexOf('--campaign-digest') + 1], 'deadbeef');
  });

  it('OMITS both flags when no campaign is active — never passes a blank value', () => {
    const args = buildArmArgs(arm, { ...ctx, runId: 'r1' });
    assert.equal(args.includes('--envelope-scope'), false);
    assert.equal(args.includes('--campaign-digest'), false);
  });

  it('the two flags travel TOGETHER — scope with no digest is still omitted-or-present consistently', () => {
    // Guards against a caller passing envelopeScope without campaignDigest,
    // which would make the spawned reviewer believe a campaign is active
    // (--campaign-digest present) while actually recording no digest at all —
    // this test pins that buildArmArgs does not silently synthesize one.
    const args = buildArmArgs(arm, { ...ctx, runId: 'r1', envelopeScope: 'thin' });
    assert.equal(args[args.indexOf('--envelope-scope') + 1], 'thin');
    assert.equal(args.includes('--campaign-digest'), false);
  });
});

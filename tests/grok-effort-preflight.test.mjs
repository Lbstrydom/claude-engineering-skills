/**
 * Tier-1 (pure) tests for the Grok reasoning-effort pre-flight's disposition
 * rule and spend-bound derivation. Network calls, fixture building against a
 * real transcript, and artifact writing are exercised live by the script
 * itself (`--build-fixture` / `--run`) — not re-mocked here; a mock that
 * repairs the network response would test the mock, not the logic that
 * decides pass/fail from what a real call returns.
 *
 * Plan: docs/plans/final-review-scoped-second-reviewer.md §8.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  computeDisposition, computeWorstCaseSpendUsd, TRIALS_PER_EFFORT,
  MAX_OUTPUT_TOKENS, SPEND_CAP_USD, PREFLIGHT_FIXTURE_MAX_CHARS, CALL_TIMEOUT_MS,
  buildFixture,
} from '../scripts/grok-effort-preflight.mjs';

const trial = (effort, reasoningTokens, ok = true) => ({ effort, ok, reasoningTokens });

describe('computeDisposition — the pass/fail/inconclusive rule', () => {
  it('PASS: non-overlapping distributions, high strictly above low', () => {
    const r = computeDisposition([
      trial('low', 20), trial('low', 30), trial('low', 25),
      trial('high', 100), trial('high', 150), trial('high', 120),
    ]);
    assert.equal(r.disposition, 'pass');
  });

  it('FAIL: distributions overlap — this is the inert-dial case the pre-flight exists to catch', () => {
    const r = computeDisposition([
      trial('low', 50), trial('low', 60), trial('low', 55),
      trial('high', 55), trial('high', 58), trial('high', 60),
    ]);
    assert.equal(r.disposition, 'fail');
    assert.match(r.reason, /inert or unproven/);
  });

  it('FAIL boundary: min(high) EQUAL to max(low) does not count as separated', () => {
    // Strict `>`, not `>=` — a tie is not "does not overlap".
    const r = computeDisposition([
      trial('low', 50), trial('low', 60), trial('low', 70),
      trial('high', 70), trial('high', 80), trial('high', 90),
    ]);
    assert.equal(r.disposition, 'fail');
  });

  it('INCONCLUSIVE: a failed call (network error) treated as fail-for-manifest, distinct reason', () => {
    const r = computeDisposition([
      trial('low', 20), trial('low', 30), { effort: 'low', ok: false, error: 'timeout' },
      trial('high', 100), trial('high', 150), trial('high', 120),
    ]);
    assert.equal(r.disposition, 'inconclusive');
    assert.match(r.reason, /failed or reported no reasoning_tokens/);
  });

  it('INCONCLUSIVE: a 200 response with no reasoning_tokens field is NOT silently treated as 0', () => {
    // ok:true but reasoningTokens undefined must not pass the isFinite check
    // and get compared as if it were a real 0 — that would let a provider
    // that stops reporting the field read as "the dial is inert" (a FAIL)
    // rather than "we can't tell" (INCONCLUSIVE), which is the wrong verdict
    // for missing evidence.
    const r = computeDisposition([
      trial('low', 20), trial('low', 30), { effort: 'low', ok: true, reasoningTokens: undefined },
      trial('high', 100), trial('high', 150), trial('high', 120),
    ]);
    assert.equal(r.disposition, 'inconclusive');
  });

  it('INCONCLUSIVE: wrong trial count (never silently proceeds on partial data)', () => {
    const r = computeDisposition([trial('low', 20), trial('high', 100)]);
    assert.equal(r.disposition, 'inconclusive');
    assert.match(r.reason, /expected 6 trials, got 2/);
  });

  it('an all-LOW mislabelled 6-trial set is INCONCLUSIVE, never a garbage PASS (audit-found bug)', () => {
    // Reproduces the exact bug the cluster audit caught: 6 trials, every one
    // labelled 'low' (a plausible labelling defect). Before the fix, this
    // returned {disposition:'pass', reason:'min(high)=Infinity > max(low)=...'}
    // — Math.min(...[]) on an empty `high` array is Infinity, so an empty
    // group silently "passed" the non-overlap check.
    const all = Array.from({ length: 6 }, (_, i) => trial('low', 10 + i));
    const r = computeDisposition(all);
    assert.equal(r.disposition, 'inconclusive');
    assert.match(r.reason, /expected \d+ trials per effort level/);
  });

  it('an unbalanced 5-low/1-high split is INCONCLUSIVE, not a lucky pass', () => {
    const unbalanced = [
      trial('low', 10), trial('low', 11), trial('low', 12), trial('low', 13), trial('low', 14),
      trial('high', 500),
    ];
    const r = computeDisposition(unbalanced);
    assert.equal(r.disposition, 'inconclusive');
  });

  it('an unrecognised effort label is rejected explicitly, not silently dropped into a bucket', () => {
    const bad = [
      trial('low', 10), trial('low', 11), trial('low', 12),
      trial('high', 100), trial('high', 110), trial('medium', 999),
    ];
    const r = computeDisposition(bad);
    assert.equal(r.disposition, 'inconclusive');
    assert.match(r.reason, /unexpected effort label/);
  });

  it('the REAL committed artifact\'s trial data passes this function (reads the file, never a frozen snapshot)', () => {
    // An earlier version of this test hardcoded specific trial numbers as a
    // "frozen regression." That went stale the first time the artifact was
    // legitimately re-run (a fix landed in buildFixture, so the pre-flight was
    // re-run for real to re-verify it end-to-end) — the artifact's real
    // numbers changed, and the test kept asserting the OLD ones, silently
    // testing nothing real (the cluster audit's L3). Reading the artifact
    // directly means this test can never drift from what is actually
    // committed, whatever it re-runs to next.
    const artifact = JSON.parse(readFileSync(
      new URL('../docs/research/grok-effort-preflight-2026q3.json', import.meta.url), 'utf-8',
    ));
    assert.equal(artifact.trials.length, TRIALS_PER_EFFORT * 2, 'the artifact itself must carry a full trial set');
    const r = computeDisposition(artifact.trials.map((t) => trial(t.effort, t.reasoningTokens, t.ok)));
    assert.equal(r.disposition, artifact.disposition, 'computeDisposition must reproduce the artifact\'s OWN recorded disposition from its OWN recorded trials');
  });
});

describe('computeWorstCaseSpendUsd — bounded BEFORE any call', () => {
  it('scales linearly with fixture size', () => {
    const small = computeWorstCaseSpendUsd(10_000);
    const large = computeWorstCaseSpendUsd(100_000);
    assert.ok(large.inputUsd > small.inputUsd * 9, 'input cost should scale ~linearly with chars');
  });

  it('output cost is FIXED regardless of fixture size — bounded by max_tokens, not chars', () => {
    const a = computeWorstCaseSpendUsd(10_000);
    const b = computeWorstCaseSpendUsd(500_000);
    assert.equal(a.outputUsd, b.outputUsd,
      'output is bounded by TRIALS x MAX_OUTPUT_TOKENS x rate, independent of input size');
  });

  it('the PREFLIGHT_FIXTURE_MAX_CHARS ceiling stays under SPEND_CAP_USD at the documented pessimistic ratio', () => {
    const bound = computeWorstCaseSpendUsd(PREFLIGHT_FIXTURE_MAX_CHARS);
    assert.ok(bound.totalUsd <= SPEND_CAP_USD,
      `worst case at the fixture ceiling ($${bound.totalUsd.toFixed(2)}) must not exceed the spend cap ($${SPEND_CAP_USD}) — `
      + 'this is the invariant that makes --run\'s pre-call refusal reachable-but-never-needed under normal operation');
  });

  it('trials-per-effort and output-token constants are the ones actually used (regression on the derivation)', () => {
    // Pin the constants the $8 cap was derived FROM, so a change to either one
    // is forced through this test rather than silently invalidating the cap's
    // own justification comment.
    assert.equal(TRIALS_PER_EFFORT, 3);
    assert.equal(MAX_OUTPUT_TOKENS, 16_000);
  });
});

describe('buildFixture — the KD-8 redaction scan actually runs (audit-found gap, H4/H6)', () => {
  // `outPath` is ALWAYS an isolated temp path in these tests — never the
  // default FIXTURE_PATH. Without this (the exact bug the cluster audit
  // caught, H1/H2), every `npm test` run would atomically overwrite the real
  // `.audit/grok-preflight-fixture.json` — shared, production-facing scratch
  // state a real --run invocation depends on — with test data.
  const isolatedOutPath = (dir) => join(dir, 'fixture-under-test.json');

  it('a secret-shaped string in the source plan does NOT reach the written fixture', () => {
    // Reproduces the exact gap the cluster audit caught: buildFixture() called
    // buildReviewEnvelope() but never applied redactSecretsWithCount() before
    // writing the fixture to disk (which is then sent to xAI six times per
    // pre-flight run). Real detected shape (sk-ant-...), not a made-up marker.
    const dir = mkdtempSync(join(tmpdir(), 'grok-preflight-fixture-test-'));
    const secret = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const planPath = join(dir, 'plan.md');
    const transcriptPath = join(dir, 'transcript.json');
    writeFileSync(planPath, `# Plan\n\nleaked credential: ${secret}\n`);
    writeFileSync(transcriptPath, JSON.stringify({ rounds: [{ findings: [] }] }));

    const fixture = buildFixture({ transcriptPath, planPath, outPath: isolatedOutPath(dir) });
    assert.ok(!fixture.userPrompt.includes(secret), 'the secret must not survive into the written fixture');
    assert.ok(fixture.redactions >= 1, 'the redaction count must reflect that a match was found');
  });

  it('clean content (no secrets) reports zero redactions and is byte-unchanged', () => {
    const dir = mkdtempSync(join(tmpdir(), 'grok-preflight-fixture-test-'));
    const planPath = join(dir, 'plan.md');
    const transcriptPath = join(dir, 'transcript.json');
    writeFileSync(planPath, '# Plan\n\nnothing sensitive here.\n');
    writeFileSync(transcriptPath, JSON.stringify({ rounds: [{ findings: [] }] }));

    const fixture = buildFixture({ transcriptPath, planPath, outPath: isolatedOutPath(dir) });
    assert.equal(fixture.redactions, 0);
  });

  it('writes to the caller-supplied outPath, not the shared default FIXTURE_PATH', () => {
    const dir = mkdtempSync(join(tmpdir(), 'grok-preflight-fixture-test-'));
    const planPath = join(dir, 'plan.md');
    const transcriptPath = join(dir, 'transcript.json');
    writeFileSync(planPath, '# Plan\n');
    writeFileSync(transcriptPath, JSON.stringify({ rounds: [{ findings: [] }] }));
    const out = isolatedOutPath(dir);

    buildFixture({ transcriptPath, planPath, outPath: out });
    assert.ok(existsSync(out), 'must write to the supplied outPath');
  });
});

describe('run() — a second redaction pass at the actual egress point (audit-found gap, H3)', () => {
  it('re-scans the fixture read from disk before sending, not just what buildFixture wrote', () => {
    // run() is not exported (top-level orchestration doing real I/O + a
    // network call) and buildFixture() already has direct unit coverage for
    // redaction above — this pins the DEFENCE-IN-DEPTH property specifically:
    // the fixture is treated as untrusted at the point it is READ BACK,
    // because between a --build-fixture run and a --run invocation the file
    // on disk could have been hand-edited or restored from elsewhere.
    const src = readFileSync(new URL('../scripts/grok-effort-preflight.mjs', import.meta.url), 'utf-8');
    const fn = src.slice(src.indexOf('async function run()'));
    const body = fn.slice(0, fn.indexOf('\nasync function main'));
    assert.match(body, /redactSecretsWithCount\(fixture\.userPrompt\)/, 'run() must re-scan the fixture read from disk, not trust it as already-clean');
    assert.match(body, /fixture\.userPrompt = rescan\.text/, 'the re-scanned text must actually replace what gets sent — a scan whose result is discarded protects nothing');
  });
});

describe('callXai — bounded, never a hung trial (audit-found gap, M6)', () => {
  it('CALL_TIMEOUT_MS is a sane finite positive bound', () => {
    assert.ok(Number.isFinite(CALL_TIMEOUT_MS) && CALL_TIMEOUT_MS > 0);
    // Six sequential trials at this ceiling must stay well under typical CI
    // job timeouts even in the total-hang case — a sanity bound on the bound.
    assert.ok(CALL_TIMEOUT_MS * 6 < 15 * 60_000, 'six timed-out trials must not approach a 15-minute worst case');
  });

  it('the fetch call is wired to an AbortController, not left unbounded', () => {
    // callXai() is not exported (network-level, no fake-fetch harness here —
    // proportionate to a defensive timeout fix). Source-inspection, same
    // convention tests/shadow-gateway-provider.test.mjs already uses for
    // "does the emitted call carry the pin it claims to."
    const src = readFileSync(new URL('../scripts/grok-effort-preflight.mjs', import.meta.url), 'utf-8');
    const fn = src.slice(src.indexOf('async function callXai'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    assert.match(body, /new AbortController\(\)/, 'no AbortController constructed');
    assert.match(body, /signal:\s*controller\.signal/, 'fetch() call must pass the abort signal');
    assert.match(body, /setTimeout\(\(\) => controller\.abort\(\), timeoutMs\)/, 'no timer arms the abort');
    assert.match(body, /clearTimeout\(timer\)/, 'timer must be cleared — a leaked timer keeps the process alive after a fast response');
  });
});

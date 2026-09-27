/**
 * @fileoverview Tier 2 boundary tests for the final-review round cap and the
 * approved-with-debt close (field report 2026-09-26: 7 final-review reruns,
 * a CONCERNS_REMAINING verdict whose findings were all "not release-blocking",
 * closed only by user override).
 *
 * Deliberately imports ONLY modules that existed before the change, so every
 * test here runs — and fails — against the pre-fix tree:
 *   - the provider schema must REQUIRE the release-blocking pair (it had none);
 *   - `gemini-review.mjs --round 3` must be refused (it ignored the flag);
 *   - a round-2 run with `--prior` must suppress the settled round-1 finding
 *     and emit a code-computed `gateDisposition`;
 *   - `debt-auto-capture.mjs --final-review` must capture non-blocking
 *     findings through the existing debt write path (the flag did not exist).
 *
 * Spawns the REAL CLIs with `--provider fixture` (test-only, NODE_ENV=test)
 * and an empty AUDIT_DB_URL — no provider construction, no network, no store.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

import { GeminiFinalReviewSchema } from '../scripts/gemini-review.mjs';
import {
  GeminiFinalReviewJsonSchema, OpenAiFinalReviewJsonSchema, AnthropicReviewToolSchema,
} from '../scripts/lib/final-review/output-schemas.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const GEMINI_REVIEW = path.join(REPO_ROOT, 'scripts', 'gemini-review.mjs');
const DEBT_CAPTURE = path.join(REPO_ROOT, 'scripts', 'debt-auto-capture.mjs');

const env = () => ({
  ...process.env, NODE_ENV: 'test', AUDIT_DB_URL: '', GEMINI_API_KEY: '', ANTHROPIC_API_KEY: '',
});

function canned(findingOverrides = {}) {
  return {
    verdict: 'CONCERNS_REMAINING',
    deliberation_quality: { claude_bias_detected: false, gpt_false_positive_count: 0, deliberation_was_fair: true, quality_summary: 'ok' },
    new_findings: [{
      id: 'G1', severity: 'LOW', category: 'Naming', section: 'src/a.mjs:1', detail: 'd', risk: 'r',
      recommendation: 'rec', is_quick_fix: false, is_mechanical: false, is_reopened: false, principle: 'p',
      classification: { sonarType: 'CODE_SMELL', effort: 'EASY', sourceKind: 'REVIEWER', sourceName: 'x' },
      release_blocking: false, blocking_basis: 'none',
      ...findingOverrides,
    }],
    wrongly_dismissed: [], over_engineering_flags: [], architectural_coherence: 'Adequate', overall_reasoning: 'ok',
  };
}

describe('provider schema — the release-blocking pair is REQUIRED on every new finding', () => {
  it('accepts a finding carrying a legal pair', () => {
    const r = GeminiFinalReviewSchema.safeParse(canned());
    assert.equal(r.success, true, JSON.stringify(r.error?.issues));
  });
  it('rejects a finding without release_blocking / blocking_basis', () => {
    const c = canned();
    delete c.new_findings[0].release_blocking;
    delete c.new_findings[0].blocking_basis;
    assert.equal(GeminiFinalReviewSchema.safeParse(c).success, false);
  });
  it('rejects an off-enum blocking_basis', () => {
    assert.equal(GeminiFinalReviewSchema.safeParse(canned({ blocking_basis: 'style' })).success, false);
  });
  it('every provider dialect (Gemini, OpenAI-compatible, Anthropic tool) requires both fields', () => {
    const itemsOf = (s) => s.properties.new_findings.items;
    for (const [name, schema] of [['gemini', GeminiFinalReviewJsonSchema], ['openai', OpenAiFinalReviewJsonSchema], ['anthropic', AnthropicReviewToolSchema]]) {
      const items = itemsOf(schema);
      assert.ok(items.required.includes('release_blocking'), `${name}: release_blocking required`);
      assert.ok(items.required.includes('blocking_basis'), `${name}: blocking_basis required`);
      assert.deepEqual([...items.properties.blocking_basis.enum].sort(),
        ['acceptance_criterion', 'changed_code_regression', 'data_loss', 'none', 'runtime_failure', 'security'], name);
    }
    // And the emitted schema is what the Zod source says — asked of the emitted form.
    assert.ok(z.toJSONSchema(GeminiFinalReviewSchema).properties.new_findings.items.required.includes('release_blocking'));
  });
});

describe('gemini-review.mjs — the 2-round cap is enforced in code', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'final-review-round-cap-'));
    fs.writeFileSync(path.join(dir, 'plan.md'), '# plan\n');
    fs.writeFileSync(path.join(dir, 't.json'), JSON.stringify({ changed_files: ['src/a.mjs'], rounds: [], _fixtureVerdict: 'missed_candidate' }));
  });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* ignore */ } });

  const review = (extra) => spawnSync(process.execPath, [GEMINI_REVIEW, 'review', path.join(dir, 'plan.md'), path.join(dir, 't.json'), '--provider', 'fixture', ...extra], {
    cwd: REPO_ROOT, env: env(), encoding: 'utf-8',
  });

  it('refuses --round 3 with a non-zero exit naming the cap', () => {
    const r = review(['--round', '3', '--prior', path.join(dir, 'nope.json'), '--out', path.join(dir, 'r3.json')]);
    assert.notEqual(r.status, 0, `must refuse; stdout=${r.stdout}`);
    assert.match(r.stderr, /capped at 2 rounds/);
    assert.equal(fs.existsSync(path.join(dir, 'r3.json')), false, 'no result may be written for a refused round');
  });

  it('round 1 → round 2 with --prior: the settled finding is suppressed and the gate closes approve_with_debt', () => {
    const r1 = review(['--round', '1', '--out', path.join(dir, 'r1.json')]);
    assert.equal(r1.status, 0, r1.stderr);
    const res1 = JSON.parse(fs.readFileSync(path.join(dir, 'r1.json'), 'utf-8'));
    assert.equal(res1.new_findings.length, 1);
    assert.equal(res1.gateDisposition, 'approve_with_debt', 'CONCERNS + only non-blocking findings');
    assert.equal(res1.verdict, 'CONCERNS', 'verdict stays the reviewer\'s word');
    assert.match(r1.stdout, /Gate: approve_with_debt \(blocking 0, debt 1\) \| Round 1\/2/);

    const r2 = review(['--round', '2', '--prior', path.join(dir, 'r1.json'), '--out', path.join(dir, 'r2.json')]);
    assert.equal(r2.status, 0, r2.stderr);
    const res2 = JSON.parse(fs.readFileSync(path.join(dir, 'r2.json'), 'utf-8'));
    assert.equal(res2.new_findings.length, 0, 'the identical round-1 finding is settled, not re-raised');
    assert.equal(res2._priorSuppressedCount, 1);
    assert.equal(res2.finalReviewRound, 2);
  });

  it('a typo\'d cap flag is refused, never silently dropped into an uncapped review', () => {
    const r = review(['--rond', '3', '--out', path.join(dir, 'typo.json')]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /unknown flag "--rond"/);
    assert.equal(fs.existsSync(path.join(dir, 'typo.json')), false);
  });

  it('round 2 without --prior is refused (structured memory is the point of round 2)', () => {
    const r = review(['--round', '2', '--out', path.join(dir, 'r2.json')]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /requires --prior/);
  });
});

describe('debt-auto-capture.mjs --final-review — non-blocking findings become debt via the existing path', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'final-review-debt-'));
    fs.mkdirSync(path.join(dir, '.audit'));
  });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* ignore */ } });

  const capture = (args) => spawnSync(process.execPath, [DEBT_CAPTURE, ...args], { cwd: dir, env: env(), encoding: 'utf-8' });
  const detail = 'the parser tolerates a trailing comma it should reject, which is lenient but harmless here';
  function writeResult(findings) {
    const p = path.join(dir, '.audit', 'sid-gemini-result.json');
    fs.writeFileSync(p, JSON.stringify({ ...canned(), finalReviewRound: 2, new_findings: findings }));
    return p;
  }
  const nonBlocking = { ...canned().new_findings[0], id: 'G1', detail, _hash: 'aaaa1111', affectedFiles: ['src/a.mjs'] };
  const isBlocking = { ...nonBlocking, id: 'G2', release_blocking: true, blocking_basis: 'data_loss', _hash: 'bbbb2222', detail: 'drops the last row on flush' };

  it('dry-run lists the non-blocking finding and never the blocking one', () => {
    const r = capture(['--final-review', writeResult([nonBlocking, isBlocking]), '--dry-run']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /\[DRY RUN\] Would capture 1 deferred entries/);
    assert.match(r.stdout, /\[aaaa1111\]/);
    assert.doesNotMatch(r.stdout, /bbbb2222/);
    assert.match(r.stderr, /release-blocking.*G2/);
    assert.equal(fs.existsSync(path.join(dir, '.audit', 'tech-debt.json')), false, 'dry run writes nothing');
  });

  it('a real capture lands the non-blocking finding in .audit/tech-debt.json', () => {
    const r = capture(['--final-review', writeResult([nonBlocking, isBlocking]), '--run', 'sid-fr']);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    const ledger = JSON.parse(fs.readFileSync(path.join(dir, '.audit', 'tech-debt.json'), 'utf-8'));
    assert.deepEqual(ledger.entries.map((e) => e.topicId), ['aaaa1111']);
    assert.equal(ledger.entries[0].pass, 'final-review');
  });

  it('an unkeyable non-blocking finding is a PARTIAL capture (non-zero), never a silent drop', () => {
    const { _hash: _drop, ...unkeyed } = nonBlocking;
    const r = capture(['--final-review', writeResult([unkeyed])]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /PARTIAL CAPTURE/);
  });

  it('--ledger and --final-review are mutually exclusive', () => {
    const r = capture(['--final-review', writeResult([nonBlocking]), '--ledger', 'x.json']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /exactly one of --ledger/);
  });
});

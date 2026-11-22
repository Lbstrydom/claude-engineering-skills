/**
 * @fileoverview Fixes for the unverified leads from the verification-lessons
 * Cluster C audit (docs/plans/solo-control-leads-2026-11-22.md): spend identity,
 * the retry budget gate, the DeepSeek fingerprint pin, the store queries, the
 * retro's baseline completion, the not-final verdict, plus a pin for a lead that
 * was FALSE (stage-recall artifact names). Every fix has a case that fails on the
 * pre-fix code and a negative control for the direction it must NOT fire.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { budgetVerdict } from '../scripts/lib/solo-control/hardening-guards.mjs';
import { aggregateBudgetSpent, appendLedgerRow, computeSpendId, computeCallId, sharedPassCreditRows } from '../scripts/lib/solo-control/ledger.mjs';
import { fingerprintVerdict, retryBudgetVerdict } from '../scripts/lib/solo-control/cell-guards.mjs';
import { DISCOVER_COMMITS_SQL, EXTERNAL_FINDINGS_SQL, discoverCommits, fetchExternalFindings, partitionDiscoveredRows } from '../scripts/lib/solo-control/store-queries.mjs';
import { baselineReviewCompleted } from '../scripts/lib/solo-control/completion.mjs';
import { blockVerdictUnlessFinal } from '../scripts/lib/solo-control/run-guards.mjs';
import { artifactFileName } from '../scripts/lib/model-eval/stage-recall.mjs';
import { _internals } from '../scripts/solo-control-audit.mjs';

const row = (o) => ({ callId: 'c1', arm: 'S', sharedBy: null, commit: 'abc', repeat: 0, chunk: 0, pass: 'structure', purpose: 'pass', resolvedModel: 'm', recipient: 'anthropic', usage: { input_tokens: 1, output_tokens: 1 }, costUsd: 6, pricingVersion: 'v', state: 'ok', ...o });

describe('H4/H22 — a re-paid cell is additive in the budget (spendId)', () => {
  test('two paid calls under ONE callId with distinct spendIds both count: $12 >= $10 ceiling', () => {
    const v = budgetVerdict([row({ spendId: 'a' }), row({ spendId: 'b' })], 10);
    assert.equal(v?.reason, 'ceiling');
    assert.equal(v.spentUsd, 12);
    assert.equal(aggregateBudgetSpent([row({ spendId: 'a' }), row({ spendId: 'b' })]).spentUsd, 12);
  });
  test('negative control: legacy rows without a spendId still dedupe by callId (the documented limit), so $6 < $10', () => {
    assert.equal(budgetVerdict([row({}), row({})], 10), null);
    assert.equal(aggregateBudgetSpent([row({}), row({})]).spentUsd, 6);
  });
  test('negative control: a shared-pass credit copies the payer\'s spendId, so a shared call is still ONE spend', () => {
    const paid = row({ spendId: 'a', arm: 'B' });
    const credits = sharedPassCreditRows([paid], { commit: 'abc', baseArm: 'B', label: 'A+' });
    assert.equal(credits.length, 1);
    assert.equal(credits[0].spendId, 'a');
    assert.equal(budgetVerdict([paid, ...credits], 10), null, '$6 counted once, not $12');
  });
  test('control (R6 H1): a cell recorded ok/conformance-miss with null usage and null cost is UNMEASURED, never free; only a usage-less provider-error is free', () => {
    for (const state of ['ok', 'conformance-miss']) assert.equal(budgetVerdict([row({ costUsd: null, pricingVersion: null, usage: null, state, spendId: 'q' })], 100)?.reason, 'unmeasured');
    assert.equal(budgetVerdict([row({ costUsd: null, pricingVersion: null, usage: null, state: 'provider-error', spendId: 'q' })], 100), null);
  });
  test('a billed-but-unpriced first attempt stays unmeasured after a priced rerun (never read as zero)', () => {
    const v = budgetVerdict([row({ spendId: 'a', costUsd: null, pricingVersion: null }), row({ spendId: 'b', costUsd: 1 })], 100);
    assert.equal(v?.reason, 'unmeasured');
    assert.equal(v.unmeasured, 1);
  });
  test('spendId is unique per call, deterministic given a nonce, and survives the ledger schema', () => {
    const id = computeCallId({ commit: 'abc', purpose: 'pass', pass: 'structure', chunkIndex: 0, repeatIndex: 0, resolvedModel: 'm' });
    assert.notEqual(computeSpendId(id), computeSpendId(id));
    assert.equal(computeSpendId(id, 'n'), computeSpendId(id, 'n'));
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'spend-')), 'ledger.jsonl');
    appendLedgerRow(f, row({ spendId: computeSpendId(id, 'n') }));
    assert.equal(JSON.parse(fs.readFileSync(f, 'utf8').trim()).spendId, computeSpendId(id, 'n'), 'a schema that strips the field would silently restore the dedupe');
  });
});

describe('H5/M8 — the retry is a second paid call and is budget-checked', () => {
  const cost = (u) => ({ priced: true, totalUsd: u.input_tokens / 1000 }); // 1000 tokens = $1
  test('ledger $9.5 + first attempt $1 >= $10: stop before the retry', () => {
    const v = retryBudgetVerdict([row({ costUsd: 9.5, spendId: 'x' })], 10, { input_tokens: 1000, output_tokens: 0 }, 'm', cost);
    assert.equal(v?.reason, 'ceiling');
  });
  test('an unpriced first attempt that returned usage makes the retry UNCHECKABLE, not free', () => {
    const v = retryBudgetVerdict([], 10, { input_tokens: 1, output_tokens: 1 }, 'm', () => ({ priced: false }));
    assert.equal(v?.reason, 'unmeasured');
  });
  test('negative controls: room left, or the first attempt returned nothing → the retry may go', () => {
    assert.equal(retryBudgetVerdict([row({ costUsd: 1, spendId: 'x' })], 10, { input_tokens: 1000, output_tokens: 0 }, 'm', cost), null);
    assert.equal(retryBudgetVerdict([row({ costUsd: 1, spendId: 'x' })], 10, null, 'm', cost), null);
  });
  test('a reply that came back with NO usage is billed-but-unpriced: the retry is unmeasured, not free', () => {
    assert.equal(retryBudgetVerdict([], 10, null, 'm', () => null, { replyWithoutUsage: true })?.reason, 'unmeasured');
    // even a costFn that would price an empty usage at $0 must not be asked
    assert.equal(retryBudgetVerdict([], 10, null, 'm', () => ({ priced: true, totalUsd: 0 }), { replyWithoutUsage: true })?.reason, 'unmeasured');
  });

  const nonconforming = () => ({ content: [{ text: 'not json at all' }], usage: { input_tokens: 10, output_tokens: 5 } });
  test('runPass: a nonconforming first reply + a breached gate → ONE call, unmeasured (providerError), usage kept', async () => {
    let calls = 0;
    const client = { messages: { create: async () => { calls++; return nonconforming(); } } };
    const r = await _internals.runPass(client, 'm', _internals.PASSES[0], 'diff', { beforeRetry: () => ({ reason: 'ceiling' }) });
    assert.equal(calls, 1);
    assert.equal(r.budgetStop, true);
    assert.equal(r.providerError, true);
    assert.equal(r.conformanceMiss, undefined, 'never scored against the model');
    assert.deepEqual(r.usage, { input_tokens: 10, output_tokens: 5 });
    assert.equal(r.replyWithoutUsage, false);
  });
  test('runPass: a nonconforming reply with NO usage + a breached gate flags replyWithoutUsage so the row is recorded unmeasured', async () => {
    const client = { messages: { create: async () => ({ content: [{ text: 'not json' }] }) } };
    const r = await _internals.runPass(client, 'm', _internals.PASSES[0], 'diff', { beforeRetry: (u, noUsage) => (noUsage ? { reason: 'unmeasured' } : null) });
    assert.equal(r.budgetStop, true);
    assert.equal(r.replyWithoutUsage, true);
    assert.equal(r.usage, null);
  });
  test('the budget reads a usage-less budget-stop row as UNMEASURED (usage {} + null cost), not free', () => {
    assert.equal(budgetVerdict([row({ costUsd: null, pricingVersion: null, usage: {}, state: 'provider-error', spendId: 'z' })], 100)?.reason, 'unmeasured');
    assert.equal(budgetVerdict([row({ costUsd: null, pricingVersion: null, usage: null, state: 'provider-error', spendId: 'z' })], 100), null, 'control: nothing came back stays free');
  });
  test('runPass negative control: no gate (or a clear gate) → the retry runs, two calls, conformance miss', async () => {
    for (const beforeRetry of [null, () => null]) {
      let calls = 0;
      const client = { messages: { create: async () => { calls++; return nonconforming(); } } };
      const r = await _internals.runPass(client, 'm', _internals.PASSES[0], 'diff', { beforeRetry });
      assert.equal(calls, 2);
      assert.equal(r.conformanceMiss, true);
      assert.deepEqual(r.usage, { input_tokens: 20, output_tokens: 10 }, 'both attempts billed in the recorded row (H5\'s "unrecorded" claim is false)');
    }
  });
  test('partial usage ({prompt_tokens} only) is UNMEASURED (null), not a low price with output 0', async () => {
    const ok = JSON.stringify({ findings: [], summary: 's' });
    for (const [usage, expectNull] of [[{ prompt_tokens: 1000 }, true], [{ prompt_tokens: 1000, completion_tokens: 5 }, false]]) {
      const client = { chat: { completions: { create: async () => ({ choices: [{ message: { content: ok } }], usage, system_fingerprint: 'fp' }) } } };
      const r = await _internals.runDeepseekPass(client, 'deepseek-flash', _internals.PASSES[0], 'diff');
      assert.equal(r.usage === null, expectNull);
    }
  });
  test('G2 pin: a two-attempt pass whose SECOND reply omits usage is unmeasured (usage null), not half-priced', async () => {
    let n = 0;
    const client = { messages: { create: async () => (++n === 1 ? { content: [{ text: 'nope' }], usage: { input_tokens: 10, output_tokens: 5 } } : { content: [{ text: 'nope again' }] }) } };
    const r = await _internals.runPass(client, 'm', _internals.PASSES[0], 'diff');
    assert.equal(n, 2);
    assert.equal(r.usage, null);
  });
  test('runDeepseekPass: same gate, and the fingerprint seen so far rides along', async () => {
    let calls = 0;
    const client = { chat: { completions: { create: async () => { calls++; return { choices: [{ message: { content: 'nope' } }], usage: { prompt_tokens: 7, completion_tokens: 3 }, system_fingerprint: 'fp1' }; } } } };
    const r = await _internals.runDeepseekPass(client, 'deepseek-flash', _internals.PASSES[0], 'diff', { beforeRetry: () => ({ reason: 'ceiling' }) });
    assert.equal(calls, 1);
    assert.equal(r.budgetStop, true);
    assert.equal(r.systemFingerprint, 'fp1');
  });
});

describe('M1 — a DeepSeek reply without a fingerprint cannot pass the pin', () => {
  test('missing beside a pin, and missing with no pin yet, are both refused', () => {
    assert.deepEqual(fingerprintVerdict({ recipient: 'deepseek', pinned: 'fp1', got: undefined }), { pin: 'fp1', refuse: 'missing' });
    assert.deepEqual(fingerprintVerdict({ recipient: 'deepseek', pinned: null, got: null }), { pin: null, refuse: 'missing' });
  });
  test('drift is refused; the first fingerprint seeds the pin; a match passes', () => {
    assert.equal(fingerprintVerdict({ recipient: 'deepseek', pinned: 'fp1', got: 'fp2' }).refuse, 'drift');
    assert.deepEqual(fingerprintVerdict({ recipient: 'deepseek', pinned: null, got: 'fp1' }), { pin: 'fp1', refuse: null });
    assert.equal(fingerprintVerdict({ recipient: 'deepseek', pinned: 'fp1', got: 'fp1' }).refuse, null);
  });
  test('negative control: anthropic carries no fingerprint by design and is never refused', () => {
    assert.equal(fingerprintVerdict({ recipient: 'anthropic', pinned: null, got: undefined }).refuse, null);
  });
});

describe('H9/H12 — store queries', () => {
  test('H9: the external-findings pick among re-audits has a total order (newest run, then run id, then fingerprint)', () => {
    const order = /ORDER BY([\s\S]*)$/.exec(EXTERNAL_FINDINGS_SQL)[1];
    assert.match(order, /v\.commit_sha, v\.arm, v\.canonical_id,\s*ar\.created_at DESC,\s*v\.run_id DESC,\s*v\.finding_fingerprint/);
  });
  test('H12: discovery no longer drops rows with neither audited_sha nor audited_tree; they are COUNTED as unresolved', async () => {
    assert.doesNotMatch(DISCOVER_COMMITS_SQL, /IS NOT NULL/);
    const rows = [
      { id: 1, commit_sha: 'a', audited_sha: null, audited_tree: null },
      { id: 2, commit_sha: 'b', audited_sha: 's', audited_tree: null },
      { id: 3, commit_sha: 'c', audited_sha: 's', audited_tree: 't' },
    ];
    const r = await discoverCommits('audit-code', { query: async () => ({ rows }) });
    assert.equal(r.unresolvedIncompleteIdentityCount, 2);
    assert.deepEqual(r.resolved, [{ commitSha: 'c', auditedSha: 's', auditedTree: 't' }]);
  });
  test('negative control: complete rows dedupe on the (sha, tree) pair, as before', () => {
    const r = partitionDiscoveredRows([{ commit_sha: 'a', audited_sha: 's', audited_tree: 't' }, { commit_sha: 'a', audited_sha: 's', audited_tree: 't' }, { commit_sha: 'a', audited_sha: 's', audited_tree: 'u' }]);
    assert.equal(r.resolved.length, 2);
    assert.equal(r.unresolvedIncompleteIdentityCount, 0);
  });
  test('fetchExternalFindings passes (stage, commits) and returns the rows', async () => {
    let seen;
    const out = await fetchExternalFindings(['a'], 'audit-code', { query: async (sql, p) => { seen = p; return { rows: [{ x: 1 }] }; } });
    assert.deepEqual(seen, ['audit-code', ['a']]);
    assert.deepEqual(out, [{ x: 1 }]);
  });
});

describe('M10 — a baseline counts only when its review COMPLETED', () => {
  const run = (perCommit) => ({ perCommit });
  test('findings with a provider-error latest state is NOT a completed baseline', () => {
    assert.deepEqual(baselineReviewCompleted(run([{ sha: 's', state: 'provider-error' }]), 's'), { completed: false, state: 'provider-error' });
  });
  test('no entry reads as not completed; a later `ran` supersedes an earlier failure (resume appends)', () => {
    assert.equal(baselineReviewCompleted(run([]), 's').completed, false);
    assert.equal(baselineReviewCompleted(null, 's').completed, false);
    assert.equal(baselineReviewCompleted(run([{ sha: 's', state: 'provider-error' }, { sha: 's', state: 'ran' }]), 's').completed, true);
  });
  test('negative control: a different commit\'s `ran` does not complete this one', () => {
    assert.equal(baselineReviewCompleted(run([{ sha: 'other', state: 'ran' }]), 's').completed, false);
  });
});

describe('M5 — a decision over incomplete labels cannot read as a verdict', () => {
  test('non-final status is folded into verdictBlocked, keeping an existing block', () => {
    assert.match(blockVerdictUnlessFinal(null, 'directional-only'), /NOT FINAL/);
    const both = blockVerdictUnlessFinal('INCOMPLETE — 20% partial', 'directional-only');
    assert.match(both, /^INCOMPLETE — 20% partial; NOT FINAL/);
  });
  test('negative control: a final decision is left exactly as it was', () => {
    assert.equal(blockVerdictUnlessFinal(null, 'final'), null);
    assert.equal(blockVerdictUnlessFinal('INCOMPLETE', 'final'), 'INCOMPLETE');
  });
});

describe('H7 (FALSE lead, pinned) — stage-capture artifact names cannot collide', () => {
  test('run/1 and run_1 (and entry/stage variants) hash to different files', () => {
    const a = artifactFileName({ runId: 'run/1', entryId: 'KD-1', stage: 'final' });
    const b = artifactFileName({ runId: 'run_1', entryId: 'KD-1', stage: 'final' });
    assert.notEqual(a, b);
    assert.match(a, /^[0-9a-f]{64}\.json$/);
    assert.equal(a, artifactFileName({ runId: 'run/1', entryId: 'KD-1', stage: 'final' }), 'deterministic');
  });
});

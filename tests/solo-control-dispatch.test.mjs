import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { classifyRecipient, RECIPIENTS } from '../scripts/lib/solo-control/recipient.mjs';
import { loadRecipientPolicy, assertRecipientAllowed, resolveAndAuthorize, validateCorpusAgainstPolicy } from '../scripts/lib/solo-control/policy.mjs';
import { loadCorpus } from '../scripts/lib/solo-control/corpus.mjs';
import { z } from 'zod';
import { computeCallId, appendLedgerRow, readLedger, aggregateCostForArm, aggregateBudgetSpent, sharedPassCreditRows } from '../scripts/lib/solo-control/ledger.mjs';
import { commitArmCompletion, commitsCompleteForAllArms } from '../scripts/lib/solo-control/completion.mjs';
import { _internals as soloCtl } from '../scripts/solo-control-audit.mjs';

// ── recipient classification ────────────────────────────────────────────────

test('classifyRecipient: dispatches every resolved id this experiment actually uses', () => {
  assert.equal(classifyRecipient('claude-sonnet-5'), 'anthropic');
  assert.equal(classifyRecipient('claude-opus-5'), 'anthropic');
  assert.equal(classifyRecipient('gpt-6-astra'), 'openai');
  assert.equal(classifyRecipient('gemini-pro-latest'), 'gemini');
  assert.equal(classifyRecipient('gemini-flash-latest'), 'gemini');
  assert.equal(classifyRecipient('deepseek-flash'), 'deepseek'); // the exp-5 challenger, direct
  assert.equal(classifyRecipient('qwen/qwen3.8-max'), 'openrouter'); // a '/' slug is OpenRouter regardless of upstream vendor
});

test('classifyRecipient: a deepseek id reached via an OpenRouter slug is recipient "openrouter", not "deepseek" (recipient != vendor)', () => {
  // The whole point of the recipient/vendor distinction (plan §2): the SAME
  // upstream model reached two different ways is two different recipients.
  assert.equal(classifyRecipient('deepseek/deepseek-chat-v3.1'), 'openrouter');
});

test('classifyRecipient: an unrecognised id throws rather than silently defaulting to a recipient', () => {
  // A silent default here would be a silent egress-policy bypass — this
  // must fail loudly, not guess.
  assert.throws(() => classifyRecipient('mystery-model-9000'), /cannot classify/);
  assert.throws(() => classifyRecipient(''), /non-empty string/);
});

test('RECIPIENTS includes every value this experiment\'s policy file names', () => {
  for (const r of ['anthropic', 'openai', 'gemini', 'openrouter', 'deepseek', 'alibaba', 'xai']) assert.ok(RECIPIENTS.includes(r), r);
});

// ── policy: fail-closed authorization ───────────────────────────────────────

function withTempFile(content, fn) {
  const p = path.join(os.tmpdir(), `exp5-test-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, content);
  try { return fn(p); } finally { fs.rmSync(p, { force: true, recursive: true, maxRetries: 3, retryDelay: 50 }); }
}

test('assertRecipientAllowed: a repo absent from the policy is refused (absence means refuse)', () => {
  const policy = { repos: { 'github.com/x/known': ['anthropic'] } };
  assert.throws(() => assertRecipientAllowed(policy, 'github.com/x/unknown', 'anthropic'), /REFUSED.*no entry/);
});

test('assertRecipientAllowed: a recipient not listed for a known repo is refused', () => {
  const policy = { repos: { 'github.com/x/known': ['anthropic'] } };
  assert.throws(() => assertRecipientAllowed(policy, 'github.com/x/known', 'openrouter'), /REFUSED.*does not permit/);
  assert.doesNotThrow(() => assertRecipientAllowed(policy, 'github.com/x/known', 'anthropic'));
});

test('loadRecipientPolicy: refuses a repo entry with an EMPTY recipient list (absence must be a missing key, not an empty array)', () => {
  withTempFile(JSON.stringify({ repos: { 'github.com/x/y': [] } }), (p) => {
    assert.throws(() => loadRecipientPolicy(p), /missing or empty recipient list/);
  });
});

test('loadRecipientPolicy: refuses an unknown recipient name rather than loading it', () => {
  withTempFile(JSON.stringify({ repos: { 'github.com/x/y': ['anthropic', 'not-a-real-recipient'] } }), (p) => {
    assert.throws(() => loadRecipientPolicy(p), /unknown recipient/);
  });
});

test('resolveAndAuthorize: throws BEFORE any client would be constructed, for a refused (repo, recipient) pair', () => {
  // The ordering guarantee: this function does no I/O, so a caller that
  // gates every client construction behind it can never construct a
  // client for a refused pair — proven here by a counting stub that a
  // correctly-ordered call site would never reach.
  const policy = { repos: { 'github.com/x/wine': ['anthropic'] } };
  let constructed = 0;
  const constructClient = () => { constructed++; return {}; };
  assert.throws(() => {
    resolveAndAuthorize({ model: 'qwen/qwen3.8-max', repoIdentity: 'github.com/x/wine', policy });
    constructClient(); // unreachable if the gate above throws, as it must here
  }, /REFUSED/);
  assert.equal(constructed, 0, 'the client constructor must never run for a refused pair');
});

test('resolveAndAuthorize: returns the classified recipient for an allowed pair, and DOES let construction proceed', () => {
  const policy = { repos: { 'github.com/x/wine': ['anthropic', 'deepseek'] } };
  let constructed = 0;
  const recipient = resolveAndAuthorize({ model: 'deepseek-flash', repoIdentity: 'github.com/x/wine', policy });
  constructed++;
  assert.equal(recipient, 'deepseek');
  assert.equal(constructed, 1);
});

// ── corpus: strict schema + policy cross-check ──────────────────────────────

test('loadCorpus: the REAL committed corpus + policy validate cleanly (not a hand-written fixture that could drift from reality)', () => {
  const policy = loadRecipientPolicy('docs/experiments/audit-effectiveness/recipient-policy.json');
  const corpus = loadCorpus('docs/experiments/audit-effectiveness/experiment-5-corpus.json', policy);
  assert.equal(corpus.entries.length, 35);
  for (const e of corpus.entries) assert.ok(e.allowedTransports.length > 0, `${e.id} must carry allowedTransports`);
});

test('loadCorpus: refuses an entry with an EMPTY allowedTransports array', () => {
  const policy = { repos: { 'github.com/x/y': ['anthropic'] } };
  withTempFile(JSON.stringify({ version: 1, entries: [{ id: 'E1', repo: 'y', repoIdentity: 'github.com/x/y', sha: 'a'.repeat(40), source: 'draw', stratum: { size: 'S', kind: 'backend' }, allowedTransports: [] }] }), (p) => {
    assert.throws(() => loadCorpus(p, policy), /allowedTransports must be non-empty/);
  });
});

test('loadCorpus: refuses an entry whose allowedTransports claims a recipient the policy does not grant that repo', () => {
  const policy = { repos: { 'github.com/x/y': ['anthropic'] } }; // policy grants anthropic ONLY
  withTempFile(JSON.stringify({ version: 1, entries: [{ id: 'E1', repo: 'y', repoIdentity: 'github.com/x/y', sha: 'a'.repeat(40), source: 'draw', stratum: { size: 'S', kind: 'backend' }, allowedTransports: ['anthropic', 'openrouter'] }] }), (p) => {
    assert.throws(() => loadCorpus(p, policy), /openrouter.*not permitted/);
  });
});

test('validateCorpusAgainstPolicy: reports EVERY violation in one pass, not just the first', () => {
  const policy = { repos: { 'github.com/x/y': ['anthropic'] } };
  const corpus = { entries: [
    { id: 'E1', repoIdentity: 'github.com/x/y', allowedTransports: ['openrouter'] },
    { id: 'E2', repoIdentity: 'github.com/x/y', allowedTransports: ['deepseek'] },
  ] };
  const violations = validateCorpusAgainstPolicy(corpus, policy);
  assert.equal(violations.length, 2);
  assert.deepEqual(violations.map((v) => v.id), ['E1', 'E2']);
});

// ── call ledger: callId determinism + the two aggregation predicates ───────

test('computeCallId: deterministic — identical cell identity always produces the identical id', () => {
  const args = { commit: 'abc123', purpose: 'pass', pass: 'structure', chunkIndex: 0, repeatIndex: 0, resolvedModel: 'deepseek-flash' };
  assert.equal(computeCallId(args), computeCallId({ ...args }));
});

test('computeCallId: any single differing field changes the id (no accidental collisions)', () => {
  const base = { commit: 'abc123', purpose: 'pass', pass: 'structure', chunkIndex: 0, repeatIndex: 0, resolvedModel: 'deepseek-flash' };
  const id0 = computeCallId(base);
  assert.notEqual(computeCallId({ ...base, chunkIndex: 1 }), id0, 'chunkIndex must matter');
  assert.notEqual(computeCallId({ ...base, repeatIndex: 1 }), id0, 'repeatIndex must matter — this is what makes an xN repeat a distinct cell');
  assert.notEqual(computeCallId({ ...base, pass: 'wiring' }), id0, 'pass must matter');
  assert.notEqual(computeCallId({ ...base, resolvedModel: 'deepseek-v4-pro' }), id0, 'resolvedModel must matter — this is the fingerprint-pin\'s partner: two different served models must never collapse to one callId');
});

test('computeCallId: rejects a non-integer or negative chunkIndex/repeatIndex rather than hashing garbage', () => {
  const base = { commit: 'abc123', purpose: 'pass', pass: 'structure', chunkIndex: 0, repeatIndex: 0, resolvedModel: 'x' };
  assert.throws(() => computeCallId({ ...base, chunkIndex: -1 }), /non-negative integer/);
  assert.throws(() => computeCallId({ ...base, repeatIndex: 1.5 }), /non-negative integer/);
});

function withTempLedger(fn) {
  const p = path.join(os.tmpdir(), `exp5-ledger-${process.pid}-${Math.random().toString(36).slice(2)}.jsonl`);
  try { return fn(p); } finally { fs.rmSync(p, { force: true, recursive: true, maxRetries: 3, retryDelay: 50 }); }
}

test('ledger: appendLedgerRow + readLedger round-trips, and rejects a row missing a required field', () => {
  withTempLedger((p) => {
    const row = { callId: 'c1', arm: 'E', sharedBy: null, commit: 'abc', repeat: 0, chunk: 0, pass: 'structure', purpose: 'pass', resolvedModel: 'deepseek-flash', recipient: 'deepseek', usage: { input_tokens: 10 }, costUsd: 0.01, pricingVersion: '2026-09-21', state: 'ok' };
    appendLedgerRow(p, row);
    const rows = readLedger(p);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].callId, 'c1');
    assert.throws(() => appendLedgerRow(p, { ...row, callId: undefined }), /callId/);
  });
});

test('ledger: purpose "retry" is a valid, distinct row — not conflated with "pass"', () => {
  withTempLedger((p) => {
    appendLedgerRow(p, { callId: 'c1', arm: 'E', sharedBy: null, commit: 'abc', repeat: 0, chunk: 0, pass: 'structure', purpose: 'pass', resolvedModel: 'deepseek-flash', recipient: 'deepseek', usage: null, costUsd: null, pricingVersion: null, state: 'provider-error' });
    appendLedgerRow(p, { callId: 'c1', arm: 'E', sharedBy: null, commit: 'abc', repeat: 0, chunk: 0, pass: 'structure', purpose: 'retry', resolvedModel: 'deepseek-flash', recipient: 'deepseek', usage: { input_tokens: 5 }, costUsd: 0.005, pricingVersion: '2026-09-21', state: 'ok' });
    const rows = readLedger(p);
    assert.deepEqual(rows.map((r) => r.purpose), ['pass', 'retry']);
  });
});

test('readLedger: a missing ledger file reads as empty, not an error (an experiment that has not spent yet is not a failure)', () => {
  const rows = readLedger(path.join(os.tmpdir(), `exp5-nonexistent-${Math.random()}.jsonl`));
  assert.deepEqual(rows, []);
});

test('aggregateCostForArm: a SHARED row (sharedBy) is credited to BOTH configurations that share it', () => {
  // This is the exact bug Gemini R2-G4 caught: A+'s five-pass compute is
  // shared with A, so filtering strictly on row.arm === arm would make A+
  // appear to cost only its gate call.
  const rows = [
    { callId: 'shared-1', arm: 'A', sharedBy: ['A', 'A+'], costUsd: 0.50 }, // one shared 5-pass call
    { callId: 'gate-a', arm: 'A', sharedBy: null, costUsd: 0.10 },          // A's own Flash gate call
    { callId: 'gate-aplus', arm: 'A+', sharedBy: null, costUsd: 0.20 },     // A+'s own Pro gate call
  ];
  const a = aggregateCostForArm(rows, 'A');
  const aPlus = aggregateCostForArm(rows, 'A+');
  assert.deepEqual(a, { costUsd: 0.60, complete: true });      // 0.50 (shared) + 0.10 (own)
  assert.deepEqual(aPlus, { costUsd: 0.70, complete: true });  // 0.50 (shared) + 0.20 (own) — the shared row counted AGAIN
});

test('aggregateBudgetSpent: the SAME shared row is counted ONCE across the whole run, by unique callId', () => {
  // The deliberate asymmetry with aggregateCostForArm above: per-arm scoring
  // must double-count a shared call (each arm's $/diff includes it), but the
  // run's overall spend must not — that would double the true budget burn.
  const rows = [
    { callId: 'shared-1', arm: 'A', sharedBy: ['A', 'A+'], costUsd: 0.50 },
    { callId: 'shared-1', arm: 'A+', sharedBy: ['A', 'A+'], costUsd: 0.50 }, // same call, written once per sharing arm
    { callId: 'gate-a', arm: 'A', sharedBy: null, costUsd: 0.10 },
    { callId: 'gate-aplus', arm: 'A+', sharedBy: null, costUsd: 0.20 },
  ];
  const budget = aggregateBudgetSpent(rows);
  assert.deepEqual(budget, { spentUsd: 0.80, complete: true }); // 0.50 (once) + 0.10 + 0.20, NOT 0.50+0.50+0.10+0.20
});

test('aggregateCostForArm: any unpriced contributing row makes the aggregate null/incomplete — never a partial sum read as the true cost', () => {
  const rows = [{ callId: 'e0', arm: 'E', sharedBy: null, costUsd: 0.10 }, { callId: 'e1', arm: 'E', sharedBy: null, costUsd: null }];
  assert.deepEqual(aggregateCostForArm(rows, 'E'), { costUsd: null, complete: false });
});

test('aggregateCostForArm: a re-run cell (same callId, later row) SUPERSEDES its earlier row — never billed twice, and an earlier unpriced attempt never poisons the arm', () => {
  // The ledger is append-only and callId is deterministic over the cell, so a
  // resumed/re-run cell is a second row under the same id. Measured 2026-09-21:
  // two conformance-miss rows (usage null => costUsd null) from a broken first
  // launch would otherwise have kept the whole arm's cost `unknown` forever.
  const rows = [
    { callId: 'e0', arm: 'E', sharedBy: null, costUsd: null },  // first launch: unpriced miss
    { callId: 'e1', arm: 'E', sharedBy: null, costUsd: 0.10 },
    { callId: 'e0', arm: 'E', sharedBy: null, costUsd: 0.05 },  // re-run of the SAME cell, priced
    { callId: 'e1', arm: 'E', sharedBy: null, costUsd: 0.10 },  // re-run of e1 too — must not double to 0.20
  ];
  assert.deepEqual(aggregateCostForArm(rows, 'E'), { costUsd: 0.15, complete: true });
  // Same rule completion.mjs applies (last row wins per callId) — the two
  // readers must not disagree about which row IS the cell.
  assert.equal(commitArmCompletion(rows.map((r) => ({ ...r, commit: 'c', state: r.costUsd == null ? 'provider-error' : 'ok' })), { arm: 'E', commit: 'c', expectedCellCount: 2 }), 'complete');
});

test('aggregateCostForArm: an arm with zero contributing rows is null/incomplete, not a fabricated $0', () => {
  assert.deepEqual(aggregateCostForArm([{ callId: 'o0', arm: 'OTHER', sharedBy: null, costUsd: 1 }], 'E'), { costUsd: null, complete: false });
});

// ── completion states ────────────────────────────────────────────────────────

test('commitArmCompletion: complete only when every expected cell landed on ok/conformance-miss', () => {
  const rows = [
    { callId: 'c0', arm: 'E', sharedBy: null, commit: 'abc', state: 'ok' },
    { callId: 'c1', arm: 'E', sharedBy: null, commit: 'abc', state: 'conformance-miss' },
  ];
  assert.equal(commitArmCompletion(rows, { arm: 'E', commit: 'abc', expectedCellCount: 2 }), 'complete');
});

test('commitArmCompletion: fewer recorded cells than expected is partial, never complete-by-omission', () => {
  const rows = [{ callId: 'c0', arm: 'E', sharedBy: null, commit: 'abc', state: 'ok' }];
  assert.equal(commitArmCompletion(rows, { arm: 'E', commit: 'abc', expectedCellCount: 2 }), 'partial');
});

test('commitArmCompletion: a provider-error cell makes the whole commit partial for that arm', () => {
  const rows = [
    { callId: 'c0', arm: 'E', sharedBy: null, commit: 'abc', state: 'ok' },
    { callId: 'c1', arm: 'E', sharedBy: null, commit: 'abc', state: 'provider-error' },
  ];
  assert.equal(commitArmCompletion(rows, { arm: 'E', commit: 'abc', expectedCellCount: 2 }), 'partial');
});

test('commitArmCompletion: an excluded cell (transport not allowed) is its own state, distinct from a failure', () => {
  const rows = [{ callId: 'c0', arm: 'E', sharedBy: null, commit: 'abc', state: 'excluded' }];
  assert.equal(commitArmCompletion(rows, { arm: 'E', commit: 'abc', expectedCellCount: 1 }), 'excluded');
});

test('commitArmCompletion: a retry SUPERSEDES its own cell\'s earlier attempt — it does not count as a second cell', () => {
  const rows = [
    { callId: 'c0', arm: 'E', sharedBy: null, commit: 'abc', state: 'provider-error' }, // first attempt
    { callId: 'c0', arm: 'E', sharedBy: null, commit: 'abc', state: 'ok' },             // retry of the SAME callId, later in the file
  ];
  // Only 1 distinct callId, so expectedCellCount:1 and the LAST row for that
  // id (ok) is what decides the state — not partial.
  assert.equal(commitArmCompletion(rows, { arm: 'E', commit: 'abc', expectedCellCount: 1 }), 'complete');
});

test('commitArmCompletion: rejects a non-positive expectedCellCount rather than silently treating 0 cells as complete', () => {
  assert.throws(() => commitArmCompletion([], { arm: 'E', commit: 'abc', expectedCellCount: 0 }), /positive integer/);
});

test('commitsCompleteForAllArms: a commit partial for ANY one arm is dropped from EVERY arm in the cohort (never a lopsided comparison)', () => {
  const rows = [
    { callId: 'a0', arm: 'A', sharedBy: null, commit: 'c1', state: 'ok' },
    { callId: 'e0', arm: 'E', sharedBy: null, commit: 'c1', state: 'provider-error' }, // E failed on c1
    { callId: 'a1', arm: 'A', sharedBy: null, commit: 'c2', state: 'ok' },
    { callId: 'e1', arm: 'E', sharedBy: null, commit: 'c2', state: 'ok' },
  ];
  const { kept, dropped } = commitsCompleteForAllArms(rows, ['A', 'E'], ['c1', 'c2'], () => 1);
  assert.deepEqual(kept, ['c2']);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].commit, 'c1');
  // c1 is dropped for BOTH arms even though A itself completed fine on c1 —
  // that is the whole point: A vs E on c1 alone would be comparing E's
  // failure against nothing, which is not a comparison.
});

// ── cmdRun/cmdApparatus internals (scripts/solo-control-audit.mjs) ─────────

// unit() mirrors cmdRun's own manual-mode shape ({mode, resumeKey, commitSha,
// auditedSha:null, auditedTree:null}) — a manual unit's resumeKey IS its sha.
function unit(sha) { return { mode: 'manual', resumeKey: sha, commitSha: sha, auditedSha: null, auditedTree: null }; }

test('planIncrementalRun: with no prior file, every requested unit is scheduled', () => {
  const { commits, covered } = soloCtl.planIncrementalRun({ units: [unit('a'), unit('b')], prior: null, force: false, resume: false });
  assert.deepEqual(commits, [unit('a'), unit('b')]);
  assert.equal(covered.size, 0);
});

test('planIncrementalRun: a unit already recorded state:"ran" (by unitKey) is skipped on the next incremental run', () => {
  const prior = { perCommit: [{ sha: 'a', unitKey: 'a', state: 'ran' }, { sha: 'b', unitKey: 'b', state: 'not-found' }] };
  const { commits, covered } = soloCtl.planIncrementalRun({ units: [unit('a'), unit('b'), unit('c')], prior, force: false, resume: false });
  // 'b' was attempted but never completed (state != 'ran') — it must be
  // RETRIED, not treated as permanently skipped, or a transient failure
  // (diff-too-large threshold change, a fixed egress false-positive) could
  // never be recovered by re-running.
  assert.deepEqual(commits.map((u) => u.resumeKey), ['b', 'c']);
  assert.deepEqual([...covered], ['a']);
});

test('planIncrementalRun: a prior perCommit entry with no unitKey (written before that field existed) still resumes via its legacy .sha', () => {
  // The off-by-N fix (origin PR #110) introduced unitKey; S-findings files
  // written before it exist only with the bare .sha field. The fallback
  // `c.unitKey || c.sha` is what keeps those old files resuming correctly
  // rather than re-running everything once.
  const prior = { perCommit: [{ sha: 'a', state: 'ran' }] }; // legacy shape, no unitKey
  const { commits } = soloCtl.planIncrementalRun({ units: [unit('a'), unit('b')], prior, force: false, resume: false });
  assert.deepEqual(commits.map((u) => u.resumeKey), ['b']);
});

test('planIncrementalRun: --force ignores prior coverage entirely, even for a completed unit', () => {
  const prior = { perCommit: [{ sha: 'a', unitKey: 'a', state: 'ran' }] };
  const { commits, covered } = soloCtl.planIncrementalRun({ units: [unit('a')], prior, force: true, resume: false });
  assert.deepEqual(commits, [unit('a')]);
  assert.equal(covered.size, 0);
});

test('planIncrementalRun: --force and --resume together is a contradiction (start over vs continue) and must throw, not silently pick one', () => {
  assert.throws(() => soloCtl.planIncrementalRun({ units: [unit('a')], prior: null, force: true, resume: true }), /mutually exclusive/);
});

test('buildColdPassPrompt: the fairness contract — deterministic and byte-identical for the same (passName, diff)', () => {
  // This is what makes runPass (anthropic) and runDeepseekPass (deepseek)
  // send byte-equal text: both call this ONE function rather than building
  // their own copy, so equality is structural, not a maintained coincidence.
  const a = soloCtl.buildColdPassPrompt('structure', 'diff --git a/x b/x\n+foo();\n');
  const b = soloCtl.buildColdPassPrompt('structure', 'diff --git a/x b/x\n+foo();\n');
  assert.deepEqual(a, b);
  assert.match(a.user, /## Diff\ndiff --git a\/x b\/x/);
  assert.match(a.user, /CRITICAL OUTPUT REQUIREMENT/); // the JSON_CONTRACT suffix
});

test('buildColdPassPrompt: a different passName or diff changes the prompt (not a constant)', () => {
  const base = soloCtl.buildColdPassPrompt('structure', 'X');
  assert.notEqual(soloCtl.buildColdPassPrompt('wiring', 'X').system, base.system);
  assert.notEqual(soloCtl.buildColdPassPrompt('structure', 'Y').user, base.user);
});

test('repoIdentityFor: resolves THIS repo\'s real remote to the exact key recipient-policy.json uses', () => {
  // Not a synthetic fixture — proves the real chain (git remote -> canonicaliseRemoteUrl
  // -> policy lookup key) agrees with the committed policy file for the repo this
  // suite actually runs in, closing the gap a hand-rolled origin URL could hide.
  const identity = soloCtl.repoIdentityFor(process.cwd());
  const policy = JSON.parse(fs.readFileSync('docs/experiments/audit-effectiveness/recipient-policy.json', 'utf8'));
  assert.ok(Object.hasOwn(policy.repos, identity), `repoIdentityFor() returned "${identity}", not a key in recipient-policy.json's repos (${Object.keys(policy.repos).join(', ')})`);
});

test('repoIdentityFor: a directory with no git remote resolves to null, not a thrown error or a guessed identity', () => {
  const dir = path.join(os.tmpdir(), `exp5-noremote-${process.pid}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  try {
    // Not a git repo at all — `git config` fails, tryGit returns null upstream.
    assert.equal(soloCtl.repoIdentityFor(dir), null);
  } finally {
    fs.rmSync(dir, { force: true, recursive: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('sha256hex: deterministic and sensitive to every byte (the pre-gate integrity check depends on this)', () => {
  assert.equal(soloCtl.sha256hex('same'), soloCtl.sha256hex('same'));
  assert.notEqual(soloCtl.sha256hex('same'), soloCtl.sha256hex('Same'));
  assert.equal(soloCtl.sha256hex(''), soloCtl.sha256hex(null), 'null/undefined gateContext must hash as empty, never throw');
});

test('gatePath: derives a short, stable tag from the resolved gate model (flash/pro/sonnet/opus), never leaks the full id when a short tag is available', () => {
  assert.match(soloCtl.gatePath('abc123', 'gemini-flash-latest'), /G-flash-A-abc123\.json$/);
  assert.match(soloCtl.gatePath('abc123', 'gemini-pro-latest'), /G-pro-A-abc123\.json$/);
  // Claude gate candidates (the Sonnet-as-gate ablation) get their own short tags too.
  assert.match(soloCtl.gatePath('abc123', 'claude-sonnet-5'), /G-sonnet-A-abc123\.json$/);
  assert.match(soloCtl.gatePath('abc123', 'claude-opus-5'), /G-opus-A-abc123\.json$/);
  // An unrecognised gate model falls back to a sanitised full id rather than
  // colliding two different gate models onto the same filename.
  assert.match(soloCtl.gatePath('abc123', 'grok-4.6'), /G-grok-4-6-A-abc123\.json$/);
});

test('gatePath: the tag match is scoped to the vendor id SHAPE, not a bare substring — a non-gate model containing "flash"/"pro" as a word must not collide with the real Gemini gate tags', () => {
  // deepseek-flash is the exp-5 cold-arm challenger (Arm E), never a gate
  // candidate today — but it contains the literal word "flash", and a bare
  // /flash/i test would tag it identically to gemini-flash-latest's gate
  // output file, silently merging two unrelated models' artifacts.
  assert.doesNotMatch(soloCtl.gatePath('abc123', 'deepseek-flash'), /G-flash-A-abc123\.json$/);
  assert.match(soloCtl.gatePath('abc123', 'deepseek-flash'), /G-deepseek-flash-A-abc123\.json$/);
});

// ── the third gate candidate: runClaudeGateReview (Sonnet-as-gate) ─────────

test('buildGateReviewPrompt: deterministic and byte-identical for the same (collected, diff) — the gate-ablation fairness contract', () => {
  // This is what makes runGeminiReview and runClaudeGateReview send
  // byte-equal text: both call this ONE function rather than each building
  // their own copy, so the ablation compares GATE MODELS, not prompt wording.
  const collected = [{ severity: 'HIGH', category: 'bug', detail: 'x' }];
  const a = soloCtl.buildGateReviewPrompt(collected, 'diff --git a/x b/x\n+foo();\n');
  const b = soloCtl.buildGateReviewPrompt(collected, 'diff --git a/x b/x\n+foo();\n');
  assert.equal(a, b);
  assert.match(a, /Emit ONLY NET-NEW findings the prior audit MISSED/);
  assert.match(a, /## Prior findings\n- \[HIGH\] bug: x/);
  assert.match(a, /## Subject under audit\ndiff --git a\/x b\/x/);
});

test('buildGateReviewPrompt: empty collected findings reads as "(none)", never an empty section that looks like a parse failure', () => {
  assert.match(soloCtl.buildGateReviewPrompt([], 'X'), /## Prior findings\n\(none\)/);
});

function stubAnthropicClient(handler) {
  let calls = 0;
  return {
    messages: {
      create: async (params, opts) => { calls++; return handler(params, opts); },
    },
    get callCount() { return calls; },
  };
}

test('runClaudeGateReview: sends the shared prompt verbatim, forces the emit_findings tool, and applies the requested reasoning effort', async () => {
  let seenParams = null;
  const client = stubAnthropicClient((params) => {
    seenParams = params;
    return { content: [{ type: 'tool_use', input: { findings: [{ id: 'H1', severity: 'HIGH', category: 'bug', section: 'x.js', detail: 'd', risk: 'r', recommendation: 'fix', is_quick_fix: false, is_mechanical: false, is_reopened: false, principle: 'p', classification: { sonarType: 'BUG', effort: 'EASY', sourceKind: 'MODEL', sourceName: 'claude-gate' } }] } }], usage: { input_tokens: 10, output_tokens: 5 } };
  });
  const collected = [{ severity: 'MEDIUM', category: 'style', detail: 'already raised' }];
  const r = await soloCtl.runClaudeGateReview(client, 'claude-sonnet-5', collected, 'DIFF-TEXT', { reasoningEffort: 'medium' });

  assert.equal(seenParams.model, 'claude-sonnet-5');
  assert.equal(seenParams.messages[0].content, soloCtl.buildGateReviewPrompt(collected, 'DIFF-TEXT'));
  assert.equal(seenParams.tool_choice.name, 'emit_findings');
  assert.equal(seenParams.output_config.effort, 'medium');
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].category, 'bug');
});

test('runClaudeGateReview: defaults to "high" effort — the max tier this repo has for Claude — when the caller passes none', async () => {
  let seenParams = null;
  const client = stubAnthropicClient((params) => { seenParams = params; return { content: [{ type: 'tool_use', input: { findings: [] } }] }; });
  await soloCtl.runClaudeGateReview(client, 'claude-sonnet-5', [], 'X');
  assert.equal(seenParams.output_config.effort, 'high');
});

test('runClaudeGateReview: a provider error degrades to a conformance-style empty result, never a thrown crash', async () => {
  const client = stubAnthropicClient(() => { throw new Error('network blip'); });
  const r = await soloCtl.runClaudeGateReview(client, 'claude-sonnet-5', [], 'X');
  assert.deepEqual(r.findings, []);
  assert.match(r.skipped, /network blip/);
});

test('runClaudeGateReview: a tool_use input that fails schema validation (or a missing tool_use block) returns empty findings, not a thrown parse error', async () => {
  const missingToolUse = stubAnthropicClient(() => ({ content: [{ type: 'text', text: 'sorry, no tool call' }] }));
  const r1 = await soloCtl.runClaudeGateReview(missingToolUse, 'claude-sonnet-5', [], 'X');
  assert.deepEqual(r1.findings, []);

  const malformedInput = stubAnthropicClient(() => ({ content: [{ type: 'tool_use', input: { findings: 'not-an-array' } }] }));
  const r2 = await soloCtl.runClaudeGateReview(malformedInput, 'claude-sonnet-5', [], 'X');
  assert.deepEqual(r2.findings, []);
});

test('runClaudeGateReview: a diff carrying a real secret pattern refuses BEFORE the client is ever called', async () => {
  const client = stubAnthropicClient(() => ({ content: [{ type: 'tool_use', input: { findings: [] } }] }));
  const dirtyDiff = 'aws_secret_key = "AKIA1234567890ABCDEF1234567890ABCDEF1234"';
  await assert.rejects(
    () => soloCtl.runClaudeGateReview(client, 'claude-sonnet-5', [], dirtyDiff),
    /egress-gate/,
  );
  assert.equal(client.callCount, 0, 'the client must never be called for a payload the egress gate refuses');
});

test('pregatePath: one immutable artifact path per commit sha, independent of which arm/gate later reads it', () => {
  assert.match(soloCtl.pregatePath('abc123'), /S-pregate-A-abc123\.json$/);
  assert.equal(soloCtl.pregatePath('abc123'), soloCtl.pregatePath('abc123'));
});

// ── pre-Phase-3 fixes (2026-09-21 fresh-look review) ───────────────────────

test('pass set: the solo-control runner uses EXACTLY the baseline SHADOW_PASSES — never a locally re-derived list', async () => {
  // Regression lock. The file used to compute `PASS_PROMPTS keys minus
  // quickfix`, which silently enrolled the later-added MECHANICAL waves
  // (duplication, adjacency — regex/index lookups, not model calls) as paid
  // LLM passes: 7 calls per chunk against the apparatus's 5. Both a 40%
  // over-spend and a fairness break. The only oracle is audit-shadow's own.
  const { SHADOW_PASSES, MECHANICAL_WAVES } = await import('../scripts/lib/audit-shadow.mjs');
  const { PASS_PROMPTS } = await import('../scripts/lib/prompt-seeds.mjs');
  // The RUNNER's own list — the thing that actually drifted. (A first draft of
  // this lock asserted on SHADOW_PASSES alone and stayed green with the bug
  // planted: it never looked at what the runner iterates. Seen to fail first.)
  assert.deepEqual([...soloCtl.PASSES], [...SHADOW_PASSES], 'the runner must iterate exactly the baseline pass set');
  for (const wave of MECHANICAL_WAVES) assert.ok(!soloCtl.PASSES.includes(wave), `${wave} is mechanical and must not be a paid generation pass`);
  assert.ok(soloCtl.PASSES.every((p) => p in PASS_PROMPTS));
  // Vacuous-pass guard: the trap only exists because PASS_PROMPTS carries MORE
  // keys than the pass set — if that ever stops being true the lock is moot.
  assert.ok(Object.keys(PASS_PROMPTS).length > soloCtl.PASSES.length, 'PASS_PROMPTS must contain mechanical waves for this lock to mean anything');
});

test('REASONING_TIERS: per-vendor tables are deliberately NOT unified — a tier one vendor silently aliases is refused, never remapped', () => {
  assert.equal(soloCtl.assertReasoningTier('anthropic', 'xhigh'), 'xhigh');
  assert.equal(soloCtl.assertReasoningTier('deepseek', 'max'), 'max');
  assert.equal(soloCtl.assertReasoningTier('anthropic', null), null, 'null = provider default, never an error');
  // DeepSeek documents xhigh -> high and medium -> high as SILENT aliases: the
  // manifest would say one effort and the provider would run another.
  assert.throws(() => soloCtl.assertReasoningTier('deepseek', 'xhigh'), /not a deepseek tier/);
  assert.throws(() => soloCtl.assertReasoningTier('deepseek', 'medium'), /not a deepseek tier/);
  assert.throws(() => soloCtl.assertReasoningTier('anthropic', 'ultra'), /not a anthropic tier/);
  assert.throws(() => soloCtl.assertReasoningTier('gemini', 'high'), /not supported for recipient/);
});

test('runPass: effort raises max_tokens (thinking shares the budget) and a null effort keeps the request body byte-identical to the pre-exp-5 shape', async () => {
  let seen = null;
  const stub = { messages: { create: async (p) => { seen = p; return { content: [{ type: 'text', text: '{"findings":[],"summary":""}' }], usage: null }; } } };
  await soloCtl.runPass(stub, 'claude-sonnet-5', 'structure', 'X');
  assert.equal(seen.max_tokens, 8000);
  assert.ok(!('output_config' in seen), 'no effort => no output_config key at all (solo-control:catchup must not change)');
  await soloCtl.runPass(stub, 'claude-sonnet-5', 'structure', 'X', { reasoningEffort: 'xhigh' });
  assert.deepEqual(seen.output_config, { effort: 'xhigh' });
  assert.equal(seen.max_tokens, soloCtl.REASONING_TIERS.anthropic.xhigh);
  assert.ok(seen.max_tokens > 8000, 'raising effort without raising max_tokens truncates the chain of thought into a conformance miss');
});

test('runDeepseekPass: sends thinking.reasoning_effort, sizes max_tokens to the documented thinking-mode ceiling, and NEVER sends temperature', async () => {
  let seen = null;
  const stub = { chat: { completions: { create: async (p) => { seen = p; return { choices: [{ message: { content: '{"findings":[],"summary":""}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 }, system_fingerprint: 'fp_a' }; } } } };
  await soloCtl.runDeepseekPass(stub, 'deepseek-flash', 'structure', 'X', { reasoningEffort: 'max' });
  assert.deepEqual(seen.thinking, { type: 'enabled', reasoning_effort: 'max' });
  assert.equal(seen.max_tokens, soloCtl.REASONING_TIERS.deepseek.max);
  assert.ok(!('temperature' in seen), 'DeepSeek thinking mode ignores temperature silently; sending it would put an unhonoured value in the manifest');
  // Default (null effort) still gets the 64K thinking-mode ceiling, not the old
  // 8K that would have truncated reasoning + answer.
  await soloCtl.runDeepseekPass(stub, 'deepseek-flash', 'structure', 'X');
  assert.ok(!('thinking' in seen), 'null effort leaves the provider default in place');
  assert.equal(seen.max_tokens, soloCtl.REASONING_TIERS.deepseek.high);
});

// ── the prose↔schema seam of the cold pass (AGENTS.md "Contracts across the
// prose↔code seam") ──────────────────────────────────────────────────────────

/** A finding shaped exactly as JSON_CONTRACT asks the model to write it —
 * deliberately WITHOUT `is_reopened`, which the contract never names. */
const coldFinding = () => ({
  id: 'H1', severity: 'HIGH', category: 'bug', section: 'x.js', detail: 'd', risk: 'r', recommendation: 'fix',
  is_quick_fix: false, is_mechanical: false, principle: 'p',
  classification: { sonarType: 'BUG', effort: 'EASY', sourceKind: 'MODEL', sourceName: 'solo-control' },
});

test('JSON_CONTRACT names every key the cold schema REQUIRES the model to supply — derived from the emitted schema, never from the Zod source', () => {
  // The bug this pins (2026-09-21): `is_reopened` became required on
  // ProducerFindingSchema on 2026-08-14, after the prose contract was written.
  // Nothing type-checks prose against Zod, so every cold finding failed
  // `expected boolean, received undefined` and every cold cell became a
  // conformance-miss with 0 findings — which completion.mjs counts as COMPLETE.
  // Arms C and E would have scored as "found nothing". The check asks the
  // EMITTED schema what the model must supply (`io:'input'` — a defaulted field
  // is not the model's to write) and greps the contract for each key.
  const emitted = z.toJSONSchema(soloCtl.ColdPassSchema, { io: 'input' });
  const finding = emitted.properties.findings.items;
  assert.ok(Array.isArray(finding.required) && finding.required.length >= 10, 'the finding schema exposes its required keys');
  for (const key of finding.required) {
    assert.match(soloCtl.JSON_CONTRACT, new RegExp(`"${key}"\\s*:`), `JSON_CONTRACT never names required finding key "${key}" — a model following the prompt cannot produce a conformant reply`);
  }
  for (const key of emitted.required) {
    assert.match(soloCtl.JSON_CONTRACT, new RegExp(`"${key}"\\s*:`), `JSON_CONTRACT never names required top-level key "${key}"`);
  }
  // Negative control: the same check against the ARMS' schema (enforced
  // structured output, not prose) must FAIL on is_reopened — proving the
  // assertion above can fail, and that ColdPassSchema differs from it in
  // exactly that key.
  const armsEmitted = z.toJSONSchema(soloCtl.ColdPassSchema.shape.findings.element.omit({ is_reopened: true }).extend({ is_reopened: z.boolean() }), { io: 'input' });
  assert.ok(armsEmitted.required.includes('is_reopened'));
  assert.doesNotMatch(soloCtl.JSON_CONTRACT, /"is_reopened"\s*:/, 'the contract must NOT ask a round-1 model for a round-2-only field');
});

test('ColdPassSchema: a finding written exactly as JSON_CONTRACT describes it (no is_reopened) conforms, and is_reopened lands as false', () => {
  const check = soloCtl.ColdPassSchema.safeParse({ findings: [coldFinding()], summary: '' });
  assert.ok(check.success, JSON.stringify(check.error?.issues));
  assert.equal(check.data.findings[0].is_reopened, false, 'round-1 by construction — the arm, not the model, owns this value');
});

test('runPass / runDeepseekPass: a reply shaped as the contract asks is COUNTED, not a conformance miss', async () => {
  const text = JSON.stringify({ findings: [coldFinding()], summary: 's' });
  const anth = { messages: { create: async () => ({ content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 5 } }) } };
  const a = await soloCtl.runPass(anth, 'claude-sonnet-5', 'structure', 'X', { reasoningEffort: 'xhigh' });
  assert.equal(a.findings.length, 1);
  assert.ok(!a.conformanceMiss);
  const ds = { chat: { completions: { create: async () => ({ choices: [{ message: { content: text } }], usage: { prompt_tokens: 10, completion_tokens: 5 }, system_fingerprint: 'fp' }) } } };
  const e = await soloCtl.runDeepseekPass(ds, 'deepseek-flash', 'structure', 'X', { reasoningEffort: 'max' });
  assert.equal(e.findings.length, 1);
  assert.ok(!e.conformanceMiss);
});

test('runPass / runDeepseekPass: a conformance MISS still carries the usage of every attempt that replied — the provider billed them', async () => {
  // Before 2026-09-21 a miss returned usage:null, so the ledger row was
  // unpriced (costUsd null) and aggregateCostForArm read the whole arm's cost
  // as unknown. A miss costs real money — two full thinking-mode attempts.
  let calls = 0;
  const anth = { messages: { create: async () => { calls++; return { content: [{ type: 'text', text: 'not json' }], usage: { input_tokens: 100, output_tokens: 7 } }; } } };
  const a = await soloCtl.runPass(anth, 'claude-sonnet-5', 'structure', 'X');
  assert.equal(calls, 2);
  assert.equal(a.conformanceMiss, true);
  assert.deepEqual(a.usage, { input_tokens: 200, output_tokens: 14 }, 'both attempts summed');
  const ds = { chat: { completions: { create: async () => ({ choices: [{ message: { content: 'nope' } }], usage: { prompt_tokens: 50, completion_tokens: 3 } }) } } };
  const e = await soloCtl.runDeepseekPass(ds, 'deepseek-flash', 'structure', 'X');
  assert.equal(e.conformanceMiss, true);
  assert.deepEqual(e.usage, { input_tokens: 100, output_tokens: 6 });
  // A miss with NO reply at all (both attempts threw) has nothing to sum — null,
  // never a fabricated zero that would price the cell as free.
  const dead = { messages: { create: async () => { throw new Error('529 overloaded'); } } };
  const d = await soloCtl.runPass(dead, 'claude-sonnet-5', 'structure', 'X');
  assert.equal(d.usage, null);
});

test('runPass: a first attempt that did not parse still counts toward the cell\'s usage when the retry succeeds', async () => {
  let n = 0;
  const anth = { messages: { create: async () => { n++; return n === 1
    ? { content: [{ type: 'text', text: 'garbage' }], usage: { input_tokens: 10, output_tokens: 1 } }
    : { content: [{ type: 'text', text: '{"findings":[],"summary":""}' }], usage: { input_tokens: 12, output_tokens: 2 } }; } } };
  const r = await soloCtl.runPass(anth, 'claude-sonnet-5', 'structure', 'X');
  assert.ok(!r.conformanceMiss);
  assert.deepEqual(r.usage, { input_tokens: 22, output_tokens: 3 });
});

test('sumUsage: null-safe, sums both token counts, and two nulls stay null', () => {
  assert.equal(soloCtl.sumUsage(null, null), null);
  assert.deepEqual(soloCtl.sumUsage(null, { input_tokens: 1, output_tokens: 2 }), { input_tokens: 1, output_tokens: 2 });
  assert.deepEqual(soloCtl.sumUsage({ input_tokens: 1, output_tokens: 2 }, { input_tokens: 3, output_tokens: 4 }), { input_tokens: 4, output_tokens: 6 });
});

// ── shared 5-pass credit for --gate-only configurations ─────────────────────

test('sharedPassCreditRows: a gate-only configuration credits itself with the base arm\'s pass cells under the SAME callId, sharedBy widened', () => {
  // The bug this pins (2026-09-21): A's writer hardcoded sharedBy ['A','A+'],
  // so the third and fourth gate candidates (A-sonnet, A-sol) held only their
  // gate row — priced as gate-only and read as `partial` on every commit.
  const base = [
    { callId: 'p0', arm: 'A', sharedBy: null, commit: 'c1', purpose: 'pass', pass: 'structure', costUsd: 0.5, state: 'ok' },
    { callId: 'p1', arm: 'A', sharedBy: ['A', 'A+'], commit: 'c1', purpose: 'pass', pass: 'wiring', costUsd: 0.4, state: 'ok' }, // legacy hardcoded shape
    { callId: 'g0', arm: 'A', sharedBy: null, commit: 'c1', purpose: 'gate', pass: 'apparatus-gate', costUsd: 0.1, state: 'ok' }, // A's OWN gate — never shared
    { callId: 'p9', arm: 'A', sharedBy: null, commit: 'c2', purpose: 'pass', pass: 'structure', costUsd: 0.5, state: 'ok' }, // other commit
    { callId: 'e0', arm: 'E', sharedBy: null, commit: 'c1', purpose: 'pass', pass: 'structure', costUsd: 0.01, state: 'ok' }, // a cold arm's own pass — not A's
  ];
  const credits = sharedPassCreditRows(base, { commit: 'c1', baseArm: 'A', label: 'A-sonnet' });
  assert.deepEqual(credits.map((r) => r.callId).sort(), ['p0', 'p1']);
  for (const r of credits) {
    assert.equal(r.arm, 'A-sonnet');
    assert.ok(r.sharedBy.includes('A') && r.sharedBy.includes('A-sonnet'));
    assert.equal(r.purpose, 'pass');
  }
  assert.deepEqual(credits.find((r) => r.callId === 'p1').sharedBy, ['A', 'A+', 'A-sonnet'], 'the legacy list is widened, not replaced');
  // Once appended, every reader sees the sharer whole and the base arm unchanged.
  const rows = [...base, ...credits, { callId: 'gs', arm: 'A-sonnet', sharedBy: null, commit: 'c1', purpose: 'gate', pass: 'apparatus-gate', costUsd: 0.3, state: 'ok' }];
  assert.deepEqual(aggregateCostForArm(rows, 'A-sonnet'), { costUsd: 1.2, complete: true }); // 0.5 + 0.4 + own gate 0.3
  assert.deepEqual(aggregateCostForArm(rows, 'A'), { costUsd: 1.5, complete: true });        // unchanged: 0.5 + 0.4 + 0.1 + 0.5(c2)
  assert.equal(commitArmCompletion(rows, { arm: 'A-sonnet', commit: 'c1', expectedCellCount: 3 }), 'complete');
  assert.equal(aggregateBudgetSpent(rows).spentUsd, 1.81, 'budget counts each callId ONCE despite the credit copies');
});

test('sharedPassCreditRows: an arm never credits itself, an empty base yields no rows (partial, not padded), and a re-credit is idempotent under last-wins', () => {
  assert.deepEqual(sharedPassCreditRows([{ callId: 'p0', arm: 'A', commit: 'c1', purpose: 'pass' }], { commit: 'c1', baseArm: 'A', label: 'A' }), []);
  assert.deepEqual(sharedPassCreditRows([], { commit: 'c1', baseArm: 'A', label: 'A+' }), []);
  const base = [{ callId: 'p0', arm: 'A', sharedBy: null, commit: 'c1', purpose: 'pass', costUsd: 0.5, state: 'ok' }];
  const once = sharedPassCreditRows(base, { commit: 'c1', baseArm: 'A', label: 'A+' });
  const twice = sharedPassCreditRows([...base, ...once], { commit: 'c1', baseArm: 'A', label: 'A+' });
  assert.deepEqual(twice, once);
  assert.equal(commitArmCompletion([...base, ...once, ...twice], { arm: 'A+', commit: 'c1', expectedCellCount: 1 }), 'complete');
  assert.deepEqual(aggregateCostForArm([...base, ...once, ...twice], 'A+'), { costUsd: 0.5, complete: true });
});

test('geminiUsageOrNull: a usable usageMetadata becomes ledger usage; a missing one is NULL, never a fabricated zero that prices as free', () => {
  const ok = soloCtl.geminiUsageOrNull({ usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 30 } });
  assert.deepEqual(ok, { input_tokens: 100, output_tokens: 50 }); // thoughts are billed output, disjoint from candidates
  assert.equal(soloCtl.geminiUsageOrNull({}), null);
  assert.equal(soloCtl.geminiUsageOrNull({ usageMetadata: { promptTokenCount: 'x' } }), null);
});

test('runGeminiReview: the gate call now returns usage (it returned findings only, so every gate row was costUsd:null and A/A+ were ineligible by construction)', async () => {
  // Cannot stub @google/genai's dynamic import cheaply; assert the contract at
  // the seam the function uses instead — the same normaliser it now calls.
  const r = soloCtl.geminiUsageOrNull({ usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } });
  assert.notEqual(r, null);
  // and the no-key early return is unchanged (no network in a test suite)
  const saved = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    const out = await soloCtl.runGeminiReview('gemini-flash-latest', [], 'X');
    assert.deepEqual(out, { findings: [], skipped: 'no-key' });
  } finally { if (saved !== undefined) process.env.GEMINI_API_KEY = saved; }
});

test('runGptGateReview: fourth gate candidate — same shared prompt, GPT\'s own structured output (Responses API + zodTextFormat), effort + scaled max_output_tokens', async () => {
  let seen = null;
  const client = { responses: { parse: async (p) => { seen = p; return { output_parsed: { findings: [{ id: 'G1', severity: 'HIGH', category: 'bug', section: 'x', detail: 'd', risk: 'r', recommendation: 'f', is_quick_fix: false, is_mechanical: false, is_reopened: false, principle: 'p', classification: { sonarType: 'BUG', effort: 'EASY', sourceKind: 'REVIEWER', sourceName: 'gpt-gate' } }] }, usage: { input_tokens: 5, output_tokens: 2 } }; } } };
  const zodTextFormat = (schema, name) => ({ type: 'json_schema', name }); // transport stub: the real helper is openai/helpers/zod
  const collected = [{ severity: 'MEDIUM', category: 'style', detail: 'already raised' }];
  const r = await soloCtl.runGptGateReview(client, zodTextFormat, 'gpt-5.6-sol', collected, 'DIFF', { reasoningEffort: 'high' });
  assert.equal(seen.model, 'gpt-5.6-sol');
  assert.equal(seen.input[0].content, soloCtl.buildGateReviewPrompt(collected, 'DIFF'), 'byte-identical prompt to the Gemini/Claude gates');
  assert.deepEqual(seen.reasoning, { effort: 'high' });
  assert.equal(seen.max_output_tokens, soloCtl.REASONING_TIERS.openai.high);
  assert.equal(seen.text.format.name, 'shadow_pass');
  assert.equal(r.findings.length, 1);
  assert.deepEqual(r.usage, { input_tokens: 5, output_tokens: 2 }, 'usage must reach the ledger — a null here is the blocker-#2 class');
});

test('runGptGateReview: a diff carrying a secret refuses BEFORE the client is called', async () => {
  let calls = 0;
  const client = { responses: { parse: async () => { calls++; return { output_parsed: { findings: [] } }; } } };
  await assert.rejects(() => soloCtl.runGptGateReview(client, () => ({}), 'gpt-5.6-sol', [], 'aws_secret_key = "AKIA1234567890ABCDEF1234567890ABCDEF1234"'), /egress-gate/);
  assert.equal(calls, 0);
});

test('gatePath: the GPT gate tags (sol/terra/luna) are anchored to the id TAIL, so a future gpt-*-sol-* variant cannot silently share a file', () => {
  assert.match(soloCtl.gatePath('abc', 'gpt-5.6-sol'), /G-sol-A-abc\.json$/);
  assert.match(soloCtl.gatePath('abc', 'gpt-5.6-terra'), /G-terra-A-abc\.json$/);
  assert.match(soloCtl.gatePath('abc', 'gpt-6-astra'), /G-gpt-6-astra-A-abc\.json$/, 'an unlisted GPT variant falls back to its full id');
});

test('runClaudeGateReview: max_tokens follows the effort tier for the same thinking-budget reason as runPass', async () => {
  let seen = null;
  const stub = { messages: { create: async (p) => { seen = p; return { content: [{ type: 'tool_use', input: { findings: [] } }] }; } } };
  await soloCtl.runClaudeGateReview(stub, 'claude-sonnet-5', [], 'X', { reasoningEffort: 'xhigh' });
  assert.equal(seen.output_config.effort, 'xhigh');
  assert.equal(seen.max_tokens, soloCtl.REASONING_TIERS.anthropic.xhigh);
});

test('commitsCompleteForAllArms: the denominator is per (commit, ARM) — a x3 arm has three times the cells — and a missing denominator is partial, never guessed', () => {
  const rows = [
    { callId: 'c1-a', arm: 'C', commit: 'c1', state: 'ok' }, { callId: 'c1-b', arm: 'C', commit: 'c1', state: 'ok' }, { callId: 'c1-c', arm: 'C', commit: 'c1', state: 'ok' },
    { callId: 'e1-a', arm: 'E', commit: 'c1', state: 'ok' },
  ];
  const expected = { C: 3, E: 1 };
  assert.deepEqual(commitsCompleteForAllArms(rows, ['C', 'E'], ['c1'], (commit, arm) => expected[arm]).kept, ['c1']);
  // Same rows, but E claims 3 expected cells: E is partial, so c1 drops for BOTH.
  const r = commitsCompleteForAllArms(rows, ['C', 'E'], ['c1'], (commit, arm) => ({ C: 3, E: 3 })[arm]);
  assert.deepEqual(r.kept, []);
  assert.equal(r.dropped[0].causes[0].arm, 'E');
  // No recorded denominator for an arm => partial with a named reason, not a
  // vacuous "complete" against an unknown total.
  const r2 = commitsCompleteForAllArms(rows, ['C', 'E'], ['c1'], (commit, arm) => (arm === 'E' ? null : 3));
  assert.deepEqual(r2.kept, []);
  assert.equal(r2.dropped[0].causes[0].reason, 'no-expected-cell-count');
});

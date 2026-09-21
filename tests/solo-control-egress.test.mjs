import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveAndAuthorize, loadRecipientPolicy } from '../scripts/lib/solo-control/policy.mjs';
import { entriesEligibleForRecipient, loadCorpus } from '../scripts/lib/solo-control/corpus.mjs';
import { assertEgressSafe } from '../scripts/lib/sensitive-egress-gate.mjs';
import { canonicaliseRemoteUrl } from '../scripts/lib/repo-identity.mjs';

const S_FINDINGS_PATH = '.audit-loop/solo-control/S-findings-S-sonnet.json';

/** solo-control-audit.mjs logs via lib/cli-io.mjs's log() -> stderr (AGENTS.md
 * Code Style: stdout stays clean for JSON output) — execFileSync only returns
 * stdout, so a bare call here would always see empty output regardless of
 * what actually happened. spawnSync gives both streams back directly.
 * `policyPath`, when given, sets SOLO_CONTROL_RECIPIENT_POLICY_PATH so the
 * subprocess reads an ISOLATED fixture instead of the real committed policy
 * file — mutating that shared file on disk raced every other test file
 * reading it concurrently (Node's test runner parallelises across files),
 * confirmed live: tests/solo-control-dispatch.test.mjs's own real-policy
 * reads failed intermittently the first time this test mutated it in place. */
function runCli(args, { policyPath } = {}) {
  return runCliFull(args, { policyPath }).output;
}
/** Same, but also the REAL exit status — a pipe through `tail` reports the
 * pipe's exit, which is how a process.exit(3) reads as 0 (memory:
 * feedback_pipe_masks_git_exit_code). */
function runCliFull(args, { policyPath, scrubKeys = false } = {}) {
  const env = { ...process.env };
  if (policyPath) env.SOLO_CONTROL_RECIPIENT_POLICY_PATH = policyPath;
  // For tests whose PASSING path is "the guard stops us before any call": if the
  // guard ever regresses, the subprocess would reach a real provider. Preset
  // keys win over the repo's env loader (dotenv no-override — verified), so an
  // invalid key turns a regressed guard into a fast 401, not spend. Also pin
  // the sdk backend so the cli (`claude -p`) path can't authenticate around it.
  if (scrubKeys) Object.assign(env, { OPENAI_API_KEY: 'scrubbed', ANTHROPIC_API_KEY: 'scrubbed', GEMINI_API_KEY: 'scrubbed', DEEPSEEK_API_KEY: 'scrubbed', CLAUDE_BACKEND: 'sdk' });
  const r = spawnSync('node', ['scripts/solo-control-audit.mjs', ...args], { encoding: 'utf8', env });
  return { output: `${r.stdout || ''}${r.stderr || ''}`, status: r.status };
}

function withTempPolicyFile(policyObj, fn) {
  const p = path.join(os.tmpdir(), `exp5-egresstest-policy-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, JSON.stringify(policyObj, null, 2));
  try { return fn(p); } finally { fs.rmSync(p, { force: true, recursive: true, maxRetries: 3, retryDelay: 50 }); }
}

// This file covers the egress guarantees SPECIFIC to experiment 5's
// recipient/corpus design — not the generic secret-pattern gate itself
// (that is tests/sensitive-egress.test.mjs, already exhaustive). The gap
// here: recipient-policy refusal is a SEPARATE boundary from content
// redaction, and the two must compose in the right ORDER at any real call
// site — a diff must never leave the machine for a refused recipient
// regardless of whether its content is clean, and an authorized recipient
// must still be denied dirty content.

test('composed call-site order: recipient refusal fires even when the payload has no secrets at all', () => {
  // Simulates the exact shape scripts/solo-control-audit.mjs's dispatch
  // must follow: resolveAndAuthorize() BEFORE assertEgressSafe() BEFORE
  // any network call. A clean diff must not buy its way past a refused
  // recipient.
  const policy = { repos: { 'github.com/x/wine': ['anthropic'] } };
  const cleanDiff = 'diff --git a/foo.js b/foo.js\n+console.log("hello");\n';
  let sent = false;
  function dispatch({ model, repoIdentity, diffText }) {
    resolveAndAuthorize({ model, repoIdentity, policy }); // must throw first
    assertEgressSafe(diffText, { label: 'test' });
    sent = true;
  }
  assert.throws(() => dispatch({ model: 'qwen/qwen3.8-max', repoIdentity: 'github.com/x/wine', diffText: cleanDiff }), /REFUSED/);
  assert.equal(sent, false, 'a clean diff must not be sent to a recipient the policy refuses');
});

test('composed call-site order: an authorized recipient is STILL refused dirty content', () => {
  // The opposite failure direction: authorization is necessary but not
  // sufficient. A recipient permitted by policy must still be blocked by
  // the secret-pattern gate — the two boundaries are independent, and
  // passing one must never short-circuit the other.
  const policy = { repos: { 'github.com/x/wine': ['deepseek'] } };
  const dirtyDiff = 'diff --git a/config.js b/config.js\n+aws_secret_key = "AKIA1234567890ABCDEF1234567890ABCDEF1234"\n';
  let sent = false;
  function dispatch({ model, repoIdentity, diffText }) {
    resolveAndAuthorize({ model, repoIdentity, policy });
    assertEgressSafe(diffText, { label: 'test' }); // must throw here
    sent = true;
  }
  assert.throws(() => dispatch({ model: 'deepseek-flash', repoIdentity: 'github.com/x/wine', diffText: dirtyDiff }), /egress-gate/);
  assert.equal(sent, false);
});

test('composed call-site order: a clean diff to an authorized recipient sends (the non-refusal path is not accidentally also blocked)', () => {
  // A guard that always throws would pass both tests above vacuously.
  // This is the paired positive control.
  const policy = { repos: { 'github.com/x/wine': ['deepseek'] } };
  const cleanDiff = 'diff --git a/foo.js b/foo.js\n+console.log("hello");\n';
  let sent = false;
  function dispatch({ model, repoIdentity, diffText }) {
    resolveAndAuthorize({ model, repoIdentity, policy });
    assertEgressSafe(diffText, { label: 'test' });
    sent = true;
  }
  dispatch({ model: 'deepseek-flash', repoIdentity: 'github.com/x/wine', diffText: cleanDiff });
  assert.equal(sent, true);
});

test('entriesEligibleForRecipient: a corpus entry with a narrower allowedTransports than the repo policy grants is excluded for the recipient it does not list', () => {
  // allowedTransports is a per-ENTRY egress boundary, tighter than (never
  // wider than) the per-REPO policy — e.g. one wine-cellar-app commit may
  // be marked anthropic-only even though the repo policy now permits
  // deepseek/openrouter broadly, because that specific commit's diff was
  // reviewed and cleared only for the narrower set.
  const corpus = { entries: [
    { id: 'E1', allowedTransports: ['anthropic'] },
    { id: 'E2', allowedTransports: ['anthropic', 'deepseek'] },
  ] };
  assert.deepEqual(entriesEligibleForRecipient(corpus, 'deepseek'), ['E2']);
  assert.deepEqual(entriesEligibleForRecipient(corpus, 'anthropic'), ['E1', 'E2']);
});

test('the real committed corpus + policy: every entry eligible for "deepseek" is ALSO eligible for "anthropic" (Arm E is a subset, never a superset, of the cohort)', () => {
  // A concrete regression lock on the plan's single-cohort design after
  // the wine-cellar-app policy change: DeepSeek's eligible set must not
  // exceed the incumbent's, or Arm E would be scored on commits no other
  // arm ever saw — silently comparing apples to a larger orange bowl.
  const policy = loadRecipientPolicy('docs/experiments/audit-effectiveness/recipient-policy.json');
  const corpus = loadCorpus('docs/experiments/audit-effectiveness/experiment-5-corpus.json', policy);
  const deepseekEligible = new Set(entriesEligibleForRecipient(corpus, 'deepseek'));
  const anthropicEligible = new Set(entriesEligibleForRecipient(corpus, 'anthropic'));
  for (const id of deepseekEligible) assert.ok(anthropicEligible.has(id), `${id} is deepseek-eligible but not anthropic-eligible`);
});

test('resolveAndAuthorize: throws BEFORE entriesEligibleForRecipient would even be consulted for a repo the corpus does not cover', () => {
  // A repoIdentity absent from the policy must refuse at the authorization
  // step, never fall through to "just filter the corpus and find nothing" —
  // an empty eligible set and a refusal are different outcomes, and only
  // one of them is safe to treat as "proceed with zero entries."
  const policy = { repos: { 'github.com/x/known': ['anthropic'] } };
  assert.throws(
    () => resolveAndAuthorize({ model: 'claude-sonnet-5', repoIdentity: 'github.com/x/unknown-repo', policy }),
    /REFUSED/,
  );
});

// ── the WIRED CLI (scripts/solo-control-audit.mjs cmdRun) ───────────────────
//
// The tests above prove the composition is safe in isolation; this proves the
// REAL entry point actually calls it in that order, for a REAL local commit —
// "a bare --commits run on a repo absent from recipient-policy.json is
// refused" (plan §7 test table), exercised end to end with no network access
// (a refusal must happen before any provider call is attempted, so nothing
// here needs a network stub).

test('cmdRun refuses a real commit when this repo has no entry in recipient-policy.json — no client, no network, never silently sent', () => {
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  fs.rmSync(S_FINDINGS_PATH, { force: true, recursive: true, maxRetries: 3, retryDelay: 50 });
  try {
    withTempPolicyFile({ version: 999, repos: { 'github.com/someone/else': ['anthropic'] } }, (policyPath) => {
      // A policy with every OTHER repo but not this one — the exact "absence
      // means refuse" shape, not an artificially malformed file.
      const output = runCli(['run', '--commits', sha, '--force'], { policyPath });
      assert.match(output, /POLICY REFUSED/, `expected a policy refusal in output, got:\n${output}`);

      const written = JSON.parse(fs.readFileSync(S_FINDINGS_PATH, 'utf8'));
      const record = written.perCommit.find((c) => c.sha === sha);
      assert.equal(record.state, 'policy-refused', 'the refused commit must be recorded distinctly, never silently dropped or marked "ran"');
      assert.equal(written.findings.length, 0, 'no findings can exist for a commit whose content was never sent');
    });
  } finally {
    fs.rmSync(S_FINDINGS_PATH, { force: true, recursive: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('cmdRun proceeds past the policy gate for the same commit once the repo IS in policy (paired positive control)', () => {
  // Without this, a CLI that always printed "POLICY REFUSED" regardless of
  // policy content would pass the test above vacuously. `--max-diff-chars 1`
  // forces an immediate, network-free short-circuit right after the gate
  // (either 'diff-too-large' or, if this very commit's diff happens to carry
  // the deliberate secret fixture from the test above, 'egress-refused') —
  // both prove the policy gate let this commit through without ever reaching
  // runPass (no real provider spend in a test suite). The exact downstream
  // state is NOT what this test is about — asserting one specific value
  // couples the test to incidental diff content (which commit HEAD happens to
  // be) rather than the property under test: did the POLICY gate pass.
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const identity = canonicaliseRemoteUrl(execFileSync('git', ['config', '--get', 'remote.origin.url'], { encoding: 'utf8' }).trim());
  fs.rmSync(S_FINDINGS_PATH, { force: true, recursive: true, maxRetries: 3, retryDelay: 50 });
  try {
    withTempPolicyFile({ version: 999, repos: { [identity]: ['anthropic'] } }, (policyPath) => {
      const output = runCli(['run', '--commits', sha, '--force', '--max-diff-chars', '1'], { policyPath });
      assert.doesNotMatch(output, /POLICY REFUSED/);
      const written = JSON.parse(fs.readFileSync(S_FINDINGS_PATH, 'utf8'));
      const record = written.perCommit.find((c) => c.sha === sha);
      assert.notEqual(record.state, 'policy-refused', 'the policy gate itself must have passed for this authorized repo');
      assert.ok(['diff-too-large', 'egress-refused'].includes(record.state), `expected a network-free short-circuit state, got "${record.state}"`);
    });
  } finally {
    fs.rmSync(S_FINDINGS_PATH, { force: true, recursive: true, maxRetries: 3, retryDelay: 50 });
  }
});

// ── cmdApparatus: the wired CLI (regression + Sonnet-as-gate dispatch) ─────

const A_FINDINGS_PATH = '.audit-loop/solo-control/S-findings-A.json';
const A_SONNET_FINDINGS_PATH = '.audit-loop/solo-control/S-findings-A-sonnet-gate.json';

test('cmdApparatus does not crash on a real invocation — regression lock for the planIncrementalRun/units signature mismatch', () => {
  // planIncrementalRun's signature moved from {requested} to {units} while
  // reconciling with the commit_sha identity fix (origin PR #110); cmdRun's
  // call site was updated but cmdApparatus's was not, so every real
  // cmdApparatus invocation threw "Cannot read properties of undefined
  // (reading 'filter')" before ever reaching a single commit. Caught by
  // hand before shipping, but a real commit slipped through review once —
  // this locks it so it can't again.
  fs.rmSync(A_FINDINGS_PATH, { force: true, recursive: true, maxRetries: 3, retryDelay: 50 });
  try {
    const output = runCli(['apparatus', '--commits', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef']);
    assert.doesNotMatch(output, /TypeError|Cannot read propert/, `cmdApparatus crashed:\n${output}`);
    assert.match(output, /NOT FOUND/);
    const written = JSON.parse(fs.readFileSync(A_FINDINGS_PATH, 'utf8'));
    assert.equal(written.perCommit[0].state, 'not-found');
  } finally {
    fs.rmSync(A_FINDINGS_PATH, { force: true, recursive: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('cmdApparatus --gate-model claude-sonnet-5 dispatches to the anthropic gate branch without crashing (no provider spend — commit not found short-circuits first)', () => {
  fs.rmSync(A_SONNET_FINDINGS_PATH, { force: true, recursive: true, maxRetries: 3, retryDelay: 50 });
  try {
    const output = runCli(['apparatus', '--label', 'A-sonnet-gate', '--gate-model', 'claude-sonnet-5', '--commits', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef']);
    assert.doesNotMatch(output, /TypeError|Cannot read propert|no adapter yet/, `unexpected dispatch failure:\n${output}`);
    assert.match(output, /claude-sonnet-5 review/, 'the kickoff line must name the resolved gate model, proving dispatch reached the anthropic branch, not the gemini default');
    const written = JSON.parse(fs.readFileSync(A_SONNET_FINDINGS_PATH, 'utf8'));
    assert.equal(written.perCommit[0].state, 'not-found');
  } finally {
    fs.rmSync(A_SONNET_FINDINGS_PATH, { force: true, recursive: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('cmdApparatus refuses a gate model with no wired adapter (e.g. an OpenRouter id) before doing any work', () => {
  const output = runCli(['apparatus', '--gate-model', 'qwen/qwen3.8-max', '--commits', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef']);
  assert.match(output, /FATAL:.*openrouter.*no adapter yet/);
});

// ── pre-Phase-3 fixes: budget ceiling + the incumbent GPT pin ──────────────

const LEDGER_PATH = '.audit-loop/solo-control/call-ledger.jsonl';
/** The budget-guard tests need a REAL, locatable commit whose diff reaches the
 * per-cell preflight — i.e. one that is small and clears the egress gate. HEAD
 * is neither reliably: 4a5ec701's own diff carries a deliberate fake AWS key
 * in a test fixture, so the egress gate refused it BEFORE the budget guard
 * could fire and both tests failed on that commit while passing on the one
 * before it (a probe must be representative — the subject is now pinned to a
 * docs-only commit, immutable in a public repo). Absent (shallow clone) ⇒ the
 * test skips by name, never passes vacuously. */
const BUDGET_SUBJECT_SHA = '901348a29a4f626c1efff009ddbfdef66f1e1aaf'; // docs(plans): drop exp5 Arms B/D
const budgetSubjectAvailable = () => spawnSync('git', ['cat-file', '-e', `${BUDGET_SUBJECT_SHA}^{commit}`]).status === 0;
const cleanArtifacts = () => {
  for (const p of [S_FINDINGS_PATH, A_FINDINGS_PATH, LEDGER_PATH]) fs.rmSync(p, { force: true, recursive: true, maxRetries: 3, retryDelay: 50 });
};

test('budget ceiling: cmdRun stops BEFORE any provider call when the ledger already meets the cap — exit 3, the commit recorded budget-exceeded, exactly one refused ledger row', (t) => {
  // A ceiling of 0 is met by an empty ledger (0 >= 0), so the guard trips at the
  // very first cell of a REAL commit with no network access and no spend —
  // exactly the preflight the plan §8 promises.
  if (!budgetSubjectAvailable()) { t.skip(`pinned subject commit ${BUDGET_SUBJECT_SHA.slice(0, 8)} is not in this clone`); return; }
  const sha = BUDGET_SUBJECT_SHA;
  cleanArtifacts();
  try {
    const { output, status } = runCliFull(['run', '--commits', sha, '--force', '--budget-usd', '0'], { scrubKeys: true });
    assert.equal(status, 3, `expected exit 3 (budget), got ${status}:\n${output}`);
    assert.match(output, /BUDGET CEILING/);
    const written = JSON.parse(fs.readFileSync(S_FINDINGS_PATH, 'utf8'));
    const rec = written.perCommit.find((c) => c.sha === sha);
    assert.equal(rec.state, 'budget-exceeded');
    assert.equal(rec.error, 'budget');
    assert.ok(Number.isInteger(rec.expectedCells) && rec.expectedCells > 0, 'the denominator is recorded even for a refused commit');
    const rows = fs.readFileSync(LEDGER_PATH, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(rows.length, 1, 'one row: the refused cell — nothing was sent');
    assert.equal(rows[0].state, 'provider-error');
    assert.equal(rows[0].costUsd, null);
  } finally { cleanArtifacts(); }
});

test('budget ceiling: cmdApparatus has the same guard on its pass cells (exit 3, nothing sent)', (t) => {
  if (!budgetSubjectAvailable()) { t.skip(`pinned subject commit ${BUDGET_SUBJECT_SHA.slice(0, 8)} is not in this clone`); return; }
  const sha = BUDGET_SUBJECT_SHA;
  cleanArtifacts();
  try {
    const { output, status } = runCliFull(['apparatus', '--commits', sha, '--budget-usd', '0'], { scrubKeys: true });
    assert.equal(status, 3, `expected exit 3 (budget), got ${status}:\n${output}`);
    const written = JSON.parse(fs.readFileSync(A_FINDINGS_PATH, 'utf8'));
    assert.equal(written.perCommit.find((c) => c.sha === sha).state, 'budget-exceeded');
    const rows = fs.readFileSync(LEDGER_PATH, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(rows.length, 1);
    // The payer names no sharer: which --gate-only configurations will reuse
    // this cell is unknowable at A's write time. Each sharer credits itself
    // (sharedPassCreditRows) — a hardcoded ['A','A+'] here was wrong the day a
    // third gate candidate was added (2026-09-21).
    assert.equal(rows[0].sharedBy, null, 'the payer writes no guessed sharer list');
    assert.equal(rows[0].arm, 'A');
  } finally { cleanArtifacts(); }
});

test('cmdApparatus pins the incumbent GPT to gpt-5.6-terra by default — the live catalog must not silently upgrade Arm A to a newer, unpriced model', () => {
  // `latest-gpt` resolved to gpt-6-astra via the catalog refresh at the time of
  // writing: unpriced here (=> costUsd:null => A ineligible => inconclusive
  // after real spend) and not the model exp-3 validated the apparatus against.
  cleanArtifacts();
  try {
    const output = runCli(['apparatus', '--commits', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef']);
    assert.match(output, /gpt-5\.6-terra 5-pass/);
    assert.doesNotMatch(output, /astra/);
    const written = JSON.parse(fs.readFileSync(A_FINDINGS_PATH, 'utf8'));
    assert.equal(written.provenance.gptModel, 'gpt-5.6-terra');
    assert.equal(written.provenance.gptModelArg, 'gpt-5.6-terra', 'the manifest records a CONCRETE id, never a sentinel (plan §3)');
  } finally { cleanArtifacts(); }
});

test('cmdApparatus --gate-model gpt-5.6-sol dispatches to the openai gate branch and refuses an unverified tier', () => {
  cleanArtifacts();
  try {
    const { output, status } = runCliFull(['apparatus', '--label', 'A-sol', '--gate-model', 'gpt-5.6-sol', '--commits', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef']);
    assert.equal(status, 0, output);
    assert.match(output, /gpt-5\.6-sol review/);
    assert.doesNotMatch(output, /no adapter yet/);
    const r2 = runCliFull(['apparatus', '--label', 'A-sol', '--gate-model', 'gpt-5.6-sol', '--gate-reasoning-effort', 'xhigh', '--commits', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef']);
    assert.equal(r2.status, 2);
    assert.match(r2.output, /not a openai tier \(valid: low\|medium\|high\)/);
  } finally { cleanArtifacts(); fs.rmSync('.audit-loop/solo-control/S-findings-A-sol.json', { force: true, recursive: true, maxRetries: 3, retryDelay: 50 }); }
});

test('cmdRun refuses a reasoning-effort tier the recipient would silently alias, before any client is built', () => {
  const { output, status } = runCliFull(['run', '--model', 'deepseek-flash', '--label', 'E', '--reasoning-effort', 'xhigh', '--commits', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', '--force']);
  assert.equal(status, 2);
  assert.match(output, /not a deepseek tier \(valid: low\|high\|max\)/);
});

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
  const env = policyPath ? { ...process.env, SOLO_CONTROL_RECIPIENT_POLICY_PATH: policyPath } : process.env;
  const r = spawnSync('node', ['scripts/solo-control-audit.mjs', ...args], { encoding: 'utf8', env });
  return `${r.stdout || ''}${r.stderr || ''}`;
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
  // forces an immediate, network-free 'diff-too-large' short-circuit right
  // after the gate — proving the gate itself let this commit through,
  // without ever reaching runPass (no real provider spend in a test suite).
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const identity = canonicaliseRemoteUrl(execFileSync('git', ['config', '--get', 'remote.origin.url'], { encoding: 'utf8' }).trim());
  fs.rmSync(S_FINDINGS_PATH, { force: true, recursive: true, maxRetries: 3, retryDelay: 50 });
  try {
    withTempPolicyFile({ version: 999, repos: { [identity]: ['anthropic'] } }, (policyPath) => {
      const output = runCli(['run', '--commits', sha, '--force', '--max-diff-chars', '1'], { policyPath });
      assert.doesNotMatch(output, /POLICY REFUSED/);
      const written = JSON.parse(fs.readFileSync(S_FINDINGS_PATH, 'utf8'));
      const record = written.perCommit.find((c) => c.sha === sha);
      assert.equal(record.state, 'diff-too-large', 'proves the policy gate passed and dispatch reached the (network-free) diff-size check next');
    });
  } finally {
    fs.rmSync(S_FINDINGS_PATH, { force: true, recursive: true, maxRetries: 3, retryDelay: 50 });
  }
});

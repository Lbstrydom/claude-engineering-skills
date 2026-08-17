/**
 * @fileoverview The load-bearing suite: the credential preflight must REFUSE.
 *
 * A missing provider key does not error at runtime — `resolveShadow` returns
 * `skipped-no-key`, the arm records as SKIPPED, and the snapshot is rejected
 * only after the other arms have billed. Two snapshots and ~$13 were lost that
 * way on 2026-08-17. So the direction that matters is the one the gate MUST
 * fire in; a suite that only ever asserts the pass direction cannot tell a
 * working gate from an inert one.
 *
 * Env is INJECTED throughout. An ambient `process.env` would make these tests
 * pass or fail by whose machine ran them — and on the author's machine all ten
 * credentials are present, so the refusal branch would never execute.
 *
 * Plan: docs/plans/pinned-revision-fixture.md §4.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  credentialVarsFor,
  requiredCredentials,
  checkCredentials,
  formatMissing,
} from '../scripts/lib/pinned-worktree/preflight.mjs';
import { SHADOW_PROVIDER_SPECS } from '../scripts/lib/final-review/provider-specs.mjs';

/** The six-arm shape of the live scoped campaign, minus everything irrelevant. */
const CAMPAIGN = Object.freeze({
  id: 'final-review-scoped-2026q3',
  arms: [
    { id: 'opus', model: 'claude-opus', mode: 'shadow' },
    { id: 'kimi', model: 'moonshotai/kimi-k2-thinking', mode: 'shadow' },
    { id: 'grok', model: 'grok-4.6', mode: 'shadow' },
    { id: 'qwen', model: 'qwen3.8-max', mode: 'shadow' },
    { id: 'deepseek', model: 'deepseek-v4-pro', mode: 'shadow' },
    { id: 'gemini-control', model: 'gemini-pro-latest', mode: 'shadow' },
  ],
});

/** Every variable the campaign above needs, all present. */
function fullEnv() {
  const env = {
    AUDIT_DB_URL: 'postgresql://x',
    OPENAI_API_KEY: 'k',
    CAMPAIGN_HMAC_KEY_FINAL_REVIEW_SCOPED_2026Q3: 'k',
  };
  for (const req of requiredCredentials({ campaignConfig: CAMPAIGN })) {
    for (const v of req.vars) env[v] ??= 'k';
  }
  return env;
}

describe('credentialVarsFor — names derived from the predicate, never re-listed', () => {
  it('recovers BOTH names of an && predicate (alibaba)', () => {
    // The trap this exists for: a hand-written list that checked only
    // `*_API_KEY` would read green while the arm skipped, because alibaba's
    // hasCredential is `env.A && env.B`. An all-falsy probe alone stops at A.
    assert.deepEqual(
      credentialVarsFor(SHADOW_PROVIDER_SPECS.alibaba),
      ['ALIBABA_CLOUD_API_KEY', 'ALIBABA_CLOUD_BASE_URL'],
    );
  });

  it('recovers BOTH names of an || predicate (openrouter)', () => {
    // Mirror image: an all-truthy probe alone stops at the first alternative.
    assert.deepEqual(
      credentialVarsFor(SHADOW_PROVIDER_SPECS.openrouter),
      ['FINAL_REVIEW_API_KEY', 'OPENROUTER_API_KEY'],
    );
  });

  it('every spec in the table yields at least one variable name', () => {
    // Derived by iterating the TABLE, so a provider added tomorrow is covered
    // without editing this test — the same reason db:enrolment:gate iterates
    // the filesystem rather than a curated list.
    for (const [key, spec] of Object.entries(SHADOW_PROVIDER_SPECS)) {
      assert.ok(credentialVarsFor(spec).length > 0, `${key} yielded no variable names`);
    }
  });
});

describe('the gate FIRES — a missing key refuses before any spend', () => {
  it('refuses when a declared arm has no credential, and names the variable', () => {
    const env = fullEnv();
    delete env.ALIBABA_CLOUD_API_KEY;
    const result = checkCredentials(requiredCredentials({ campaignConfig: CAMPAIGN }), env);
    assert.equal(result.ok, false);
    const names = result.missing.flatMap((m) => m.vars);
    assert.ok(names.includes('ALIBABA_CLOUD_API_KEY'), `expected ALIBABA_CLOUD_API_KEY in ${JSON.stringify(names)}`);
    // The message must name the arm that needs it — "a key is missing" without
    // the arm sends the operator back to checking ten variables by hand.
    assert.match(formatMissing(result), /qwen/);
  });

  it('refuses when only ALIBABA_CLOUD_BASE_URL is missing', () => {
    // The concrete two-variable trap. A preflight that re-spelled the names as
    // "one key per provider" would pass here while the qwen arm skipped.
    const env = fullEnv();
    delete env.ALIBABA_CLOUD_BASE_URL;
    const result = checkCredentials(requiredCredentials({ campaignConfig: CAMPAIGN }), env);
    assert.equal(result.ok, false);
    assert.ok(result.missing.flatMap((m) => m.vars).includes('ALIBABA_CLOUD_BASE_URL'));
  });

  it('refuses for EVERY provider family in the table, one at a time', () => {
    // Per-family coverage derived from the campaign, so adding an arm family
    // cannot silently escape the check.
    const perArm = [
      ['grok-4.6', 'XAI_API_KEY'],
      ['deepseek-v4-pro', 'DEEPSEEK_API_KEY'],
      ['claude-opus', 'ANTHROPIC_API_KEY'],
      ['gemini-pro-latest', 'GEMINI_API_KEY'],
    ];
    for (const [model, variable] of perArm) {
      const campaign = { id: 'solo', arms: [{ id: 'a', model, mode: 'primary' }] };
      const env = { AUDIT_DB_URL: 'x', OPENAI_API_KEY: 'k', CAMPAIGN_HMAC_KEY_SOLO: 'k' };
      for (const req of requiredCredentials({ campaignConfig: campaign })) {
        for (const v of req.vars) env[v] ??= 'k';
      }
      delete env[variable];
      const result = checkCredentials(requiredCredentials({ campaignConfig: campaign }), env);
      assert.equal(result.ok, false, `${model}: absent ${variable} did not refuse`);
      assert.ok(result.missing.flatMap((m) => m.vars).includes(variable), `${model}: ${variable} not named`);
    }
  });

  it('refuses when the campaign HMAC key is absent', () => {
    const env = fullEnv();
    delete env.CAMPAIGN_HMAC_KEY_FINAL_REVIEW_SCOPED_2026Q3;
    const result = checkCredentials(requiredCredentials({ campaignConfig: CAMPAIGN }), env);
    assert.equal(result.ok, false);
    assert.ok(result.missing.flatMap((m) => m.vars).includes('CAMPAIGN_HMAC_KEY_FINAL_REVIEW_SCOPED_2026Q3'));
  });

  it('refuses when the campaign store DSN is absent', () => {
    const env = fullEnv();
    delete env.AUDIT_DB_URL;
    const result = checkCredentials(requiredCredentials({ campaignConfig: CAMPAIGN }), env);
    assert.equal(result.ok, false);
  });
});

describe('the gate does NOT fire when everything is present', () => {
  // The negative control. Without it, a gate that refuses unconditionally
  // would pass every test above — refusing always and refusing correctly are
  // indistinguishable from the firing direction alone.
  it('passes with a fully-populated environment', () => {
    const result = checkCredentials(requiredCredentials({ campaignConfig: CAMPAIGN }), fullEnv());
    assert.equal(result.ok, true, `unexpectedly missing: ${JSON.stringify(result.missing)}`);
    assert.equal(result.missing.length, 0);
  });

  it('checks a non-trivial number of requirements — not vacuously green', () => {
    // A pass over zero requirements is not a pass. The live six-arm campaign
    // resolved 10 on 2026-08-18, matching the ten variables the operator was
    // checking by hand.
    const result = checkCredentials(requiredCredentials({ campaignConfig: CAMPAIGN }), fullEnv());
    assert.ok(result.checked >= 8, `only ${result.checked} requirement(s) checked`);
  });
});

describe('vacuity and unknown-shape refusals', () => {
  it('refuses a campaign with no arms rather than reporting an empty check as a pass', () => {
    assert.throws(
      () => requiredCredentials({ campaignConfig: { id: 'empty', arms: [] } }),
      (err) => /declares no arms/.test(err.message),
    );
  });

  it('refuses a campaign whose arms are missing entirely', () => {
    assert.throws(() => requiredCredentials({ campaignConfig: { id: 'none' } }));
  });

  it('checkCredentials refuses an empty requirement list', () => {
    assert.throws(() => checkCredentials([], {}), (err) => /empty check/.test(err.message));
  });

  it('refuses an arm whose model resolves to no known provider family', () => {
    // `transportForModel` refuses an unknown family rather than guessing a
    // token — surfaced here, where it is free, instead of inside a spawned
    // reviewer after the arm is counted as attempted.
    assert.throws(() => requiredCredentials({
      campaignConfig: { id: 'x', arms: [{ id: 'a', model: '', mode: 'shadow' }] },
    }));
  });
});

describe('secret hygiene', () => {
  it('reports variable NAMES only — never a value', () => {
    const env = fullEnv();
    env.XAI_API_KEY = 'super-secret-value-do-not-log';
    delete env.DEEPSEEK_API_KEY;
    const result = checkCredentials(requiredCredentials({ campaignConfig: CAMPAIGN }), env);
    const rendered = JSON.stringify(result) + formatMissing(result);
    assert.doesNotMatch(rendered, /super-secret-value/);
  });
});

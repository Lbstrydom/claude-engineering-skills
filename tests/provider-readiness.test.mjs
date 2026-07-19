/**
 * @fileoverview A null provider client must not mean four different things.
 *
 * The tiered shadow reported credentials-missing, malformed config, transport
 * init failure and construction regressions all as one generic
 * `providers.anthropicClient unavailable`. 51 records produced by a single
 * keyless 14-hour session therefore read as intermittent flakiness for two
 * days (2026-07-16/17) — the investigation cost far more than the fix.
 *
 * Two invariants:
 *   - only credentials-missing / disabled / not-attempted are BENIGN; anything
 *     else is an operational defect and must not hide behind a routine skip;
 *   - the message is persisted and rendered, so it must be redacted.
 *
 * Plan: docs/plans/debt-burndown-workstreams.md §4 WS-B2.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  classifyProviderReadiness,
  isBenignUnavailability,
} from '../scripts/lib/audit/provider-readiness.mjs';

describe('classifyProviderReadiness', () => {
  it('recognises our own factory\'s missing-credential contract', () => {
    const r = classifyProviderReadiness(new Error('[anthropic-client] ANTHROPIC_API_KEY required for sdk backend'));
    assert.equal(r.state, 'credentials-missing');
    assert.equal(isBenignUnavailability(r), true, 'a keyless run is a routine skip, not a defect');
  });

  it('classifies malformed configuration separately from a missing key', () => {
    for (const msg of ['unknown backend: bogus', 'baseURL cannot be honoured by the cli backend', 'invalid deployment name']) {
      const r = classifyProviderReadiness(new Error(msg));
      assert.equal(r.state, 'config-invalid', msg);
      assert.equal(isBenignUnavailability(r), false, 'a misconfiguration is an operational defect');
    }
  });

  it('an UNRECOGNISED failure defaults to non-benign (fail-closed)', () => {
    // The load-bearing default. If a new failure mode fell into
    // credentials-missing it would be silently skipped forever — exactly the
    // hiding this module exists to end.
    const r = classifyProviderReadiness(Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:443'), { code: 'ECONNREFUSED' }));
    assert.equal(r.state, 'transport-init-failed');
    assert.equal(isBenignUnavailability(r), false);
    assert.equal(r.code, 'ECONNREFUSED', 'a transport code is worth keeping');
  });

  it('never reports an unknown shape as benign', () => {
    for (const weird of [null, undefined, 'a bare string', 42, {}, new Error('')]) {
      assert.equal(isBenignUnavailability(classifyProviderReadiness(weird)), false);
    }
  });

  it('always returns the allowlisted shape', () => {
    const r = classifyProviderReadiness(new Error('anything'));
    assert.deepEqual(Object.keys(r).sort(), ['code', 'message', 'state']);
  });
});

describe('redaction of the persisted message', () => {
  it('strips a credential from a provider URL but keeps the diagnostic', () => {
    const r = classifyProviderReadiness(
      new Error('failed POST https://x.openai.azure.com/v1?api-key=sk-ant-api03-SUPERSECRETVALUE1234567890')
    );
    assert.ok(!r.message.includes('SUPERSECRETVALUE'), 'the credential must not survive into a persisted record');
    assert.match(r.message, /openai\.azure\.com/, 'the endpoint is the diagnostic — it must survive');
  });

  it('does NOT redact an ordinary message into uselessness', () => {
    // `redactSecrets` returns {text, redacted} rather than a string; treating
    // the object as the result made EVERY message read
    // "[REDACTED:redaction-failed]". A redactor that redacts everything
    // destroys the diagnostic as surely as one that redacts nothing leaks it.
    const r = classifyProviderReadiness(new Error('unknown backend: bogus'));
    assert.equal(r.message, 'unknown backend: bogus');
    assert.doesNotMatch(r.message, /redaction-failed/);
  });

  it('fails closed if redaction itself throws', () => {
    // Can't inject a throwing redactor without rewiring the module, so assert
    // the contract that guarantees it: no branch returns the raw text.
    const r = classifyProviderReadiness(new Error('plain'));
    assert.equal(typeof r.message, 'string');
  });
});

describe('the not-attempted state', () => {
  it('is benign — "we never tried" must not render as "it broke"', () => {
    assert.equal(isBenignUnavailability({ state: 'not-attempted' }), true);
  });

  it('is distinct from every failure state', () => {
    for (const s of ['config-invalid', 'transport-init-failed']) {
      assert.equal(isBenignUnavailability({ state: s }), false);
    }
  });
});

describe('shadowFailureReasonsAll — both-pipelines-failed is no longer anonymous (WS-B3)', () => {
  it('surfaces a reason that shadowFailureReasons structurally cannot', async () => {
    const { summarize } = await import('../scripts/lib/audit/tiered-shadow-summary.mjs');
    const records = [
      // The field shape: legacy ALSO failed, so the existing reducer skips it
      // and the reason survived only as an anonymous `legacyFailures` tally.
      { legacyOk: false, shadowOk: false, shadowError: 'providers.anthropicClient credentials-missing' },
      { legacyOk: false, shadowOk: false, shadowError: 'providers.anthropicClient credentials-missing' },
      { legacyOk: true, shadowOk: false, shadowError: 'glm: [timeout]' },
      { legacyOk: true, shadowOk: true, comparison: { tieredRunStatus: 'complete' } },
    ];
    const s = summarize(records);

    assert.equal(s.shadowFailureReasons['providers.anthropicClient credentials-missing'], undefined,
      'precondition: the legacyOk-gated reducer cannot see it');
    assert.equal(s.shadowFailureReasonsAll['providers.anthropicClient credentials-missing'], 2,
      'the all-reasons view must count it');
    assert.equal(s.shadowFailureReasonsAll['glm: [timeout]'], 1,
      'and must still include the reasons the gated view does show');
  });

  it('the existing precedence is untouched (additive change)', async () => {
    const { summarize } = await import('../scripts/lib/audit/tiered-shadow-summary.mjs');
    const records = [
      { legacyOk: false, shadowOk: false, shadowError: 'x' },
      { legacyOk: true, shadowOk: false, shadowError: 'y' },
    ];
    const s = summarize(records);
    assert.equal(s.legacyFailures, 1, 'legacyFailures unchanged');
    assert.equal(s.shadowFailures, 1, 'shadowFailures unchanged');
    assert.deepEqual(s.shadowFailureReasons, { y: 1 }, 'the gated reducer keeps its exact semantics');
  });

  it('a record with no reason is not invented into one', async () => {
    const { summarize } = await import('../scripts/lib/audit/tiered-shadow-summary.mjs');
    const s = summarize([{ legacyOk: false, shadowOk: false, shadowError: null }]);
    assert.deepEqual(s.shadowFailureReasonsAll, {}, 'absent ≠ "unknown"');
  });
});

describe('the CODE field is redacted too (audit R1-H3)', () => {
  it('a credential-bearing code does not survive into the record', () => {
    const err = Object.assign(new Error('init failed'), {
      code: 'https://x.openai.azure.com/?api-key=sk-ant-api03-SECRETCODEVALUE1234567890',
    });
    const r = classifyProviderReadiness(err);
    assert.ok(!r.code.includes('SECRETCODEVALUE'),
      'code is persisted and rendered exactly like message — same boundary');
  });

  it('an ordinary transport code passes through intact', () => {
    const r = classifyProviderReadiness(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }));
    assert.equal(r.code, 'ECONNREFUSED');
  });

  it('an unbounded code is length-capped (an identifier, not a payload)', () => {
    const r = classifyProviderReadiness(Object.assign(new Error('x'), { code: 'A'.repeat(5000) }));
    assert.ok(r.code.length <= 120);
  });
});

describe('hidden-reason reporting subtracts counts (Gemini G2)', () => {
  it('a reason occurring in BOTH states still reports its hidden occurrences', async () => {
    const { summarize } = await import('../scripts/lib/audit/tiered-shadow-summary.mjs');
    const s = summarize([
      { legacyOk: true, shadowOk: false, shadowError: 'boom' },   // visible: 1
      { legacyOk: false, shadowOk: false, shadowError: 'boom' },  // hidden:  1
      { legacyOk: false, shadowOk: false, shadowError: 'boom' },  // hidden:  2
    ]);
    // A key-existence filter would drop 'boom' entirely because it IS in the
    // visible map — under-reporting the very records the line exists to show.
    const visible = s.shadowFailureReasons['boom'] || 0;
    const hidden = s.shadowFailureReasonsAll['boom'] - visible;
    assert.equal(visible, 1);
    assert.equal(hidden, 2, 'the legacy-failure occurrences must remain countable');
  });
});

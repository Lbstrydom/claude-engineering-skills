/**
 * @fileoverview The PASS-GRANTING half of the gate registry, validated.
 *
 * `loadContracts` (the half that PROVES a gate can fail) is schema-validated
 * through the shared loader and throws on divergence. `loadExemptions` — the half
 * that GRANTS A PASS — was `JSON.parse(...).exempt ?? {}`, so `""`, `true`, `null`
 * or `{}` was accepted as a reason and silently exempted a gate with nothing
 * written down. An asymmetry in that direction is the fake-check class this file
 * exists to catch, in its own bookkeeping.
 *
 * Plan: docs/plans/gate-honesty-adjudicated-defects.md (D3, D6).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  loadExemptions, forbiddenNewExemptions, verifyExemptionProvenance, POLICY_CUTOFF,
} from '../scripts/check-gate-poison-pills.mjs';

const VALID = { reason: 'covered elsewhere', gateAddedAt: '2026-05-01', gateAddedAtSource: 'git-log-S' };

/** Write an exemption registry to a temp file and load it. */
function loadWith(exempt) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exempt-'));
  const file = path.join(dir, '_exemptions.json');
  fs.writeFileSync(file, JSON.stringify({ exempt }, null, 2));
  // Retry-hardened per the repo-wide guard (tests/rmsync-retry-guard.test.mjs):
  // on Windows a just-read file can still be held, and a bare rmSync throws EBUSY.
  try { return loadExemptions(file); } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
}

describe('loadExemptions — a pass must be explained', () => {
  test('accepts a well-formed entry', () => {
    assert.equal(Object.keys(loadWith({ 'docs:check': VALID })).length, 1);
  });

  test('rejects every shape that used to grant a silent pass', () => {
    // The four values the bare `JSON.parse` accepted verbatim.
    for (const bad of ['', true, null, {}]) {
      assert.throws(
        () => loadWith({ 'docs:check': bad }),
        /invalid gate exemption/,
        `${JSON.stringify(bad)} must not exempt a gate`,
      );
    }
  });

  test('rejects a blank or whitespace-only reason', () => {
    for (const reason of ['', '   ', '\n']) {
      assert.throws(() => loadWith({ 'docs:check': { ...VALID, reason } }), /non-empty string/);
    }
  });

  test('names the offending key, and reports EVERY divergence in one run', () => {
    // A loader that reports one problem per run turns a 17-entry migration into
    // 17 runs — same reason loadContracts lists all its divergences.
    try {
      loadWith({ 'a:one': { ...VALID, reason: '' }, 'b:two': { ...VALID, gateAddedAt: 'nope' } });
      assert.fail('expected a throw');
    } catch (err) {
      assert.match(err.message, /a:one/);
      assert.match(err.message, /b:two/);
    }
  });
});

describe('gateAddedAt — a date, not a vibe', () => {
  test('rejects a malformed or impossible date rather than defaulting to grandfathered', () => {
    // Defaulting a missing date to "old" is the fail-open direction: the ratchet's
    // only predicate is this field, so an absent one must fail, not pass.
    for (const bad of [undefined, null, '2026-8-1', '2026/08/01', '2026-02-30', 'yesterday', 20260801]) {
      assert.throws(
        () => loadWith({ 'docs:check': { ...VALID, gateAddedAt: bad } }),
        /gateAddedAt/,
        `${JSON.stringify(bad)} is not a calendar date`,
      );
    }
  });

  test('rejects an unknown provenance source', () => {
    assert.throws(() => loadWith({ 'docs:check': { ...VALID, gateAddedAtSource: 'i-made-it-up' } }), /gateAddedAtSource/);
    assert.throws(() => loadWith({ 'docs:check': { ...VALID, gateAddedAtSource: undefined } }), /gateAddedAtSource/);
  });
});

describe('forbiddenNewExemptions — the mandatory-pill ratchet', () => {
  test('a gate added AFTER the cutoff cannot simply be exempted', () => {
    const found = forbiddenNewExemptions({ 'new:gate': { ...VALID, gateAddedAt: '2026-08-05' } });
    assert.deepEqual(found, [{ key: 'new:gate', gateAddedAt: '2026-08-05' }]);
  });

  test('the cutoff date itself is forbidden — "after 2026-07-31" includes it', () => {
    assert.equal(forbiddenNewExemptions({ g: { ...VALID, gateAddedAt: POLICY_CUTOFF } }).length, 1);
  });

  test('a grandfathered gate passes', () => {
    assert.deepEqual(forbiddenNewExemptions({ old: { ...VALID, gateAddedAt: '2026-07-30' } }), []);
  });

  test('an explicit policyOverride is the ONLY escape, and must say something', () => {
    const post = { ...VALID, gateAddedAt: '2026-08-05' };
    assert.equal(forbiddenNewExemptions({ g: { ...post, policyOverride: 'circular: the pill-runner cannot pill itself' } }).length, 0);
    // A blank override is not an override — it is the empty-reason hole one level up.
    for (const blank of ['', '  ']) {
      assert.equal(forbiddenNewExemptions({ g: { ...post, policyOverride: blank } }).length, 1);
    }
  });

  test('lexicographic comparison, so no timezone can move the boundary', () => {
    // ISO-8601 dates sort correctly as strings; going through `Date` would make
    // the verdict depend on the runner's offset.
    assert.equal(forbiddenNewExemptions({ g: { ...VALID, gateAddedAt: '2026-12-31' } }).length, 1);
    assert.equal(forbiddenNewExemptions({ g: { ...VALID, gateAddedAt: '2025-01-01' } }).length, 0);
  });
});

describe('the real registry satisfies its own schema', () => {
  test('all committed exemptions load, and none is forbidden without an override', () => {
    const real = loadExemptions();
    assert.ok(Object.keys(real).length > 0, 'the registry should not be empty');
    assert.deepEqual(forbiddenNewExemptions(real), [],
      'a post-cutoff exemption needs a policyOverride — add one deliberately, or pill the gate');
  });
});

describe('verifyExemptionProvenance — the date is checked, not trusted', () => {
  // Audit clusterB-H2/H3: without this, `gateAddedAtSource: "git-log-S"` is a
  // LABEL asserting a provenance nothing verifies — a stated-but-unenforced
  // claim inside the change whose subject is stated-but-unenforced claims.
  const entry = (over = {}) => ({ reason: 'r', gateAddedAt: '2026-05-01', gateAddedAtSource: 'git-log-S', ...over });
  const gitSaying = (dates) => () => ({ status: 0, stdout: dates.join('\n'), error: null });

  test('a claimed date git does not support is a divergence', () => {
    const r = verifyExemptionProvenance({ 'a:gate': entry() }, { run: gitSaying(['2026-07-16']) });
    assert.deepEqual(r.divergences, [{ key: 'a:gate', claimed: '2026-05-01', derived: '2026-07-16' }]);
  });

  test('the OLDEST commit is the gate\u2019s birth, not the newest', () => {
    // git log lists newest-first; the introduction is the last line.
    const r = verifyExemptionProvenance({ 'a:gate': entry({ gateAddedAt: '2026-05-01' }) },
      { run: gitSaying(['2026-08-01', '2026-06-01', '2026-05-01']) });
    assert.deepEqual(r.divergences, [], 'the oldest date matched, so there is no divergence');
  });

  test('an agreeing date produces no divergence', () => {
    const r = verifyExemptionProvenance({ 'a:gate': entry() }, { run: gitSaying(['2026-05-01']) });
    assert.deepEqual(r.divergences, []);
    assert.deepEqual(r.unverified, []);
  });

  test('"we could not check" is UNVERIFIED, never agreement', () => {
    // Each of these used to be indistinguishable from a pass.
    const cases = [
      ['git missing', () => ({ error: new Error('ENOENT'), status: null })],
      ['git non-zero', () => ({ status: 128, stdout: '', error: null })],
      ['no history for the key', gitSaying([])],
    ];
    for (const [label, run] of cases) {
      const r = verifyExemptionProvenance({ 'a:gate': entry() }, { run });
      assert.deepEqual(r.divergences, [], `${label}: must not invent a divergence`);
      assert.equal(r.unverified.length, 1, `${label}: must be reported as unverified`);
    }
  });

  test('a non-git source is unverified rather than silently accepted', () => {
    const r = verifyExemptionProvenance({ 'a:gate': entry({ gateAddedAtSource: 'unknown' }) }, { run: gitSaying(['2026-05-01']) });
    assert.equal(r.unverified.length, 1);
    assert.deepEqual(r.divergences, []);
  });

  test('the REAL registry agrees with git', () => {
    // The migration derived every date from package.json history; this is the
    // check that it stays true, and that a hand-edited date gets caught.
    const { divergences } = verifyExemptionProvenance(loadExemptions());
    assert.deepEqual(divergences, [], 'a committed gateAddedAt disagrees with package.json history');
  });
});

test('a whitespace-only disposition is not a justification (audit clusterB-M3)', async () => {
  // `.min(1)` admitted "   " and "\n": length is not content, and the surrounding
  // comment already said a disposition IS the written reason.
  const { DetectorSchema } = await import('../scripts/lib/audit/detector.mjs');
  const parse = (v) => DetectorSchema.safeParse({ kind: 'regex', pattern: 'x', globs: ['a/**'], disposition: { k: v } }).success;
  assert.equal(parse('exempt — temp file'), true);
  for (const blank of ['', ' ', '   ', '\n', '\t']) {
    assert.equal(parse(blank), false, `${JSON.stringify(blank)} must not disposition a match`);
  }
});

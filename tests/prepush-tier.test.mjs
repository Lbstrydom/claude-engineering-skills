/**
 * @fileoverview The sandbox's tiered check run (scripts/lib/prepush-tier.mjs; docs/plans/gate-cost-slice-2.md sections
 * 2.2-2.5 and 13), driven with an injected `run` so each case is milliseconds: the order of the steps, every fallback to
 * full, the legacy path, and the ONE summary line.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sandboxTierSupport, runTieredChecks } from '../scripts/lib/prepush-tier.mjs';
import { parseSummary } from '../scripts/lib/test-tier.mjs';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const ENV_PATH = '/tmp/env.json';
const heavy = (file, reached) => ({ file, reached, via: reached ? ['x'] : [] });
const LIST = { version: 1, maxAgeDays: 30, heavyThresholdMs: 1000, heavy: ['tests/fleet-a.test.mjs', 'tests/fleet-b.test.mjs'].map((file) => ({ file, why: 'a heavy family member', measuredMs: 5, measuredAt: '2026-10-13', reach: ['x/**'] })) };
const envelope = (over = {}) => ({
  version: 'test-tier/v1', kind: 'push', tier: 'full', requested: 'full', requestedRaw: null, head: HEAD, base: BASE, baseSource: 'merge-base:origin/main',
  asOf: '2026-10-13T00:00:00.000Z', escapes: [], heavy: [heavy('tests/fleet-a.test.mjs', false), heavy('tests/fleet-b.test.mjs', true)],
  wouldSkip: ['tests/fleet-a.test.mjs'], skipped: [], ...over,
});
const SUPPORT = { ok: true };

/** A scripted harness: `plan` answers per case; every call is recorded in order. */
function harness({ planStatus = 0, envelopeText = JSON.stringify(envelope()), statuses = {}, files = {} } = {}) {
  const calls = [];
  const logs = [];
  const store = { '.test-tiers.json': JSON.stringify(LIST), [ENV_PATH]: envelopeText, ...files };
  const run = (kind, args) => {
    calls.push([kind, ...args]);
    if (kind === 'node' && args[1] === 'plan') return { status: planStatus };
    const key = kind === 'npm' ? args.join(' ') : args[0];
    return { status: statuses[key] ?? 0 };
  };
  return { calls, logs, run, readText: (p) => store[p] ?? null, log: (l) => logs.push(l) };
}
const go = (h, over = {}) => runTieredChecks({ head: HEAD, tier: '', pushesDefault: false, support: SUPPORT, run: h.run, readText: h.readText, envelopePath: ENV_PATH, log: h.log, ...over });
const names = (h) => h.calls.map((c) => (c[0] === 'npm' ? `npm ${c.slice(1).join(' ')}` : `node ${c.slice(1, 3).join(' ')}`));

describe('sandboxTierSupport (D7b): the SANDBOX decides whether the tiered path exists', () => {
  const full = { 'package.json': JSON.stringify({ scripts: { 'check:static': 'x' } }), 'scripts/run-tests.mjs': "export const TIER_PROTOCOL = 'test-tier/v1';" };
  const present = new Set(['scripts/lib/test-tier.mjs', 'scripts/lib/test-tier-git.mjs', 'scripts/test-tier.mjs', '.test-tiers.json']);
  const probe = (files = full, exists = present) => sandboxTierSupport({ readText: (p) => files[p] ?? null, exists: (p) => exists.has(p) });
  it('supported when everything is there', () => assert.deepEqual(probe(), { ok: true }));
  it('each missing piece makes it unsupported, with its own reason', () => {
    assert.match(probe({ ...full, 'package.json': JSON.stringify({ scripts: {} }) }).reason, /no check:static/);
    assert.match(probe({ ...full, 'package.json': '{' }).reason, /no check:static/);
    for (const f of present) assert.match(probe(full, new Set([...present].filter((x) => x !== f))).reason, new RegExp(f.replace(/[.]/g, '\\.')));
    assert.match(probe({ ...full, 'scripts/run-tests.mjs': 'export const x = 1;' }).reason, /TIER_PROTOCOL/);
    assert.match(probe({ ...full, 'scripts/run-tests.mjs': undefined }).reason, /TIER_PROTOCOL/);
  });
});

describe('runTieredChecks', () => {
  it('stage 0: static gates, then the oracle, then the FULL suite, with the shadow line; the summary says full/default', () => {
    const h = harness();
    const r = go(h);
    assert.deepEqual(names(h), ['npm run check:static', 'node scripts/test-tier.mjs plan', 'npm test']);
    assert.equal(r.status, 0);
    assert.match(h.logs.join('\n'), /test-tier\/v1 shadow: would skip 1 of 2 heavy file\(s\) \(1 reached by this diff\)/);
    assert.deepEqual(parseSummary(r.summary, HEAD), { ok: true, tier: 'full', head: HEAD, skipped: 0, base: BASE, reason: 'default' });
  });

  it('the oracle is asked for exactly the head, the tier request and the push-time inputs', () => {
    const h = harness();
    go(h, { tier: 'branch', pushesDefault: true });
    const plan = h.calls.find((c) => c[0] === 'node');
    assert.deepEqual(plan.slice(1), ['scripts/test-tier.mjs', 'plan', '--head', HEAD, '--out', ENV_PATH, '--tier', 'branch', '--pushes-default']);
    const h2 = harness();
    go(h2);
    assert.ok(!h2.calls.find((c) => c[0] === 'node').includes('--tier'), 'no request: no --tier');
  });

  it('stage 1: an opt-in branch envelope runs the tiered runner on the envelope, not npm test, and the summary says branch', () => {
    const e = envelope({ tier: 'branch', requested: 'branch', requestedRaw: 'branch', skipped: ['tests/fleet-a.test.mjs'] });
    const h = harness({ envelopeText: JSON.stringify(e) });
    const r = go(h, { tier: 'branch' });
    assert.deepEqual(names(h), [
      'npm run check:static',
      'node scripts/test-tier.mjs plan',
      'node scripts/run-tests.mjs --tier-skip',
    ]);
    assert.deepEqual(h.calls[2].slice(1), ['scripts/run-tests.mjs', '--tier-skip', ENV_PATH]);
    assert.match(h.logs.join('\n'), /BRANCH TIER — not the full suite\. Skipped 1 heavy file/);
    assert.deepEqual(parseSummary(r.summary, HEAD), { ok: true, tier: 'branch', head: HEAD, skipped: 1, base: BASE, reason: null });
  });

  describe('an envelope that disagrees with the request is the FULL suite (audit H1)', () => {
    const branchEnv = (over = {}) => envelope({ tier: 'branch', requested: 'branch', requestedRaw: 'branch', skipped: ['tests/fleet-a.test.mjs'], ...over });
    const cases = {
      'a branch envelope on a push to the default branch': [branchEnv(), { tier: 'branch', pushesDefault: true }, /updates the default branch/],
      'a branch envelope for a request that was not branch': [branchEnv(), { tier: '', pushesDefault: false }, /request of "the default"/],
      'a branch envelope for an explicit full request': [branchEnv(), { tier: 'full', pushesDefault: false }, /request of "full"/],
      'a branch envelope that lists an escape': [branchEnv({ escapes: [{ id: 'forced-full', detail: 'x' }] }), { tier: 'branch', pushesDefault: false }, /lists escape/],
    };
    for (const [name, [env, req, why]] of Object.entries(cases)) {
      it(name, () => {
        const h = harness({ envelopeText: JSON.stringify(env) });
        const r = go(h, req);
        assert.ok(!names(h).some((n) => n.includes('--tier-skip')), 'never a tiered run');
        assert.deepEqual(names(h).slice(-1), ['npm test']);
        assert.match(h.logs.join('\n'), why);
        assert.equal(parseSummary(r.summary, HEAD).reason, 'selector-failed');
        assert.equal(parseSummary(r.summary, HEAD).tier, 'full');
      });
    }
    it('control: the same envelope for a matching request IS a tiered run', () => {
      const h = harness({ envelopeText: JSON.stringify(branchEnv()) });
      go(h, { tier: 'branch', pushesDefault: false });
      assert.ok(names(h).some((n) => n.includes('--tier-skip')));
    });
  });

  describe('this repo\'s committed default tier: an EMPTY request runs the branch tier (docs/plans/ci-full-suite-actions.md D3-D4)', () => {
    const CES_LIST = { ...LIST, defaultTier: 'branch', ciVerdict: { workflow: '.github/workflows/full-suite.yml' } };
    const defaultEnv = (over = {}) => envelope({ tier: 'branch', requested: 'branch', requestedRaw: null, defaultSource: 'list', skipped: ['tests/fleet-a.test.mjs'], ...over });
    it('with the default in the list, no request is a tiered run and the summary is branch', () => {
      const h = harness({ envelopeText: JSON.stringify(defaultEnv()), files: { '.test-tiers.json': JSON.stringify(CES_LIST) } });
      const r = go(h, { tier: '' });
      assert.ok(names(h).some((n) => n.includes('--tier-skip')), names(h).join(' | '));
      assert.deepEqual(parseSummary(r.summary, HEAD), { ok: true, tier: 'branch', head: HEAD, skipped: 1, base: BASE, reason: null });
    });
    it('control: the SAME envelope with a list that has no default is the full suite (an envelope cannot invent the default)', () => {
      const h = harness({ envelopeText: JSON.stringify(defaultEnv()) });
      const r = go(h, { tier: '' });
      assert.ok(!names(h).some((n) => n.includes('--tier-skip')));
      assert.equal(parseSummary(r.summary, HEAD).tier, 'full');
      assert.equal(parseSummary(r.summary, HEAD).reason, 'selector-failed');
    });
    it('an explicit full request, or a push to the default branch, is still full under the list default', () => {
      const files = { '.test-tiers.json': JSON.stringify(CES_LIST) };
      const forced = harness({ envelopeText: JSON.stringify(envelope({ requested: 'full', requestedRaw: 'full', escapes: [{ id: 'forced-full', detail: 'x' }] })), files });
      assert.equal(parseSummary(go(forced, { tier: 'full' }).summary, HEAD).tier, 'full');
      const pushed = harness({ envelopeText: JSON.stringify(defaultEnv()), files });
      const r = go(pushed, { tier: '', pushesDefault: true });
      assert.equal(parseSummary(r.summary, HEAD).tier, 'full', 'a branch envelope on a push to the default branch is refused');
    });
  });

  it('a push that updates the default branch is full even when branch was asked, and the summary names why', () => {
    const e = envelope({ requested: 'branch', requestedRaw: 'branch', escapes: [{ id: 'pushes-default', detail: 'x' }] });
    const h = harness({ envelopeText: JSON.stringify(e) });
    const r = go(h, { tier: 'branch', pushesDefault: true });
    assert.deepEqual(names(h).slice(-1), ['npm test']);
    assert.equal(parseSummary(r.summary, HEAD).reason, 'pushes-default');
    assert.equal(parseSummary(r.summary, HEAD).tier, 'full');
  });

  it('a failing static gate stops BEFORE the oracle and any test; no summary is claimed', () => {
    const h = harness({ statuses: { 'run check:static': 1 } });
    const r = go(h);
    assert.deepEqual(names(h), ['npm run check:static']);
    assert.deepEqual([r.status, r.summary], [1, null]);
  });

  it('a failing test run blocks and claims no summary (control: the same harness passes when the tests pass)', () => {
    assert.deepEqual([go(harness({ statuses: { test: 1 } })).summary, go(harness()).summary === null], [null, false]);
    assert.equal(go(harness({ statuses: { test: 1 } })).status, 1);
    const tier = envelope({ tier: 'branch', requested: 'branch', requestedRaw: 'branch', skipped: ['tests/fleet-a.test.mjs'] });
    const h = harness({ envelopeText: JSON.stringify(tier), statuses: { 'scripts/run-tests.mjs': 1 } });
    assert.equal(go(h, { tier: 'branch' }).status, 1);
  });

  it('a status whose low byte is zero is a failure, never a pass', () => {
    assert.equal(go(harness({ statuses: { test: 256 } })).status, 1);
  });

  describe('the selector failing in any way is the FULL suite with the reason printed (guard 4)', () => {
    const cases = {
      'the selector exits non-zero': { planStatus: 1 },
      'the envelope is missing': { envelopeText: undefined, files: { [ENV_PATH]: null } },
      'the envelope is not JSON': { envelopeText: '{' },
      'the envelope has the wrong version': { envelopeText: JSON.stringify({ ...envelope(), version: 'test-tier/v0' }) },
      'the envelope skips a file that is not on the list': { envelopeText: JSON.stringify(envelope({ tier: 'branch', skipped: ['tests/light.test.mjs'] })) },
      'the envelope skips a file the diff reaches': { envelopeText: JSON.stringify(envelope({ tier: 'branch', skipped: ['tests/fleet-b.test.mjs'] })) },
      'the envelope is for another head': { envelopeText: JSON.stringify(envelope({ head: 'c'.repeat(40) })) },
      'the heavy list is unreadable': { files: { '.test-tiers.json': '{' } },
    };
    for (const [name, opts] of Object.entries(cases)) {
      it(name, () => {
        const h = harness(opts);
        const r = go(h, { tier: 'branch' });
        assert.deepEqual(names(h).slice(-1), ['npm test'], 'ran the full suite');
        assert.ok(!names(h).some((n) => n.includes('--tier-skip')), 'never a tiered run');
        assert.match(h.logs.join('\n'), /selector failed, so the FULL suite runs/);
        assert.equal(parseSummary(r.summary, HEAD).reason, 'selector-failed');
      });
    }
    it('a throwing run adapter is also full', () => {
      const h = harness();
      const run = (kind, args, o) => { if (kind === 'node') throw new Error('spawn exploded'); return h.run(kind, args, o); };
      const r = go(h, { run });
      assert.match(h.logs.join('\n'), /the selector threw: spawn exploded/);
      assert.equal(parseSummary(r.summary, HEAD).reason, 'selector-failed');
    });
  });

  it('a head that predates the tier runs the legacy `npm run check` unchanged and says so (D7b)', () => {
    const h = harness();
    const r = go(h, { support: { ok: false, reason: 'package.json has no check:static' } });
    assert.deepEqual(names(h), ['npm run check']);
    assert.match(h.logs.join('\n'), /predates the test tier/);
    assert.deepEqual(parseSummary(r.summary, HEAD), { ok: true, tier: 'full', head: HEAD, skipped: 0, base: null, reason: 'head-predates-tier' });
    assert.equal(go(harness({ statuses: { 'run check': 1 } }), { support: { ok: false, reason: 'x' } }).status, 1);
  });

  it('a spawn error is thrown for the caller (a sandbox that cannot run is not a pass)', () => {
    const run = () => ({ status: null, error: new Error('ENOENT') });
    assert.throws(() => go(harness(), { run }), /could not run checks: ENOENT/);
  });
});

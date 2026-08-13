/**
 * Tier-1 tests for the one-command experiment toggle (operator request
 * 2026-07-02). File I/O uses a temp repo root — nothing touches the real
 * `.audit-loop/`.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { readToggle, writeToggle, resolveShadowArmsWithToggle, TOGGLE_RELPATH, TOGGLE_SHADOW_ARMS } from '../scripts/lib/arm-eval/toggle.mjs';

let root;
before(() => { root = mkdtempSync(path.join(tmpdir(), 'arm-eval-toggle-')); });
after(() => { rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

describe('toggle read/write', () => {
  it('absent file → disabled (fail-closed OFF, present:false)', () => {
    const t = readToggle({ repoRoot: root });
    assert.deepEqual(t, {
      enabled: false, budgetEur: null, enabledAt: null, present: false,
      // `state` distinguishes this from a file that exists but is broken —
      // both refuse to spend, and only one of them warrants investigation.
      state: 'absent', reason: null,
    });
  });
  it('on → enabled with budget + timestamp; off → disabled', () => {
    const on = writeToggle({ repoRoot: root, enabled: true, budgetEur: 300 });
    assert.equal(on.enabled, true);
    assert.equal(on.budgetEur, 300);
    assert.ok(on.enabledAt, 'enabledAt stamped');
    const off = writeToggle({ repoRoot: root, enabled: false });
    assert.equal(off.enabled, false);
    assert.equal(off.budgetEur, null);
  });
  it('malformed JSON → disabled (never a surprise spend)', () => {
    const p = path.join(root, TOGGLE_RELPATH);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, '{not json');
    assert.equal(readToggle({ repoRoot: root }).enabled, false);
  });
  // --- audit 2026-08-13 (H1/M7/M10/M11/L3): the toggle is durable control-plane
  // state and was decoded by coercion. The test this block replaces asserted
  // `-5 → null` under the comment "downstream refusal still applies — no
  // negative ceiling". That belief was FALSE: cross-skill/commands/model-eval.mjs
  // reads `t.budgetEur ?? armEvalConfig.budgetEur`, so null is the €300 DEFAULT.
  // The old behaviour turned a typo into a larger cap than the operator typed.

  it('an invalid budget is REFUSED by the writer, never coerced to null', () => {
    for (const bad of [-5, 0, Number.NaN, Number.POSITIVE_INFINITY, '300']) {
      assert.throws(
        () => writeToggle({ repoRoot: root, enabled: true, budgetEur: bad }),
        RangeError,
        `writeToggle must refuse budgetEur=${JSON.stringify(bad)} — coercing it to null RAISES the cap to the default`,
      );
    }
  });

  it('an explicit null budget is still legal (means: use the configured default)', () => {
    const t = writeToggle({ repoRoot: root, enabled: true, budgetEur: null });
    assert.equal(t.enabled, true);
    assert.equal(t.budgetEur, null);
    assert.equal(t.state, 'ok');
  });

  it('a numeric-PREFIX budget on disk is malformed, not 300 (parseFloat trap)', () => {
    const p = path.join(root, TOGGLE_RELPATH);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ enabled: true, budgetEur: '300EUR-typo', enabledAt: null }));
    const t = readToggle({ repoRoot: root });
    assert.equal(t.enabled, false, 'fail-closed');
    assert.equal(t.budgetEur, null);
    assert.equal(t.state, 'malformed', 'parseFloat would have decoded this to a valid 300');
  });

  it('read outcomes are DISTINGUISHABLE: absent vs malformed', () => {
    const fresh = mkdtempSync(path.join(tmpdir(), 'arm-eval-toggle-states-'));
    try {
      assert.equal(readToggle({ repoRoot: fresh }).state, 'absent');
      const p = path.join(fresh, TOGGLE_RELPATH);
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, '{not json');
      const bad = readToggle({ repoRoot: fresh });
      assert.equal(bad.state, 'malformed');
      assert.ok(bad.reason, 'a malformed toggle must say why — that is the whole point');
      // Both refuse to spend; only the reason differs. Asserting BOTH directions
      // is the point: collapsing them is the defect (audit M10).
      assert.equal(bad.enabled, false);
    } finally {
      rmSync(fresh, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('enabledAt cannot outlive enabled (L3)', () => {
    const p = path.join(root, TOGGLE_RELPATH);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ enabled: 'false', budgetEur: 50, enabledAt: '2026-01-01T00:00:00.000Z' }));
    const t = readToggle({ repoRoot: root });
    assert.equal(t.enabled, false);
    assert.equal(t.enabledAt, null, 'a disabled toggle must not carry an enable timestamp');
  });

  it('NEGATIVE CONTROL: a valid toggle still reads back enabled with its budget', () => {
    // Without this, a decoder stuck at "always malformed" passes every test above.
    const t = writeToggle({ repoRoot: root, enabled: true, budgetEur: 42.5 });
    assert.equal(t.enabled, true);
    assert.equal(t.budgetEur, 42.5);
    assert.equal(t.state, 'ok');
    assert.ok(t.enabledAt, 'an enabled toggle carries its enable timestamp');
  });
});

describe('resolveShadowArmsWithToggle — precedence', () => {
  it('env WINS over the toggle (kill switch / custom arm set)', () => {
    writeToggle({ repoRoot: root, enabled: true, budgetEur: 300 });
    const r = resolveShadowArmsWithToggle({ AUDIT_MODEL_SHADOW: 'B' }, { repoRoot: root });
    assert.equal(r.source, 'env');
    assert.deepEqual(r.requested, ['B'], 'env arm set used verbatim, not the toggle B,C');
  });
  it('env unset + toggle ON → canonical shadow set B,C', () => {
    writeToggle({ repoRoot: root, enabled: true, budgetEur: 300 });
    const r = resolveShadowArmsWithToggle({}, { repoRoot: root });
    assert.equal(r.source, 'toggle');
    assert.equal(r.enabled, true);
    assert.deepEqual(r.requested, TOGGLE_SHADOW_ARMS.split(','));
  });
  it('env unset + toggle OFF → inert (byte-identical pre-toggle path)', () => {
    writeToggle({ repoRoot: root, enabled: false });
    const r = resolveShadowArmsWithToggle({}, { repoRoot: root });
    assert.equal(r.source, 'off');
    assert.equal(r.enabled, false);
    assert.deepEqual(r.arms, []);
  });
  it('env unset + no toggle file at all → inert', () => {
    const empty = mkdtempSync(path.join(tmpdir(), 'arm-eval-toggle-empty-'));
    try {
      const r = resolveShadowArmsWithToggle({}, { repoRoot: empty });
      assert.equal(r.enabled, false);
      assert.equal(r.source, 'off');
    } finally { rmSync(empty, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });
});

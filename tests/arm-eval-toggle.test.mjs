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
    assert.deepEqual(t, { enabled: false, budgetEur: null, enabledAt: null, present: false });
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
  it('a non-positive / garbage budget is normalized to null', () => {
    const t = writeToggle({ repoRoot: root, enabled: true, budgetEur: -5 });
    assert.equal(t.enabled, true);
    assert.equal(t.budgetEur, null, 'downstream refusal still applies — no negative ceiling');
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

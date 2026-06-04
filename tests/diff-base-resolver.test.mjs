/**
 * @fileoverview Tier-1 (deterministic-seam) regression for the `--scope diff`
 * base resolver in openai-audit.mjs.
 *
 * Origin: ai-organiser audit over-capture — a blind `HEAD~1` default re-pulled
 * an already-shipped+audited commit into scope (33/34 findings out-of-scope).
 * The fix is a dirty-aware default; this pins the decision table so it cannot
 * silently regress to the over-capturing behaviour.
 *
 * The git subprocess (`git status --porcelain`) is NOT exercised here — only
 * the pure decision (explicit-base precedence + dirty→HEAD / clean→HEAD~1).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.AUDIT_EXPORTS_FOR_TESTS = '1';
const audit = await import('../scripts/openai-audit.mjs');
const { resolveDiffBase } = audit.__testExports;

describe('resolveDiffBase — dirty-aware --scope diff base', () => {
  it('explicit --base always wins, regardless of dirty state', () => {
    assert.equal(resolveDiffBase('abc1234', true), 'abc1234');
    assert.equal(resolveDiffBase('abc1234', false), 'abc1234');
    assert.equal(resolveDiffBase('clusterStartRef', true), 'clusterStartRef');
  });

  it('dirty working tree → HEAD (audit uncommitted work only)', () => {
    assert.equal(resolveDiffBase(null, true), 'HEAD');
  });

  it('clean working tree → HEAD~1 (audit the last commit)', () => {
    assert.equal(resolveDiffBase(null, false), 'HEAD~1');
  });

  it('the over-capture regression: a null base must NOT yield HEAD~1 when dirty', () => {
    // This is the exact bug — a dirty tree resolving to HEAD~1 re-includes the
    // prior (already-audited) commit. Guard against any future reintroduction.
    assert.notEqual(resolveDiffBase(null, true), 'HEAD~1');
  });
});

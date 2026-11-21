/**
 * A round audited with an explicit `--files` allowlist AND `--base` records `_diffBase`, so the final reviewer can rebuild the
 * round's hunks (CES verification-lessons: /cycle's documented cluster command passes `--files`, and its rounds reached the final
 * gate with no diff base, reading `Code: PARTIAL … no diff evidence`).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { diffBaseToStamp, resolveAllowlistBase, stampAuditRound } from '../scripts/lib/finalize-outcomes.mjs';

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

describe('diffBaseToStamp — which base a round records', () => {
  it('a scope-diff round records its base (unchanged behaviour)', () => {
    assert.equal(diffBaseToStamp({ coverageChanged: ['x.mjs'], auditBaseCommit: SHA }), SHA);
  });
  it('an --files round with a validated --base records it', () => {
    assert.equal(diffBaseToStamp({ coverageChanged: null, explicitBaseResolved: true, auditBaseCommit: SHA }), SHA);
  });
  it('negative control: an --files round WITHOUT --base records nothing (the provisional HEAD~1 is never a base)', () => {
    assert.equal(diffBaseToStamp({ coverageChanged: null, explicitBaseResolved: false, auditBaseCommit: 'HEAD~1' }), null);
    assert.equal(diffBaseToStamp({ coverageChanged: null, auditBaseCommit: SHA }), null);
  });
  it('a non-sha base is never stamped, whatever the flags', () => {
    assert.equal(diffBaseToStamp({ explicitBaseResolved: true, auditBaseCommit: 'origin/main' }), null);
  });
  it('end to end through stampAuditRound: the result carries _diffBase', () => {
    const r = stampAuditRound({}, 3, diffBaseToStamp({ explicitBaseResolved: true, auditBaseCommit: SHA }));
    assert.equal(r._diffBase, SHA);
    assert.equal(r.round, 3);
  });
});

describe('resolveAllowlistBase — an explicit base beside --files is validated and resolved', () => {
  const ok = () => ({ ok: true, baseSha: OTHER });
  it('allowlist + explicit base resolves to the full sha the snapshot validated', () => {
    assert.equal(resolveAllowlistBase({ source: 'allowlist', explicitBase: 'origin/main', resolve: ok }), OTHER);
  });
  it('is a no-op for a non-allowlist round or with no explicit base (the scope-diff block owns those)', () => {
    let called = false;
    const spy = () => { called = true; return ok(); };
    assert.equal(resolveAllowlistBase({ source: 'scope-diff', explicitBase: 'origin/main', resolve: spy }), null);
    assert.equal(resolveAllowlistBase({ source: 'allowlist', explicitBase: null, resolve: spy }), null);
    assert.equal(called, false);
  });
  it('an explicit base that cannot be validated STOPS the run, never demotes to no base', () => {
    assert.throws(
      () => resolveAllowlistBase({ source: 'allowlist', explicitBase: 'nope', resolve: () => ({ ok: false, reason: 'not an ancestor of HEAD' }) }),
      (e) => e.auditScopeFatal === true && /not an ancestor/.test(e.message),
    );
    assert.throws(() => resolveAllowlistBase({ source: 'allowlist', explicitBase: 'x', resolve: () => ({ ok: true, baseSha: 'HEAD' }) }), /AGENT FIX/);
  });
});

describe('openai-audit.mjs uses the ONE decision at every stamp site', () => {
  const src = fs.readFileSync(new URL('../scripts/openai-audit.mjs', import.meta.url), 'utf8');
  it('both stampAuditRound call sites for code rounds go through diffBaseToStamp, and the old coverage-only ternary is gone', () => {
    assert.equal((src.match(/stampAuditRound\([^\n]*diffBaseToStamp\(opts\)/g) || []).length, 2);
    assert.doesNotMatch(src, /opts\.coverageChanged \? opts\.auditBaseCommit : null/);
  });
  it('the allowlist base is resolved and handed on as explicitBaseResolved', () => {
    assert.match(src, /resolveAllowlistBase\(\{ source: scopeResolution\.source, explicitBase,/);
    assert.match(src, /explicitBaseResolved: Boolean\(allowlistBase\)/);
  });
});

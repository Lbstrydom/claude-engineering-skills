import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveFileToDomain,
  checkDepAllowed,
  computeDeclaredDomains,
  VENDOR_DOMAIN,
} from '../scripts/lib/arch-intent/domain-resolver.mjs';

const RULES = [
  { pattern: 'scripts/lib/arch-intent/**', domain: 'shared-lib' },
  { pattern: 'scripts/openai-audit.mjs', domain: 'audit-orchestration' },
  { pattern: 'scripts/lib/**', domain: 'shared-lib' },
  { pattern: 'tests/**', domain: 'tests' },
];

describe('resolveFileToDomain', () => {
  it('first-match-wins', () => {
    // scripts/lib/arch-intent/foo.mjs matches the FIRST rule, not the broader scripts/lib/**
    assert.equal(resolveFileToDomain('scripts/lib/arch-intent/foo.mjs', RULES), 'shared-lib');
  });

  it('returns null for unmatched paths', () => {
    assert.equal(resolveFileToDomain('random/file.txt', RULES), null);
  });

  it('handles Windows backslashes', () => {
    assert.equal(resolveFileToDomain('scripts\\lib\\arch-intent\\foo.mjs', RULES), 'shared-lib');
  });

  it('returns null for empty inputs', () => {
    assert.equal(resolveFileToDomain('', RULES), null);
    assert.equal(resolveFileToDomain('x', []), null);
    assert.equal(resolveFileToDomain('x', null), null);
  });
});

describe('checkDepAllowed', () => {
  const allowed = { 'audit-orchestration': ['shared-lib', 'learning-store'] };

  it('same-domain edges always allowed', () => {
    assert.equal(checkDepAllowed('audit-orchestration', 'audit-orchestration', allowed), true);
    // Even when allowedDeps is null
    assert.equal(checkDepAllowed('shared-lib', 'shared-lib', null), true);
  });

  it('vendor as target always allowed', () => {
    assert.equal(checkDepAllowed('audit-orchestration', VENDOR_DOMAIN, allowed), true);
    assert.equal(checkDepAllowed('audit-orchestration', VENDOR_DOMAIN, null), true);
  });

  it('allowedDeps whitelist semantics', () => {
    assert.equal(checkDepAllowed('audit-orchestration', 'shared-lib', allowed), true);
    assert.equal(checkDepAllowed('audit-orchestration', 'tests', allowed), false);
  });

  it('null allowedDeps forbids all non-trivial edges', () => {
    assert.equal(checkDepAllowed('audit-orchestration', 'shared-lib', null), false);
  });

  it('missing fromDomain in allowedDeps forbids', () => {
    assert.equal(checkDepAllowed('plan', 'shared-lib', allowed), false);
  });
});

describe('computeDeclaredDomains', () => {
  it('unions rules + allowedDeps keys/values + description; excludes vendor', () => {
    const map = {
      rules: [{ pattern: '**/*.js', domain: 'a' }],
      allowedDeps: { a: ['b'], c: ['vendor'] },
      description: { d: '...' },
    };
    const declared = computeDeclaredDomains(map);
    assert.deepEqual([...declared].sort(), ['a', 'b', 'c', 'd']);
    assert.equal(declared.has(VENDOR_DOMAIN), false, 'vendor must be excluded');
  });

  it('handles empty map gracefully', () => {
    const declared = computeDeclaredDomains({ rules: [] });
    assert.equal(declared.size, 0);
  });
});

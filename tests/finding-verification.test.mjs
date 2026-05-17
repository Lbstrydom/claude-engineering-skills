/**
 * Tests for scripts/lib/audit/finding-verification.mjs — the deterministic
 * finding-verification gate.
 * Plan: docs/plans/adaptive-context-blast-radius.md — Phase 1.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyFinding,
  extractCitedEntity,
  verifyExistenceFindings,
} from '../scripts/lib/audit/finding-verification.mjs';

const REPO = ['scripts/lib/brainstorm/schemas.mjs', 'scripts/lib/secret-patterns.mjs', 'AGENTS.md'];

function finding(over = {}) {
  return {
    id: 'H1', severity: 'HIGH', category: 'Missing Module', section: 'scripts/brainstorm-round.mjs',
    detail: 'x', risk: 'x', recommendation: 'x', is_quick_fix: false, is_mechanical: true,
    principle: 'x', ...over,
  };
}

describe('classifyFinding', () => {
  it('matches an existence claim', () => {
    assert.equal(classifyFinding(finding({ detail: 'The module `schemas.mjs` is missing.' })), true);
    assert.equal(classifyFinding(finding({ category: 'Missing Import', detail: 'no such file' })), true);
  });
  it('does not match an ordinary finding', () => {
    assert.equal(classifyFinding(finding({ category: 'DRY Violation', detail: 'duplicated helper', section: 'x' })), false);
  });
});

describe('extractCitedEntity — anchored, not first-quoted-wins (audit H4/H5)', () => {
  it('pulls the file token adjacent to the missing-claim phrase', () => {
    const e = extractCitedEntity(finding({ detail: 'The module `scripts/lib/brainstorm/schemas.mjs` does not exist.' }));
    assert.equal(e.kind, 'file');
    assert.equal(e.name, 'scripts/lib/brainstorm/schemas.mjs');
  });
  it('picks the MISSING module, not the importer, when both are cited', () => {
    // The importer (scripts/a.mjs) exists; only the second token is the claim.
    const e = extractCitedEntity(finding({
      detail: 'In `scripts/a.mjs`, the import `scripts/lib/ghost.mjs` does not exist.',
    }));
    assert.equal(e.name, 'scripts/lib/ghost.mjs', 'anchored on the claim phrase, not first-quoted');
  });
  it('classifies a symbol token', () => {
    const e = extractCitedEntity(finding({ detail: 'The export `BrainstormEnvelopeWriteSchema` is missing.' }));
    assert.equal(e.kind, 'symbol');
  });
  it('classifies a scoped package as external (audit M7)', () => {
    const e = extractCitedEntity(finding({ category: 'Missing Dependency', detail: 'The dependency `@google/genai` is missing.' }));
    assert.equal(e.kind, 'external');
  });
});

describe('verifyExistenceFindings — the H1/H2/M2 regression', () => {
  it('REFUTES a HIGH "missing module" finding when the file exists', () => {
    const out = verifyExistenceFindings(
      [finding({ detail: 'The module `scripts/lib/brainstorm/schemas.mjs` does not exist.' })],
      { repoFiles: REPO },
    );
    const v = out[0].verification;
    assert.equal(v.verification, 'refuted');
    assert.equal(v.verdictSeverity, 'LOW');
    assert.equal(v.countsTowardVerdict, false);
    assert.equal(out[0].severity, 'HIGH', 'original severity preserved (immutable — audit M2)');
  });

  it('CONFIRMS a missing-file claim when the file genuinely does not exist', () => {
    const out = verifyExistenceFindings(
      [finding({ detail: 'The module `scripts/lib/ghost-module.mjs` does not exist.' })],
      { repoFiles: REPO },
    );
    const v = out[0].verification;
    assert.equal(v.verification, 'confirmed');
    assert.equal(v.verdictSeverity, 'HIGH', 'original severity preserved (G2)');
    assert.equal(v.countsTowardVerdict, true);
  });

  it('a missing-SYMBOL claim is requires_verification, never confirmed (audit G1)', () => {
    const out = verifyExistenceFindings(
      [finding({ category: 'Missing Symbol', detail: 'The export `SomeType` is missing.' })],
      { repoFiles: REPO },
    );
    const v = out[0].verification;
    assert.equal(v.verification, 'requires_verification');
    assert.equal(v.verdictSeverity, 'HIGH', 'severity preserved — gate must not bury a real HIGH (G2)');
    assert.equal(v.countsTowardVerdict, true);
  });

  it('a symbol found via symbolLookup is refuted', () => {
    const out = verifyExistenceFindings(
      [finding({ category: 'Missing Symbol', detail: 'The export `KnownSym` is missing.' })],
      { repoFiles: REPO, symbolLookup: (n) => n === 'KnownSym' },
    );
    assert.equal(out[0].verification.verification, 'refuted');
  });

  it('an external-dependency claim is requires_verification (not confirmed missing — audit M7)', () => {
    const out = verifyExistenceFindings(
      [finding({ category: 'Missing Dependency', detail: 'The dependency `@google/genai` is missing.' })],
      { repoFiles: REPO },
    );
    assert.equal(out[0].verification.verification, 'requires_verification');
    assert.match(out[0].verification.verificationReason, /external dependency/i);
  });

  it('a cited sensitive path is requires_verification and never probed (Gemini-R2-G1)', () => {
    const out = verifyExistenceFindings(
      [finding({ detail: 'The module `secrets/prod.key` does not exist.' })],
      { repoFiles: REPO },
    );
    const v = out[0].verification;
    assert.equal(v.verification, 'requires_verification');
    assert.match(v.verificationReason, /sensitive/i);
  });

  it('a relative specifier escaping the repo root is requires_verification (audit H5/M6)', () => {
    const out = verifyExistenceFindings(
      [finding({ detail: 'The file `../../etc/passwd` does not exist.' })],
      { repoFiles: REPO },
    );
    assert.equal(out[0].verification.verification, 'requires_verification');
  });

  it('leaves a non-existence finding untouched (no verification field)', () => {
    const out = verifyExistenceFindings(
      [finding({ category: 'DRY Violation', detail: 'helper duplicated across two files', section: 'scripts/a.mjs' })],
      { repoFiles: REPO },
    );
    assert.equal(out[0].verification, undefined);
  });

  it('an existence claim with no extractable entity is requires_verification', () => {
    const out = verifyExistenceFindings(
      [finding({ category: 'Missing Module', detail: 'something is missing somewhere in the wiring' })],
      { repoFiles: REPO },
    );
    assert.equal(out[0].verification.verification, 'requires_verification');
  });
});

/**
 * @fileoverview A required pattern already covered by an ignored PARENT
 * DIRECTORY must not be re-appended.
 *
 * `hasPattern` is exact-line, so a repo with a bare `.audit/` reported every
 * `.audit/<thing>` pattern as missing and the writer appended the lot — pure
 * churn, since git already ignores all of it. The source repo's post-merge hook
 * re-proposed that whole redundant block on every `git pull` (2026-07-19).
 *
 * The risk direction matters here. `hasPattern`'s own design note says
 * over-reporting presence is the DANGEROUS direction, because it would skip
 * adding a real `.env` protection. Coverage detection pushes that way, so most
 * of these tests pin what must NEVER be treated as covered.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  _internals, ensureAuditGitignore, checkAuditGitignore,
} from '../scripts/lib/install/gitignore.mjs';

const { isCoveredByIgnoredDirectory, isPatternSatisfied, hasPattern } = _internals;

describe('gitignore coverage — what IS covered', () => {
  test('a bare ignored directory covers its descendants', () => {
    assert.equal(isCoveredByIgnoredDirectory('.audit/\n', '.audit/local/'), true);
    assert.equal(isCoveredByIgnoredDirectory('.audit/\n', '.audit/bandit-state.json'), true);
    assert.equal(isCoveredByIgnoredDirectory('.audit/\n', '.audit/**/*.lock'), true);
  });

  test('a root-anchored directory rule covers too', () => {
    assert.equal(isCoveredByIgnoredDirectory('/.audit/\n', '.audit/local/'), true);
  });

  test('coverage survives surrounding noise', () => {
    const gi = '# comment\nnode_modules/\n\n.audit/   \ndist/\n';
    assert.equal(isCoveredByIgnoredDirectory(gi, '.audit/staging/'), true);
  });
});

describe('gitignore coverage — what must NEVER be covered (safety)', () => {
  test('a bare filename pattern is never claimed as covered', () => {
    // `.env` is THE protection hasPattern's note is about. It contains no `/`,
    // so it can never enter the coverage path at all — belt and braces.
    assert.equal(isCoveredByIgnoredDirectory('/\n*\n.env/\n', '.env'), false);
    assert.equal(isCoveredByIgnoredDirectory('.audit/\n', '.audit-loop-install-receipt.json'), false);
  });

  test('the strict-superstring trap does not fire', () => {
    // `.audit/` must not be read as covering `.audit-loop/...` — the same class
    // of bug the exact-line rule in hasPattern exists to prevent.
    assert.equal(isCoveredByIgnoredDirectory('.audit/\n', '.audit-loop/x.json'), false);
    assert.equal(isCoveredByIgnoredDirectory('.claude/\n', '.claude-skills/tmp/'), false);
  });

  test('a negation line never covers', () => {
    assert.equal(isCoveredByIgnoredDirectory('!.audit/\n', '.audit/local/'), false);
  });

  test('a comment never covers', () => {
    assert.equal(isCoveredByIgnoredDirectory('#.audit/\n', '.audit/local/'), false);
  });

  test('a glob directory never covers (no glob semantics are inferred)', () => {
    assert.equal(isCoveredByIgnoredDirectory('.aud*/\n', '.audit/local/'), false);
    assert.equal(isCoveredByIgnoredDirectory('**/tmp/\n', 'tmp/x'), false);
    assert.equal(isCoveredByIgnoredDirectory('.audit/[ab]/\n', '.audit/a/x'), false);
  });

  test('a non-directory rule never covers', () => {
    // `.audit` (no trailing slash) is not treated as a directory rule here.
    assert.equal(isCoveredByIgnoredDirectory('.audit\n', '.audit/local/'), false);
  });

  test('isPatternSatisfied is the union, and still honours leading whitespace', () => {
    assert.equal(isPatternSatisfied('.audit/local/\n', '.audit/local/'), true, 'literal presence');
    assert.equal(isPatternSatisfied('.audit/\n', '.audit/local/'), true, 'covered');
    assert.equal(isPatternSatisfied('other/\n', '.audit/local/'), false);
    // Leading space is significant to git; hasPattern must still reject it and
    // coverage must not rescue it.
    assert.equal(hasPattern(' .env\n', '.env'), false);
    assert.equal(isPatternSatisfied(' .env\n', '.env'), false, 'a space-prefixed rule is NOT the protection');
  });
});

describe('gitignore coverage — end to end', () => {
  let dir;
  const mk = (giContent) => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gi-'));
    // Not the source repo — package.json absent means consumer semantics.
    fs.writeFileSync(path.join(dir, '.gitignore'), giContent);
    return dir;
  };

  test('a bare .audit/ makes the writer append nothing for .audit/* patterns', () => {
    const root = mk('.audit/\n.env\n.claude/tmp/\n');
    const before = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    const res = ensureAuditGitignore(root, { quiet: true });
    const after = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    assert.equal(res.added.filter(p => p.startsWith('.audit/')).length, 0,
      'no .audit/* pattern may be re-added when .audit/ already ignores them');
    assert.ok(res.alreadyPresent.includes('.audit/local/'));
    // Other genuinely-missing patterns (bundle etc.) may still be added; what
    // must not happen is the redundant .audit/* churn.
    assert.ok(!after.slice(before.length).includes('.audit/local/'));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  test('checker agrees with writer — neither reports covered patterns missing', () => {
    const root = mk('.audit/\n');
    const { missing } = checkAuditGitignore(root);
    assert.equal(missing.filter(p => p.startsWith('.audit/')).length, 0,
      'checkAuditGitignore must use the same predicate or --fix loops forever');
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  test('an EMPTY .gitignore still gets the real protections (no false coverage)', () => {
    const root = mk('');
    const res = ensureAuditGitignore(root, { quiet: true });
    assert.ok(res.added.includes('.env'), '.env protection must always be added when absent');
    assert.ok(res.added.includes('.audit/local/'));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
});

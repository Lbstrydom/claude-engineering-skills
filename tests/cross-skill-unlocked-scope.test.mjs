/**
 * @fileoverview Repo-scoping for the unlocked-fix backlog (plan Issue 4).
 *
 * THE DEFECT THESE LOCK. `list-unlocked-fixes` accepted `--repo` and silently
 * ignored it — only `--repo-id` was read — so with neither flag both store
 * calls took their unscoped branch and returned EVERY repository's rows. A
 * consumer reported a backlog of 207 that belonged entirely to a different
 * repo; its own true count was 0. Worse, the lock worksheet then looked a
 * finding up across all repos and adopted the matched row's `repo_id`, so a
 * foreign id could be written into a regression spec — a cross-tenant WRITE.
 *
 * Two layers are asserted, deliberately:
 *   1. the **data-access boundary** rejects an implicit global (behavioural);
 *   2. the **CLI precedence chain** evaluates explicit intent before ambient
 *      inference (source-level — the chain short-circuits inside a non-exported
 *      function, and the ordering IS the contract).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getUnlockedFixes, countUnlockedFixes } from '../scripts/lib/store/plans-ship.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliSrc = fs.readFileSync(path.join(repoRoot, 'scripts', 'cross-skill.mjs'), 'utf-8');

describe('unlocked-fix store boundary — global access must be ASKED for', () => {
  // Each of these used to mean "every repository". The whole point of the fix
  // is that a caller can no longer reach cross-tenant rows by omission.
  for (const [label, arg] of [
    ['undefined (the original bug)', undefined],
    ['null', null],
    ['a bare repoId string', 'some-uuid'],
    ['an empty object', {}],
    ['{repoId: null}', { repoId: null }],
    ['{allRepos: false}', { allRepos: false }],
  ]) {
    it(`getUnlockedFixes rejects ${label}`, async () => {
      await assert.rejects(() => getUnlockedFixes(arg), /explicit scope is required/);
    });
    it(`countUnlockedFixes rejects ${label}`, async () => {
      await assert.rejects(() => countUnlockedFixes(arg), /explicit scope is required/);
    });
  }

  it('rejects an ambiguous {repoId, allRepos} pair rather than picking one', async () => {
    await assert.rejects(
      () => getUnlockedFixes({ repoId: 'x', allRepos: true }),
      /never both/,
    );
  });

  it('the error explains the leak, so the next caller understands the rule', async () => {
    await assert.rejects(() => getUnlockedFixes(undefined), (err) => {
      assert.match(err.message, /every repository/);
      assert.match(err.message, /leaked/);
      return true;
    });
  });
});

describe('CLI scope precedence — explicit intent before ambient inference', () => {
  const chain = cliSrc.slice(
    cliSrc.indexOf('async function resolveUnlockedFixScope()'),
    cliSrc.indexOf('const storeScopeFor'),
  );

  it('resolveUnlockedFixScope exists and is used by BOTH handlers', () => {
    assert.ok(chain.length > 0, 'the scope chain must be one shared function, not duplicated per handler');
    const uses = cliSrc.match(/await resolveUnlockedFixScope\(\)/g) || [];
    assert.equal(uses.length, 2,
      'both cmdListUnlockedFixes and cmdLockWithTestWorksheet must scope — the worksheet is the ' +
      'command /ship PRINTS as its remediation, so leaving it unscoped hands over foreign findings');
  });

  it('--all-repos is evaluated BEFORE ambient identity, or it is unreachable', () => {
    // The chain short-circuits. With `--all-repos` last, ambient identity
    // resolves inside any git repo and terminates the chain first, silently
    // ignoring the flag — the same accepted-but-inert defect being fixed.
    const iAll = chain.indexOf("if (allRepos) return");
    const iAmbient = chain.indexOf('resolveRepoForStore');
    assert.ok(iAll > -1 && iAmbient > -1, 'both branches must exist');
    assert.ok(iAll < iAmbient,
      '--all-repos must short-circuit before ambient identity resolution, else the flag is dead');
  });

  it('--repo and --repo-id are both honoured (--repo was the ignored one)', () => {
    assert.match(chain, /argOption\('repo-id'\)/);
    assert.match(chain, /argOption\('repo'\)/);
    assert.match(chain, /getRepoIdByName/, '--repo takes a slug and must be resolved to an id');
  });

  it('an unknown --repo slug is an ERROR, never a silent widening or a bare zero', () => {
    assert.match(chain, /unknown-repo/);
    assert.ok(!/allRepos: true/.test(chain.slice(chain.indexOf('unknown-repo'))),
      'an unknown slug must never fall back to global');
  });

  it('an unresolvable ambient identity is measured:false, not global', () => {
    assert.match(chain, /repo-identity-unresolvable/);
    assert.match(chain, /measured: false/);
  });

  it('measured:false is distinguishable from a genuine zero', () => {
    // Conflating "nothing was measured" with "no obligations" is precisely how
    // a foreign 207 and a local 0 both read as ordinary numbers.
    assert.match(cliSrc, /measured: false, reason: scope\.reason/);
    assert.match(cliSrc, /measured: true, reason: null/);
  });
});

describe('lock worksheet — cross-tenant WRITE fence', () => {
  it('resolves repo identity FIRST and never adopts the fetched row\'s repo_id', () => {
    assert.ok(!/const repoId = finding\?\.repo_id/.test(cliSrc),
      'adopting the matched row\'s repo_id is how a foreign repo got written into a regression spec');
    assert.match(cliSrc, /findUnlockedFixInRepo\(\{ repoId, findingId \}\)/,
      'the lookup must be scoped to the resolved repo, not a cross-repo LIMIT-20 scan');
  });

  it('refuses rather than guessing when identity is unresolvable', () => {
    assert.match(cliSrc, /repo identity unresolvable/);
  });

  it('a finding belonging to another repo is refused with a reason, not silently missed', () => {
    assert.match(cliSrc, /belongs to another repository|another repository/);
  });

  it('does NOT use the LIMIT-20 sampler for a single-finding lookup', () => {
    // Strip line comments first: the fence carries a comment QUOTING the removed
    // `getUnlockedFixes(null)` call so the defect stays explained at the site.
    // A naive source match would fire on that explanation forever — a test that
    // punishes documenting the bug it guards.
    const code = cliSrc.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    assert.ok(!/getUnlockedFixes\(\s*null\s*\)/.test(code),
      'the sampler returns an arbitrary 20 rows — a real finding usually is not among them');
    assert.ok(!/getUnlockedFixes\(\s*argOption\(/.test(code),
      'a bare argOption() is the pre-fix shape: it reads --repo-id only and ignores --repo');
  });
});

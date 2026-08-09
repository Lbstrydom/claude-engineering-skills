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
import {
  getUnlockedFixes,
  countUnlockedFixes,
  getUnremediatedAcceptances,
} from '../scripts/lib/store/plans-ship.mjs';

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
    // Added 2026-07-30: this reader kept the pre-fix `if (repoId) … else every
    // repository` shape for three days after its siblings were fenced, and
    // /ship Step 0.5e calls it with no flags at all.
    it(`getUnremediatedAcceptances rejects ${label}`, async () => {
      await assert.rejects(() => getUnremediatedAcceptances(arg), /explicit scope is required/);
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

/**
 * Slice one top-level `async function <name>()` body out of the CLI source,
 * bounded by the NEXT top-level function declaration.
 *
 * Deliberately not a fixed character offset (`indexOf(name) + 2400`): that was
 * tried and is a false-PASS risk, not merely untidy — if the target function
 * shrinks, the slice spills into the following function, and an assertion looking
 * for a string can then find it in the neighbour and pass for the wrong reason.
 * A test whose bound depends on the length of what it measures cannot be trusted
 * to fail.
 *
 * Throws rather than returning a partial slice when the anchor is missing: a
 * silently-empty haystack would make every `assert.match` against it fail with a
 * confusing message, and every `assert.ok(!/…/)` pass vacuously.
 */
function fnBody(name) {
  const start = cliSrc.indexOf(`async function ${name}()`);
  assert.ok(start > -1, `could not find "async function ${name}()" in cross-skill.mjs — the test anchor is stale`);
  const after = cliSrc.indexOf('\nasync function ', start + 1);
  const end = after > -1 ? after : cliSrc.length;
  const body = cliSrc.slice(start, end);
  assert.ok(body.length > 50, `extracted an implausibly short body for ${name} (${body.length} chars)`);
  return body;
}

describe('CLI scope precedence — explicit intent before ambient inference', () => {
  const chain = cliSrc.slice(
    cliSrc.indexOf('async function resolveShipNudgeScope()'),
    cliSrc.indexOf('const storeScopeFor'),
  );

  it('resolveShipNudgeScope exists and is used by EVERY nudge handler', () => {
    assert.ok(chain.length > 0, 'the scope chain must be one shared function, not duplicated per handler');
    const uses = cliSrc.match(/await resolveShipNudgeScope\(\)/g) || [];
    assert.equal(uses.length, 3,
      'cmdListUnlockedFixes, cmdLockWithTestWorksheet and cmdListUnremediatedAcceptances must all ' +
      'scope. The worksheet is the command /ship PRINTS as its remediation, and the acceptance ' +
      'backlog is a second /ship step that shipped unscoped for three days — leaving any of them ' +
      'unscoped hands the operator another repository\'s findings');
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

  it('scope capability is PER-COMMAND: the worksheet refuses --all-repos, the reader allows it', () => {
    // Plan D21. One shared precedence chain, but permitted scope MODES differ by
    // command. `--all-repos` is a legitimate read on list-unlocked-fixes and
    // incoherent on the worksheet, because every row the worksheet prints is a
    // pasteable per-repo `lock-with-test` command that the write fence would then
    // refuse. Emitting instructions that cannot be followed is the same
    // plausible-but-wrong output class as the original bug.
    const ws = fnBody('cmdLockWithTestWorksheet');
    const iGuard = ws.indexOf("scope.mode === 'all-repos'");
    const iStore = ws.indexOf('getUnlockedFixes(');
    assert.ok(iGuard > -1, 'the worksheet must reject --all-repos explicitly');
    assert.ok(iStore > -1, 'the worksheet must read the view');
    assert.ok(iGuard < iStore,
      'the refusal must come BEFORE any store call — an unscoped read must never be attempted');
    assert.match(ws, /all-repos-unsupported/, 'the refusal needs a machine-readable reason code');

    // ...and the reader must NOT have grown the same restriction, or the
    // capability is silently lost rather than deliberately scoped.
    const reader = fnBody('cmdListUnlockedFixes');
    assert.ok(!/all-repos-unsupported/.test(reader),
      'list-unlocked-fixes must keep --all-repos — it is a read-only reporting question');
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

  it('an unverified --repo-id can never produce an authoritative zero', () => {
    // The incident's FINAL number came from here, not from the missing scope:
    // the operator passed the arch-memory repo_uuid (v5, from
    // `.audit-loop/repo-id`) while these views key on `audit_repos.id` (v4).
    // The id was trusted verbatim, matched no rows, and 0 was reported as a
    // measured backlog — so a `warned` ship event was "corrected" to `shipped`.
    assert.match(chain, /listRepoIds\(\)/,
      '--repo-id must be checked against audit_repos, not trusted verbatim');
    assert.match(chain, /unknown-repo-id/);
    assert.match(chain, /repo-id-unverifiable/,
      'an unreadable audit_repos must refuse to report a count, not fall through to one');

    const branch = chain.slice(chain.indexOf('if (repoIdArg) {'), chain.indexOf('if (slugArg) {'));
    assert.ok(!/measured: true[\s\S]*unknown-repo-id/.test(branch.slice(branch.indexOf('unknown-repo-id'))),
      'the unknown-id exit must be measured:false');
    assert.match(branch, /getRepoIdByUuid/,
      'the arch-memory uuid names the same repo (a sibling column) — translate it rather than ' +
      'rejecting the id an operator most plausibly has to hand');
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

describe('the fence covers the whole view family, not just the reported one', () => {
  // The 207-vs-0 fix added the fence and routed the two readers it knew about.
  // `getUnremediatedAcceptances` queried a sibling view, skipped the fence, and
  // reproduced the identical defect one /ship step later. Enumerating readers by
  // hand is what missed it, so enumerate mechanically instead.
  const storeSrc = fs.readFileSync(
    path.join(repoRoot, 'scripts', 'lib', 'store', 'plans-ship.mjs'), 'utf-8');
  const NUDGE_VIEWS = ['unlocked_fixes', 'unremediated_acceptances'];

  // Split on function declarations so each body can be attributed to its owner.
  const parts = storeSrc.split(/(?=^(?:export\s+)?(?:async\s+)?function\s+\w+)/m);
  const readers = parts
    .map((body) => ({ name: (body.match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/) || [])[1], body }))
    .filter((f) => f.name && NUDGE_VIEWS.some((v) => new RegExp(`FROM\\s+${v}\\b`).test(f.body)));

  it('finds the readers at all (guards against the regex silently matching nothing)', () => {
    assert.ok(readers.length >= 3,
      `expected >=3 nudge-view readers, found ${readers.length} (${readers.map((r) => r.name).join(', ')}) ` +
      '— if this dropped, the scan below is passing vacuously');
  });

  for (const { name, body } of readers) {
    it(`${name} has no repo-unfiltered read of a nudge view`, () => {
      // Per-STATEMENT, deliberately. A body-wide "does a repo_id predicate
      // appear anywhere?" check passes the exact bug being guarded: the broken
      // getUnremediatedAcceptances had a filtered branch AND an unfiltered one,
      // so the filtered branch alibi'd the leak. Verified by reverting the fix
      // against this assertion before trusting it.
      const fenced = /resolveExplicitRepoScope\(/.test(body);
      const statements = [...body.matchAll(/`([^`]*)`/g)].map((m) => m[1])
        .filter((sql) => NUDGE_VIEWS.some((v) => new RegExp(`FROM\\s+${v}\\b`).test(sql)));
      assert.ok(statements.length > 0, `no SQL extracted from ${name} — the scan would pass vacuously`);

      const unfiltered = statements.filter((sql) => !/repo_id\s*=\s*\$\d/.test(sql));
      if (fenced) {
        // The fence makes global access an explicit, asked-for argument, so an
        // unfiltered branch is legitimate — it is only reachable via allRepos.
        return;
      }
      assert.equal(unfiltered.length, 0,
        `${name} reads a /ship-nudge view with no repo_id predicate and does not route through ` +
        `resolveExplicitRepoScope, so omission reaches every repository:\n  ${unfiltered.join('\n  ')}\n` +
        'Either take the fence (if the caller chooses the scope) or require a repoId and always ' +
        'filter on it (if the scope is inherent).');
    });
  }
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

describe('a capped nudge reader must ship a counter, and the CLI must emit it', () => {
  // A `LIMIT`ed read whose caller reports `rows.length` states a floor as a
  // total. Twice in this family: `unlocked_fixes` reported 20 against 232
  // (2026-07-29), `unremediated_acceptances` 20 against 129 (2026-07-31). Both
  // were fixed in the store AND the CLI — but the /ship prose was corrected for
  // only one, so on 2026-08-09 the surviving "count the rows" instruction
  // produced 20 against a real 201 and that number was reported back as the
  // size of the backlog being triaged.
  //
  // Pinned as an explicit pair rather than by scanning function bodies: an
  // enumeration clever enough to find these is also clever enough to find
  // nothing and pass. Adding a third nudge view means adding a row here.
  const PAIRS = [
    { reader: 'getUnlockedFixes', counter: 'countUnlockedFixes' },
    { reader: 'getUnremediatedAcceptances', counter: 'countUnremediatedAcceptances' },
  ];
  const storeSrc = fs.readFileSync(
    path.join(repoRoot, 'scripts', 'lib', 'store', 'plans-ship.mjs'), 'utf-8');
  const cliSrc = fs.readFileSync(path.join(repoRoot, 'scripts', 'cross-skill.mjs'), 'utf-8');

  for (const { reader, counter } of PAIRS) {
    it(`${reader} exists and caps its rows (vacuous-pass guard)`, () => {
      // If the reader were renamed or stopped capping, the assertions below
      // would be pinning a contract nothing needs any more.
      assert.match(storeSrc, new RegExp(`function\\s+${reader}\\b`), `${reader} not found in the store`);
      const body = storeSrc.slice(storeSrc.search(new RegExp(`function\\s+${reader}\\b`)));
      assert.match(body.slice(0, 1200), /\bLIMIT\s+\d+/,
        `${reader} no longer caps its rows — re-check whether a counter is still required`);
    });

    it(`${counter} exists — ${reader}'s caller cannot otherwise report a real total`, () => {
      assert.match(storeSrc, new RegExp(`function\\s+${counter}\\b`),
        `${reader} caps its rows but ${counter}() is missing`);
    });

    it(`cross-skill.mjs calls ${counter} wherever it calls ${reader}`, () => {
      assert.match(cliSrc, new RegExp(`\\b${reader}\\s*\\(`), `CLI must call ${reader} (else vacuous)`);
      assert.match(cliSrc, new RegExp(`\\b${counter}\\s*\\(`),
        `the CLI calls ${reader} without ${counter} — the payload would carry capped rows and no total`);
    });
  }

  it('/ship never tells the operator to count the capped rows', () => {
    // The prose half of the same contract — the half that survived both tool
    // fixes and produced the 20-vs-201 report.
    const shipSkill = fs.readFileSync(path.join(repoRoot, 'skills', 'ship', 'SKILL.md'), 'utf-8');
    assert.doesNotMatch(shipSkill, /Count the rows as `unremediated_count`/,
      'Step 0.5e must read byMode.total, not rows.length');
    assert.match(shipSkill, /byMode\.total/, 'Step 0.5e must name the field that carries the real total');
  });
});

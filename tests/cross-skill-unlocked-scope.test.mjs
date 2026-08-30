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
// RETARGETED (command-registry Cluster D): every command this suite inspects
// migrated out of scripts/cross-skill.mjs into the registry command modules,
// and the legacy dispatch map is gone. The haystack is now the concatenation
// of the modules that own those handlers, so `fnBody` keeps finding real
// bodies instead of failing on a stale anchor. The ASSERTIONS are unchanged —
// what they guard (explicit-before-ambient scope precedence, the cross-tenant
// write fence, the capped-reader counter) is the same contract in its new home.
const cliSrc = [
  'scripts/lib/cross-skill/commands/ship.mjs',
  'scripts/lib/cross-skill/scope.mjs',
].map((f) => fs.readFileSync(path.join(repoRoot, f), 'utf-8')).join('\n');

/**
 * Every `*.mjs` under `scripts/lib/store/`, as `{file, src}`.
 *
 * RETARGETED (command-registry Cluster E, and deliberately NOT to a new
 * filename). The three static scans below read the store source; all three
 * were pinned to `plans-ship.mjs`, and Phase 6 moved the nudge readers out of
 * it into `ship-nudges.mjs`. Re-pinning to the new name would have restored
 * coverage while leaving the property that failed: **a reader added to, or
 * moved into, a file the scan does not name is unrepresentable to it.** That is
 * AGENTS.md defect shape #3 — ask which side you are iterating and what cannot
 * be seen from it. The answer here is to iterate the DIRECTORY, which is the
 * side that can see a file no list mentions, so the next move cannot blind
 * these scans either. (The barrel is included and contributes nothing: an
 * `export * from` line carries no SQL.)
 */
const STORE_DIR = path.join(repoRoot, 'scripts', 'lib', 'store');
const storeFiles = fs.readdirSync(STORE_DIR)
  .filter((f) => f.endsWith('.mjs'))
  .map((f) => ({ file: `scripts/lib/store/${f}`, src: fs.readFileSync(path.join(STORE_DIR, f), 'utf-8') }));

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

  // Audit CE-r2-H5. `allRepos` was tested for TRUTHINESS, so any non-boolean
  // truthy value authorised a cross-repo read. No caller passes one today —
  // every producer is `ctx.hasFlag('all-repos')` or the literal `true` — but
  // this is the fence whose entire premise is that global access must be ASKED
  // for, and "truthy counts as yes" is the wrong default to leave armed on a
  // tenant boundary. A JSON payload carrying `{"allRepos": "false"}` is the
  // shape that turns a string into a global read.
  for (const bogus of ['yes', 'false', 1, {}, []]) {
    it(`a non-boolean allRepos (${JSON.stringify(bogus)}) is refused, never read as global`, async () => {
      await assert.rejects(() => getUnlockedFixes({ allRepos: bogus }), /explicit scope is required/);
    });
  }

  it('a real {allRepos:true} is still honoured — the fix narrows the type, not the capability', async () => {
    // Without this the H5 fix could have been "reject everything", which also
    // makes the five assertions above pass. Reaches the store (cloud may be off,
    // in which case the reader returns []); what matters is that it does NOT
    // throw the explicit-scope error.
    await getUnlockedFixes({ allRepos: true });
  });

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
  const start = cliSrc.indexOf(`async function ${name}(`);
  assert.ok(start > -1, `could not find "async function ${name}(" in the cross-skill command modules — the test anchor is stale`);
  const after = cliSrc.indexOf('\nasync function ', start + 1);
  const end = after > -1 ? after : cliSrc.length;
  const body = cliSrc.slice(start, end);
  assert.ok(body.length > 50, `extracted an implausibly short body for ${name} (${body.length} chars)`);
  return body;
}

describe('CLI scope precedence — explicit intent before ambient inference', () => {
  // RETARGETED (command-registry Cluster D). `resolveShipNudgeScope` became the
  // `global-optin` MODE of the one scope resolver (scripts/lib/cross-skill/scope.mjs
  // → globalOptin), and the three nudge handlers now DECLARE that policy in the
  // registry instead of each calling a shared function. Every assertion below
  // guards the same contract; only where the contract lives has moved.
  const chain = cliSrc.slice(
    cliSrc.indexOf('async function globalOptin('),
    cliSrc.length,
  );

  it('the nudge handlers all DECLARE the global-optin scope policy', async () => {
    assert.ok(chain.length > 0, 'the scope chain must be one shared resolver mode, not duplicated per handler');
    const { REGISTRY } = await import('../scripts/lib/cross-skill/registry.mjs');
    // The worksheet is a MODE of lock-with-test (--worksheet), so it inherits
    // that command's declaration — three declaring commands, same three
    // surfaces as before.
    const declared = ['list-unlocked-fixes', 'list-unremediated-acceptances', 'lock-with-test']
      .map((n) => REGISTRY.find((e) => e.name === n));
    for (const e of declared) {
      assert.ok(e, 'a nudge command vanished from the registry');
      assert.equal(e.scope, 'global-optin',
        `${e.name} must scope. The worksheet is the command /ship PRINTS as its remediation, and the `
        + 'acceptance backlog is a second /ship step that shipped unscoped for three days — leaving any '
        + 'of them unscoped hands the operator another repository\'s findings');
    }
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
    const ws = fnBody('lockWithTestWorksheet');
    const iGuard = ws.indexOf("scope.kind === 'global'");
    const iStore = ws.indexOf('getUnlockedFixes(');
    assert.ok(iGuard > -1, 'the worksheet must reject --all-repos explicitly');
    assert.ok(iStore > -1, 'the worksheet must read the view');
    assert.ok(iGuard < iStore,
      'the refusal must come BEFORE any store call — an unscoped read must never be attempted');
    assert.match(ws, /all-repos-unsupported/, 'the refusal needs a machine-readable reason code');

    // ...and the reader must NOT have grown the same restriction, or the
    // capability is silently lost rather than deliberately scoped.
    const reader = fnBody('listUnlockedFixesCmd');
    assert.ok(!/all-repos-unsupported/.test(reader),
      'list-unlocked-fixes must keep --all-repos — it is a read-only reporting question');
  });

  it('--repo and --repo-id are both honoured (--repo was the ignored one)', () => {
    assert.match(chain, /explicitRepoId/, '--repo-id must reach the resolver');
    assert.match(chain, /explicitRepoName/, '--repo must reach the resolver');
    assert.match(chain, /getRepoIdByName/, '--repo takes a slug and must be resolved to an id');
  });

  it('an unknown --repo slug is an ERROR, never a silent widening or a bare zero', () => {
    assert.match(chain, /UNKNOWN_REPO/, 'an unknown slug must be a typed refusal');
    assert.ok(!/allRepos: true/.test(chain.slice(chain.indexOf('UNKNOWN_REPO'))),
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
    assert.match(chain, /UNKNOWN_REPO_ID/);
    assert.match(chain, /repo-id-unverifiable/,
      'an unreadable audit_repos must refuse to report a count, not fall through to one');

    // The branch bounds moved with the resolver: `repoIdArg`/`slugArg` became
    // `explicitRepoId`/`explicitRepoName` in scope.mjs's globalOptin.
    const branch = chain.slice(chain.indexOf('if (explicitRepoId) {'), chain.indexOf('if (explicitRepoName) {'));
    assert.ok(!/kind: 'scoped'[\s\S]*UNKNOWN_REPO_ID/.test(branch.slice(branch.indexOf('UNKNOWN_REPO_ID'))),
      'the unknown-id exit must NOT resolve to a scoped read — it is an error, not a zero');
    assert.match(branch, /getRepoIdByUuid/,
      'the arch-memory uuid names the same repo (a sibling column) — translate it rather than ' +
      'rejecting the id an operator most plausibly has to hand');
  });

  it('an unresolvable ambient identity is measured:false, not global', () => {
    assert.match(chain, /repo-identity-unresolvable/);
    // `measured:false` moved from the resolver's return into the HANDLER's
    // envelope (ship.mjs `unmeasured()`), because the resolver is now shared
    // across policies and only the handler knows the reporting shape. The
    // guarantee is unchanged: unresolvable ambient identity never becomes a
    // global read, and never becomes a bare zero.
    assert.match(chain, /kind: 'unresolved'/,
      'ambient-unresolvable must be its own discriminated kind, never a silent global');
    assert.ok(!/kind: 'global'/.test(chain.slice(chain.indexOf('repo-identity-unresolvable'))),
      'the unresolvable exit must never fall through to a global read');
    assert.match(cliSrc, /measured: false/,
      'the handler must still report measured:false rather than an empty-but-clean row set');
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
  // The `_all` base views are listed explicitly: `\b` after `unlocked_fixes`
  // does NOT match `unlocked_fixes_all` (the next char is a word char), so an
  // aged-visibility reader would otherwise be invisible to this scan.
  const NUDGE_VIEWS = [
    'unlocked_fixes', 'unlocked_fixes_all',
    'unremediated_acceptances', 'unremediated_acceptances_all',
  ];

  // Split on function declarations so each body can be attributed to its owner
  // — across every store module, not one named file (see `storeFiles`).
  const readers = storeFiles.flatMap(({ file, src }) => src
    .split(/(?=^(?:export\s+)?(?:async\s+)?function\s+\w+)/m)
    .map((body) => ({ file, name: (body.match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/) || [])[1], body })))
    .filter((f) => f.name && NUDGE_VIEWS.some((v) => new RegExp(`FROM\\s+${v}\\b`).test(f.body)));

  // The floor TRACKS REALITY rather than sitting under it. It read `>= 3` while
  // seven readers existed, and on 2026-08-11 an interpolated view name
  // (`FROM ${source}`, invisible to a literal scan) silently dropped TWO of them
  // out — leaving exactly 3, so this passed and the fence quietly covered half
  // of what it claimed. A floor with slack in it cannot report the loss it exists
  // to report. Raise it deliberately when a reader is added or removed.
  //
  // RAISED 7 → 8 (Cluster E). Measuring the split against HEAD found the floor
  // already carried one notch of slack: `countAcceptedPermanent` joined the
  // family with the disposition migration on 2026-08-11 and the floor was not
  // raised with it, so eight readers existed under a floor of seven. One reader
  // could have dropped out — the exact loss this is here to report — and it
  // would still have passed. Found only because the retarget forced a re-count,
  // which is the argument for re-measuring a floor rather than porting it.
  //
  // RAISED 8 → 10 (remediation-state-verification-reconciler.md): a THIRD
  // reader over this view family — `getStaleAcceptedFindingsForVerification` +
  // its counter `countStaleAcceptedFindingsForVerification`, both in
  // ship-nudges.mjs, reading `unremediated_acceptances_all` unbounded by age.
  it('finds the readers at all (guards against the regex silently matching nothing)', () => {
    assert.ok(readers.length >= 10,
      `expected >=10 nudge-view readers, found ${readers.length} (${readers.map((r) => r.name).join(', ')}) ` +
      '— if this dropped, the scan below is passing vacuously. A reader whose view name is ' +
      'INTERPOLATED rather than written out is invisible here and will show up as a missing reader.');
  });

  for (const { file, name, body } of readers) {
    it(`${name} (${file}) has no repo-unfiltered read of a nudge view`, () => {
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

describe('a capped nudge reader must impose its OWN total order', () => {
  // THE DEFECT (upstream 96a829f8, HIGH, filed from a consumer 2026-08-10).
  // `getUnremediatedAcceptances` capped its page with no ORDER BY of its own
  // while the sibling `getUnlockedFixes` had carried one since the
  // arbitrary-page fix — the THIRD one-sibling-only divergence in this family,
  // after the LIMIT-counter and the repo-scope fence. Enumerating readers by
  // hand is what missed the first two, so this scans mechanically like the
  // scope block above.
  //
  // Why it is a real defect even though the output looked right: measured on
  // the live store, `unremediated_acceptances` defines its own inner
  // `ORDER BY CASE severity … , created_at ASC`, the planner keeps that Sort
  // under the outer LIMIT, and all 15 HIGH rows of 44 landed inside the page.
  // But Postgres does not guarantee a subquery's ORDER BY reaches an outer
  // query, and the sibling view carries no inner sort at all — so /ship's
  // "show at most 5 rows, HIGH first" was resting on an accident of one view's
  // text. The order has to be asserted where the LIMIT is applied.
  // Adjacent concatenated template literals are joined before scanning: a SQL
  // string long enough to need wrapping is written as `…` + `…`, and matching
  // each literal separately would see a FROM with no LIMIT and a LIMIT with no
  // FROM, so every statement would drop out of the filter and the suite would
  // pass having examined nothing. (The vacuous-pass guard below caught exactly
  // that while this test was being written.) Interpolating the clause into a
  // `const` is still invisible here, and that is intended — the source must
  // keep its SQL literal for a static scan to mean anything.
  const storeSrc = storeFiles.map((f) => f.src).join('\n').replace(/`\s*\+\s*`/g, '');
  const NUDGE_VIEWS = [
    'unlocked_fixes', 'unlocked_fixes_all',
    'unremediated_acceptances', 'unremediated_acceptances_all',
  ];

  // Only SELECTs that actually take a page. A `count(*) … GROUP BY` needs no
  // order (it returns a set the caller reduces), and demanding one there would
  // be cargo-culting the rule rather than enforcing it.
  const pagedStatements = [...storeSrc.matchAll(/`([^`]*)`/g)].map((m) => m[1])
    .filter((sql) => NUDGE_VIEWS.some((v) => new RegExp(`FROM\\s+${v}\\b`).test(sql)))
    .filter((sql) => /\bLIMIT\b/.test(sql))
    // A single-row lookup by primary key (`findUnlockedFixInRepo`) is already
    // deterministic: the predicate selects at most one row, so LIMIT 1 cannot
    // choose between candidates.
    .filter((sql) => !/audit_finding_id\s*=\s*\$\d/.test(sql));

  // Same reasoning as the reader floor above: this read `>= 2` while six paged
  // statements existed, so an interpolated view name could remove two thirds of
  // the coverage without failing anything.
  //
  // RAISED 6 → 7 (remediation-state-verification-reconciler.md):
  // `getStaleAcceptedFindingsForVerification` adds one paged statement; its
  // counter has no LIMIT and correctly does not join this count.
  it('finds paged statements at all (vacuous-pass guard)', () => {
    assert.ok(pagedStatements.length >= 7,
      `expected >=7 paged nudge-view reads, found ${pagedStatements.length} — if this dropped, ` +
      'the assertions below are checking less than they claim. A read whose view name is ' +
      'INTERPOLATED is invisible to this scan.');
  });

  for (const sql of pagedStatements) {
    const label = sql.replace(/\s+/g, ' ').trim().slice(0, 80);
    it(`orders before it caps: ${label}`, () => {
      assert.match(sql, /ORDER BY/i,
        'a LIMITed read of a nudge view with no ORDER BY returns an arbitrary page. Inheriting ' +
        'the view\'s inner ORDER BY does not count — Postgres does not guarantee it survives ' +
        `into an outer query:\n  ${sql}`);
      assert.ok(sql.search(/ORDER BY/i) < sql.search(/\bLIMIT\b/),
        `ORDER BY must precede LIMIT to select the page, not reorder it:\n  ${sql}`);
    });

    it(`its order is TOTAL, not merely a sort key: ${label}`, () => {
      // A non-total order permutes freely among ties, so paging it shows one
      // row twice and skips another — which is worse than an arbitrary single
      // page, because it looks like a complete enumeration.
      const order = sql.slice(sql.search(/ORDER BY/i));
      assert.match(order, /audit_finding_id/,
        'the final tiebreaker must be a unique column (audit_finding_id) or rows can reorder ' +
        `between pages:\n  ${sql}`);
    });
  }

  it('every paged reader threads limit/offset — a page you cannot advance hides its tail', () => {
    // Measured on the consumer: total 44, shown 20, and no CLI invocation could
    // reach the other 24. `--limit` was a globally-registered flag the handler
    // never read, so it was accepted, validated, and inert.
    for (const sql of pagedStatements) {
      assert.match(sql, /OFFSET/i, `paged read cannot advance past its first page:\n  ${sql}`);
    }
    // RETARGETED (Cluster D): `pageArgsFromFlags` became `pageArgs(ctx)` in
    // ship.mjs, and `--offset` moved from the global KNOWN_FLAGS union into
    // each paged command's own `flags` declaration — where it is strictly
    // safer: the dispatcher's accessor THROWS on an undeclared read, so the
    // flag cannot be accepted-and-inert the way the global list allowed.
    assert.match(cliSrc, /pageArgs\(ctx\)/,
      'the CLI must pass --limit/--offset to the readers, not merely accept the flags');
    assert.match(cliSrc, /ctx\.flag\('offset'\)/);
  });

  it('every paged command DECLARES --limit/--offset (else the dispatcher refuses them)', async () => {
    const { REGISTRY, normalizeFlag } = await import('../scripts/lib/cross-skill/registry.mjs');
    for (const name of ['list-unlocked-fixes', 'list-unremediated-acceptances']) {
      const entry = REGISTRY.find((e) => e.name === name);
      const declared = (entry.flags ?? []).map(normalizeFlag).map((d) => d.name);
      for (const f of ['limit', 'offset']) {
        assert.ok(declared.includes(f),
          `${name} must declare --${f} — an undeclared flag is REFUSED at exit 2, so the tail becomes unreachable again`);
      }
    }
  });

  it('the CLI echoes the RESOLVED page, so a clamp is visible to the caller', () => {
    // The store clamps (0, -5, NaN, 10_000). A caller who cannot see what it
    // actually received will read a short page as "the tail is empty".
    assert.match(cliSrc, /resolveNudgePage\(page\)/);
    assert.match(cliSrc, /rows, shown: rows\.length, total: byMode\.total, byMode,/);
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
  const storeSrc = storeFiles.map((f) => f.src).join('\n');
  // RETARGETED (Cluster D): this block-scoped binding SHADOWED the module-level
  // one and still pointed at scripts/cross-skill.mjs, whose dispatch map is now
  // empty — so the reader/counter pairing would have gone unchecked while
  // reading a file that can no longer contain either call. Named differently
  // from the outer `cliSrc` so the shadowing cannot silently return.
  const nudgeSrc = fs.readFileSync(
    path.join(repoRoot, 'scripts', 'lib', 'cross-skill', 'commands', 'ship.mjs'), 'utf-8');

  for (const { reader, counter } of PAIRS) {
    it(`${reader} exists and caps its rows (vacuous-pass guard)`, () => {
      // If the reader were renamed or stopped capping, the assertions below
      // would be pinning a contract nothing needs any more.
      assert.match(storeSrc, new RegExp(`function\\s+${reader}\\b`), `${reader} not found in the store`);
      // Bounded to THIS function, not to a byte window. It sliced the first
      // 1600 chars until 2026-08-11, when a comment added above the SQL pushed
      // a still-present LIMIT past the cutoff and the guard reported that the
      // reader had stopped capping. A magic length is wrong in both directions:
      // it can miss a real LIMIT (what happened), and it can borrow the NEXT
      // function's LIMIT to alibi a reader that genuinely lost its own.
      const startAt = storeSrc.search(new RegExp(`function\\s+${reader}\\b`));
      const after = storeSrc.slice(startAt + 1);
      const endRel = after.search(/^(?:export\s+)?(?:async\s+)?function\s+\w+/m);
      const body = endRel === -1 ? after : after.slice(0, endRel);
      // `LIMIT $n` counts as a cap as much as `LIMIT 20` does. This read
      // `/\bLIMIT\s+\d+/` until the readers took a bound page parameter
      // (2026-08-10), at which point it failed on a reader that still capped —
      // the assertion was pinned to the literal rather than to the property.
      assert.match(body, /\bLIMIT\s+(?:\d+|\$)/,
        `${reader} no longer caps its rows — re-check whether a counter is still required`);
    });

    it(`${counter} exists — ${reader}'s caller cannot otherwise report a real total`, () => {
      assert.match(storeSrc, new RegExp(`function\\s+${counter}\\b`),
        `${reader} caps its rows but ${counter}() is missing`);
    });

    it(`the nudge handlers call ${counter} wherever they call ${reader}`, () => {
      assert.match(nudgeSrc, new RegExp(`\\b${reader}\\s*\\(`), `handler must call ${reader} (else vacuous)`);
      assert.match(nudgeSrc, new RegExp(`\\b${counter}\\s*\\(`),
        `the handler calls ${reader} without ${counter} — the payload would carry capped rows and no total`);
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

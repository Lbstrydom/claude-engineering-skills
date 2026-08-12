/**
 * @fileoverview Regression locks for docs/plans/cross-skill-cli-integrity.md.
 *
 * Every case here pins a defect that was CONFIRMED BY EXECUTION against
 * HEAD 096b78c7 and then fixed — not a hypothesis about untouched code. Each
 * one is the same family: a read or a claim that is confidently WRONG rather
 * than absent, so the failure is invisible to a caller that only checks `ok`.
 *
 * The negative control for F1 is in-suite and deliberate: `legacyContextHash`
 * reproduces the exact pre-fix expression, and the first test asserts that it
 * COLLIDES. Without it, "the new hash distinguishes A from B" is a vacuous
 * pass — any hash function distinguishes two different inputs, so the test
 * would not have caught the bug it exists for. The control proves the subject
 * was genuinely broken and that this specific input reaches it.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { contextHash, canonicaliseContext } from '../scripts/lib/learning/decision-logger.mjs';
import { reconcileRepoIdentity } from '../scripts/lib/repo-scope.mjs';

const CROSS_SKILL_SRC = fs.readFileSync(
  fileURLToPath(new URL('../scripts/cross-skill.mjs', import.meta.url)), 'utf8',
);

/**
 * Source with comments stripped.
 *
 * Load-bearing: this file's comments deliberately QUOTE the defective
 * expressions they replaced ("this line used to read `JSON.stringify(ctx,
 * Object.keys(ctx).sort())`"), so a "the bad code is gone" assertion run over
 * raw source matches the explanation and fails. Three of this suite's
 * assertions failed that way on first run — instrument defects, every one, in
 * the direction that would have blocked a correct fix rather than passing a
 * broken one.
 */
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '$1')).join('\n');

const CODE = stripComments(CROSS_SKILL_SRC);

/**
 * The body of one named function, for assertions that must not be file-global.
 *
 * Brace-balanced, not "slice to the next `async function`". The naive version
 * (shadow final review, LOW) swallowed any non-async declaration that happened
 * to sit between two async ones, so a negative assertion — "this defective
 * expression is absent from cmdX" — silently changed scope whenever neighbouring
 * code moved: it could pass because the expression moved out, or fail because
 * unrelated code moved in. Both are wrong answers about the subject under test.
 */
function functionBody(name) {
  const start = CODE.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1, `function ${name} not found`);
  const open = CODE.indexOf('{', start);
  assert.notEqual(open, -1, `function ${name} has no body`);
  let depth = 0;
  for (let i = open; i < CODE.length; i += 1) {
    if (CODE[i] === '{') depth += 1;
    else if (CODE[i] === '}') {
      depth -= 1;
      if (depth === 0) return CODE.slice(start, i + 1);
    }
  }
  assert.fail(`unbalanced braces while extracting ${name}`);
  return '';
}

// ── Behavioural harness ─────────────────────────────────────────────────────
// The source-text assertions above pin that a specific defective EXPRESSION has
// not returned; they cannot show the command behaves correctly. These spawn the
// real CLI with no DSN, so they run anywhere (including the pre-push sandbox
// worktree, which has no gitignored inputs).
const CLI_PATH = fileURLToPath(new URL('../scripts/cross-skill.mjs', import.meta.url));
let tmp;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xskill-integrity-')); });
after(() => { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

function runCli(...args) {
  const dir = fs.mkdtempSync(path.join(tmp, 'case-'));
  const env = { ...process.env, HOME: dir, USERPROFILE: dir, AUDIT_LOOP_DISABLE_SHARED: '1' };
  delete env.DOTENV_CONFIG_PATH;
  delete env.AUDIT_DB_URL;
  const r = spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: 'utf8', env, cwd: dir, timeout: 60_000,
  });
  const line = r.stdout.split('\n').filter((l) => l.trim().startsWith('{')).pop();
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json: line ? JSON.parse(line) : null };
}

describe('behavioural — the commands themselves, not their source text', () => {
  it('record-ship-event refuses a payload with no outcome (exit 2, typed error)', () => {
    const out = runCli('record-ship-event', '--json', '{}');
    assert.equal(out.json?.ok, false);
    assert.equal(out.json.error.code, 'BAD_INPUT');
    assert.equal(out.status, 2);
  });

  it('record-regression-spec-run refuses a payload with no specId', () => {
    const out = runCli('record-regression-spec-run', '--json', '{"passed":true}');
    assert.equal(out.json?.ok, false);
    assert.equal(out.json.error.code, 'BAD_INPUT');
  });

  it('VACUOUS-PASS GUARD: a well-formed call is NOT rejected', () => {
    // Without this, a handler that refused everything would satisfy both cases
    // above. Cloud is off here, so the documented graceful no-op is the success.
    const out = runCli('record-ship-event', '--json', '{"outcome":"success"}');
    assert.equal(out.json?.ok, true, `well-formed call was rejected: ${JSON.stringify(out.json)}`);
    assert.equal(out.json.cloud, false, 'no DSN configured — must take the cloud-off path');
  });

  it('persona-outcomes with an unknown sub-verb prints usage rather than acting', () => {
    const out = runCli('persona-outcomes', 'bogus-verb');
    assert.equal(out.json?.ok, false);
    assert.equal(out.json.error.code, 'BAD_INPUT');
    assert.match(out.json.error.message, /summary\|label\|backfill-hash/);
  });

  it('an unregistered flag is rejected before any handler runs', () => {
    // The guard that makes the declared-flag census meaningful: without it, an
    // unread flag would simply be ignored rather than refused.
    const out = runCli('whoami', '--not-a-real-flag');
    assert.equal(out.status, 2);
    assert.equal(out.json, null, 'a rejected flag must not also emit a result envelope');
  });

  it('--selfcheck-relocation survives the relocation contract', () => {
    const out = runCli('--selfcheck-relocation');
    assert.equal(out.status, 0);
    assert.match(out.stdout, /OK/);
  });
});

/** The EXACT pre-fix expression from cross-skill.mjs:2954. Negative control only. */
const legacyContextHash = (ctx) =>
  crypto.createHash('sha256')
    .update(JSON.stringify(ctx, Object.keys(ctx).sort()))
    .digest('hex');

describe('F1 — learning-record context_hash uses the one oracle', () => {
  // Differ ONLY below the top level: the case the replacer array cannot see.
  const A = { passName: 'backend', meta: { model: 'gpt-5.6', tokens: 100 } };
  const B = { passName: 'backend', meta: { model: 'gemini', tokens: 999 } };
  const AReordered = { meta: { tokens: 100, model: 'gpt-5.6' }, passName: 'backend' };

  it('NEGATIVE CONTROL: the pre-fix expression really did collide on these inputs', () => {
    // If this ever stops failing-by-colliding, the control is vacuous and the
    // assertions below stop proving anything — that is what it is here to catch.
    assert.equal(
      legacyContextHash(A), legacyContextHash(B),
      'control is vacuous: the legacy expression no longer collides, so the '
      + 'test inputs no longer exercise the defect',
    );
    assert.equal(
      JSON.stringify(A, Object.keys(A).sort()), '{"meta":{},"passName":"backend"}',
      'control is vacuous: the legacy expression no longer empties nested objects',
    );
  });

  it('distinguishes contexts that differ only in a NESTED value', () => {
    assert.notEqual(contextHash(A), contextHash(B));
  });

  it('stays invariant under key reordering at every level', () => {
    assert.equal(contextHash(A), contextHash(AReordered));
  });

  it('preserves nested content in the canonical form', () => {
    assert.equal(canonicaliseContext(A), '{"meta":{"model":"gpt-5.6","tokens":100},"passName":"backend"}');
  });

  it('cross-skill.mjs no longer carries its own copy of the hash', () => {
    // Keyed on the CONSEQUENCE (a second implementation exists) rather than on
    // one spelling of it: any re-introduced local sha256-over-stringify here is
    // a second writer of the same column.
    // RETARGETED (command-registry Cluster B): learning-record migrated to
    // commands/misc.mjs. The negative half still guards the LEGACY file (the
    // defective expression must not reappear anywhere), and the positive half
    // follows the handler to its new home.
    const miscSrc = stripComments(fs.readFileSync(
      fileURLToPath(new URL('../scripts/lib/cross-skill/commands/misc.mjs', import.meta.url)), 'utf8',
    ));
    assert.ok(
      !/Object\.keys\(p\.context\)\.sort\(\)/.test(CODE) && !/Object\.keys\(p\.context\)\.sort\(\)/.test(miscSrc),
      'the replacer-array context hash is back',
    );
    assert.ok(
      /contextHash: computeContextHash/.test(miscSrc),
      'learningRecordCmd must import decision-logger\'s contextHash, not re-implement it',
    );
  });
});

describe('F2/F3 — writers report their own outcome', () => {
  it('recordShipEvent and recordRegressionSpecRun return a status, never undefined', async () => {
    const store = await import('../scripts/lib/store/plans-ship.mjs');
    // Input-validation refusals are reachable without a store: both must be a
    // discriminated `{ok:false}`, not the old bare `return;`.
    const noOutcome = await store.recordShipEvent(null, {});
    assert.equal(noOutcome?.ok, false, 'recordShipEvent(missing outcome) must report ok:false');
    assert.equal(noOutcome.reason, 'missing-outcome');

    const noSpec = await store.recordRegressionSpecRun(null, {});
    assert.equal(noSpec?.ok, false, 'recordRegressionSpecRun(missing specId) must report ok:false');
    assert.equal(noSpec.reason, 'missing-spec-id');
  });

  it('both CLI handlers branch on the returned status', () => {
    // RETARGETED (command-registry Cluster A): record-ship-event moved to the
    // registry — its fail-closed branch now lives in commands/ship.mjs, and
    // the guarantee is additionally behavioural in
    // tests/cross-skill-store-calls.test.mjs (the store's {ok:false} becomes
    // a thrown CommandError). record-regression-spec-run is still legacy.
    // Both writers now live in commands/ship.mjs (Cluster A moved
    // record-ship-event; Cluster B moved record-regression-spec-run). Their
    // fail-closed guarantee is additionally behavioural in
    // tests/cross-skill-store-calls.test.mjs.
    const shipSrc = fs.readFileSync(
      fileURLToPath(new URL('../scripts/lib/cross-skill/commands/ship.mjs', import.meta.url)), 'utf8',
    );
    assert.ok(/ship event not persisted/.test(shipSrc),
      'recordShipEventCmd must fail closed on a failed write');
    assert.ok(/regression spec run not persisted/.test(shipSrc),
      'recordRegressionSpecRunCmd must fail closed on a failed write');
  });

  it('ux-lock-run `recorded` is no longer a bare alias for `cloud`', () => {
    // Comments stripped: this file's comments quote the defective expressions
    // they replaced, so a raw-source match reads the explanation, not the code.
    const src = stripComments(fs.readFileSync(
      fileURLToPath(new URL('../scripts/ux-lock-run.mjs', import.meta.url)), 'utf8',
    ));
    assert.ok(!/recorded: cloud,/.test(src),
      '`recorded: cloud` asserts "the runs were recorded" while only meaning '
      + '"a store is configured" — it must account for write failures');
    // Key on the CONSEQUENCE, not one spelling of the expression: `recorded`
    // must be conditioned on BOTH ways recording can silently not happen. The
    // first version of this assertion pinned the exact string and then failed
    // when the expression was correctly EXTENDED to cover the identity outage —
    // an instrument that blocks a real improvement.
    const recordedExpr = src.match(/recorded: ([^,\n]+)/)?.[1] ?? '';
    assert.match(recordedExpr, /specRunPersistFailures/,
      '`recorded` must account for failed spec-run writes');
    assert.match(recordedExpr, /identityFailed/,
      '`recorded` must account for a repo-identity outage that skipped recording');
  });
});

describe('F6 — persona-session identity is reconciled even when BOTH fields are supplied', () => {
  const ambient = { repoRowId: 'id-B', repoUuid: 'uuid-B', name: 'owner/repo-B' };

  it('a payload naming repo A from a checkout of repo B is refused', () => {
    const merged = reconcileRepoIdentity({ repoId: 'id-A', repoName: 'owner/repo-A' }, ambient);
    assert.equal(merged.ok, false, 'a cross-repo payload must not be written verbatim');
  });

  it('the reconcile call is NOT gated on a field being missing', () => {
    assert.ok(
      !/if \(!data\.repoId \|\| !data\.repoName\) \{\s*\n\s*const ref = await resolveRepoForStore/.test(CROSS_SKILL_SRC),
      'reconciliation gated on a missing field skips the exact input it exists to check',
    );
  });

  it('no ambient identity still passes an explicit pair through (CI escape hatch)', () => {
    const merged = reconcileRepoIdentity({ repoId: 'id-A', repoName: 'owner/repo-A' }, null);
    assert.equal(merged.ok, true);
    assert.equal(merged.repoId, 'id-A');
  });
});

describe('F7 — repo resolution failure is distinguishable from absence', () => {
  it('resolveRepoForStoreResult is exported and discriminated', async () => {
    const store = await import('../scripts/lib/store/repo.mjs');
    assert.equal(typeof store.resolveRepoForStoreResult, 'function');
    // With no DSN configured the honest answer is `cloud-off`, NOT a null that
    // a writer would read as "this repo has no identity".
    const r = await store.resolveRepoForStoreResult({});
    assert.ok(['resolved', 'cloud-off', 'unresolved', 'error'].includes(r.kind),
      `unexpected kind: ${JSON.stringify(r)}`);
  });

  it('resolveRepoId fails closed on a transient lookup error', () => {
    assert.ok(/refusing an unscoped write rather than silently dropping repo scope/.test(CROSS_SKILL_SRC));
    assert.ok(/ref\.kind === 'error'/.test(CROSS_SKILL_SRC),
      'the ambient branch must branch on the error kind, not collapse it to null');
  });
});

describe('F4/F5 — a flag that is accepted must decide something', () => {
  it('persona-outcomes resolves scope from --repo, not from the ambient checkout', async () => {
    // RETARGETED (command-registry Cluster A): cmdPersonaOutcomes migrated to
    // the registry, where the F4 guarantee is now STRUCTURAL — the entry
    // declares `scope: 'explicit-required'`, whose resolver (scope.mjs) is
    // `--repo`-authoritative by construction, and the behavioural half lives
    // in tests/cross-skill-store-calls.test.mjs ("the ambient checkout must
    // play NO part in an explicitly-named read"). This case pins the
    // declaration so a future re-declaration to an ambient policy is loud.
    const { REGISTRY } = await import('../scripts/lib/cross-skill/registry.mjs');
    const entry = REGISTRY.find((e) => e.name === 'persona-outcomes');
    assert.ok(entry, 'persona-outcomes must be a registry command');
    assert.equal(entry.scope, 'explicit-required',
      'the F4 fix IS this declaration — an ambient policy here reintroduces the silently-overridden --repo');
    // The legacy resolver survives for the not-yet-migrated reader below.
    assert.ok(/async function resolveRequestedRepoScope/.test(CODE));
  });

  it('get-persona-sessions-by-repo resolves the REQUESTED repo, not the ambient one', () => {
    // The same defect, found one command over by the round-2 audit. Its store
    // predicate is `repo_name = $1 AND (repo_id = $3 OR repo_id IS NULL)`, so an
    // ambient id produced `rows: []` WITH `scopedByRepoId: true` — a false zero
    // wearing a field that asserts correct scoping.
    const body = functionBody('cmdGetPersonaSessionsByRepo');
    assert.ok(/resolveRequestedRepoScope\(parsed\.data\.repoName\)/.test(body));
    assert.ok(!/resolveRepoForStore\(\{\}\)/.test(body),
      'the ambient resolver must not decide the scope of an explicitly-named repo');
  });

  it('an unresolvable --repo is refused even when --repo-id is valid', () => {
    // Round-2 audit caught this gap in the FIRST version of the fix: letting the
    // id win silently accepted a `--repo` naming a repo that does not exist.
    const body = functionBody('resolveRequestedRepoScope');
    const unknownBranch = body.indexOf('UNKNOWN_REPO');
    const idWins = body.indexOf('explicitId || byName');
    assert.ok(unknownBranch !== -1 && idWins !== -1);
    assert.ok(unknownBranch < idWins,
      'the unknown-name refusal must come BEFORE the explicit id is allowed to win');
  });

  it('abort-refresh-run fails closed when nothing was aborted', () => {
    // RETARGETED (command-registry Cluster B): moved to commands/arch-refresh.mjs.
    const src = stripComments(fs.readFileSync(
      fileURLToPath(new URL('../scripts/lib/cross-skill/commands/arch-refresh.mjs', import.meta.url)), 'utf8',
    ));
    assert.ok(/ABORT_NOT_APPLIED/.test(src),
      'a wrong-repo or already-terminal abort must not report ok:true');
    assert.ok(/if \(!aborted\)/.test(src));
    // The wrapper must not swallow that refusal: passthroughErrors re-throws a
    // CommandError untouched, or ABORT_NOT_APPLIED would lose its exit-1 and
    // its payload on the way out (caught while writing it).
    assert.ok(/if \(err instanceof CommandError\) throw err;/.test(src),
      'passthroughErrors must re-throw a handler CommandError, not re-wrap it');
  });

  it('ux-lock-run distinguishes a store outage from an unconfigured store', () => {
    // Comments stripped: this file's comments quote the defective expressions
    // they replaced, so a raw-source match reads the explanation, not the code.
    const src = stripComments(fs.readFileSync(
      fileURLToPath(new URL('../scripts/ux-lock-run.mjs', import.meta.url)), 'utf8',
    ));
    assert.ok(!/resolveRepoForStore\(\{\}\)\.catch\(\(\) => null\)/.test(src),
      'collapsing a lookup failure to null makes a broken store look like disabled recording');
    assert.ok(/resolveRepoForStoreResult/.test(src));
  });

  it('arm-eval-run no longer writes an unscoped session', () => {
    // Scoped to cmdArmEvalRun's body. A file-global ban on this expression was
    // wrong: `arm-eval-decision`/`arm-eval-stats`/`upstream list` use the same
    // spelling for READ scope, and their store functions already fail closed
    // (`throw` unless repoId or allRepos:true), so a null there is refused, not
    // silently widened. Only the WRITE path could persist repo_id NULL.
    assert.ok(!/argOption\('repo-id'\) \|\| null/.test(functionBody('cmdArmEvalRun')),
      'arm-eval-run must fall back to ambient identity like its sibling, not write repo_id NULL');
    assert.ok(/resolveScopedRepoId\(\)/.test(functionBody('cmdArmEvalRun')));
  });

  // ── The census's LIMIT, stated so it is not over-claimed ──────────────────
  //
  // The file-global census below proves only that each declared flag is read by
  // SOME handler. `KNOWN_FLAGS` is one global union and `assertKnownFlags`
  // validates names only, so a flag read by one subcommand is silently ACCEPTED
  // and IGNORED by the other ~60. That is exactly what F4 (`persona-outcomes
  // --repo`) and F16 (`get-recent-findings --repo-id`) were — and the global
  // census passed while both were live. It cannot catch that class, so it must
  // not be cited as evidence against it.
  //
  // This case is the check that WOULD have caught them: per-subcommand, for the
  // flags a subcommand documents and whose silent inertness caused a real
  // defect. It is a regression lock over known pairs, not a general prover —
  // the dispatch is dynamic and no static check enumerates it.
  it('a documented per-subcommand flag is actually read by that subcommand', () => {
    const REQUIRED = [
      // [handler, flag, why it matters]
      ['cmdGetRecentFindings', 'repo-id', 'F16 — accepted, never read; ambient repo silently substituted'],
      ['cmdGetRecentFindings', 'repo', 'the documented cross-repo override'],
      ['cmdGetPersonaSessionsByRepo', 'repo', 'F10 — false zero for the requested repo'],
      ['resolveRequestedRepoScope', 'repo-id', 'F4/F11 — explicit id must beat ambient, and conflict must be caught'],
      ['resolveShipNudgeScope', 'all-repos', 'explicit global must be evaluated BEFORE ambient inference'],
      ['cmdArmEvalRun', 'experiment', 'the subcommand does nothing meaningful without it'],
    ];
    const missing = [];
    for (const [fn, flag, why] of REQUIRED) {
      const body = functionBody(fn);
      const reads = new RegExp(`(argOption|hasFlag|argList|argAll)\\('${flag}'\\)`).test(body);
      if (!reads) missing.push(`${fn} does not read --${flag} (${why})`);
    }
    assert.deepEqual(missing, [],
      'a subcommand accepts a flag it never reads — the accepted-and-inert class');
  });

  it('every declared flag has a reader, and every read flag is declared', async () => {
    // Both directions. The one-directional version of this check is what let
    // `--report-path` be read-but-unregistered (rejected before its handler saw
    // it) while `--limit` was declared-but-unread (validated, then ignored).
    const known = new Set(
      [...CROSS_SKILL_SRC.match(/const KNOWN_FLAGS = \[([\s\S]*?)\n\];/)[1]
        .matchAll(/'(--[a-z0-9-]+)'/g)].map((m) => m[1]),
    );
    const body = CODE.slice(CODE.indexOf('function parsePayload'));
    const read = new Set();
    for (const re of [/argOption\('([a-z0-9-]+)'\)/g, /hasFlag\('([a-z0-9-]+)'\)/g,
      /argList\('([a-z0-9-]+)'\)/g, /argAll\('([a-z0-9-]+)'\)/g]) {
      for (const m of body.matchAll(re)) read.add(`--${m[1]}`);
    }
    // Not every flag goes through a helper: `--stdin` is read with
    // `rest.indexOf('--stdin')` and `--help` with `subcommand === '--help'`.
    // Recognising only the helpers reported both as inert — a false positive
    // that would have pushed someone to "fix" two working flags.
    for (const re of [/includes\('(--[a-z0-9-]+)'\)/g, /indexOf\('(--[a-z0-9-]+)'\)/g,
      /===\s*'(--[a-z0-9-]+)'/g]) {
      for (const m of body.matchAll(re)) read.add(m[1]);
    }
    // Registry-migrated commands read their flags through ctx accessors in
    // commands/*.mjs, but their names MUST stay in KNOWN_FLAGS until Phase 5
    // (main()'s global assert runs before registry dispatch, so removing
    // `--hash` would REJECT `persona-outcomes --hash` at the door). Their
    // declarations count as readers — and more strongly than a grep: the
    // dispatcher's declaration-checked accessor makes an undeclared read
    // throw, so a registry declaration cannot be inert the way a KNOWN_FLAGS
    // row could.
    const { REGISTRY, normalizeFlag } = await import('../scripts/lib/cross-skill/registry.mjs');
    for (const entry of REGISTRY) {
      for (const f of entry.flags ?? []) read.add(`--${normalizeFlag(f).name}`);
    }

    // Forwarded wholesale to another CLI, which reads them (see KNOWN_FLAGS).
    const FORWARDED = new Set(['--policy', '--baseline', '--since']);
    const declaredButUnread = [...known].filter((f) => !read.has(f) && !FORWARDED.has(f));
    const readButUndeclared = [...read].filter((f) => !known.has(f));

    assert.deepEqual(declaredButUnread, [],
      'flags accepted and validated but read by no handler — the inert-flag class');
    assert.deepEqual(readButUndeclared, [],
      'flags a handler reads but assertKnownFlags rejects first — the --report-path class');
  });
});

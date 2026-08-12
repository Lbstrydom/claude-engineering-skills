/**
 * @fileoverview Ship-domain registry commands (docs/plans/cross-skill-command-registry.md
 * — Cluster A template trio; grows in Phases 3–4).
 *
 * Behaviour-preserving moves of the legacy handlers: same envelope fields,
 * same refusal codes and exit codes, same ordering of store-touching
 * operations. Persistence goes through `ctx.deps` only.
 */
import { CommandError } from '../dispatch.mjs';

/**
 * `record-ship-event` — /ship writes its outcome. Moved from
 * `cmdRecordShipEvent`; the write template for every Cluster B migration:
 * validate → cloud degrade → lazy scope → port write → map the store's
 * discriminated result (`{ok:false}` becomes a thrown CommandError, never a
 * returned envelope — the unverified-write-success class F2 stays dead).
 */
export async function recordShipEventCmd(ctx) {
  const p = ctx.payload();
  if (!p.outcome) throw new CommandError('BAD_INPUT', 'outcome is required');
  if (!ctx.cloud.enabled) return ctx.degrade();
  const scope = await ctx.resolveScope();
  const repoId = scope.kind === 'scoped' ? scope.repoId : null;
  const res = await ctx.deps.recordShipEvent(repoId, {
    commitSha: p.commitSha || ctx.git.commitSha(),
    branch: p.branch || ctx.git.branch(),
    outcome: p.outcome,
    blockReasons: p.blockReasons,
    openP0Count: p.openP0Count,
    openP1Count: p.openP1Count,
    missingSpecCount: p.missingSpecCount,
    overriddenByUser: p.overriddenByUser,
    overrideFlag: p.overrideFlag,
    stackDetected: p.stackDetected,
    framework: p.framework,
    durationMs: p.durationMs,
  });
  if (!res.ok) {
    throw new CommandError('WRITE_FAILED',
      `ship event not persisted: ${res.reason ?? 'unknown'}${res.error ? ` (${res.error})` : ''}`,
      { reason: res.reason ?? null }, 1);
  }
  return { ok: true, cloud: true };
}

/**
 * Shared shape for the two /ship-nudge backlog readers.
 *
 * `measured:false` is NOT "zero obligations" — it is "nothing was measured".
 * Collapsing the two is exactly how a foreign 207 and a local 0 both looked
 * like ordinary numbers. Every unresolved path therefore returns the same
 * explicit shape rather than an empty-but-clean row set.
 */
function unmeasured(scope, reason, extra = {}) {
  return {
    ok: true,
    cloud: true,
    scope: { mode: scope?.kind === 'global' ? 'all-repos' : 'unresolved', repoId: null, slug: scope?.slug ?? null },
    measured: false,
    reason,
    rows: [], shown: 0, total: 0, byMode: { total: 0, code: 0, plan: 0 },
    ...extra,
  };
}

/** The store-scope argument for a resolved scope (D18 explicit-scope contract). */
const storeScopeFor = (scope) => (scope.kind === 'global' ? { allRepos: true } : { repoId: scope.repoId });

/** `--limit` / `--offset` for the capped nudge readers; the store clamps. */
const pageArgs = (ctx) => ({ limit: ctx.flag('limit'), offset: ctx.flag('offset') });

/**
 * `list-unlocked-fixes` — HIGH/P0 fixes with no regression spec.
 *
 * `rows` is ONE PAGE, so its length is NOT the obligation count — reporting it
 * as one undercounted 232 as "20" for weeks. `byMode.plan` is surfaced
 * separately because a plan finding can never carry a spec, and folding it in
 * makes an unactionable half of the backlog read as work. `agedOut` reports
 * what the 14-day window DROPPED, so "not shown" and "not owed" stay distinct
 * and an obligation cannot be discharged by waiting.
 */
export async function listUnlockedFixesCmd(ctx) {
  if (!ctx.cloud.enabled) {
    return {
      ok: true, cloud: false, scope: { mode: 'unresolved', repoId: null, slug: null },
      measured: false, reason: 'cloud-off', rows: [], shown: 0, total: 0, byMode: { total: 0, code: 0, plan: 0 },
    };
  }
  const scope = await ctx.resolveScope();
  if (scope.kind === 'unresolved') return unmeasured(scope, scope.reason);

  const storeScope = storeScopeFor(scope);
  // `--all-ages` opts out of the 14-day window. The window stays the default:
  // an unbounded ship-time nudge becomes noise and earns `--no-verify`.
  const allAges = ctx.hasFlag('all-ages');
  const page = { ...pageArgs(ctx), allAges };
  const rows = await ctx.deps.getUnlockedFixes(storeScope, page);
  const byMode = await ctx.deps.countUnlockedFixes(storeScope, { allAges });
  const aged = await ctx.deps.countAgedUnlockedFixes(storeScope);
  const { limit, offset } = ctx.deps.resolveNudgePage(page);
  return {
    ok: true, cloud: true,
    scope: { mode: scope.kind === 'global' ? 'all-repos' : 'repo', repoId: scope.repoId ?? null, slug: scope.slug ?? null },
    measured: true, reason: null,
    rows, shown: rows.length, total: byMode.total, byMode,
    allAges,
    agedOut: aged.agedOut, agedOutByMode: aged.byMode,
    prePractice: aged.prePractice, practiceStart: aged.practiceStart,
    // Echo the RESOLVED page, not the raw flags: the store clamps, so a caller
    // that asked for 10_000 and one that asked for nothing must be able to tell
    // what they actually received before concluding the tail is empty.
    limit, offset,
  };
}

/**
 * `list-unremediated-acceptances` — accepted findings never remediated.
 *
 * `notYetDue` (under the 7-day maturity floor) is reported beside `agedOut`
 * but is NOT a loss — those rows appear on their own once they mature.
 * Conflating them is the specific error this view invites, because both read
 * as "not shown". `acceptedPermanent` stays visible so the disposition cannot
 * become a silence button.
 */
export async function listUnremediatedAcceptancesCmd(ctx) {
  if (!ctx.cloud.enabled) {
    return {
      ok: true, cloud: false, scope: { mode: 'unresolved', repoId: null, slug: null },
      measured: false, reason: 'cloud-off', rows: [],
    };
  }
  const scope = await ctx.resolveScope();
  if (scope.kind === 'unresolved') return unmeasured(scope, scope.reason);

  const storeScope = storeScopeFor(scope);
  const allAges = ctx.hasFlag('all-ages');
  const page = { ...pageArgs(ctx), allAges };
  const rows = await ctx.deps.getUnremediatedAcceptances(storeScope, page);
  const byMode = await ctx.deps.countUnremediatedAcceptances(storeScope, { allAges });
  const aged = await ctx.deps.countAgedUnremediatedAcceptances(storeScope);
  const acceptedPermanent = await ctx.deps.countAcceptedPermanent(storeScope);
  const { limit, offset } = ctx.deps.resolveNudgePage(page);
  return {
    ok: true, cloud: true,
    scope: { mode: scope.kind === 'global' ? 'all-repos' : 'repo', repoId: scope.repoId ?? null, slug: scope.slug ?? null },
    measured: true, reason: null,
    rows, shown: rows.length, total: byMode.total, byMode,
    byDisposition: { open: byMode.total, acceptedPermanent },
    allAges,
    agedOut: aged.agedOut, agedOutByMode: aged.byMode, agedOutBySeverity: aged.bySeverity,
    notYetDue: aged.notYetDue,
    prePractice: aged.prePractice, practiceStart: aged.practiceStart,
    limit, offset,
  };
}

/**
 * `recommend-skills` — the à-la-carte "what's worth running next" advisor.
 * Deterministic, nudge-not-gate, silent when nothing fits.
 */
export async function recommendSkillsCmd(ctx) {
  const { recommendSkills, renderRecommendationCard } = await import('../../skill-recommender.mjs');
  const { execSync } = await import('node:child_process');
  const { readFileSync } = await import('node:fs');
  const csv = (s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : []);

  const gitChangedFiles = () => {
    const run = (cmd) => {
      try {
        return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' })
          .split('\n').map((s) => s.trim()).filter(Boolean);
      } catch { return []; }
    };
    return [...new Set([...run('git diff --name-only HEAD'), ...run('git ls-files --others --exclude-standard')])];
  };

  const changedFiles = ctx.flag('changed') ? csv(ctx.flag('changed')) : gitChangedFiles();
  // `PERSONA_TEST_APP_URL` unset is not the same fact as "no live target" — a
  // repo that only sets it for CI/PR-preview but runs a local dev server
  // otherwise has a runnable URL this env-only check would miss.
  const hasLiveUrl = Boolean(ctx.flag('url') || process.env.PERSONA_TEST_APP_URL);
  const justRan = ctx.flag('just-ran') || null;
  const maxFlag = ctx.flag('max');
  const max = Number.isFinite(Number(maxFlag)) && maxFlag ? Number(maxFlag) : 2;
  const planLenses = csv(ctx.flag('plan-lenses'));

  let auditFindings = [];
  const findingsFile = ctx.flag('findings');
  if (findingsFile) {
    try {
      const raw = JSON.parse(readFileSync(findingsFile, 'utf8'));
      auditFindings = Array.isArray(raw) ? raw
        : (Array.isArray(raw.findings) ? raw.findings
          : (Array.isArray(raw.allFindings) ? raw.allFindings : []));
    } catch (e) { process.stderr.write(`  [recommend] could not read --findings ${findingsFile}: ${e.message}\n`); }
  }

  // Idempotent ux-lock signal. Graceful when cloud is off (no signal, not an error).
  let unlockedHighFix = false;
  try {
    const ref = await ctx.deps.resolveRepoForStore({}).catch(() => null);
    if (ref?.repoRowId) {
      const rows = await ctx.deps.getUnlockedFixes({ repoId: ref.repoRowId });
      unlockedHighFix = Array.isArray(rows) && rows.length > 0;
    }
  } catch { /* cloud off / store error → no ux-lock signal, proceed */ }

  const recommendations = recommendSkills({ changedFiles, hasLiveUrl, auditFindings, planLenses, unlockedHighFix, justRan, max });
  const card = renderRecommendationCard(recommendations);
  if (ctx.flag('format') === 'human') { process.stdout.write(card); return undefined; }
  return { ok: true, hasLiveUrl, recommendations, card };
}

/**
 * `preview-gate` — resolve the /cycle Step 5 deploy-topology gate.
 *
 * The executable seam the cycle SKILL calls rather than re-deciding in prose.
 * `--format human` prints a one-line directive and emits no envelope, which is
 * why the handler returns undefined on that branch (the dispatcher's
 * documented "the text IS the output" contract).
 */
export async function previewGateCmd(ctx) {
  const { resolvePreviewGate } = await import('../../cycle/topology.mjs');
  const { cycleConfig } = await import('../../config.mjs');
  const gate = resolvePreviewGate(cycleConfig);
  if (ctx.flag('format') === 'human') {
    const tag = gate.action === 'halt' ? 'HALT' : gate.action === 'warn' ? 'WARN' : 'OK';
    process.stdout.write(gate.message ? `[${tag}] ${gate.message}\n` : '[OK] preview gate not_applicable — no action.\n');
    return undefined;
  }
  return { ok: true, ...gate };
}

/**
 * `lock-with-test` — record a unit/integration test as a finding's regression lock.
 *
 * REUSES `recordRegressionSpec` (a `unit-test` row has the identical shape).
 * What lives HERE and not in the store is the disk check: the store has no
 * business touching the filesystem, and "this test file exists" is a
 * CLI-boundary fact.
 *
 * The refusal is the point. A row saying "tests/foo.test.mjs locks finding X"
 * is a CLAIM, and closing 119 obligations by matching `primary_file` to a
 * same-named test would have moved the number while proving nothing.
 */
export async function lockWithTestCmd(ctx) {
  if (!ctx.cloud.enabled) return { ...ctx.degrade(), locked: false };
  if (ctx.hasFlag('worksheet')) return lockWithTestWorksheet(ctx);

  const findingId = ctx.flag('finding');
  const testPath = ctx.flag('test');
  const description = ctx.flag('description');
  if (!findingId || !testPath || !description) {
    // Concrete example, not `<angle-bracket>` syntax: PowerShell reserves `<`,
    // so a bracketed usage line is unpasteable on this repo's dev platform.
    return { ok: false, error: 'lock-with-test needs --finding, --test and --description. Example: '
      + 'node scripts/cross-skill.mjs lock-with-test --finding a4969127-d5d0-47bb-8b2e-0acb0ed71546 '
      + '--test tests/foo.test.mjs --description "pins the NUL-delimited parse path". '
      + 'The description is mandatory: an unexplained lock is an unverifiable claim. '
      + 'Run --worksheet for the reviewed queue.' };
  }

  const { realpathSync } = await import('node:fs');
  const { classifyTestPath } = await import('../../path-validation.mjs');
  const repoRoot = realpathSync(process.cwd());
  // Delegate to the one canonical realpath+containment oracle: the previous
  // check never RESOLVED the target, so an in-repo symlink pointing outside was
  // accepted, and `existsSync` accepts a DIRECTORY, so a lock could name a
  // directory and read as evidence (INC-001 class).
  const verdict = classifyTestPath({ repoRoot, testPath });
  if (!verdict.ok) {
    const why = {
      'path-escapes-repo': `"${testPath}" resolves outside the repo`,
      'not-a-file': `"${testPath}" is not a regular file`,
      'test-file-not-found': `test file "${testPath}" does not exist — a lock naming a missing file is a fake check`,
      'path-unresolvable': `"${testPath}" could not be resolved (broken symlink or permission error)`,
      'sensitive-path': `"${testPath}" is a sensitive path`,
      'empty-path': 'a test path is required',
    }[verdict.reason] ?? verdict.reason;
    return { ok: false, error: `refusing: ${why}`, reason: verdict.reason };
  }

  // CROSS-TENANT WRITE FENCE. This used to scan an arbitrary 20 cross-repo rows
  // and adopt whatever repo_id the matched row carried — a legitimate finding
  // usually was NOT among those 20, and a foreign row's repo_id could be
  // written straight into a regression spec. Resolve identity FIRST, look the
  // finding up scoped to it, and take repo_id from the identity, never the row.
  const scope = await ctx.resolveScope();
  const repoId = scope.kind === 'scoped' ? scope.repoId : null;
  if (!repoId) {
    return { ok: false, error: 'refusing: repo identity unresolvable — a regression spec must be attributed to a repo, and guessing one is how another repo\'s findings got recorded.' };
  }
  const finding = await ctx.deps.findUnlockedFixInRepo({ repoId, findingId });
  if (!finding) {
    return { ok: false, error: `refusing: no unlocked finding "${findingId}" in THIS repo. If it exists elsewhere it belongs to another repository — locking it here would attribute the fix to the wrong repo.` };
  }

  const spec = await ctx.deps.recordRegressionSpec(repoId, {
    specPath: testPath,
    description,
    sourceKind: 'unit-test',
    sourceFindingId: findingId,
    sourceFindingType: 'audit',
    assertionCount: 0,
    domContractTypes: [],
  });
  // §2b F2. `locked` was `!!spec` — the same bare null that meant cloud-off,
  // five input refusals, and a DB outage. This command's whole job is to report
  // whether the finding IS locked, so an unverified write reporting
  // `locked:false` at exit 0 is the worst available answer: indistinguishable
  // from a refusal the operator can act on. It stays inside lock-with-test's
  // existing `{ok:false, error:'refusing: …'}` shape rather than throwing,
  // because this command reports refusals as data (its softFail declaration is
  // about the refusal paths, not about the write).
  if (!spec.ok) {
    return { ok: false, cloud: spec.cloud, locked: false, findingId, testPath, reason: spec.reason, error: `regression spec NOT written: ${spec.message}` };
  }
  return { ok: true, cloud: true, locked: true, specId: spec.specId, findingId, testPath };
}

/**
 * Operator worksheet for the unlocked-code backlog.
 *
 * The suggested test is a FILENAME HEURISTIC and is labelled as one: it does
 * NOT establish that the test covers the finding, which is why this emits a
 * queue for review instead of writing rows.
 */
async function lockWithTestWorksheet(ctx) {
  const { findTestFilesFor, classifyTestMatch } = await import('../../test-file-search.mjs');
  const { shellQuoteSingle, shellQuoteLabel } = await import('../../shell-quote.mjs');
  const scope = await ctx.resolveScope();

  // PER-COMMAND SCOPE CAPABILITY (plan D21). `--all-repos` is legitimate on the
  // read-only list-unlocked-fixes; it is NOT legitimate here, because every row
  // carries a pasteable lock command and lock-with-test refuses findings from
  // another repo. A global worksheet would be a queue of instructions that
  // cannot be followed. Refused BEFORE any store call.
  if (scope.kind === 'global') {
    return { ok: false, reason: 'all-repos-unsupported',
      error: '--all-repos is not supported by lock-with-test --worksheet: every row it emits is a '
        + 'per-repo lock command, and lock-with-test refuses findings from another repo. '
        + 'Scope it (--repo/--repo-id, or run inside the repo), or use list-unlocked-fixes --all-repos to browse.' };
  }
  if (scope.kind === 'unresolved') {
    return { ok: true, measured: false, reason: scope.reason, worksheet: '',
      note: 'repo scope unresolved — nothing was measured (this is NOT "no unlocked fixes").' };
  }

  // `mode` is applied in SQL, BEFORE the 20-row cap. Filtering in JS afterwards
  // took an arbitrary subset of an arbitrary subset.
  const storeScope = storeScopeFor(scope);
  const rows = await ctx.deps.getUnlockedFixes(storeScope, { mode: 'code' });
  // `allAges: false` spelled out rather than inherited — this line once read
  // `{ allAges }` against no such binding and threw on EVERY invocation of the
  // command /ship Step 0.5b tells operators to run.
  const byMode = await ctx.deps.countUnlockedFixes(storeScope, { allAges: false });
  const capped = byMode.code > rows.length;

  const lines = ['# Unlocked code fixes — regression-lock worksheet', '',
    `${rows.length} shown of ${byMode.code} code obligations`
      + `${capped ? ' (page caps at 20 — re-run after locking these)' : ''}`
      + `${byMode.plan ? `; ${byMode.plan} plan finding(s) excluded — they can never carry a spec` : ''}.`,
    '',
    'The suggested test is a **filename heuristic only** — it does not prove the',
    'test covers this finding. Confirm by reading the test, then run its command.',
    'If no test covers it, write one; do NOT lock it to an unrelated file.',
    '',
    'One test file may lock SEVERAL findings — run every command below, including',
    'repeats of the same path.', ''];

  for (const r of rows) {
    const matches = findTestFilesFor(r.primary_file, process.cwd());
    const guess = matches[0] ?? null;
    // A rendered command is READ AS EVIDENCE that the lock is sound — that is
    // the whole reason it saves typing. So it is withheld when the only
    // candidate's directories contradict the source's.
    const verdict = guess ? classifyTestMatch(r.primary_file, guess) : null;
    const others = matches.length > 1 ? ` (+${matches.length - 1} other same-named match(es))` : '';
    lines.push(`## ${r.audit_finding_id}`);
    lines.push(`- file: \`${r.primary_file}\``);
    lines.push(`- category: ${r.category}`);
    if (!guess) {
      lines.push('- suggested test: **none found — write one**');
    } else if (verdict === 'unrelated') {
      lines.push(`- suggested test: **none confident**. Closest basename match is \`${guess}\`${others}, `
        + 'but it lives under a different module — a same-named file from elsewhere is not coverage. '
        + 'Read it, or write a test; then run `lock-with-test` with the path spelled out.');
    } else {
      lines.push(`- suggested test: \`${guess}\`${others} (exists — READ IT before locking)`);
      // Every interpolated value is shell-quoted: `guess` is discovered by
      // globbing and `category` is model-generated text, and the previous
      // rendering put the latter inside DOUBLE quotes with only `"` escaped —
      // which still expands `$(...)`, backticks and `$VAR`.
      lines.push('', '```bash',
        'node scripts/cross-skill.mjs lock-with-test'
        + ` --finding ${shellQuoteSingle(r.audit_finding_id)}`
        + ` --test ${shellQuoteSingle(guess)}`
        + ` --description ${shellQuoteLabel(`pins: ${r.category}`)}`,
        '```');
    }
    lines.push('');
  }
  process.stdout.write(`${lines.join('\n')}\n`);
  return undefined;
}

/**
 * `record-regression-spec` — /ux-lock writes a new Playwright spec.
 *
 * Moved from `cmdRecordRegressionSpec`. The `!repoId` refusal is load-bearing
 * and stays a hard error: the (repo_id, spec_path) arbiter is a FULL index and
 * a NULL repo_id is distinct from every other NULL in Postgres, so an unscoped
 * row INSERTs a duplicate on every re-run instead of updating.
 */
export async function recordRegressionSpecCmd(ctx) {
  const p = ctx.payload();
  if (!p.sourceKind || !p.description) {
    throw new CommandError('BAD_INPUT', 'sourceKind and description are required');
  }
  if (!p.specPath) throw new CommandError('BAD_INPUT', 'specPath is required');
  if (!ctx.cloud.enabled) return { ...ctx.degrade(), specId: null };
  const scope = await ctx.resolveScope();
  const repoId = scope.kind === 'scoped' ? scope.repoId : null;
  if (!repoId) {
    throw new CommandError('BAD_INPUT',
      'regression specs require a resolved repoId — run resolve-repo-identity --persist first');
  }
  const res = await ctx.deps.recordRegressionSpec(repoId, {
    specPath: p.specPath ?? null,
    description: p.description,
    commitSha: p.commitSha || ctx.git.commitSha(),
    assertionCount: p.assertionCount,
    domContractTypes: p.domContractTypes,
    sourceKind: p.sourceKind,
    sourceFindingId: p.sourceFindingId,
    sourceFindingType: p.sourceFindingType,
  });
  // §2b F2: the writer reports its own outcome, so `ok: !!specId` is no longer
  // writable. `/ux-lock` reads `.specId` on success, which is unchanged; what
  // changes is that a REFUSED or FAILED write is now exit 1 with a reason
  // instead of `{ok:false}` at exit 0.
  if (!res.ok) {
    // Exit 1 for a write that FAILED, 2 for one the store REFUSED on its input.
    // The repo's convention is "you asked wrong" (2) vs "we tried and it did not
    // work" (1), and collapsing them would put a DB outage in the same bucket as
    // a typo — which is the distinction this whole conversion exists to restore.
    const failed = res.reason === 'write-failed';
    throw new CommandError(failed ? 'WRITE_FAILED' : 'BAD_INPUT',
      `recordRegressionSpec: ${res.message}`, { reason: res.reason }, failed ? 1 : 2);
  }
  return { ok: true, cloud: true, specId: res.specId };
}

/**
 * `record-regression-spec-run` — append a pass/fail run to a spec.
 *
 * Moved from `cmdRecordRegressionSpecRun`. The store reports its own outcome
 * (fixed 2026-08-12): this emitted an unconditional `{ok:true}` while the
 * writer swallowed every error, so a run that never reached the store reported
 * as persisted.
 *
 * NOTE (Cluster F): `specId` is an opaque parent id with no ownership check —
 * the deferred `parent: {table:'regression_specs'}` declaration lands here.
 */
export async function recordRegressionSpecRunCmd(ctx) {
  const p = ctx.payload();
  if (!p.specId || typeof p.passed !== 'boolean') {
    throw new CommandError('BAD_INPUT', 'specId and passed (bool) are required');
  }
  if (!ctx.cloud.enabled) return ctx.degrade();
  const res = await ctx.deps.recordRegressionSpecRun(p.specId, {
    passed: p.passed,
    commitSha: p.commitSha || ctx.git.commitSha(),
    capturedRegression: p.capturedRegression,
    durationMs: p.durationMs,
    errorMessage: p.errorMessage,
    runContext: p.runContext,
  });
  if (!res.ok) {
    throw new CommandError('WRITE_FAILED',
      `regression spec run not persisted: ${res.reason ?? 'unknown'}${res.error ? ` (${res.error})` : ''}`,
      { reason: res.reason ?? null }, 1);
  }
  return { ok: true, cloud: true };
}

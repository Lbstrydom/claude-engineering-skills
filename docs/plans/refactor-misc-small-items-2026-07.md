# Plan: Miscellaneous Small-Cluster Debt (2026-07-26 triage)

- **Date**: 2026-07-26 (re-traced 2026-08-17, implemented + shipped
  2026-08-23 — note: this plan's §Fix Designs/§`/audit-plan` trail/§`/audit-code`
  sections below carry an internal "2026-08-17" date label inherited from
  the re-trace session; the actual implementation, audit rounds, and
  fixture regeneration described happened 2026-08-23. Chronological
  sequence within the doc is accurate; the absolute date label on those
  sections is not — not corrected retroactively, given the volume).
- **Status**: Complete (2026-08-23) — code for all 7 in-scope topicIds
  landed under `/audit-code` (6 GPT rounds to the round cap + 1 rebuttal
  round + mandatory Gemini gate: `APPROVE`, 0 new findings), plus
  `tests/fixtures/expected-schema.json` regenerated from a real fresh
  Docker Postgres replay (`npm run db:local:regen` — Docker turned out to
  be available in this session after all) and verified: the identity-column
  regression suite passes (5/5) against that live container, and the exact
  CI drift-check step (`diffSchemas` against the regenerated fixture)
  reports "manifest matches live schema", reproduced twice independently.
  **Narrowed to 9 items (10 topicIds); fix designs for the 7 in this
  plan's execution scope survived 4 GPT rounds + 3 Gemini rounds during
  `/audit-plan` — see §Fix Designs and §`/audit-plan` trail.** Of the
  original 17 entries: 1 done directly under this plan (2026-07-27), 4
  closed by other work (2026-08-03/07-28), 1 corrected (was already fixed
  pre-plan). Items resolved individually as picked up, not
  implemented as one batch.
- **Author**: Claude (tech-debt backlog triage session)
- **Scope**: backend

> Origin: full `.audit/tech-debt.json` backlog triage (384 entries). This
> is the leftover bucket — originally 17 entries across 13 files, each a
> standalone 1-2-entry issue not sharing enough theme with another cluster
> to warrant its own plan doc. Verified against current source 2026-07-26;
> re-verified 2026-08-17 (see Progress notes below). Grouped here by file,
> no cross-cutting theme implied.

**Progress (2026-07-27)**: `duplicate-justification-pragma.mjs` (`67f8f414`/
`fbd71c9a`) — **done**. `^\s*` anchor added to `PRAGMA_RE`; 4 regression
tests added. Also fixed a related bug found while verifying: a real pragma
in `scripts/setup-postgres.mjs` was written as a JSDoc continuation line
(no comment-marker prefix), so it never actually matched at all — moved to
a standalone `//` comment line.

**Progress (2026-08-17, re-traced against current source, none via this
plan)**: 4 more topicIds closed, 1 entry corrected, **9 distinct items (10
topicIds) remain genuinely open**:
- `139dc8c30859` (gemini-review.mjs `thinkingBudget` literal) — **fixed**
  `05858e20` (2026-08-03): now `GEMINI_THINKING_BUDGET_BY_EFFORT` lookup.
- `19659d7a`/`0e18b00d`/`3f0e3fe7` (on-conflict.mjs `isNullableExpr` +
  atomic-write-adoption-guard.test.mjs identifier matching) — **fixed by
  one commit**, `869f69ca` (2026-07-28): `isNullableExpr` replaced by a
  three-valued `classifyNullability` lattice, and the guard now resolves
  real lexical bindings via `scripts/lib/import-binding.mjs` instead of
  matching identifier spelling.
- `1ff42c81c4f7` (schemas.mjs `FindingSchema` alias) — **claim was already
  stale when this plan was written**: the distinguishing comment landed in
  `afbcd022` (2026-04-05), 3.5 months before this plan's 2026-07-26
  authoring commit. Nothing to fix.

The remaining 9 items (10 topicIds — `linter.mjs` carries two) below are
unchanged from 2026-07-26 — re-verified against current source 2026-08-17,
not re-read off this text. (Corrects the earlier "8 items" count in this
plan's own Status line, per `/audit-plan` R1 finding M1 — `linter.mjs` was
being counted as one item despite carrying two topicIds under one bullet;
see §Fix Designs.)

---

## Fix Designs (2026-08-17, response to `/audit-plan` round 1)

`/audit-plan` R1 (`SIGNIFICANT_GAPS`, H:3 M:5) correctly found that several
"still open" bullets below stated the bug but not the fix design. Designs
for the 5 items with a real code change; the other 4 open items
(`86b51ca4ba56`, `9a7c7263`, `5cf9d863`'s collision half, `eff197286a47`)
are addressed by **correcting or citing an existing decision**, not by new
design — each note below says which.

**H1 — `linter.mjs` (`6a74fc5a892d` + `b99706f9393b`).** Two separate
claims, resolved differently. (`6a74fc5a892d`'s design was revised in
round 2 — see the R2 correction below; this is the current design.)
- `b99706f9393b` (`AUDIT_LOOP_ALLOW_TOOLS` documented but unimplemented) —
  **real gap, doc-only fix**: grep across `scripts/**/*.mjs` finds this env
  var in exactly one place, the docstring at `linter.mjs:14`. `--no-tools`
  is the sole real gate — traced end-to-end: `audit-loop.mjs:158` parses
  it → `openai-audit.mjs:668` reads it → `legacy-production-audit.mjs:2633`
  disables the tool pre-pass. Fix: delete the `AUDIT_LOOP_ALLOW_TOOLS=1 env`
  clause from the docstring (lines 13-14); `--no-tools` alone is the
  security control this comment claims two gates for. **Acceptance**: a
  repo-wide grep for `AUDIT_LOOP_ALLOW_TOOLS` after the fix returns zero
  matches.
- `6a74fc5a892d` (`cwd: process.cwd()`, post-filtered only) — **R2
  correction: real scoping gap, not just a docstring fix.** R1's claim that
  "no tool accepts per-file args" was wrong — it described the CURRENT
  hardcoded config (`language-profiles.mjs` args end in a literal `.`), not
  a capability limit: ESLint, Ruff, and Flake8 all accept path arguments;
  only `tsc`'s project-wide type-check semantics genuinely require running
  against the whole project (a single-file invocation loses cross-file type
  resolution). Fix: add a `scopeToFiles: true` flag to the eslint/ruff/flake8
  tool configs in `language-profiles.mjs` (absent/false for `tsc`). In
  `linter.mjs` `runTool`, when `toolConfig.scopeToFiles` is true, replace the
  trailing `'.'` in `toolConfig.args` with `'--'` followed by the relative
  `auditedFiles` paths, instead of invoking against the whole repo; keep the
  existing post-filter as a defense-in-depth no-op for these tools (harmless
  — the output is already scoped) and as the sole scoping mechanism for
  `tsc`, unchanged.

  **Gemini gate (round 2) correction — real crash bug.** `auditedFiles`
  comes from a diff-scoped audit, which includes **deleted** files (the
  diff has an entry for them even though nothing exists on disk anymore).
  The current project-wide `.` invocation tolerates this silently — a
  deleted file just never appears in the tool's own file traversal, so
  there's nothing to post-filter out. Passing a deleted file's path
  **explicitly** as an argument, as this fix does, breaks that: ESLint,
  Ruff, and Flake8 all fail loudly ("file not found" / non-zero exit) on a
  named path that doesn't exist, which — per `runTool`'s own non-zero-exit
  handling (`:132-145`) — is currently only tolerant of a *tool* failure
  with parseable `stdout`, not a hard invocation error. Fix: filter
  `auditedFiles` to files that still exist on disk (`fs.existsSync`,
  synchronous check before building argv — cheap, the file count is
  diff-bounded) before substituting them into `scopeToFiles` tools' argv. A
  deleted file has no content to lint, so dropping it from the scoped
  invocation loses nothing; it's excluded from tool output either way.

  **R3 correction — 3 gaps R3 found in this design, all addressed:**
  1. *Mixed-language file sets* — **already a non-issue**, not something to
     build: `executeTools` (`linter.mjs:156-174`) already unions files
     **per tool**, from the per-file `getProfileForFile` lookup, before
     calling `runTool` — the `auditedFiles` a given `runTool` call receives
     are already exactly the files whose language profile declares that
     tool. `scopeToFiles` only needs to use the `auditedFiles` parameter
     it's already given; no new filtering logic.
  2. *`-`-prefixed filenames read as options* — real gap, fixed by the
     `'--'` separator above (ESLint, Ruff, and Flake8's argparse all honour
     `--` as the end-of-options marker); note this in the docstring so a
     future tool addition preserves it.
  3. *Argv size limits on a large file set* — **R4 partial correction**:
     R3's "accepted bound" note was right that building a chunking/batching
     execution path is out of scope here (`runTool` has no other caller
     today, and engineering for a hypothetical full-repo-scoped invocation
     that doesn't currently exist is exactly the over-engineering this
     repo's own design-right-sizing rule warns against) — but R4 correctly
     pointed out that "in practice" is a caller convention, not a contract,
     and `runTool` is a reusable primitive nothing stops a future caller
     from misusing. Cheap, right-sized middle ground: add one explicit guard
     in `runTool`, before invoking `execFileSync`, that throws a clear error
     naming the file count when `scopeToFiles` is true and `auditedFiles.length`
     exceeds a documented sane ceiling (e.g. 2000 — orders of magnitude above
     any real diff, orders of magnitude below where `E2BIG` risk begins) —
     turning a rare, cryptic OS-level failure into an immediate, actionable
     one, without building batching nothing currently needs.

  A fourth case R3 asked about — an empty eligible-files set — was
  correctly ruled out **for the design as it stood at R3**: `executeTools`
  only ever creates a `toolsById` entry for a file whose profile declares
  that tool, so the RAW `auditedFiles` is non-empty for every `runTool`
  call.

  **Gemini gate (round 3) correction — that reasoning stopped being true
  the moment the deleted-file existence filter above was added.** A diff
  consisting entirely of deleted files for one language (e.g. removing
  obsolete `.py` scripts) makes the raw `auditedFiles` non-empty but the
  **post-existsSync-filtered** array empty — invoking a `scopeToFiles` tool
  with zero file arguments after `--` is a real, newly-introduced case, not
  the one R3 ruled out. Fix: after the existence filter, if the resulting
  array is empty, skip invoking the tool entirely and return the same
  `{status: 'no_tool', findings: [], usage: {files: 0}, ...}` shape
  `runTool` already returns for an unavailable tool (`:108`) — there is
  nothing to lint, so "did not run" is the correct, existing envelope
  shape, not a new one.

  The existence check needs the same test-injectable seam `linter.mjs`
  already uses for `execFileSync` (`_execFileSync` / `setExecFileSync` /
  `resetExecFileSync`, `:62-67`) — add `_existsSync` / `setExistsSync` /
  `resetExistsSync` the same way, so tests fake file presence without
  touching real disk.

  **Acceptance**: a regression test in `tests/linter.test.mjs` (existing
  suite), using both seams, asserting that `runTool` for an
  `eslint`-shaped config with `scopeToFiles: true` and `auditedFiles:
  ['a.js', '-rf.js', 'deleted.js']` — with the faked `existsSync` returning
  `true` for `a.js`/`-rf.js` and `false` for `deleted.js` — invokes
  `execFileSync` with `['--', 'a.js', '-rf.js']` as the trailing argv (via
  `setExecFileSync`): proving the scoping, that the option-injection-shaped
  filename is not swallowed as a flag, AND that the deleted file is
  silently dropped rather than passed through to crash the tool. A second
  case: `auditedFiles: ['deleted.js']` (existence faked `false`) returns
  `status: 'no_tool'` without invoking `execFileSync` at all — proving the
  all-deleted case is skipped, not passed through with an empty argv.

**H2 — `postgres-parity/generate-expected-schema.mjs` (`8c95c520`).** Add
`is_identity` and `identity_generation` to the `tables` query's
`json_build_object` (`:57-62`) — both columns already exist on
`information_schema.columns`, no join needed:
```sql
'is_identity', is_identity,
'identity_generation', identity_generation,
```
This distinguishes a `GENERATED ALWAYS/BY DEFAULT AS IDENTITY` column
(`is_identity='YES'`, `identity_generation` set) from a legacy `serial`
default (`is_identity='NO'`, `column_default` holds the `nextval(...)`
expression) — both remain distinguishable from `column_default` alone,
which is what the header comment (`:7-8`) already claims is captured.

**R2's "no new diff-reporting code needed" was traced in R3 and found
WRONG — this is a real second call site.** `setup-postgres.mjs:454`
(`diffSchemas`) does generic structural comparison (would pick up new keys
automatically), but it diffs the **committed fixture** against a
`SHARED_CATALOG_QUERIES` object (`setup-postgres.mjs:495`) that the file's
own comment admits is a **hand-duplicated copy** of the generator's SQL,
"kept in lock-step... when that script grows new fields, mirror the
change here." So the SQL change must land in **two files**:
`generate-expected-schema.mjs`'s `QUERIES.tables` (above) AND
`setup-postgres.mjs`'s `SHARED_CATALOG_QUERIES.tables` — identical two
lines added to both. Skipping the second file doesn't error; it makes
`--check-drift`/adopt-mode's live capture never see the two new columns,
so the fixture and the live-diff silently stop agreeing on what "captured"
means for identity columns specifically (the fixture has them, the
live-comparison object doesn't) — exactly the class of drift this repo's
own comment on that constant warns about.

After both SQL changes: regenerate the committed fixture via `npm run
db:local:regen` (**only** from a fresh replay per this repo's own
Postgres-Parity Store rule — never hand-edit the JSON).

**Acceptance**: a new test file, `tests/postgres-parity-identity-columns.test.mjs`
— against a disposable Postgres DB with the migrated schema intact, create
one `GENERATED ALWAYS AS IDENTITY` column and one legacy `serial` column,
run BOTH the generator's query and `captureLiveSchema`'s
`SHARED_CATALOG_QUERIES.tables` query against them, and assert (a) the
generated JSON records `is_identity='YES'` for the former and `'NO'` for
the latter (proving the fields round-trip in the fixture), AND (b)
`diffSchemas` reports NO difference when expected and live are produced
from the SAME schema (proving the two query copies actually agree — the
real risk this fix introduces).

**Gemini gate (round 2) correction — the acceptance criteria only tested
the no-false-positive direction, never the direction that actually proves
drift detection works.** (b) alone can pass vacuously — `diffSchemas`
could ignore the new fields entirely (a stripped-projection bug, or a
`live[k]`/`expected[k]` shape mismatch elsewhere) and two IDENTICAL
schemas would still report no difference either way, telling us nothing
about whether a REAL divergence in `is_identity`/`identity_generation`
gets caught. Add (c): construct `expected`/`live` from the SAME base
schema but with **one** column's `is_identity` flipped between the two
(everything else identical), and assert `diffSchemas` DOES report a
difference for that table — proving detection, not just proving silence
on agreement. (a)+(b)+(c) together close both directions: the fields
round-trip, agreement doesn't false-positive, and a real divergence
doesn't false-negative.

**Suite enrolment** (repo invariant — see
AGENTS.md "A DB suite no runner names has never run"): this new file needs
an intact migrated schema, not a destructive teardown, so it belongs in
`scripts/db-test-container.mjs`'s `ISOLATED_SUITE_FILES` (`:66`) —
**two edits, always**, per that file's own documented convention: add the
entry there AND to `.github/workflows/postgres-parity.yml`'s matching
step list.

**R4 — dismissing a scope-expansion ask on `8c95c520`'s fix.** R4 raised
(M1) that the two-copy `QUERIES`/`SHARED_CATALOG_QUERIES` design is itself
a DRY violation and asked this plan to unify them into one shared module.
**Dismissed as out of scope, not fixed**: the duplication — and its
"kept in lock-step... mirror the change here" comment — predates this plan
entirely; this plan's fix doesn't worsen it (the new acceptance test
proves the two copies agree after the fix, closing exactly the risk the
duplication creates for THIS change) and doesn't depend on it being
eliminated. Unifying two independently-evolved catalog-query modules
(`setup-postgres.mjs`'s adopt-mode diffing has its own error-handling and
`pool` lifecycle around the query loop) is a real, larger refactor that
belongs in its own plan if picked up — exactly the "the correct fix is
larger, so the smallest true function of the problem is the smaller one"
case AGENTS.md's design-right-sizing rule describes, not a defect in this
fix.

**H3 — `tests/tiered-shadow-compare.test.mjs` (`a5f8c94f`).**

**Gemini gate (round 1) correction — a real factual error in the R1-R4
design, caught by the mandatory final review, not by GPT.** Every prior
round's acceptance criterion assumed the air-gap block lives in (or could
be triggered by importing) `scripts/lib/audit/tiered-shadow-compare.mjs`
— the **production** module. It does not: the air-gap (`process.env.AUDIT_DB_URL
= ''` etc.) lives in the **test** file, `tests/tiered-shadow-compare.test.mjs`
itself (`:16-23`), as a top-level side effect of importing the *test*, not
the module under test. R4's probe design — `import
'../../scripts/lib/audit/tiered-shadow-compare.mjs'` and expect the
air-gap to fire — would import the production module directly, which
contains no air-gap code at all, and the probe would silently prove
nothing (both env vars would print back whatever the child process's env
already had, unchanged).

**Corrected fix — extract the air-gap into a shared, directly-testable
helper** (Gemini's recommendation, adopted as-is): move the save/clear/
restore logic out of the test file and into a new `tests/helpers/air-gap.mjs`,
exporting one function:
```js
// tests/helpers/air-gap.mjs
export function airGapDbUrl() {
  const priorDbUrl = process.env.AUDIT_DB_URL;
  const priorPostgresUrl = process.env.AUDIT_POSTGRES_URL;
  process.env.AUDIT_DB_URL = '';
  process.env.AUDIT_POSTGRES_URL = '';
  process.on('exit', () => {
    if (priorDbUrl === undefined) delete process.env.AUDIT_DB_URL;
    else process.env.AUDIT_DB_URL = priorDbUrl;
    if (priorPostgresUrl === undefined) delete process.env.AUDIT_POSTGRES_URL;
    else process.env.AUDIT_POSTGRES_URL = priorPostgresUrl;
  });
}
```
`tests/tiered-shadow-compare.test.mjs` replaces its inline block (`:16-23`)
with `import { airGapDbUrl } from './helpers/air-gap.mjs'; airGapDbUrl();`
— same behavior, now reusable. This closes the gap `client.mjs:347`
(`resolveDbUrl`) creates: `AUDIT_DB_URL` wins when set, but an unset/empty
`AUDIT_DB_URL` still falls through to `AUDIT_POSTGRES_URL`. No
`assertDisposableDbUrl` call needed — this test never intends to hit a DB
at all, so the fix is "resolve to nothing", not "resolve to something
disposable."

**Acceptance — tests the extracted helper directly, sidestepping the
whole production-vs-test-file confusion**: a standalone
`tests/fixtures/tiered-shadow-airgap-probe.mjs` fixture script (no
`node:test` import, no `describe`/`it`) that imports `airGapDbUrl` from
the **same shared helper** and calls it, then
`process.stdout.write(JSON.stringify({ auditDbUrl: process.env.AUDIT_DB_URL, auditPostgresUrl: process.env.AUDIT_POSTGRES_URL }))`
— a known, single-line, JSON-only stdout contract. A new
`tests/tiered-shadow-compare-airgap.test.mjs` runs it via
`execFileSync('node', ['tests/fixtures/tiered-shadow-airgap-probe.mjs'], { encoding: 'utf-8', env: { ...process.env, AUDIT_DB_URL: 'postgresql://placeholder/db', AUDIT_POSTGRES_URL: 'postgresql://placeholder-alias/db' } })`,
`JSON.parse`s the captured stdout, and asserts both `auditDbUrl` and
`auditPostgresUrl` are `''` — directly proving the actual reusable air-gap
logic clears both vars regardless of what the ambient environment had,
without any assumption about what importing the production module does.

**H1 (R2) / M4 (R1) — `memory-health.mjs` (`aad83769`).** R1's `{min: 0}`
design was itself buggy — R2 correctly caught it: `min: 0` still accepts
`minFindingsForSignal=0`, which reproduces the EXACT bypass the original
finding reported (`insufficient = total_findings_in_window <
THRESHOLDS.minFindingsForSignal`; since `total_findings_in_window` is
always `>= 0`, a threshold of `0` makes `< 0` permanently false — the
guard never fires, identically to the reported `-1` case). R2 also caught
that `WINDOW_DAYS=0` produces a degenerate empty observation window, and
that count-type variables silently accept fractional values (`numEnv` only
checked finiteness, not integrality). Corrected design — bounds are
per-variable, not a blanket floor, and separates "must be a positive count"
from "must be zero-or-more":
```js
function numEnv(name, fallback, { min = -Infinity, max = Infinity, integer = false } = {}) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  const bad = !Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n));
  if (bad) {
    process.stderr.write(`memory-health: WARNING — ${name}="${raw}" is out of range/type [${min},${max}]${integer ? ' integer' : ''}; using ${fallback}\n`);
    return fallback;
  }
  return n;
}
```
Per-variable bounds:
- `minFindingsForSignal`: `{min: 1, integer: true}` — **must be `>= 1`, not
  `>= 0`**; this is the specific bound R2 caught missing, since a `0`
  threshold structurally cannot ever fire the `<` comparison it gates.
- `WINDOW_DAYS`: `{min: 1, integer: true}` — a `0`-day window is degenerate
  (no observation period), so the correctness floor is `1`, independent of
  what a *sensible* window size might be (that's an operator choice, not a
  validity bound).
- `clusterMedianPairs`: `{min: 0, integer: true}` — a count, but unlike
  `minFindingsForSignal` this one gates with `>=` (density trigger fires
  MORE easily at `0`, not less), so `0` is a valid, non-bypassing value.
- `fuzzyReraiseRate`, `recurrenceRate`, `clusterCosine`,
  `clusterMinCoverage`: `{min: 0, max: 1}` — ratios/similarities, no
  integer constraint.

**Acceptance**: `tests/memory-health.test.mjs` (existing suite — confirmed
on disk, not a new file) gains a regression case per bound: (a)
`MEMORY_HEALTH_MIN_FINDINGS=0` and `=-1` both fall back to the default AND
emit the WARNING line (proving the exact R1/R2 bypass is closed, not just
that *some* validation exists); (b) `MEMORY_HEALTH_WINDOW_DAYS=0` falls
back; (c) a fractional value for an `integer: true` variable (e.g.
`MEMORY_HEALTH_MIN_FINDINGS=2.5`) falls back.

**M3 (R2) / M5 test-half (R1) — `tests/install/receipt.test.mjs`
(`5cf9d863`).** R2 correctly caught that R1's fix (move `fs.rmSync(TMP,
...)` into `t.after()`) was unsafe as stated: read the file — `TMP` is one
directory shared by all 5 `it()` blocks (each `fs.mkdirSync(TMP,
{recursive:true})`s it, writes its own distinctly-named file inside, then
`rmSync`s the WHOLE directory). Registering a **per-test** `t.after()`
against that SAME shared path means the first test to finish deletes the
directory a later test may still be using — safe only by accident of
today's sequential execution, and broken the moment concurrency is enabled
now or in the future (exactly R2's point). Corrected design: give each test
its own uniquely-named subdirectory via `fs.mkdtempSync`, nested under the
existing shared PID-based root (so the PID-collision reasoning below still
covers the outer root, but no two tests ever touch the same leaf
directory):
```js
describe('receipt', () => {
  after(() => fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));

  it('round-trips a valid receipt', (t) => {
    fs.mkdirSync(TMP, { recursive: true });
    const dir = fs.mkdtempSync(path.join(TMP, 'case-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
    const p = path.join(dir, 'receipt.json');
    // ...unchanged body...
  });
  // same pattern for the other 4 it() blocks
});
```
Each test now cleans up only the leaf directory it created — no test can
delete another's fixtures regardless of execution order or concurrency; the
outer `after()` sweeps the (by then empty) shared root once. **Rebutting**
the PID-collision half of GPT's M5/M3: this repo's own Accepted Technical
Debt table (AGENTS.md) already evaluates PID-based tmp naming for
`atomicWriteFileSync` and accepts it — "collision requires same PID + same
millisecond + same directory; probability negligible" — that reasoning
covers the outer root's uniqueness across process runs; `mkdtempSync`
covers uniqueness across tests within one run, which is the part the
original fix was missing.

**R3 correction — the R2 "inject a failure, assert cleanup ran" acceptance
criterion was unexecutable, and R3 named the exact reason**: a failed
`it()` in node:test terminates that test — nothing INSIDE the same process
can make a further assertion "after" it, and a later, unrelated `it()`
does not reliably model the failed one's completion. **Corrected
acceptance**: a **child-process** test — spawn `node --test` against a
tiny fixture file (not the real `receipt.test.mjs`) containing one
`it()` that creates a `mkdtempSync` dir via `t.after()` cleanup exactly
like the real fix, then deliberately throws; the fixture prints the dir
path to stdout before throwing. The parent test lets the child exit
(regardless of its exit code — it's *expected* to report a failure) and
then asserts, from the OUTSIDE, that the printed directory path no longer
exists on disk — proving `t.after()` ran even though the test it was
registered in failed. Plus a test confirming two concurrently-created case
directories (e.g. via `Promise.all` of two `mkdtempSync` calls in the real
suite) never collide.

**M5 (test half) — `tests/sensitive-paths-canonical.test.mjs` (`9fce2220`).**
Replace `if (skipOnWin) return;` at each of the 4 sites (`:70,86,106,123`)
with node:test's `{skip: reason}` option, so the platform decision is
self-documenting in the test-runner output instead of only in a comment:
```js
test('...', { skip: skipOnWin ? 'POSIX-only path semantics' : false }, async () => { ... });
```
Windows CI then reports these SKIPPED with a reason, not PASSING.
**Acceptance**: run the suite's own reporter (or `node --test
--test-reporter=tap` against just this file) on a POSIX runner and a
Windows runner (or simulate via `process.platform` override in a
sub-process), and diff the reported test count breakdown — the 4 cases
must show as `skip` on Windows, not `pass`.

**M2 — `lint/on-conflict.mjs` `SCOPE_COLUMNS` (`9a7c7263`) — not new design,
citing the existing one.** `docs/plans/refactor-static-analysis.md`
already adjudicated this exact ledger entry (§Out of Scope, "Discovering
NEW tenancy/scope columns automatically"): the census found **zero**
unenforced tenancy columns across 71 tables / 467 columns (so nothing is
presently undetected), and names the unblocking condition — "a *semantic*
source rather than name morphology: either a small committed scope-key
manifest where each entry states why the column is a tenancy boundary and
who owns it, or constraint-level semantics." That plan's Phase 5 already
ships the existence check (every `SCOPE_COLUMNS` entry must exist in the
committed schema) — the residual GPT is flagging (auto-*discovering*
un-listed columns) is the deliberately-deferred half, with its own named
trigger. Nothing to add here beyond this citation.

**M3 — `gemini-review.mjs` decomposition (`86b51ca4ba56`) — scope
correction, not a design.** The original 2026-07-26 text already said "not
urgent enough to justify one on its own" — this was **never a committed
action item** in this plan, only a recorded observation for a future
session that touches this file for another reason. GPT's M3 finding
("vague, no module boundaries or migration strategy") is asking this plan
to design a decomposition it never intended to perform. Correcting the
plan's own framing rather than inventing that design: this bullet is
**out of this plan's execution scope**, tracked as a standing observation
only. (`eff197286a47`, `shared.test.mjs`'s import hygiene, gets the same
treatment for the same reason — "not urgent on its own" in the original
text, a recorded observation, not an action item.)

---

- **`gemini-review.mjs`** — `139dc8c30859` (bare `thinkingBudget: 16384`
  literal, no named constant). **Fixed `05858e20` (2026-08-03)** — a
  `GEMINI_THINKING_BUDGET_BY_EFFORT` lookup replaced the literal.
  `86b51ca4ba56` (file has grown to 2157 lines, still mixes
  CLI/provider/shadow-compare/formatting/watchdog in one file — worth a
  decomposition pass if this file gets touched again for another reason,
  not urgent enough to justify one on its own) — **still open**; the file
  has since grown further, to 3082 lines (checked 2026-08-17), still
  undecomposed.
- **`lint/on-conflict.mjs`** — `19659d7a` (`isNullableExpr` misclassifies
  both its own documented `||`/`&&` examples as non-nullable — a genuine
  logic bug in the lint rule itself, worth a quick fix + regression test).
  **Fixed `869f69ca` (2026-07-28)** — replaced by `classifyNullability`, a
  three-valued `nullable|non-null|unknown` lattice; `isNullableExpr`
  survives only as a thin back-compat wrapper. `9a7c7263` (`SCOPE_COLUMNS`
  is a hardcoded set with no fallback diagnostic for an un-listed tenancy
  column) — **still open**; `docs/plans/refactor-static-analysis.md:868`
  records auto-detection of missing entries as a deliberately deferred
  residual, not a forgotten one.
- **`duplicate-justification-pragma.mjs`** — `67f8f414`/`fbd71c9a`: the
  pragma regex has no `^` start anchor, so pragma-looking text inside a
  string/template literal (not a real comment) still matches. One-line
  anchor fix. **Done (2026-07-27)** — `^\s*` (permits leading whitespace/
  indentation, verified against every real pragma in this repo).
- **`linter.mjs`** — `6a74fc5a892d` (external lint tools run with
  `cwd: process.cwd()` against the whole repo, filtered only after the
  fact) and `b99706f9393b` (the documented `AUDIT_LOOP_ALLOW_TOOLS` env gate
  is referenced in comments/docs but never actually implemented — tools run
  by default regardless). **Fix design in §Fix Designs above** —
  `b99706f9393b` is a docstring correction (no code change); `6a74fc5a892d`
  is a real scoping fix (R2-corrected — R1 wrongly called this
  docstring-only) touching `language-profiles.mjs` + `linter.mjs`.
- **`atomic-write-adoption-guard.test.mjs`** — `0e18b00d`/`3f0e3fe7`: the
  guard matches `atomicWriteFileSync` calls by identifier *name* only, no
  lexical-scope/binding resolution, so a shadowing local with the same name
  would satisfy the guard incorrectly. **Fixed `869f69ca` (2026-07-28)** —
  same commit as `19659d7a` above; the guard now resolves real lexical
  bindings via `scripts/lib/import-binding.mjs`'s
  `resolvesToNamedImport`/`resolveNamedImportBinding` instead of
  `Set.has(name)`.
- **`schemas.mjs`** — `1ff42c81c4f7`: `FindingSchema` is a bare alias of
  `PersistedFindingSchema` with no distinguishing name/comment — naming
  clarity only, no behavior risk. **Not actually open**: the distinguishing
  comment ("Backward-compatible alias — existing imports of `FindingSchema`
  use the permissive persisted schema. Enforcement happens at producer
  boundaries via `ProducerFindingSchema`.") already existed in `afbcd022`
  (2026-04-05), 3.5 months before this entry was written 2026-07-26 — the
  original triage read stale/pre-fix source.
- **`tests/install/receipt.test.mjs`** — `5cf9d863` (LOW): shared
  PID-based tmp path across tests, cleanup only runs as the final statement
  after assertions — an assertion failure mid-test skips cleanup. Move
  cleanup into `afterEach`/`t.after()`. **Fix design in §Fix Designs above**
  — cleanup-ordering fix only; PID-collision concern rebutted against this
  repo's own Accepted Technical Debt precedent.
- **`postgres-parity/generate-expected-schema.mjs`** — `8c95c520`: the
  schema-introspection query selects `column_default` but not
  `is_identity`/`identity_generation`, despite the file's own header
  comment claiming identity sequences are captured. **Fix design (exact SQL
  + fixture-regen recipe) in §Fix Designs above.**
- **`tests/sensitive-paths-canonical.test.mjs`** — `9fce2220`: Windows-skip
  logic uses a bare `if (skipOnWin) return;` instead of node:test's real
  `skip()`/`{skip}`, so these report as *passing* on Windows CI rather than
  skipped — silently reduces coverage without saying so. **Fix design in
  §Fix Designs above.**
- **`tests/tiered-shadow-compare.test.mjs`** — `a5f8c94f`: the test only
  clears `AUDIT_DB_URL`, but `client.mjs`'s `resolveDbUrl()` falls back to
  `AUDIT_POSTGRES_URL` when that's empty — so ambient config in the test
  environment could still select a real DB. Given this repo's own
  `assertDisposableDbUrl` incident history (the 2026-07-14 wipe), this is
  worth closing even though it's LOW-labeled — clear both env vars. **Fix
  design (exact diff) in §Fix Designs above.**
- **`memory-health.mjs`** — `aad83769`: `numEnv()` checks `Number.isFinite`
  but not non-negativity, so `MEMORY_HEALTH_MIN_FINDINGS=-1` makes the
  insufficient-data guard always false. **Fix design (bounds per variable)
  in §Fix Designs above.**
- **`tests/shared.test.mjs`** — `eff197286a47`: one large catch-all
  destructured import of ~35 names from `shared.mjs` — a test-hygiene
  observation given `shared.mjs` is documented as a backwards-compat
  barrel already being split; not urgent on its own. **Standing
  observation, not an action item** — same treatment as `86b51ca4ba56`
  above, see §Fix Designs.

---

## Full entry table (status authoritative — 2026-08-17, corrected in R2 per
`/audit-plan` finding M1 — the R1 version of this note miscounted)

Every topicId below carries an explicit status: `OPEN` (8 topicIds across 7
files — 7 topicIds/6 files in this plan's own execution scope, plus
`9a7c7263`/`on-conflict.mjs`, OPEN but owned by a different plan's
execution, see §Fix Designs), `FIXED` (closed by other work, cited commit),
`CORRECTED` (claim was never valid), or `OBSERVATION` (recorded,
deliberately not an action item — see §Fix Designs; 2 topicIds across 2
files). 8 + 2 = the 10 topicIds across 9 files carried in this plan's
Status line and Progress section above.

**`scripts/gemini-review.mjs`**

| topicId | severity | status | evidence |
|---|---|---|---|
| `139dc8c30859` | MEDIUM | FIXED `05858e20` | gemini-review.mjs:484 thinkingBudget bare literal — now a lookup table |
| `86b51ca4ba56` | MEDIUM | OBSERVATION | gemini-review.mjs now 3082 lines, still mixes many concerns — never a committed action item |

**`scripts/lib/lint/on-conflict.mjs`**

| topicId | severity | status | evidence |
|---|---|---|---|
| `19659d7a` | MEDIUM | FIXED `869f69ca` | isNullableExpr replaced by classifyNullability three-valued lattice |
| `9a7c7263` | MEDIUM | OPEN (deferred by a different plan) | SCOPE_COLUMNS auto-discovery — see refactor-static-analysis.md §Out of Scope, cited in §Fix Designs |

**`scripts/lib/duplicate-justification-pragma.mjs`**

| topicId | severity | status | evidence |
|---|---|---|---|
| `67f8f414` | MEDIUM | FIXED (this plan, 2026-07-27) | `^\s*` anchor added to PRAGMA_RE |
| `fbd71c9a` | MEDIUM | FIXED (this plan, 2026-07-27) | same commit, duplicate topicId |

**`scripts/lib/linter.mjs`**

| topicId | severity | status | evidence |
|---|---|---|---|
| `6a74fc5a892d` | HIGH | OPEN — scoping fix designed (R2-corrected) | eslint/ruff/flake8 support path args and will be scoped to audited files; tsc stays project-wide; §Fix Designs |
| `b99706f9393b` | HIGH | OPEN — docstring-only fix designed | AUDIT_LOOP_ALLOW_TOOLS never implemented; §Fix Designs removes the false claim, `--no-tools` is the real gate |

**`tests/atomic-write-adoption-guard.test.mjs`**

| topicId | severity | status | evidence |
|---|---|---|---|
| `0e18b00d` | MEDIUM | FIXED `869f69ca` | guard now resolves real lexical bindings via import-binding.mjs |
| `3f0e3fe7` | MEDIUM | FIXED `869f69ca` | same commit, duplicate topicId |

**`scripts/lib/schemas.mjs`**

| topicId | severity | status | evidence |
|---|---|---|---|
| `1ff42c81c4f7` | MEDIUM | CORRECTED | distinguishing comment predates this plan by 3.5 months (`afbcd022`) — claim was never valid |

**`tests/install/receipt.test.mjs`**

| topicId | severity | status | evidence |
|---|---|---|---|
| `5cf9d863` | LOW | OPEN — fix designed | move `fs.rmSync` into `t.after()`; PID-collision half rebutted, see §Fix Designs |

**`scripts/postgres-parity/generate-expected-schema.mjs`**

| topicId | severity | status | evidence |
|---|---|---|---|
| `8c95c520` | HIGH | OPEN — fix designed | add `is_identity`/`identity_generation` to the tables query; exact SQL in §Fix Designs |

**`tests/sensitive-paths-canonical.test.mjs`**

| topicId | severity | status | evidence |
|---|---|---|---|
| `9fce2220` | LOW | OPEN — fix designed | replace bare `return` with `{skip: reason}` at 4 sites; §Fix Designs |

**`tests/tiered-shadow-compare.test.mjs`**

| topicId | severity | status | evidence |
|---|---|---|---|
| `a5f8c94f` | HIGH | OPEN — fix designed | extend air-gap to clear AUDIT_POSTGRES_URL too; exact diff in §Fix Designs |

**`scripts/memory-health.mjs`**

| topicId | severity | status | evidence |
|---|---|---|---|
| `aad83769` | MEDIUM | OPEN — fix designed | numEnv gains per-variable min/max bounds; §Fix Designs |

**`tests/shared.test.mjs`**

| topicId | severity | status | evidence |
|---|---|---|---|
| `eff197286a47` | LOW | OBSERVATION | catch-all import — never a committed action item, same treatment as `86b51ca4ba56` |

**Executable in-scope manifest** — per-topicId file list, not an aggregate
count (R1's count said 5, R2's said 6, R3 correctly caught R2's own list
already contradicting "6" — a top-level number kept drifting as the design
got more concrete each round; this table is the authoritative form and
carries no summary count to go stale):

| topicId | Files touched |
|---|---|
| `b99706f9393b` | `scripts/lib/linter.mjs` (docstring only) |
| `6a74fc5a892d` | `scripts/lib/linter.mjs`, `scripts/lib/language-profiles.mjs`, `tests/linter.test.mjs` |
| `8c95c520` | `scripts/postgres-parity/generate-expected-schema.mjs`, `scripts/setup-postgres.mjs` (`SHARED_CATALOG_QUERIES`), `tests/fixtures/expected-schema.json` (regenerated), `tests/postgres-parity-identity-columns.test.mjs` (new), `scripts/db-test-container.mjs` (`ISOLATED_SUITE_FILES` enrolment), `.github/workflows/postgres-parity.yml` (matching enrolment) |
| `a5f8c94f` | `tests/helpers/air-gap.mjs` (new — the extracted, directly-testable air-gap), `tests/tiered-shadow-compare.test.mjs` (modify — use the helper), `tests/tiered-shadow-compare-airgap.test.mjs` (new), `tests/fixtures/tiered-shadow-airgap-probe.mjs` (new) |
| `aad83769` | `scripts/memory-health.mjs`, `tests/memory-health.test.mjs` (existing) |
| `5cf9d863` | `tests/install/receipt.test.mjs`, a new tiny fixture file for the child-process cleanup-under-failure regression |
| `9fce2220` | `tests/sensitive-paths-canonical.test.mjs` |

`9a7c7263` is OPEN but owned by a different plan's execution (cited, not
touched here). `86b51ca4ba56` and `eff197286a47` are OBSERVATION — no file
touched.

## `/audit-plan` trail (2026-08-17)

4 GPT rounds, extended one round past the 3-round default cap because
acceptance stayed high (100%, 100%, 100%) and every finding through round 3
was a concrete design/correctness defect — several caught real bugs in the
*previous* round's own fix design (an unfalsifiable test assertion, a
shared-directory test-isolation race, a hand-duplicated SQL query the fix
would have silently left out of sync, a drifting file count). Stopped at
round 4: `H:0` for the first time, acceptance dropped to 67%, and the
findings' character shifted to scope-expansion (asking this plan to
eliminate a pre-existing architectural duplication it doesn't depend on)
and defensive-engineering-for-a-non-occurring-scenario — the rigor-pressure
signal, not a bug in this plan's actual fixes. 1 dismissed (scope), 1
partial-accept (cheap guard, declined the larger ask), 1 fully accepted
(genuine spec gap).

**Gemini final review, round 1: `CONCERNS_REMAINING`, 1 new HIGH finding**
— and a real one, missed by all 4 GPT rounds: the R1-R4 `a5f8c94f` design
assumed the air-gap block lived in (or could be triggered by importing)
the *production* `tiered-shadow-compare.mjs` module; it actually lives in
the *test file* itself. The probe as specified would have imported a
module with no air-gap code and proven nothing. Fixed by extracting the
air-gap into a shared `tests/helpers/air-gap.mjs` (Gemini's own
recommendation, adopted as-is) that both the real test file and the new
probe import — see the corrected `a5f8c94f` fix design above.

**Gemini final review, round 2: `CONCERNS`, 2 new HIGH findings — both
genuine correctness bugs, not rigor pressure, so fixed and one more round
run (the genuine-bug exception to the 2-round cap):**
- `6a74fc5a892d`'s scoping fix would pass **deleted** files (present in a
  diff, absent on disk) as explicit tool args, crashing ESLint/Ruff/Flake8
  instead of the silent tolerance whole-repo `.` invocation has today.
  Fixed: filter to `fs.existsSync` files before substituting into argv,
  via a new injectable `_existsSync` seam mirroring the file's existing
  `_execFileSync` one.
- `8c95c520`'s acceptance criteria only tested the no-false-positive
  direction (identical schemas → no diff) and never proved
  `diffSchemas` actually DETECTS a real identity-column divergence — the
  property the whole fix exists for. Added a third case constructing two
  schemas differing in exactly one column's `is_identity` and asserting
  the difference IS reported.

**Gemini final review, round 3: `CONCERNS_REMAINING`, 1 new MEDIUM
finding** — a sharp, narrow catch: round 2's own deleted-file existence
filter falsified round 3's earlier (correct, at the time) claim that an
empty eligible-files set "cannot occur by construction." A diff of
entirely-deleted files for one language now makes the POST-filter array
empty even though the RAW `auditedFiles` isn't. Fixed: skip invoking the
tool when the filtered set is empty, returning the same `no_tool` envelope
`runTool` already uses for an unavailable tool.

**Stopping here, not running a 4th Gemini round**: severity dropped
HIGH,HIGH → MEDIUM and count dropped 2 → 1 across rounds 2→3 — the
convergence trend the cap rule watches for — and round 2 already used this
plan's one "genuine-bug exception" past the 2-round default. Round 3's
finding was itself a direct, narrow consequence of round 2's own fix
(fixing an edge case a fix introduced, not a new independent defect
surfacing), which is the kind of tail that terminates rather than
compounds. The fix above is applied and is straightforward to verify
against the acceptance criteria already stated for `6a74fc5a892d` — the
next real checkpoint is `/audit-code` against the actual implementation,
which is what this plan was always going to hand off to.

## Rollback

All additive/test-hygiene changes; no schema/data migrations. The
`tiered-shadow-compare.test.mjs` env-clearing fix is the one item here
worth prioritizing given the prior wipe-incident history in this repo.

# Plan: Pinned-Revision Fixture for Spend-Bearing Runs

- **Date**: 2026-08-18
- **Status**: Complete — Phases 1–5 implemented and shipped 2026-08-18; `npm test` 12902 pass / 0 fail and `npm run check` green. Wiring the other consumers (arm-eval, solo-control, model-eval) remains follow-on operational work, not a plan phase — see §7.
- **Author**: Claude + Louis
- **Scope**: backend (tooling / operator surface)
- **Target domain(s)**: `scripts`, `shared-lib`, `tests`
- ⚠ **Cross-domain work** — touches `scripts` (new CLI), `shared-lib` (a
  provider-spec extraction out of `scripts/gemini-review.mjs`) and `tests`.
  The one new boundary crossing is the extraction in Phase 2, which *removes* a
  coupling rather than adding one: today the credential table lives inside a CLI
  entry point, so any second reader would have to import an entry point.

---

## 1. Context Summary

**Detected scope**: backend · **stack**: `js-ts` · no frontend surface.

### The problem, measured

A bake-off campaign snapshot spawns 6 subprocess arms and takes **15–25
minutes**. Each arm records the git commit it ran at. The campaign store enforces
*one snapshot is one revision* and refuses a snapshot whose arms disagree
(`scripts/lib/campaign/promote.mjs:108` @ `606537ee`):

> `arms recorded ${shas.size} different commits (…) — one snapshot is one revision`

**Two snapshots were destroyed this way on 2026-08-17, ~$13 of real provider
spend wasted** (*measured* — operator record, this session):

| # | Cause | Who moved HEAD |
|---|---|---|
| 1 | rebase mid-collection | this session |
| 2 | commit landed mid-collection | a **concurrent** agent session — `e9305550 docs(plans): close tiered-recall-audit-pipeline` |

This repo is routinely worked by several agent sessions in **one shared working
tree** (3 live linked worktrees + the main checkout at the time of writing), so
"be careful not to commit during a collection" is not a control anybody can
enforce. A hand-made detached worktree at `C:/GIT/ces-bakeoff` demonstrably fixed
it and is still registered today — that hand-made setup is what this plan
productises.

**Generality.** The exposure is not bake-off's. It belongs to *any* long-running
run whose evidence is revision-stamped: arm-eval collection, solo-control sweeps
(`scripts/solo-control-audit.mjs`), model-eval harness runs
(`scripts/model-eval-*.mjs`), multi-hour audit replays. The fixture is therefore
designed around **"pin a revision for the duration of a spend-bearing run"**,
with bake-off as its first consumer and the only one wired in this plan.

### The second failure mode — a skip that costs full price

A missing provider credential does **not** error. `resolveShadow`
(`scripts/gemini-review.mjs:1692` @ `606537ee`) returns:

```js
if (!spec.hasCredential(env)) return { provider: spec.canonical, model: null, state: 'skipped-no-key' };
```

The arm records as SKIPPED, and the snapshot is rejected only by the
completeness check — **after the other five arms have been paid for**. This is
the same shape as the revision race: a cheap, knowable precondition converted
into an expensive, late failure. The operator's mitigation on 2026-08-17 was
checking ten environment variables by hand.

### Code Trace

All refs pinned at **`606537ee`** (per verification-discipline: a line number is
only meaningful with the commit it was read at).

| Ref | What it establishes |
|---|---|
| `scripts/lib/campaign/promote.mjs:105,108` | The refusal this fixture exists to prevent. `105` is the *no* `audited_sha` case, `108` the disagreement case. |
| `scripts/lib/bakeoff/arms.mjs:41` `transportForModel` | model → `{route, shadowToken, …}`. The first half of "which credential does this arm need". |
| `scripts/gemini-review.mjs:1617` `SHADOW_PROVIDER_SPECS` | Per-provider `hasCredential(env)`. The second half — and **the single oracle** the preflight must reuse rather than re-spell. Currently a module-level `const`, exported only through `_internals`. |
| `scripts/gemini-review.mjs:1692` | `skipped-no-key` — the silent skip. |
| `scripts/lib/store/campaign.mjs:356` `requireCampaignHmacKey` | Hard refusal on an absent `CAMPAIGN_HMAC_KEY_*`; `hmacKeyRefFor` (`:342`) derives the var name. |
| `scripts/prepush-check.mjs:159–237` `provisionNodeModules` | **Precedent (see §Neighbourhood).** Already solves link-vs-install for a sandbox worktree, including the `'junction'` call at `:222` and its cross-platform note. |
| `scripts/lib/node-modules-resolver.mjs:43` `findNodeModules` | Resolves `node_modules` the way *Node* does, not as `<repoRoot>/node_modules`. Directly reusable. |
| `scripts/lib/dependency-identity.mjs:124` `dependencySetChanged` | Fails **closed**; decides link vs install. Directly reusable. |
| `scripts/lib/shared-cloud-config.mjs:203` `discoverLocalEnvPath` | The env resolver fixed by `606537ee`. Its `main-worktree` branch is what makes an *outside* fixture viable — see §2 Decision 1. |
| `scripts/lib/bakeoff/log.mjs:15` `LOG_PATH = '.audit/bakeoff-log.jsonl'` | Repo-relative ⇒ the fixture writes its **own** log. The root of the misleading-progress trap (§2 Decision 5). |
| `.githooks/post-checkout` | Fires on `git worktree add`, prints "Claude configured for &lt;name&gt;", writes `.claude/settings.local.json`. The cross-agent coupling to neutralise. |
| `scripts/lib/cli-io.mjs:260` `assertKnownFlags` | The `cli:flags:gate` contract the new CLI must satisfy. |
| `scripts/bakeoff-collect.mjs:404` | The `--selfcheck-relocation` smoke-contract shape to copy. |

### Neighbourhood considered

`get-neighbourhood` (2026-08-18, `refreshId 75d6c5a9`) returned **one
`precedent` / `above-floor-cluster`** hit and seven `review`:

- **`provisionNodeModules` — `scripts/prepush-check.mjs:159` — score 0.454,
  `above-floor-cluster`.** Opened and read. It answers exactly the
  `node_modules`-in-a-worktree question, and its two load-bearing pieces are
  *already* extracted libraries (`findNodeModules`, `dependencySetChanged`).
  **Disposition: reuse the libraries, write a sibling orchestrator.** Not reuse
  the function itself — it is bound to prepush's `sandbox`/`gitEnv`/`log`
  parameters and to `npm ci --ignore-scripts` (chosen there because the
  `prepare` lifecycle would repoint the *real* repo's hooks). The fixture needs
  a different install policy and a different failure contract. Extracting a
  common orchestrator would mean editing the pre-push path to serve a
  not-yet-existent second caller — the over-engineering cliff. The *duplication
  that would matter* (the junction call, the resolution walk, the dependency
  comparison) is exactly what gets reused.
- `cleanupTempRoot` (`scripts/lib/audit/diff-scope-resolver.mjs:404`) — `review`.
  Read: `git worktree remove` with a filesystem fallback. Informs §2 Decision 4
  but is throwaway-scoped (no `node_modules` link to unlink first), so it cannot
  be reused as-is.
- `resolveMainWorktree` (`scripts/skills-hydrate.mjs:73`) — `review`. Same
  `git rev-parse` shape the fixture needs; too small to share.

### Past incidents to verify against

- **The stray-parent-`.env` shadow** (2026-08-17). `discoverLocalEnvPath` used to
  walk up unbounded first, so `C:\tmp\.env` — which declares only
  `OPENAI_API_KEY` and `OPENAI_SESSION_TOKEN` — shadowed the repo's. Fixed in
  `606537ee`; **re-verified this session** (§2 Decision 1). The stray file is
  still on disk, which makes it a live negative control.
- **Orphaned worktree directories.** 11 directories exist under
  `.claude/worktrees/` against 3 registered worktrees. The residue is a dangling
  `node_modules` junction and nothing else — reproduced and root-caused in §2
  Decision 4.

---

## 2. Proposed Architecture

One CLI, `scripts/pinned-worktree.mjs`, with `create` / `verify` / `remove`, over
a pure library at `scripts/lib/pinned-worktree/`. It creates a **detached**
worktree at an explicit commit, links `node_modules`, and **refuses to hand it
over** unless every credential the declared arms need is present.

```
create  ──▶ resolve rev ──▶ worktree add --detach ──▶ link node_modules ──▶ preflight ──▶ ready
                (pin)          (hooks suppressed)        (reuse)          (refuse on miss)
verify  ──▶ re-assert all four properties against a fixture that already exists
remove  ──▶ unlink link ──▶ worktree remove ──▶ prune ──▶ reconcile disk residue
```

### Key design decisions

#### Decision 1 — the fixture lives **OUTSIDE** the repo. *(the open question)*

**Default root: `<parent-of-main-checkout>/<repo-name>-pinned/<fixture-name>`** —
e.g. `C:/GIT/claude-engineering-skills-pinned/bakeoff-2026q3`, a sibling of the
main checkout, matching the shape of the hand-made `C:/GIT/ces-bakeoff` that
already works. Overridable with `--root`.

This was decided on measurement, not preference. Both candidate sites were
tested this session:

**The stated argument *for* inside — "`.env` discovery resolves correctly for
free" — is empirically void.** A worktree is its own `repoRoot` whether it sits
inside or outside the repo, so `chainWithinRepo` terminates at the worktree in
*both* cases and both fall through to the identical `main-worktree` branch at
`scripts/lib/shared-cloud-config.mjs:210`. Measured from
`C:/tmp/pwt-probe` (an outside worktree, pinned at `606537ee`, with the stray
`C:\tmp\.env` still present as a negative control):

```
NOTICE reason=main-worktree path=C:\GIT\claude-engineering-skills\.env
unset from OUTSIDE worktree: (none — all resolved)
```

All ten credentials resolved. Inside buys nothing here.

> **The instrument lied once, and the correction is the point.** The first run of
> this probe reported four credentials unset and `.env` resolving to the stray
> `C:\tmp\.env` — apparently a live bug in `606537ee`. It was not: the probe
> worktree was pinned at `e9305550`, *before* the fix, so the probe had imported
> the **old** resolver. A pinned worktree runs pinned tooling — which is the
> fixture's entire purpose and also its sharpest edge. Re-run at `606537ee`, the
> resolver was correct. This is logged because the same trap will catch the next
> person who debugs tooling *inside* a fixture pinned to an older revision.

**The argument against inside is measured and non-trivial.** `.claude/worktrees/`
is the *harness's own* worktree namespace: Claude Code creates and removes
worktrees there, and this fixture must survive untouched for 15–25 minutes while
other sessions operate. It is also where the orphan residue accumulates today
(11 directories, 3 registered). Putting a spend-bearing fixture in a namespace
another tool manages is an avoidable coupling — and a `.claude/`-shaped path is
the wrong home for a fixture whose stated goal is to serve Codex, Copilot, Cursor
and Windsurf equally.

**The repo-scanning risk that motivated the question does not favour inside
either — it is already absent, and for a reason that generalises.** Verified from
the main checkout *with 11 directories present under `.claude/worktrees/`*:

| Gate | Result | Why |
|---|---|---|
| `docs:check`, `docs:refs:gate`, `cli:flags:gate`, `npm-args:gate`, `emit:exit:gate`, `worktree:preflight:gate`, `db:enrolment:gate` | **all PASS** | — |
| `knip:gate` | **PASS** | knip honours `.gitignore` |
| `tests/arm-vocabulary-layering.test.mjs` (the layering oracle) | **6/6 pass** | — |

Every enumeration path is either `git ls-files --cached --others
--exclude-standard` (gitignore-respecting — `.gitignore` ignores
`.claude/worktrees/`) or scoped to a named subtree (`scripts/`, `tests/`,
`docs/`). So *inside* is survivable today. But it survives **because of a
gitignore entry**, whereas *outside* is immune by construction — it is not in the
repo, so no repo-walking tool can reach it however it enumerates. Given a choice
between "safe because every current walker respects one ignore rule" and "safe
because it is not there", the second is the smaller claim to have to keep true.

**What would change this decision:**
1. If `discoverLocalEnvPath`'s `main-worktree` branch were removed or regressed,
   outside would lose credential resolution and inside would become the cheaper
   fix. **Phase 4 pins that branch with a test that fails if it is removed** —
   so the decision carries its own tripwire rather than relying on nobody
   touching it.
2. If a future consumer had to run the fixture on a filesystem where only the
   repo path is writable (a locked-down CI image), `--root` already covers it —
   pointing `--root` at `.claude/worktrees/` remains supported and is *not*
   blocked, because the evidence above says it works.
3. If the harness ever stopped managing `.claude/worktrees/`, the namespace
   objection would lapse — but the immunity argument would still stand.

#### Decision 2 — detached at an **explicit commit**, never a branch

`git worktree add --detach <path> <sha>`. Being a worktree is not what fixes the
problem; being **detached at a pinned sha** is. A worktree checked out on a
branch follows that branch, which reintroduces the concurrent-session race
through a different door. `create` resolves the user's `--rev` (a sha, tag, or
`HEAD`) to a **full 40-char sha once**, records it, and every later `verify`
compares against that recorded value — so "did anything move?" is answered
against the pin, not against whatever `HEAD` means now.

`verify` asserts three separate things, because they fail independently:
`git symbolic-ref -q HEAD` must fail (detached), `rev-parse HEAD` must equal the
pin, and the tree must be clean.

#### Decision 3 — `node_modules` by junction, falling back to `npm ci`

Reuses `findNodeModules` and `dependencySetChanged` (§Neighbourhood). Verified
this session on win32:

```
fs.symlinkSync(target, link, 'junction')  →  isSymbolicLink()=true
require through junction                  →  42
bare-specifier resolution from wt cwd     →  42
```

`'junction'` is Windows-only and needs no elevation; other platforms ignore the
type and create a directory symlink — the behaviour `prepush-check.mjs:220–222`
already documents and relies on. **Windows requires an absolute target**, so the
implementation resolves before linking. POSIX behaviour is asserted by Phase 4's
test rather than assumed, since this session could only measure win32.

When `dependencySetChanged` says the dependency set differs between the pinned
revision and the checkout that owns the modules, linking would test the pinned
code against the wrong dependency tree — so the fixture installs instead
(`npm ci --ignore-scripts`, same reasoning as prepush: the `prepare` lifecycle
writes `core.hooksPath`, which is shared with the main checkout).

#### Decision 4 — `remove` unlinks **before** it removes, and reconciles

Reproduced this session, and it is the mechanism behind all 11 orphaned
directories:

```
fs.rmSync('…/wt', {recursive:true, force:true})
  → Error: EBUSY: resource busy or locked, rmdir
  → target intact (the junction was NOT followed — good)
  → the junction and its parent directory both SURVIVE  (← the orphan)
```

and worse, from `git` itself:

```
$ git worktree remove --force C:/tmp/pwt-probe
error: failed to delete 'C:/tmp/pwt-probe': Permission denied
$ git worktree remove --force C:/tmp/pwt-probe
fatal: 'C:/tmp/pwt-probe' is not a working tree     ← deregistered anyway
$ test -e C:/tmp/pwt-probe  →  STILL PRESENT        ← directory orphaned
```

**`git worktree remove` deregisters even when it fails.** So `remove` must be
written for a world where registry and disk disagree:

1. `lstat` the link. Unlink **only if `isSymbolicLink()`** — never recurse into
   it, never `rm -rf` a path that might be a real `node_modules`.
2. `git worktree remove`, tolerating failure.
3. `git worktree prune`.
4. Reconcile: if the directory still exists, `fs.rmSync` it and say so.
5. Idempotent — removing an already-removed fixture is a success, not an error.

The good news the probe also establishes: `fs.rmSync(recursive)` does **not**
follow the junction, so the main checkout's `node_modules` is never at risk. The
implementation still unlinks explicitly rather than relying on that.

#### Decision 5 — the credential preflight refuses, from **inside** the fixture

Derivation chain, all through existing single oracles:

```
campaign config ──▶ arms[].model ──▶ transportForModel() ──▶ shadowToken
                                          (arms.mjs:41)
                    ──▶ SHADOW_PROVIDER_SPECS[token].hasCredential(env)  ──▶ present?
                                     (extracted in Phase 2)
        plus  hmacKeyRefFor(campaignId)   (store/campaign.mjs:342)
        plus  AUDIT_DB_URL, OPENAI_API_KEY
```

**Re-spelling the env-var names in the fixture is the one thing that must not
happen.** A second list would be a prose↔code contract with no compiler — the
class AGENTS.md documents repeatedly — and its failure mode is precisely the
bug being fixed: the preflight passes, the arm skips, the snapshot dies after
spend. Hence Phase 2 extracts `SHADOW_PROVIDER_SPECS` to
`scripts/lib/final-review/provider-specs.mjs` and `gemini-review.mjs` imports it.
The table itself is unchanged; `_internals.SHADOW_PROVIDER_SPECS` keeps
re-exporting it so existing tests are untouched.

**The preflight runs with `cwd` set to the fixture**, not the main checkout.
Verifying the env the *main checkout* sees would verify a different environment
than the run uses — "verify what the consumer receives, not what the producer
sent". It is the fixture's `.env` resolution that decides whether an arm skips.

`hasCredential` returns a boolean and the value never leaves it; the preflight
reports **variable names only**, never values, matching `azure:routes`.

#### Decision 6 — the Claude-specific `post-checkout` hook is suppressed per-invocation

Reproduced: `git worktree add --detach` prints `✅ Claude configured for
pwt-probe` and writes `.claude/settings.local.json` with `additionalDirectories:
["docs"]` and `enableAllProjectMcpServers: true`. A Codex or Copilot user must
not inherit that.

Verified fix — suppress hooks for **that one git invocation**:

```
git -c core.hooksPath=<empty dir> worktree add --detach <path> <sha>
   →  settings.local.json ABSENT — hook suppressed
```

Chosen over the alternatives deliberately: editing `.githooks/post-checkout` to
detect worktrees changes behaviour for every existing consumer of the hook to
serve one new caller, and `--no-checkout` does not help (the hook fires on the
subsequent checkout anyway). `-c` is scoped to the single command, leaves repo
config untouched, and needs no coordination with the hook's owner. The empty
directory is created under the OS temp dir and removed after.

#### Decision 7 — the local bake-off log is **not** the progress oracle

`LOG_PATH` is the repo-relative `.audit/bakeoff-log.jsonl`
(`scripts/lib/bakeoff/log.mjs:15`), and `.audit/` is gitignored — therefore
**absent from every worktree**. A fixture writes its own empty log, so
`bakeoff-collect.mjs --progress` run there reads *near-zero* regardless of how
many snapshots the campaign actually has.

This reads exactly like lost progress and will be misread as such. The mitigation
is documentation plus a machine-emitted warning: `verify` prints the fixture's
local log entry count **beside** the store-derived count, labelled, so the two
can never be confused. The store is the trustworthy count.

Gitignored inputs absent from the fixture, and their handling:

| Input | Handling |
|---|---|
| `.env` | resolved from the main checkout (Decision 1) — nothing to do |
| `.audit/**` transcripts | **must be passed by absolute path** from the main checkout; `create` prints the absolute prefix to use |
| `.audit/bakeoff-log.jsonl` | fixture-local; see above |
| `scripts/.claude-skills/**` | absent; `npm run skills:hydrate` is the existing remedy and `verify` points at it |

### Right-sizing gate

- **The band-aid**: document "make a worktree before collecting" in the campaigns
  runbook. Rejected — it re-creates by hand, every time, the five preconditions
  (detach, pin, link, hook-suppress, credential-check) whose omission is what
  cost $13; and it cannot refuse.
- **The over-built version**: a general "job runner" with a lifecycle daemon,
  lockfiles, and a scheduler that owns collection. Rejected — nothing in the
  current requirement needs a process supervisor. The measured failures are
  *setup* failures, all knowable before the first token is spent.
- **Why this is the smallest honest thing**: it automates exactly the five
  preconditions, refuses on the one that silently costs money, and adds no
  policy the operator did not already have. It composes three existing libraries
  rather than re-implementing them, and its one extraction exists to keep the
  credential answer single-sourced.

---

## 3. File-Level Plan

### `scripts/lib/final-review/provider-specs.mjs` (create)
`SHADOW_PROVIDER_SPECS` and `shadowModelMatchesFamily`, moved verbatim from
`scripts/gemini-review.mjs:1617`. No behaviour change.

### `scripts/gemini-review.mjs` (modify)
Import the two symbols instead of defining them; keep both in `_internals` so
existing tests are untouched.

### `scripts/lib/pinned-worktree/paths.mjs` (create)
`defaultFixtureRoot(mainRoot)`, `fixturePath(root, name)`, `resolveMainRoot()`.
Name validation: `^[a-z0-9][a-z0-9-]{0,63}$` (mirrors `CAMPAIGN_ID_PATTERN`), so
a name can never escape the root via `..`.

### `scripts/lib/pinned-worktree/preflight.mjs` (create)
Pure. `requiredCredentials({campaignConfig})` → `[{name, source, present}]` via
the Decision-5 chain. `checkCredentials(required, env)` → `{ok, missing}`. Env is
a parameter, never read from `process.env` inside — that is what makes the
refusal testable in both directions.

### `scripts/lib/pinned-worktree/manage.mjs` (create)
`createFixture`, `verifyFixture`, `removeFixture`. Owns the git invocations, the
hook suppression, the link/install decision (composing `findNodeModules` +
`dependencySetChanged`), and the Decision-4 removal sequence. Injectable
`{git, fs}` seams for tests.

### `scripts/pinned-worktree.mjs` (create)
argv + dispatch only. `--selfcheck-relocation` first in `main()`;
`assertKnownFlags`. Flags: `--name --rev --campaign --root --install --force
--json --selfcheck-relocation --help -h`.

### `package.json` (modify)
```
"fixture:create": "node scripts/pinned-worktree.mjs create",
"fixture:verify": "node scripts/pinned-worktree.mjs verify",
"fixture:remove": "node scripts/pinned-worktree.mjs remove"
```

### `tests/pinned-worktree.test.mjs` (create) · `tests/pinned-worktree-preflight.test.mjs` (create)
See §5.

### `AGENTS.md` (modify)
A short stub + pointer, per this file's own size rule. Placed next to the
existing pre-push/worktree material.

### `docs/runbooks/pinned-revision-fixture.md` (create)
The cross-agent operator guide (Claude Code, Codex CLI, Copilot, Cursor,
Windsurf). Real values, never `<angle-brackets>` — PowerShell reserves `<`.

### `docs/runbooks/model-campaigns.md` (modify)
§2 Collect points at the fixture; adds the "trust the store, not the local log"
warning (Decision 7) and the absolute-transcript-path requirement.

### Implementation Phases

**Phase 1 — paths + CLI skeleton.** `paths.mjs`, `scripts/pinned-worktree.mjs`
with dispatch, `--selfcheck-relocation`, `assertKnownFlags`, package.json
scripts. No git side effects yet.
Files: `scripts/lib/pinned-worktree/paths.mjs` (create),
`scripts/pinned-worktree.mjs` (create), `package.json` (modify).

**Phase 2 — provider-spec extraction + preflight.** The verbatim move, then
`preflight.mjs`. **Precedes Phase 3**: `create` must not exist in a form that
can hand over an unchecked fixture, because that is the shape that costs money.
Files: `scripts/lib/final-review/provider-specs.mjs` (create),
`scripts/gemini-review.mjs` (modify),
`scripts/lib/pinned-worktree/preflight.mjs` (create).

**Phase 3 — create / verify / remove.** `manage.mjs`: detached-at-sha creation
with hook suppression, link-or-install, the four-property verify, the
unlink-then-remove-then-prune-then-reconcile sequence.
Files: `scripts/lib/pinned-worktree/manage.mjs` (create),
`scripts/pinned-worktree.mjs` (modify).

**Phase 4 — tests.** Red-then-green, one defect at a time (§5).
Files: `tests/pinned-worktree.test.mjs` (create),
`tests/pinned-worktree-preflight.test.mjs` (create).

**Phase 5 — docs.** AGENTS.md stub, the runbook, and the campaigns-runbook
rewiring.
Files: `AGENTS.md` (modify), `docs/runbooks/pinned-revision-fixture.md` (create),
`docs/runbooks/model-campaigns.md` (modify).

---

## 4. Testing Strategy

**Red-then-green, and the negative control comes first.** Per this repo's
verification discipline, a check is not trustworthy until it has been seen to
fail, and a before/after observation of a pre-existing defect is not a negative
control.

### The load-bearing test — the preflight must REFUSE

Both directions, because a gate that only ever passes is indistinguishable from
a gate that is inert (`feedback_test_the_direction_the_gate_must_not_fire`, and
`feedback_validator_inert_by_arguments`: three validators in one session were
inert *because of their arguments* while the call site looked correct):

1. **Fires** — a campaign declaring a `qwen` arm with `ALIBABA_CLOUD_API_KEY`
   absent from the injected env ⇒ `ok:false`, `missing` names the variable, and
   `create` exits non-zero. Asserted per-arm for every provider family in
   `SHADOW_PROVIDER_SPECS`, derived by iterating the table so a newly added
   provider is covered without editing the test.
2. **Does not fire** — the same campaign with a fully-populated env ⇒ `ok:true`.
3. **Not vacuous** — a campaign with **zero** arms must not report `ok:true` by
   checking nothing; `requiredCredentials` returning an empty list is itself a
   refusal.
4. **`ALIBABA_CLOUD_BASE_URL` alone missing** still refuses — that spec's
   `hasCredential` is an `&&` of two variables, and a preflight that only
   checked `*_API_KEY` would pass while the arm skips. This is the concrete
   re-spelling bug Decision 5 exists to prevent.

Env is injected, never ambient — otherwise the suite passes or fails by whose
machine runs it (the trap `tests/helpers/provider-env.mjs` `withScrubbedProviderEnv`
already exists for).

### Fixture-mechanics tests (real git, temp repo)

Built on a throwaway repo under the OS temp dir with two commits, so the pin is
verifiably *not* `HEAD`:

- **Detached at the pinned sha** — after `create --rev <first-commit>`:
  `symbolic-ref HEAD` fails, `rev-parse HEAD` equals the *first* commit while the
  origin's `HEAD` is the second. Negative control: creating without `--detach`
  leaves `symbolic-ref` succeeding, so the assertion is shown to discriminate.
- **`node_modules` resolution** — a fake package resolves through the link from
  the fixture cwd (the probe run this session, promoted to a test per
  "promote a one-off check that mattered"). Asserted by *resolving a module*,
  not by `existsSync` on the link.
- **Cross-platform link creation** — `isSymbolicLink()` true and `readlink`
  points at the resolved absolute target. Runs on both win32 and POSIX; only
  win32 was measurable this session, which is why the assertion is on
  `lstat`/`readlink` semantics that hold on both rather than on "junction".
- **Removal is idempotent and reconciles** — `remove` twice succeeds; a fixture
  whose `git worktree remove` fails still ends with the directory gone and the
  registry pruned. Negative control: a **real** (non-symlink) `node_modules`
  directory inside the fixture is *not* unlinked-through — the target survives.
- **Hook suppression** — `.claude/settings.local.json` is absent after `create`.
  Negative control: the same temp repo with the hook wired and *without*
  suppression must produce the file, proving the assertion can fail.

### Regression tripwire for Decision 1

A test asserting `discoverLocalEnvPath` resolves the **main** checkout's `.env`
from a linked worktree with a competing stray `.env` in an ancestor directory —
the exact `606537ee` behaviour the outside-fixture decision rests on. If that
branch is ever removed, this fails and the decision is revisited rather than
silently invalidated.

`tests/local-env-discovery.test.mjs` already has a `makeFixture` helper for
git-repo-plus-worktree-plus-`.env` layouts; reuse it rather than writing a
second.

---

## 5. Execution Clustering

- **Cluster A** — Phases 1–2 — fix-gate: yes
  - Coupling: Phase 1's CLI is the only caller of Phase 2's preflight, and Phase
    2's extraction is a prerequisite for the preflight having a single oracle to
    read. The gate is load-bearing because everything after assumes the
    credential answer is single-sourced — if the extraction is wrong, every
    later test is asserting against a second spelling.
  - author-tier: standard
- **Cluster B** — Phases 3–4 — fix-gate: yes
  - Coupling: `manage.mjs` and its tests are one unit. The removal sequence in
    particular cannot be reviewed apart from the negative control proving it
    does not delete through a link — the failure mode is destroying the main
    checkout's `node_modules`, so shipping the code ahead of that test is
    exactly the risk not worth taking. Phase 4 also carries the Decision-1
    tripwire, which gates whether the plan's central decision still holds.
  - author-tier: standard
- **Cluster C** — Phase 5 — fix-gate: final
  - Coupling: the docs describe surfaces A and B create; writing them earlier
    documents an unshipped shape. `model-campaigns.md` must not point operators
    at commands that do not exist yet.
- **Final gate**: consolidated Gemini review over the union diff of A–C.

---

## 6. Risk & Trade-off Register

| Risk | Severity | Mitigation |
|---|---|---|
| `remove` deletes through the link, destroying the main `node_modules` | **High** | `lstat`+`isSymbolicLink()` guard; explicit unlink before any recursive delete; negative-control test with a real directory. Probe shows `fs.rmSync` does not follow junctions, but the guard does not rely on that. |
| Preflight passes while an arm still skips | **High** | Single oracle via extraction (Decision 5) rather than a re-spelled list; the `ALIBABA_CLOUD_BASE_URL` two-variable case is tested by name. |
| Operator reads fixture-local log as lost progress | Medium | Decision 7: labelled dual count in `verify`, plus the runbook warning. |
| Fixture pinned to an old revision runs old tooling | Medium | Documented in the runbook with this session's own instrument failure as the worked example. `verify` prints the pinned sha and how far behind `main` it is. |
| Disk cost — a full checkout per fixture | Low | Accepted; `node_modules` is linked, not copied, and `remove` reconciles. The 11 orphaned directories are evidence the *absence* of a remove path costs more. |
| `-c core.hooksPath` suppresses *all* hooks for that invocation | Low | Scoped to one `worktree add`. Accepted: no other hook is expected on that path, and the alternative edits a hook shared with every consumer. |

### Deliberately deferred

- **Wiring the other consumers** (arm-eval, solo-control, model-eval). The
  fixture is designed generally and takes `--campaign` only for the credential
  derivation; pointing those runners at it is follow-on operational work with no
  shared code to write. Deferred as a **true scope boundary**: their collection
  paths are independent of the bake-off path being wired here, so nothing
  shipped in this plan rides on them.
- **Cleaning up the 11 orphaned `.claude/worktrees/` directories.** Repo hygiene
  belongs to a separate, explicitly-requested task; they are another session's
  working set.
- **A lock preventing two concurrent fixtures at different revisions.** No
  current requirement — one operator, one campaign at a time. Revisit if a
  second consumer collects concurrently.

---

## 7. Implementation Log (2026-08-18)

Shipped as specified. Four things the plan did not anticipate, all found by
building it:

1. **A CRLF trap that would have hit every consumer repo.** The link-vs-install
   comparison read the two `package-lock.json` files as raw bytes. Git for
   Windows sets `core.autocrlf=true` at the **system** level — present even when
   user and global config are both empty, which is why it went unnoticed — so a
   fresh worktree checkout gets CRLF while the main working tree holds LF. The
   same committed lockfile measured **59 bytes against 63**, the compare said
   "differs", and every `create` would have paid a full `npm ci`. This repo's
   `.gitattributes eol=lf` masks it here; a consumer without one is bitten every
   time. Fixed with `canonicalizeEol` (`lib/file-io.mjs`) — the sanctioned use,
   since a line ending is not dependency-relevant. Found by the test suite, not
   by review, and pinned by a test that forces CRLF rather than relying on the
   ambient git config.

2. **`hmacKeyRefFor` had to MOVE, not be imported.** The preflight needed it, but
   `shared-lib -> stores` is not an allowed edge. The layering oracle's
   preference order is refactor > retag > declare, and refactor was genuinely
   right: the function derives an env-var *name* from a campaign id, which is
   campaign identity rather than persistence. Moved to `lib/campaign/config.mjs`
   and re-exported from `lib/store/campaign.mjs`, so every existing caller is
   unchanged. Re-spelling it in the preflight — the tempting shortcut — would
   have been a second source of truth for a name the store writes into a table.

3. **Four registration gates fired, and all four were right.** A new
   `scripts/lib/` subsystem needs an explicit `domain-map.json` rule (not the
   catch-all), new npm scripts need `.cli-catalog.json` entries, and **every**
   `fs.rmSync` must carry `{maxRetries, retryDelay}` per
   `tests/rmsync-retry-guard.test.mjs`. That last one is the repo having already
   solved, generically, the EBUSY problem this plan measured specifically.

4. **AGENTS.md had 146 characters of headroom.** Adding the stub required
   condensing first, per the file's own rule ("condense a dossier section rather
   than raising the cap"). Four passages were condensed with no loss of
   invariant: the shadow-envelope-scope mechanics (already in
   `environment-variables.md`), a duplicate pointer to
   `final-review-shadow-reviewer.md` in the same section, the tiered-recall
   closing pointer that re-enumerated its own intro, and two historical asides.
   It now sits at **91,952/92,000 — 48 characters spare**, so the file is
   effectively full: a genuine condensation pass (one dossier section →
   `docs/<topic>.md`) is owed before the next invariant lands.

### Verification performed

- Red-then-green on the load-bearing gate: two independent sabotages (an inert
  `checkCredentials`, and a single-probe `credentialVarsFor`) each failed
  exactly the tests that should have caught them; restored green.
- The Decision-1 tripwire was sabotaged at its subject — removing
  `discoverLocalEnvPath`'s `main-worktree` branch — and failed with the message
  that names the decision. Restored byte-identical.
- End-to-end against the live repo and the real `final-review-scoped-2026q3`
  manifest: `create` resolved **10** credential requirements (matching the ten
  variables the operator had been checking by hand), linked `node_modules`,
  suppressed the `post-checkout` hook, and `verify` reported all six checks ok.
  `remove` was run twice; the main checkout's `node_modules` survived both.

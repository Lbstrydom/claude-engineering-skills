---
summary: The optional .fleet.json - base branch, merge method, test tiers, collision checks, hotFiles, archiveIgnore.
---

# Config — optional `.fleet.json` at the repo root

Never synced; read from the checkout you run in, so commit it — an untracked copy
in one worktree changes behaviour there only. Every key optional. `baseBranch` (a
branch name — `origin/main` is refused; default origin/HEAD, else main),
`mergeMethod` (`pr` default, `direct-squash`, `direct-merge`; fixed into the
train when built), `testCommand` (a string, or ordered tiers; `post-merge` tiers
never run in `land` and are listed as deferred), and `checks` (repo-owned
collision scripts; `land` runs them inside the combined train tree; a failing
`block` check makes a train non-approvable, and one listed with
`"runIn": [..., "ready"]` (opt-in) refuses `ready` too; a timed-out hook's
process tree is terminated, except a descendant that deliberately escapes it).
A monorepo with a long chain:

```json
{ "mergeMethod": "pr",
  "testCommand": { "tiers": [
    { "name": "fast", "command": ["npm", "run", "test:unit"], "stage": "pre-land" },
    { "name": "full", "command": ["npm", "test"], "stage": "pre-land", "timeoutMs": 3600000 },
    { "name": "packaged", "command": ["npm", "run", "test:packaged"], "stage": "post-merge" } ] },
  "checks": [ { "name": "semantic-collisions", "script": "scripts/<your-check>.mjs",
                "runIn": ["status", "land"], "severity": "block" } ] }
```

`hotFiles` (claim-grammar patterns, e.g. `["**/tech-debt.json"]`) are files nearly
every branch touches: an overlap made ONLY of them is listed apart (`[hot]`) and
never blocks; mixed evidence still blocks. A tier or check may carry a one-line
`"note"` (≤300 chars), printed and recorded in the manifest. Landing keys —
`requiredChecks`, `appendOnlyGlobs`, `restackIgnore`, `serialTimeoutMs` — are in
`references/landing.md`; `ghAccount` (a gh login name; the PR reads of `status`, `prune`, `next`'s caches and the handover use that account's credential via `gh auth token --user`, never a token. NOT `land`, `ship-batch` or the train, whose gh mutations run as the signed-in account, so they read PRs as it too; `ci-merge` takes its own `--gh-account`), `archiveIgnore` (default `node_modules/**`, `scripts/.claude-skills/**`, `.claude/settings.local.json`: gitignored paths that `archive-check` and `prune` treat as disposable) is used by the verbs in `references/ending-a-session.md`.

`fullSuite` (`"session"` default, or `"train"`): with `"train"`, sessions run the targeted and affected-file tests plus the
required gates and never take the heavy slot for a full suite; `next` and `ready` say so and give the test-log words
(`full suite deferred to the train (fullSuite: train)`), and `fleet land` is the one full-suite run. Under `"train"`
`land` is the only place a combination is tested in full, so run the fast-tier probe (`references/landing.md`) early.

`gitTimeoutMs` (1000-600000; default `60000`), overridden per machine by `FLEET_GIT_TIMEOUT_MS`: the timeout of the train's own git calls (worktree add, merge, commit, reset, clean). An invalid env value is an error, never the default. A transient `worktree add` failure (timeout, lock) is undone and retried, at most 3 attempts.

**Why a tier is red** comes from ONE line the tier's runner prints on a failing run (`run-tests.mjs` prints it; any runner may):
`test-outcome/v1 {"testsFailed": <n|null>, "guards": [{"id": "<slug>", "kind": "policy|timeout|instrument"}]}`. `testsFailed > 0` is a
test failure (rerun); zero with only `policy` guards is **guard-only** (deterministic: no rerun, the next tier still runs, and a human may
accept it, `references/landing.md`); any `timeout` guard is not rerun; `instrument` reruns. No line, a malformed one or two in one attempt
is `unclassified`: rerun once, never acceptable. A tier may declare `"rerunFailedCommand": ["npm", "test", "--", "{files}"]` (exactly one
`{files}`): a test failure whose `run-tests/v1 failed-files:` line names ≤50 files reruns those first, and the whole tier only if they pass.

`FLEET_GIT_STATUS_TIMEOUT_MS` (environment, not `.fleet.json`; default `5000`) is the per-call timeout of the worktree `git status` probes. One `git status` costs ~130 ms on a warm 4k-file checkout, so a timeout says the machine's disk is slow, not that the call is wrong. A probe past it reads unmeasured, never clean: the session item notes `uncommitted files not measured`, and an idle worktree stays visible as `cleanliness unchecked`. Both probe sweeps share one 15 s budget, which grows to admit at least one probe; fleet's git calls never take an optional lock (`GIT_OPTIONAL_LOCKS=0`), so a probe cannot rewrite the index under an editor's own git.

`pruneAlert` (`false`, or `{removable?, worktrees?}`; default `{removable: 25, worktrees: 30}`, a missing number keeps its default): once the cached prune count reaches either number, `fleet next` prints an `ASK` line for the coordinator's next pass. `removable` counts branch candidates, removable detached worktrees and stale registrations (listed only, never judged); `worktrees` counts registered worktrees. It names only the action that can address what crossed, and removal stays the user's decision. `false` turns it off.

# Plan: Bound and adjudicate the consumer dependency install

- **Date**: 2026-09-04
- **Status**: Complete — implemented, verified, and audited 2026-09-04;
  `/audit-code` 6 rounds + Gemini APPROVE
- **Author**: Claude (ad-hoc fix, not `/plan`-originated — written retroactively
  so the change has a spec to be audited against)
- **Scope**: backend (one library module + three test suites + one test helper;
  no UI)

> **Target domain(s)**: `shared-lib` (`scripts/lib/install/`), `tests`
> - No new cross-domain edge: the helper added under `tests/helpers/` imports
>   `scripts/lib/install/deps.mjs`, an edge the three suites it serves already
>   had individually.

## 1. Context Summary

**Origin**: `tests/sync-target-path.test.mjs` failed intermittently on a
dependency-install timeout, independently of any code change. Reproduced
2026-09-04 on Windows across three consecutive runs (two full `npm test`, one
isolated `node --test`), with the failing subtest varying between runs — the
signature of a timing-dependent failure, not a logic bug. Observed durations of
240s and 480s.

**Why it matters beyond the test**: `npm run check` (the pre-push hook) ends
with `npm test`, so this intermittently blocked pushes on a slow network for
reasons unrelated to the change being pushed — the cried-wolf shape that earns
a `--no-verify`.

**The reported symptom** was `null !== 0` from
`assert.equal(r.code, 0, …)`, with the sync's stderr showing:

```
  ✓ Required deps installed
  ○ npm reported: spawnSync C:\Program Files\nodejs\node.exe ETIMEDOUT
  Installing optional audit-loop deps in fresh via npm: codeowners-utils, proper-lockfile, playwright
```

**Root cause — three defects, in order of what actually produced the failure:**

1. **Two independently-chosen bounds on one operation, and the outer one was
   the tighter.** `ensureAuditDeps` capped each install phase at 120s
   (`timeoutMs = 120000`); `sync-target-path.test.mjs` capped the whole sync
   subprocess at 240s. The two phases summed to exactly 240s, so on a slow
   network the PARENT killed the child. `execFile` reports a kill as
   `code: null` — hence `null !== 0`, an assertion naming neither the install
   nor the network. The same shape existed, one raised default away from
   firing, in `sync-consumer-divergence-e2e.test.mjs` and
   `sync-outbound-eol-e2e.test.mjs` (300s each, hand-picked).

2. **The cap was not sized to the work.** One number covered both phases, and
   `OPTIONAL_DEPS` contains `playwright`, whose tarball is orders of magnitude
   larger than anything in the required set. A number sized for the required
   phase silently under-bounded the optional one.

3. **A cap-kill was reported in the words of a manager-reported failure.**
   `installAndVerify` already re-probes `node_modules` rather than trusting the
   exit code (the AGENTS.md rule, added for `ERR_PNPM_IGNORED_BUILDS`), and
   that re-probe correctly rescued the required phase above. What was missing
   was *saying which thing happened*: a timeout that landed the deps printed a
   raw `spawnSync … ETIMEDOUT` under a `✓ installed` line, and a timeout that
   did not printed `install failed`, sending the operator after a broken
   package rather than at the cap.

**Explicit non-goal**: the sync logic itself is not to be changed to work
around this. The defect is in how the install is bounded and adjudicated.

## 2. Proposed Architecture

**One oracle for the bound.** `installTimeouts({timeoutMs, env})` in
`scripts/lib/install/deps.mjs` resolves both per-phase caps and their sum. It is
exported so that a caller bounding `ensureAuditDeps` from the outside derives
its budget FROM it rather than picking a second number. This is the structural
fix for defect 1: the parent can never again be the tighter bound, whatever the
defaults become.

**Two caps, not one.** `DEFAULT_REQUIRED_INSTALL_TIMEOUT_MS = 300_000` and
`DEFAULT_OPTIONAL_INSTALL_TIMEOUT_MS = 600_000`, each overridable by
`AUDIT_DEPS_INSTALL_TIMEOUT_MS` / `AUDIT_DEPS_OPTIONAL_INSTALL_TIMEOUT_MS`.
These are **ceilings on a network operation, not budgets**: on a warm cache both
phases finish in seconds, and a generous ceiling only changes how long a wedged
install takes to give up. A junk or non-positive env value falls back to the
default rather than being passed through — `timeout: 0` in `execFileSync` means
NO timeout, so a typo would otherwise silently remove the bound entirely.

**Timeout is a distinct outcome from failure.** `isInstallTimeout(err)` keys on
`err.code === 'ETIMEDOUT'` — a string, where an ordinary failure's `code` is the
numeric exit status, so the two cannot be confused. A cap-kill on the required
phase returns `action: 'timed-out'` (not `'failed'`) and names the cap and its
env lever; a cap-kill that nonetheless landed the packages sets `timedOut: true`
on an otherwise-successful result and says so in one line. Adjudication of
whether the consumer is actually broken remains the `node_modules` re-probe —
unchanged, and the reason `'timed-out'` can be reported honestly at all.

**Test-side: one shared fixture helper.** `tests/helpers/consumer-fixture.mjs`
owns the derived budget, the install-env caps, the seeding, and `whySyncFailed`.
Three suites drive the real `sync-to-repos.mjs` CLI against a scratch consumer;
each had picked its own timeout by hand. One construction site removes the class.

**Test-side: no network install by default.** None of the three suites is ABOUT
dependency installation — they are about the deployment layout (D5a), consumer
divergence, and outbound EOL. `seedInstalledDeps` pre-creates
`node_modules/<dep>` per required+optional dep, which is exactly the question
`findMissingDeps` asks, so the sync reports `already-satisfied` and never spawns
a package manager. `SYNC_TARGET_PATH_INSTALL_REQUIRED=1` opts back into the real
install (the AGENTS.md strictness-flag shape — a skipped path must be forceable),
and under it nothing degrades.

**Why empty directories and not a link to this repo's `node_modules`**: were the
seed ever incomplete, a link would have the package manager install the
remainder straight into the SOURCE checkout's tree. An empty directory cannot do
that. It is also invisible to git, so a fixture running `git add -A` is
unaffected, where a real install buries it under tens of thousands of files.

## 3. Execution Model (dependency analysis)

Sequential; each step depends on the previous.

1. `deps.mjs` — caps, oracle, classifier, verdict, messages.
2. `tests/helpers/consumer-fixture.mjs` — derives from (1).
3. The three sync suites — consume (2).
4. `tests/install-deps-contract.test.mjs` — asserts (1) directly.
5. `docs/reference/environment-variables.md` — documents (1)'s two vars.

## 4. Sustainability Notes

- The `timeoutMs` option is retained as a single-number override of both phases,
  so the previous call contract still works.
- `DEPS_TIMEOUT_MARKER` is exported as the one spelling of the cap-kill
  substring: `sync-to-repos.mjs` calls `ensureAuditDeps` and discards its return
  value, so anything downstream of a sync subprocess can only read a timeout out
  of stderr.
- The caps being ceilings rather than budgets is the property that keeps this
  from re-rotting: raising one costs nothing on a healthy machine.

## 5. File-Level Plan

| File | Change |
|---|---|
| `scripts/lib/install/deps.mjs` | Per-phase cap constants; `installTimeouts`; `positiveIntEnv`; `isInstallTimeout`; `DEPS_TIMEOUT_MARKER`; `installAndVerify(pkgs, capMs)` returning `timedOut`; both call sites' verdicts and messages; `timedOut` on the return shape |
| `tests/helpers/consumer-fixture.mjs` | **New** — `INSTALL_REQUIRED`, `INSTALL_ENV`, `syncBudgetMs`, `DEPS_SATISFIED_MARKER`, `seedInstalledDeps`, `syncExecOptions`, `whySyncFailed` |
| `tests/sync-target-path.test.mjs` | Onto the helper; hand-picked 240s removed; seeded fixtures; deps assertions strengthened |
| `tests/sync-consumer-divergence-e2e.test.mjs` | Onto the helper; hand-picked 300s removed; seeded fixture; `sync()` carries `killed`/`signal` |
| `tests/sync-outbound-eol-e2e.test.mjs` | Same as above |
| `tests/install-deps-contract.test.mjs` | Six tests for cap sizing, env override + fallback, the classifier's must-not-fire direction, and a real cap-kill verdict |
| `docs/reference/environment-variables.md` | New "Consumer dependency install" section |

## 6. Testing Strategy

Tier 1 (test-first for deterministic modules) applies to `installTimeouts` and
`isInstallTimeout`. The three sync suites are Tier 3 (the consumer
sync/relocation contract) and keep every existing assertion.

**Negative controls are mandatory here** — the whole change is about a check
that was passing for the wrong reason:

- Mutate the timeout verdict (`'timed-out'` → `'failed'`) → the adjudication
  test must go red.
- Mutate the timeout message branch → the same test must go red on the wording
  assertion, proving it is not carried by the verdict alone.
- Disable `seedInstalledDeps` → the two deploy tests must go red, proving the
  seed assertions are not vacuous.

**Vacuous-pass guard**: under the seed, `ownedDeps(target)` is empty, so
comparing it against itself proves nothing. The idempotency test therefore also
asserts the stronger property it stands for — a sync into an already-satisfied
consumer must not touch `package.json` at all — plus that the sync reported its
deps satisfied.

## 7. Implementation Phases

Single phase; the file list above is the unit of work.

## 8. Risk & Trade-off Register

| Risk | Mitigation |
|---|---|
| Raising the default caps lets a genuinely wedged install run longer before giving up | Accepted: the caps are ceilings, and the failure mode they replace (a kill that reads as a broken package) is worse than a slower give-up |
| Seeding removes the only end-to-end coverage of a real dep install | `SYNC_TARGET_PATH_INSTALL_REQUIRED=1` restores it, and `install-deps-contract.test.mjs` now covers the cap-kill path deterministically and offline. Measured: on this machine the install exceeded any cap a test may reasonably impose, cold and warm, so the assertion it fed was never actually verified |
| An empty `node_modules/<dep>` is not a working package | Nothing in the sync imports from the target's `node_modules`; presence at that path IS the documented probe contract |
| A copy-only sync ceiling could still be hit under load | Measured: 180s was reached under `node --test`'s CPU-count concurrency; raised to 600s on the ceiling-not-budget reasoning |

## 9. Execution Clustering

One cluster.

## 10. Audit Trail

- Implemented and verified 2026-09-04.
- `npm test`: 14,718 tests, 0 fail, exit 0 (39 skips, unchanged from baseline).
- `tests/sync-target-path.test.mjs`: 450s → 23s, 8/8.
- `SYNC_TARGET_PATH_INSTALL_REQUIRED=1`: 8/8, exit 0, 824s — the real install
  completes under the raised caps, confirming 120s was simply too small.
- Four sync suites in parallel: 49/49, exit 0.
- Gates green: `context:check`, `docs:check`, `docs:refs:gate`, `knip:gate`,
  `npm-args:gate`, `cli:flags:gate`, `requirements:map:check`.

### `/audit-code` — 6 rounds, converged not-stable at max, Gemini APPROVE

Full history: `.audit/audit-code-1757000000-ledger.json` (29 entries, 6
rounds, 100% ruled). Round-by-round:

| Round | Verdict | H/M/L | New | Notable |
|---|---|---|---|---|
| 1 | SIGNIFICANT_ISSUES | 3/4/0 | 7 | Presence probe accepted a bare `node_modules/<dep>` directory as "installed" (H1/H4); `timeoutMs` override bypassed env validation, `timeout:0` meant no cap (H3) |
| 2 | NEEDS_FIXES | 0/5/0 | 5 | M1/M3 flagged an unbounded `timeoutMs` — did **not** reproduce on execution (verified with a positive control); fixed on documented-contract grounds anyway, recorded as such |
| 3 | SIGNIFICANT_ISSUES | 1/2/0 | 3 | **Regression I introduced**: the round-2 M2 fix let a caller raise the child's install cap while the parent subprocess budget stayed a module constant — the exact parent-tighter-than-child bug this change removes, reintroduced |
| 4 | NEEDS_FIXES | 0/4/2 | 6 | Three drifted copies of the same subprocess wrapper across suites were hiding a stale-timeout diagnostic; consolidated into `runSyncCli`. One finding (duplicate plan section) **dismissed as false** — verified by grep, section appears once |
| 5 | NEEDS_FIXES | 0/4/0 | 5 | **Second regression I introduced**: the fix for round-3's bug let a caller-composed env raise the child caps without raising the derived parent budget with it. Two of three negative controls I first ran were themselves invalid (a syntax error from a bad line-splice, a revert that didn't touch the actual bug) — redone correctly before accepting the fix |
| 6 (max) | PASS | 0/1/2 | 3 | Threshold met but not 2-round-stable at the round cap — presented per protocol, fixed anyway rather than deferred to Gemini |
| Gemini | **APPROVE** | — | 1 LOW | `deliberation_was_fair: true`, `claude_bias_detected: false`. Independently identified the same round-3 regression as the standout catch. One new finding (missing `if (TMP)` guard) fixed post-gate, 37/37 |

Full suite re-confirmed clean after every round; final run 14,742 tests / 0
fail / 39 skipped, exit 0. One unrelated flake observed during the round-6
full-suite run (`tests/audit-no-files-cli.test.mjs`, outside this diff
entirely) — reproduced 3/3 clean in isolation and in a subsequent full run;
its own docstring documents the exact flake class (a tight timeout margin
against environment-dependent LLM-call latency under load).

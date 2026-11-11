---
summary: The consumer pre-push hook's version history (v2-v17), moved out of scripts/install-prepush-hook.mjs so the installer stays under the size ratchet.
---

# Consumer pre-push hook — changelog

The generated hook body lives in `HOOK_BODY` in [`scripts/install-prepush-hook.mjs`](../../scripts/install-prepush-hook.mjs); its
version is `PREPUSH_HOOK_VERSION` in [`scripts/lib/prepush-hook-version.mjs`](../../scripts/lib/prepush-hook-version.mjs). Bump it when the
body changes in a way a consumer must re-install to pick up. A stale body is detectable by its `# hook-version:` line; re-install with
`npm run hooks:install -- --target <name>` (after the consumer's sync). Moved here verbatim from the installer's comment block on
2026-11-11 (hook v17), newest last.

## v2

v2 (reference-integrity-gate Cluster C): plan selection moved from `ls -t docs/plans/*.md | head -1` to the Status-aware `check-plan-status.mjs
--select`, so a Complete plan is never re-audited. A stale v1 body is detectable by the ABSENCE of the `# hook-version:` line; `hooks:install` rewrites it.

## v3

v3 (2026-09-04): the source-repo sibling scan is anchored on the MAIN
checkout instead of cwd. A v2 body run from a linked worktree enumerated
sibling WORKTREES, found nothing, and skipped the audit with exit 0 — on
every push a Claude Code session makes. Re-install to pick it up.

## v4

v4 (2026-09-06): two fixes to the plan-status gate, measured in a consumer.
(a) MAIN_PARENT is derived with `pwd -W` where that exists, so the path
handed to node.exe is already NATIVE and does not depend on MSYS rewriting
argv on the way in. (b) The gate probes whether the checker can RUN before
interpreting its exit code, so a crash is reported as a crash rather than as
a Status violation. Re-install to pick both up.

## v5

v5 (2026-09-06): the CONSUMER'S OWN extension point now runs on every push.
`.githooks/pre-push.local` was invoked on the last line, below three
unconditional `exit 0`s — no docs/plans, no source repo beside the checkout,
and (the ordinary case) no plan SELECTED. Measured in wine-cellar-app: with
every plan Complete, `check-plan-status.mjs --select` returns empty, so the
third fired on a real push and the local hook — that repo's full unit suite,
its npm-args gate and its knip gate — never ran, while its AGENTS.md said it
did. A skipped gate reads exactly like a pass. Same defect the round-4 fix
repaired for the weekly-maintenance block by hoisting it above the early
exits; the consumer extension point was not hoisted with it, and hoisting is
the wrong remedy here anyway (see the `finish` comment in the body).
Re-install to pick it up. NOTE for operators: on a repo whose local hook runs
a test suite, pushes get slower by exactly that suite — which is the gate
working. Bypass per-push with PREPUSH_LOCAL_DISABLE=1 or `git push --no-verify`.

## v6

v6 (2026-09-08): the generated hook never read git's own pre-push stdin
protocol (<local_ref> <local_sha> <remote_ref> <remote_sha>), so every
AUDIT_PUSH_RANGE-aware gate (today just check-plan-status.mjs's --drift and
--select, via scripts/lib/push-range.mjs) fell back to inferring a base from
THIS CHECKOUT's own HEAD/@{upstream} — wrong whenever a shared checkout's
local branch sits behind the remote it is pushing to. Measured live in a
consumer (2026-09-07): local main was 17 commits behind origin/main, so
--drift's inferred base was that stale HEAD, and it attributed 10 OTHER
sessions' pre-existing non-conforming plan Status lines to a push that
touched no plan file at all — blocking three consecutive pushes, including
one that carried no commits at all (a branch deletion). The hook now reads
stdin once, immediately after the AUDIT_PREPUSH_DISABLE check, and exports
AUDIT_PUSH_RANGE_BASE/_HEAD from the real range git handed it — the same
fix this repo's own dogfooded .githooks/pre-push already applies. Re-install
to pick it up.

## v7

v7 (2026-09-08): a push whose ONLY changed files are the sync bookkeeping
pair (.sync-receipt.json, scripts/.sync-owned.json — both written by this
repo's own `npm run sync`, never hand-edited) still ran the full code audit
against whatever plan the Status-aware selector fell back to picking, since
selectAuditPlan's documented fallback ("a single active plan is still
unambiguous — no guess required") fires even when nothing in the push
touches that plan. openai-audit.mjs's A1 integrity guard then correctly
refused to certify a verdict over code it never read (0 of the plan's files
were in the --scope diff), but that refusal is an uncaught `throw` — it
prints a Node stack trace that reads as a crash, and it still spent a
preflight cost estimate first. Measured live in ai-organiser: a
bookkeeping-only push after this hook's own v6 fix landed. Now, with a known
push range (v6's AUDIT_PUSH_RANGE_BASE/_HEAD), a push whose changed-file set
is a non-empty subset of exactly that pair skips the audit invocation
entirely — the plan-status gate, maintenance sweep and surfaces-manifest
check are UNCHANGED, since those are cheap and still worth running. An
unknown push range (PUSH_BASE empty) leaves this a no-op, same as before —
never silently skip an audit when the range isn't known.

## v8

v8 (2026-10-02): a DELETE-ONLY push (`git push origin --delete x`, every
stdin line carrying an all-zero local sha) now exits after the maintenance
block instead of running the plan-status gate with an empty range. With no
local sha there is no range to export, so AUDIT_PUSH_RANGE_BASE/_HEAD stayed
empty and check-plan-status.mjs fell back to stale inference, which could
block a push that sends no commits. The skip needs BOTH conjuncts
(published == 0 AND deleted > 0) counted over EVERY stdin line: empty stdin
is not "all deletions", and a mixed push is still checked at its real
update. To make that true the stdin read became a loop (first PUBLISHED ref
wins the range, as in this repo's own .githooks/pre-push), so a deletion
listed first no longer leaves a mixed push on stale inference either. The
skip exits directly rather than through `finish`, so the consumer's
.githooks/pre-push.local (typically a whole test suite) does not run for a
push with nothing to test. Re-install to pick it up.

## v9

v9 (2026-10-08): `finish` runs .githooks/pre-push.local with git's
repo-pointing variables (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, ... — the
GIT_LOCAL_ENV_VARS baseline plus `git rev-parse --local-env-vars`) unset.
Reported by a consumer: pushing from a linked worktree exports GIT_DIR into
the hook, their pre-push.local test suite inherited it, and its throwaway
fixture repos wrote core.bare=true and a fake user identity into the SHARED
.git/config. Re-install to pick it up.

## v10

v10 (2026-10-12): fail closed when killed. Git for Windows reads a hook's
status as `code & 0xff`, and an MSYS sh killed by signal S exits `S << 8`, so
a killed hook read as exit 0 and the push went through (measured on this
repo's own gate during PR #220). The hook now traps every catchable
terminating signal and exits 1 — the same marked block as this repo's
.githooks/pre-push, kept byte-identical by
tests/prepush-hook-fail-closed-on-signal.test.mjs. Re-install to pick it up.

## v11

v11 (2026-10-23): no step can hang silently. A consumer's hook ran a draft-plan audit for 15 minutes on a MERGE-commit push,
printing nothing (its output went to a temp file) and writing no log; workers bypassed it with AUDIT_PREPUSH_DISABLE=1 on most
pushes, so the gate was effectively off. Every node step now runs through scripts/prepush-step.mjs: a wall-clock budget, one
progress line per step plus a 30s heartbeat, and on expiry a REFUSAL (exit 1) naming the step, the elapsed time and the machine
lease holder - never a skip. And a merge push no longer audits what main brought in: plan selection and the audit's --files scope
are the branch's own non-merge commits (push-range.mjs branchOwnedChangedFiles). Re-install to pick it up:
`npm run hooks:install -- --target <name>`.

## v12

v12 (2026-10-23): an audit that did not run no longer passes, and a big audit is not redone. (1) The hook read every non-zero audit
exit other than 124 as "config/key error -> noise" and let the push through (storyline #427): a crash, a missing credential and
an INCOMPLETE exit-3 run were indistinguishable from advisory findings. The audit's own contract decides now - it exits 0 for ANY
completed run (findings live in its --out envelope's verdict, never in the exit code), 3 for INCOMPLETE, 1/2 for "the CLI itself
errored" - so DID NOT RUN (crash, auth/config, exit 3, no envelope) REFUSES the push naming the cause, unless the one named
override AUDIT_PREPUSH_ALLOW_UNMEASURED=1 is set (and then the output says so); RAN WITH FINDINGS stays advisory unless
AUDIT_PREPUSH_BLOCK=1; RAN CLEAN passes. (2) A ~60-file storyline push timed out at the flat 600s although 3 GPT rounds + Gemini had
already passed that very tree. A CONVERGED run recorded for exactly the pushed commit's TREE (.audit/last-audit-run.json + the
store row) is reused and the audit skipped, saying which run; a tree that differs by one byte re-runs. Otherwise the budget scales
with the diff (files + lines, floor 600s, capped) unless AUDIT_PREPUSH_AUDIT_BUDGET_SEC pins it. Logic: lib/prepush-audit-gate.mjs.
Re-install to pick it up: `npm run hooks:install -- --target <name>` (after the consumer's sync).

## v13

v13 (2026-10-24): v12's first day in the field, three fixes. (1) A push the plan selector resolved NO plan for (none touched among
several active, or none active) exited at the selection with only "[plan-status] no active plan to audit": a code push passed with
NOTHING measured and was never reported UNMEASURED (storyline #431). It now REFUSES as UNMEASURED naming the cause, unless the push
carries nothing a code audit reads (docs or sync bookkeeping only) or AUDIT_PREPUSH_ALLOW_UNMEASURED=1 says so on purpose. The audit
is plan-keyed (`openai-audit.mjs code <plan-file>`), so a plan-less audit was not the cheap option. (2) The diff-scaled audit budget is
refit from the store's MEASURED round-1 audit durations (600s + 30s per file, capped): v12's formula gave a 23-file / 1208-line push
881s and the audit took 882s. (3) A converged audit is also reused when the tree differs but the branch's own commits have exactly
the audited commits' content fingerprints (a rebase / cherry-pick recovery moves the tree, not the diff) - printed as range-diff-equivalent,
never as "the same tree". Logic: lib/prepush-audit-gate.mjs, lib/patch-equivalence.mjs. Re-install: `npm run hooks:install -- --target <name>`.

## v14

v14 (2026-10-24): the audit's report is KEPT. v13 wrote the result envelope and the step's output to mktemp files and deleted both
as soon as the outcome was read, so the H/M findings of an advisory run were gone when the push returned and could not be
triaged (wine #1171/#1181/#1183). They now live under the consumer's gitignored .audit/prepush/ (mktemp inside it, renamed to
<pushed-tree-sha>.report.json / .output.log), the path is printed on EVERY outcome (pass, findings, unmeasured, timeout - where a
partial output is kept, or "none exists" is said), the newest AUDIT_PREPUSH_KEEP_REPORTS (default 20) of each kind are retained,
and a directory or file that cannot be created still refuses the push. Re-install: `npm run hooks:install -- --target <name>`.

## v15

v15 (2026-10-25): (1) a push whose files are ALL non-subjects for the code audit (lockfiles, images, *.json, config/schema/type dirs -
the audit's own `shared` bucket) is NO_CODE_IN_SCOPE: a distinct, recorded, MEASURED outcome (.audit/prepush/<tree>.no-code.json),
neither a pass of the audit nor UNMEASURED. Before this a package.json-only push aborted in the audit's own "0 implementation files"
guard and was refused as UNMEASURED (fleet 70b5). The decision is made by `prepush-step.mjs no-code` and the hook bypasses only on rc 0 +
the exact token + a non-empty record; anything else runs the audit as in v14, and an older source checkout without the subcommand does too.
(2) After the report is kept, ONE informational line says how much of this push's findings sit on files the previous push flagged
(`prepush-step.mjs recurrence`) - it never suppresses and never gates (fleet 484f). (3) The run's own `.tmp-ledger.*` is removed by
exact path, and older orphans by the 24h rule `.tmp.*` already had. Logic: lib/prepush-audit-gate.mjs, prepush-step.mjs.
Re-install: `npm run hooks:install -- --target <name>`.

## v16

v16 (2026-10-25): v15's field gaps. (1) A `sync:pr` push with no single active plan read UNMEASURED (its .gitignore managed-block edit looked like code;
every consumer sync needed AUDIT_PREPUSH_ALLOW_UNMEASURED): the SANCTIONED SYNC LANE recognises exactly one commit with a
`Sync-Bundle:` trailer the receipt in the pushed tree attests, touching only paths the sync owns (its own sidecar; .gitignore only as a managed-block edit). (2) A tag-only push (7 archive tags: a ~10 min paid audit)
selected a plan and audited: the consumer now runs the archive lane (a secret/sensitive-path scan of what an archive ref publishes) and skips the
audit for tag pushes whose commits the destination already holds (`prepush-step.mjs landing`, ls-remote, never a stale local ref). (3) Plan
selection also reads the plan whose DECLARED PATHS cover the changed code (reason printed), and the plan-status gate reads the pushed commit, not
the working tree. (4) The body warns when the source expects a newer hook. The trap probe is `trap '' SIG` (dash). Re-install: `npm run hooks:install -- --target <name>`.

## v17

v17 (2026-11-11, docs/plans/prepush-gate-consumer-feedback-theme1.md; consumer feedback theme 1). Four changes:
(1) PLAN-LESS AUDIT (D1). A code push the selector resolved no plan for is audited WITHOUT a plan
(`openai-audit.mjs code --planless <intent>`): the pushed branch's own commit messages, secret-redacted and capped at 8 KB, are
the stated intent, written to a per-invocation `.audit/prepush/<tree12>-<base12>-<head12>-<pid>.intent.md`. v13-v16 refused such a
push UNMEASURED, which in a repo whose `docs/plans/` is untracked (ai-organiser) refused every code push. Only a SUCCESSFUL no-match
falls back to plan-less: a failed selector, an `AUDIT_PREPUSH_PLAN` naming no file, and an unknown range still refuse UNMEASURED; a
docs / bookkeeping-only push stays exempt. A missing `docs/plans/` directory no longer `finish`es the hook (it pushed code with no
audit and no UNMEASURED line); it is a no-match like any other, and an explicit `AUDIT_PREPUSH_PLAN` still wins. The verdict line reads
`code audit (plan-less): ...` and the envelope carries `planless: true`.
(2) THE AUDIT READS THE PUSHED COMMIT (D2). It runs with its cwd in a detached snapshot worktree of `PUSH_HEAD`
(`$TMP/ces-consumer-snap-<tree12>-<pid>`, `prepush-step.mjs snapshot create`), removed and stat-verified on every exit path by an
EXIT trap; a husk a SIGKILL leaves is swept by a later push (dead owner at once, else 24h). The working tree is never read: an
uncommitted regenerated file (ai-organiser's 2.7 MB architecture map) can no longer overflow the adjacency diff, and an edit made
mid-audit is not read as pushed. The intent, report and output log are absolute paths in the checkout's `.audit/prepush/`. An untracked
`.auditignore` is copied in; the untracked debt ledger is passed as `--debt-ledger <abs> --read-only-debt`; local learning state is not
copied, so a hook audit's reuse marker dies with the snapshot. A selected plan crosses by its repo-relative path when the snapshot holds
the same bytes, else by the checkout's absolute path, said out loud. Shared with CES's own gate: `lib/prepush-snapshot.mjs`.
(3) TOOLING STATUS IS NOT A FINDING (D3, gate library; no body change needed): a control-state marker (`ADJACENCY_INCOMPLETE`) is a
`[prepush-hook] tooling:` line, excluded from H/M/L, and a git output overflow is named with its buffer size.
(4) INVOCATION LOG (D4): one line per invocation in `.audit/prepush/invocations.log` (time, head12, outcome, overrides that were set),
rotated to `.1` past 256 KB. The kill switch writes `disabled` with head `-`; `git push --no-verify` is not observed.
The runner must offer the `planless` and `snapshot` capabilities, or the hook refuses as for any runner that predates it.
Re-install: `npm run hooks:install -- --target <name>` (after the consumer's sync).

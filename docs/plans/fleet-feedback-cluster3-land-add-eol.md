# Plan: fleet feedback cluster 3 — remote-only `add`, flaky remote reads, abandon cleanup, EOL flips, ignored `--dry-run`
- **Date**: 2026-11-22
- **Status**: In progress — plan audited (2 GPT rounds + Gemini), implemented on claude/fleet-cluster3-land-add-eol
- **Author**: Claude + Louis
- **Scope**: backend (Node CLI, `scripts/lib/fleet/**`, two standalone scripts). Stack `js-ts`.
- **Target domain(s)**: `fleet`

## 1. Context Summary

Work-consumer fleet feedback of 2026-11-21, items #4, #6, #7, plus the two ignored `--dry-run` bugs the coordinator folded in.
Code trace (read at `88cd976c`):

- **#4.** `cmdAdd` (`commands.mjs`) looks the branch up only in `facts.branches` (local heads) and answers `no local branch <x>`
  for a branch a teammate pushed and the user fetched.
- **#6.** `git ls-remote` is read in `git-facts.mjs` `remoteRefOid`, `rollup-land.mjs` (`remoteTip`, `freeBranch`) and `serial.mjs`
  (the base tip) through one-shot calls; one transient failure fails the whole `land`. `removeTrainWorktree` (`train.mjs`) tries
  the removal once, and `renderAbandon` prints `(worktree: <reason>)` with no path and no command, so a train abandoned over a
  locked worktree reads as clean.
- **#7.** Nothing at `ready` looks at line endings; a CRLF/LF rewrite of a file shows as a whole-file change and reaches a
  train as noise. `canonicalizeEol` (`file-io.mjs`) exists for hashing generated artifacts, not for source review.
- **Dry-run.** `sync-refresh.mjs` parses `--no-pull`/`--target` by `argv.includes` and has no unknown-flag check (it is in the
  `check-cli-flags` baseline), so `--dry-run` was ignored: a "dry run" pulled the clone and synced into the consumer.
  `write-ledger-r1.mjs` parses no argv at all and writes its ledger on import.

## 2. Design

### D1 (#4) — a remote-only branch is made local, then adopted
`materializeRemoteBranch(cwd, name)` (`commands.mjs`): only when `refs/heads/<name>` is absent, and `<name>` passes
`git check-ref-format --branch`, it lists `refs/remotes/*/<name>`, keeps exact `<remote>/<name>` matches, and `git branch
--no-track -- <name> <remote>/<name>` (no checkout, never overwrites, and NO `branch.<name>.*` configuration — adoption does not need tracking, and writing none
makes rollback exactly the ref). Zero matches → null (the old refusal stands); more than one
remote → a refusal naming them (a guess adopts the wrong tip). It runs BEFORE the facts are gathered so adoption sees the
branch like any other; the output says `created local branch … from <remote>/<name>`. A `#PR` or `--all` is unchanged.
**Order and recovery.** (1) `git branch --no-track` is atomic: a concurrent creator makes it FAIL (a refusal), never overwrite. (2) Adoption persists the
session under the registry lock as before. (3) If NOTHING was adopted (refused, failed, already tracked, or a throw) the ref THIS call created
is removed again with `git update-ref -d refs/heads/<name> <oid it created>` — a compare-and-swap, so a branch someone moved or made since
is never deleted — and the text says so. A crash between (1) and (3) leaves a plain tracking branch, which is harmless and visible.

### D2 (#6a) — a remote READ is retried, a test rerun never is
`remote-read.mjs`: `retryRemoteRead(read, {attempts: 3, sleep})` retries only a read that could not be ASKED (`ok:false`), 400 ms then
1200 ms apart (≈1.6 s). The contract it reads is the structured `{ok, reason}` every call site already returns (`runGit` and the injected
`deps.git` never throw); a PERMANENT failure (authentication, a wrong remote, permission) is not retried either.
Classification is by the failure `reason` at this one seam (four classes: timeout, permanent, transient, unknown); an UNKNOWN failure is retried
— the conservative side for an idempotent read, bounded at ≈1.6 s — and a test pins each class including unknown. An answer — including a reachable remote saying "ref absent" (`ok:true`, empty) — returns at once, and a
read that TIMED OUT is not retried (the remote is hung; tripling 60 s is not a flake cure). `lsRemote(git, args, …)` wraps an
injected `git` dep. Applied at the four `ls-remote` call sites above; `remoteRefOid` keeps its `{ok, oid}` shape and appends
`(after N attempts)` to a final failure. It wraps reads only: no push, merge, tier or test run goes through it.
*Band-aid considered:* raise the timeout. Rejected — a hung remote is not helped and a fast reset is not caught.

### D3 (#6b) — `land --abandon` retries the removal, then says what is left
`removeTrainWorktree` makes up to three bounded attempts (500 ms, 1000 ms) before reporting `worktree not fully removed`.
`abandonTrain` returns `leftBehind: [{kind:'worktree', path, dirExists, registered, reason}]` when the removal failed and EITHER the
directory remains OR git still lists it — the two facts kept separate because they need different recovery: registered + directory →
`inspect it first, then git worktree remove --force --force <path>` (a locked worktree needs `--force` twice); not registered → only a
directory, delete it yourself after inspecting; directory gone but still registered → preview with `git worktree prune --dry-run -v`, then `git worktree prune` (named as clearing EVERY stale registration, not only this one; git has no
path-targeted prune). The path is quoted as data. A
clean abandon prints no such line. The phase still becomes `abandoned`: the train is
over whether or not the directory could be deleted, and the directory is named so it is not silently orphaned.

### D4 (#7) — line-ending flips are disclosed at `ready`
`eol-flips.mjs`: two `git diff --numstat -z` reads of the SAME range (measured base → the head being marked), one raw and one
with `--ignore-cr-at-eol`. Empty ignoring-CR diff with a non-empty raw one = a PURE flip; at least 20 extra raw lines and at least
twice the real change = a PARTIAL flip (the real change is buried). With `--no-repo-renames` semantics (`--no-renames` in BOTH reads) there is one record per path in each read, `-z` carries a path with a space,
tab or newline untouched (the path is everything after the second tab), a binary file (`-`) is skipped, and a path present in the raw read but
absent from the ignoring-CR read is a file whose ONLY change was endings. `ready` prints one warning per class
(≤ 8 names, exact count) and ALWAYS carries `eol: {checked, flips[, reason]}` in its JSON (`checked:false` + reason when it could not look,
`checked:true, flips:[]` when it looked and found none); the warnings live in `text`, the one human-readable field of the single JSON value. **Advisory, never blocking** (a deliberate `.gitattributes` change is
also a flip); an unmeasured base or unreadable range prints `note: line-ending churn was not checked (<why>)` — never read as
"no flips". Not added to `train.mjs`: a train is built from ready marks, so `ready` is the earliest point and a second check there
would only repeat it.

### D5 — the two ignored `--dry-run` CLIs
`sync-refresh.mjs` gains `assertKnownFlags` (`--target`, `--no-pull`, `--dry-run`; an unknown flag exits 2) and honours
`--dry-run`: no `git pull` (a pull rewrites the canonical clone) and `sync-to-repos.mjs … --dry-run`. Its `check-cli-flags`
baseline entry is removed on the strength of a negative control (`--dry-runn` exits 2). `write-ledger-r1.mjs` gains
`assertKnownFlags` and `--dry-run` (reports what it would write, writes nothing), and its work moves into `main()` behind
`isInvokedAsScript(import.meta.url)`, so importing it writes nothing. `sync-refresh` validates `--target`'s value (missing, or another flag standing in
for it, exits 2) before pulling or spawning anything; the first `--target` wins.

## 3. Acceptance criteria

- A1. `fleet add <x>` with `x` only on `origin` creates `x` tracking `origin/x` (no checkout) and adopts it; nowhere → still
  refused; two remotes → refused naming both; an existing local branch is untouched; a nonsense name creates nothing.
- A2. A failed remote read is retried at most 3 times with the stated backoff; an answer and a timeout are not retried; the four
  call sites use it; `remoteRefOid`'s shapes are unchanged.
- A3. A removal that clears on a retry is a success; one that never clears reports the failure after the bound; `renderAbandon`
  names the leftover path and the removal command only when something is left.
- A4. `ready` warns on a pure and a partial flip, not on an ordinary change, says so when it could not check, and never blocks.
- A5. `sync-refresh`/`write-ledger-r1` exit 2 on a mistyped flag; `--dry-run` writes/pulls nothing; the baseline entry is gone.

## 3b. Test matrix (same commit as the code)

`tests/fleet-cluster3.test.mjs`: #4 create / nowhere / two remotes / existing local / nonsense name / rollback + no tracking config; #6 retry bound, answer,
timeout, permanent, unknown-retried, `lsRemote`, `remoteRefOid` shapes, removal retry and give-up, the three `renderAbandon` recovery states; #7 pure,
partial, clean, rename/binary/odd-name, unmeasured, JSON `checked`, `ready` end to end; dry-run: both CLIs' mistyped flag (exit 2), `--dry-run`
writes/pulls nothing, a missing or flag-shaped `--target`, importing `write-ledger-r1` writes nothing. `sync-refresh` is exercised through its real
CLI (the consumer-sync Tier-3 seam: argument handling is the part this change alters, and it is the part tested).

## 4. Files

`scripts/lib/fleet/commands.mjs` (D1, D4 wiring), `scripts/lib/fleet/remote-read.mjs` (D2), `scripts/lib/fleet/git-facts.mjs`,
`scripts/lib/fleet/rollup-land.mjs`, `scripts/lib/fleet/serial.mjs` (D2 call sites), `scripts/lib/fleet/train.mjs`,
`scripts/lib/fleet/render-train.mjs` (D3), `scripts/lib/fleet/eol-flips.mjs` (D4), `scripts/sync-refresh.mjs`,
`scripts/write-ledger-r1.mjs`, `scripts/check-cli-flags.mjs` (D5), `tests/fleet-cluster3.test.mjs`.

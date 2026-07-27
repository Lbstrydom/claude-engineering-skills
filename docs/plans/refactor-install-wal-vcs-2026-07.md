# Plan: Install-Transaction WAL + VCS Parsing Debt (2026-07-26 triage)

- **Date**: 2026-07-26
- **Status**: Complete
- **Author**: Claude (tech-debt backlog triage session)
- **Scope**: backend

> **Closure note (2026-07-27)**: all 22 entries resolved via two derivative
> implementation plans — the `transaction.mjs` 9-entry portion via
> [`transaction-wal-cleanup-failure-distinction.md`](./transaction-wal-cleanup-failure-distinction.md),
> and the `vcs.mjs`/`find-rmsync-sites.mjs` 13-entry portion via
> [`vcs-parsing-and-rmsync-scope-hardening.md`](./vcs-parsing-and-rmsync-scope-hardening.md)
> (audit trail: [`vcs-parsing-and-rmsync-scope-hardening-audit-summary.md`](./vcs-parsing-and-rmsync-scope-hardening-audit-summary.md)).
> This triage document is kept in place as the historical record of the
> original 22-entry cluster; the tables below are as originally triaged.

> Origin: full `.audit/tech-debt.json` backlog triage (384 entries). This
> cluster (22 entries) covers `scripts/lib/install/transaction.mjs` (the
> write-ahead-log installer transaction system) and `scripts/lib/vcs.mjs`
> (git output parsing). Both were independently re-verified twice (by two
> different sub-agents, given the same file by different labels — a
> batching mix-up on my end, not a deliberate double-check, but the
> agreement is reassuring). Of the 19 original `transaction.mjs` findings,
> **10 are already fixed** (locking, journal validation, fsync-on-critical,
> delete-reconciliation during recovery — see the resolution events for
> specifics); these 9 are what's left.

---

## `transaction.mjs` — remaining WAL gaps

All three remaining defect classes share one root cause: **the recovery/
cleanup paths still have "best-effort" catches that don't distinguish
"nothing to clean up" from "cleanup failed."**

- `0b7661a0`/`22bb5573`/`aea521d8`/`ee735643` (4 duplicate topicIds, same
  bug) — `writeJournal`'s final `retrySync(() => fs.renameSync(tmp,
  journalPath))` (line 496) sits *outside* the try/catch/finally that
  cleans up `tmp` elsewhere in the function, so an exhausted-retry rename
  failure leaks the temp journal file.
- `6e6e7f3c`/`725c8fff` — `rollbackPartialTransaction` has branches for
  `snapshot === undefined` and `snapshot !== null`, but a `null` snapshot
  (recorded on a *read* failure) falls through untouched — the pre-existing
  target file is neither restored nor removed.
- `9ffef897` — `fsyncDir` is called after every rename but never after any
  `unlinkSync`/delete — directory-entry durability for deletes is weaker
  than for renames.
- `c0f85a8c`/`cea63575` — both the roll-forward recovery path and the
  transaction rollback path log a failure and then *unconditionally* call
  `cleanupJournal()` right after — discarding the WAL even when the
  recovery/rollback it just attempted didn't actually succeed.

**Fix shape**: wrap the `tmp`-cleanup in the same try/finally style already
used for the write path; add the missing `snapshot === null` branch to
rollback; call `fsyncDir` after deletes too; and change both
`cleanupJournal()` call sites to only run when the preceding recovery/
rollback step actually reported success — otherwise leave the journal for a
future recovery attempt (which is the whole point of a WAL).

## `vcs.mjs` — two independent, unrelated defect classes

- **Whitespace-unsafe name-status parsing** (`087d6ca8`, `1aa272b5`,
  `bc3095ea`, `bd92cfe5`) — `gitDiffWithWorkingTree` splits
  `git diff --name-status` lines with a whitespace regex
  (`/^([AMDR])\d*\s+(.+?)(?:\s+(.+))?$/`), so a path containing a literal
  space gets truncated/misparsed. Same issue in the rename-record parsing
  (old-path/new-path split on `\s+`, which can't distinguish an embedded
  space from the real tab separator). **Fix**: `git diff --name-status -z`
  (NUL-separated) sidesteps this whitespace ambiguity entirely — worth
  checking whether the existing callers can tolerate the NUL-delimited
  format.
- **`sinceCommit` falsy silently skips tracked-file diffing**
  (`1f40ab08`, `ebbbc2ad`) — when `sinceCommit` is `null`/`undefined`, the
  whole `git diff --name-status` block is skipped, so only untracked files
  (`git ls-files --others`) come back; modified/deleted/staged tracked
  files are silently omitted from the returned diff shape. **Fix**: either
  default `sinceCommit` to a sensible base (mirrors this repo's own
  `push-range.mjs` "one range, one resolver" doctrine — don't let a second
  ad-hoc base-inference path exist) or make the omission an explicit,
  visible field on the return shape rather than a silent gap.
- **Mutable exported policy Set** (`1337d6e1`, `904c0d36`, `913d3a00`,
  `c2cca428`) — `RETRYABLE_VCS_ERRORS` is a plain `new Set(...)` exported
  directly; a caller doing `.add()`/`.delete()` on it mutates shared state,
  and `isRetryableVcsError()` independently hardcodes `'EXEC_FAILED'`
  rather than reading the Set, so the two can silently diverge. **Fix**:
  freeze the Set at export (`Object.freeze` doesn't work on a `Set`'s
  contents, so wrap it — export a getter or a `ReadonlySet`-style facade)
  and have `isRetryableVcsError` read from it instead of duplicating the
  policy.

## `find-rmsync-sites.mjs` — lexical, scope-blind matching

`0c1d3132`, `82ab4534`, `e54d6d52` — both the production linter and its own
test helper (`rmsync-retry-guard.test.mjs`) match `fs.rmSync`-style calls by
plain identifier name with no lexical-scope/shadowing resolution, and don't
handle computed (`fs['rmSync']`) or optional-call (`fs?.rmSync()`) forms.
**Fix**: this needs real AST scope resolution (the same class of gap noted
for the atomic-write-adoption guard below) — a shadowed local named `fs`
that isn't the `node:fs` import would currently satisfy the guard
incorrectly either way (false-negative for the retry check, false-positive
risk for the linter).

---

## Full entry table


**`scripts/lib/install/transaction.mjs`**

| topicId | severity | evidence |
|---|---|---|
| `0b7661a0` | MEDIUM | transaction.mjs:496 rename-retry failure outside cleanup try/catch, leaks temp journal (confirmed 2x) |
| `22bb5573` | MEDIUM | transaction.mjs:496 same gap duplicate (confirmed 2x) |
| `6e6e7f3c` | HIGH | transaction.mjs:638-639,726-735 null snapshot falls through rollback untouched (confirmed 2x) |
| `725c8fff` | HIGH | transaction.mjs same defect duplicate (confirmed 2x) |
| `9ffef897` | HIGH | transaction.mjs fsyncDir called after renames but never after unlink/delete (confirmed 2x) |
| `aea521d8` | MEDIUM | transaction.mjs:496 same rename-retry leak duplicate (confirmed 2x) |
| `c0f85a8c` | HIGH | transaction.mjs roll-forward catch only logs, cleanupJournal runs unconditionally after (confirmed 2x) |
| `cea63575` | HIGH | transaction.mjs rollback swallows restore failures, cleanupJournal runs unconditionally (confirmed 2x) |
| `ee735643` | MEDIUM | transaction.mjs:496 same rename-retry issue duplicate (confirmed 2x) |

**`scripts/lib/vcs.mjs`**

| topicId | severity | evidence |
|---|---|---|
| `087d6ca8` | HIGH | vcs.mjs:300 whitespace regex truncates filenames with spaces |
| `1337d6e1` | MEDIUM | vcs.mjs:51 RETRYABLE_VCS_ERRORS still mutable exported Set |
| `1aa272b5` | HIGH | vcs.mjs:300 rename record whitespace regex ambiguous split |
| `1f40ab08` | HIGH | vcs.mjs:276 sinceCommit falsy skips diff entirely, only untracked returned |
| `904c0d36` | LOW | vcs.mjs:51 same mutable Set duplicate |
| `913d3a00` | LOW | vcs.mjs:51,60-62 mutable Set + duplicate hardcoded policy diverge |
| `bc3095ea` | HIGH | vcs.mjs:300 same whitespace regex bug duplicate |
| `bd92cfe5` | MEDIUM | vcs.mjs:300,324-327 whitespace regex + trim mishandles legit whitespace |
| `c2cca428` | LOW | vcs.mjs:51,60-62 duplicate mutable Set issue |
| `ebbbc2ad` | HIGH | vcs.mjs:276-307 confirmed null/undefined sinceCommit skips diff, omits modified/deleted/staged files |

**`scripts/lib/find-rmsync-sites.mjs`**

| topicId | severity | evidence |
|---|---|---|
| `0c1d3132` | MEDIUM | find-rmsync-sites.mjs:30-53,173-184 scope-blind matching |
| `82ab4534` | MEDIUM | find-rmsync-sites.mjs:173-184 computed/optional-call forms unmatched |
| `e54d6d52` | MEDIUM | find-rmsync-sites.mjs + rmsync-retry-guard.test.mjs scope-blind matching |

## Rollback

All fixes are additive/defensive within existing modules; no schema/data
migrations. `transaction.mjs` changes should be covered by
`tests/transaction*.test.mjs` (extend rather than replace) before shipping,
given this module's WAL semantics are safety-critical for `install.mjs`/
`setup.mjs`.

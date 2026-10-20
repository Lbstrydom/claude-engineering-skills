# Test evidence: may an earlier test run be reused, or must the tests rerun?

**What it is.** `scripts/test-evidence.mjs` records a command's outcome next to a
hash of the content it ran against, and later answers one word: `reusable`,
`invalidated` or `unknown`. It exists for the long suite (a 3h27m rerun after a
documentation-only change is the case that earned it). **It never skips a test.**
No hook, `/ship` step or `--no-tests` path consults it; a person or an
orchestration reads the verdict and decides. `unknown` always means rerun.

**When you need it.** Before rerunning an expensive suite, or when a ship report
needs to cite an earlier green run honestly. Plan:
`docs/plans/copilot-feedback-item4.md` Cluster C.

## Use

```powershell
node scripts/test-evidence.mjs record --junit report.xml -- python -m pytest -q --junitxml=report.xml
node scripts/test-evidence.mjs check -- python -m pytest -q --junitxml=report.xml
```

`record` runs the command (no shell, so quote arguments for the command itself,
not for a shell) and writes the record. The child's stdout and stderr go to
**stderr**; stdout is exactly one JSON envelope. `check` recomputes the content
identity and answers.

| Verb | Flags | Exit codes |
|---|---|---|
| `record` | `--ignore GLOB` (repeatable), `--toolchain "PROBE"` (repeatable), `--junit PATH` | the child's own code; 1 killed by a signal; 2 could not start (or a usage error); 3 ran green but nothing was recorded, or the identity could not be computed so nothing ran |
| `check` | `--ignore`, `--toolchain` (same as the `record` they pair with) | 0 `reusable`, 1 `invalidated`, 3 `unknown` |

`--ignore`, `--toolchain`, the working directory, the platform and the
architecture are part of the **record key**: the same command from another
directory, or on another machine, finds no record and reads `unknown`. Records
live in `<git-common-dir>/test-evidence/`, shared by every linked worktree.

## The three answers

| Answer | Means | Examples |
|---|---|---|
| `reusable` | The recorded run exited 0, was stable, executed tests, and the tested content is unchanged. Cite it with its counts and wall time. | Only files under an `--ignore` glob changed (they are named). |
| `invalidated` | A recorded green run exists but the content moved. The changed paths are listed. | A tracked file edited; an untracked file appeared; a `--toolchain` probe output moved; `core.autocrlf` changed. |
| `unknown` | There is nothing sound to reuse. Rerun. | No record; unreadable or wrong-version record; the recorded run failed, was killed or never started; the recorded run was **unstable** (the tree changed while it ran); zero tests ran; the tested content is empty; a clean/smudge filter (for example LFS) is configured. |

A failed or unstable recorded run is `unknown`, not `invalidated`: there was no
valid green to invalidate.

## What "content" means (and does not)

The identity is **git's normalised content** of the whole worktree: tracked
edits, staged edits and untracked, non-ignored files, hashed through a throwaway
index (your real index is never touched). It is the identity `AI-Audited-Tree`
uses, not a byte hash, so a CRLF-only rewrite under `text=auto` is the same
content, while a changed `core.autocrlf`/`core.eol` is not. **By default any
changed path invalidates**; declare what the suite may legitimately rewrite or
what is irrelevant with `--ignore 'docs/**'` (a glob, relative to the repo root).

**Known limit: gitignored inputs are invisible.** `.env`, a virtualenv, generated
config: a change to one does not move the hash, and `check` will still say
`reusable`. Bind what matters with a probe, whose stdout is hashed and never
stored:

```powershell
node scripts/test-evidence.mjs record --toolchain "python --version" --toolchain "pip freeze" -- python -m pytest -q
```

A probe is a command, not a shell line (quotes group arguments). A probe that
cannot run is `unknown` (and `record` runs nothing).

## Counts

With `--junit`, counts come from the JUnit XML **this invocation produced**: the
file must be new or changed and written after the run started; a stale report
beside a command that wrote none is `counts: null` with `report not produced by
this run`. Supported: a root `<testsuites>` carrying all four totals (used as
is), otherwise the sum over leaf `<testsuite>` elements. Everything else, a
negative or inconsistent total, an unreadable file, or **`node --test` top-level
tests (bare `<testcase>`, wrap them in `describe()`)**, is `counts: null` with a
named diagnostic. Without `--junit` the output says `counts unmeasured`, never `0`.

## Honest edges

- `unstable`: the content identity is captured before AND after the run. If the
  reuse identity moved (the suite rewrote a tracked file, or someone edited one
  mid-run) the record is written with `stable: false` and `check` says `unknown`.
  A suite that rewrites a tracked output should declare it with `--ignore`.
- A recorded tree git has since pruned degrades only the changed-path listing
  (`paths unavailable`), never the answer.
- A repository that uses clean/smudge filters (LFS) never reuses.
- Deferred: an `AI-Tests` commit trailer and a test ladder (smallest
  discriminating test, then affected, then full); both need evidence this tool
  does not collect.

# Audit summary — arch-memory / symbol-index manifest transport

- **Date**: 2026-08-09
- **Plan**: [`refactor-arch-memory-symbol-index-2026-07.md`](refactor-arch-memory-symbol-index-2026-07.md)
- **SID**: `audit-code-manifest-1786282081`
- **Scope**: `--base 14641cc0` (the session's own commits + working tree)
- **Verdict**: **CONVERGED** — GPT R15 `H:0 M:0 L:0`; Gemini `APPROVE` (0 new, 0 wrongly dismissed), three consecutive
- **Tests**: 10,382 pass / 0 fail / 24 skipped (skip count unchanged throughout — the suite never quietly stopped running things)

## Why 15 rounds

Well past the 6-round cap, and deliberately. The cap exists to stop *rigor
pressure*; every extra round here was bought by a **concrete new defect**, which
is the documented exception. The rounds that produced nothing new (R4, R5, R15)
were the ones that ended each phase. The escalation pattern:

| Round | What it produced |
|---|---|
| R1 | 6 findings (1 HIGH, 5 MEDIUM) — the real parsing + temp-file defects |
| R2, R4, R5 | clean |
| R3 | REOPENED the temp-file finding — my fix's comment overclaimed |
| R6 | control marker only (adjacency hit its own enumeration cap) |
| R7 | adjacency re-run at full coverage — clean |
| R8–R13 | Gemini + shadow findings: producer/parser asymmetry, I/O ordering, UTF-8 scope, hand-rolled duplication |
| R14 | 1 pre-existing HIGH (deferred), 2 adjacency false positives |
| R15 | clean |

## What was actually wrong

**The parsing contract (H1/M1/M2/M4/M5 → one coherent fix).** `--files-from`'s
documented precedence over `--files` was implemented only by left-to-right
assignment to a shared field, so `--files-from intended --files stale.js`
silently indexed the wrong subset. Unknown flags were dropped whole, so a
one-letter typo (`--files-form`) silently promoted a restricted incremental run
to an unrestricted full walk. `.filter(Boolean)` shortened malformed lists
without complaint. All resolved by adopting the contract `refresh-args.mjs`
already established — `assertKnownFlags`, `--flag=value`, a `--` terminator —
plus resolving scope **once after the loop** and refusing both-supplied and
repeated flags outright. No precedence rule remains to get wrong.

**The temp-file trust boundary (M3 → R3 reopen → `compromise`).** `wx` closed
only the pre-creation half of the race. `mkdtempSync` narrows it further, but
the finding was right that the *replacement comment overclaimed* too. GPT
deliberation adjudicated `compromise`, HIGH→LOW: keep the private directory,
reject the proposed `--files-from-stdin` transport (a same-UID attacker can
rewrite the reader, the parser, the working tree, or read `.env` — the manifest
pathname is not an independent boundary against that actor), and fix the
**claim**. Gemini's `over_engineering_flags` independently reached the same
conclusion. The docblock now states exactly what is closed (cross-UID, name
predictability) and what is not, with a named revisit trigger.

**Producer/parser asymmetry (shadow `3339be19`).** The parser was strict while
`formatFilesManifest` coerced anything via template interpolation. Measured: a
`{from,to}` rename object became the literal path `[object Object]` and *passed*
the parser — the file silently absent from the extraction scope. That is the
silent-data-loss class the module exists to prevent, one function from its own
guard, and `refresh-file-scope.mjs` builds part of its list from
`diff.renamed.map(r => r.to)`. Now validated symmetrically, failing at the
producer while the caller's stack is live.

## Two findings disproved by measurement, not argument

- **Containment (shadow `9bc2e75b`)** claimed manifest paths were adopted
  verbatim with no repo-containment check. A probe fed the extractor an absolute
  outside path and a `../` escape alongside a legitimate file: only the
  legitimate one was extracted and the outside symbol never appeared.
  `admitFile`'s `escapedRepo` check already does the job. Dismissed.
- **Atomic-write (R10 MEDIUM)** wanted tmp+rename. There is no concurrent
  reader (the path is first published into the child's argv *after* the
  synchronous write returns) and no previous version to preserve (`wx` into a
  directory created moments earlier). GPT ruled `overrule` → DISMISSED.
- **Gemini's final LOW (v4)** described a `cleanup` closure with
  `unlinkSync`/`rmdirSync` that does not exist; the code already did what it
  recommended. Verified against source and dismissed.

## Deliberately left open

- **`buildTimeoutRecovery` zero-symbol files (HIGH, deferred → debt).**
  `recoveredTouchedSet` derives from `finalSymbols.map(s => s.filePath)`, so a
  successfully-extracted file declaring zero symbols is missed by recovery
  bookkeeping. `git diff` confirms this diff never touched it; the manifest
  transport decides *which files are handed to extract*, this is *post-extraction
  bookkeeping* — no call path between them. Fixing it properly needs verification
  against a real timed-out full refresh. Captured to `.audit/tech-debt.json`.
- **Audit-coverage gap (shadow, accepted, 3 rounds running).**
  `duplication-detector.mjs` was in `--changed`/`--files` every round and never
  appeared in any round's `code_files` — the auditor never read the second
  producer's changed body. Compensating evidence: it was verified here manually,
  end-to-end through a real subprocess spawn. The gap is in the audit tool, not
  the change.

## Regression locks

Both fixes are backend/CLI, so a unit test **is** the lock (per `/ship`'s own
rule, not `/ux-lock` — there is no DOM to drive). Recorded via `lock-with-test`:

| Finding | Lock |
|---|---|
| Temporary-file TOCTOU | `tests/refresh-subprocess-recovery.test.mjs` |
| Argument parsing correctness | `tests/extract-cli-contract.test.mjs` |

Every guard was proven red-then-green by reverting the fix alone and reading the
failure text. One of those controls was itself defective — reverting the leak fix
left the `try/catch` in place, so the suite stayed green and the "control" proved
nothing; it was redone reverting both halves before the red was trusted. That is
the instrument-first rule catching its own instrument.

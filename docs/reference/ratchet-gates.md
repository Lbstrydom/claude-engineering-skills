# Drift-only ratchet gates — the stdout drain and the file-size ratchet

**What it is**: the measurements and fine print behind two gates AGENTS.md states
as one-paragraph rules, both built in `scripts/knip-gate.mjs`'s shape (a committed
baseline, a non-zero exit only for drift, shrinks fail too):

| Gate | Rule in one line | Enforcer | Baseline |
|---|---|---|---|
| `npm run stdout:flush:gate` | an exit that stdout can reach must drain first (`await finishAndExit(code)`) | [`scripts/check-stdout-flush.mjs`](../../scripts/check-stdout-flush.mjs) | `.stdout-flush-baseline.json` |
| `npm run size:ratchet:gate` | oversized `scripts/**` files may not grow | [`scripts/file-size-ratchet.mjs`](../../scripts/file-size-ratchet.mjs) | `.file-size-baseline.json` |

**When you need it**: adding a CLI exit after a stdout write, re-baselining either
gate, or deciding whether a flagged site is a real finding.

**Why it lives here**: AGENTS.md is loaded every session and enforced at 92,000
characters (`npm run context:check`); depth belongs in `docs/` behind a short
stub. The passages below were relocated from AGENTS.md on 2026-10-03 **verbatim
apart from link paths** — nothing was lost. The authoritative detail also lives
in each enforcer's `@fileoverview` header and in
[stdout-flush-drain-gate.md](../plans/stdout-flush-drain-gate.md).

---

## An exit that stdout can reach must drain first

On Windows a piped `process.stdout` is asynchronous — `npm run x`, `x | tee` and
every CI capture are pipes — so `process.exit()` **discards whatever has not
flushed**. Use **`await finishAndExit(code)`**
([cli-io.mjs](../../scripts/lib/cli-io.mjs)) after writing to stdout. In a
**synchronous** function it cannot be awaited: hand the decision to the async
caller, and never fire `void finishAndExit(code)` and fall through — that returns
immediately and the exit still truncates.

`npm run stdout:flush:gate` ratchets the population drift-only (growth AND
unrecorded shrink fail); `--report` for the triaged census, **221 sites at
2026-09-04, 108 carrying a JSON envelope a caller parses** — where a truncation
is a parse error blamed on the wrong thing, not merely a lost tail.

**Deliberate non-findings**: a `stderr` write before an exit, and the
`--selfcheck-relocation` smoke contract's exact two-statement body.

Plan: [stdout-flush-drain-gate.md](../plans/stdout-flush-drain-gate.md).

## Oversized files may not grow

`npm run size:ratchet:gate` ratchets every `scripts/**` file already over 1000
lines against `.file-size-baseline.json`, drift-only in knip-gate's shape. **A
shrink fails too** — asking you to re-baseline — because a baseline pinned at the
historical high-water mark lets a file grow back unchallenged.

**The measurement that motivated it.** Over the 60 days to 2026-09-04, two
decompositions removed 3,652 lines and were outpaced by 4,551 lines of unmanaged
growth across 11 other files.

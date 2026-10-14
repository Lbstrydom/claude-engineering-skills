# Drift-only ratchet gates — the stdout drain and the two size ratchets

**What it is**: the measurements and fine print behind three gates AGENTS.md states
as one-paragraph rules, all built in `scripts/knip-gate.mjs`'s shape (a committed
baseline, a non-zero exit only for drift, shrinks fail too):

| Gate | Rule in one line | Enforcer | Baseline |
|---|---|---|---|
| `npm run stdout:flush:gate` | an exit that stdout can reach must drain first (`await finishAndExit(code)`) | [`scripts/check-stdout-flush.mjs`](../../scripts/check-stdout-flush.mjs) | `.stdout-flush-baseline.json` |
| `npm run size:ratchet:gate` | oversized `scripts/**` files may not grow | [`scripts/file-size-ratchet.mjs`](../../scripts/file-size-ratchet.mjs) | `.file-size-baseline.json` |
| `npm run skills:size:gate` | skill markdown may not grow | [`scripts/skill-size-ratchet.mjs`](../../scripts/skill-size-ratchet.mjs) | `.skill-size-baseline.json` |

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

## Skill markdown may not grow

`npm run skills:size:gate` ratchets the size, in **characters** of the LF-canonical
text, of every `*.md` under `skills/` plus the canonical
`docs/audit/shared-references/`, against `.skill-size-baseline.json`. It shares its
decision core with the file-size ratchet ([size-ratchet.mjs](../../scripts/lib/size-ratchet.mjs)).
The generated copies of the shared references (`findSyncTargets()`'s targets) and
`.claude/skills/**` are never governed, and a symbolic link anywhere in a governed
tree fails the run.

**The hard ceiling is the limit itself.** 12,000 chars is the documented ≤3K-token
SKILL.md target at 4 chars/token. A file at or over it is baselined and may not grow
(beyond a 200-char tolerance); a file under it is not baselined, so crossing it reads
`NEW>LIMIT`. No absolute cap is possible: the census below fails the gate on its first
push.

**The measurement that motivated it** (2026-10-14, `wc -c` at 8561d31f): 13 of 17
SKILL.md files over 12,000 chars (`ship` 69,993; `persona-test` 59,449; `audit-code`
57,024; `cycle` 47,804; `click-test` 45,355), `skills/fleet/references/coordination.md`
27,911 after growing twice that day. The SKILL.md ≤3K-token target had been prose
nothing enforced.

**Remedy for a failure:** move detail into `references/<topic>.md` (progressive
disclosure, [skill-reference-format.md](skill-reference-format.md)); do not raise the
baseline. After a trim, lock it in with
`npm run skills:size:gate -- --update-baseline` (ratchets down only).

Plan: [skill-markdown-size-ratchet.md](../plans/skill-markdown-size-ratchet.md).

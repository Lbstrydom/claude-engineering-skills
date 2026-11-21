# Plan: fleet field feedback, cluster 1 — hydrate circularity and `--help` read-only (consumer feedback 2026-11-21)
- **Date**: 2026-11-21
- **Status**: In progress — implemented on branch claude/fleet-field-feedback-54e8b7, awaiting audit
- **Author**: Claude + Louis
- **Scope**: backend (Node CLIs, `scripts/**`). Stack `js-ts`.
- **Target domain(s)**: `fleet`, `skills`

## 1. Context Summary

A work consumer sent nine pieces of fleet feedback. Cluster 1 is the two that are
plain bugs against rules AGENTS.md already states.

**#3 `skills:hydrate` fails in a fresh consumer worktree (`MODULE_NOT_FOUND`).**
The consumer's `skills:hydrate` npm script lived inside the gitignored
`scripts/.claude-skills/` tree it is meant to copy. `git worktree add` never
populates ignored paths, so in a fresh linked worktree the remedy dies on the
very thing it remedies. This is AGENTS.md "seven shapes" #4. The existing gate
(`checkMarkerRemedies`) asked only whether the named script EXISTS in
`package.json`; it existed, so the gate was green throughout. The canonical
one-liner (`CONSUMER_HYDRATE_NPM_SCRIPT`) is already self-contained, so the
defect is the consumer's own spelling, and the gap is that nothing checks it.

**#8 `arch-intent-bootstrap.mjs --help` RAN the bootstrap.** The CLI parsed
`process.argv` as a bare `Set`, recognised neither `--help` nor unknown flags, and
did its real work. Same hole as `symbol-index/refresh.mjs` dropping `--dry-run`
(the origin of `assertKnownFlags`). The question "which other CLIs have it" was
unasked.

## 2. Design

### 2.1 #3 — a present remedy must also be runnable

`checkMarkerRemedies` additionally rejects a remedy whose body EXECUTES a file
under `scripts/.claude-skills/` (`node [--opts] scripts/.claude-skills/…`, with or without quotes, `./`, `&&`
chains or backslashes) or LOADS one from `node -e` (`require('…/.claude-skills/…')`,
`import(…)`). A directory merely NAMED inside `node -e "…"` (the canonical
one-liner's `const dir='scripts/.claude-skills'`) is neither, and must not match. Result gains `circular: string[]`; `ok` requires it
empty. Surfaced by `check-worktree-preflight` (`wtpf/remedy-circular`) and the
doctor probe `hydration/remedy-missing` (the one a consumer actually runs, since
the gate reads THIS repo's `package.json`).

*Band-aid considered:* document "don't put it in the tree". *Over-built
considered:* have the sync write the consumer's `package.json`. Rejected: the sync
does not own a consumer's `package.json`, and the doctor already reads it.

### 2.2 #8 — `--help` is read-only, measured and enforced

Two halves, because each alone missed the original bug:

1. **Dynamic** (`lib/help-probe/`). Every top-level `scripts/*.mjs`, EVERY
   nested `scripts/<subsystem>/*.mjs` (derived from the filesystem, so a new nested
   CLI is covered the day it lands) and the `lib/` members of `CLI_SMOKE_SET` run with `--help` under an `--import` preload that
   RECORDS and BLOCKS filesystem writes, network (`net`, `dns`, `http(s)`,
   `fetch`) and any spawn other than `node` and read-only `git`. Blocking makes the
   census itself harmless. `NODE_OPTIONS` carries the preload into child `node`.
   Running in this tree missed `arch-intent-bootstrap` (it writes only when the
   live doc is absent), which is why the second half exists.
2. **Static** (`hasHelpContract`). A CLI must handle `--help` or refuse unknown
   flags (`assertKnownFlags`/`ArgvError`/`parseArgs`/the guard below), else
   `--help` runs the tool.

**Fix.** `lib/help-guard-run.mjs` as each CLI's FIRST import (same line as its
existing first import, so no line count moves and the `scripts/**` size ratchet
is untouched): if `--help` precedes any `--`, print the file's own header
`Usage:` block (no second copy to drift), write synchronously, `process.exit(0)`.
A function called after the imports is too late — `openai-audit`, `gemini-review`
and others hit the network while their imports load — and an async stdout write
lets later imports keep evaluating until its callback fires. 44 CLIs got the
import; `arch-intent-bootstrap` got an explicit `--help` plus `assertKnownFlags`.

**Stated limits (round-1 audit, H1/H4/H5/M1).** The probe is an instrument for a
census, not a security sandbox: it blocks the common entry points (`fs` write
family incl. promises, `open` with a writing flag, `net`/`dns`/`http(s)`/`fetch`,
non-read-only spawns) and poisons the env, but a CLI that deliberately strips
`NODE_OPTIONS` or uses an unpatched native route is outside it. The static
contract is a necessary backstop, not proof (an `assertKnownFlags` call could sit
after a side effect); the dynamic half is what tests reachability, and the guard
is the first import so nothing precedes it. `--help` short-circuits ahead of the
other flags by convention (`--bogus --help` prints usage and runs nothing), so
unknown-flag refusal applies to invocations that would actually run. The usage
text is the header `Usage:` block, else the first `@fileoverview` paragraph, else
a `see the header of scripts/<file>` line — never empty, never an error.

**Gate shape.** Absolute, NOT baselined: the census found 54 findings including
`prepush-check --help` creating a git worktree and paid-provider calls from
`openai-audit`/`anthropic-ping`/`gemini-review`; a baseline holding those would
hold the bug. A `hang` IS gated (60 s timeout): a CLI that has not exited has not been shown read-only, and a green over it would read incomplete coverage as success. `shared.mjs`
(a barrel with no main) is exempt by a written reason.

## 3. Acceptance criteria

- A1. `checkMarkerRemedies` fails `node scripts/.claude-skills/skills-hydrate.mjs`
  (and `./`, `&&`, backslash spellings) as `circular`, and passes the canonical
  one-liner and `node scripts/skills-hydrate.mjs`.
- A2. `node scripts/arch-intent-bootstrap.mjs --help` prints usage, exits 0 and
  attempts no write/network/spawn; `--bogus` exits 2.
- A3. The probe flags a fixture that writes, a fixture using named fs imports, and
  a fixture that fetches/pushes, blocks the write, and passes a clean fixture.
- A4. `npm run help:readonly:gate` reports 0 offenders (including hangs) across every top-level, nested and `lib/` smoke-set CLI, and fails
  when a CLI without a contract is added.
- A6. A real `package.json` on disk (no injected reader) with the circular spelling fails `checkMarkerRemedies`; with the canonical one-liner it passes.
- A5. Registration invariants hold: CLI catalog entry, archive-lane
  classification, knip ignore for the preload (loaded by path, never imported).

## 4. Out of scope (stays with other clusters)

Fleet turn/claim hygiene (#1, #2, #9), robustness (#4, #6, #7), ready vs train
tier (#5).

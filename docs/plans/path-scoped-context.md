# Plan: Path-scoped context — measure per host, then move path-specific tripwires out of AGENTS.md
- **Date**: 2026-11-23
- **Status**: Complete — pilot shipped (Postgres store + consumer sync); further topics NOT SCHEDULED
- **Author**: Claude + Louis
- **Scope**: backend (stack `js-ts`; docs plus one test: `AGENTS.md`, two `.claude/rules/` files, their two `.github/instructions/` twins, `tests/path-scoped-instructions-twins.test.mjs`)
- **Builds on**: `docs/plans/agents-md-kernel-shrink.md` (stages 1-4), the 2026-11-23 best-practice review (recurring context is the cost)

Neighbourhood considered: not consulted. AGENTS.md "When NOT to consult" exempts doc-only and test-only changes; the one
new function (`twinProblems`) is a test helper inside the test file.

---

## 1. Measurement (before → after)

Command for every `measured` Claude Code figure: `claude -p "/context all"` (Claude Code 2.1.318, run with
`MSYS_NO_PATHCONV=1` from Git Bash, or the leading `/` is rewritten to a path), reading the **Memory files** and
**Skills** tables. `derived` figures are chars ÷ 4 on the same file. Copilot cannot be measured here (no Copilot CLI on
this machine; VS Code needs a human), so its rows are `derived` from the same bytes plus the documented load rules.

| Host | What loads every session | Before | After | Label |
|---|---|---|---|---|
| Claude Code, CES | `CLAUDE.md` 921 + `@AGENTS.md` + user `CLAUDE.md` 505 + `MEMORY.md` 6.0k = **memory files** | 33.1k | 31.4k | measured |
| ↳ of which `AGENTS.md` | 63007 → 58894 chars (+ the new 4-line preamble pointer) | 25.6k | 24.0k | measured |
| ↳ project skill listing (15 skills) | `.claude/skills/*/SKILL.md` name + description | 4.2k | 4.2k | measured (sum of `~` rows) |
| ↳ hooks | SessionStart hooks print nothing locally; `arch-memory-check.sh` adds 1474 chars (~370 tok) per feature-shaped prompt, 0 otherwise | ~0 | ~0 | measured (bytes), derived (tokens) |
| ↳ on demand, when a matching file is read/edited | `.claude/rules/postgres-store.md` 4999 chars, `consumer-sync.md` 2628 chars | 0 | +1.2k / +0.7k | derived |
| VS Code Copilot harness, CES | `AGENTS.md` (not `CLAUDE.md`; no `.github/copilot-instructions.md` exists) + `.claude/skills` listing | ~29.8k | ~28.2k | derived |
| ↳ on demand | `.github/instructions/*.instructions.md` by `applyTo` (same bytes as the rules) | 0 | +1.2k / +0.7k | expected (doc) |
| Claude Code, wine (`5a952493d`) | `CLAUDE.md` 177 + `AGENTS.md` 32.9k + user 505 + `MEMORY.md` 7.8k = 41.3k; project skills 4.8k | 41.3k | 41.3k | measured (unchanged: this PR ships nothing to consumers) |
| VS Code Copilot, wine | `AGENTS.md` 32.9k + `.github/copilot-instructions.md` 2503 chars (~0.6k) + skills 4.8k | ~38.3k | ~38.3k | derived |

The whole-session number Claude Code reports (62.6k at session start in CES) is dominated by the system prompt and
tool schemas (~17k) that no repo file controls. `AGENTS.md` is the largest repo-controlled share, then `MEMORY.md`.

## 2. Host-by-host decision (verified 2026-11-23)

| Host | Path-scoped mechanism | Reads `.claude/rules`? | Evidence |
|---|---|---|---|
| Claude Code | `.claude/rules/*.md` with `paths:`; loads after a Read/Write/Edit (or a `cat`) of a matching file | yes | docs `code.claude.com/docs/en/memory`; **live**: canary rule loaded after reading `scripts/lib/db/client.mjs`, absent after `scripts/lib/cli-io.mjs`; same 3×2 matrix re-run on the real rules (`db/rpc.mjs`, `sync-path-map.mjs`, `cli-io.mjs`) |
| VS Code Copilot harness | `.github/instructions/**/*.instructions.md` with `applyTo:`, or nested `AGENTS.md` | **no** | `code.visualstudio.com/docs/agents/reference/custom-instructions-reference`; not run live |
| VS Code Local harness (deprecated Feb 2027) | both of the above | yes | same reference |
| Codex | nested `AGENTS.md` only along the path to the session's cwd | no | same reference |
| Cursor / Windsurf / Gemini CLI | not verified | — | AGENTS.md's stub names each tripwire and the file to open |

Consequences:

1. **A tripwire moved only to `.claude/rules` is lost for Copilot**, so each topic is a pair of byte-identical files that
   carry both `paths:` (Claude Code; any other key is ignored) and `applyTo:` (Copilot). The two folders sit at the
   same depth, so the relative links resolve identically. `tests/path-scoped-instructions-twins.test.mjs` fails on a
   missing twin, differing bytes, an unscoped rule, or glob lists that disagree (red-then-green on the real repo).
2. **An `@import` inside a path-scoped rule is NOT lazy.** Measured: a rule whose body was `@../../docs/x.md` put `x.md`'s
   canary into the session-start project instructions, before any file was read. One body imported from two thin
   entry files would therefore load everywhere; the copy is the smallest thing that keeps the scoping.
3. **Nested `AGENTS.md` (+ a `CLAUDE.md` importing it) was rejected for these topics**: the store tripwires span
   `scripts/lib/db/`, `scripts/lib/store/`, `supabase/migrations/` and four single files, which a directory cannot name.
   It stays the better choice for a topic that is one directory, since Codex and Copilot both read it.
4. **Hosts with no path scoping keep a cue, not the text.** Each AGENTS.md stub lists every moved tripwire in one line
   and names the file to open before editing those paths.

## 3. What moved, and what was deliberately left resident

Moved (text verbatim, links re-rooted): from §Postgres-Parity Store — Connect/pooler, jsonb write seam, `durableWrite`,
schema-error-not-empty, disposable allowlist, RPC bound at the caller; from §Consumer-repo layout — Consumer divergence,
Sync mechanics (the `sync-path-map.mjs` oracle), the consumer package manager.

Left resident, and why:

- Every gate-quoted sentence (`statedIn: AGENTS.md`): `parity:check-coupling`, `emit:exit:gate`, the Seven shapes'
  three gates, `upstream:coverage:gate`. All 28 still resolve (`npm run gates:check`).
- **Never use the dashboard as the routine migration path** — an agent can apply a migration through the Supabase MCP
  without touching any file, so no path filter would fire.
- **`audit_runs.commit_sha` is HEAD at capture time** — it bites ad-hoc SQL, which touches no file either.
- The pooler rule keeps a resident copy in the §Environment Variables `AUDIT_DB_URL` row.
- Upstream-owned / not-on-one-store / file-the-report / blocked / ownership-oracle / CLI smoke contract: they apply
  while investigating a consumer or writing any CLI, not while editing a path set.

## 4. Knock-on: the checklist pilot's kernel estimate

`kernelEstimate` (`scripts/lib/checklist/pilot.mjs`) anchors each checklist entry to an AGENTS.md sentence. Five of
those sentences moved here (`disposable-db-allowlist`, `durable-write-registration`, `jsonb-write-seam`,
`schema-error-is-not-empty-result`, `sync-inventory-single-owner`), so it now reports them `unanchored`. `pilot.mjs` is a
**hash-frozen instrument** (`scripts/lib/checklist/frozen.mjs`, `--verify-frozen`), so it is deliberately NOT edited:
re-freezing an experiment's instrument is not this change's call. `tests/checklist-gen-pilot.test.mjs` instead asserts
that the unanchored set is exactly those five and that each anchor is in `.claude/rules/` and absent from AGENTS.md;
any other unanchored entry still fails. The checklist entries themselves (`.audit-loop/checklist.json`) are untouched
and still fire on a matching diff.

## 5. Not done (scope boundary)

No gate deleted or relaxed; no ratchet, no dashboard. Further candidates for the same mechanism, unscheduled:
§Sensitive paths + VCS contract (`sensitive-paths.mjs`, `vcs.mjs`, `subprocess.mjs`), §Azure AI Foundry Work Profile,
the non-quoted half of §Anthropic Backend Routing. Copilot's `applyTo` loading should be confirmed in the
`docs/runbooks/vscode-host-smoke.md` run (a human step).

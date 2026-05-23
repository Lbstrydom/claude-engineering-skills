# Plan: Shared cloud-config file for consumer repos

- **Date**: 2026-05-23
- **Status**: Complete
- **Author**: Claude + Louis
- **Scope**: backend
- **Stack**: js-ts
- **Target domain(s)**: `cross-skill-bridge`, `install`, `scripts`, `shared-lib`
- ⚠ **Cross-domain work** — touches 4 domains but each change is small and self-contained: one loader extension (shared-lib), one new CLI (scripts), one end-of-sync trigger (install), one message edit (shared-lib/store), one warn-rewrite (install). No new modules under more than one domain.

## 1. Context Summary

Today every consumer repo (ai-organiser, wine-cellar-app, future installs) needs `AUDIT_DB_URL` set in its own `.env` to participate in the shared cloud learning store. The DSN is the **same value across all consumers** — a single Supabase project (`uahjjdelnnpfmaqjrwoz`) — yet the operator is currently expected to remember to copy-paste it into each new repo's `.env`. When they don't, the failure is silent: [`scripts/lib/store/repo.mjs::initLearningStore`](scripts/lib/store/repo.mjs#L48-L50) prints `[learning] Cloud store not configured — using local mode` and downstream features (planner's arch-memory consultation, audit-loop's cloud learning, persona-test correlations) silently no-op. The operator finds out months later when they realise their planning sessions never had real similarity-search context.

The new convention introduces a per-user shared file at `~/.audit-loop.env` that any consumer can inherit from automatically, with three trigger surfaces that ensure the operator never silently misses it: (1) `setup:cloud` CLI for explicit one-time setup, (2) end-of-`sync` auto-prompt for create/update, (3) actionable recovery command in the cloud-disabled fallback message. The pattern is locked in user-feedback memory as **[[first-deploy-plus-update-from-source-pattern]]** — applies whenever we design cross-repo shared state.

### Neighbourhood considered

Architectural-memory consultation returned the cluster around the points we'll touch — strong reuse signals from existing code:

| Symbol | File | Domain | Recommendation | How we use it |
|---|---|---|---|---|
| `discoverDotenv` | [`scripts/lib/config.mjs:21-55`](scripts/lib/config.mjs#L21-L55) | shared-lib | **review** (sim 0.83) — extend, not replace. Current behaviour walks cwd → git root for `.env`; we add a second `dotenv.config()` call after for `~/.audit-loop.env` as fallback. |
| `loadEnv` | [`scripts/check-setup.mjs:42-57`](scripts/check-setup.mjs#L42-L57) | install | **reuse** — straightforward `=`-delimited parser with comment-skip + quote-strip. Move to a shared lib so both `check-setup.mjs` and `setup-cloud.mjs` can call it. |
| Sibling-dir scan (bash) | [`scripts/install-prepush-hook.mjs:74-82`](scripts/install-prepush-hook.mjs#L74-L82) | scripts | **extend pattern** — port the bash sentinel `dir contains BOTH scripts/openai-audit.mjs AND scripts/install-prepush-hook.mjs` into JS for `setup-cloud.mjs`'s source-repo discovery. |
| `main` end-of-sync block | [`scripts/sync-to-repos.mjs:411-616`](scripts/sync-to-repos.mjs#L411-L616) | install | **extend** — insertion point for D2b trigger sits right after the Summary block, before `process.exit`. |
| `initLearningStore` cloud-disabled message | [`scripts/lib/store/repo.mjs:48-50`](scripts/lib/store/repo.mjs#L48-L50) | shared-lib | **extend** — append the actionable recovery command. The canonical message location across the codebase. |

No prior security incidents matched these paths. `cross-skill-bridge` and `install` domain crossings are minimal — `cross-skill.mjs` isn't actually touched (the cloud-disabled message lives in `repo.mjs`); `install` only sees the sync.mjs end-of-flow trigger.

## 2. Proposed Architecture

Plan flag: `--no-diagram`. The four moving parts are simple enough that a 2D diagram would add noise:

```
┌────────────────────────────────────────────────────────────────────┐
│                       OPERATOR'S MACHINE                            │
│                                                                      │
│   ~/.audit-loop.env  ←─── shared cross-repo secrets (A)             │
│       │                                                              │
│       │ autoloaded as fallback (D3)                                 │
│       ▼                                                              │
│   ┌──────────────────────┐         ┌──────────────────────────┐    │
│   │  source-repo .env    │  ───┐   │  consumer-repo .env      │    │
│   │  (canonical DSN)     │     │   │  (repo-specific only)    │    │
│   └──────────────────────┘     │   └──────────────────────────┘    │
│              │                  │              │                     │
│              ▼                  │              ▼                     │
│   ┌──────────────────────┐     │   ┌──────────────────────────┐    │
│   │ sync-to-repos.mjs    │ ────┤   │ config.mjs (loader)      │    │
│   │  ────────────────    │     │   │  cwd .env (wins)         │    │
│   │  END-OF-SYNC (D2b):  │     │   │  + ~/.audit-loop.env     │    │
│   │  • file absent?      │     │   │    (fallback, silent)    │    │
│   │    prompt Create     │     │   └──────────────────────────┘    │
│   │  • diverges?         │     │              │                     │
│   │    prompt Update     │     │              ▼                     │
│   │    (shows delta)     │     │   ┌──────────────────────────┐    │
│   │  • in sync? silent   │     │   │ initLearningStore        │    │
│   └──────────────────────┘     │   │  cloud:false →           │    │
│              │                  │   │  "run npm run            │    │
│              │                  │   │   setup:cloud …"         │    │
│              ▼                  │   │  (consumer-side nudge)   │    │
│   ┌──────────────────────┐     │   └──────────────────────────┘    │
│   │  setup-cloud.mjs     │ ◀───┤                                    │
│   │   ─────────────────  │     │                                    │
│   │   mode-a: file exists│     │                                    │
│   │     → list vars      │     │                                    │
│   │   mode-b: file absent│     │                                    │
│   │     → scan sibling   │     │                                    │
│   │       dirs for src   │     │                                    │
│   │     → prompt copy    │     │                                    │
│   │     → write 0600     │     │                                    │
│   └──────────────────────┘     │                                    │
│                                  │                                    │
│   D2a (explicit):                │   sync-to-repos.mjs also          │
│   `npm run setup:cloud` ◀────────┘   imports setup-cloud's helpers   │
│                                      for the D2b trigger              │
└────────────────────────────────────────────────────────────────────┘
```

### Key design decisions

1. **Shared file location: `~/.audit-loop.env`** (#3 Modularity, #5 SSoT). Top-level dotfile in `os.homedir()`; owned-namespace; per-USER not per-repo. Holds `AUDIT_DB_URL`, `AUDIT_DB_SSL_MODE`, and optionally the three LLM keys (`OPENAI_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`) — those are shared across all consumers, single rotation surface. Alternative considered (`~/.claude/audit-loop.env` under Claude Code's namespace) rejected — could clash with Claude Code's own state in that dir.

2. **Loader extends the existing `discoverDotenv` pattern** (#5 SSoT, #6 Open/Closed, #18 Backward-Compat). `scripts/lib/config.mjs` already does worktree-safe `.env` discovery via [`discoverDotenv`](scripts/lib/config.mjs#L21-L55). We add a second `dotenv.config()` call after the cwd `.env` load, pointing at `~/.audit-loop.env` with `override: false` (so cwd `.env` always wins). Three failure modes handled invisibly:
   - File absent → silent no-op (the whole point of invisible inheritance)
   - File present, unparseable → dotenv's own warning, no crash
   - File present, fully shadowed by cwd `.env` → loader still notes the file existed for telemetry, but no vars actually changed

3. **One-time stderr note on first load** (#19 Observability). When `~/.audit-loop.env` IS present AND set at least one variable that wouldn't otherwise be set, emit a single stderr line: `[config] loaded shared cloud config from ~/.audit-loop.env (sets: AUDIT_DB_URL, OPENAI_API_KEY)`. Module-state guard ensures one-line-per-process — not per-import. Operators see ONCE that inheritance happened; subsequent runs see nothing.

4. **Pure helpers live in `scripts/lib/shared-cloud-config.mjs` (shared-lib domain); `scripts/setup-cloud.mjs` is the thin CLI wrapper** (#3 Modularity, #11 Testability, addresses R1-audit H2 + R2-audit M2). The lib module has zero side-effects (no `process.exit`, no `console.*`, no prompts) — all I/O happens at the CLI boundary or in `sync-to-repos.mjs`. This is the project convention: importing a `scripts/` top-level mid-flow violates the lib/CLI separation.

   **Assessment vs action split** (addresses R2-audit M1): `assessSharedCloudConfig` is the pure analyser — returns the plan without executing it. `runSetupCloud` (in setup-cloud.mjs) is the CLI executor — calls assess, prompts, applies, renders human output. Sync trigger calls `assessSharedCloudConfig` directly and only renders/prompts on actionable outcomes — silent on `already_current`.

   The reconciliation flow has no mode-a/mode-b split — both invocations ALWAYS diff against source. Outcomes:
   - Source repo not resolvable → `misconfigured`, exit 4
   - Source resolvable, source `.env` has no `AUDIT_DB_URL` → `misconfigured` (R2-audit H2 fix — was wrongly succeeding as `already_current`), exit 4
   - Source resolvable, shared file in sync → `already_current`, exit 0 (silent in sync; one-line "in sync" in CLI)
   - Source resolvable, deltas present → prompt with explicit add/change/remove; on Y → `updated`/`created`, exit 0; on N → `user_skipped`, exit 0
   - Source `.env` malformed / unreadable → `fatal`, exit 1

   **Lib module exports** (`scripts/lib/shared-cloud-config.mjs`):
   - `assessSharedCloudConfig({sourceRepoDir, sharedPath, requireVars}) → {outcome, deltas, sharedPath, sourcePath, resolution} | null` — pure analyser
   - `resolveSourceRepo({explicitFlag, cwd}) → {path, source} | null` (H1)
   - `parseEnvText(text) → object` (delegates to `dotenv.parse`; M2)
   - `parseEnvFile(path) → object` (thin wrapper)
   - `serializeEnvValue(value) → string` (handles quoting/escaping for round-trip safety; R2-audit M4)
   - `diffSharedEnv({sharedPath, sourcePath, managedKeys}) → {add, change, remove, unchanged}` (H3)
   - `writeSharedEnv(path, managedVars, {mode}) → void` (atomicWriteFileSync; M3)
   - `resolveCloudConfig({localEnvPath, sharedEnvPath}) → {AUDIT_DB_URL, source: 'local'|'shared'|'unset', ...}` (M1)
   - `discoverLocalEnvPath(cwd) → string | null` — reuse of `config.mjs`'s walk-up + git-root pattern, extracted (R2-audit M3)
   - `sharedEnvPath(homedir) → string` — `path.join(homedir, '.audit-loop.env')`
   - `SHARED_VARS` + `REQUIRED_VARS` + `OUTCOMES` enum + `EXIT_CODE_FOR` mapper (M4)

   **CLI wrapper exports** (`scripts/setup-cloud.mjs`):
   - `runSetupCloud({prompt, dryRun, autoYes, sourceRepoDir, stdio, homedir, format}) → {outcome, exitCode, deltas, ...}` — calls assess, prompts, writes, renders
   - `main()` — argv parsing + `process.exit(result.exitCode)` (R2-audit H1 fix)

5. **D2b trigger lives at the END of `sync-to-repos.mjs::main`** (#19 Observability, [[first-deploy-plus-update-from-source-pattern]]). After the Summary block, before `process.exit`. Decision tree:
   - **No TTY OR `--no-prompt` flag OR `DRY_RUN`** → skip entirely (CI safety + dry-run hygiene)
   - **Shared file absent** AND source `.env` has `AUDIT_DB_URL` → prompt `"Create ~/.audit-loop.env from this repo's .env so consumer repos can inherit cloud config? (Y/n)"`. On Y, call `runSetupCloud({sourceRepoDir: SOURCE_ROOT, autoYes: true})`.
   - **Shared file exists** but `diffSharedEnv` returns non-empty deltas → prompt with the SPECIFIC delta lines: `"  - AUDIT_DB_URL host changed: aws-1-eu-west-2 → aws-1-us-east-1\n  Update ~/.audit-loop.env? (Y/n)"`. On Y, `writeSharedEnv` in place (preserve chmod).
   - **In sync** → silent no-op (don't spam "✓ shared config is current" on every sync — operator only wants to see actions).
   - Diff filtering: only show secrets that DIFFER (not "AUDIT_DB_URL present in both but identical"); mask passwords in the delta display.

6. **Consumer-side nudge in `initLearningStore`** (#19 Observability). Current message: `[learning] Cloud store not configured — using local mode`. New: `[learning] Cloud store not configured — using local mode. Run \`npm run setup:cloud\` from your claude-engineering-skills install to inherit shared config (or set AUDIT_DB_URL in this repo's .env directly).` Single line, still non-blocking. Operators who hit local-mode see the recovery path immediately.

7. **chmod 0600 on file creation** (#16 Error Handling). Best-effort. The file contains secrets; restrictive permissions are a defence-in-depth measure for shared-machine scenarios (rare for dev workstations, more relevant for CI runners or shared dev VMs). Wrapped in try/catch; on Windows where `chmod` is a no-op, emit a one-time advisory: `[setup:cloud] note: chmod is a no-op on Windows; file permissions inherit from %APPDATA%`. Doesn't fail the command.

8. **D2a `--yes` and `--dry-run` flags** (#11 Testability, #6 Open/Closed). `--yes` bypasses all prompts (CI use); `--dry-run` prints what WOULD happen and writes nothing. Both compose: `setup:cloud --yes --dry-run` is a useful "show me what auto-confirming would do" mode for the operator.

### Public-CLI contract change blast radius

| Surface | Today | Post-plan |
|---|---|---|
| `npm run sync` | Sync files; print summary; exit. | Same + interactive prompt at end (or silent skip if not TTY / `--no-prompt`). |
| `node scripts/setup-postgres.mjs --check-drift` etc. (any script importing config.mjs) | Reads cwd `.env` only. | Reads cwd `.env` THEN `~/.audit-loop.env` as fallback. Inherits without code change. |
| `npm run setup:cloud` (NEW) | n/a | New command. Idempotent. |
| `npm run setup:cloud --yes` (NEW) | n/a | Non-interactive mode for CI. |
| `npm run setup:cloud --dry-run` (NEW) | n/a | Print without writing. |
| `[learning] Cloud store not configured — using local mode` | Current message. | Extended with recovery command. |
| `check-setup.mjs` WARN line | `AUDIT_DB_URL not set — audit runs will be local-only` | When `~/.audit-loop.env` absent: `AUDIT_DB_URL not set; run \`npm run setup:cloud\` to inherit from your source-repo install`. When file exists but doesn't have AUDIT_DB_URL: existing message (file present but doesn't cover the var). |

## 3. Execution Model

**Are any planned operations dependent on others?** Yes, one chain at the consumer-first-use point:

```
operator runs `npm run sync` in source repo
  └─► (end of sync) trigger fires
       └─► reads `~/.audit-loop.env` state
            └─► if absent → calls runSetupCloud (writes file)
            └─► if diverges → prompts + writes
       └─► (next time) consumer repo `npm run anything-cloud-aware`
            └─► config.mjs autoloads `~/.audit-loop.env`
                 └─► `initLearningStore` sees AUDIT_DB_URL set → cloud:true
```

The chain is **interactive at one point** (the trigger prompt) and **passive everywhere else** (autoload + connection). No batched operations, no rollback semantics needed.

### Concurrency model

Single-operator-machine — no concurrency concerns. If two sync runs fire concurrently from different terminals (rare but possible), the second prompt sees the file the first wrote and either falls through to "in sync" or prompts to update. Filesystem-level atomic write (`fs.writeFileSync` on POSIX is single-syscall) prevents partial-write races; for the rename-into-place pattern we use `atomicWriteFileSync` from `file-io.mjs` (existing project helper) for crash-safety.

### Partial failure recovery

- Shared file partially written then crash → file is empty/corrupt, next setup-cloud or sync re-prompts to recreate. dotenv handles parse errors gracefully (logs + skips); no crash on bad file.
- Sibling-dir scan finds NO source repo (operator running setup-cloud from a brand-new install path with no audit-loop sibling) → print manual instructions: `"No source repo found. Either set CLAUDE_AUDIT_LOOP_DIR=<path> or write the file manually with: AUDIT_DB_URL=postgresql://..."`. Exit 0; operator has full info.
- Source repo discovered but has NO `.env` (rare — operator never set up source repo) → print: `"Found audit-loop at X but no .env — set up source repo first"`. Exit 1 (this is genuinely actionable, not a silent skip).

## 4. Engineering Principles Applied

| # | Principle | How it shows up |
|---|---|---|
| #1 | DRY | DSN lives in ONE place across all consumer repos (`~/.audit-loop.env`); rotation is a single edit + sync. |
| #3 | Modularity | `setup-cloud.mjs` exports helpers (`runSetupCloud`, `discoverSourceRepo`, `parseEnvFile`, `diffSharedEnv`, `writeSharedEnv`) that both the CLI and the sync trigger consume — no logic duplication. |
| #5 | SSoT | Shared env file is the SSoT for cross-repo secrets. Per-repo `.env` only carries repo-specific overrides. |
| #6 | Open/Closed | Adding a new shared variable (e.g., `MEMORY_HEALTH_RECURRENCE_RATE`) is one entry in `setup-cloud.mjs`'s `SHARED_VARS` list. The loader doesn't change. |
| #11 | Testability | All helpers accept injectable opts (`prompt: AsyncFunction`, `stdio: Stream`, `fs: Module`, `homedir: () => string`). Tests run against `mkdtemp` HOMEs with stub prompts; no real filesystem outside the temp tree. |
| #15 | Graceful Degradation | Shared file absent → silent no-op (planner falls back to local-mode). Non-TTY sync skips the prompt. Operator without `chmod` (Windows) gets an advisory note, not a failure. |
| #16 | Error Handling | dotenv parse errors are caught and logged. `chmod 0600` failure is caught and reported as advisory. Source-repo-not-found case is explicit, not implicit. |
| #18 | Backward Compat | Per-repo `.env` STILL WINS over the shared file (`override: false`). Every existing consumer that has `AUDIT_DB_URL` set locally continues to work identically. Operators who never run `setup:cloud` see no change. |
| #19 | Observability | Three nudge surfaces ensure operators never silently miss setup: explicit command, sync-time prompt, fallback-message recovery command. One-time stderr note on first inheritance confirms it happened. |
| #20 | Long-Term Flexibility | Same pattern reusable for future shared state — Anthropic API keys today, possibly `PERSONA_TEST_SUPABASE_URL` (separate cloud) tomorrow. The `SHARED_VARS` array is the extension point. |

## 5. Long-Term Sustainability

### Assumptions encoded

- **Operators have one shared cloud project across all consumers.** True today (Supabase project `uahjjdelnnpfmaqjrwoz`). If we ever split to per-environment clouds (`AUDIT_DB_URL_PROD` vs `AUDIT_DB_URL_DEV`), the shared file holds both and each repo's `.env` picks via a separate `AUDIT_DB_URL=$PROD` indirection — already supported by dotenv var-expansion in v17+. Plan stays valid.
- **`os.homedir()` is writable.** Universal except for sandboxed/locked-down environments (Docker without volume, some CI runners). Those environments don't run `setup:cloud` (CI uses `--yes` writing to a pre-mounted location, or sets `AUDIT_DB_URL` via standard env-injection). Documented in the §6 setup-cloud header.
- **Operators have at most one source repo per machine.** The sibling-dir scan finds ONE; if there are multiple (rare — a contributor might have both an upstream + their fork), it picks the first match by directory iteration order. Documented escape hatch: `CLAUDE_AUDIT_LOOP_DIR=<path>` env override (same as install-prepush-hook).

### What we WON'T do

- **Auto-write the shared file on `git clone`.** Public-repo safety; would auto-leak cloud config into repos that shouldn't have it.
- **Add a sync-time non-interactive `--auto-create` flag.** Hand-rolled `--yes` flag on setup-cloud is the explicit non-interactive path; binding sync to "always auto-create" removes operator agency on a write-to-HOME action.
- **Encrypt the file at rest.** Same threat model as `.env` — chmod 0600 is the project convention. If the threat model ever requires encryption, that's an OS-level keychain integration, not a loader-level decision.
- **Sync the file ACROSS machines** (e.g., commit `~/.audit-loop.env.example`). The whole point is per-USER not per-machine; multi-machine operators run setup-cloud on each. Trade-off accepted.
- **Validate that the DSN actually connects** before writing. Setup-cloud writes from source `.env` to shared file; the DSN's validity is already proven by the source repo's prior arch:refresh runs. Re-validating would add cloud round-trips for no signal.

### Migration path if this outgrows v1

If multi-environment becomes a real need: add `--profile <name>` flag to setup-cloud; shared file becomes `[profile_name]` INI-shaped instead of flat KEY=VALUE. Loader picks profile via `AUDIT_PROFILE` env. Existing flat-form files work unchanged (treated as the `default` profile). No rewrite, just an additive evolution.

## 6. File-Level Plan

### EDIT [`scripts/lib/config.mjs`](scripts/lib/config.mjs)

Extend the existing `discoverDotenv` + `dotenv.config` block to also load `~/.audit-loop.env` as fallback.

```js
// ── .env Discovery (worktree-safe) ──────────────────────────────────────────
// (existing discoverDotenv() unchanged — lines 21-55)

// Run discovery then load .env (uses dotenv package directly, not 'dotenv/config')
discoverDotenv();
import dotenv from 'dotenv';

// Layer 1: cwd-discovered .env wins (existing behaviour, preserved)
dotenv.config({ path: process.env.DOTENV_CONFIG_PATH || '.env', quiet: true });

// Layer 2: ~/.audit-loop.env as fallback — only fills vars not set above.
// Silent when absent. One-time stderr note when present + set ≥1 var.
import os from 'node:os';
const SHARED_CLOUD_ENV = path.join(os.homedir(), '.audit-loop.env');
if (fs.existsSync(SHARED_CLOUD_ENV)) {
  const before = new Set(Object.keys(process.env));
  dotenv.config({ path: SHARED_CLOUD_ENV, override: false, quiet: true });
  const added = Object.keys(process.env).filter(k => !before.has(k));
  if (added.length > 0 && !process.env._AUDIT_LOOP_SHARED_LOADED) {
    process.stderr.write(`  [config] loaded shared cloud config from ~/.audit-loop.env (sets: ${added.join(', ')})\n`);
    process.env._AUDIT_LOOP_SHARED_LOADED = '1';  // process-state guard so subprocesses don't re-log
  }
}
```

The `_AUDIT_LOOP_SHARED_LOADED` env-var sentinel propagates to spawned subprocesses (since env inherits), preventing each child process from re-logging the same notice. Module-state would only suppress within a single process.

### NEW [`scripts/lib/shared-cloud-config.mjs`](scripts/lib/shared-cloud-config.mjs)

Pure lib module — zero side-effects (no `process.exit`, no `console.*`, no prompts). Holds all reusable helpers + the assessment layer.

```js
/**
 * @fileoverview Pure helpers for the cross-repo shared-cloud-config feature.
 * No I/O side-effects beyond fs reads + atomic writes; all process.exit /
 * console / prompt happens at the CLI boundary (scripts/setup-cloud.mjs)
 * or the sync trigger (scripts/sync-to-repos.mjs).
 *
 * Plan: docs/plans/shared-cloud-config.md (R2-audit M2: split CLI/lib).
 *
 * @module scripts/lib/shared-cloud-config
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import dotenv from 'dotenv';
import { atomicWriteFileSync } from './file-io.mjs';

// Vars that are SHARED across consumer repos (single rotation surface).
// Adding a new shared var: append here. Loader doesn't change.
export const SHARED_VARS = Object.freeze([
  'AUDIT_DB_URL', 'AUDIT_DB_SSL_MODE',
  'OPENAI_API_KEY', 'GEMINI_API_KEY', 'ANTHROPIC_API_KEY',
]);

// R2-audit H2: REQUIRED_VARS is a strict subset — source .env without these
// can't usefully populate the shared file. Currently AUDIT_DB_URL only
// (LLM keys + SSL_MODE are optional). The assessor reports `misconfigured`
// when any REQUIRED_VAR is missing from source.
export const REQUIRED_VARS = Object.freeze(['AUDIT_DB_URL']);

export function sharedEnvPath(homedir = os.homedir()) {
  return path.join(homedir, '.audit-loop.env');
}

// R1-audit M2: standardize on dotenv.parse for ALL .env parsing.
export function parseEnvText(text) {
  return dotenv.parse(text);
}
export function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  return parseEnvText(fs.readFileSync(filePath, 'utf-8'));
}

// R2-audit M4: round-trip-safe serializer. dotenv.parse handles quoted,
// escaped, multi-line values; raw `KEY=value` writes don't round-trip
// when the value contains whitespace, quotes, $, #, newlines, etc. For
// current SHARED_VARS (URL + opaque tokens) this is theoretical, but
// the writer must be robust for future additions.
export function serializeEnvValue(value) {
  if (typeof value !== 'string') value = String(value ?? '');
  // Plain values that don't need quoting: alphanumerics, common URL chars,
  // base64, no whitespace/quotes/escape-significant chars.
  if (/^[A-Za-z0-9._:/?=&@%+~-]*$/.test(value)) return value;
  // Anything else: double-quote, escape backslashes + double-quotes + newlines.
  // dotenv expands \n in double-quoted strings, so literal newlines round-trip.
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
  return `"${escaped}"`;
}

// R1-audit M4: stable outcome model with explicit exit-code map.
// Replaces the ambiguous `{ok: true|false}` shape that conflated
// "informational no-op" with "fatal error".
export const OUTCOMES = Object.freeze({
  CREATED:         'created',          // shared file didn't exist; we wrote it
  UPDATED:         'updated',          // file existed; we applied add/change/remove
  ALREADY_CURRENT: 'already_current',  // file matches source; nothing to do
  USER_SKIPPED:    'user_skipped',     // operator declined the prompt
  MISCONFIGURED:   'misconfigured',    // source repo unresolvable / no .env / no managed vars
  FATAL:           'fatal',            // unexpected error (parse failure, fs error)
});
export const EXIT_CODE_FOR = Object.freeze({
  created:         0,
  updated:         0,
  already_current: 0,
  user_skipped:    0,
  misconfigured:   4,
  fatal:           1,
});

// R1-audit H1 → Gemini-G3: deterministic source-repo identity via
// source-exclusive sentinel file (`scripts/sync-to-repos.mjs`).
// Resolution order:
//   1. explicit `--source-repo <path>` flag (CLI) or `sourceRepoDir` arg
//   2. CLAUDE_AUDIT_LOOP_DIR env override
//   3. cwd IF it's the source repo (verified by sentinel)
//   4. parent's siblings, sentinel-verified

function isSourceRepo(candidatePath) {
  // Gemini-G3: deterministic single-signal check. `scripts/sync-to-repos.mjs`
  // is the syncer itself — it is NOT in CORE_ENTRY / ARCH_ENTRY and is
  // never synced to consumer repos. Its presence on a candidate directory
  // is sufficient proof of source-repo identity. Replaces the prior
  // multi-heuristic package.json-name + git-remote-URL check that R3-M1
  // patched and Gemini-G3 simplified.
  return fs.existsSync(path.join(candidatePath, 'scripts/sync-to-repos.mjs'));
}

export function resolveSourceRepo({explicitFlag = null, cwd = process.cwd()} = {}) {
  // (1) explicit flag — operator's wishes win
  if (explicitFlag) {
    return isSourceRepo(explicitFlag)
      ? { path: explicitFlag, source: 'flag' }
      : null;
  }
  // (2) env override
  if (process.env.CLAUDE_AUDIT_LOOP_DIR && isSourceRepo(process.env.CLAUDE_AUDIT_LOOP_DIR)) {
    return { path: process.env.CLAUDE_AUDIT_LOOP_DIR, source: 'env' };
  }
  // (3) cwd is the source repo
  if (isSourceRepo(cwd)) {
    return { path: cwd, source: 'cwd' };
  }
  // (4) sibling scan with name verification
  const parent = path.dirname(cwd);
  let entries;
  try { entries = fs.readdirSync(parent, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const candidate = path.join(parent, e.name);
    if (candidate === cwd) continue;
    if (isSourceRepo(candidate)) return { path: candidate, source: 'sibling' };
  }
  return null;
}

// R1-audit H3: full add/change/remove diff model. Managed-key removal
// (operator revoked OPENAI_API_KEY from source .env) MUST propagate to the
// shared file — the prior model only handled add/change, leaving revoked
// secrets in place. Unmanaged keys in the shared file (operator-added vars
// beyond SHARED_VARS) are NEVER touched by the diff or apply.
//
// Shape:
//   add:       {KEY: value}        — present in source, absent in shared
//   change:    {KEY: {from, to}}   — present in both, different value
//   remove:    {KEY: oldValue}     — present in shared, absent from source
//   unchanged: {KEY: value}        — present in both, identical
export function diffSharedEnv({sharedPath, sourcePath, managedKeys = SHARED_VARS}) {
  const shared = parseEnvFile(sharedPath);
  const source = parseEnvFile(sourcePath);
  const result = { add: {}, change: {}, remove: {}, unchanged: {} };
  for (const key of managedKeys) {
    const s = shared[key];
    const src = source[key];
    if (src !== undefined && s === undefined)     result.add[key] = src;
    else if (src !== undefined && s !== src)      result.change[key] = { from: s, to: src };
    else if (src === undefined && s !== undefined) result.remove[key] = s;
    else if (src !== undefined && s === src)      result.unchanged[key] = s;
    // else: both undefined — skip
  }
  return result;
}

// R1-audit M3 + R2-audit M4 + R3-audit M4 + Gemini-G4: secure mode AT OPEN
// via the project's atomicWriteFileSync helper (NOT hand-rolled fs.openSync
// — Gemini caught the DRY violation). Requires a one-line extension to
// atomicWriteFileSync to forward an optional `mode` to fs.openSync.
//
// Edit to scripts/lib/file-io.mjs::atomicWriteFileSync:
//
//   - export function atomicWriteFileSync(target, content)
//   + export function atomicWriteFileSync(target, content, { mode } = {})
//     [...]
//     - const fd = fs.openSync(tmp, 'wx');
//     + const fd = fs.openSync(tmp, 'wx', mode ?? 0o666);
//
// (Default 0o666 preserves existing callers' behaviour — Node's default
// open-with-umask outcome; the project's existing callers haven't relied
// on a specific mode.)
export function writeSharedEnv(filePath, managedVars, { mode = 0o600 } = {}) {
  const existing = parseEnvFile(filePath);
  const preserved = {};
  for (const [k, v] of Object.entries(existing)) {
    if (!SHARED_VARS.includes(k)) preserved[k] = v;
  }
  const lines = [
    '# managed by scripts/lib/shared-cloud-config.mjs — edit source repo .env + run `npm run sync` to update',
  ];
  for (const k of SHARED_VARS) {
    if (managedVars[k] !== undefined) lines.push(`${k}=${serializeEnvValue(managedVars[k])}`);
  }
  if (Object.keys(preserved).length > 0) {
    // Gemini-r3-r3 M4: header is honest about the contract — KEY=VALUE
    // pairs survive, but any comments or formatting will be stripped on
    // the next rewrite (dotenv.parse only returns parsed pairs).
    lines.push('',
      '# unmanaged keys — KEY=VALUE pairs survive rewrites, but any',
      '# comments / blank lines / formatting in this section will be',
      '# stripped by the next `setup:cloud` or sync trigger.');
    for (const [k, v] of Object.entries(preserved)) lines.push(`${k}=${serializeEnvValue(v)}`);
  }
  atomicWriteFileSync(filePath, lines.join('\n') + '\n', { mode });
  // Windows fallback — atomicWriteFileSync's mode is largely ignored at
  // open on Windows; post-rename chmod is also a no-op for ACL purposes
  // but kept for parity with the POSIX call shape.
  if (process.platform === 'win32') {
    try { fs.chmodSync(filePath, mode); } catch { /* expected */ }
  }
}

// R2-audit M3: extracted from config.mjs's `discoverDotenv`. ONE walk-up
// + git-root rule shared by runtime loader AND check-setup diagnostics.
// Returns absolute path or null.
export function discoverLocalEnvPath(cwd = process.cwd()) {
  let dir = cwd;
  while (dir) {
    const p = path.join(dir, '.env');
    if (fs.existsSync(p)) return p;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Try git root + main worktree root (matches config.mjs behaviour).
  try {
    const gitRoot = execSync('git rev-parse --show-toplevel', { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    const p = path.join(gitRoot, '.env');
    if (fs.existsSync(p)) return p;
    const gitCommonDir = execSync('git rev-parse --git-common-dir', { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    const mainRoot = path.resolve(gitCommonDir, '..');
    const main = path.join(mainRoot, '.env');
    if (fs.existsSync(main)) return main;
  } catch { /* not a git repo */ }
  return null;
}

// R2-audit M1: pure assessment layer. Returns the plan without rendering
// or acting. Both the CLI and the sync trigger consume this; the CLI
// renders human output, the sync trigger only renders/prompts on
// ACTIONABLE outcomes (skips `already_current` silently).
export function assessSharedCloudConfig({
  sourceRepoDir,                          // absolute path or null (resolver runs if null)
  sharedPath: spOverride = null,
  homedir   = os.homedir(),
  explicitFlag = null,
} = {}) {
  const sp = spOverride ?? sharedEnvPath(homedir);
  const resolution = sourceRepoDir
    ? { path: sourceRepoDir, source: 'arg' }
    : resolveSourceRepo({explicitFlag, cwd: process.cwd()});
  if (!resolution) {
    return {
      outcome: OUTCOMES.MISCONFIGURED,
      reason:  'no-source-repo',
      sharedPath: sp,
      message: `Source repo not found. Resolution order tried: --source-repo flag, CLAUDE_AUDIT_LOOP_DIR env, cwd, sibling dirs.\nEither set CLAUDE_AUDIT_LOOP_DIR=<path>, run from the source repo, or write ${sp} manually with at least:\n  AUDIT_DB_URL=postgresql://...\n  AUDIT_DB_SSL_MODE=no-verify\n`,
    };
  }
  const sourcePath = path.join(resolution.path, '.env');
  if (!fs.existsSync(sourcePath)) {
    return {
      outcome: OUTCOMES.MISCONFIGURED,
      reason: 'source-env-missing',
      sharedPath: sp, sourcePath, resolution,
      message: `Source repo at ${resolution.path} has no .env file. Set up the source repo first.\n`,
    };
  }
  // R2-audit H2: validate REQUIRED_VARS present in source.
  const sourceParsed = parseEnvFile(sourcePath);
  const missingRequired = REQUIRED_VARS.filter(k => !sourceParsed[k]);
  if (missingRequired.length > 0) {
    return {
      outcome: OUTCOMES.MISCONFIGURED,
      reason: 'source-missing-required',
      sharedPath: sp, sourcePath, resolution,
      missingRequired,
      message: `Source repo .env (${sourcePath}) is missing required var(s): ${missingRequired.join(', ')}. Set them in the source repo .env before running setup:cloud.\n`,
    };
  }

  const deltas = diffSharedEnv({sharedPath: sp, sourcePath});
  const totalChanges = Object.keys(deltas.add).length + Object.keys(deltas.change).length + Object.keys(deltas.remove).length;
  if (totalChanges === 0) {
    return { outcome: OUTCOMES.ALREADY_CURRENT, sharedPath: sp, sourcePath, resolution, deltas };
  }
  return {
    outcome: fs.existsSync(sp) ? OUTCOMES.UPDATED : OUTCOMES.CREATED,
    proposed: true,           // not yet applied; CLI/sync decides whether to prompt+write
    sharedPath: sp, sourcePath, resolution, deltas,
  };
}

// resolveSourceRepo per R1-audit H1 — body unchanged from R1 fix.
// (See §6 above for the full implementation.)

function maskDsn(v) {
  return typeof v === 'string' ? v.replace(/:[^:@\s/]+@/, ':***@') : v;
}

// resolveCloudConfig — R1-audit M1 + R2-audit M3 + R3-audit M3 + Gemini-G2.
// Models the full runtime precedence:
//   1. process.env IFF the value DIFFERS from both file layers
//      (Gemini-G2: config.mjs already calls dotenv.config() which copies
//      local + shared into process.env; without the differ-check the source
//      would always report 'process-env' and the diagnostic would lose
//      file-attribution signal. Differ-check correctly identifies values
//      set EXTERNALLY — shell export, parent-process env, etc.)
//   2. local .env (discovered via worktree-safe walk-up + git root)
//   3. ~/.audit-loop.env (shared file)
export function resolveCloudConfig({
  processEnv    = process.env,
  localEnvPath  = discoverLocalEnvPath(),
  sharedPath: sp = sharedEnvPath(),
} = {}) {
  const local  = localEnvPath ? parseEnvFile(localEnvPath) : {};
  const shared = parseEnvFile(sp);
  const result = {};
  for (const key of SHARED_VARS) {
    const peVal     = processEnv[key];
    const localVal  = local[key];
    const sharedVal = shared[key];
    const peSet     = peVal !== undefined && peVal !== '';
    // process.env wins ONLY when it differs from both files (genuine
    // external override, not the loader's copy).
    if (peSet && peVal !== localVal && peVal !== sharedVal) {
      result[key] = { value: peVal, source: 'process-env' };
    } else if (localVal !== undefined) {
      result[key] = { value: localVal,  source: 'local'  };
    } else if (sharedVal !== undefined) {
      result[key] = { value: sharedVal, source: 'shared' };
    } else if (peSet) {
      // Edge case: env set externally AND happens to equal a file value
      // (impossible — covered by branches above), OR env set externally
      // but file layers are empty.
      result[key] = { value: peVal, source: 'process-env' };
    } else {
      result[key] = { value: null, source: 'unset' };
    }
  }
  return result;
}

// formatDeltaPreview — pure renderer for prompts + CLI display.
export function formatDeltaPreview(deltas) {
  const lines = [];
  for (const [k, v] of Object.entries(deltas.add)) {
    lines.push(`  + ${k}=${k === 'AUDIT_DB_URL' ? maskDsn(v) : '***'}  (new)`);
  }
  for (const [k, {from, to}] of Object.entries(deltas.change)) {
    const f = k === 'AUDIT_DB_URL' ? maskDsn(from) : '***';
    const t = k === 'AUDIT_DB_URL' ? maskDsn(to)   : '***';
    lines.push(`  ~ ${k}: ${f} → ${t}`);
  }
  for (const k of Object.keys(deltas.remove)) {
    lines.push(`  - ${k}  (revoked in source)`);
  }
  return lines.join('\n');
}

function maskDsn(v) {
  return typeof v === 'string' ? v.replace(/:[^:@\s/]+@/, ':***@') : v;
}
```

**Additional lib export — the executor moves here per R3-audit M2.** The lib now owns:

```js
// R3-audit M2: executor moved into the lib so callers don't import the
// scripts/ top-level CLI module. The executor is "pure given injected
// I/O" — prompt/stdio are injectable, no process.exit, no global state.
// scripts/setup-cloud.mjs becomes purely an argv → executor adapter.
export async function runSetupCloud({
  prompt,                                  // (question: string) => Promise<boolean>; required (no default I/O)
  dryRun        = false,
  autoYes       = false,
  sourceRepoDir = null,
  explicitFlag  = null,
  stdio         = process.stderr,
  homedir       = undefined,
  format        = 'human',
} = {}) {
  const assessment = assessSharedCloudConfig({sourceRepoDir, homedir, explicitFlag});

  if (assessment.outcome === OUTCOMES.MISCONFIGURED ||
      assessment.outcome === OUTCOMES.ALREADY_CURRENT) {
    return emitResult(assessment, {format, stdio});
  }

  if (!autoYes) {
    const verb = assessment.outcome === OUTCOMES.CREATED ? 'Create' : 'Update';
    const ok = await prompt(`${verb} ${assessment.sharedPath}?\n${formatDeltaPreview(assessment.deltas)}\n(Y/n) `);
    if (!ok) return emitResult({...assessment, outcome: OUTCOMES.USER_SKIPPED}, {format, stdio});
  }
  if (dryRun) return emitResult({...assessment, dryRun: true}, {format, stdio});

  const desired = {};
  for (const k of Object.keys(assessment.deltas.unchanged)) desired[k] = assessment.deltas.unchanged[k];
  for (const k of Object.keys(assessment.deltas.add))       desired[k] = assessment.deltas.add[k];
  for (const k of Object.keys(assessment.deltas.change))    desired[k] = assessment.deltas.change[k].to;
  writeSharedEnv(assessment.sharedPath, desired);

  return emitResult(assessment, {format, stdio});
}

function emitResult(assessment, {format, stdio}) {
  const result = {...assessment, exitCode: EXIT_CODE_FOR[assessment.outcome]};
  if (format === 'json') {
    // Note: lib writes to process.stdout here for the JSON contract.
    // This is the ONE intentional global-stdout use in the lib — JSON
    // CLI output must go to stdout regardless of injected stdio.
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    renderHumanResult(result, stdio);
  }
  return result;
}

function renderHumanResult(r, stdio) {
  if (r.outcome === OUTCOMES.MISCONFIGURED) { stdio.write(r.message); return; }
  if (r.outcome === OUTCOMES.ALREADY_CURRENT) {
    stdio.write(`shared cloud config: ${r.sharedPath} — in sync with source repo .env\n`);
    return;
  }
  if (r.outcome === OUTCOMES.USER_SKIPPED) { stdio.write('Skipped.\n'); return; }
  if (r.dryRun) {
    stdio.write(`(dry-run) would ${r.outcome === OUTCOMES.CREATED ? 'create' : 'update'} ${r.sharedPath}:\n${formatDeltaPreview(r.deltas)}\n`);
    return;
  }
  stdio.write(`${r.outcome === OUTCOMES.CREATED ? 'Created' : 'Updated'} ${r.sharedPath} (mode 0600).\n`);
  if (process.platform === 'win32') {
    stdio.write('[setup:cloud] note: chmod is a no-op on Windows; file permissions inherit from %USERPROFILE%\n');
  }
  if (r.outcome === OUTCOMES.CREATED) {
    stdio.write('Consumer repos will now inherit these on next run. Run `npm run arch:refresh` to populate the symbol index.\n');
  }
}
```

### NEW [`scripts/setup-cloud.mjs`](scripts/setup-cloud.mjs) (thin CLI adapter)

```js
#!/usr/bin/env node
/**
 * @fileoverview Thin argv → executor adapter. ALL logic lives in
 * scripts/lib/shared-cloud-config.mjs per R3-audit M2.
 *
 * @module scripts/setup-cloud
 */
import readline from 'node:readline';
import path from 'node:path';
import { runSetupCloud, OUTCOMES, EXIT_CODE_FOR } from './lib/shared-cloud-config.mjs';

function defaultPrompt(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({input: process.stdin, output: process.stderr});
    rl.question(question, (answer) => {
      rl.close();
      // R1-audit M3/M13: tightened to a strict allowlist (default-Y prompt,
      // anything else → reject). Typos and pasted junk no longer auto-confirm.
      const a = answer.trim().toLowerCase();
      resolve(a === '' || a === 'y' || a === 'yes');
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  let explicitFlag = null, format = 'human';
  let autoYes = args.includes('--yes') || args.includes('-y');
  let dryRun  = args.includes('--dry-run');
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--source-repo') explicitFlag = args[++i];
    else if (args[i] === '--format')  format      = args[++i];
  }
  if (format !== 'human' && format !== 'json') {
    process.stderr.write(`error: --format must be 'human' or 'json' (got: ${format})\n`);
    process.exit(2);
  }
  let result;
  try {
    result = await runSetupCloud({prompt: defaultPrompt, autoYes, dryRun, format, explicitFlag});
  } catch (err) {
    process.stderr.write(`setup-cloud: fatal: ${err.stack || err.message}\n`);
    process.exit(EXIT_CODE_FOR[OUTCOMES.FATAL]);
  }
  process.exit(result.exitCode);
}

const invoked = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (invoked) main();
```

### EDIT [`scripts/sync-to-repos.mjs`](scripts/sync-to-repos.mjs)

Add the D2b trigger at the end of `main()`, before `process.exit`:

```js
// Existing tail of main():
//   console.log('─'.repeat(40));
//   ...
//   console.log(`  Created: ${totalNew}  Updated: ${totalUpdated}  ...`);
//   process.exit(totalErrors > 0 ? 1 : 0);

// NEW — D2b trigger. Skip on dry-run, non-TTY, --no-prompt, errors.
// Gemini-r3 G2: both stdin.isTTY AND stdout.isTTY required — stdout-only is
// unsafe in CI environments where stdout is a pseudo-TTY but stdin is
// closed/piped (readline would hang forever).
if (!DRY_RUN && totalErrors === 0
    && process.stdout.isTTY && process.stdin.isTTY
    && !args.includes('--no-prompt')) {
  await maybePromptSharedCloudUpdate({
    sourceRepoDir: SOURCE_ROOT,
    stdio: process.stderr,
  });
}

process.exit(totalErrors > 0 ? 1 : 0);
```

And `maybePromptSharedCloudUpdate` (file-local). Per R2-audit M1, sync calls the PURE assessor directly and short-circuits silently on `already_current` — no rendering noise on every sync.

```js
async function maybePromptSharedCloudUpdate({sourceRepoDir, stdio}) {
  const { assessSharedCloudConfig, OUTCOMES } = await import('./lib/shared-cloud-config.mjs');
  const assessment = assessSharedCloudConfig({sourceRepoDir});

  // Silent on `already_current` — operator only sees output when there's
  // something to act on (R2-audit M1: split assessment from rendering).
  if (assessment.outcome === OUTCOMES.ALREADY_CURRENT) return;

  // Misconfigured → one-line advisory, never blocks sync.
  if (assessment.outcome === OUTCOMES.MISCONFIGURED) {
    stdio.write(`\n[sync] shared cloud config: ${assessment.reason} — skipping (run \`npm run setup:cloud\` for details)\n`);
    return;
  }

  // CREATED or UPDATED — call the lib's runSetupCloud executor directly
  // (R3-audit M2: never import the scripts/ top-level CLI from another flow).
  const { runSetupCloud } = await import('./lib/shared-cloud-config.mjs');
  const readline = await import('node:readline');
  const prompt = (q) => new Promise(r => {
    const rl = readline.createInterface({input: process.stdin, output: stdio});
    rl.question(q, answer => {
      rl.close();
      // R1-audit M3/M13 (Gemini-r3-r3): identical strict allowlist to the
      // setup-cloud CLI's defaultPrompt — typos and pasted junk reject.
      const a = answer.trim().toLowerCase();
      r(a === '' || a === 'y' || a === 'yes');
    });
  });
  stdio.write('\n');
  await runSetupCloud({prompt, sourceRepoDir, stdio, autoYes: false});
}
```

`args.includes('--no-prompt')` requires the existing argv parser to surface that flag — add it to the flag set near the top of sync-to-repos.mjs.

### EDIT [`scripts/lib/file-io.mjs`](scripts/lib/file-io.mjs)

Per Gemini-G4: extend `atomicWriteFileSync` to accept an optional `mode` parameter forwarded to `fs.openSync`. One-line addition, default `0o666` preserves existing callers' behaviour.

```js
// BEFORE
export function atomicWriteFileSync(target, content) {
  const tmp = `${target}.${process.pid}-${Date.now()}.tmp`;
  const fd = fs.openSync(tmp, 'wx');
  try { fs.writeSync(fd, content); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(tmp, target);
}

// AFTER
export function atomicWriteFileSync(target, content, { mode = 0o666 } = {}) {
  const tmp = `${target}.${process.pid}-${Date.now()}.tmp`;
  const fd = fs.openSync(tmp, 'wx', mode);
  try { fs.writeSync(fd, content); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(tmp, target);
}
```

No call-site updates required for existing usages — the default value matches Node's prior open-with-umask outcome. The new `mode` option is opt-in for callers that need it (this plan's `writeSharedEnv` is the first).

### EDIT [`scripts/lib/store/repo.mjs`](scripts/lib/store/repo.mjs)

Single-line edit to the cloud-not-configured message (line 49):

```js
// BEFORE
process.stderr.write('  [learning] Cloud store not configured — using local mode\n');

// AFTER
process.stderr.write(
  '  [learning] Cloud store not configured — using local mode.\n' +
  '             Run `npm run setup:cloud` from your claude-engineering-skills install to inherit shared config,\n' +
  '             OR set AUDIT_DB_URL in this repo\'s .env directly.\n'
);
```

### EDIT [`scripts/check-setup.mjs`](scripts/check-setup.mjs)

R1-audit M1: the check must evaluate EFFECTIVE merged config, not just the local `.env`. If local `.env` has no `AUDIT_DB_URL` but `~/.audit-loop.env` provides it, the effective config IS set — current implementation would falsely warn. Extract `resolveCloudConfig()` as a shared helper used by `config.mjs`, `check-setup.mjs`, and `repo.mjs::initLearningStore`.

**`resolveCloudConfig` is defined ONCE in the lib (see §6 `scripts/lib/shared-cloud-config.mjs` above)** — Gemini-G1 caught an earlier draft of this section that duplicated the function with a different signature (`cwdEnvPath` instead of `localEnvPath`), creating a contradiction. The check-setup call site uses the lib's canonical signature:

```js
import { resolveCloudConfig, sharedEnvPath, discoverLocalEnvPath } from './lib/shared-cloud-config.mjs';

// In the audit-loop check block:
const cloud = resolveCloudConfig({ localEnvPath: discoverLocalEnvPath(repoPath) });

if (cloud.AUDIT_DB_URL.source === 'unset') {
  if (fs.existsSync(sharedEnvPath())) {
    warn('AUDIT_DB_URL not set anywhere — present in ~/.audit-loop.env? check that file');
  } else {
    warn('AUDIT_DB_URL not set; run `npm run setup:cloud` to inherit from your source-repo install');
  }
} else if (cloud.AUDIT_DB_URL.source === 'shared') {
  pass(`AUDIT_DB_URL  (inherited from ~/.audit-loop.env)`);
} else if (cloud.AUDIT_DB_URL.source === 'process-env') {
  pass(`AUDIT_DB_URL  (set via shell export — not in any .env file)`);
} else {
  pass(`AUDIT_DB_URL  (set in repo .env)`);
}
```

### EDIT [`package.json`](package.json)

```json
"setup:cloud": "node scripts/setup-cloud.mjs",
```

### EDIT [`scripts/.cli-catalog.json`](scripts/.cli-catalog.json)

```json
"setup:cloud": {
  "description": "Create or refresh ~/.audit-loop.env from the source repo's .env so consumer repos auto-inherit shared cloud config (DSN + LLM keys). Idempotent. --yes for CI, --dry-run to preview.",
  "category": "diagnostic"
}
```

### EDIT [`AGENTS.md`](AGENTS.md)

New subsection under "Postgres-Parity Store" (after the "Migration-drift detection" subsection added in the prior plan):

```markdown
### Shared cloud config for consumer repos

The audit-loop's cloud secrets (`AUDIT_DB_URL`, optional `OPENAI_API_KEY` /
`GEMINI_API_KEY` / `ANTHROPIC_API_KEY`) are shared across all consumer repos
that use this bundle — same Supabase project, same LLM accounts. Rather than
duplicate them in each repo's `.env`, the loader supports a per-user shared
file at **`~/.audit-loop.env`** that consumers automatically inherit.

**Loader precedence** (configured in [scripts/lib/config.mjs](scripts/lib/config.mjs)):
1. cwd / git-root `.env` — wins on overrides. Repo-specific values live here.
2. `~/.audit-loop.env` — fallback for any var not set above. Shared secrets.

If the shared file doesn't exist, the loader is silent (no warning, no error).
The first time it loads variables, you'll see one stderr line:
`[config] loaded shared cloud config from ~/.audit-loop.env (sets: AUDIT_DB_URL, OPENAI_API_KEY)`.

**Setup**:

```bash
# From your source claude-engineering-skills repo (where .env has the canonical DSN):
npm run setup:cloud
#  → prompts "Create ~/.audit-loop.env from this repo's .env? (Y/n)"
#  → writes the file with chmod 0600

# Subsequent runs:
npm run setup:cloud        # prints current vars (passwords masked), suggests arch:refresh
npm run setup:cloud --yes  # non-interactive (CI)
npm run setup:cloud --dry-run  # show what would happen, write nothing
```

**Updating after rotation**: when you edit `AUDIT_DB_URL` (or any shared var) in
the source repo's `.env`, the next `npm run sync` detects the divergence and
prompts with the specific delta:

```
Shared cloud config diverges from source repo .env:
  AUDIT_DB_URL: ***:***@aws-1-eu-west-2... → ***:***@aws-1-us-east-1...
Update ~/.audit-loop.env? (Y/n)
```

Skip the prompt with `npm run sync -- --no-prompt` (CI). The prompt also skips
when not running in a TTY.

**From a consumer repo**: any cloud-aware command (arch:refresh,
audit-loop, persona-test with cloud, /plan) automatically inherits the shared
config. If a consumer's `[learning] Cloud store not configured` warning fires,
the recovery is one command — the message itself points at `npm run setup:cloud`.

**What lives where**:

| File | Holds | Wins on conflict |
|---|---|---|
| consumer repo `.env` | repo-specific (`PERSONA_TEST_REPO_NAME`, custom overrides) | Yes (override:false) |
| `~/.audit-loop.env` | shared secrets (DSN, LLM keys) | Fallback only |
| source repo `.env` | canonical for shared secrets (the source `setup:cloud` reads from) | n/a (not loaded by consumers) |

**Opt-out**: don't run `setup:cloud`. The file never gets created; consumer
repos that need cloud just set `AUDIT_DB_URL` in their own `.env` directly,
same as before. Public-repo safety: the file is in `os.homedir()`, never in
any git tree.
```

### NEW [`tests/config-shared-env.test.mjs`](tests/config-shared-env.test.mjs)

Hermetic via `os.homedir()` override (set `HOME` env to a `mkdtemp` dir before spawning a subprocess; the subprocess's `os.homedir()` returns the temp path on POSIX, `USERPROFILE` on Windows). Test matrix:

| Case | Setup | Assertion |
|---|---|---|
| `cwd .env wins over shared` | cwd has `AUDIT_DB_URL=cwd-value`; shared has `AUDIT_DB_URL=shared-value` | subprocess sees `cwd-value` |
| `shared fills unset vars` | cwd has `PERSONA_REPO=x`; shared has `AUDIT_DB_URL=y` | subprocess sees both |
| `shared absent → silent no-op` | only cwd .env | no stderr `[config]` line; no crash |
| `both absent → no crash` | empty cwd, empty home | subprocess exits clean |
| `stderr note emitted once per process` | shared has 2 vars | exactly ONE `[config] loaded shared cloud config…` line in stderr |
| `subprocess inherits via _AUDIT_LOOP_SHARED_LOADED` | parent loads shared; spawns child | child does NOT re-log (sentinel propagates) |

Subprocess pattern: invoke a tiny throwaway `.mjs` that imports `config.mjs` and prints `JSON.stringify(process.env)` keys; assert presence/absence per test.

### NEW [`tests/shared-cloud-config.test.mjs`](tests/shared-cloud-config.test.mjs)

Hermetic via injected `homedir` + `prompt` + `stdio`. NO real filesystem outside `mkdtemp`. NO real subprocesses (CLI surface tested via direct `runSetupCloud()` calls).

| Case | Setup | Assertion |
|---|---|---|
| `already_current` outcome | shared file matches source `.env` exactly | result `{outcome: 'already_current', exitCode: 0}`; no prompt fired; stderr: "in sync with source" |
| `created` outcome | shared file absent; source has SHARED_VARS | result `{outcome: 'created', exitCode: 0}`; file written via atomic-write; chmod 0600 (POSIX); vars parseable |
| `updated` outcome — add | shared has DSN only; source adds OPENAI_API_KEY | deltas.add has OPENAI_API_KEY; result `{outcome: 'updated'}`; file now contains both |
| `updated` outcome — change | shared has old DSN; source has new DSN | deltas.change.AUDIT_DB_URL has from+to; prompt preview shows masked old → new |
| `updated` outcome — remove (H3) | shared has DSN + LLM key; source removed LLM key | deltas.remove.OPENAI_API_KEY present; written file LACKS the key (revocation propagated) |
| `updated` — preserves unmanaged keys | shared has SHARED_VARS + operator-added `MY_CUSTOM=x` | after update, MY_CUSTOM still present in file under "# unmanaged" section |
| `user_skipped` outcome | mock prompt returns false on update | result `{outcome: 'user_skipped', exitCode: 0}`; file unchanged on disk |
| `misconfigured` — no source | no source repo resolvable | result `{outcome: 'misconfigured', exitCode: 4}`; manual instructions printed |
| `misconfigured` — source .env missing | resolved source dir has no `.env` | result `{outcome: 'misconfigured', exitCode: 4}`; explicit message |
| `--dry-run` | deltas present, dryRun=true | result `{outcome: 'created'|'updated', dryRun: true, exitCode: 0}`; file NOT written |
| `--yes` bypasses prompt | autoYes=true with non-empty deltas | mock prompt counter is 0; result CREATED/UPDATED |
| `resolveSourceRepo` priority — explicit flag | flag points at non-source dir | returns null (validation rejects) |
| `resolveSourceRepo` priority — env > sibling | both set | env wins |
| `resolveSourceRepo` rejects synced consumer | sibling has both sentinel files but `package.json::name !== 'claude-engineering-skills'` | returns null (H1 fix — was previously matched) |
| `resolveSourceRepo` accepts cwd if self | invoked from inside source repo | returns `{path: cwd, source: 'cwd'}` |
| chmod 0600 on POSIX | created outcome on Linux/Mac | `fs.statSync(file).mode & 0o777 === 0o600` |
| chmod skipped on Windows | created outcome with `process.platform === 'win32'` mocked | no throw; advisory note printed |
| `parseEnvText` matches dotenv.parse | sample with `KEY="quoted"`, `# comment`, blank lines | byte-equal output to `dotenv.parse(text)` (proves M2 — single semantic) |
| `diffSharedEnv` shapes | identical / disjoint / partial-overlap scenarios | returns `{add, change, remove, unchanged}` with correct contents per scenario |
| `writeSharedEnv` is atomic | mocked fs that fails mid-write | original file preserved (atomic-rename semantics); no truncation |
| `writeSharedEnv` preserves SHARED_VARS order | vars passed in random key order | file lines emitted in `SHARED_VARS` declaration order |
| `OUTCOMES` + `EXIT_CODE_FOR` are aligned | every OUTCOMES value maps to a number in EXIT_CODE_FOR | Object.keys(EXIT_CODE_FOR) ⊇ Object.values(OUTCOMES) |

### NEW [`tests/sync-shared-env-trigger.test.mjs`](tests/sync-shared-env-trigger.test.mjs)

Hermetic test of the `maybePromptSharedCloudUpdate` function (file-local in sync-to-repos.mjs — exposed via a small `_internals` export following the project convention).

| Case | Setup | Assertion |
|---|---|---|
| first-deploy prompt fires | shared file absent; source .env has AUDIT_DB_URL | calls `runSetupCloud`; stdio shows the "Create ~/.audit-loop.env" prompt |
| divergence prompt fires with delta | shared file has old DSN; source has new | stdio shows `AUDIT_DB_URL: ***:***@old-host... → ***:***@new-host...`; prompt fired |
| in-sync skips silently | shared file matches source | NO stdio output beyond what sync itself emits; no prompt |
| non-TTY skips entirely | `process.stdout.isTTY = false` mocked | function not invoked (or returns early) |
| --no-prompt flag skips entirely | sync invoked with `--no-prompt` | function not invoked |
| dry-run skips entirely | sync invoked with `--dry-run` | function not invoked |
| source .env missing skips | source repo has no .env | function returns early; no error |
| update declined | divergence detected; prompt returns false | stdio shows "Skipped"; file unchanged |
| update confirmed | divergence; prompt returns true | file rewritten; sha changes; only divergent keys updated (other vars in shared file preserved) |

## 7. Risk & Trade-off Register

| Risk | Mitigation |
|---|---|
| Shared file gets out of sync between machines (operator works on laptop AND desktop) | Operator runs `setup:cloud` on each machine. Documented in AGENTS.md "What lives where" table. Sync trigger from source repo on each machine catches divergence per-machine. |
| File contains secrets in plaintext on disk | Same threat model as `.env`. chmod 0600 on POSIX; documented as per-user-private. If threat model tightens, the migration path is OS-keychain integration — separate plan. |
| Operator deletes `~/.audit-loop.env` accidentally | Loader silently no-ops on missing file (per design — opt-out semantics). Next `setup:cloud` re-creates it. No data loss — the source repo's `.env` is the canonical source. |
| Multiple source repos on one machine (operator has a fork + upstream) | `discoverSourceRepo` picks first match by directory iteration order. Documented escape hatch: `CLAUDE_AUDIT_LOOP_DIR=<path>` env override. |
| `--no-prompt` accidentally suppresses a critical divergence warning | Single-machine, single-operator scenario — `--no-prompt` is only used in CI where divergence wouldn't matter anyway (CI sets env directly). Documented in AGENTS.md. |
| `process.env._AUDIT_LOOP_SHARED_LOADED` sentinel collides with another tool's env var | Underscore-prefix is the project convention for internal-only env vars; name is sufficiently specific to this loader. Drop sentinel if it ever clashes — fallback is per-process log noise, not a crash. |
| Loader fires the stderr note in tests, polluting CI logs | Tests run subprocesses; the note appears in the captured stderr but tests can pin it explicitly with the `stderr note emitted once` case. Existing tests that DON'T import config.mjs are unaffected. |
| Adding a new SHARED_VAR (e.g. `MEMORY_HEALTH_*`) requires editing the export list | Trade-off accepted: an explicit allowlist prevents accidentally promoting per-repo vars to the shared file. The list is a single Array.freeze; one-line edit. |
| Operator running setup-cloud from inside `c:\GIT\claude-engineering-skills` itself (no sibling needed) | `discoverSourceRepo` walks PARENT dir's siblings. From inside source repo, parent = `c:\GIT`, siblings exclude self. Source repo IS the source — call `runSetupCloud({sourceRepoDir: process.cwd()})` directly. Handled by sync-to-repos.mjs which passes `SOURCE_ROOT` explicitly. Standalone CLI invocation: `runSetupCloud()` would scan and find a SIBLING audit-loop install (different repo path) — the operator is unlikely to have that. Documented edge case in setup-cloud.mjs header: "if running setup-cloud from inside the source repo, pass `--source-repo .`" — add this flag in v1 to avoid the surprise. |

### Deliberately deferred

- **Encryption-at-rest**: out of scope. Same chmod 0600 convention as `.env`.
- **Profile / multi-environment support**: out of scope. Single-cloud assumption matches v1 reality.
- **OS-keychain integration**: out of scope. dotenv + chmod is the project's chosen security boundary.
- **Auto-sync `~/.audit-loop.env` across multiple operator machines**: explicit non-goal. Per-machine setup is intentional (the file in HOME isn't a deployment artifact).
- **Auto-create on `git clone`**: explicit non-goal. Public-repo safety.

## 8. Testing Strategy

| Layer | Coverage |
|---|---|
| Loader (`config.mjs`) | `tests/config-shared-env.test.mjs` — 6 cases via subprocess + HOME override. Asserts precedence, silent no-op, one-time note, subprocess inheritance. |
| Helpers + executor (`scripts/lib/shared-cloud-config.mjs` exports) | `tests/shared-cloud-config.test.mjs` — 37 cases via direct calls with injected `homedir`/`prompt`/`stdio`. Covers all assess outcomes + executor branches + flag combinations + chmod cross-platform + helper purity. |
| Sync trigger (`sync-to-repos.mjs` D2b) | `tests/sync-shared-env-trigger.test.mjs` — 9 cases via direct call to the exported `_internals.maybePromptSharedCloudUpdate`. Covers all 5 decision-tree branches + TTY/--no-prompt/--dry-run gating + decline/confirm. |
| Catalog | Existing `tests/dashboard-cli.test.mjs` regression gate will catch any missing catalog entry. |

### Existing-suite invariants

- All 2995 currently-passing tests stay green.
- The note-emitted-once test pins the loader's stderr signature; if a future refactor accidentally re-emits, that test fires.
- chmod test is platform-conditional via `process.platform === 'win32'` → `t.skip(…)` (mirroring the bash-detection pattern in `hook-snippet-behaviour.test.mjs`).

### Regression locks

- No `/ux-lock` runs (backend-only).
- No persona-test runs.
- Opt-in: `npm run check:integration` doesn't need extension — `arch:refresh:full` and `--check-drift` already exercise the cloud path; if the loader broke, those would fail first.

## 9. Cross-skill registration

```bash
node scripts/cross-skill.mjs upsert-plan --json '{
  "path": "docs/plans/shared-cloud-config.md",
  "skill": "plan-backend",
  "status": "draft"
}'
```

(Note: still using `skill='plan-backend'` instead of `'plan'` per the cross-skill constraint historically. Once the migration-drift detector's bootstrap fully propagates and the unified-plan-skill value is widely used, can switch.)

Update `status` to `in_progress` when implementation lands, `complete` once tests are green AND operator has run `setup:cloud` on their machine to verify the end-to-end flow.

## Implementation Log

### 2026-05-23 — R1 plan-audit revisions

R1 plan-audit (GPT-5.4) returned NEEDS_REVISION, H:3 M:4 L:0. All 7 findings valid + in-scope + fixed:

| ID | Finding | Edit |
|---|---|---|
| H1 — sibling scan matches synced consumer repos | `resolveSourceRepo` with priority order (flag → env → cwd → name-verified siblings) using `package.json::name === 'claude-engineering-skills'` sentinel | §2 #4 + §6 setup-cloud.mjs |
| H2 — mode-a was terminal "all good" without source comparison | unified `runSetupCloud` always diffs vs source; outcomes (already_current/created/updated/user_skipped/misconfigured/fatal) explicit; sync trigger delegates entirely | §2 #4 + §6 setup-cloud.mjs main flow + §6 sync trigger |
| H3 — removed-from-source keys never propagated as removals | `diffSharedEnv` returns full add/change/remove/unchanged shape; `writeSharedEnv` constructs file from canonical desired set + preserves unmanaged operator-added keys | §6 setup-cloud.mjs diffSharedEnv + writeSharedEnv |
| M1 — check-setup didn't evaluate merged config | `resolveCloudConfig({cwdEnvPath, sharedEnvPath})` shared helper; check-setup branches on `.source === 'unset'/'local'/'shared'` | §6 setup-cloud.mjs + §6 check-setup.mjs |
| M2 — handwritten parser vs dotenv | `parseEnvText` delegates to `dotenv.parse`; `parseEnvFile` thin wrapper; one semantic across runtime + setup | §6 setup-cloud.mjs |
| M3 — non-atomic writes vs stated narrative | use `atomicWriteFileSync` from file-io.mjs; preserves crash-safe rename pattern | §6 setup-cloud.mjs writeSharedEnv |
| M4 — exit-code contract ambiguous | OUTCOMES enum + EXIT_CODE_FOR map; CLI exits per outcome (no-source-repo = 4, fatal = 1, others = 0) | §6 setup-cloud.mjs |

### 2026-05-23 — R2 plan-audit revisions

R2 (GPT-5.4): NEEDS_REVISION, H:2 M:4 L:0 (down from H:3 — meets >30% rigor rule). All 6 valid + in-scope + applied:

| ID | Finding | Edit |
|---|---|---|
| H1 — CLI still used `.ok` instead of `.exitCode` from R1 fix (regression I introduced) | main() now `process.exit(result.exitCode)`; explicit FATAL outcome on exception | §6 setup-cloud.mjs main() |
| H2 — source `.env` without AUDIT_DB_URL fell through to `already_current` (false success) | added `REQUIRED_VARS = ['AUDIT_DB_URL']`; `assessSharedCloudConfig` returns `misconfigured` with `missingRequired` when source lacks required vars | §6 lib SHARED_VARS/REQUIRED_VARS + assess body |
| M1 — sync prints "in sync" noise on every run | split pure `assessSharedCloudConfig` from CLI renderer; sync trigger short-circuits on `already_current` silently, only renders on actionable outcomes | §2 #4 + §6 lib assess + §6 sync trigger rewrite |
| M2 — lib code mixed with CLI in `scripts/setup-cloud.mjs` | moved pure helpers to NEW `scripts/lib/shared-cloud-config.mjs` (shared-lib domain); setup-cloud.mjs becomes thin CLI per project lib/CLI convention | §6 split into lib + CLI files |
| M3 — check-setup env path discovery diverged from runtime | extracted `discoverLocalEnvPath` into the lib; both runtime loader (config.mjs) and check-setup use the same walk-up + git-root rule | §6 lib discoverLocalEnvPath + §6 check-setup edit |
| M4 — raw `KEY=value` writes don't round-trip quoted/escaped values | added `serializeEnvValue(value)` that quotes when needed (whitespace, quotes, `$`, `#`, newlines) and escapes backslashes/quotes/newlines | §6 lib serializer + writeSharedEnv uses it |

### 2026-05-23 — R3 plan-audit revisions

R3 (GPT-5.4): NEEDS_REVISION, H:0 M:4 L:1. **HIGH cleared (3 → 2 → 0).** MEDIUM stayed at 4 with different findings each round — entering rigor-pressure territory. All 4 R3 MEDIUMs valid + applied; stopping plan-audit and proceeding to Gemini per the skill's stop rule.

| ID | Finding | Edit |
|---|---|---|
| M1 — hardcoded `package.json::name` for repo identity | added git remote URL fallback (`remote.origin.url` ending in `claude-engineering-skills(.git)?`) — covers forks that renamed package.json | §6 lib `isSourceRepo` |
| M2 — sync trigger imported from `scripts/setup-cloud.mjs` (CLI module) | moved `runSetupCloud` executor INTO the lib; `scripts/setup-cloud.mjs` is now pure argv → executor adapter; sync imports the executor from the lib directly | §6 lib runSetupCloud + §6 setup-cloud.mjs slimmed + §6 sync trigger imports lib |
| M3 — `resolveCloudConfig` ignored process.env layer | added `processEnv` as first layer (precedence: `process.env` → cwd `.env` → `~/.audit-loop.env`); operator who `export AUDIT_DB_URL=...` in shell sees `{source: 'process-env'}` not false-`unset` | §6 lib resolveCloudConfig |
| M4 — chmod after rename left permission window | replaced post-write chmod with `fs.openSync(temp, 'wx', 0o600)` — file created with secure mode atomically; rename preserves crash-safety; Windows falls back to post-rename chmod (best-effort, ACLs unaffected anyway) | §6 lib writeSharedEnv |

**Stopping iteration.** HIGH cleared at R3 (0 findings). MEDIUM count plateaued (4 → 4) — different concerns each round means the auditor is now in rigor-pressure mode rather than catching design bugs. Per audit-plan skill's stop rule, proceeding to Gemini Step 6 with the current draft. The remaining MEDIUMs from R3 are all addressed in the lib edits above.

### 2026-05-23 — Gemini final review revisions

Gemini 3.1 Pro returned CONCERNS, 4 new findings (2 HIGH the 3 GPT rounds missed). All 4 valid + applied:

| ID | Finding | Edit |
|---|---|---|
| Gemini-G1 (HIGH) — duplicate resolveCloudConfig definitions | I had ONE definition in the lib (`localEnvPath`/`processEnv`) and a stale one in the check-setup.mjs section (`cwdEnvPath`, missing process.env layer). Removed the stale duplicate; check-setup imports the lib's canonical version | §6 check-setup.mjs section |
| Gemini-G2 (HIGH) — process.env masks file sources | `config.mjs` already populates `process.env` via `dotenv.config()`, so `processEnv[key] !== undefined` was ALWAYS true after loader runs → source would always report 'process-env', wiping file attribution. Now attribute to 'process-env' ONLY when the value differs from both file layers (genuine external override like shell export) | §6 lib resolveCloudConfig precedence |
| Gemini-G3 (MEDIUM) — fragile package.json + remote heuristics | Replaced multi-signal identity check (package.json::name + git remote URL) with single deterministic sentinel: `fs.existsSync(scripts/sync-to-repos.mjs)`. The syncer itself is NOT in CORE_ENTRY (verified via grep) — never synced to consumer repos. Removed SOURCE_REPO_NAME const + execSync import as no longer needed | §6 lib isSourceRepo |
| Gemini-G4 (LOW) — hand-rolled atomic write violates DRY vs file-io.mjs | Reverted writeSharedEnv to use `atomicWriteFileSync` from file-io.mjs; extended that helper with optional `mode` parameter forwarded to `fs.openSync` (default 0o666 preserves existing callers). One-line library extension, restored DRY contract | §6 file-io.mjs edit + writeSharedEnv |

**Final state**: plan reflects R1+R2+R3+Gemini revisions. All HIGH cleared. Stopping iteration per audit-plan skill's "max 2 final-review rounds" rule. Plan is ready for implementation. Final shape covers:

- 3 HIGH (lib/CLI split, source-repo identity, partial-adopt soundness) + 4 MEDIUM (parser/serializer/writer atomicity/exit codes/process.env layering) + 4 MEDIUM (assess/lib boundary/process-env masking/file-perm window) + 4 Gemini (duplicate defs/precedence/identity-sentinel/atomicWrite DRY) findings — 15 total, all applied.
- Single workstream, ~200 LOC + 3 test files.
- Pure lib in `scripts/lib/shared-cloud-config.mjs`; thin CLI in `scripts/setup-cloud.mjs`; sync trigger imports from lib (never from setup-cloud).

## Implementation Log

### 2026-05-23 — Implemented, audited (R1→R3 + Gemini ×5), shipped

| Planned Item | Status | Notes |
|---|---|---|
| `scripts/lib/shared-cloud-config.mjs` | ✅ Done | Pure helpers + executor; 558 LOC, exports SHARED_VARS/REQUIRED_VARS/OUTCOMES/EXIT_CODE_FOR + 12 functions. Tagged-union resolveSourceRepo (R2-audit M2/M8). Bare-form mixed-quote serializer with safety guards (Gemini-r3 M7). |
| `scripts/setup-cloud.mjs` | ✅ Done | Thin argv→executor CLI (116 LOC). Strict allowlist prompt (R1-audit M3/M13). Short-flag rejection in argv parser (R2-audit M5). TTY check for non-yes invocations (R1-audit M4). |
| `scripts/lib/config.mjs` autoload | ✅ Done | `~/.audit-loop.env` fallback with sentinel suppression for subprocess inheritance (R1-audit M17). Refactored `discoverDotenv` to share `discoverLocalEnvPath` from lib (R1-audit M9/M11/M15 DRY). |
| `scripts/lib/file-io.mjs` mode param | ✅ Done | `atomicWriteFileSync({mode})` forwarded to `fs.writeFileSync` for secure-mode-at-create (Gemini-G4). Symlink-preservation via `lstat` + `realpath` so dotfile-manager users keep their `~/.audit-loop.env → ~/dotfiles/...` symlink (Gemini-r3-r2 G1). |
| `scripts/sync-to-repos.mjs` D2b trigger | ✅ Done | End-of-sync auto-prompt; both `stdin.isTTY` AND `stdout.isTTY` required (Gemini-r3 G2 — CI hang fix). `_internals` test seam (R1-audit M16). |
| `scripts/install-prepush-hook.mjs` HOOK_BODY | ✅ Done | Bash sibling-scan aligned with JS resolveSourceRepo: single `sync-to-repos.mjs` sentinel instead of dual-file false-match (Gemini-r3 G1). |
| `scripts/check-setup.mjs` | ✅ Done | Uses `resolveCloudConfig` for effective-config evaluation; reports source attribution (process-env / shared / local / unset). |
| `scripts/lib/store/repo.mjs` cloud-disabled msg | ✅ Done | Recovery hint now points at `npm run setup:cloud`. |
| `scripts/.cli-catalog.json` + `package.json` | ✅ Done | New `setup:cloud` entry. |
| `tests/shared-cloud-config.test.mjs` | ✅ Done | 39 tests (1 skipped on Windows). Covers all assess outcomes + executor branches + tagged-union resolveSourceRepo + serializer edge cases including mixed-quote bare form + bare-form blockers + empty-string explicit override. |
| `tests/sync-shared-env-trigger.test.mjs` | ✅ Done | 12 tests via `_internals` import. ALREADY_CURRENT silent path + MISCONFIGURED advisory + structural import-form contract (matches static AND dynamic — R2-audit M6/M10). |
| `tests/config-shared-env.test.mjs` | ✅ Done | 7 subprocess-driven tests via committed fixture `tests/fixtures/config-shared-env-child.mjs` (R1-audit M19). Precedence + silent-no-op + one-time note + sentinel-suppression inheritance. |
| `tests/shared.test.mjs` symlink regression | ✅ Done | POSIX-only test for `atomicWriteFileSync` symlink preservation (Gemini-r3-r2 G1). |
| `AGENTS.md` "Shared cloud config for consumer repos" subsection | ✅ Done | Loader precedence + setup recipe + update path + opt-out. |

**Audit history**: GPT R1 (H:7 M:10 L:5) → R2 (H:4 M:10 L:3) → R3 (H:0 in-scope; HIGH plateau on pre-existing repo.mjs concerns deferred as debt). **Gemini ×5 rounds** — final verdict **APPROVE** with `claude_bias_detected: false`. Two pre-existing repo.mjs HIGH findings deferred as out-of-scope debt: schema qualification (H1) + `upsertRepoByUuid` race (H2) — atomic-upsert refactor warrants its own PR.

**Deviations from original plan**:
- Plan §6 wrote `# unmanaged — preserved across updates` as the section header. Code (and plan) now write a 3-line honest header explaining KEY=VALUE pairs survive but comments/formatting do not (Gemini-r3-r3 M4 — the original wording invited operators to add content that `dotenv.parse` silently strips).
- Plan §6 spec used loose `!== 'n' && !== 'no'` prompt validation. Actual code uses strict allowlist (`a === '' || a === 'y' || a === 'yes'`) to reject typos and pasted junk (R1-audit M3/M13). Plan synced to match (Gemini-r3-r3 G2).
- `resolveCloudConfig` now treats `peVal !== undefined` as the set test (instead of also requiring `peVal !== ''`). Explicit `export AUDIT_DB_URL=""` is a deliberate operator override that the diagnostic surface must report truthfully (Gemini-r3-r4 G2).
- `serializeEnvValue` mixed-quote handling: the original plan accepted "throw fail-fast" as the contract; Gemini-r3 correctly noted that dotenv reads bare/unquoted values verbatim, providing a lossless escape hatch. Implementation now attempts bare emission first; only throws when bare form has a blocker (newline / `#` / leading-quote / surrounding whitespace).

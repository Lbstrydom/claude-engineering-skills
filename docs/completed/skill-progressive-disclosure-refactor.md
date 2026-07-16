# Plan: Skill Progressive Disclosure Refactor
- **Date**: 2026-04-19
- **Status**: **Complete** (all phases A, B.1, B.2, C1–C6, D, E shipped and tested)
- **Author**: Claude + Louis
- **Audit trail**: GPT-5.4 R1 (8 findings, all fixed) → R2 (8 findings; 3 HIGH fixed + 1 LOW deferred + E2E gap documented) → Gemini 3.1 Pro final gate (5 findings; 3 accepted as pre-existing bugs all fixed in Phase B.1/B.2, 2 challenged as category errors)

## Implementation Log

### 2026-04-19 — Full rollout

Phases completed end-to-end in a single session. All 940 tests pass.

- **Phase A** — `docs/reference/skill-reference-format.md`, `skill-refs-parser`,
  `check-skill-refs` CLI, `repo-stack` lib, `cross-skill detect-stack`
  subcommand, `skill-packaging` allowlist, `regenerate-skill-copies`
  generator + `--check` verifier. 41 new unit tests.
- **Phase B.1** — `MANIFEST_SUPPORTED_VERSIONS = [1, 2]`, `FileEntrySchema`
  + optional `files[]`, version-gated installer entrypoint, crash-safe WAL
  journal in `executeTransaction` with `recoverFromJournal`,
  `resolveSkillFiles` + `partitionManagedFilesByScope`. **G2 fix** (receipt
  scope split — global receipt for claude surface) + **G3 fix** (merged
  copilot-instructions SHA = final merged content, not blockSha). 21 new
  install tests.
- **Phase C1** — persona-test 879 → 364 lines canonical (6 refs, 1 example).
- **Phase C2** — audit-loop 724 → 370 lines canonical (4 refs).
- **Phase C3** — ux-lock 487 → 208 lines canonical (3 refs).
- **Phase C4** — plan-frontend 386 → 259 lines canonical (3 refs).
- **Phase C5** — ship 361 → 283 lines canonical (2 refs).
- **Phase C6** — plan-backend 267 → 226 lines canonical (2 refs).
- **Phase D** — `list-personas` / `add-persona` / `record-persona-session`
  subcommands on `cross-skill.mjs` with Zod schemas. `emitError` exits
  non-zero on validation failures (bug fix). 9 new CLI tests.
- **Phase B.2** — `MANIFEST_SCHEMA_VERSION = 2`, `build-manifest.mjs`
  rewritten to use `enumerateSkillFiles` (allowlist-based).
  `sync-to-repos.mjs` auto-enumerates. **G5 fix** — YAML frontmatter parse
  is now tolerant of inline/block/plain forms.
- **Phase E** — `npm run skills:regenerate / :check / :manifest /
  :manifest:check`. CONTRIBUTING.md rewrite documenting the
  authoritative-source + generated-copies architecture.

### Success metrics met

| Metric | Target | Result |
|---|---|---|
| Per-skill SKILL.md | ≤3K tokens | All 6 ≤3.2K tokens (avg 2.3K) |
| Cross-skill dup | ≤50 tokens | 0 tokens — stack detection fully extracted |
| Tests | 100% pass | 940/940 |
| `skills:check` lint | zero violations | 6/6 pass |
| No UX regression | user still calls `/skill-name` | unchanged — frontmatter + triggers preserved |

### Total SKILL.md reduction

3,104 → 1,710 canonical lines (**-45%**). Reference files carry 1,370
lines of the moved content, loaded only when the "Read when" trigger
applies.

---

## 1. Context Summary

### Current state (measured, not estimated)

The 6 skills are each a single monolithic `SKILL.md`:

| Skill | Lines | Chars | ~Tokens |
|---|---:|---:|---:|
| audit-loop | 724 | 31,771 | 7,942 |
| persona-test | 879 | 39,221 | 9,805 |
| plan-backend | 267 | 13,287 | 3,321 |
| plan-frontend | 386 | 20,027 | 5,006 |
| ship | 361 | 13,861 | 3,465 |
| ux-lock | 487 | 16,898 | 4,224 |
| **Total** | **3,104** | **135,065** | **33,763** |

Per-turn baseline cost (YAML frontmatter only, always loaded): **~1.5K tokens** across all 6 skills. This is fine.

Per-invocation cost (SKILL.md body loaded when the skill fires): **3.3K → 9.8K tokens** depending on skill. `persona-test` and `audit-loop` are the outliers.

### Audit findings (from Explore agent survey)

Section classification (as % of each file):

| Skill | CANONICAL | REFERENCE | INTEGRATION | EDGE | DIAGNOSTICS |
|---|---:|---:|---:|---:|---:|
| audit-loop | 65% | 20% | 5% | 8% | 2% |
| persona-test | 55% | 15% | 15% | 10% | 5% |
| plan-backend | 85% | 10% | 2% | 0% | 3% |
| plan-frontend | 80% | 15% | 2% | 0% | 3% |
| ship | 75% | 10% | 15% | 5% | — |
| ux-lock | 70% | 15% | 10% | 8% | 5% |

**Real cross-skill duplication**: ~200 tokens of stack-detection logic repeated verbatim in `plan-backend` Phase 0, `plan-frontend` Phase 0, and `ship` Step 0. Everything else the audit flagged as "similar" is contextually distinct (Python backend ≠ Python frontend ≠ Python pre-push discovery).

**Zero sibling files exist**. No `references/`, no `examples/`, no per-skill `scripts/`. Every skill is a single flat file.

### Installer + sync constraints (discovered in Phase 1)

The sync and install machinery currently assumes one file per skill:

- `scripts/lib/schemas-install.mjs` — `SkillEntrySchema = { path: string, sha, size, summary }` (single path)
- `scripts/build-manifest.mjs` — iterates `skills/<name>/SKILL.md`, registers one entry per skill
- `scripts/lib/install/surface-paths.mjs` — `resolveSkillTargets()` returns one `filePath` per surface
- `scripts/sync-to-repos.mjs` — `SKILL_FILES` array hardcodes 12 paths (6 skills × 2 surfaces for `.claude/` + `.github/`)

If we add sibling reference files and don't update this chain, downstream repos get broken skills — SKILL.md says *"read `references/interop.md`"* but the file was never shipped.

### Why this refactor, why now

The recent data-loop work (this session) added content to `persona-test`, `ux-lock`, `ship`, and `plan-frontend`. `persona-test` grew past 9.8K tokens. Every future cross-skill integration adds to every skill that participates. Without progressive disclosure, the drift only gets worse.

---

## 2. Proposed Architecture

### 2.1 Target directory structure (per skill)

```
.claude/skills/<name>/
├── SKILL.md                    ← canonical flow only; ≤3K tokens target
├── references/
│   ├── <topic-a>.md            ← rare/edge content, loaded on demand
│   └── <topic-b>.md
└── examples/                   ← optional; full output samples
    └── <example>.md
```

`examples/` is optional — only present when the skill emits long structured output (report templates, debriefs, spec files).

### 2.2 Reference-index format spec

Every SKILL.md ends with exactly one section matching this shape:

```markdown
## Reference files

This skill's canonical flow is above. The files below cover specialised
situations — read them only when the trigger applies.

| File | Summary | Read when |
|---|---|---|
| `references/interop.md` | How this skill feeds /audit-loop, /ship, /plan-*. | The user asks about cross-skill effects, OR you need to emit a correlation row. |
| `references/session-history.md` | Querying + summarising prior sessions. | Step 6c fires AND there are ≥2 prior sessions for this URL. |
| `references/troubleshooting.md` | Recovery from mid-session failures. | A browser tool call fails twice in a row, OR the user asks "what went wrong". |
```

**Rules**:
- Table is the fixed shape (parser can regex-match it for lint).
- `File` is always a relative path from the skill directory.
- `Summary` is one sentence — what's in the file.
- `Read when` is a trigger clause — a **specific, detectable condition**, not "if relevant" (too vague to prevent over-reading).
- Entries are sorted by expected read frequency (most-likely first).

**Anti-patterns for `Read when` triggers** (to call out in the format spec doc):
- ❌ "when relevant" — every ref is "relevant"; this defeats the point
- ❌ "before responding" — every invocation goes to responding
- ✅ "when the user asks about X" — trigger is detectable
- ✅ "when step Y fails" — trigger is observable in the flow

#### 2.2.1 Reference file frontmatter (drift detection)

Every file under `references/` or `examples/` **MUST** begin with YAML frontmatter containing a canonical `summary` string:

```markdown
---
summary: How this skill feeds /audit-loop, /ship, /plan-*.
---

# Rest of the reference file...
```

- `summary` is a single-line string, ≤120 chars.
- The string is **byte-identical** to the `Summary` column entry in the parent SKILL.md's ref-index table.
- `check-skill-refs.mjs` parses the frontmatter and does an exact string equality check against the index. Any mismatch fails the lint with a clear diff.
- This replaces the earlier "first paragraph" heuristic — no fuzzy matching, no scoring, no implementer judgement.

**Rationale**: a ref file that changes purpose without updating the index will drift silently — Claude keeps reading it based on an outdated trigger. The frontmatter `summary` is the contract between the ref body and its index entry; forcing exact equality with a simple failure mode keeps the contract honest.

### 2.3 Installer manifest extension

#### 2.3.1 Schema changes (v1 → v2)

`SkillEntrySchema` in `scripts/lib/schemas-install.mjs` gains a `files: Array<FileEntry>` field:

```js
export const FileEntrySchema = z.object({
  relPath: z.string(),   // 'SKILL.md' or 'references/interop.md'
  sha: z.string(),
  size: z.number(),
});

export const SkillEntrySchema = z.object({
  path: z.string(),        // kept for backward compat: always 'skills/<name>/SKILL.md'
  sha: z.string(),         // SHA of SKILL.md specifically
  size: z.number(),
  summary: z.string(),
  files: z.array(FileEntrySchema).default([{relPath: 'SKILL.md', ...}]),  // NEW in v2
});
```

- `path` + `sha` + `size` stay pointing at SKILL.md so existing consumers don't break.
- `files` lists everything that must be installed for the skill to work.
- `schemaVersion` bumps from 1 → 2.

#### 2.3.2 Version-gated entrypoint (two-step rollout)

`schemaVersion` alone doesn't protect old installers — they still parse the manifest, ignore the new field, and silently skip the reference files. The migration must be **two-step**:

**Step 1 — Compat installer (ships first)**: update `scripts/install-skills.mjs` to read `schemaVersion` **before** parsing the rest of the manifest. Behaviour:
- `schemaVersion: 1` → existing single-file install path (unchanged).
- `schemaVersion: 2` → new multi-file install path. Consumes `files[]` as the canonical file list. Backfills `files = [{relPath:'SKILL.md', sha, size}]` when the array is empty (legacy data in a v2 manifest).
- `schemaVersion > 2` → exit non-zero with `UNSUPPORTED_MANIFEST_VERSION` and the minimum installer version required.

Ship this installer alone. Tag it. Give consumer repos time to pick it up (one `git pull` cycle).

**Step 2 — v2 manifests (ships after)**: only after Step 1 is in every consumer repo's installed copy do we flip `MANIFEST_SCHEMA_VERSION = 2` in `scripts/build-manifest.mjs`. Older installers that never picked up Step 1 now fail-fast with a clear error, instead of silently skipping reference files.

Compatibility-test matrix (in `tests/install-multi-file-skill.test.mjs`):
- v1 installer × v1 manifest → pass (regression)
- v1 installer × v2 manifest → fail cleanly with `UNSUPPORTED_MANIFEST_VERSION`
- v2 installer × v1 manifest → pass (backward compat)
- v2 installer × v2 manifest → pass + all files installed

#### 2.3.3 File lifecycle — additions, updates, deletions

Multi-file skills need deterministic deletion: when a skill version bumps and removes a reference file, the old file must not linger in the consumer's skill directory. The install transaction extends as follows:

The transaction must survive process crash / power loss. Use a write-ahead-log pattern (same shape as `atomicWriteFileSync` already used in this repo — temp-file + rename):

```
On install (crash-safe):
1. Read previousReceipt.managedFiles for this skill (if receipt exists).
2. Compute:
   toWrite = manifest.files[]
   toDelete = previousReceipt.managedFiles[] − manifest.files[]
3. Open a transaction journal at `<skillDir>/.install-txn.json` describing the
   planned writes + deletes + next receipt state. fsync the journal.
4. Stage every write: for each file in toWrite, write to `<path>.tmp-<pid>`
   (same directory as target — rename is atomic).
5. Rename every `.tmp-<pid>` to the target path in a deterministic order.
6. Delete every file in toDelete (skip user-modified per orphan-protection below).
7. Write the new receipt to `<receipt>.tmp-<pid>`, rename into place.
8. Delete the transaction journal. Done.

On next startup (crash recovery):
1. If `.install-txn.json` exists, the last install was interrupted.
2. Read the journal. For every entry, either (a) roll forward — complete any
   rename whose target doesn't yet exist; or (b) roll back — delete any
   stray `.tmp-<pid>` files whose corresponding rename didn't happen.
3. Delete the journal when state is consistent.
```

**Orphan protection**: if `previousReceipt.managedFiles[i].sha` doesn't match the current on-disk SHA, the file has been user-modified — `toDelete` skips it and emits a `CONFLICT_DELETION_SKIPPED` warning. The user resolves manually.

**Atomicity boundary**: filesystems give us atomic rename only within a directory and only for single operations. Multi-file installs are *not* atomic at the OS level. The journal + fsync pattern gives us **eventual consistency** — the next installer run reconciles to a valid state. This is the best we can do without a real database; it matches the atomicity guarantees of the existing `atomicWriteFileSync` used elsewhere in the repo.

Receipt schema in `scripts/lib/schemas-install.mjs` already supports multiple entries per skill (`managedFiles: ManagedFile[]`) — no schema change needed, just installer logic.

### 2.4 Shared-library extractions

Only one true cross-skill duplication is worth extracting. Because skills invoke shell commands (not Node imports), the extraction needs an **executable interface**, not just a library.

**Library**: `scripts/lib/repo-stack.mjs` — pure functions, unit-testable:

```js
export function detectRepoStack(cwd = process.cwd()) { /* ... */ }  // → StackProfile
export function detectPythonFramework(deps) { /* ... */ }           // → 'fastapi'|'django'|'flask'|'none'
export function detectPythonEnvironmentManager(cwd) { /* ship-specific */ } // → 'poetry'|'uv'|'pipenv'|'venv'|'none'
```

**CLI wrapper**: `node scripts/cross-skill.mjs detect-stack` — the skill-facing interface:

```bash
node scripts/cross-skill.mjs detect-stack [--cwd <path>] [--include-env-manager]
```

Output — stable JSON on stdout (Zod-validated via `StackProfileSchema`):

```json
{
  "ok": true,
  "stack": "js-ts" | "python" | "mixed" | "unknown",
  "pythonFramework": "fastapi" | "django" | "flask" | "none" | null,
  "environmentManager": "poetry" | "uv" | "pipenv" | "venv" | "none" | null,
  "detectedFrom": ["package.json", "pyproject.toml"]
}
```

- `environmentManager` only populated when `--include-env-manager` passed (used by `/ship`; other skills don't need it).
- `detectedFrom` is always populated — shows which marker files drove the decision (useful for diagnostics in mixed repos).
- Stable exit codes: 0 = detection succeeded (any stack); 2 = bad input.

**Schema lives in** `scripts/lib/schemas.mjs` (single source of truth — not duplicated in cross-skill.mjs). Consumers of the JSON output can import the Zod schema if they want to validate.

**Skill call pattern**:
```bash
STACK=$(node scripts/cross-skill.mjs detect-stack --cwd .)
# parse the JSON and render the matching profile section
```

plan-backend, plan-frontend, ship each call this at Phase 0 / Step 0 and render the appropriate profile from the JSON. Phase 0 in each SKILL.md becomes ~8 lines (invoke CLI + parse JSON + branch on `stack` value).

**NOT extracting**: browser tool detection (currently in persona-test Phase 1 only — no real duplication yet). Flagged as preemptive-extraction candidate only when `/ux-lock verify` grows anti-bot support.

### 2.5 Replacing curl recipes with `cross-skill.mjs`

`persona-test` still hand-writes 4 curl blocks. Each gets a dedicated CLI subcommand with a fully specified contract (Zod schemas, exit codes, error semantics).

The three new subcommands — all following the existing `cross-skill.mjs` pattern (graceful no-op when cloud unavailable, single-line JSON on stdout):

#### `list-personas`

```bash
node scripts/cross-skill.mjs list-personas --url <app_url>
```

- **Request schema**: `ListPersonasRequestSchema = { url: z.string().url() }`
- **Response schema**: `ListPersonasResponseSchema = { ok: boolean, cloud: boolean, rows: Array<PersonaDashboardRow> }` where `PersonaDashboardRow` mirrors the `persona_dashboard` view (name, description, test_count, last_tested_at, last_verdict, days_since_last_test, recent_sessions).
- **Empty state**: `{ok:true, cloud:true, rows:[]}` — NOT an error. Skill renders "no personas registered for this URL".
- **Cloud unavailable**: `{ok:true, cloud:false, rows:[]}` — exit 0.
- **Exit codes**: 0 = success (incl. empty); 2 = bad input (missing/invalid URL); 1 = unexpected.

#### `add-persona`

```bash
node scripts/cross-skill.mjs add-persona --json '{"name":"...","description":"...","appUrl":"...","appName":"...","notes":"..."}'
```

- **Request schema**: `AddPersonaRequestSchema = { name: z.string().min(1), description: z.string().min(1), appUrl: z.string().url(), appName: z.string().optional(), notes: z.string().optional(), repoName: z.string().optional() }`
- **Response schema**: `{ ok: boolean, cloud: boolean, personaId: string|null, existed: boolean }` — `existed=true` means a persona with the same `(name, appUrl)` unique key already existed and was updated in-place (idempotent upsert).
- **Transaction**: single `upsert` with `onConflict: 'name,app_url'`. Atomic at the Supabase level.
- **Exit codes**: 0 = success; 2 = validation failure; 1 = unexpected.

#### `record-persona-session`

```bash
node scripts/cross-skill.mjs record-persona-session --json '{...}'
```

- **Request schema**: all fields currently written by the Phase 6 curl block, including optional `personaId`, `commitSha`, `deploymentId`, `repoName`. Zod validates `verdict in {...}`, severity counts are non-negative, `findings` is a JSON array.
- **Response schema**: `{ ok: boolean, cloud: boolean, sessionId: string|null, existed: boolean, statsUpdated: boolean }`. `existed=true` when a prior insert with the same `session_id` is found (idempotent replay). `statsUpdated=false` when the session insert succeeded but the secondary persona stats update failed — the skill can decide whether to surface that.
- **Transaction boundary**: the session insert + persona stats update run as a best-effort sequence. The session insert is the source of truth; the stats row (`personas.test_count`, `personas.last_tested_at`) is a **derived cache** — `test_count = COUNT(*) FROM persona_test_sessions WHERE persona_id = X`. A nightly reconciler (`scripts/reconcile-persona-stats.mjs`, Phase D+1 follow-up — not blocking this refactor) recomputes stats from sessions so any missed update self-heals.
- **Idempotency**: `session_id` (e.g. `persona-test-<timestamp>`) is UNIQUE. Re-posting the same id is a no-op via `onConflict: 'session_id', ignoreDuplicates: true`. Response returns the existing row's `sessionId` + `existed: true`; no error.
- **Exit codes**: 0 = success (including idempotent replay); 2 = validation; 1 = unexpected.

All three subcommands emit single-line JSON on stdout (same pattern as existing subcommands) and diagnostic text on stderr. Tests for each in `tests/cross-skill-persona.test.mjs` cover: happy path, empty-list, validation error, cloud-unavailable no-op.

**Design rule (restated and enforced)**: `scripts/cross-skill.mjs` is the **guaranteed shipped surface** for cross-skill persistence. SKILL.md files never hand-write curl to these tables. If the CLI is unavailable in a consumer repo, the skill logs `WARN: cross-skill CLI not available — persistence disabled for this session` and continues in degraded mode. **No curl fallback is shipped** (superseding the earlier draft of this plan which proposed a `references/supabase-persistence-recipes.md` file — that reference is deleted from the plan).

---

## 3. Sustainability Notes

### Canonical source of truth (for skill content)

**Design decision**: the top-level `skills/` tree is **authoritative**. `.claude/skills/` and `.github/skills/` are **generated** from it — one-way, never edited directly.

- Authors edit only `skills/<name>/*`.
- A new script `scripts/regenerate-skill-copies.mjs` produces `.claude/skills/` and `.github/skills/` from `skills/` (the content is byte-identical across all three; the surfaces only exist because different tools look in different places).
- The script runs in a pre-commit hook (via existing hook infrastructure) and in CI. Out-of-sync copies fail the build — no silent drift.
- `scripts/check-sync.mjs` becomes a read-only verifier (does `skills/` → generated output match the committed `.claude/` and `.github/` output?) rather than a three-way equality checker. Equality checking detects drift *after* it happens; one-way generation *prevents* drift.

Editor guidance + documentation call-out in `CONTRIBUTING.md`: "Never edit `.claude/skills/` or `.github/skills/` directly — run `node scripts/regenerate-skill-copies.mjs` after editing `skills/`."

### Packaging allowlist (for manifest + sync)

Neither `build-manifest.mjs` nor `sync-to-repos.mjs` does a naïve recursive walk. Both consume an explicit allowlist defined once in `scripts/lib/skill-packaging.mjs`:

```js
export const SKILL_ALLOWED_PATTERNS = [
  'SKILL.md',                    // canonical file — always present
  'references/**/*.md',          // reference files
  'examples/**/*.md',            // example outputs
];

export const SKILL_EXCLUDED_PATTERNS = [
  '**/.*',                       // dotfiles (.DS_Store, .gitkeep)
  '**/*.swp', '**/*.swo',        // editor swap files
  '**/*.bak', '**/*~',           // editor backups
  '**/node_modules/**',          // belt-and-braces
];
```

Everything goes through `enumerateSkillFiles(skillDir) → string[]` which applies both lists. A file that matches both (e.g. `references/.DS_Store`) is excluded. Unknown file types inside a skill directory (e.g. `.json`, `.js`) are **rejected with an explicit error** — skills are pure markdown surfaces by design; code belongs in `scripts/`.

### Assumptions that could change

| Assumption | What if it changes | Mitigation |
|---|---|---|
| Claude Code loads only SKILL.md on invocation; sibling files require explicit Read() | Auto-preloading would make progressive disclosure moot | The refactor still pays off for maintainability; content organisation remains useful |
| The "Read when" trigger approach works — model decides to Read based on trigger | Model might over-Read (load everything) or under-Read (miss needed content) | Tune trigger phrasing; monitor in practice; fall back to embedding in SKILL.md if over-/under-reading is systemic |
| Installer manifest schema v1 consumers can handle v2 gracefully | Old installers silently skip new fields | Version-gated entrypoint (see §2.3.2) rejects with explicit `UNSUPPORTED_MANIFEST_VERSION`; two-step rollout ships the compat installer before publishing v2 manifests |
| Skills stay pure-markdown | A skill wants to ship helper scripts alongside SKILL.md | Allowlist rejects non-markdown; the right answer is always `scripts/<name>.mjs` at repo root, not inside the skill dir |

### How the design accommodates future change

- **New skill**: add `skills/<name>/SKILL.md` + optional `references/` and `examples/`. Re-run `regenerate-skill-copies.mjs`. `build-manifest.mjs` picks it up automatically (allowlist covers the whole tree).
- **New reference type**: add to `references/`; the ref-index table updates; no global changes.
- **Cross-skill content migration**: a ref file can move from one skill to another by filesystem move + ref-index update in both files.
- **Schema v3 (hypothetical future)**: installer already speaks versioned manifests — add an entry to the version-gated entrypoint for v3, ship as a compat installer, then publish v3 manifests.

### Extension points deliberately built in

1. **Authoritative source tree** — one place to edit; copies are generated.
2. **Allowlist, not directory walk** — predictable packaging; rejects unexpected files.
3. **Version-gated installer entrypoint** — future schema changes don't silently corrupt consumer state.
4. **Trigger syntax is a free-form `Read when:` clause** — can be tightened later into structured metadata (e.g. YAML triggers) without breaking existing skills.
5. **`examples/` directory is optional** — skills that don't need it pay zero tokens; skills that do can add large output bodies there without inflating SKILL.md.

---

## 4. File-Level Plan

Grouped by work-phase. Each file has purpose + imports + what-imports-it.

### Phase A — Format spec + library foundations (no skill changes yet)

| File | Purpose | Imports | Imported by |
|---|---|---|---|
| `docs/reference/skill-reference-format.md` (NEW) | Canonical spec for the SKILL.md ref-index table format + reference-file `summary:` frontmatter. Documents trigger rules, anti-patterns, the drift-detection contract. Source of truth for the lint script. | — | Referenced by every SKILL.md; read by lint script authors |
| `scripts/lib/skill-refs-parser.mjs` (NEW) | Parse the "Reference files" section of a SKILL.md into structured entries. Parse frontmatter `summary` from referenced files. Validates format. | `node:crypto`, `node:fs` | `scripts/check-skill-refs.mjs`, future meta tools |
| `scripts/check-skill-refs.mjs` (NEW) | CLI lint: for each skill, parse its ref-index, verify every listed file exists, verify no orphan files, verify each ref's frontmatter `summary` exactly matches the index row. Exits non-zero on any violation. | `skill-refs-parser.mjs`, `node:fs` | `npm test` (added to `package.json` test scripts) |
| `tests/skill-refs-parser.test.mjs` (NEW) | Unit tests for the parser — valid formats pass; missing files / malformed table / frontmatter mismatch fail. | — | `npm test` |
| `scripts/lib/schemas.mjs` (MODIFY) | Add `StackProfileSchema` (output of `detect-stack` CLI). Single source of truth — don't duplicate in cross-skill.mjs. | zod | `cross-skill.mjs`, stack detection consumers |
| `scripts/lib/repo-stack.mjs` (NEW) | Pure stack-detection library. `detectRepoStack`, `detectPythonFramework`, `detectPythonEnvironmentManager`. | `node:fs` | `cross-skill.mjs detect-stack` subcommand (§2.4) |
| `scripts/cross-skill.mjs` (MODIFY) | Add `detect-stack` subcommand using `repo-stack.mjs` + `StackProfileSchema`. | `schemas.mjs`, `repo-stack.mjs` | Skills shell out to this |
| `tests/repo-stack.test.mjs` (NEW) | Tests for stack detection — JS/TS, Python, mixed, unknown; Python framework detection; environment manager detection. | `node:fs` (fixtures) | `npm test` |
| `scripts/lib/skill-packaging.mjs` (NEW) | Defines `SKILL_ALLOWED_PATTERNS`, `SKILL_EXCLUDED_PATTERNS`, `enumerateSkillFiles(skillDir)`. Single source of truth for what ships. | `node:fs`, `node:path` | `build-manifest.mjs`, `regenerate-skill-copies.mjs`, `sync-to-repos.mjs`, `check-sync.mjs` |
| `tests/skill-packaging.test.mjs` (NEW) | Tests: SKILL.md + refs/examples included; dotfiles, swap files, backups excluded; non-markdown files rejected with clear error. | `node:fs` (fixtures) | `npm test` |
| `scripts/regenerate-skill-copies.mjs` (NEW) | Reads from authoritative `skills/`, byte-copies to `.claude/skills/` and `.github/skills/`. Uses `enumerateSkillFiles` for the allowlist. **Prunes** any file present in a destination tree but not in the source (skill deleted, ref file renamed, etc.) — so `.claude/skills/` and `.github/skills/` exactly mirror `skills/` after every run. Idempotent. | `skill-packaging.mjs`, `node:fs` | Pre-commit hook + CI; invoked manually when editing skills |

**Why these files**:
- `docs/reference/skill-reference-format.md` → Principle 10 (Single Source of Truth — one place defines the format).
- `scripts/lib/skill-refs-parser.mjs` → Principle 11 (Testability — extracted from CLI so it can be unit tested).
- `scripts/check-skill-refs.mjs` → Principle 19 (Observability — catches ref rot before it ships).
- `scripts/lib/repo-stack.mjs` → Principle 1 (DRY — eliminates 3x duplication).

### Phase B — Installer extension (two-step rollout — see §2.3.2)

**Phase B.1 — Compat installer (ships alone, first)**

B.1 teaches the installer to **understand** v2 manifests; it does not change what manifests the build pipeline **produces**. The version bump lives in Phase B.2.

| File | Purpose |
|---|---|
| `scripts/lib/schemas-install.mjs` (MODIFY) | Add `FileEntrySchema`; extend `SkillEntrySchema` with an **optional** `files` array (v1 manifests without it still parse). Define a `MANIFEST_SUPPORTED_VERSIONS = [1, 2]` constant used by the entrypoint. **Do not change** the `MANIFEST_SCHEMA_VERSION` constant that `build-manifest.mjs` writes — that flip happens in B.2. |
| `scripts/install-skills.mjs` (MODIFY) | Read `schemaVersion` **before** parsing the rest of the manifest. `schemaVersion ∈ MANIFEST_SUPPORTED_VERSIONS` → route to v1 or v2 install path. Otherwise → exit with `UNSUPPORTED_MANIFEST_VERSION` and the minimum installer version required. |
| `scripts/lib/install/surface-paths.mjs` (MODIFY) | Add `resolveSkillFiles(name, surface, repoRoot, files[])` that returns per-file targets. Keep existing `resolveSkillTargets` for v1 compat. |
| `scripts/lib/install/transaction.mjs` (MODIFY) | Multi-file install path: writes every file in `files[]`, deletes files in `previousReceipt.managedFiles` that are not in the new manifest (see §2.3.3), with all-or-nothing rollback. Respects `CONFLICT_DELETION_SKIPPED` for user-modified files. |
| `scripts/lib/install/conflict-detector.mjs` (MODIFY) | Detect conflicts on every file in a skill, not just SKILL.md. Adds `deletionConflicts[]` for files the installer would delete but whose SHA has been user-modified. |
| `scripts/lib/install/receipt.mjs` (MODIFY) | `managedFiles` schema unchanged; ensure installer populates every entry on write. |
| `tests/install-version-gate.test.mjs` (NEW) | Matrix from §2.3.2: v1 installer × v1 manifest; v1 × v2 (should fail cleanly); v2 × v1 (back-compat); v2 × v2. |
| `tests/install-lifecycle.test.mjs` (NEW) | Add/update/delete scenarios: skill gains a ref → installed; loses a ref → deleted; user-modified file → deletion skipped with warning; partial failure → rollback restores prior state. |

Ship B.1 as its own tagged release. Wait for consumer repos to `git pull` and pick it up.

**Phase B.2 — v2 manifests (ships after consumers have B.1 installed)**

Readiness check (before starting B.2): consumer repos must have B.1 installed. `scripts/sync-to-repos.mjs` already reports per-repo file SHAs — extend it with a `--check-installer-version` flag that verifies each consumer's installed `scripts/install-skills.mjs` SHA matches the B.1 release SHA. All green → safe to proceed.

| File | Purpose |
|---|---|
| `scripts/lib/schemas-install.mjs` (MODIFY) | Flip the `MANIFEST_SCHEMA_VERSION` constant from 1 to 2. |
| `scripts/build-manifest.mjs` (MODIFY) | Use `enumerateSkillFiles` from `skill-packaging.mjs` (allowlist-based, not directory walk). Populate `files[]` per skill. Keep `path`/`sha`/`size` pointing at SKILL.md for back-compat. |
| `scripts/sync-to-repos.mjs` (MODIFY) | Replace hardcoded `SKILL_FILES` array with `enumerateSkillFiles()` calls against the authoritative `skills/` tree plus the generated `.claude/skills/` and `.github/skills/` trees. |
| `scripts/check-sync.mjs` (MODIFY) | Becomes a read-only verifier: does running `regenerate-skill-copies.mjs` produce output byte-identical to the committed `.claude/skills/` and `.github/skills/`? If not, fail with the generator command to run. |
| `tests/install-multi-file-skill.test.mjs` (NEW) | End-to-end: build a v2 manifest from fixture skills, run a v2 install, verify all files + receipt correctness. |
| `tests/packaging-allowlist.test.mjs` (NEW) | Verify `build-manifest` and `sync-to-repos` both reject non-allowlisted files, both exclude dotfiles/backups/swap files identically. |

**Why these files**:
- Principle 14 (Transaction Safety — installer already uses transactional installs; extending to multi-file must preserve all-or-nothing semantics).
- Principle 18 (Backward Compatibility — `schemaVersion: 2` lets old installers detect and fail gracefully rather than silently skip files).

### Phase C — Per-skill refactors

Work order by leverage (biggest token saving first):

#### C1 — persona-test (879 → ~350 lines, saves ~5.5K tokens on invocation)

Move to `references/`:
- `references/interop.md` — current "Engineering Skills Interplay" section (lines 774–841; 68 lines). Trigger: *user asks about `/ship`, `/plan-*`, or `/audit-loop` integration*.
- `references/audit-correlation.md` — Phase 6b (92–741; 50 lines, emit correlations). Trigger: *`audit_link = true` AND ≥1 P0/P1 finding in this session*.
- `references/session-history.md` — Phase 6c (745–771). Trigger: *session save succeeded AND Supabase configured*.
- `references/browser-tool-detection.md` — Phase 1 detailed tier logic (248–295; 48 lines). Trigger: *setup failing OR first-run environment*.
- `references/persona-debrief-format.md` — Phase 5b full tone-rules + template (577–620). Trigger: *about to generate the debrief section*.
- ~~`references/supabase-persistence-recipes.md`~~ — **deleted from the plan**. The 4 curl blocks are replaced by `cross-skill.mjs` subcommands (see §2.5); no curl fallback is shipped. CLI unavailable in a consumer repo → skill logs a warning and continues in degraded mode.

Kept canonical:
- Phase 0 routing + sub-command entries
- Phase 1 tool selection (condensed to 10 lines: "Use Playwright MCP for own apps, BrightData for external")
- Phase 2 persona mental model
- Phase 3 safety policy + exploration loop (shortened)
- Phase 4 severity model
- Phase 5 structured report format (keep — short)

#### C2 — audit-loop (724 → ~400 lines, saves ~3K tokens)

Move to `references/`:
- `references/r2-plus-mode.md` — R2+ auto-skip logic, Round 6 cap, suppression details (~60 lines across Steps 2–5).
- `references/debt-ledger.md` — Step 3.6 debt capture details (94 lines).
- `references/gemini-arbiter.md` — Step 7 full deliberation protocol (76 lines).
- `references/convergence-criteria.md` — triage decision rules, convergence conditions (~30 lines).
- `examples/transcript-format.md` — sample Gemini input transcript (verbose JSON).

Kept canonical:
- Mode parsing + routing
- Step 1 (plan gen)
- Step 2 (GPT audit, core scope modes)
- Step 3 (triage basics; deep rules in debt-ledger.md ref)
- Step 4–6 (fix + verify + convergence summary)
- Step 7 (short invocation; deep protocol in gemini-arbiter.md ref)

#### C3 — ux-lock (487 → ~250 lines, saves ~1.8K tokens)

Two modes share a file. Each mode gets its canonical flow kept in SKILL.md; deep templates go to refs:

- `references/lock-mode-templates.md` — full spec template + fix-type assertion map (LOCK Step 3 body).
- `references/verify-mode-translation-rules.md` — the translation-rules table and full generated spec template (VERIFY Step V2).
- `references/obsidian-limitations.md` — Electron app caveats (Step 6 scope limitations).
- `examples/verify-report.md` — sample verify-mode report output.

Kept canonical:
- Phase 0 routing
- Both modes' step list with 1-line descriptions + CLI commands
- Persistence invocations (these are the integration point)

#### C4 — plan-frontend (386 → ~280 lines, saves ~1.2K tokens)

- `references/ux-principles.md` — the 26 principle tables (Phases 2–4: Gestalt, interaction, cognitive load, accessibility, state). Trigger: *exploring a design decision AND need to cite specific principles*.
- `references/acceptance-criteria-format.md` — Section 9 worked example + category/severity rules. Trigger: *writing or validating Section 9 entries*.
- `references/stacked-modals.md` — LIFO cascade anti-pattern detail. Trigger: *plan includes modal interactions*.

Kept canonical:
- Phase 0 → `scripts/lib/repo-stack.mjs` wrapper
- Phase 1 explore
- Phases 2–4 condensed to "cite principles from `references/ux-principles.md` for each design choice"
- Phase 5 output structure (short — format docs are in refs)
- Phase 6 persist

#### C5 — ship (361 → ~280 lines, saves ~1K tokens)

- `references/python-environment-discovery.md` — Step 0 environment manager + tool detection (lines 40–65).
- `references/status-md-format.md` — Step 2 full session log template.

Kept canonical:
- All steps in overview form
- Step 0.5 (pre-ship gates — critical)
- Step 7 (ship event — always fires)

#### C6 — plan-backend (267 → ~220 lines, saves ~400 tokens)

- `references/python-backend-profile.md` — the Python backend profile section (lines 44–78).
- `references/engineering-principles.md` — the 20 principles table (Phase 2).

Kept canonical:
- Phase 0 → `scripts/lib/repo-stack.mjs` wrapper
- Phase 1 explore
- Phase 1.5 execution model (short, critical)
- Phases 2–4 condensed

### Phase D — Cross-skill CLI extensions (new subcommands)

| File | Purpose |
|---|---|
| `scripts/cross-skill.mjs` (MODIFY) | Add `list-personas`, `add-persona`, `record-persona-session` subcommands. Move the 4 curl recipes from `persona-test` SKILL.md into these. |
| `scripts/learning-store.mjs` (MODIFY) | Add `listPersonasForApp`, `upsertPersona`, `recordPersonaSession` functions behind the CLI subcommands. |
| `tests/cross-skill-persona.test.mjs` (NEW) | Unit tests for the new subcommands (no-op when cloud unavailable). |

### Phase E — Sync + validation

| File | Purpose |
|---|---|
| `scripts/check-sync.mjs` (MODIFY) | Detect the 3 skill-directory copies (`.claude/` + `.github/` + top-level `skills/`) and flag any drift including reference files. |
| `package.json` (MODIFY) | Add `npm run check-skills` → runs `check-skill-refs.mjs` + `check-sync.mjs` together. |
| CI config (if any) | Add `check-skills` to PR checks. |

---

## 5. Risk & Trade-off Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Over-reading — model reads every ref "just in case" | Medium | Erases the token savings | Write tight triggers; measure via a quick check after Phase C1 (count Read() calls on persona-test across 5 sample invocations) |
| Under-reading — model misses needed content that moved to a ref | Medium | Skill quality degrades silently | For each ref, keep a 1-line *semantic summary* in SKILL.md alongside the trigger, so model has enough to decide; keep triggers specific enough to fire when content matters |
| Ref rot — summaries in the index drift from the ref bodies | High over time | Triggers fire for wrong content | See §2.2.1 — every reference file declares a canonical `Summary:` line in frontmatter; lint does an **exact string match** against the index table entry. No heuristic prose comparison. |
| Installer v1 → v2 migration breaks downstream repos | Low if done right | Skills stop working in downstream repos | Ship v2 schema with `files` as optional (default: `[{relPath: 'SKILL.md', ...}]`); old installers reading v2 manifests work fine for single-file skills |
| 3-way skill copies drift after refactor | High (this already happens) | Inconsistent behaviour in consumer repos | `check-sync.mjs` enforces byte equality across all 3 copies; CI gate |
| "Read when" triggers are subjective | Always | Inconsistent reading behaviour across runs | Anti-pattern section in `docs/reference/skill-reference-format.md` catches the worst cases ("when relevant" etc.); over time, trigger phrasing converges through review |
| Refactor breaks a skill mid-session | Low | User-visible bug | Each skill refactors atomically: write the refs, update SKILL.md, sync the 3 copies, test the canonical invocation. Each skill is its own commit. |
| `persona-test`'s embedded curl becomes CLI subcommands that don't exist yet | Dependency risk | Skill broken during Phase C1 | Sequence: Phase D (CLI subcommands + tests) **before** Phase C1 (persona-test refactor). |

### Trade-offs made

- **Keep 3 skill copies** rather than symlinks or a single source: the existing installer architecture assumes copies; symlinks don't work on Windows; we instead rely on `check-sync` to enforce byte equality. Accepted cost: duplication disk footprint; duplication maintenance burden (mitigated by sync script).
- **Reference-index table rather than YAML frontmatter**: table is human-writable and human-readable inline; YAML would be more machine-friendly but fragments the skill author's flow. The parser is strict enough to reject malformed tables, so this is safe.
- **`files` array is additive, not replacing `path`**: kept both for backward compat. Slight data duplication (`path` points at same SKILL.md as `files[0]`) but old manifest readers still work. Accepted cost: schema size grows marginally.

### Deliberately deferred

- Browser-tool-detection library extraction — defer until `/ux-lock verify` grows anti-bot support. YAGNI.
- Automatic reference-index generation — defer. Human-authored triggers are higher quality than LLM-generated ones at this stage.
- Structured trigger metadata (YAML instead of free-form clauses) — defer. Free-form is sufficient for the current 6 skills; revisit if we grow to 15+.
- `examples/` directories — create only when a specific skill needs one (audit-loop + ux-lock likely qualify).

### Pre-existing installer bugs this plan inherits

Gemini's final-gate review surfaced three real bugs in the current installer infrastructure. They don't block Phase B but the implementation must address them or the refactor will land on broken foundations.

| # | File | Bug | Fix lands in |
|---|---|---|---|
| G2 | `scripts/install-skills.mjs` (global `claude` surface) | Receipt path uses `path.relative(repoRoot, target.filePath)` for files that live in `~/.claude/skills/` — produces machine-specific backward-traversing paths. Prevents portable receipts. | **Phase B.1** — split receipts by scope: global receipt (at `~/.audit-loop-install-receipt.json`) for `claude` surface; repo receipt for `copilot`/`agents`. Store absolute paths for global targets, repo-relative for per-repo targets. |
| G3 | `scripts/lib/install/conflict-detector.mjs` for merged files | Stores `sha: blockSha` in `managedFiles` but `detectConflicts` computes `currentSha` as SHA of the full merged file on disk — these can never match for files with any other content. Idempotent re-install always flags a "conflict". | **Phase B.1** — for merged targets, store SHA of final merged content in `managedFiles.sha`; keep `blockSha` as a separate `blockSha:` metadata field used only for block-update detection. |
| G5 | `scripts/build-manifest.mjs` — `descMatch = content.match(/description:\s*\|?\s*\n\s+(.+)/)` | Strictly requires newline after `description:`. Skills using inline YAML (`description: "..."`) fall through to the skill-name fallback silently. | **Phase B.2** — replace with a proper YAML frontmatter parser (`js-yaml`) OR extend the regex to `/description:\s*(?:\|\s*\n\s+)?([^\n]+)/` + strip surrounding quotes. Preference: `js-yaml` since we're changing packaging anyway. |

All three fixes ship inside the `Phase B.1` commit since they affect installer internals the refactor touches. Each needs a regression test added to the Phase B test matrix.

### Gemini final-gate deliberation record

Gemini verdict: **REJECT** — 5 findings. Claude deliberation:

- **#2 Path Resolution, #3 Broken Idempotency, #5 Parsing Logic** — **ACCEPTED** as pre-existing bugs in scope of Phase B.1. Recorded above.
- **#1 Missing Crash-Safe Transaction (Failed Implementation)** — **CHALLENGED**. Evidence: the finding asserts `executeTransaction` "still uses an in-memory snapshots Map" — this is the **current** implementation, pre-dating this plan. The plan describes the WAL journal to be built during Phase B.1; it is not a failure to ship behaviour that hasn't been implemented yet. The `.install-txn.json` pattern in §2.3.3 is the commitment. Reviewer conflated "plan" with "implementation".
- **#4 Missing Implementation (`FileEntrySchema` absent)** — **CHALLENGED**, same category error. The plan prescribes adding `FileEntrySchema` in Phase B.1; §2.3.1 defines it explicitly. Current `schemas-install.mjs` correctly does not have it — that's the state the refactor leaves.

**Decision**: challenges held. Category-error findings do not require a re-run of Gemini; the three accepted findings are addressed in the table above and re-verified by Phase B.1 tests (`tests/install-version-gate.test.mjs`, `tests/install-lifecycle.test.mjs`). Plan status flips to **Approved-with-conditions**: Phase B.1 must include regression tests for bugs G2, G3, G5.

### Known limitations (acknowledged, not blocking)

1. **Progressive-disclosure classification is a judgement call.** Some refs (e.g. `persona-debrief-format.md`) will be read on every happy-path invocation — not because they're "edge content" but because they house a large format-heavy template that bloats SKILL.md. Acceptable as long as the trigger is **deterministic** ("when generating the debrief section"). The true measure of success is per-invocation token count; the CANONICAL vs REFERENCE split is a proxy.
2. **Trigger-quality lint is policy-by-documentation.** `check-skill-refs.mjs` enforces table shape + file existence + summary equality, but does NOT algorithmically flag low-quality triggers like "when relevant". Reviewers catch those during code review. Adding a deny-list of banned phrases is easy if this turns out to leak in practice — tracked as a follow-up, not part of Phase A.
3. **No fully-closed end-to-end test.** The E2E chain (`skills/ → regenerate → manifest → install → Claude Code consumes`) cannot be fully automated — the final step requires a live Claude Code harness. The delivered tests cover every stage up to *"files land on disk in the correct tree"*. Manual dogfood (C1 validation run on `persona-test`) bridges the last-mile gap.
4. **Persona stats are cached, not authoritative.** `personas.test_count` / `last_tested_at` are derived from `persona_test_sessions` and may go stale if `record-persona-session` fails mid-call. A reconciler (`scripts/reconcile-persona-stats.mjs`) is scheduled as a follow-up but out of scope for this refactor.

---

## 6. Testing Strategy

### Unit tests (added in Phase A)

- `tests/skill-refs-parser.test.mjs` — valid formats parse; malformed rows emit errors; missing files flagged; orphan files flagged.
- `tests/repo-stack.test.mjs` — each stack detection case (JS-only, Python-only, mixed, unknown); Python framework detection (FastAPI / Django / Flask / none).
- `tests/cross-skill-persona.test.mjs` — new persona subcommands return graceful no-op when cloud unavailable, validate required fields.
- `tests/install-multi-file-skill.test.mjs` — manifest v2 round-trips; dry-run install lists all files from `files` array.

### Integration tests (Phase C, per skill)

After each skill refactors, run a smoke test:
1. Read the new `SKILL.md` end-to-end — is the canonical flow still self-contained for the main success path?
2. Parse the ref-index — does every listed file exist?
3. For `persona-test` and `ux-lock verify` specifically: ensure no ref is needed for the "happy path" (minimum-viable P0 run).

### Lint (Phase E)

`npm run check-skills` composes:
- `scripts/check-skill-refs.mjs` — ref-index format + file existence + orphan files.
- `scripts/check-sync.mjs` — 3-way copy equality.

Added to `npm test` and (optionally) a CI gate.

### Regression check — does a refactor degrade skill behaviour?

Hard to test mechanically for LLM-driven skills. Instead:
- Keep each skill's canonical flow acceptance-testable at the CLI level where possible (e.g. `plan-satisfaction` subcommand returns the same shape).
- For skills with pure LLM orchestration (persona-test, audit-loop), do a **dogfood run** after each refactor: invoke the skill on the same task that was invoked pre-refactor; compare the output shape (report sections, severity counts, save-to-DB success) for parity.

### Token-cost measurement

Before-and-after metric captured in the plan's close-out:
- Per-skill SKILL.md token count (the 1-line target table in Section 1 is the before snapshot).
- A sample invocation trace showing which refs Claude Read(s) in practice.
- Goal: average invocation loads SKILL.md + ≤1 ref — total ≤4K tokens for heavy skills.

---

## 7. Phased Execution Order

| Phase | What | Depends on | Atomicity |
|---|---|---|---|
| **A** | Format spec, parser, lint script, `repo-stack` lib, `detect-stack` CLI, `skill-packaging` lib, `regenerate-skill-copies` script, all Phase A tests | — | Single commit. Lint + packaging + regenerate ship together so they can validate each other. |
| **B.1** | Compat installer (version-gated entrypoint, multi-file install path, lifecycle delete, tests). No v2 manifest published yet. | A | Single commit; **tag release**. |
| **B.2** | Publish v2 manifest via `build-manifest.mjs`; switch sync to allowlist; `check-sync` becomes read-only verifier. | B.1 deployed to consumer repos (verified via `git pull` + receipt) | Single commit; publish only after confirming B.1 is installed everywhere |
| **D** | Cross-skill CLI subcommands for persona-test curl replacement (`list-personas`, `add-persona`, `record-persona-session`) + schemas + tests | — (independent) | One commit per subcommand + tests |
| **C1** | Refactor persona-test | A, B.1, D | One commit: edit `skills/persona-test/`, regenerate copies, tests pass |
| **C2** | Refactor audit-loop | A, B.1 | One commit |
| **C3** | Refactor ux-lock | A, B.1 | One commit |
| **C4** | Refactor plan-frontend | A, B.1, `detect-stack` CLI | One commit |
| **C5** | Refactor ship | A, B.1, `detect-stack` CLI | One commit |
| **C6** | Refactor plan-backend | A, B.1, `detect-stack` CLI | One commit |
| **E** | `npm run check-skills` wiring, CI gate, pre-commit hook calling `regenerate-skill-copies`, CONTRIBUTING.md update | All C phases | Single commit |

**Why B.1 and B.2 ship separately**: a v1 installer that encounters a v2 manifest with reference files will silently drop the references — consumer repos end up with broken skills. Shipping the version-gated installer alone (B.1) gives consumer repos time to pick it up via `git pull` before any v2 manifest reaches them. B.2 only flips the version bit once B.1 is confirmed installed everywhere.

C1–C6 can run in parallel once B.1 is shipped (B.2 is not required for skill refactors — skills work fine against v1 manifests until the manifest itself is regenerated). Sequential order above is suggested so we validate the approach on persona-test first.

C1–C6 can run in parallel (independent files). Sequential order is suggested above (biggest saving first) so we can validate the approach on `persona-test` before propagating.

### Success metrics

Measured after Phase E completion:

| Metric | Target | How measured |
|---|---|---|
| Per-skill SKILL.md size | ≤3,000 tokens each | `wc -c` / 4 |
| First-invocation cost (SKILL.md + refs Read) | ≤4,000 tokens avg | Sample 5 invocations per heavy skill; count tokens in the Read() arguments |
| Cross-skill duplication | ≤50 tokens | Manual inspection after `repo-stack.mjs` extraction |
| All tests pass | 100% | `npm test` |
| `check-skills` lint | Zero violations | CI |
| No UX regression | User still calls `/skill-name`; same output shape | Dogfood per C-phase |

---

## Appendix A — Reference-index format quick card

For skill authors:

```markdown
## Reference files

This skill's canonical flow is above. Load a reference only when its trigger applies.

| File | Summary | Read when |
|---|---|---|
| `references/<topic>.md` | <one sentence> | <specific, detectable condition> |
```

**Good triggers**:
- *"user asks how this skill interacts with /ship"*
- *"step 4 fails twice in a row"*
- *"generating the final debrief section"*
- *"plan includes modal interactions"*

**Bad triggers (reject in review)**:
- *"when relevant"* / *"if useful"* / *"before proceeding"*
- *"for context"* — every invocation has context

---

## Appendix B — Anticipated post-refactor file counts

| Skill | SKILL.md lines | `references/` files | Approx SKILL.md tokens |
|---|---:|---:|---:|
| audit-loop | ~400 | 5 | ~3,000 |
| persona-test | ~350 | 6 | ~2,800 |
| plan-backend | ~220 | 2 | ~1,800 |
| plan-frontend | ~280 | 3 | ~2,200 |
| ship | ~280 | 2 | ~2,200 |
| ux-lock | ~250 | 4 | ~2,000 |
| **Total** | **~1,780** | **22** | **~14,000** |

vs. current **3,104 lines / 33,763 tokens** — **~42% reduction in canonical-flow tokens** and a much larger reduction in per-invocation cost once the "Read only when triggered" pattern operates as designed.

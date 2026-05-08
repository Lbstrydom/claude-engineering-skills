# Plan: Brainstorm-skill upgrades + Quick-fix detection (v1)

- **Date**: 2026-05-05 (R2 — audit-plan revisions integrated)
- **Status**: Draft (audit-plan R1 fixes applied — see §10 R1 Revisions)
- **Author**: Claude + Louis
- **Scope**: backend (js-ts; consumes brainstorm + audit-orchestration domains)

---

> **Note for code auditors**: paths under `secrets/`, `src/auth.js`,
> `.audit-loop/domain-map.js`, `.claude/settings.js`, and `.audit/quickfix-hits.js`
> appear in this document only inside ILLUSTRATIVE TEST FIXTURES (the
> SENSITIVE_PATH_PATTERNS test matrix) or as auditor-visible naming
> hints — they are NOT files this plan creates. The actual files
> created/edited by this plan are listed in §4 (File-Level Plan) only.
> The canonical implementations of the planned config artefacts are
> `.audit-loop/domain-map.json`, `.claude/settings.json` (JSON, not JS),
> and the telemetry stream at `.audit/quickfix-hits.jsonl` (JSONL, not
> a .js module).

## 1. Context Summary

Two unrelated-but-bundled features ship together:

- **Feature A — /brainstorm skill upgrades**: 8 sub-items (debate pass, session memory, implicit synthesis triggers, tunable depth, helper-script wiring, COI guidance, save mode, error UX).
- **Feature B — Quick-fix detection**: 2-layer (prospective hook + retrospective audit pass) + AGENTS doc.

### Architectural-memory consultation (Phase 0.5) — surprise finding

`scripts/brainstorm-round.mjs` **already exists** with 8 indexed symbols
(parseArgs, ArgvError, readStdin, main, dispatchProvider, etc.). It was
built in a prior `brainstorm-and-arch-discoverability` plan and already
provides:

- Secret redaction (mandatory, R2-H3 — no opt-out)
- `latest-gpt`/`latest-pro` model sentinels via `scripts/lib/model-resolver.mjs`
- Cost preflight (input + output)
- Atomic writes via `scripts/lib/file-io.mjs`
- Malformed-payload archival to `.claude/tmp/<sid>.json` (0o600)
- Zod validation against `BrainstormOutputSchema`

The supporting library at `scripts/lib/brainstorm/` already has:
`schemas.mjs`, `openai-adapter.mjs`, `gemini-adapter.mjs`, `pricing.mjs`.

**Implication for A5**: this is an **EXTEND** task, not a CREATE. The
real gap is that `skills/brainstorm/SKILL.md` still uses `curl` + `jq`
heredoc invocations instead of the existing helper. The plan must:
(a) extend the helper with new flags (`--debate`, `--depth`,
`--continue-from`, `--with-context`); (b) replace the curl/jq Step 3 in
SKILL.md with `node scripts/brainstorm-round.mjs` invocation.

### Domain analysis (Phase 0.5b)

- **Target domains**: `audit-orchestration`, `brainstorm`, `shared-lib`, `skills-content`, `tests`
- **Cross-domain work** — touches 5 domains; each change is bounded to its domain.
- **Untagged path**: `.claude/hooks/quickfix-scan.*` doesn't match any rule in `.audit-loop/domain-map.json`. Add a `claude-hooks` rule before designing — see §4 file-level plan.

### Security incidents (Phase 0.5c)

`get-incident-neighbourhood` returned 0 records for these target paths.
No past security-strategy incidents apply. No `Security Considerations`
section needed.

### Patterns reused vs new

| Reused | Why |
|---|---|
| `scripts/brainstorm-round.mjs` orchestration shell | Already battle-tested; extend in-place rather than fork |
| `scripts/lib/brainstorm/{schemas,openai-adapter,gemini-adapter,pricing}.mjs` | All adapters already exist, just need new prompts threaded through |
| `scripts/lib/file-io.mjs::atomicWriteFileSync` | Used for session ledger writes (crash-safe) |
| `scripts/lib/secret-patterns.mjs::redactSecrets` | Mandatory at every text-egress site (per existing R2-H3) |
| `scripts/lib/model-resolver.mjs::resolveModel` | Resolves `latest-gpt` / `latest-pro` / `latest-haiku` sentinels |
| `scripts/openai-audit.mjs` PASS_PROMPTS + WAVES architecture | New `quickfix` pass slots into the existing wave system |
| `scripts/lib/ledger.mjs::buildR2SystemPrompt`, `suppressReRaises` | Quickfix findings flow through the existing R2+ suppression |
| Per-skill mirror via `npm run skills:regenerate` | Unchanged — edit `skills/brainstorm/SKILL.md`, run regen, mirror updates |

| New | Why |
|---|---|
| `scripts/lib/brainstorm/session-store.mjs` | Session ledger I/O (single source of truth for `.brainstorm/sessions/<sid>.jsonl`) |
| `scripts/lib/brainstorm/debate-prompt.mjs` | Builds the debate-round prompt; isolating keeps the helper main thin |
| `scripts/lib/brainstorm/depth-config.mjs` | Depth-to-tokens map + auto-promote heuristic; pure module so other callers can reuse |
| `scripts/lib/quickfix-patterns.mjs` | Pattern matrix + `matchPatterns(diffText)` pure fn (testable in isolation) |
| `.claude/hooks/quickfix-scan.mjs` | PostToolUse hook runner — node not bash for Windows compat |

---

## 2. Proposed Architecture

### Feature A — /brainstorm upgrades

```
┌──────────────────────────────────────────────────────────────────┐
│  skills/brainstorm/SKILL.md                                      │
│   ├─ Step 0–2: parse args, prompt build (unchanged structure)    │
│   ├─ Step 3:   invokes scripts/brainstorm-round.mjs (new)        │
│   ├─ Step 3.5: optional debate round if --debate (new)           │
│   ├─ Step 4:   present (with new error-UX rule, COI rule)        │
│   ├─ Step 5:   synthesis (new implicit-trigger guidance)         │
│   └─ Step 6:   save mode (new — writes .brainstorm/insights/...) │
└──────────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────────┐
│  scripts/brainstorm-round.mjs (EXTENDED)                         │
│   New flags: --debate, --depth, --continue-from, --with-context  │
│   New steps:                                                     │
│     - Resolve depth → maxTokens (depth-config.mjs)                │
│     - Optional load prior session (session-store.mjs)             │
│     - Optional debate round (debate-prompt.mjs)                   │
│     - Append every round to session ledger                       │
└──────────────────────────────────────────────────────────────────┘
                             │
        ┌────────────────────┼────────────────────┐
        ▼                    ▼                    ▼
  session-store.mjs    debate-prompt.mjs    depth-config.mjs
  (jsonl I/O)          (prompt builder)     (pure fn)
```

**Key design decisions** (cite engineering principles):

- **#5 SSOT**: depth-to-tokens table lives in ONE module (`depth-config.mjs`); both helper CLI and SKILL.md read it via the helper's `--help` output (skill never re-encodes the table). Same for session-store: helper writes ledger; skill never opens the file directly.
- **#2 SRP**: helper main stays a thin orchestrator; per-feature logic in dedicated lib modules.
- **#11 Testability**: `matchPatterns()` is pure (string in → matches array out). `debate-prompt.builder()` is pure. `depth-config.resolve()` is pure. All three get unit tests with no I/O.
- **#12 Validation**: every CLI flag validated in `parseArgs` with `ArgvError` (existing pattern); session-ledger entries validated via Zod before write.
- **#19 Observability**: every round logs to stderr with `[brainstorm]` prefix; quickfix hook logs to `.audit/quickfix-hits.jsonl` (gitignored) for retrospective analysis even after the user dismisses the system-reminder.

### Feature B — Quick-fix detection

```
┌──────────────────────────────────────────────────────────────────┐
│  PROSPECTIVE                                                     │
│  Edit/Write tool fires                                           │
│         │                                                        │
│         ▼                                                        │
│  PostToolUse hook:                                               │
│    .claude/hooks/quickfix-scan.mjs                               │
│      ├─ reads PostToolUse JSON from stdin                        │
│      ├─ extracts file_path + new_string (Edit) or content (Write)│
│      ├─ delegates to scripts/lib/quickfix-patterns.mjs           │
│      ├─ if matches → emits {systemMessage: "..."} JSON           │
│      └─ NEVER returns continue:false (nudge, not gate)           │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│  RETROSPECTIVE                                                   │
│  scripts/openai-audit.mjs PASS_PROMPTS + WAVES                   │
│    + new 'quickfix' pass entry                                   │
│      ├─ low reasoning (pattern-match, not deep semantic)         │
│      ├─ findings emit is_quick_fix: true                         │
│      └─ existing quickFix==0 convergence threshold gates them    │
└──────────────────────────────────────────────────────────────────┘
```

**Why two layers**: the regex hook catches the **mechanical** shortcuts
(empty catch, TODO, @ts-ignore, magic numbers in conditionals). The audit
pass catches the **design** shortcuts (stub returning constants, tests
asserting `toBeDefined` instead of value, side-issue fix masking root
cause). Neither covers the other; together they cover both axes.
**Documented in AGENTS.md §"Quick-fix detection"**.

### Hook output contract

The Claude Code hook protocol expects JSON on stdout:

```json
{
  "systemMessage": "⚠ Quick-fix pattern: <pattern-name> at <file>:<line>\nMatched: <snippet>\nConsider: <suggestion>"
}
```

Hook NEVER sets `continue: false` (false positives expected; nudge not
gate). If the user wants a hard gate they can wrap our hook in their
own settings.json hook that escalates on certain patterns.

### Disable mechanisms (B1 hook)

| Mechanism | When |
|---|---|
| `QUICKFIX_HOOK_DISABLE=1` env | Whole-session opt-out (e.g. while doing rapid prototyping) |
| `// quickfix-hook:ignore` on the same line | Per-line opt-out for accepted shortcuts |
| Diff-size > 2000 lines | Auto-bail (signal drowns in noise; large refactors better caught by retrospective pass) |

---

## 3. Phase 1.5 — Execution Model

**Are any planned operations dependent on others?** Yes — three chains:

### Chain 1: Brainstorm helper extensions (A5 → A1, A2, A4)

The helper must accept the new flags BEFORE the SKILL.md can invoke
them. Implementation order: `depth-config.mjs` + `session-store.mjs` +
`debate-prompt.mjs` first (independent libs), then `brainstorm-round.mjs`
parseArgs/main edits, then `skills/brainstorm/SKILL.md` rewrite, then
`npm run skills:regenerate`.

Atomicity: per-step. Each lib + helper edit + SKILL.md rewrite is
independently testable. Tests run after each lib lands.

### Chain 2: Quickfix prospective layer (B1)

Pattern matrix → hook script → settings.json wiring. Each step
testable: patterns.mjs has unit tests; hook script integration-tested
with stdin-fed PostToolUse JSON; settings.json hook registration
verified by triggering an Edit and reading the system-message echo.

Empirical effectiveness test (per AGENTS.md arch-memory pattern):
introduce a known shortcut via Edit → confirm hook fires; introduce
normal code → confirm no fire. Run before declaring done.

### Chain 3: Quickfix retrospective layer (B2)

Add 'quickfix' entry to PASS_PROMPTS → add wave handler in audit-code
flow → run audit-code on a known shortcut-bearing fixture and verify
finding emerges with `is_quick_fix: true`. This depends on existing
`PASS_PROMPTS`/`WAVES` plumbing (no changes there).

### Concurrency

All three chains can run in parallel during implementation — no
shared-mutable-state between them. Tests can run in parallel too
(Node test runner default).

---

## 4. File-Level Plan

### Brainstorm — extend existing surface

| File | Action | Role |
|---|---|---|
| `skills/brainstorm/SKILL.md` | EDIT | Replace curl/jq invocations with helper invocation (Step 3); add Step 3.5 debate (presented when helper output includes `debate` block); widen Step 5 implicit-synthesis triggers; add Step 6 save mode; add COI rule to Claude's-take section; change error-UX from peer-block to single-line-above. **(#5 SSOT — skill never re-encodes depth table or session format)** |
| `.claude/skills/brainstorm/SKILL.md` | REGEN | Run `npm run skills:regenerate` after editing source skill |
| `scripts/brainstorm-round.mjs` | EDIT | Add 4 new flags to parseArgs (`--debate`, `--depth`, `--continue-from`, `--with-context`); after parallel responses settle, optionally call `runDebateRound()` if `--debate`; append every round to session ledger via `appendSession()`; map `--depth` to `maxTokens` via `resolveDepth()`. **(#2 SRP — main stays orchestrator; new logic in lib modules)** |
| `scripts/lib/brainstorm/depth-config.mjs` | NEW | Exports `DEPTH_TOKENS = {shallow:300, standard:600, deep:1200}` and `autoPromoteDepth(topic)` returning `'deep'` if topic matches `/(architect|schema|migration|refactor|design|how should we structure|what's the best approach)/i`, else `null` (caller's default applies). Pure fn, no I/O. **(#5 SSOT — single map; #11 Testability)** |
| `scripts/lib/brainstorm/session-store.mjs` | NEW | Exports `appendSession({sid, round, topic, providers, debate, totalCostUsd})`, `loadSession(sid)`, `summariseOlderRounds(rounds, keepLast=2)`. JSONL append-only at `.brainstorm/sessions/<sid>.jsonl`. Atomic writes via `atomicWriteFileSync` for full-rewrites; append uses `fs.appendFileSync`. Prune: `pruneOldSessions(maxAgeDays=30)` called at helper startup. **(#5 SSOT; #19 observability)** |
| `scripts/lib/brainstorm/debate-prompt.mjs` | NEW | Exports `buildDebatePrompt({otherProvider, otherResponse, originalTopic})` — pure builder returning `{systemPrompt, userMessage}`. Used by `runDebateRound()` in helper main. **(#11 testability)** |
| `scripts/lib/brainstorm/schemas.mjs` | EDIT | Extend `BrainstormOutputSchema` to optionally include `debate: z.object({...})` block per provider; add `sid: z.string()` and `round: z.number().int()` top-level. Backwards-compatible — existing fields stay required, new fields optional. **(#16 backward compat)** |
| `package.json` | (no change needed) | Existing `brainstorm-round.mjs` already wired; SKILL.md drives the invocation |
| `.gitignore` | EDIT | Add `.brainstorm/` (sessions + insights are local-only, never committed) |

### Quickfix — prospective hook

| File | Action | Role |
|---|---|---|
| `scripts/lib/quickfix-patterns.mjs` | NEW | Exports `PATTERNS` (array of `{name, severity:'low'|'medium'|'high', regex, suggestion, langGuard?: regex}`) and `matchPatterns(diffText, opts)` returning `[{name, line, snippet, suggestion}]`. **Pattern matrix** (initial v1):  empty-catch, todo-fixme-hack, ts-ignore-no-justification, eslint-disable-no-rule, py-noqa-no-code, py-pylint-disable-no-reason, magic-number-conditional, masked-error, disabled-assertion, hardcoded-localhost, hardcoded-http-url. Ignore lines containing `// quickfix-hook:ignore` (per-line opt-out). Bail (return `[]`) when `diffText.length > 80_000` chars (~2000 lines). Pure fn, no I/O. **(#11 testability — fully unit-tested; #5 SSOT — patterns in one place)** |
| `.claude/hooks/quickfix-scan.mjs` | NEW | Node hook script. Reads JSON from stdin (`{tool_name, tool_input, tool_response}`); extracts `file_path` and `new_string`/`content`; if `QUICKFIX_HOOK_DISABLE=1` → exit 0 silently; if file is binary or excluded ext (e.g. `.png`, `.lock`) → exit 0; calls `matchPatterns()`; if any matches, emits `{"systemMessage": "..."}` to stdout and `process.exit(0)`. NEVER emits `continue:false`. Logs all hits to `.audit/quickfix-hits.jsonl` (gitignored) for telemetry. <200ms target. **(#19 observability)** |
| `.claude/settings.json` | EDIT | Register the hook (PostToolUse, matcher: "Edit\|Write", command: `node .claude/hooks/quickfix-scan.mjs`). MERGE with existing hooks — never replace. |
| `.audit-loop/domain-map.json` | EDIT | Add a rule for `.claude/hooks/**` → domain: `claude-hooks` (closes the untagged-paths warning) |

### Quickfix — retrospective audit pass

| File | Action | Role |
|---|---|---|
| `scripts/lib/prompt-seeds.mjs` (canonical PASS_PROMPTS source) | EDIT | Add `quickfix` entry to `PASS_PROMPTS` with rubric: "Identify shortcuts that bypass root-cause investigation. Look for: stub functions returning constants where spec implied real logic; tests asserting non-failure rather than correctness; hardcoded sample data inline where fixture would be cleaner; side-issue fixes that mask root causes (catching at boundary instead of fixing source). Each finding MUST set is_quick_fix: true. Severity rubric: HIGH = ships shortcut to production, MEDIUM = degrades long-term maintainability, LOW = stylistic." |
| `scripts/openai-audit.mjs` | EDIT | Register `quickfix` in WAVES (likely Wave 2 alongside be-services + frontend, low reasoning). Output schema entry already supports `quick_fix_warnings`; ensure findings are merged into the main findings array with `is_quick_fix: true` set. **(#16 backward compat — existing `quickFix==0` convergence threshold already gates these)** |

### Documentation

| File | Action | Role |
|---|---|---|
| `AGENTS.md` | EDIT | New section "Quick-fix detection" (concise — describe the two-layer architecture, point at `.claude/hooks/quickfix-scan.mjs` and the audit pass; document `QUICKFIX_HOOK_DISABLE=1` env + `// quickfix-hook:ignore` per-line opt-out; link the philosophy: nudge not gate, root cause > shortcut, explicit acceptance > silent shortcut) |
| `README.md` | EDIT (small) | Quick reference row for the hook + pass |

### Tests (#11 testability, #20 long-term flexibility)

| File | Action | Coverage |
|---|---|---|
| `tests/brainstorm-depth.test.mjs` | NEW | DEPTH_TOKENS map values; autoPromoteDepth() positive (architecture/schema/migration/refactor/design) + negative cases |
| `tests/brainstorm-session-store.test.mjs` | NEW | append → load round trip; summariseOlderRounds keeps last N verbatim; pruneOldSessions deletes >30d files; tmpdir-based no-side-effect tests |
| `tests/brainstorm-debate.test.mjs` | NEW | buildDebatePrompt() output structure; presence of other-model-response in user message; system prompt invites cross-pollination |
| `tests/quickfix-patterns.test.mjs` | NEW | Each pattern matrix entry: ≥1 positive + ≥1 negative case. Confirm `// quickfix-hook:ignore` on same line suppresses the hit. Confirm 80k+ char input returns `[]`. |
| `tests/quickfix-hook.test.mjs` | NEW | Stdin contract: feed PostToolUse JSON for Edit + Write paths, verify systemMessage emitted on hit, no output on miss. Verify `QUICKFIX_HOOK_DISABLE=1` short-circuits. |
| `tests/brainstorm-round-extensions.test.mjs` | NEW | parseArgs accepts `--debate`, `--depth`, `--continue-from`, `--with-context`; rejects invalid depth values; --debate forces second round in dispatch; session ledger gets appended (tmpdir override) |

---

## 5. Sustainability Notes

- **Pattern matrix is data-driven (#5 + #20)**: adding a new shortcut pattern = one new entry in `quickfix-patterns.mjs`. Tests follow the same per-row pattern.
- **Session backend is swap-friendly (#5 + #20)**: `session-store.mjs` exposes a stable interface (`appendSession` / `loadSession`); ledger format can move from JSONL to SQLite later without changing callers.
- **Depth heuristic is single-rule (#5)**: `autoPromoteDepth()` is one regex; tuning the heuristic = editing one line.
- **Debate is opt-in (#20)**: `--debate` defaults off so existing scripts/users see no behaviour change. Easy to make default-on later if proven valuable; no migration needed.
- **Hook is a nudge not a gate**: false positives erode trust faster than missed-shortcuts erode quality. Per-line + env opt-outs prevent escalation. Telemetry to `.audit/quickfix-hits.jsonl` lets us measure precision and tune patterns over time.
- **AGENTS.md philosophy section is short on purpose**: deeper guidance lives next to the code (per-pattern `suggestion` field in `quickfix-patterns.mjs`).

If 6 months from now we want richer debate (3+ models, multi-round
debate), the existing 2-model dispatcher generalises trivially because
debate-prompt.mjs is a pure builder. If we need cross-session
synthesis ("brainstorm summary across last 5 sessions"), session-store
already exposes `loadSession` and a list-API can wrap it. If quickfix
hook needs language-aware patterns, the `langGuard?: regex` field is
already on each pattern entry — implementation just needs to populate
it for language-specific patterns.

---

## 6. Risk & Trade-off Register

### Trade-offs

| Trade | Why we chose it |
|---|---|
| Hook in **node not bash** (~50–100ms startup) | Windows-first; bash fragile on PowerShell; node uniform across the consumer repos |
| Session ledger as **JSONL not SQLite** | Append-only, no schema migration, human-readable for debugging. SQLite would be over-engineering at v1 |
| Debate **opt-in default off** | Doubles cost ($0.05) + adds 10s. Some brainstorms don't need it. Discoverable via `--help` |
| Quickfix hook **uses regex not LLM** | <200ms target unblocks tight edit loops; LLM scan adds 1-3s per Edit which is unacceptable. LLM scan happens retrospectively (audit pass) |
| Quickfix retrospective uses **low reasoning** | Pattern-match task; high reasoning would be over-engineering and increase audit cost |
| `.brainstorm/` is **gitignored** | Per-machine state; no value sharing sessions across machines (insights worth sharing get committed via existing mechanisms) |
| Add a **separate `claude-hooks` domain** rather than expanding an existing one | Hooks have distinct ownership semantics (harness-invoked, not user-invoked) — clean boundary |

### Risks + mitigations

| Risk | Mitigation |
|---|---|
| Quickfix hook false positives erode trust | Per-line `// quickfix-hook:ignore` + env opt-out + telemetry to `.audit/quickfix-hits.jsonl` lets us measure precision |
| Debate-round prompt over-aligns models (both end up agreeing artificially) | Empirical check post-implementation: inspect `.brainstorm/sessions/` and look for genuine push-back vs synthetic agreement |
| Session ledger grows unbounded | `pruneOldSessions(30d)` runs at helper startup; user can adjust via `BRAINSTORM_SESSION_RETENTION_DAYS` env |
| Existing helper's `.claude/tmp/` debug archive grows unbounded | Add a `pruneOldDebugArtefacts(7d)` call at helper startup (orthogonal to brainstorm work but trivial to fold in) |
| Settings.json hook merge conflicts with user edits | `.claude/settings.json` edit MUST merge (read existing, append our hook to PostToolUse array) — never replace. Use the project's existing Edit-tool-via-Read pattern |
| The `debate` block makes `BrainstormOutputSchema` confusing | Schema versioning via the existing pattern: optional `debate` field is backwards-compat; never remove existing required fields |

### Deliberately deferred

- **Brainstorm session visualisation** (rendered HTML of session): not needed for v1; jsonl is human-readable
- **Quickfix retrospective with high-reasoning**: pattern-match task; would be over-engineering
- **3+ model debate**: 2-model is the common case; 3-model trivially generalises later
- **Cross-session synthesis**: `loadSession()` exposes the data; build a wrapper later if needed
- **Hook telemetry dashboard**: jsonl is enough for grep/jq analysis at v1
- **Per-language quickfix patterns**: schema field `langGuard?: regex` is already there; populate only when needed

---

## 7. Acceptance Criteria

Each row must be mechanically verifiable.

| ID | Criterion | Verification |
|---|---|---|
| AC1 | `scripts/brainstorm-round.mjs` accepts `--debate`, `--depth`, `--continue-from`, `--with-context` | `node scripts/brainstorm-round.mjs --help` lists all 4 flags |
| AC2 | `--depth shallow` sets maxTokens to 300; `standard` to 600; `deep` to 1200 | Test in `tests/brainstorm-depth.test.mjs` |
| AC3 | `autoPromoteDepth()` returns `'deep'` for ≥6 of these inputs: "design the architecture", "new schema for X", "migration plan", "refactor the auth flow", "how should we structure this", "what's the best approach to" | Unit test |
| AC4 | `--debate` triggers a second round; output JSON includes `debate.<provider>` block per provider that responded in round 1 | Integration test stubs adapters |
| AC5 | `--continue-from <sid>` loads `.brainstorm/sessions/<sid>.jsonl` and includes prior rounds (last 1-2 verbatim, older summarised) in user message | Test with a pre-seeded session file in tmpdir |
| AC6 | Every helper invocation appends one JSONL entry to `.brainstorm/sessions/<sid>.jsonl` | Integration test |
| AC7 | `pruneOldSessions(30)` deletes session files older than 30 days; preserves newer ones | Test with file mtime mocking |
| AC8 | `skills/brainstorm/SKILL.md` Step 3 invokes `node scripts/brainstorm-round.mjs` (no curl, no jq) | `! grep -q "curl.*openai\|jq -n" skills/brainstorm/SKILL.md` |
| AC9 | `skills/brainstorm/SKILL.md` includes implicit-synthesis-trigger guidance (not just keyword list) | grep for "judge synthesis-readiness" or similar |
| AC10 | `skills/brainstorm/SKILL.md` Claude's-take section includes COI rule ("DIFFER from theirs in substance") | grep |
| AC11 | `skills/brainstorm/SKILL.md` Step 6 documents `/brainstorm save <one-line>` mode | grep |
| AC12 | `skills/brainstorm/SKILL.md` error UX rule: errors as single line above views, not as peer block | grep for "single line above" |
| AC13 | `.claude/skills/brainstorm/SKILL.md` byte-matches the regenerated source after `npm run skills:regenerate` | `npm run skills:check` exits 0 |
| AC14 | `scripts/lib/quickfix-patterns.mjs` exports PATTERNS array with ≥10 entries; each entry has `name`, `severity`, `regex`, `suggestion` | Unit test asserts schema |
| AC15 | `matchPatterns()` returns `[]` when `// quickfix-hook:ignore` is on the same line | Unit test |
| AC16 | `matchPatterns()` returns `[]` when input length > 80,000 chars | Unit test |
| AC17 | `.claude/hooks/quickfix-scan.mjs` reads PostToolUse JSON from stdin and emits `{"systemMessage":"..."}` on hit | Integration test pipes stdin → captures stdout |
| AC18 | Hook never emits `continue:false` (nudge, not gate) | grep `! grep -q "continue.*false" .claude/hooks/quickfix-scan.mjs` |
| AC19 | `QUICKFIX_HOOK_DISABLE=1` causes hook to exit 0 silently (no stdout) | Integration test |
| AC20 | `.claude/settings.json` registers the quickfix hook on PostToolUse with matcher `Edit|Write` | jq query on settings.json |
| AC21 | Empirical effectiveness test: introduce known shortcut (e.g. `catch {}`) → hook fires; introduce normal code → no fire | Documented test recipe in tests/quickfix-hook.test.mjs (skip-if-not-run-from-test-runner) |
| AC22 | `scripts/openai-audit.mjs` PASS_PROMPTS includes `quickfix` entry | grep |
| AC23 | `scripts/openai-audit.mjs` WAVES dispatches the quickfix pass | grep + run audit-code on a fixture; verify quickfix findings appear with `is_quick_fix:true` |
| AC24 | Existing `quickFix==0` convergence threshold gates the new pass's findings | Run audit-code on shortcut-bearing fixture; verdict reflects quickFix > 0 |
| AC25 | `AGENTS.md` includes "Quick-fix detection" section with both layers + opt-outs documented | grep |
| AC26 | `.gitignore` includes `.brainstorm/` | grep |
| AC27 | `.audit-loop/domain-map.json` includes a `.claude/hooks/**` rule | jq |
| AC28 | All new test files pass | `node --test tests/brainstorm-*.test.mjs tests/quickfix-*.test.mjs` exits 0 |
| AC29 | `BrainstormOutputSchema` extension is backwards-compatible — pre-existing test fixtures still parse | Run existing brainstorm tests |
| AC30 | Synced to consumer repos: `.claude/hooks/quickfix-scan.mjs` lands in `wine-cellar-app/.claude/hooks/` and `ai-organiser/.claude/hooks/` after `npm run sync` | manual verify post-sync |

---

## 8. Testing Strategy

- **Unit (Node test runner)**: each new lib has a dedicated test file; pure-function modules (depth-config, debate-prompt, quickfix-patterns) get exhaustive matrix coverage.
- **Integration**: helper accepts CLI flags and produces schema-valid JSON; quickfix hook reads stdin and emits stdout; session-store appends and loads correctly.
- **Empirical**: quickfix hook effectiveness test (introduce known shortcut → hook fires; introduce normal code → silent). Documented in `tests/quickfix-hook.test.mjs` and runnable via `node --test`.
- **Backwards-compat**: existing `tests/brainstorm-*` test files (if any from prior plan) must still pass.
- **Manual smoke**: run `/brainstorm --debate <topic>` end-to-end and verify debate block appears; run `/brainstorm continue <sid> <refinement>` and verify prior context inclusion.

---

## 9. Out of Scope (Future)

- Cross-session brainstorm synthesis dashboard
- 3+ model debate (debate adapter accepts >2 trivially when needed)
- LLM-driven quickfix detection on every Edit (latency unacceptable; retrospective pass covers this)
- Hook telemetry visualisation
- Per-language quickfix patterns (`langGuard` field is reserved but unpopulated at v1)
- Migration of `.claude/tmp/` debug archive cleanup into a separate utility (folded into helper startup at v1 because it's trivial)
- **LLM-backed continue-from summarisation** (v1 uses deterministic head/tail truncation; LLM summary deferred to v1.1 if context-budget pressure proves it necessary — see §10.B)

---

## 10. R1 Audit Revisions — Plan Hardening

The audit-plan R1 round surfaced 5H + 2M plan-shaped gaps. This section
fills them in. Numbering matches the R1 finding IDs.

### 10.A — Save mode (R1-H1): full implementation surface

The original §2/§4 documented save mode only as a SKILL behaviour. It
is now a first-class backend capability with explicit storage,
schema, and CLI surface.

**New file**: `scripts/lib/brainstorm/insight-store.mjs`

Exports:

- `saveInsight({sid, round, topicSlug, insightText, tagsArray=[]}) → {path, slugUsed}`
- `listInsightsByTopic(topicSlug) → [{path, mtime, frontmatter}]`
- `slugifyTopic(topic) → string` (stable URL-safe slug; max 60 chars; collision suffix `-2`, `-3`)

**Storage**:
- Path: `.brainstorm/insights/<topic-slug>/<YYYYMMDD-HHMMSS>-<sid-prefix>.md` (one file per insight; per-day directory split is overkill at v1, the per-topic-slug directory is enough)
- Format: YAML frontmatter + insight body
  ```markdown
  ---
  sid: <session-id>
  round: <integer round number from the originating session>
  topic: <full topic — not slug>
  topicSlug: <slug used for directory>
  capturedAt: <ISO 8601>
  tags: [...optional]
  ---
  <insight text — multi-line allowed; markdown allowed>
  ```
- Idempotency: insight identity = sha256(`sid|round|insightText`) → 16-char prefix forms a content-hash file suffix appended after the timestamp. Repeated `saveInsight()` with identical content writes ZERO files (existing file with same hash detected → silent no-op + return existing path).
- Overwrites: never. New content with same `(sid, round)` writes a new file with the new content hash.
- Atomic writes via `atomicWriteFileSync`.
- Validation: insight body must be 1..2000 chars; topic 1..200 chars; ArgvError on violation.

**New helper CLI surface**:
- `node scripts/brainstorm-round.mjs save --sid <sid> --round <n> --topic "<text>" --insight "<text>" [--tags <csv>]`
- `node scripts/brainstorm-round.mjs save --sid <sid> --round <n> --topic "<text>" --insight-stdin` (read from stdin)
- Validates inputs via `parseArgs` with ArgvError; calls `saveInsight()`; emits `{ok:true, path, slugUsed}` JSON.

**Schema**:
- `InsightFrontmatterSchema` in `scripts/lib/brainstorm/schemas.mjs` (separate from session/provider schemas — see §10.C)
- Fields: `sid: string`, `round: number().int().nonnegative()`, `topic: string().min(1).max(200)`, `topicSlug: string()`, `capturedAt: ISO datetime string`, `tags: array(string()).optional()`

**SKILL.md Step 6** invokes the helper via this new `save` subcommand. Skill never touches the filesystem directly.

**Tests** (new file `tests/brainstorm-insight-store.test.mjs`):
- `slugifyTopic` collision-safe; "How to do X?" → "how-to-do-x"; pre-existing slug + 1 → "-2"
- `saveInsight` round-trip (write → readdir confirms presence)
- `saveInsight` idempotency: same content twice → 1 file, second call returns existing path
- Validation: body too long, body empty, topic empty → ArgvError
- Frontmatter-parse round-trip via existing yaml parser

### 10.B — `--continue-from` context assembly + budget policy (R1-H2)

The original §2/§4 said "older summarised, last 1-2 verbatim" but never
specified summarisation strategy, token budget, or precedence with
`--with-context`. Below is the precise contract.

**New file**: `scripts/lib/brainstorm/resume-context.mjs`

Exports:

- `assembleResumeContext({sid, withContext, model, providerInputCeiling}) → {systemPreface, userPrefix, includedRounds, droppedRounds, estimatedTokens}`
- `estimateTokens(text, model) → number` (deterministic char/4 default; switchable to model-specific tokenizer later)
- `summariseRound(roundEntry) → string` (deterministic head/tail truncation at v1 — head 200 chars + " … " + tail 200 chars per provider response; LLM summary deferred to v1.1 — see §9 Out of Scope)

**Provider input ceilings** (single source in `scripts/lib/brainstorm/provider-limits.mjs`):

```js
export const PROVIDER_INPUT_CEILINGS = Object.freeze({
  openai: { 'latest-gpt': 128000, 'latest-gpt-mini': 128000, /* defaults */ default: 100000 },
  gemini: { 'latest-pro': 1000000, 'latest-flash': 1000000, default: 100000 },
});
// Resume context budget = ceiling * 0.4 (leaves 60% for round-1 prompt + completion)
export const RESUME_BUDGET_FRACTION = 0.4;
```

**Assembly rules** (in priority order; deterministic):

1. **Always include** the original Step 2 system prompt + the new topic. These are FIXED (counted into "round 1 prompt + completion" allocation, not into resume budget).
2. **Resume budget** = `floor(providerInputCeiling * RESUME_BUDGET_FRACTION)` chars (using char/4 estimator means the actual token usage stays under the ceiling with comfortable margin).
3. **Verbatim quota** — last 2 rounds verbatim. If verbatim alone exceeds the resume budget, drop the older verbatim round, then if still over, summarise the surviving verbatim round.
4. **Summarised quota** — older rounds appended in chronological order via `summariseRound()`; keep adding from newest-of-the-summarised down until next add would exceed budget.
5. **`--with-context`** appended LAST in the user prefix. Counted against a SEPARATE allocation (not the resume budget) capped at `providerInputCeiling * 0.1` (10%). Truncated with a clear "[truncated; original X chars]" marker if it exceeds.
6. **Precedence on conflict**: `--with-context` is the user's deliberate hint and wins over older rounds; if both alone exceed total ceiling, helper aborts with `BUDGET_EXCEEDED` exit code 2 (does not silently truncate user input).
7. **Redaction**: every assembled string passes through `redactSecrets()` before being concatenated (defence in depth — even though source rounds were already redacted at write time).

**Output structure** (returned by `assembleResumeContext`):

```js
{
  systemPreface: "Conversation so far: ...",  // injected after the original system prompt
  userPrefix: "Earlier rounds:\n\n[round N-2 — summarised]\n...\n[round N — verbatim]\n\nAdditional context:\n<--with-context>\n\nNew topic: ",
  includedRounds: [{ round: N, treatment: 'verbatim'|'summarised' }, ...],
  droppedRounds: [{ round: M, reason: 'budget' }],
  estimatedTokens: 12345,
}
```

**Telemetry** — `assembleResumeContext` always logs to stderr:
`[brainstorm] resume: included <verbatim>/<summarised>; dropped <n>; est tokens <m>/<budget>`.

**Tests** (new file `tests/brainstorm-resume-context.test.mjs`):
- 0 prior rounds → empty assembly, no preface
- 1 prior round → verbatim, no summary
- 5 prior rounds, all small → 2 verbatim + 3 summarised
- 5 prior rounds, last verbatim huge → drop older verbatim, summarise surviving
- `--with-context` exceeds 10% allocation → truncation marker present
- Total exceeds ceiling → exit BUDGET_EXCEEDED

### 10.C — Schema split (R1-H3): provider vs envelope vs debate

Current plan extended the existing `BrainstormOutputSchema` with helper-owned fields, leaking the provider-output boundary. **Replace with three composed schemas**.

**`scripts/lib/brainstorm/schemas.mjs` (EDIT) now exports**:

```js
// LLM provider raw output — what the model emitted, validated at adapter boundary.
// Pre-existing schema; KEEP unchanged for backwards-compat.
export const ProviderResponseSchema = z.object({
  provider: z.enum(['openai','gemini']),
  state:    z.enum(['ok','malformed','misconfigured','timeout','error']),
  text:     z.string().nullable(),
  errorMessage: z.string().nullable(),
  httpStatus:   z.number().int().nullable(),
  usage:    z.object({ ... }).nullable(),
  latencyMs: z.number().int().nonnegative(),
  estimatedCostUsd: z.number().nonnegative().nullable(),
});

// Helper envelope — round metadata + provider responses + optional debate.
// This is what the helper EMITS to stdout/--out and APPENDS to the session ledger.
export const BrainstormEnvelopeSchema = z.object({
  topic: z.string(),
  redactionCount: z.number().int().nonnegative(),
  resolvedModels: z.record(z.string()),
  providers: z.array(ProviderResponseSchema),
  debate: z.array(DebateRoundSchema).optional(),  // present only if --debate
  totalCostUsd: z.number().nonnegative(),
  // Helper-owned session metadata — NEW, opt-in, non-LLM-controlled
  sid: z.string().min(1),                  // session id
  round: z.number().int().nonnegative(),   // round number within session (0-indexed)
  capturedAt: z.string().datetime(),       // ISO 8601
  schemaVersion: z.literal(2),             // bumped from implicit v1
});

// Debate round — distinct shape from round 1 because the prompt input differs
// (each provider sees the OTHER provider's response).
export const DebateRoundSchema = z.object({
  provider: z.enum(['openai','gemini']),
  reactingTo: z.enum(['openai','gemini']),
  state: z.enum(['ok','malformed','misconfigured','timeout','error','skipped-no-peer']),
  text: z.string().nullable(),
  errorMessage: z.string().nullable(),
  usage: z.object({ ... }).nullable(),
  latencyMs: z.number().int().nonnegative(),
});

// Backwards-compatible alias for callers that imported BrainstormOutputSchema:
export const BrainstormOutputSchema = BrainstormEnvelopeSchema;  // alias only
```

**Boundary rule**: adapters validate **provider** output via `ProviderResponseSchema` immediately at adapter return. The helper main composes the **envelope** with helper-owned metadata (`sid`, `round`, `capturedAt`, `schemaVersion`, optional `debate`) and validates via `BrainstormEnvelopeSchema` before write. The provider schema is NEVER mutated post-parse.

**Schema versioning**: envelope adds `schemaVersion: 2` for new writes. Sesison-store reader gracefully handles v1 records (rounds written before this plan landed) by defaulting `schemaVersion` to 1, `sid` to a synthesised value, `round` to 0 — and logs a one-time stderr warning per session.

**Tests** (extend `tests/brainstorm-round-extensions.test.mjs`):
- Adapter return → `ProviderResponseSchema.safeParse` succeeds
- Envelope build → `BrainstormEnvelopeSchema.safeParse` succeeds
- Debate round → `DebateRoundSchema.safeParse` succeeds
- v1 fixture (no `sid`/`round`) loads via session-store with synthesised defaults + warning
- Pre-existing fixtures still parse (alias preserved)

### 10.D — Session persistence locking + integrity (R1-H4)

Plan said "append-only JSONL" but also mentioned parallel invocations
and prune-rewrites. Bare `fs.appendFileSync` is not safe under
concurrent writers. Below is the safe persistence strategy.

**Strategy**:

1. **Per-session-file lock** using the project's existing dependency surface — Node 22 has stable `fs.promises.flock` is not available, so use a sentinel-file pattern: acquire `<sid>.jsonl.lock` via `fs.openSync(lockPath, 'wx')` (exclusive create — atomic on POSIX + Win32 NTFS). Hold lock for the entire append OR rewrite. Release via `unlinkSync` in a `finally`. Stale-lock recovery: if `<lock>.mtime` > 60s old AND owning PID (written into the lock file) is not alive, lock is force-released with a stderr warning.
2. **Append path**: acquire lock → `fs.appendFileSync` (single line, terminated with `\n`) → release lock. Each line is a complete JSON record validated against `BrainstormEnvelopeSchema` BEFORE the lock is acquired (no holding lock during validation).
3. **Read-modify-write path** (used by `pruneOldSessions` and any future operations that rewrite): acquire lock → read → filter → `atomicWriteFileSync` (temp + rename) → release lock.
4. **Prune scheduling**: `pruneOldSessions(30)` runs lazily — at helper startup, only if `.brainstorm/sessions/` directory mtime indicates last prune was >24h ago (mtime sentinel file `.brainstorm/sessions/.last-prune`). Prevents pruning thrashing on every invocation.
5. **Validation before commit**: every JSONL line read by `loadSession()` is parsed via `BrainstormEnvelopeSchema`; lines that fail validation are SKIPPED (not deleted) with a stderr warning showing line number and reason. Quarantine: `.brainstorm/sessions/<sid>.quarantine.jsonl` accumulates skipped lines (capped at 100 per session; older entries dropped) so corruption never silently disappears.
6. **Crash safety**: each line is a self-contained JSON record; a partial line (process killed mid-write) becomes one parse-failed line that gets quarantined. The rest of the file is fine. No rebuild needed.

**No external lock library**: keep dependency footprint zero. The sentinel-file pattern is sufficient because (a) we never hold the lock during network I/O, (b) the entire critical section is local-FS-only, (c) lock holders are local processes (not distributed), (d) stale-lock detection handles crashed PIDs.

**Tests** (extend `tests/brainstorm-session-store.test.mjs`):
- Concurrent append simulation (spawn 5 child processes appending different rounds to the same sid) → final file has 5 valid lines, no corruption, no interleaved fragments
- Stale-lock recovery: pre-create lock with PID 99999 (not running) and old mtime → next append succeeds with stderr warning
- Corrupted line handling: pre-seed file with valid + invalid + valid lines → `loadSession` returns 2 rounds + emits stderr warning + quarantine file contains the invalid line
- Pruning: `.last-prune` mtime within 24h → prune is no-op; older → prune runs

### 10.E — `--with-context` contract (R1-H5)

Defined precisely:

| Property | Value |
|---|---|
| **Repeatable** | Yes — `--with-context "..."` may appear multiple times; concatenated in argv order with `\n\n---\n\n` separator |
| **Input** | Inline text only at v1. (`--with-context-file <path>` reserved for v1.1 — see §9) |
| **Max size per call** | 8000 chars per single `--with-context`; total combined ≤ 24000 chars across all flags. Helper validates BEFORE assembly; ArgvError on violation. |
| **Token-budget treatment** | Counted against the 10% provider-ceiling allocation (separate from resume budget) per §10.B rule 5 |
| **Redaction** | `redactSecrets()` applied per-flag-value before assembly (defence in depth) |
| **Precedence on conflict** | Wins over older summarised rounds; loses to last-2 verbatim rounds (verbatim is highest precedence — that's the user's most recent context) |
| **Persistence** | NOT written to session ledger as a separate field. Captured implicitly in the envelope's `topic` field if the user wants it persisted (helper concatenates topic + with-context into a single `topic` string when writing the round). Ledger entries are reproducible from topic alone |
| **Interaction with --continue-from** | Both can be passed together. `--with-context` appears AFTER the resume-context block in the user prefix (most-recent intent wins for the model's attention) |
| **Persistence** | NOT written to session ledger as a separate field. The composed envelope `topic` field captures the original `--topic` string only — `--with-context` is consult-only context for the round, not part of round identity |

**Tests** (extend `tests/brainstorm-round-extensions.test.mjs`):
- Multiple `--with-context` values → concatenated with separator
- Single value > 8000 chars → ArgvError
- Combined > 24000 chars → ArgvError
- Empty value → silently ignored
- Combined with `--continue-from` → both appear in assembled user prefix in correct order

### 10.F — Failure matrix (R1-M1): boundary failure modes

Every new failure boundary defined explicitly. Each row: failure mode → exit code → stdout contract → stderr → fallback.

| Boundary | Failure | Exit | Stdout | Stderr | Fallback |
|---|---|---|---|---|---|
| Helper | Missing `--sid` for `--continue-from` | 1 | `{ok:false, code:'ARGV_ERROR'}` | "Error: --continue-from requires --sid" | abort |
| Helper | Session file missing for `--continue-from <sid>` | 0 | Schema-valid envelope; resume-context empty | "[brainstorm] WARN: session <sid> not found — proceeding without resume context" | proceed as fresh round |
| Helper | Session file present but ALL lines corrupt | 0 | Schema-valid envelope; resume-context empty | "[brainstorm] WARN: session <sid> all lines invalid — quarantined; proceeding fresh" | proceed as fresh round |
| Helper | Session file present, some lines corrupt | 0 | Schema-valid envelope; resume-context uses valid lines only | "[brainstorm] WARN: session <sid> N invalid lines quarantined" | use valid rounds |
| Helper | One provider fails during round 1 + `--debate` requested | 0 | Envelope with successful provider's response + debate.<failed-provider>.state='skipped-no-peer' | "[brainstorm] WARN: debate skipped for <provider> — peer failed in round 1" | other provider's debate runs against empty peer (still useful as solo expansion) — or skip both if both round-1 failed |
| Helper | Both providers fail in round 1 | 0 | Schema-valid envelope; providers.[].state set | "[brainstorm] ERROR: both providers failed in round 1" | DO NOT run debate; do NOT append to session ledger |
| Helper | Total context exceeds provider ceiling | 2 | `{ok:false, code:'BUDGET_EXCEEDED'}` | "[brainstorm] ERROR: assembled context exceeds provider ceiling — reduce --with-context or --continue-from rounds" | abort (do not silently truncate user input) |
| Helper | Cannot create `.brainstorm/` (perm/disk) | 1 | `{ok:false, code:'STORAGE_FAILED'}` | "[brainstorm] FATAL: cannot create .brainstorm/sessions/ — <errno>" | abort |
| Hook | stdin payload is not valid JSON | 0 | (silent) | "[quickfix-hook] WARN: malformed stdin — skipping scan" | proceed (no system message) |
| Hook | tool_input has no `file_path`/`new_string`/`content` | 0 | (silent) | (silent) | proceed (no system message) |
| Hook | `.audit/quickfix-hits.jsonl` cannot be appended | 0 | (system message still emitted) | "[quickfix-hook] WARN: telemetry write failed — <errno>" | emit system message; skip telemetry |
| Audit pass | `quickfix` pass times out | (controlled by main audit-loop) | partial findings | timeout log | other passes proceed; `quickfix` findings empty |
| Settings.json edit | `.claude/settings.json` missing or invalid JSON | (registration step) | install-message | "Error: settings.json must be valid JSON before quickfix-hook can be registered" | user must fix settings.json by hand |

Tests (one per row):
- `tests/brainstorm-failure-matrix.test.mjs` (NEW) — covers helper rows
- `tests/quickfix-hook.test.mjs` (already planned) — extended to cover hook rows

### 10.G — Hook line-number contract (R1-M2)

Original plan promised `<file>:<line>` but `tool_input.new_string` is a snippet, not a full file with line offsets. **Drop the false promise**.

**Revised contract**:

- Hook emits `<file>` (relative path from cwd) + a SNIPPET (max 80 chars, with ellipsis truncation) — **no line number**.
- For Edit operations, the snippet is the relevant excerpt of `new_string` (the line containing the matched pattern).
- For Write operations, the snippet is the same — single line containing the match.
- Line number is RESERVED for v1.1 when we add `tool_response.fileSizeAfter` + diff-mapping logic (deferred to §9).

**Updated AC17** (replaces the original): hook output includes file + snippet (no `:line` claim).

**Updated `quickfix-patterns.mjs::matchPatterns()` return shape**:
```js
[{ name: string, severity: 'low'|'medium'|'high', snippet: string, suggestion: string }]
// NOTE: no `line` field at v1
```

System-message format:
```
⚠ Quick-fix pattern: <name> [<severity>] in <file>
Snippet: "<snippet>"
Suggest: <suggestion>
(Disable for this line: append // quickfix-hook:ignore | session: QUICKFIX_HOOK_DISABLE=1)
```

### 10.H — Updated File-Level Plan + Acceptance Criteria

**Add to §4** (file-level plan):
- `scripts/lib/brainstorm/insight-store.mjs` (NEW — see §10.A)
- `scripts/lib/brainstorm/resume-context.mjs` (NEW — see §10.B)
- `scripts/lib/brainstorm/provider-limits.mjs` (NEW — single-source provider ceilings, see §10.B)

**Add to §7** (acceptance criteria):
- AC31 — `slugifyTopic("How to do X?")` returns "how-to-do-x"; collision append yields "-2"
- AC32 — `saveInsight` idempotency: identical content twice → 1 file
- AC33 — `assembleResumeContext` with 0 prior rounds returns empty assembly
- AC34 — `assembleResumeContext` exceeding ceiling exits BUDGET_EXCEEDED (code 2)
- AC35 — `BrainstormEnvelopeSchema` accepts v1 fixtures via session-store reader (synthesised `sid`/`round` defaults + stderr warning)
- AC36 — Provider schema rejects helper-owned fields (`sid`/`round`/`capturedAt`/`schemaVersion`)
- AC37 — Concurrent append (5 child processes) → 5 valid lines, no corruption
- AC38 — Stale-lock recovery: pre-existing lock with dead PID + old mtime → append succeeds with warning
- AC39 — `--with-context` >8000 chars per flag → ArgvError
- AC40 — `--with-context` combined >24000 chars → ArgvError
- AC41 — Both providers fail in R1 → debate skipped, ledger NOT appended, exit 0 with envelope showing both failures
- AC42 — Helper exits BUDGET_EXCEEDED (code 2) when assembled context exceeds provider ceiling
- AC43 — Hook output includes file + snippet (no line number claim)
- AC44 — Quarantine file accumulates corrupt lines (cap 100) without losing valid session entries

### 10.I — Updated Acceptance Criterion AC17 (replaces original)

**Original AC17**: hook emits `{"systemMessage":"..."}` on hit including `<file>:<line>`.
**Revised AC17**: hook emits `{"systemMessage":"..."}` on hit including `<file>` and a `Snippet:` field (no `:line` claim per §10.G).

**AC2 update**: `--depth shallow` sets maxTokens to 300; `standard` to 600; `deep` to 1200; values come from `scripts/lib/brainstorm/depth-config.mjs::DEPTH_TOKENS` constant (single source).

---

## 11. R2 Audit Revisions — Contract Hardening

R2 surfaced 4H + 4M. All concern internal-consistency / contract gaps,
not new design holes. Fixed below; supersedes any earlier conflict.

### 11.A — Debate output contract (R2-H1): canonical shape

**Canonical**: `debate` is an **array of `DebateRoundSchema`** entries. The
object-keyed-by-provider notation in earlier sections is hereby removed.

Schema (replaces §10.C `DebateRoundSchema` definition — extensible to 3+ providers):

```js
export const DebateRoundSchema = z.object({
  provider:    z.enum(['openai','gemini']),  // who is speaking
  reactingTo:  z.enum(['openai','gemini']),  // whose round-1 response they read
  state:       z.enum(['ok','malformed','misconfigured','timeout','error','skipped-no-peer','skipped-self-only']),
  text:        z.string().nullable(),
  errorMessage:z.string().nullable(),
  usage:       z.object({}).passthrough().nullable(),
  latencyMs:   z.number().int().nonnegative(),
});
```

Rules:
- One entry per (speaker, peer) pair where round-1 produced a usable response for the peer.
- If only one provider returned `ok` in round 1, debate runs only for the other provider against that one peer (1 entry, `state:'ok'`). The successful provider gets `state:'skipped-self-only'` since it has no peer to react to.
- If both providers failed round 1, no debate entries at all (array is empty); `state:'skipped-no-peer'` is no longer used in array form (replaced by absence).

**§10.F failure-matrix update** (supersedes the earlier row): "One provider fails round 1 + `--debate` requested" → debate array contains 1 entry with `state:'ok'` from the surviving provider; no entry for the failed provider.

**AC4 update**: `--debate` triggers a second round; output JSON `debate` is an ARRAY of `DebateRoundSchema` entries; entry count equals number of (speaker, peer) pairs where peer succeeded in round 1.

### 11.B — CLI grammar contract (R2-H2): unambiguous syntax per mode

**Canonical command grammar** (single source — supersedes any prior mention):

```
# Mode: brainstorm round (default)
node scripts/brainstorm-round.mjs --topic "<text>" [flags]
node scripts/brainstorm-round.mjs --topic-stdin [flags]

# Mode: resume from prior session — sid is the FLAG VALUE, not a separate --sid
node scripts/brainstorm-round.mjs --topic "<text>" --continue-from <sid> [flags]

# Mode: save an insight from a session — sid + round are explicit + required
node scripts/brainstorm-round.mjs save --sid <sid> --round <n> --topic "<text>" --insight "<text>" [--tags <csv>]
node scripts/brainstorm-round.mjs save --sid <sid> --round <n> --topic "<text>" --insight-stdin [--tags <csv>]
```

Rules:
- `--continue-from <sid>` carries the sid as its own value. There is NO `--sid` flag in brainstorm-round mode.
- `save` is a positional subcommand (first non-flag argv). It REQUIRES `--sid` and `--round`. There is no `--continue-from` interaction with `save`.
- Each mode validates its own flag set via parseArgs; unknown flags for a given mode → ArgvError.

§10.F failure matrix row "Missing `--sid` for `--continue-from`" is REMOVED (this combination cannot occur with the canonical grammar). New row: "Missing `--sid` or `--round` in `save` mode" → exit 1 with `{ok:false, code:'ARGV_ERROR'}`.

**AC1 update**: `--help` lists exactly the canonical flag set per mode; brainstorm-mode help shows `--debate`, `--depth`, `--continue-from`, `--with-context` (no `--sid`); save-mode help shows `--sid`, `--round`, `--topic`, `--insight`, `--insight-stdin`, `--tags`.

### 11.C — `--with-context` persistence (R2-H3): single decision

**Decision**: `--with-context` is **NOT persisted**. Round identity = `(sid, round, topic)` where `topic` = the original `--topic` value verbatim. `--with-context` is consult-only context for the round and lives only in the prompt sent to providers, never in the ledger.

§10.E table corrected (one row, no contradictions):

| Property | Value |
|---|---|
| Persistence | NOT written to session ledger. Round identity = (sid, round, topic). Resume from this round will NOT recover the `--with-context` text — user re-supplies if needed |

Rationale: persisting `--with-context` would either bloat the topic field (mixing intent with context) or require a parallel field (more schema surface for a transient hint). Keeping it ephemeral matches its intent: it's a one-time nudge, not a durable property of the round.

### 11.D — Quickfix hook redaction + sensitive-path exclusion (R2-H4)

Hook output IS text egress (system-reminder shown to LLM; jsonl persisted). Redaction is mandatory.

**Updated hook pipeline** (replaces §10.G output rules where they conflict):

1. Extract `file_path` from `tool_input`.
2. **Sensitive-path short-circuit**: if `file_path` matches any of these, exit 0 silently (no scan, no telemetry):
   - `^\.env(\..+)?$`, `\.env\.local$`, `secrets?\.(json|yaml|yml|txt|env)$`
   - `^.*credentials?\..+$`, `^.*\.pem$`, `^.*\.key$`, `^.*\.crt$`, `^.*\.p12$`, `^.*\.pfx$`
   - Anything under `secrets/`, `credentials/`, `.aws/`, `.ssh/`
3. Extract `new_string` (Edit) or `content` (Write).
4. Run `matchPatterns()`.
5. **Redact each matched snippet** through `redactSecrets()` BEFORE composing the system message.
6. **Redact again** before appending the hit to `.audit/quickfix-hits.jsonl` (defence in depth — even after step 5, telemetry is a separate egress).

The exclusion list is single-sourced in `scripts/lib/quickfix-patterns.mjs::SENSITIVE_PATHS`; hook reads it. Adding a new sensitive-path glob = one append in that constant.

**Tests** (extend `tests/quickfix-hook.test.mjs`):
- File path `.env` → hook exits 0 silently (no system message, no telemetry append)
- File path `secrets/api-keys.json` → same
- Snippet containing `sk-...` shaped string → systemMessage and telemetry both contain redacted form (`[REDACTED:openai-key]` or whatever the redactor emits)
- Path `src/auth.js` (not sensitive) → normal scan applies

### 11.E — Lock contention protocol (R2-M1): bounded acquisition

§10.D specified stale-lock recovery but not the healthy-contention path. **Defined now** — single shared lock helper:

**New file**: `scripts/lib/brainstorm/file-lock.mjs`

Exports:
- `withFileLock(lockPath, opts, fn) → Promise<result>` — acquires lock, runs `fn()`, releases lock (in `finally`)
- `opts.maxWaitMs` default 5000
- `opts.retryBaseMs` default 50
- `opts.retryJitterMs` default 30

Algorithm:
1. Try `fs.openSync(lockPath, 'wx')` (exclusive create) — atomic on POSIX/NTFS.
2. On EEXIST: check stale-lock criteria (mtime > 60s AND owning PID dead). If stale → force-unlink and retry from step 1 (ONCE, with a stderr warning).
3. On EEXIST + healthy: sleep `retryBaseMs * 2^attempt + random(0, retryJitterMs)` (capped exponential backoff), retry. After `maxWaitMs` total elapsed → throw `{code: 'LOCK_TIMEOUT', lockPath, heldBy: <pid-from-lockfile>}`.
4. On lock acquired: write `{pid: process.pid, acquiredAt: ISO}` into the lock file (so step-2 stale check can see PID).
5. Run `fn()`; release via `unlinkSync` in `finally`.

Both `appendSession()` and `pruneOldSessions()` use `withFileLock(<sid>.jsonl.lock, ...)`. `pruneOldSessions` operates per-file (acquires each session's lock individually) — never holds a directory-wide lock. Helpers in `session-store.mjs` are thin wrappers over `withFileLock`.

**Failure matrix addition** (§10.F):
- Helper | Lock acquisition timeout (concurrent writer) | 1 | `{ok:false, code:'LOCK_TIMEOUT'}` | "[brainstorm] ERROR: lock timeout for sid <sid> after <maxWaitMs>ms — held by PID <p>" | abort

### 11.F — Budget unit canonicalisation (R2-M2): tokens end-to-end

§10.B mixed token ceilings with character estimators. **Canonical unit**: tokens. Char-to-token estimator is documented and isolated.

**Updated `provider-limits.mjs`**:

```js
// Single estimator — chars / 4 is the well-known rule of thumb for English.
// All assembly + budget arithmetic uses TOKENS, not chars.
export function estimateTokens(text, _model = null) {
  return Math.ceil((text || '').length / 4);
}
export const PROVIDER_INPUT_CEILING_TOKENS = Object.freeze({
  openai: { 'latest-gpt': 128_000, 'latest-gpt-mini': 128_000, default: 100_000 },
  gemini: { 'latest-pro': 1_000_000, 'latest-flash': 1_000_000, default: 100_000 },
});
export const RESUME_BUDGET_FRACTION = 0.4;
export const WITH_CONTEXT_FRACTION  = 0.1;
```

§10.B rule restatement: "resume budget = floor(ceiling_tokens * 0.4)" — always tokens, never chars. `assembleResumeContext` returns `estimatedTokens` (matches budget unit). Telemetry log: `[brainstorm] resume: included X verbatim / Y summarised; dropped Z; tokens M/N`.

**Per-provider vs shared**: helper builds the resume-context ONCE using the **smallest provider ceiling** among the requested providers (most restrictive wins — guarantees the prompt fits all providers). The estimated-tokens log notes which provider's ceiling drove the budget. If providers have wildly different ceilings (e.g. gemini 1M, openai 128k → ratio 7.8x) and the smallest leaves >30% slack on the largest, helper logs an info note: "[brainstorm] note: budget driven by openai (128k); gemini ceiling 1M leaves headroom. Set --models to one only for larger budget."

### 11.G — Backward-compat round numbering for v1 records (R2-M3)

§10.C said legacy `round=0` default. Multi-line legacy sessions would collapse all rounds onto round 0. **Fixed**:

Session-store reader, when loading a v1 (no-`schemaVersion`) session, assigns `round` deterministically by **file-order index** (line N → round N, 0-indexed). Generated values clearly marked: a synthesised round entry sets `_synthesised: { fields: ['sid', 'round', 'capturedAt', 'schemaVersion'] }` so callers can tell synthesised data from real. One stderr warning per session, not per line: `[brainstorm] WARN: session <sid> uses pre-v2 schema; auto-synthesising sid/round/capturedAt for <N> lines`.

`assembleResumeContext` treats synthesised rounds the same as real rounds (chronological order = file order = synthesised round order).

### 11.H — `slugifyTopic` responsibility split (R2-M4)

Pure slugification and collision-resolution are different responsibilities. **Split**:

```js
// scripts/lib/brainstorm/insight-store.mjs

// Pure, deterministic — same topic always returns same slug
export function slugifyTopic(topic) {
  return topic.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'untitled';
}

// Filesystem-aware — appends -2, -3, ... if directory already exists
function resolveUniqueSlug(baseSlug, insightsRootDir) {
  let slug = baseSlug;
  let n = 2;
  while (fs.existsSync(path.join(insightsRootDir, slug))) {
    slug = `${baseSlug}-${n++}`;
    if (n > 1000) throw new Error(`slug collision storm for ${baseSlug}`);
  }
  return slug;
}
```

Rule: `saveInsight()` calls `slugifyTopic` then `resolveUniqueSlug` — slug is decided once per insight (saved into frontmatter as `topicSlug`). Once an insight under `<base-slug>/` exists, future insights for the same topic reuse THAT slug (no new collision check) — collision check only applies when creating a NEW slug directory.

§10.A AC31 update: tests cover both functions:
- `slugifyTopic("How to do X?")` returns `"how-to-do-x"` (pure, repeatable)
- `slugifyTopic("How to do X?")` called twice returns same value
- `resolveUniqueSlug("how-to-do-x", emptyDir)` returns `"how-to-do-x"`
- `resolveUniqueSlug("how-to-do-x", dirWithExistingFolder)` returns `"how-to-do-x-2"`

### 11.I — Updated AC list

- AC1 — `--help` lists exactly the canonical flag set per mode (per §11.B grammar)
- AC4 — `--debate` output JSON `debate` is an array of DebateRoundSchema entries (per §11.A)
- AC17 — hook output includes `<file>` and `Snippet:` (no `:line`); snippet is REDACTED through `redactSecrets()` (per §11.D)
- AC31 — `slugifyTopic("How to do X?")` returns `"how-to-do-x"`; `resolveUniqueSlug` appends `-2` on collision (per §11.H)
- AC45 — Sensitive-path short-circuit: hook on `.env`, `secrets/x.json`, `*.pem` exits 0 silently (no scan, no telemetry)
- AC46 — Snippet containing secret-shaped string is redacted in BOTH systemMessage and `.audit/quickfix-hits.jsonl` (per §11.D)
- AC47 — Lock contention with healthy peer: 5 concurrent appends serialise via `withFileLock`; all complete; no LOCK_TIMEOUT under maxWaitMs=5000
- AC48 — Lock timeout: hold a lock from one process, second process attempts append → exits LOCK_TIMEOUT after maxWaitMs (test uses maxWaitMs=500 to keep test fast)
- AC49 — All token budgets use `estimateTokens()` (chars/4); `PROVIDER_INPUT_CEILING_TOKENS` is the single ceiling table
- AC50 — Multi-line legacy session loads with deterministic round numbering by file-order index; `_synthesised` field flags generated values; one stderr warning per session
- AC51 — `--continue-from <sid>` accepts sid as its OWN value (no `--sid`); `save --sid <sid> --round <n>` requires both flags
- AC52 — `--with-context` is NOT persisted to ledger; round identity = `(sid, round, topic)` only

---

## 12. R3 Audit Revisions — Final Contract Polish

R3 surfaced 4H + 4M, all valid contract precision issues my R2 fixes
introduced. HIGH count plateaued (5→4→4) so this is the final plan
revision before Gemini gate. Issues fixed:

### 12.A — Debate state machine (R3-H1): canonical 4-case table

Earlier wording was self-contradictory. **Canonical state machine** —
single source of truth replacing all prior debate-output rules:

| Round-1 outcome | Debate adapter calls | Output `debate` array |
|---|---|---|
| **Both succeed** | 2 calls (openai reacts to gemini, gemini reacts to openai) | 2 entries, both `state:'ok'` |
| **Only A succeeds** (B failed) | 0 adapter calls | empty array (`debate: []`) |
| **Only B succeeds** (A failed) | 0 adapter calls | empty array (`debate: []`) |
| **Both fail** | 0 adapter calls | empty array (`debate: []`) |

Rationale: a debate entry requires (a) a peer round-1 response to react to, AND (b) a working speaker. Lone-success cases satisfy only one of these — no debate is meaningful. The `skipped-self-only` and `skipped-no-peer` enum values from §11.A are HEREBY REMOVED from `DebateRoundSchema`. Updated enum: `state: z.enum(['ok','malformed','timeout','error'])` only — there are no "skipped" entries because we don't write entries for skipped pairs.

§10.F failure-matrix row "One provider fails round 1 + `--debate` requested" supersedes: outputs `debate: []`, `[brainstorm] WARN: debate skipped — only 1/2 providers succeeded in round 1, no peer-response pair available`.

**AC4 update**: `debate` array length is exactly 2 when both providers succeed in round 1 with `--debate` flag; exactly 0 in all other cases.

### 12.B — Round assignment under lock (R3-H2)

Round numbering belongs INSIDE the locked critical section. **Updated `appendSession()` contract**:

```js
// scripts/lib/brainstorm/session-store.mjs
async function appendSession({sid, envelope}) {
  const lockPath = `.brainstorm/sessions/${sid}.jsonl.lock`;
  return await withFileLock(lockPath, {}, () => {
    // Step 1: read current file (under lock) to find max(round) of valid lines
    const existing = readSessionLinesUnvalidated(sid);   // returns [{round}, ...]
    const nextRound = existing.length === 0
      ? 0
      : Math.max(...existing.map(e => e.round ?? 0)) + 1;
    // Step 2: validate envelope WITH the assigned round
    const finalEnvelope = { ...envelope, round: nextRound };
    const parsed = BrainstormEnvelopeV2Schema.safeParse(finalEnvelope);
    if (!parsed.success) throw { code: 'SCHEMA_INVALID', issues: parsed.error.issues };
    // Step 3: append the validated line — still under lock
    fs.appendFileSync(`.brainstorm/sessions/${sid}.jsonl`, JSON.stringify(parsed.data) + '\n');
    return { round: nextRound };
  });
}
```

Caller passes envelope WITHOUT `round` field; `appendSession` assigns it. Two concurrent `--continue-from <sid>` invocations now serialise via the lock and get distinct round numbers. **Helper main never assigns round itself** — always delegates to `appendSession`.

**Failure matrix addition** (§10.F): "Concurrent invocation got different round than expected" → No-op; this is the correct behaviour. Caller can re-read the returned `{round}` if it needs to know what was assigned.

**AC53**: 5 concurrent appends to same sid produce rounds `0..4` (no duplicates, no gaps).

### 12.C — Schema backwards-compat as union (R3-H3)

§10.C alias `BrainstormOutputSchema = BrainstormEnvelopeSchema` made the new helper-owned fields REQUIRED for any direct parse — breaking existing callers. **Fix**: alias becomes a normalising union.

Updated `scripts/lib/brainstorm/schemas.mjs`:

```js
// V1 (pre-this-plan) — never had sid/round/capturedAt/schemaVersion
export const BrainstormEnvelopeV1Schema = z.object({
  topic: z.string(),
  redactionCount: z.number().int().nonnegative(),
  resolvedModels: z.record(z.string()),
  providers: z.array(ProviderResponseSchema),
  totalCostUsd: z.number().nonnegative(),
});

// V2 — adds session metadata + optional debate
export const BrainstormEnvelopeV2Schema = BrainstormEnvelopeV1Schema.extend({
  sid: z.string().min(1),
  round: z.number().int().nonnegative(),
  capturedAt: z.string().datetime(),
  schemaVersion: z.literal(2),
  debate: z.array(DebateRoundSchema).optional(),
  _synthesised: z.object({ fields: z.array(z.string()) }).optional(),  // for v1→v2 normalised reads
});

// Public alias — UNION of v1 + v2 with normalisation toward v2
export const BrainstormOutputSchema = z.union([BrainstormEnvelopeV2Schema, BrainstormEnvelopeV1Schema]);

// Helpers ALWAYS write v2 (the writer schema is V2 only)
export const BrainstormEnvelopeWriteSchema = BrainstormEnvelopeV2Schema;
```

Reader rules:
- New writes → `BrainstormEnvelopeWriteSchema` (v2 strict).
- Reads via session-store → returns v2 shape; v1 lines normalised with `_synthesised: { fields: ['sid','round','capturedAt','schemaVersion'] }`.
- External callers parsing brainstorm output (legacy or v1 fixtures) use `BrainstormOutputSchema` (the union) — both v1 and v2 succeed.

**AC29 update**: existing pre-v2 fixtures must parse via `BrainstormOutputSchema.safeParse()` and succeed without errors; same fixtures via `BrainstormEnvelopeV2Schema.safeParse()` must FAIL (no synthesis at the strict-write boundary). Tests cover both.

**AC35 update**: session-store `loadSession()` returns v2-shaped objects with `_synthesised` populated for v1 source lines.

### 12.D — Path normalisation for sensitive-path matching (R3-H4)

Sensitive-path matching must normalise to a canonical form first. Added helper:

```js
// scripts/lib/quickfix-patterns.mjs
export function normalisePath(pathInput) {
  // 1. Replace backslashes with forward slashes (Windows compat)
  // 2. Strip drive prefix (C:/) — sensitive paths are repo-relative
  // 3. Lower-case (Windows is case-insensitive — sensitive match must be too)
  // 4. Strip leading ./
  return String(pathInput || '')
    .replace(/\\/g, '/')
    .replace(/^[a-zA-Z]:\//, '')
    .toLowerCase()
    .replace(/^\.\//, '');
}

export const SENSITIVE_PATH_PATTERNS = [
  /^\.env(\..+)?$/,           /\.env\.local$/,
  /^secrets?\.(json|yaml|yml|txt|env)$/,
  /credentials?\..+$/,
  /\.(pem|key|crt|p12|pfx)$/,
  /(^|\/)(secrets|credentials|\.aws|\.ssh)\//,
];

export function isSensitivePath(pathInput) {
  const p = normalisePath(pathInput);
  return SENSITIVE_PATH_PATTERNS.some(re => re.test(p));
}
```

Hook calls `isSensitivePath(file_path)` BEFORE any other check. All matching done on the normalised form. Tests:
- `isSensitivePath('.env')` → true
- `isSensitivePath('.\\.env')` → true (normalised → `.env`)
- `isSensitivePath('C:\\repo\\.env')` → true (drive-stripped + slash-normalised)
- `isSensitivePath('SECRETS/keys.json')` → true (case-insensitive)
- `isSensitivePath('src/auth.js')` → false

**AC54**: `isSensitivePath` returns true for backslash-style and uppercase variants of sensitive paths.

### 12.E — Telemetry path in .gitignore (R3-M1)

Update §4 file plan + AC list:

- `.gitignore` EDIT now includes BOTH `.brainstorm/` AND `.audit/quickfix-hits.jsonl`
- **AC55**: `git check-ignore .audit/quickfix-hits.jsonl` exits 0 (path is ignored)

### 12.F — Language-aware suppression syntax (R3-M2)

`// quickfix-hook:ignore` works for JS/TS but not Python. Define language-aware suppression by file extension:

```js
// scripts/lib/quickfix-patterns.mjs
const SUPPRESS_BY_EXT = {
  '.js': /\/\/\s*quickfix-hook:ignore/,
  '.mjs': /\/\/\s*quickfix-hook:ignore/,
  '.ts': /\/\/\s*quickfix-hook:ignore/,
  '.tsx': /\/\/\s*quickfix-hook:ignore/,
  '.jsx': /\/\/\s*quickfix-hook:ignore/,
  '.py': /#\s*quickfix-hook:ignore/,
  '.sh': /#\s*quickfix-hook:ignore/,
  '.rb': /#\s*quickfix-hook:ignore/,
  '.html': /<!--\s*quickfix-hook:ignore\s*-->/,
  '.css': /\/\*\s*quickfix-hook:ignore\s*\*\//,
  '.scss': /\/\/\s*quickfix-hook:ignore/,
  // Default fallback: accept either // or # form
  '__default__': /(?:\/\/|#)\s*quickfix-hook:ignore/,
};

export function hasSuppression(line, filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  const re = SUPPRESS_BY_EXT[ext] || SUPPRESS_BY_EXT.__default__;
  return re.test(line);
}
```

`matchPatterns(diffText, {filePath})` calls `hasSuppression(line, filePath)` per matched line; suppressed matches are excluded.

**AC56**: `// quickfix-hook:ignore` suppresses in `.js` files; `# quickfix-hook:ignore` suppresses in `.py` files; cross-language usage is silently ineffective (e.g. `// ` in `.py` file does NOT suppress).

### 12.G — Slug discovery via stored mapping (R3-M3)

Pure `slugifyTopic` + `resolveUniqueSlug` without persistence means the same topic re-slugified later wouldn't find its earlier collision-resolved slug. **Fix**: scan-existing-folders-for-topic-match (no separate index file — the directories ARE the index).

```js
// scripts/lib/brainstorm/insight-store.mjs
function findExistingSlugForTopic(topic, insightsRootDir) {
  if (!fs.existsSync(insightsRootDir)) return null;
  const baseSlug = slugifyTopic(topic);
  // Candidates are baseSlug, baseSlug-2, baseSlug-3, ...
  // For each existing candidate dir, peek at one frontmatter file inside it;
  // if the recorded `topic` matches our exact input, this is the right slug.
  for (let n = 1; n <= 1000; n++) {
    const slug = n === 1 ? baseSlug : `${baseSlug}-${n}`;
    const dirPath = path.join(insightsRootDir, slug);
    if (!fs.existsSync(dirPath)) return null;  // first non-existent → no more candidates
    const files = fs.readdirSync(dirPath);
    if (files.length === 0) continue;  // empty dir, treat as available but check next
    // Read first .md file's frontmatter
    const sample = path.join(dirPath, files.find(f => f.endsWith('.md')));
    if (!sample) continue;
    const content = fs.readFileSync(sample, 'utf-8');
    const fm = parseFrontmatter(content);
    if (fm?.topic === topic) return slug;
  }
  return null;  // no match in 1000 attempts (slug-storm guard)
}

export function saveInsight({sid, round, topic, insightText, tags = []}) {
  const insightsRoot = '.brainstorm/insights';
  // 1. Try to find existing slug for this exact topic
  let slug = findExistingSlugForTopic(topic, insightsRoot);
  // 2. If none found, allocate new slug via collision-resolution
  if (slug === null) slug = resolveUniqueSlug(slugifyTopic(topic), insightsRoot);
  // ...rest of save logic
}
```

Topic-string match is exact (case + whitespace sensitive). Adding tests:
- First save of "How to do X?" → slug `how-to-do-x`
- Different topic with same slugified base "How to-do-X" (different exact topic) → slug `how-to-do-x-2`
- Second save of "How to do X?" → reuses `how-to-do-x` (NOT `-3`)
- Second save of "How to-do-X" → reuses `how-to-do-x-2`

**AC31 update**: future saves for the same exact topic discover and reuse the previously-allocated slug via `findExistingSlugForTopic`.

### 12.H — Save mode validates sid/round exist (R3-M4)

`save` mode should refuse to write insights for non-existent rounds. Updated contract:

```js
// In save mode of brainstorm-round.mjs
async function runSaveMode(args) {
  // Validate sid + round exist in ledger BEFORE writing insight
  const session = loadSession(args.sid);
  if (!session) {
    process.stderr.write(`Error: session ${args.sid} not found in .brainstorm/sessions/\n`);
    process.exit(1);
  }
  const matchingRound = session.rounds.find(r => r.round === args.round);
  if (!matchingRound) {
    process.stderr.write(`Error: round ${args.round} not found in session ${args.sid} (session has rounds ${session.rounds.map(r => r.round).join(',')})\n`);
    process.exit(1);
  }
  // Optional: warn if --topic doesn't match round's topic (don't fail; user might be capturing a meta-insight)
  if (args.topic !== matchingRound.topic) {
    process.stderr.write(`[brainstorm] WARN: --topic does not match round's recorded topic (insight saved with provided topic)\n`);
  }
  // Then save
  return saveInsight({sid: args.sid, round: args.round, topic: args.topic, insightText: args.insight, tags: args.tags || []});
}
```

**AC57**: `save --sid <unknown> ...` exits 1 with "session not found" error.
**AC58**: `save --sid <known> --round <unknown> ...` exits 1 with "round not found in session" error.
**AC59**: `save --topic` mismatches recorded round's topic → succeeds with stderr WARN (not a hard error — user might capture a meta-insight).

---

## 13. Gemini Final Review Revisions

Gemini surfaced 4 NEW findings (2H, 1M, 1L) — all introduced by my R2/R3
contract fixes. All real, all in-scope.

### 13.A — Sensitive-path basename matching (G-H1)

`normalisePath` strips drive letters but absolute paths like
`/Users/name/repo/.env` still have parent directories prepended, so
`/^\.env(\..+)?$/` (anchored at start) misses them.

**Fix**: change patterns to match either at start OR after a slash:

```js
export const SENSITIVE_PATH_PATTERNS = [
  /(^|\/)\.env(\..+)?$/,           /(^|\/)\.env\.local$/,
  /(^|\/)secrets?\.(json|yaml|yml|txt|env)$/,
  /(^|\/)credentials?\..+$/,
  /\.(pem|key|crt|p12|pfx)$/,
  /(^|\/)(secrets|credentials|\.aws|\.ssh)\//,
];
```

**Tests** (extend §12.D):
- `isSensitivePath('/Users/foo/repo/.env')` → true
- `isSensitivePath('C:\\repo\\.env')` → true (post-normalisation)
- `isSensitivePath('/home/me/.aws/credentials')` → true
- `isSensitivePath('myenv.env')` → false (basename starts with non-`.`; not the dot-env file)

**AC54 update**: `isSensitivePath` returns true regardless of leading absolute-path components for `.env`, `secrets/`, `.aws/`, `.ssh/`, and key/cert extensions.

### 13.B — Round assignment with V1 file-index fallback (G-H2)

`readSessionLinesUnvalidated()` returns V1 lines with no `round` field, so `Math.max(...lines.map(e => e.round ?? 0))` collapses everything to 0 — new V2 record gets round=1, colliding with `loadSession`'s later file-index assignment.

**Fix**: `readSessionLinesUnvalidated()` applies the same file-index fallback as `loadSession()`:

```js
function readSessionLinesUnvalidated(sid) {
  const filePath = `.brainstorm/sessions/${sid}.jsonl`;
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
  return lines.map((line, idx) => {
    try {
      const parsed = JSON.parse(line);
      // V2 records have explicit round; V1 records get file-index fallback
      // (matches loadSession's normalisation so appendSession + loadSession
      // agree on round numbering)
      return { round: parsed.round ?? idx, _raw: parsed };
    } catch {
      return { round: idx, _raw: null, _invalid: true };
    }
  });
}
```

`appendSession` then computes `nextRound = max(round) + 1` and gets the
correct value regardless of whether prior lines were V1 or V2.

**AC53 update**: extends to cover mixed V1/V2 file: 3 V1 lines + append 1 V2 → V2 gets round=3 (V1 lines normalised to rounds 0,1,2).

### 13.C — Cost preflight counts assembled context (G-M1)

`preflightEstimateUsd` currently uses `topic.length` only. With `--continue-from` + `--with-context`, assembled context can be 50k+ tokens. Estimate is wildly off.

**Fix**: assembly happens BEFORE preflight in `main()`. Updated execution order:

```
1. parseArgs (existing)
2. readStdin if needed (existing)
3. redactSecrets on raw topic (existing)
4. resolveModels + refreshModelCatalog (existing)
5. NEW: if --continue-from → loadSession(sid) and assembleResumeContext()
6. NEW: if --with-context → validate + concatenate per §10.E rules
7. Compute totalInputChars = redactedTopic.length + assembledContextChars
8. preflightEstimateUsd({modelId, inputChars: totalInputChars, maxOutputTokens})  ← now reflects real prompt size
9. Log preflight + assembly telemetry to stderr
10. Dispatch to providers with the assembled prompt
11. Optional debate round
12. appendSession (acquires lock; assigns round)
```

**AC60**: cost preflight log line reflects `assembledContextChars + topic.length`, not `topic.length` alone. Test stubs `assembleResumeContext` to return a known size and asserts the preflight log includes that magnitude.

### 13.D — Depth tokens align with existing default (G-L1)

Plan mapped `deep:1200` but existing helper default `maxTokens=1500`. Auto-promotion to `deep` would REDUCE tokens — wrong direction.

**Fix**: realign `DEPTH_TOKENS` so `standard` matches the existing default and `deep` exceeds it:

```js
// scripts/lib/brainstorm/depth-config.mjs
export const DEPTH_TOKENS = Object.freeze({
  shallow: 500,    // tighter than current default — deliberate restriction
  standard: 1500,  // matches existing helper default — no-flag behaviour preserved
  deep: 4000,      // expansive — for architecture / schema / migration prompts
});
```

`--max-tokens` and `--depth` interact as follows:
- If both provided → `--max-tokens` wins (explicit beats heuristic). Stderr WARN: `[brainstorm] WARN: --max-tokens overrides --depth (used max=N, ignored depth=X)`.
- If neither provided → `standard` (1500) — preserves existing default.
- If only `--depth` provided → table value.
- If only `--max-tokens` provided → as-is.

**AC2 update**: `DEPTH_TOKENS = {shallow:500, standard:1500, deep:4000}`. Auto-promoting "design the architecture" to `deep` yields 4000-token cap (more headroom than the 1500 default — the auto-promote actually helps).

---

## 14. Gemini Round-2 Revisions

### 14.A — Debate prompt includes assembled context (G2-H1)

`buildDebatePrompt` was specified to take `{otherProvider, otherResponse, originalTopic}` only — dropping the assembled resume-context and `--with-context`. Debate rounds would see a different (much smaller) prompt than round 1, defeating the point of "react to peer in conversation context".

**Fix** — extend the signature:

```js
// scripts/lib/brainstorm/debate-prompt.mjs
export function buildDebatePrompt({
  otherProvider,           // 'openai' | 'gemini'
  otherResponse,           // peer's round-1 text
  originalTopic,           // raw --topic string
  assembledContext,        // { systemPreface, userPrefix } from assembleResumeContext (may be empty)
  withContextText,         // assembled --with-context string (may be empty)
}) {
  return {
    systemPrompt: [/* concept-level brainstorm preamble */, assembledContext.systemPreface || ''].filter(Boolean).join('\n\n'),
    userMessage: [
      assembledContext.userPrefix || '',
      `Original topic: ${originalTopic}`,
      withContextText ? `Additional context provided:\n${withContextText}` : '',
      `\n${otherProvider}'s round-1 response:\n${otherResponse}`,
      `\nWhere do you push back? Where do you agree? What's the strongest move from this?`,
    ].filter(Boolean).join('\n\n'),
  };
}
```

Helper main passes the SAME `assembledContext` + `withContextText` to BOTH round 1 dispatch AND `buildDebatePrompt`. Single source.

**AC4 + AC5 update**: when `--debate` is combined with `--continue-from` and/or `--with-context`, the debate round's prompt INCLUDES the assembled session context (verifiable via test stub that captures the prompt sent to adapters).

### 14.B — Slug discovery null-safety on `find` (G2-H2)

`files.find(f => f.endsWith('.md'))` returns `undefined` when no .md file exists (e.g. directory contains only `.DS_Store` or `.gitkeep`). `path.join(dirPath, undefined)` throws `TypeError [ERR_INVALID_ARG_TYPE]`.

**Fix** — extract + guard:

```js
function findExistingSlugForTopic(topic, insightsRootDir) {
  if (!fs.existsSync(insightsRootDir)) return null;
  const baseSlug = slugifyTopic(topic);
  for (let n = 1; n <= 1000; n++) {
    const slug = n === 1 ? baseSlug : `${baseSlug}-${n}`;
    const dirPath = path.join(insightsRootDir, slug);
    if (!fs.existsSync(dirPath)) return null;
    const files = fs.readdirSync(dirPath);
    const mdFile = files.find(f => f.endsWith('.md'));
    if (!mdFile) continue;  // dir exists but no .md inside — skip to next candidate
    const sample = path.join(dirPath, mdFile);
    const content = fs.readFileSync(sample, 'utf-8');
    const fm = parseFrontmatter(content);
    if (fm?.topic === topic) return slug;
  }
  return null;
}
```

**AC61**: `findExistingSlugForTopic` does not throw when an insight directory contains only non-`.md` files (`.DS_Store`, `.gitkeep`); it skips that directory and continues to the next candidate.

### 14.C — Preflight accounts for debate (G2-M1)

When `--debate` is on, debate adds up to 2 extra LLM calls per debate-eligible (speaker, peer) pair. Preflight ignored these.

**Fix** — preflight loop:

```js
// In main(), around step 8 (preflight)
const totalCalls = args.debate
  ? args.models.length + (args.models.length === 2 ? 2 : 0)  // R1 calls + R2 debate calls (only if 2 providers)
  : args.models.length;
const preflightTotal = args.models.reduce((sum, p) => {
  const r1 = preflightEstimateUsd({modelId: resolvedModels[p], inputChars: totalInputChars, maxOutputTokens: args.maxTokens});
  // Debate adds another call per provider (only when 2 providers and both succeed in R1).
  // Pre-call we don't know if both will succeed — assume yes for upper-bound estimate.
  const debate = (args.debate && args.models.length === 2)
    ? preflightEstimateUsd({modelId: resolvedModels[p], inputChars: totalInputChars + args.maxTokens * 4, maxOutputTokens: args.maxTokens})  // input includes peer response
    : 0;
  return sum + r1 + debate;
}, 0);
process.stderr.write(`  [brainstorm] Pre-call cost ceiling: ~$${preflightTotal.toFixed(4)} (${totalCalls} calls: ${args.models.length} round-1${args.debate && args.models.length === 2 ? ' + 2 debate' : ''})\n`);
```

Preflight is an UPPER BOUND — actual cost may be lower if debate doesn't run (one R1 fails). Stderr line documents the breakdown so users see why the number jumped with `--debate`.

**AC60 update**: cost preflight log line documents debate-call inclusion when `--debate` is set; total = R1 calls + (debate ? R2 debate calls : 0).

### 14.D — YAML frontmatter via library, not string interpolation (G2-L1)

Naive `topic: ${topic}` interpolation breaks for topics with colons, quotes, newlines. Use a YAML serializer.

**Fix** — `insight-store.mjs` uses `yaml.stringify` from the existing `yaml` dep (or installs `yaml` if not already a dep — the existing AGENTS.md doesn't list it, check before assuming):

```js
// Pre-condition: install `yaml` as a dep if not already present.
// Verify: `node -e "import('yaml').then(()=>console.log('present'))"`
import yaml from 'yaml';

function buildInsightFile({sid, round, topic, topicSlug, insightText, tags = []}) {
  const fm = {
    sid, round, topic, topicSlug,
    capturedAt: new Date().toISOString(),
    ...(tags.length > 0 ? { tags } : {}),
  };
  const fmYaml = yaml.stringify(fm).trimEnd();  // yaml lib handles escaping
  return `---\n${fmYaml}\n---\n${insightText}\n`;
}
```

Implementation note for the implementer: if `yaml` is not yet installed (`node -e "import('yaml').catch(()=>process.exit(1))"` exits 1), install via `npm install yaml` and add to `package.json` dependencies. Document the new dep in the commit message.

**AC62**: `saveInsight` correctly serialises topics containing `:`, `"`, `\n`, and other YAML-special characters; round-trip parse via `yaml.parse` returns identical strings.

---

## 15. Gemini Round-3 Revisions

### 15.A — Redact BEFORE truncate (G3-H1)

Snippet truncation order matters: if a 100+ char API key crosses the 80-char snippet boundary, truncating first then redacting could leave a partial-secret in the output that the redactor's regex no longer matches.

**Fix** — execution order in `matchPatterns()`:

```js
// scripts/lib/quickfix-patterns.mjs — per-match handling
function buildMatchEntry(line, patternName, severity, suggestion) {
  // 1. Redact FIRST against the full line (so redactSecrets sees complete patterns)
  const redactedLine = redactSecrets(line).text;
  // 2. THEN truncate the redacted line to 80 chars with ellipsis
  const snippet = redactedLine.length > 80
    ? redactedLine.slice(0, 77) + '...'
    : redactedLine;
  return { name: patternName, severity, snippet, suggestion };
}
```

Hook then concatenates `snippet` into `systemMessage` and telemetry — both already-redacted-and-truncated.

**AC63**: matched line containing a long API key (>60 chars) yields a snippet where the secret is fully replaced by the redactor's marker (e.g. `[REDACTED:openai-key]`); no partial-secret characters appear in the snippet, systemMessage, or telemetry jsonl.

### 15.B — SKILL.md Step 0 parses all new flags (G3-H2)

The original SKILL.md Step 0 is hardcoded to extract `--models` and `--with-gemini` only. With the new flags landing, the skill must parse all of them OR pass through unrecognised flags to the helper.

**Fix** — replace SKILL.md Step 0 with a pass-through-aware parser:

```markdown
## Step 0 — Parse Arguments

Recognise these flags (anywhere in the args; consume their values):

| Flag | Mode |
|---|---|
| `--with-gemini` | brainstorm round |
| `--models <csv>` | brainstorm round |
| `--openai-model <id>` | brainstorm round |
| `--gemini-model <id>` | brainstorm round |
| `--debate` | brainstorm round (opt-in second round) |
| `--depth shallow\|standard\|deep` | brainstorm round |
| `--continue-from <sid>` | brainstorm round (resume mode) |
| `--with-context "<text>"` | brainstorm round (repeatable, concatenated) |

Special positional subcommand:
- If first non-flag argv is `save`, switch to SAVE MODE. Required: `--sid <sid>`, `--round <n>`, `--topic "<text>"`, `--insight "<text>" | --insight-stdin`. Optional: `--tags <csv>`. No `--continue-from` allowed in save mode.

Strip recognised flags + values; the remainder becomes the **topic** in
brainstorm-round mode (or is forbidden in save mode — error out).

If the topic is empty AND mode is brainstorm-round, ask the user what
they want to brainstorm and stop.
```

This gives the LLM the same full grammar the helper supports — Step 0 stays the canonical parse.

**AC8 update**: SKILL.md Step 0 documents all flags and the `save` positional subcommand.
**AC64**: SKILL.md Step 0 documents both `--debate` and `--continue-from` AND the `save` positional subcommand (verifiable by grep).

### 15.C — DebateRoundSchema includes cost; totalCostUsd sums both rounds (G3-M1)

`DebateRoundSchema` dropped `estimatedCostUsd` (Zod strips unrecognised). And `totalCostUsd` only summed round-1 `settled[]`, not the debate calls.

**Fix** — schema + reduction:

```js
// scripts/lib/brainstorm/schemas.mjs — extend DebateRoundSchema
export const DebateRoundSchema = z.object({
  provider:          z.enum(['openai','gemini']),
  reactingTo:        z.enum(['openai','gemini']),
  state:             z.enum(['ok','malformed','timeout','error']),
  text:              z.string().nullable(),
  errorMessage:      z.string().nullable(),
  usage:             z.object({}).passthrough().nullable(),
  latencyMs:         z.number().int().nonnegative(),
  estimatedCostUsd:  z.number().nonnegative().nullable(),  // ← restored
});
```

```js
// scripts/brainstorm-round.mjs main() — totalCostUsd reduction includes debate
const round1Cost = settled.reduce((s, p) => s + (p.estimatedCostUsd ?? 0), 0);
const debateCost = (debateResults || []).reduce((s, d) => s + (d.estimatedCostUsd ?? 0), 0);
const totalCostUsd = round1Cost + debateCost;
```

**AC65**: when `--debate` runs and both providers succeed in round 1 (so 2 debate calls fire), `totalCostUsd` equals sum of all 4 calls' `estimatedCostUsd` (verifiable by stubbing adapters with known costs).

---

## 16. Gemini Round-4 Revisions (Final)

After 4 Gemini rounds the plan converges to the documented audit-plan
behaviour: "CONCERNS_REMAINING after Gemini round 2 (cap) → proceed to
implementation". Final precision fixes below; remainder is left to the
/audit-code phase.

### 16.A — Shell-safety for save mode topic (G4-H1)

User-supplied `--topic "..."` interpolated into the bash command line is a shell-injection vector.

**Fix** — SKILL.md ALWAYS uses `--topic-stdin` for the helper. Topic value goes through stdin file (per existing R2-H2 pattern in `.claude/tmp/`):

```bash
# In SKILL.md Step 3 (render-time)
SID=$(date +%s%3N)
echo "$TOPIC_TEXT" > .claude/tmp/brainstorm-${SID}-topic.txt
node scripts/brainstorm-round.mjs --topic-stdin --models openai,gemini \
  [--debate] [--depth deep] \
  --out .claude/tmp/brainstorm-${SID}.json \
  < .claude/tmp/brainstorm-${SID}-topic.txt
rm -f .claude/tmp/brainstorm-${SID}-topic.txt
```

For save mode, both `--topic` and `--insight` go via stdin (or via files; helper supports both `--insight-stdin` and `--topic-stdin`):

```bash
# Save mode — topic AND insight via stdin file pattern
echo "$TOPIC_TEXT" > .claude/tmp/save-${SID}-topic.txt
echo "$INSIGHT_TEXT" > .claude/tmp/save-${SID}-insight.txt
node scripts/brainstorm-round.mjs save --sid <sid> --round <n> \
  --topic-stdin --insight-stdin \
  < /dev/stdin  # NOTE: helper reads BOTH from stdin via two-segment delimiter pattern
# Helper accepts a "TOPIC|||INSIGHT" stdin format when both --topic-stdin AND --insight-stdin are passed:
#   first line up to literal "---END-TOPIC---" marker = topic; remainder = insight
cat .claude/tmp/save-${SID}-topic.txt > /tmp/combined.txt
echo "---END-TOPIC---" >> /tmp/combined.txt
cat .claude/tmp/save-${SID}-insight.txt >> /tmp/combined.txt
node scripts/brainstorm-round.mjs save --sid <sid> --round <n> --topic-stdin --insight-stdin < /tmp/combined.txt
rm -f .claude/tmp/save-${SID}-* /tmp/combined.txt
```

**Helper update** — `parseArgs` and stdin reader handle the 2-segment stdin format when both `--topic-stdin` and `--insight-stdin` are set:

```js
async function readSplitStdin() {
  const raw = await readStdin();
  const idx = raw.indexOf('\n---END-TOPIC---\n');
  if (idx < 0) throw new ArgvError('--topic-stdin + --insight-stdin requires "---END-TOPIC---" delimiter on its own line');
  return { topic: raw.slice(0, idx), insight: raw.slice(idx + '\n---END-TOPIC---\n'.length) };
}
```

**AC66**: SKILL.md never interpolates `$TOPIC_TEXT` or user-supplied content directly into the bash command — always uses stdin file pattern (verifiable by grep: no `--topic "` literal in SKILL.md execution blocks).
**AC67**: save mode supports `--topic-stdin --insight-stdin` with `---END-TOPIC---` delimiter; both inputs survive shell-special characters intact.

### 16.B — Skill renders SID + round so user can resume (G4-M1)

User can't `--continue-from <sid>` if they never see the sid. Fix the SKILL.md output format:

**Step 1 Kickoff card update**:
```
═══════════════════════════════════════
  /brainstorm — Asking: openai, gemini
  Topic: <first 80 chars>
  Session: <sid>  ← NEW
═══════════════════════════════════════
```

**Step 4 (Present the views) — append**:
```
> **Session**: `<sid>` round `<n>`. Resume with `/brainstorm continue <sid> <refinement>`.
> **Save an insight from this round**: `/brainstorm save <sid> <n> "<insight>"`.
```

(The skill expands `/brainstorm save <sid> <n> "<insight>"` into the helper invocation per §16.A.)

**AC68**: After every brainstorm round, SKILL.md output includes the sid value AND the round number AND the resume/save instructions.

### 16.C — Atomic lock acquisition with content (G4-M2)

`fs.openSync(lockPath, 'wx')` then write is not atomic — a peer reading between open and write sees an empty file. Use `fs.writeFileSync(lockPath, content, {flag:'wx'})` which atomically opens-with-O_EXCL AND writes the content in one syscall:

```js
// scripts/lib/brainstorm/file-lock.mjs
function tryAcquireLock(lockPath) {
  const payload = JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() });
  try {
    fs.writeFileSync(lockPath, payload, { flag: 'wx' });  // atomic open-EXCL + write
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  }
}
```

The stale-lock detection then never sees an empty lock file — `JSON.parse` on the read content always succeeds (or the lock genuinely is corrupt and stale-detection treats it as orphaned).

**AC69**: lock file content is non-empty immediately after acquisition; concurrent readers always see valid JSON or get EEXIST (not a partial/empty file).

### 16.D — Prune failure non-fatal at startup (G4-L1)

`pruneOldSessions` runs at helper startup; a `LOCK_TIMEOUT` would fail the whole invocation just to do best-effort housekeeping.

**Fix** — wrap prune in try/catch, log + continue:

```js
// scripts/brainstorm-round.mjs main(), early in startup
try {
  const pruned = pruneOldSessions(30);  // returns number of files removed
  if (pruned > 0) process.stderr.write(`  [brainstorm] pruned ${pruned} old session(s)\n`);
} catch (err) {
  // Best-effort housekeeping — never fail the invocation on prune problems.
  process.stderr.write(`  [brainstorm] WARN: prune skipped — ${err.code || err.message}\n`);
}
```

`pruneOldSessions` itself uses `withFileLock` per file with `maxWaitMs:500` (short — don't compete for actively-used sessions). If a file is locked, it's skipped (LOCK_TIMEOUT caught locally inside prune), not abandoned-and-thrown. Resulting count reflects only successfully-pruned files.

**AC70**: helper startup never fails on `LOCK_TIMEOUT` from prune; stderr WARN documents the skip.

---

## 17. Plan-Audit Convergence Note

Audit-plan executed:
- **GPT R1**: 5H/2M (all valid, all in-scope, all fixed inline → §10)
- **GPT R2**: 4H/4M (all valid, all in-scope, all fixed inline → §11)
- **GPT R3**: 4H/4M (all valid, all in-scope — HIGH plateau but all real precision bugs, fixed inline → §12)
- **Gemini R1**: 4 new (2H, 1M, 1L) — fixed → §13
- **Gemini R2**: 4 new (2H, 1M, 1L) — fixed → §14
- **Gemini R3**: 3 new (2H, 1M) — fixed → §15
- **Gemini R4**: 4 new (1H, 2M, 1L) — fixed → §16

Verdict at end of plan-audit: **CONCERNS_REMAINING** per documented post-cap behaviour. Proceeding to implementation; remaining rigor-pressure issues that may surface in implementation will be caught by /audit-code's H/M/L pass per user directive.

Total acceptance criteria: **70 mechanically-verifiable**. Total file changes planned: **18 files** (5 NEW libs in `scripts/lib/brainstorm/` + `scripts/lib/quickfix-patterns.mjs` + `.claude/hooks/quickfix-scan.mjs` + edits to helper, schemas, openai-audit, SKILL.md, AGENTS, settings.json, .gitignore, domain-map; plus 6 NEW test files).







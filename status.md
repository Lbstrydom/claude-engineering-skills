# Project Status Log

## 2026-05-15 — Architecture-Intent PR-B: Python & Java adapters

PR-B of the 3-PR architecture-intent series. Adds two new pure-JS import
adapters so the architecture pass works on Python and Java repos, not just
JS/TS. Shipped via the full `/cycle` (plan → audit-plan → implement →
audit-code → ship).

**What shipped**:
- `scripts/lib/arch-intent/adapters/python.mjs` (new) — pure-JS Python
  import analyser. Char-level comment/string stripper (PEP 701 f-string
  brace tracking), packaging-aware source-root discovery (pyproject.toml /
  `src/` / `__init__.py` walk, monorepo-aware), most-specific-root module
  index, three-state resolution (resolved-local / proven-external /
  unresolved). No Python runtime required.
- `scripts/lib/arch-intent/adapters/java.mjs` (new) — pure-JS Java import
  analyser. Strips `//`, `/* */`, strings, text blocks. Resolution index
  from parsed `package` declarations + source-set derivation. Progressive
  FQN resolution (nested types, static imports), wildcard handling
  (package + JLS 7.5.2 type-import-on-demand), same-package cross-domain
  blind-spot surfaced via `_meta.packagesSpanningDomains`. No JVM required.
- `scripts/lib/repo-stack.mjs` — `hasJavaSources()` + `java` pushed to
  `stackKinds`; data-driven (root markers OR `git ls-files`).
- `scripts/sync-to-repos.mjs` — both adapters added to `CORE_SCRIPTS`.
- `tests/arch-intent-adapter-python.test.mjs`,
  `tests/arch-intent-adapter-java.test.mjs` (new),
  `tests/repo-stack.test.mjs` (+Java cases) — 90 adapter/stack tests.
- `docs/plans/arch-intent-pr-b-python-java-adapters.md` (new),
  `docs/completed/arch-intent-pr-b-audit-summary.md` (new).

**Decisions Made**:
- *Python: pure-JS parser, not `import-linter`* — `import-linter` needs a
  Python runtime everywhere `/audit-code` runs + its own `.importlinter`
  config (a second source of truth, conflicts with `domain-map.json`).
- *Java: pure-JS parser, not ArchUnit codegen* — ArchUnit test-file
  generation is async/out-of-band and cannot return violations to the
  synchronous adapter contract. Java parses imports + returns violations
  like every other adapter.
- *Three-state resolution* — `unresolved` imports stay visible in `_meta`,
  never silently absorbed as `vendor`; keeps resolver gaps observable.
- *Adapter contract frozen* — PR-B conforms to PR-A's
  `adapter-contract.mjs`; did not modify it.
- Pre-existing `scripts/.sync-manifest.json` change left unstaged
  (unrelated to PR-B, scope-discipline).

**Audit**: `/cycle` ran 3 GPT + 2 Gemini rounds at the plan stage and
3 GPT + 2 Gemini rounds at the code stage. Final Gemini verdict
**APPROVE** (coherence "Strong"). Full suite 2023 pass / 0 fail.

**Next Steps**:
- PR-C — Postgres adapter (separate plan, separate `/cycle`; the
  schema/RLS/function model differs from imports, per parent plan §11).

---

## 2026-05-14 — Anthropic backend routing (Agent SDK credit prep)

Pluggable Anthropic client factory landed in preparation for the Max 20x Agent SDK
$200/mo credit (effective 2026-06-15). One env flag (`CLAUDE_BACKEND=cli`) routes
Claude calls through `claude -p` instead of the raw `@anthropic-ai/sdk`, shifting
billing to the credit pool. Default stays `sdk` so the merge is dormant until
the credit redemption opens; before that date, flipping `cli` would cannibalise
the interactive Max budget (documented as a ⚠️ block in AGENTS.md and `.env.example`).

**Mechanism**: `scripts/lib/anthropic-client.mjs` exports
`createAnthropicClient()` returning a `.messages.create()` shape compatible
with the raw SDK. Two backends behind a single env-resolved factory.
Module-global cache keyed on effective resolved env values + redactor
identity, with cache bypass for custom redactors to prevent collisions.

**Files Affected**:
- `scripts/lib/anthropic-client.mjs` (new) — factory + cli adapter, Zod-validated CLI envelope, Windows process-tree-kill, command-injection-safe arg quoting
- `scripts/anthropic-ping.mjs` (new) — `npm run anthropic:ping` smoke test for either backend
- `tests/anthropic-client.test.mjs` (new) — 41 tests including explicit cmd.exe command-injection regression
- `scripts/lib/context.mjs` — `_llmCondense` brief generator migrated to factory
- `scripts/lib/neighbourhood-query.mjs` — Haiku rephrase migrated to factory (side-effect: env-gate now correctly ordered)
- `scripts/lib/llm-wrappers.mjs` — `callClaude` JSDoc notes factory compatibility
- `docs/plans/anthropic-backend-routing.md` (new) — plan + acceptance criteria + R1→R3+Gemini audit trail
- `AGENTS.md` — new "Anthropic Backend Routing" section with pre-Jun-15 warning + claude-trace prerequisite + Pending-migration list (5 remaining direct-SDK sites)
- `.env.example` — `CLAUDE_BACKEND`, `CLAUDE_BIN`, `CLAUDE_CLI_TIMEOUT_MS` with rollout warnings
- `package.json` — `anthropic:ping` script

**Real bugs caught + fixed during /audit-code (3 GPT rounds + 2 Gemini rounds)**:
- Windows process-tree leak: `proc.kill()` on `shell:true`-spawned `.cmd` only killed the cmd shell; orphan `claude.exe` survived timeout/abort. Fix: `taskkill /T /F /PID <pid>` on Windows.
- Redactor cache-key collision: two distinct custom redactor functions collapsed to one cache entry. Fix: cache only for default redactor or `null`; custom functions bypass cache.
- Structured `system: [{type:'text',...}]` not redacted: `applyRedactor` only traversed string form. Fix: handle array form.
- cmd.exe command injection in `quoteWinArg`: used `\"` for embedded quotes, but cmd.exe does NOT honour `\"` as an escape — a payload like `foo " & whoami &` would close the quoted span and shell-evaluate the metacharacters. Fix: use `""` (doubled-quote) which is valid for both cmd.exe and CommandLineToArgvW. Caught by Gemini Step 7.

**Decisions Made**:
- Default `redactor` is `redactSecrets` from `lib/sanitizer.mjs` (deny-by-default egress). Opt-out via `redactor: null`.
- `resolveBackend()` throws on invalid `CLAUDE_BACKEND` instead of silent fallback — backend choice affects billing, fail loudly at config load.
- `claude -p` has no `--max-tokens` flag; passing `max_tokens` to cli backend emits one-time stderr warning rather than throwing (throwing would break existing callers that pass it benignly).
- cli adapter throws via `assertOneShotTextMessages` on multi-turn or non-text content rather than silently flattening. Documented limitation, by-design.
- Migrated only 2 of 7 direct-Anthropic call sites this session; the other 5 (`evolve-prompts`, `gemini-review`, `refine-prompts`, `summarise`, `summarise-domains`) listed under AGENTS.md "Pending migration" as mechanical drop-ins.
- Pre-existing `scripts/.sync-manifest.json` modification left unstaged per scope-discipline rule (unrelated to this work).

**Audit summary**: 3 GPT rounds (R1 14 → R2 15 → R3 14 findings); R3 mechanical
fixes applied (JSDoc consistency, timeout bounds-check, ping error logging,
deny-by-default comment). Gemini Step 7 CONCERNS → fixed cmd.exe injection →
Gemini Step 7.1 **APPROVE**. 41/41 tests passing. End-to-end ping smoke test:
"pong" in 639ms via sdk backend.

**Next Steps**:
- After 2026-06-15: install `claude-trace`, baseline token spend, flip
  `CLAUDE_BACKEND=cli` in `.env`, re-verify via `npm run anthropic:ping`.
- Follow-up PR: migrate remaining 5 direct-SDK call sites listed in AGENTS.md
  "Pending migration".
- Follow-up: `putCached()` in [neighbourhood-query.mjs](scripts/lib/neighbourhood-query.mjs)
  grows unbounded (flagged by Gemini G2 as out-of-scope for this PR).

---

## 2026-05-13 — Audit-tool staleness check (Option A)

Closes the recurring "I didn't know engineering-skills shipped new audit-tool
files" problem.  Three sync-related blockers in PR 39 / 55 / 56 in
wine-cellar-app over 24h all traced to consumer repos running stale upstream
files without any in-band signal.

**Mechanism**: `npm run sync` regenerates `scripts/.sync-manifest.json`
(SHA-256 of every CORE_SCRIPTS file at the current commit) before copying
to consumers.  Consumer-side `openai-audit.mjs` fetches the manifest from
`raw.githubusercontent.com` on every audit startup, compares hashes, prints
a non-blocking warning when files diverge.  Network failure swallowed
silently (never blocks audit).

**Files Affected**:
- `scripts/lib/sync-manifest.mjs` (new) — pure logic: hash, fetch, compare, validate
- `scripts/check-audit-tool-version.mjs` (new) — standalone CLI for explicit checks (`npm run sync:version-check`)
- `scripts/.sync-manifest.json` (new, generated) — committed artefact, 101 files at current commit
- `scripts/sync-to-repos.mjs` — regenerates manifest at start of every sync; adds 3 files to CORE_SCRIPTS
- `scripts/openai-audit.mjs` — 2.5s non-blocking version check in main()
- `skills/ship/SKILL.md` — new Step 6.0 documents manifest regeneration before staging
- `package.json` — `sync:version-check` script
- `docs/plans/audit-tool-staleness-check.md` (new) — plan + acceptance criteria

**Audit cycle**: 4 GPT rounds + 2 Gemini gates against the plan.  R1 HIGHs
(3) → R2 HIGHs (2, new aspects) → R3 HIGHs (2, new aspects) → R4 HIGHs (0).
Gemini round 1 = CONCERNS_REMAINING (2 new findings: silent partial
manifest + keep-alive socket hang).  Both fixed (`generateManifest` now
throws in strict mode; `https.get` passes `agent: false`).  Gemini round 2 =
APPROVE with 1 LOW (manifest self-exclusion check pre-normalisation — fixed).

**Key fixes shipped (defence in depth)**:
- Zod boundary validation on upstream manifest (`SyncManifestSchema`)
- `RelPathSchema` rejects absolute paths, traversals, drive letters — symmetric on producer + consumer
- `path.resolve` containment guard in `compareToUpstream`
- 2 MiB response size cap before `JSON.parse` (memory-exhaustion defence)
- Promise.race end-to-end deadline that calls `req.destroy()` on timeout (was leaking sockets)
- `agent: false` on `https.get` so CLI exits cleanly (no 5s keep-alive hang)
- `atomicWriteFileSync` for the manifest itself
- `process.exitCode` + return (not `process.exit()`) so stdout/stderr flush under pipe
- Cross-OS path normalisation (Windows `\` → POSIX `/`)
- Strict manifest generation refuses to ship a partial manifest
- Differentiated CLI verdicts: `NETWORK_ERROR` vs `INVALID_MANIFEST`
- `findRepoRoot()` via `git rev-parse --show-toplevel` (cwd-independent)
- Non-Error throwable coercion at the failure-handling boundary

**Test status**: 2041 pass, 1 pre-existing vendoring-provenance fail
(unrelated — local provenance file is gitignored and older than current
audit-loop SKILL.md).

## 2026-05-12 — Architecture-Intent PR-A (framework + JS adapter) + Dead-Code Phase 1 (orphan-introduced check)

### Bundled commit — two related bodies of work

**1. Architecture-Intent Framework PR-A** (`scripts/lib/arch-intent/` + JS/TS adapter via dependency-cruiser)
- C4-model-based per-repo architecture-intent framework with cross-language adapter contract (PR-A ships JS/TS; PR-B Python/Java; PR-C Postgres planned).
- New artefacts: `docs/architecture-intent.md` (human narrative + Mermaid C4) + `.audit-loop/domain-map.json` (machine SoT with `allowedDeps` whitelist).
- New CLI: `scripts/arch-intent-bootstrap.mjs` — seeds `allowedDeps` from current import graph (`--baseline-from-graph`); writes atomically; iterates all detected stacks.
- New module: `scripts/lib/arch-intent/adapter-contract.mjs` — framework spine (inventoryFiles + per-stack fault isolation + deadIntent + pass-state taxonomy).
- New adapter: `scripts/lib/arch-intent/adapters/js-ts.mjs` — dependency-cruiser-backed JS/TS import graph (canonical edge-kind taxonomy: local-file / vendor-npm / vendor-node-builtin / vendor-typescript-alias / unresolved / dynamic / type-only).
- New Wave 1.5 architecture pass in `scripts/openai-audit.mjs` (LLM-bouncer pattern: mechanical violation detection + LLM severity classification + deterministic fallback rubric).
- 4 new test files (~35 tests): contract, doc-parser, domain-resolver, load-config.

**2. Dead-Code Phase 1 — orphan-introduced check** (`scripts/lib/audit/` new module set)
- New pure detector `scripts/lib/audit/orphan-introduced.mjs` — diff-driven structural orphan detection (born-orphan and left-orphan subkinds with exact remover attribution).
- New `scripts/lib/audit/diff-scope-resolver.mjs` — git I/O + AST pre-edge extraction via `git worktree` + dependency-cruiser; handles A/M/D/R/C statuses (variable-width records); `-z` null-byte parsing throughout; SOURCE_EXTENSIONS pre-filter; package.json + tsconfig reverse-resolution for entry-points; explicit partial-parse state propagation.
- New `scripts/lib/audit/findings-pipeline.mjs` — unified post-processing (normalize → fingerprint → ledger-suppress → accept-v1-suppress). Returns `{survivors, suppressed}` for per-pass orchestration telemetry. `findingFingerprint` delegates non-orphan findings to `findings.mjs/semanticId()` for SoT identity. accept-v1 suppression is **kind-scoped to `orphan-introduced`** (Gemini-final-gate fix: prevents cross-pass leak).
- New `scripts/lib/audit/orphan-metrics.mjs` — lock-safe single-batch JSONL writer; `wx`-flag file initialization (race-free); inside-try-block telemetry (no unhandled rejection).
- New `scripts/lib/audit/glob-match.mjs` — shared glob utility (extracted from deferral-classifier duplication).
- 5 new Zod schemas in `scripts/lib/schemas.mjs`: OrphanPassState, ChangedFile, DiffScope, HeadGraphMeta, OrphanIntroducedFinding.
- `js-ts.mjs` adapter extended with two-track `_meta` (violation-track excludes type-only; orphan-track INCLUDES type-only edges — type imports keep files structurally alive).
- Wave 1.5b orchestration wiring in `openai-audit.mjs`.
- Audit cycle: 3 GPT rounds + 5 Gemini rounds during /audit-plan; 3 GPT rounds + 2 Gemini gates during /audit-code. ~30 findings addressed (mix of fix, dismiss, compromise via GPT deliberation). Gemini caught a cross-pass accept-v1 leak and a wrong-fingerprint-shape — both fixed.
- 51 new tests; full suite **2041/2042** pass (1 pre-existing vendoring-SHA-drift failure unrelated to this work).

### Files Affected (this commit)

**Architecture-Intent PR-A**:
- New: `docs/architecture-intent.md` + `docs/architecture-intent.template.md`
- New: `scripts/arch-intent-bootstrap.mjs`
- New: `scripts/lib/arch-intent/` (adapter-contract.mjs, adapters/js-ts.mjs, domain-resolver.mjs, errors.mjs, intent-doc-parser.mjs, load-config.mjs)
- New: `tests/arch-intent-{contract,doc-parser,domain-resolver,load-config}.test.mjs`
- New: `.audit-loop/domain-map.json` (extended with allowedDeps + descriptions)

**Dead-Code Phase 1**:
- New: `scripts/lib/audit/{orphan-introduced,diff-scope-resolver,findings-pipeline,orphan-metrics,glob-match}.mjs`
- New: `tests/{orphan-introduced,diff-scope-resolver,findings-pipeline}.test.mjs`
- New: `docs/plans/dead-code-phase-1-orphan-introduced.md` (full plan + implementation log)
- New: `docs/plans/architecture-intent-framework.md`

**Modified**:
- `scripts/lib/schemas.mjs` — +8 Zod schemas
- `scripts/lib/arch-intent/adapters/js-ts.mjs` — +15 LOC two-track meta
- `scripts/openai-audit.mjs` — +493 LOC (arch-intent Wave 1.5 + orphan Wave 1.5b)
- `scripts/lib/repo-stack.mjs` + `scripts/cross-skill.mjs` — `stackKinds[]` plumbing
- `scripts/sync-to-repos.mjs` — added arch-intent + audit-lib files to CORE_SCRIPTS
- `.gitignore` — added `.audit/orphan-metrics.jsonl`

### Open deferrals (phase 2 of dead-code work)
- R3/H2 preimage-resolution-parity test gate
- Config-injection layer for entry-points + test-path patterns
- `arch-intent`'s `git ls-files` lacks `-z` (Gemini-R2/G1; pre-existing arch-intent debt)
- Cross-LLM verification for `/repo-scan` (separate phase 2 skill)
- Knip / vulture / PurgeCSS wrap layer
- Clustering pipeline for refactor blast-radius bounding

---

## 2026-05-11 (later) — Gemini-gate scope fix + OpenAI prompt prefix-cache restructure

### Changes (bundled commit — two related fixes)

**1. Gemini-gate scope fix** (`scripts/gemini-review.mjs` + shared docs)
- Added `transcript.changed_files` field as Step 7 transcript requirement.
- New rule 8 in REVIEW_SYSTEM: `new_findings[]` entries must cite a file from `Files In Scope (PR diff)` block.
- Tightened rule 7: `wrongly_dismissed[]` entries must trace to a prior dismissed finding OR provide explicit linkage from unchanged-file evidence to in-scope changed file (provenance requirement).
- New `applyScopeFilter()` post-output filter drops out-of-scope `new_findings`; logs `[scope-dropped]` to stderr + records `_scopeFilteredCount`/`_scopeFilteredFindings` on result envelope.
- Updated canonical doc at `docs/audit/shared-references/gemini-gate.md` + auto-synced to 4 mirrors.
- Audited in 3 GPT rounds + 2 Gemini rounds (REJECT final round was a Gemini hallucination — fabricated GPT quote contradicted by R1 stderr; documented).

**2. OpenAI prompt prefix-cache restructure** (`scripts/openai-audit.mjs` + new `scripts/lib/audit/prompt-builder.mjs`)
- New `buildAuditPassPrompt` pure function: 3-message structure (stable msg #1 = brief+plan+files; dynamic msg #2 = rulings; dynamic msg #3 = code) — preserves rulings-before-code instruction salience while keeping msg #1 byte-stable for OpenAI prefix caching.
- Migrated all 14 audit call sites in `openai-audit.mjs` to use `buildCachePrompt` helper.
- `_callGPTOnce` / `callGPT` / `safeCallGPT` now accept structured `{ system, messages }` OR legacy `{ systemPrompt, userPrompt }`; hybrid input rejected with `LlmError({category:'config'})` (fail-fast on programmer bugs); `safeCallGPT` re-throws config errors but stays graceful for LLM/runtime errors.
- `cached_tokens` telemetry threaded through entire call chain; aggregated to `_cacheMetrics` on the merged result + session manifest; `[cache] input=… cached=… hitRate=…%` stderr line per audit run.
- Opt-in cache-seed wrapper in `runMapReducePass` (`AUDIT_CACHE_SEED=1`) — sequential seed of smallest unit then parallel fanout; `shouldSeedCache()` policy checks `units.length > 1` + stable-prefix ≥ 1024 tokens; `throwIfConfigError` re-throws config-category rejections from Promise.allSettled (fail-fast preserved through fanout).
- `runMapReducePass` signature changed: now takes `(openai, files, passName, buildPromptForUnit, ...)` — per-unit prompt is built by caller closure.
- 40 new tests (22 prompt-builder + 18 wrapper-contract).
- Audited 2 GPT rounds + 1 Gemini round → Gemini APPROVE.

### Files Affected
- `scripts/gemini-review.mjs` (+rule 8 + scope block + applyScopeFilter + rule 7 provenance)
- `scripts/openai-audit.mjs` (~150 LOC change: prompt-builder integration, telemetry, cache-seed, test exports)
- `scripts/lib/audit/prompt-builder.mjs` (NEW — ~150 LOC pure function + helpers)
- `tests/prompt-builder.test.mjs` (NEW — 22 tests)
- `tests/openai-wrapper-contract.test.mjs` (NEW — 18 tests)
- `docs/audit/shared-references/gemini-gate.md` (+Flavour 2 section, +Step 7.1 refresh + Rule 7 cross-ref)
- `docs/plans/openai-prefix-cache.md` (NEW — 600-line plan, audited 3+2 rounds)
- `docs/plans/gemini-gate-scope-fix.md` + audit-summary (NEW)
- Auto-synced mirrors at `skills/audit-{plan,code}/references/gemini-gate.md` + `.claude/skills/audit-{plan,code}/references/gemini-gate.md`

### Audit Outcomes
- Gemini-gate plan: GPT R1→R2 PASS, Gemini R1 CONCERNS→R2 APPROVE (with HIGH hallucination documented)
- Prefix-cache plan: GPT R1 NEEDS_REVISION→R2 NEEDS_REVISION→R3 NEEDS_REVISION→Gemini R1 CONCERNS→R2 APPROVE; verification audit GPT R1 SIGNIFICANT_ISSUES (3 HIGHs — all rebutted/dismissed) → R2 NEEDS_FIXES (H:0 plateau, MEDIUMs are R1 re-raises) → Gemini APPROVE (1 LOW spread-order polish fixed)

### Next Steps
- Follow-up PR: deferred snapshot + integration + R2-churn-defense tests + their fixtures.
- Empirical cache-hit-rate measurement across 5+ real audits; flip `AUDIT_CACHE_SEED` default to ON once median R2 hit-rate > 30%.

---

## 2026-05-11 — Symbol-index bugs: arch:refresh --force + arch:duplicates thin-delegate

### Changes
- **Bug 1 — `refresh.mjs:--force` was a no-op**: when `openRefreshRun` failed with `REFRESH_IN_FLIGHT` and `--force` was passed, control fell through to `throw err`. Added an abort-then-retry path: query the stale `refresh_runs` row via `getReadClient()`, call `abortRefreshRun({reason: 'aborted by --force'})`, then re-attempt `openRefreshRun` once. Uses the existing import — no new dependencies.
- **Bug 2 — `arch:duplicates` flagged thin-delegate facades as duplication**: extracted `isThinDelegate()` heuristic to `scripts/lib/symbol-index/thin-delegate.mjs` (text-based: `<member.access>(<passthrough-args>)`). Wired into `extract.mjs` candidate loop with `stats.skippedDelegate` counter + done-progress line. Default-on; `--include-delegates` flag disables for debug/visibility.
- Added 29 unit tests (`tests/thin-delegate.test.mjs`) covering positive/negative/input-guard/argument-passthrough/VariableDeclaration-prefix/async-function-expression cases.
- Heuristic tightened twice during audit: (a) argument-passthrough rule (no operators/literals/objects/ternaries in args) — added per GPT R1 M4 compromise; (b) VariableDeclaration `name = function(...)` prefix-strip + `async` variant — added per Gemini R1/R2 review.
- Updated `docs/plans/symbol-index-bugs.md` with the actual repo test path + audit-ruling annotations + revised trade-off discussion.

### Files Affected
- `scripts/symbol-index/refresh.mjs` — Bug 1 force-abort path; `--include-delegates` flag passthrough + warning
- `scripts/symbol-index/extract.mjs` — Bug 2 thin-delegate filter; `--include-delegates` flag + warning
- `scripts/lib/symbol-index/thin-delegate.mjs` (NEW) — heuristic helper with argument-passthrough rule + JSDoc limitations
- `tests/thin-delegate.test.mjs` (NEW) — 29 unit cases
- `docs/plans/symbol-index-bugs.md` — updated test path + audit-ruling annotations
- `docs/plans/symbol-index-bugs-audit-summary.md` (NEW) — convergence summary
- `.audit/tech-debt.json` — captured 3 out-of-scope pre-existing items (extract.mjs IO error swallowing, hardcoded TS enum literals at lines 70-77, extractSymbols cognitive complexity 47)

### Audit Outcome
- **GPT (3 rounds)** → R1: 8 findings (5 in-scope adjudicated, 3 debt) → R2: 6 findings (all re-raises/false-positives, all adjudicated) → R3: convergence stop (only re-raises with new hashes)
- **Gemini final review (2 rounds, MANDATORY)** → R1 CONCERNS: 1 valid (FunctionExpression prefix) → fixed → R2 CONCERNS: 2 (async-FE false negative → fixed; `git log --grep` → out-of-scope hallucination, dismissed)
- Final: H:0 M:0 substantively, 29/29 thin-delegate tests pass, 1901/1902 full suite (1 pre-existing failure in `vendoring-provenance.test.mjs` is gitignored local artefact unrelated to this PR)

### Decisions Made
- Skip-at-extraction over store-and-classify-downstream — preserves index storage cost vs schema-retrofit cost; visibility-preservation shipped in same change-set as `--include-delegates` flag per audit ruling.
- Text-based heuristic over AST-level classification — keeps the recent ts-morph memory-pressure fix intact (releases SourceFile after extraction); 11 → 29 test cases cover the validated edge cases.
- Argument-passthrough rule: any operator/literal/object/ternary in arg position disqualifies. More conservative than the original plan's stance (which accepted `x ?? defaultVal` as facade); now correctly rejects it.

### Next Steps
- Optional: tackle deferred debt items (M5/M6/M7) when extract.mjs is refactored for the broader pipeline split.
- Consumer repos pick up the fix via plugin sync — no per-repo action needed.

---

## 2026-04-01 — Supabase Learning Loop, God Module Refactor, Audit Pipeline Fixes

### Changes
- Wired all 9 Supabase tables: bandit arms sync, FP patterns, adjudication events, prompt variants (learning-store.mjs)
- Connected Thompson Sampling bandit reward updates from rebuttal deliberation outcomes
- Split shared.mjs (1608 lines) → 7 focused modules under scripts/lib/ (schemas, file-io, ledger, code-analysis, context, findings, config) + barrel re-export
- Fixed bandit Beta posterior algorithm (was broken threshold, now proper alpha/beta update)
- Added atomic writes for ledger, bandit, and FP tracker persistence (atomicWriteFileSync)
- Enforced schema validation at trust boundaries (callGemini rejects invalid responses, writeLedgerEntry validates entries)
- Consolidated schema source of truth: zodToGeminiSchema() replaces hand-maintained JSON Schemas
- Centralized config validation in lib/config.mjs
- Made Gemini final review mandatory (not convergence-gated)
- Added Step 7.1: Claude deliberates on Gemini findings, then Gemini re-verifies (closed loop)
- Increased Gemini thinking budget to 16384 tokens
- Replaced silent .catch(() => {}) with error logging throughout
- Added fuzzy file discovery for plan paths that don't match exact filenames
- Added 47 unit tests (node:test) covering bandit, schemas, ledger, FP tracker
- Verified by 3-round GPT-5.4 audit + Gemini 3.1 Pro final review

### Files Affected
- scripts/lib/ (new) — 7 focused modules extracted from shared.mjs
- tests/ (new) — shared.test.mjs (33 tests), bandit.test.mjs (14 tests)
- scripts/shared.mjs — replaced 1608-line monolith with 80-line barrel re-export
- scripts/openai-audit.mjs — direct lib/ imports, bandit reward wiring, error logging
- scripts/gemini-review.mjs — derived schemas, 16K thinking budget, validation enforcement
- scripts/bandit.mjs — proper Beta posterior, atomic writes, flush on exit, warning on unknown arms
- scripts/learning-store.mjs — 5 new Supabase sync functions
- .claude/skills/audit-loop/SKILL.md — mandatory Gemini, Step 7.1 closed loop
- package.json — added test script

### Decisions Made
- Barrel re-export pattern: shared.mjs kept for backwards compatibility, consumers migrate to lib/ directly
- Fuzzy file discovery only triggers when regex finds <5 files (threshold prevents over-matching)
- Gemini re-verifies its own findings (not GPT) since GPT already missed them
- Codex plugin (openai/codex-plugin-cc) evaluated and rejected — not a fit for plan-aware audit pipeline

### Supabase Cloud Status
- audit_repos: 6 rows, audit_runs: 7 rows, audit_findings: 105 rows, audit_pass_stats: 34 rows, bandit_arms: 15 rows — all flowing
- suppression_events, false_positive_patterns, finding_adjudication_events: 0 rows (expected — need rebuttal/R2+ rounds)

### Next Steps
- Run full audit-loop with rebuttal to populate remaining Supabase tables
- Implement prompt variant A/B testing with bandit selection
- Consider splitting openai-audit.mjs orchestration from LLM call logic

---

## 2026-03-31 — Final Review Fallback to Claude Opus

### Changes
- Implemented provider fallback in scripts/gemini-review.mjs so Step 6.5 now runs Gemini when available, then Claude Opus when Gemini credentials are missing.
- Added Claude Opus invocation path using @anthropic-ai/sdk with shared verdict schema parsing and consistent output metadata.
- Updated ping behavior in scripts/gemini-review.mjs to validate either Gemini or Claude Opus depending on available credentials.
- Updated final-review docs and skill instructions to reflect fallback order instead of skipping when GEMINI_API_KEY is absent.
- Added environment variable documentation for CLAUDE_FINAL_REVIEW_MODEL and clarified ANTHROPIC_API_KEY usage for final-review fallback.

### Files Affected
- scripts/gemini-review.mjs — Added runtime provider selection and Claude Opus fallback execution path.
- .github/skills/audit-loop/SKILL.md — Updated Step 6.5 fallback behavior for Copilot skill flow.
- .claude/skills/audit-loop/SKILL.md — Updated Step 6.5 fallback behavior for Claude Code skill flow.
- .env.example — Documented fallback behavior and CLAUDE_FINAL_REVIEW_MODEL.
- CLAUDE.md — Updated architecture and environment variable table for fallback design.
- README.md — Updated final-review usage label and environment variable table.

### Decisions Made
- Final review provider precedence is Gemini first, Claude Opus second.
- Step 6.5 is only skipped when both GEMINI_API_KEY and ANTHROPIC_API_KEY are absent.
- Output payload now includes provider metadata to make downstream processing explicit.

### Next Steps
- Run an end-to-end final-review dry run in both provider modes to validate response schema stability and timeout behavior.

---

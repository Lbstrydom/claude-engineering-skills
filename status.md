# Project Status Log

## 2026-05-29 — Device-profile emulation for /persona-test + /click-test (+ runner enforcement)

### Changes

**New shared module** ([scripts/lib/device-presets.mjs](scripts/lib/device-presets.mjs))
- Five device presets: `desktop` (default), `desktop-large`, `tablet`, `mobile` (390×844 iPhone 13/14), `mobile-small` (360×640 Pixel-baseline).
- `resolveDevicePreset(description)` — keyword-match resolver. Patterns ordered most-specific-first (`mobile-small` before `mobile`); avoids overbroad cues like "power user" (a power user can be on mobile). Falls back to `desktop` when no cue.
- `parseViewportFlag("WxH")` / `parseDevicesFlag("a,b")` — input helpers for the legacy + matrix flag paths.
- CLI: `list` / `resolve` / `get` / `prep` / `prep-matrix`. The last two are the runner-enforcement contracts (below).

**`/persona-test`** — new Phase 1a "Device Profile Resolution" ([skills/persona-test/SKILL.md](skills/persona-test/SKILL.md))
- Inserts BEFORE Phase 1b (cache-bust). Mandates calling `device-presets.mjs prep "<description>" [--device <override>]` and executing the returned `expectedFirstMcpCall` (a `browser_resize` invocation) verbatim — LLM does not pick dimensions.
- Mental-model tags (`thumb-reach`, `one-handed`, …) injected silently into Phase 2 when `isMobile=true`; never leaked into Phase 5b persona-voice debrief.
- Report (Phase 5) + pair-mode report (Step P5) gain a `Device:` header line. Pair mode resolves each persona's device independently — intentional cross-device coverage.
- New `--device <preset>` flag overrides description-based resolution.

**`/click-test`** — `--device` / `--devices` matrix mode ([skills/click-test/SKILL.md](skills/click-test/SKILL.md))
- Phase 0 gains `--device <preset>` (single pass) and `--devices "<list>"` (matrix mode, multiplicative cost, opt-in only). Mutually exclusive with each other AND with legacy `--viewport WxH`.
- Phase 3 mandates calling `device-presets.mjs prep-matrix` first and walking the returned `passes` array — runner-enforced ordering, no LLM judgement on device sequence.
- Finding schema gains `device: string`. Dedup key becomes `{device, route, via, kind, selector}` — same duplicate-id on mobile + desktop is two regressions (responsive CSS can hide one), reported twice.
- Report adds PER-DEVICE COVERAGE table + CROSS-DEVICE diff (Shared / Desktop-only / Mobile-only). `small-touch-target` desktop findings auto-downgrade when mobile pass also ran (mobile is authoritative).

**Runner enforcement** (`prep` + `prep-matrix` CLI helpers)
- Both skills now MANDATE invoking the prep CLI as their first device-related step. The CLI returns a typed contract (`{kind, version, device, expectedFirstMcpCall, logLine, ...}`) the LLM consumes verbatim. Removes the failure mode where the LLM forgets to resize or picks the wrong dimensions for "mobile-first" personas.
- Mutual-exclusion violations (e.g. `--device` + `--devices`) cause non-zero exit on stderr — skill instructions surface and stop, never proceed silently.

**Tests** ([tests/device-presets.test.mjs](tests/device-presets.test.mjs))
- 48 tests across 8 suites: registry shape, resolver patterns + determinism, getPreset / parseViewportFlag / parseDevicesFlag input helpers, `prepPersonaTest` contract shape + override precedence + mental-model tagging, `prepClickTest` matrix expansion + mutual-exclusion errors.
- Full suite: 3199 tests, 3181 pass, 0 fail (18 pre-existing skips).

**Implementation brief** ([docs/plans/device-profile-emulation.md](docs/plans/device-profile-emulation.md))
- Portable plan document for porting the same patch to other repos (e.g. work codebases that use a different skill-bundle structure). Covers motivation, architecture, acceptance criteria, implementation order (~3-4 hours), back-compat guarantees, trade-offs worth flagging in code review.

### Files Affected
- `scripts/lib/device-presets.mjs` — new shared module + CLI
- `tests/device-presets.test.mjs` — new test suite (48 tests)
- `skills/persona-test/SKILL.md` — Phase 1a inserted; usage + Phase 0b + report headers updated
- `skills/click-test/SKILL.md` — Phase 0 args + Phase 3 device-pass loop + Phase 4 finding shape + Phase 6 report all updated
- `.claude/skills/persona-test/SKILL.md`, `.claude/skills/click-test/SKILL.md` — regenerated mirrors
- `AGENTS.md` — added `device-presets.mjs` to scripts/lib/ tree
- `docs/plans/device-profile-emulation.md` — new portable implementation brief

### Decisions Made
- **No DB schema change.** Device resolution runs from description text at session start (deterministic for stable descriptions). Persistence on the persona row is deferred — revisit only after we see description-drift cause silent device shifts.
- **Viewport-only emulation, not full device emulation.** Playwright MCP exposes `browser_resize`, not context-level launch options. UA / real touch events / DPR-correct rendering require code-driven Playwright — that's what `--mode consistency` already provides. Don't pretend to support what MCP can't deliver.
- **Runner enforcement via prep CLI, not full LLM-to-runner conversion.** The LLM still drives MCP tool calls; the CLI just emits a structured contract the LLM consumes verbatim. Keeps the skill spec readable, removes the variance in device selection.
- **`small-touch-target` desktop downgrade when mobile also ran.** Desktop reading is non-authoritative (no touch); mobile is. Avoids spurious P2s on desktop-pass output of matrix runs.
- **Pre-existing uncommitted changes left untouched** per scope discipline: `dashboard/index.html`, `scripts/setup-postgres.mjs`, `scripts/sync-to-repos.mjs`.

### Next Steps
- Real-world verification: run `/persona-test` against a registered mobile-first persona (e.g. Pieter on wine-cellar-app); confirm the `[device-profile]` log line + `browser_resize(390,844)` MCP call land in that order.
- Real-world verification: run `/click-test https://<own-app> --devices "desktop,mobile"`; confirm CROSS-DEVICE section surfaces mobile-only findings (probably `small-touch-target` ×N).
- If the brief is shared and a work repo ports the patch, capture any resolver-pattern misses they hit (descriptions we should be matching but aren't) and add them to RESOLVER_PATTERNS.

---

## 2026-05-24 — New /click-test skill + /persona-test enhancements (SW cache-bust, --pair mode)

### Changes

**New skill `/click-test`** ([skills/click-test/SKILL.md](skills/click-test/SKILL.md))
- Structural DOM audit complementing /persona-test. Walks every interactive element on each route and asserts 13 semantic-HTML contracts (duplicate IDs, orphan labels, inputs/buttons without accessible names, ARIA misuse, heading skips, missing alt, undersized touch targets, positive tabindex).
- Optional `--with-modals` opens each modal/dropdown trigger and re-scans the live DOM — catches duplicate IDs and orphan labels that only exist while modals are mounted (the class of bugs persona-test can't reach).
- Pre-flight SW cache-bust gated to own-app hostnames (localhost / `*.railway.app` / `*.vercel.app` / `*.netlify.app` / `*.local`); external URLs require explicit `--force-cache-bust` to avoid clearing operator state.
- Run contract captured in report (viewport, ready-selector, cache-bust mode); per-route `coverageStatus` distinguishes `scanned`/`auth-required`/`navigation-error`/`readiness-timeout`/`scanner-error`.
- Verdict precedence (6 buckets) explicitly handles `Broken+Incomplete` and `Has issues+Incomplete` so findings are never masked by coverage gaps.
- 8 concerns deferred to "Out of Scope (v2)" with rationale (state-changing trigger classifier extension, shadow-DOM/iframe traversal, browser-side severity re-derivation, etc.).
- Scanner ([references/dom-scanner.md](skills/click-test/references/dom-scanner.md)) returns canonical `ClickTestScanResult` object with `elementsScanned` / `interactiveElementsScanned` / `shadowGapCount` / `iframeGapCount` metrics. Region-scoped `duplicate-aria-label` rule reduces FP rate on grid/card layouts.

**`/persona-test` enhancements** ([skills/persona-test/SKILL.md](skills/persona-test/SKILL.md))
- **Phase 1b** — mandatory SW cache-bust (with `typeof`-guarded script for non-secure contexts). Wine-cellar-app failure mode is now eliminated for any browser-driven persona session.
- **Phase 7 — Pair mode** (`--pair "<p1>" "<p2>"`). Runs two opposed-expertise personas back-to-back, diffs findings into CONSENSUS / A-ONLY / B-ONLY using Jaccard token overlap on `observed` text. Emits overlap-rate metric (<0.20 = strong disjoint coverage signal).
- Frontmatter usage block updated to advertise pair mode.

**Registry + docs**
- [scripts/lib/install/copilot-prompts.mjs](scripts/lib/install/copilot-prompts.mjs): added `click-test` entry to `SKILL_ENTRY_SCRIPTS` so `.github/prompts/click-test.prompt.md` shim generates.
- [AGENTS.md](AGENTS.md): skill count 6→7, skill chain diagram now shows `/click-test ∥ /persona-test` as parallel live-verification surfaces, persona-test entry gained Pair mode description.

**Audit trail** (extensive — 5 audit rounds total)
- GPT R1 → R2 → R3: HIGH count 7→3→5. Stopped per rigor-pressure rule. Quick fixes for R3-H1/H2/H3 (route default for path-prefix base, `--viewport` flag, coverage gaps gate verdict). R3-H4/H5 deferred to "Out of Scope".
- Gemini R1: 4 concerns (state re-init, metric aggregation, verdict logic hole, redact API ref) — all fixed.
- Gemini R2: 3 concerns (OAuth redirect detection, metric double-counting, caches ReferenceError) — all fixed. Exceeded protocol's 2-round cap by 1 round because findings were concrete bugs, not rigor pressure.

### Files Affected
- [skills/click-test/SKILL.md](skills/click-test/SKILL.md) — new (~360 lines)
- [skills/click-test/references/dom-scanner.md](skills/click-test/references/dom-scanner.md) — new (~250 lines including the `browser_evaluate` scanner JS)
- [skills/persona-test/SKILL.md](skills/persona-test/SKILL.md) — added Phase 1b + Phase 7 (~156 line diff)
- [.claude/skills/click-test/](.claude/skills/click-test/) — generated mirror
- [.claude/skills/persona-test/SKILL.md](.claude/skills/persona-test/SKILL.md) — regenerated mirror
- [.github/prompts/click-test.prompt.md](.github/prompts/click-test.prompt.md) — Copilot shim
- [scripts/lib/install/copilot-prompts.mjs](scripts/lib/install/copilot-prompts.mjs) — registry entry
- [AGENTS.md](AGENTS.md) — skill chain + skill list updates
- [dashboard/index.html](dashboard/index.html) — auto-rebuilt during `npm run sync`

### Decisions Made
- **Persistence to cross-skill store deferred to v2.** `record-click-test` subcommand doesn't exist yet; declaring it as out-of-scope avoids shipping a dead integration path. v1 ships authoritatively from the local Phase 6 report.
- **Naming pair `/click-test` + `/persona-test`** chosen over alternatives (`/click-audit`, `/dom-test`, `/ui-audit`) for parallel `-test` suffix and clear "click vs persona" mnemonic.
- **Exceed Gemini 2-round cap when findings are concrete bugs** — user confirmed this judgment; new feedback memory `[[rigor-cap-genuine-bugs-exception]]` captures the rule.
- **Shadow DOM / iframe traversal deferred to v2** — feasible (recursive descent into `el.shadowRoot`, `iframe.contentDocument`) but not load-bearing for v1. Counts always populated as `shadowGapCount`/`iframeGapCount` so verdict can flag the coverage gap.

### Memories Saved
- `feedback_sw_cache_bust_before_verify.md` — clear SW + caches before suspecting deploy issues
- `feedback_reverify_fix_on_live_env.md` — passing tests ≠ landed fix
- `feedback_click_test_complements_persona_test.md` — structural vs narrative coverage
- `feedback_rigor_cap_genuine_bugs_exception.md` — when to exceed audit-loop round caps

### Deployment
- `npm run skills:regenerate` → 4 writes (mirror created)
- `npm run skills:check` → 13 passed, 0 failed
- `npm run sync` → click-test deployed to ai-organiser + wine-cellar-app (.claude/skills/click-test/ + dom-scanner.md present in both)

---

## 2026-05-23 — Pipeline liveness + canonical-path enforcement (WS-LIVE + WS-CANON)

Implements [docs/plans/liveness-and-canonical-paths.md](docs/plans/liveness-and-canonical-paths.md). Two pre-existing fragilities that had been recurring HIGH findings across multiple audit rounds are now retired:

1. **WS-LIVE — pipeline liveness**. `scripts/symbol-index/refresh.mjs` used `spawnSync` to drive a multi-minute extract → summarise → embed pipeline. While spawnSync blocked, the `runWithHeartbeat` setInterval could not fire — the refresh row's `heartbeat_at` went silent for the entire duration. Replaced with a new `scripts/lib/subprocess.mjs` (`runJsonLinesAsync` + `runJsonLinesAsyncStrict` + closed `SubprocErrorCode` enum). Async streaming restores heartbeat liveness. Stage-tagged errors (`stage=summarise exit=2`) give the operator log a precise failure pinpoint. Hard-fail on malformed JSON lines closes the `.filter(Boolean)` silent-data-loss invariant.

2. **WS-CANON — canonical-path enforcement**. The lexical sensitive-path classifier matched on the visible string `repo/notes.txt` — a symlink whose realpath target pointed into `~/.ssh/id_rsa` or `secrets/db.yaml` was not classified as sensitive. New `scripts/lib/sensitive-paths.mjs::resolveAndClassify` runs the cheap lexical check first, then `fs.realpathSync` + re-classify of the canonical target. Fail-closed on resolution errors (`resolutionFailed: true → category: 'sensitive'`) and on escapes outside `repoRoot` (`escapedRepo: true → 'sensitive'`). `gateSymbolForEgress` opts in via `repoRoot`; `extract.mjs` hoists per-file resolution + reads via the canonical path (so ts-morph sees the gate-approved file, not the unresolved one). `redactSecrets` rewritten to delegate to `redact.mjs::redactObject` — fail-closed; BigInt and circular refs can no longer leak.

### Files added
- [scripts/lib/subprocess.mjs](scripts/lib/subprocess.mjs) — async streaming subprocess runner. Two helpers (`runJsonLinesAsync`/`runJsonLinesAsyncStrict`), closed 4-code `SUBPROC_ERROR_CODES` enum. EPIPE-safe (Gemini-r1 G1). 18 tests including heartbeat-liveness property test.
- [tests/subprocess.test.mjs](tests/subprocess.test.mjs) — full async + strict-wrapper coverage.
- [tests/sensitive-paths-canonical.test.mjs](tests/sensitive-paths-canonical.test.mjs) — 18 hermetic POSIX tests for `resolveAndClassify` (symlink-bypass, escape detection, canonical re-classification, fail-closed).

### Files modified
- [scripts/symbol-index/refresh.mjs](scripts/symbol-index/refresh.mjs) — three call sites migrated from `spawnSync` → `runJsonLinesAsyncStrict({stage})`. Catch block recognises `SubprocErrorCode`s and surfaces `{stage, exitCode, signal, parseErrorCount}` in the structured error output.
- [scripts/lib/sensitive-paths.mjs](scripts/lib/sensitive-paths.mjs) — added `resolveAndClassify` + top-of-file `fs` import.
- [scripts/lib/sensitive-egress-gate.mjs](scripts/lib/sensitive-egress-gate.mjs) — `gateSymbolForEgress` accepts `repoRoot`; new `skip-symlink-escape` action; `generatedNoise` branch added in repoRoot path (Gemini-r2 G2 regression-fix). `redactSecrets` rewritten fail-closed via `redactObject`.
- [scripts/lib/redact.mjs](scripts/lib/redact.mjs) — `redactObject` now walks KEYS as well as values (Gemini-r2 G1; closes a leak path WS-CANON introduced when we delegated object-payload redaction here).
- [scripts/symbol-index/extract.mjs](scripts/symbol-index/extract.mjs) — hoisted `resolveAndClassify` to per-file (BEFORE `addSourceFileAtPathIfExists`). Reads via `cls.canonical`. Inner candidate loop simplified to `containsSecrets` only — path enforcement done once per file (Gemini-r1 G2).
- [tests/redact.test.mjs](tests/redact.test.mjs) — 2 new tests for key redaction.
- [tests/sensitive-egress.test.mjs](tests/sensitive-egress.test.mjs) — extended with `redactSecrets` fail-closed contract (circular + BigInt), `gateSymbolForEgress` WS-CANON behaviours, generated-noise blocking.
- [docs/security-strategy.md](docs/security-strategy.md) — NEW `INC-001`: symlink-bypass of sensitive-path classifier. Mitigation form `manual` (regression-locked by the new test file). Lessons learned recorded.
- [AGENTS.md](AGENTS.md) — "Sensitive paths + VCS contract" extended with the WS-CANON canonical-path layer + fail-closed redactor; VCS section updated to point at the new `scripts/lib/subprocess.mjs` for WS-LIVE.

### Decisions
- **WS-LIVE ships first.** Larger blast radius (touches refresh.mjs main pipeline); landing it first means WS-CANON's `extract.mjs` change rebases over a stable async pipeline rather than a sync one. Per plan §3.
- **AbortSignal/timeout deferred.** Plan §5 "What we WON'T do" explicitly defers cross-process cancellation tokens. Heartbeat is one-way; cancellation is already checked between stages. Future work if a hanging-child scenario actually surfaces.
- **Hard-fail on parse errors by default.** Behaviour change (the old `.filter(Boolean)` silently dropped malformed lines). No callers tolerated this today; escape hatch is `opts.maxParseErrors: Infinity` for the rare legacy-tolerance need.
- **`extract.mjs` reads via canonical path** — even though ts-morph already loads the body into memory, feeding it `cls.canonical` rather than `abs` means we read exactly what the gate approved. Closes the TOCTOU window between gate-check and file-read.
- **`redactObject` walks keys too** (Gemini-r2 G1). WS-CANON delegated object-payload redaction from a stringify-then-text-redact path to `redactObject`. The old path caught key-secrets incidentally; the new walker didn't, until this fix.
- **REBUTTED 3 Gemini findings** as factually wrong: containment-check claim (code uses `path.relative` + `path.isAbsolute`, exactly what Gemini recommended), `MAX_FILE_BYTES` undefined (declared at line 378, accessible inside the function), parseArgs robustness (pre-existing, plan §5 defers).

### Verification
- Audit cycle: GPT R1 + Gemini ×3 rounds. HIGH count trajectory (real, not hallucinations): r1=2 → r2=2 → r3=0. Architectural coherence assessment rose from "Adequate" (r2) to "Strong" (r3). Stopped per audit-plan skill's rigor-pressure rule.
- Full suite: **3116/3134 passing, 0 failures, 18 skipped** (was 3068/3086 baseline; +48 net tests from this plan).
- Empirical smoke: extract.mjs runs against 906 files, emits real symbols (proves `MAX_FILE_BYTES` access is fine — Gemini-r3 G1 was a hallucination).

### Out of scope (deferred)
- Subprocess records-buffering memory pressure on very large repos.
- `refresh.mjs` god-orchestrator decomposition (pre-existing).
- `refresh.mjs::parseArgs` unknown-flag / missing-value strictness (pre-existing).

---

## 2026-05-23 — Shared cloud-config for consumer repos (~/.audit-loop.env)

Implements [docs/plans/shared-cloud-config.md](docs/plans/shared-cloud-config.md). Eliminates the silent-failure pattern that hit ai-organiser this week: `[learning] Cloud store not configured` printed once at startup, then arch-memory consultation, audit-loop cloud learning, and persona-test correlations all silently no-op'd because the consumer repo's `.env` didn't have `AUDIT_DB_URL`. Three trigger surfaces ensure the operator never misses it: explicit `npm run setup:cloud`, end-of-`npm run sync` auto-prompt, and the cloud-disabled fallback message now names the recovery command. Pattern locked in `[[first-deploy-plus-update-from-source-pattern]]` memory.

### Files added
- [scripts/lib/shared-cloud-config.mjs](scripts/lib/shared-cloud-config.mjs) — pure lib (558 LOC). Exports `SHARED_VARS` / `REQUIRED_VARS` / `OUTCOMES` / `EXIT_CODE_FOR` / `sharedEnvPath` / `discoverLocalEnvPath` / `parseEnvText` / `parseEnvFile` / `serializeEnvValue` / `diffSharedEnv` / `writeSharedEnv` / `resolveCloudConfig` / `resolveSourceRepo` / `assessSharedCloudConfig` / `runSetupCloud` / `formatDeltaPreview` / `_internals`. Tagged-union `resolveSourceRepo` returns `{type: 'resolved'|'invalid-override'|'ambiguous'|'none', ...}`. Lossless mixed-quote serializer with safety guards (newline / `#` / leading-quote / surrounding WS blockers).
- [scripts/setup-cloud.mjs](scripts/setup-cloud.mjs) — thin argv→executor CLI (116 LOC). Strict allowlist prompt (`'' | y | yes`). Short-flag rejection in `--source-repo`/`--format` value parsing. TTY check forces `--yes` when stdin is not a TTY.
- [tests/shared-cloud-config.test.mjs](tests/shared-cloud-config.test.mjs) — 39 tests (1 skipped on Windows). Covers all 6 assess outcomes + executor branches + tagged-union resolveSourceRepo + serializer edge cases including mixed-quote bare round-trip + bare-form-blocker throws + explicit-empty-string process.env override.
- [tests/sync-shared-env-trigger.test.mjs](tests/sync-shared-env-trigger.test.mjs) — 12 tests via `_internals` import (R1-audit M16 — real behaviour, not regex-asserting source text). ALREADY_CURRENT silent path + MISCONFIGURED one-line advisory + structural import-form contract (matches BOTH static `import ... from` AND dynamic `import(...)` so a future refactor can't silently bypass the lib-only rule).
- [tests/config-shared-env.test.mjs](tests/config-shared-env.test.mjs) — 7 subprocess-driven tests for the config.mjs autoload. cwd `.env` wins over shared; shared fills unset vars; loader silent when shared file absent; one-time stderr note when shared loads; sentinel suppression for subprocess inheritance (R1-audit M17).
- [tests/fixtures/config-shared-env-child.mjs](tests/fixtures/config-shared-env-child.mjs) — committed test fixture (R1-audit M19).
- [docs/plans/shared-cloud-config.md](docs/plans/shared-cloud-config.md) — plan (Status: Complete).

### Files modified
- [scripts/lib/config.mjs](scripts/lib/config.mjs) — autoloads `~/.audit-loop.env` as a fallback layer (`override: false`) after the local `.env` walk-up; sets `_AUDIT_LOOP_SHARED_LOADED=1` sentinel in `process.env` so spawned subprocesses don't re-log the "loaded shared cloud config" notice. Refactored `discoverDotenv` to share `discoverLocalEnvPath` from the new lib (DRY).
- [scripts/lib/file-io.mjs](scripts/lib/file-io.mjs) — `atomicWriteFileSync({mode})` parameter forwarded to `fs.writeFileSync` for secure-mode-at-create (chmod 0600 on POSIX). Symlink-preservation: `lstat` + `realpath` before rename so dotfile managers (GNU Stow, chezmoi) that symlink `~/.audit-loop.env → ~/dotfiles/...` keep their setup intact.
- [scripts/sync-to-repos.mjs](scripts/sync-to-repos.mjs) — end-of-`main()` D2b trigger; both `stdin.isTTY` AND `stdout.isTTY` required (CI-hang fix). `--no-prompt` flag added. `_internals` export for direct test access.
- [scripts/install-prepush-hook.mjs](scripts/install-prepush-hook.mjs) — bash sibling-scan aligned with JS resolveSourceRepo: single `sync-to-repos.mjs` sentinel (the old dual-file check false-matched consumer repos that had both files synced).
- [scripts/check-setup.mjs](scripts/check-setup.mjs) — uses `resolveCloudConfig` for effective-config evaluation; reports source attribution (`inherited from ~/.audit-loop.env` / `set via shell export` / unset).
- [scripts/lib/store/repo.mjs](scripts/lib/store/repo.mjs) — cloud-disabled message now names `npm run setup:cloud` as the recovery command.
- [scripts/openai-audit.mjs](scripts/openai-audit.mjs) — drive-by fix for `mode is not defined` ReferenceError in cache log (1-character; `runMultiPassCodeAudit` is code-mode only).
- [tests/shared.test.mjs](tests/shared.test.mjs) — POSIX-only regression test for `atomicWriteFileSync` symlink preservation.
- [scripts/.cli-catalog.json](scripts/.cli-catalog.json) + [package.json](package.json) — `setup:cloud` entry.
- [AGENTS.md](AGENTS.md) — new "Shared cloud config for consumer repos" subsection: loader precedence, setup recipe, update-from-source path, opt-out, public-repo safety note.

### Decisions
- **Pure lib + thin CLI + sync trigger**, not a monolithic CLI. The plan considered three call sites (setup-cloud CLI, sync end-of-run, check-setup diagnostic) and chose to put all logic in a pure lib so each surface is a thin adapter that imports the same `runSetupCloud` executor. Sync trigger calls the lib directly — NEVER imports from `scripts/setup-cloud.mjs` (R3-audit M2; enforced by structural test).
- **Tagged-union return for `resolveSourceRepo`** (R2-audit M2/M8). Always returns `{type: 'resolved'|'invalid-override'|'ambiguous'|'none', ...}` instead of `null|object` polymorphism. Explicit `--source-repo <bad-path>` returns `invalid-override` so we surface the operator's mistake instead of silently falling through to cwd/sibling auto-discovery (R2-audit H3).
- **Throw fail-fast → bare-form lossless** (Gemini-r3 M7). Initial R2-audit decision was to throw on values containing both `'` and `"`. Gemini's deliberation correctly identified that dotenv reads unquoted/bare values verbatim until newline, providing a lossless escape hatch. Implementation now attempts bare emission first; throws only when the value has a bare-form blocker (newline / `#` / leading-quote / surrounding whitespace). Regression tests cover both the round-trip and the throw cases.
- **Symlink preservation via `lstat` + `realpath`** (Gemini-r3-r2 G1). Power users manage `~/.audit-loop.env` through dotfile managers (GNU Stow, chezmoi). Without symlink-following, `fs.renameSync` would destroy the symlink and replace it with a regular file, detaching the operator's config from their dotfiles repo.
- **`stdin.isTTY` + `stdout.isTTY` both required** (Gemini-r3 G2). Stdout-only TTY check was vulnerable to CI environments where stdout is a pseudo-TTY but stdin is closed/piped — readline would hang forever.
- **Out-of-scope deferred**: `audit_repos` schema qualification (H1) and `upsertRepoByUuid` race condition (H2) in `scripts/lib/store/repo.mjs` are real concerns but predate this PR. Atomic-upsert refactor with proper unique constraints warrants its own PR.

### Verification
- Full test suite: **3052/3070 passing, 0 failures, 18 skipped**.
- Audit history: GPT R1 (H:7 M:10 L:5) → R2 (H:4 M:10 L:3) → R3 (in-scope HIGH: 0). **Gemini ×5 rounds** — final verdict **APPROVE** with `claude_bias_detected: false`, `architectural_coherence: Strong`. Quality summary: *"Claude demonstrated excellent architectural judgment, correctly distinguishing between pre-existing out-of-scope debt and new logic flaws. Claude successfully rebutted the symlink issue (G1) with precise codebase evidence showing it was already resolved, while rightly accepting and fixing the empty-string diagnostic drift (G2)."*
- `npm run setup:cloud --dry-run` syntax-checks clean.

---

## 2026-05-23 — Migration-drift detector + ledger bootstrap path

Implements [docs/plans/migration-drift-detector.md](docs/plans/migration-drift-detector.md) (planId `a33b71f3`). Closes the silent-drift gap that bit us on 2026-05-22 — three migrations (`20260519`, `20260520`, `20260521`) had been committed to `supabase/migrations/` but never applied to the cloud, causing `/plan` upsert + `/persona-test --mode consistency` + WS-PIPE1 `persona_test_candidates` CLI to all silently no-op.

### Files added
- [scripts/setup-postgres.mjs](scripts/setup-postgres.mjs) `runCheckDrift` + `renderHumanDriftReport` — read-only drift detection with closed 4-code exit contract (0 clean/cloud-disabled, 1 drift, 2 hard-error, 3 needs-bootstrap). Three drift kinds surfaced separately (unapplied / sha-mismatch / orphan-ledger). DI signature `{format, migrationsDir, stdout, stderr}` so tests run hermetically against a `mkdtemp` directory + in-memory stub pool. NEVER calls `ensureLedger` — the read-only contract is load-bearing.
- [.github/workflows/migration-drift.yml](.github/workflows/migration-drift.yml) — weekly cron (Mondays 09:45 UTC, 15-min stagger from architectural-drift) + push-on-`supabase/migrations/**` event-driven trigger + `workflow_dispatch`. Sticky GitHub issue with label `migration-drift`; auto-closes on green. Exit-2/3 fail the workflow loudly without polluting the issue tracker.
- [tests/setup-postgres-check-drift.test.mjs](tests/setup-postgres-check-drift.test.mjs) — 25 hermetic tests: 3 drift-kinds × format combos + needs-bootstrap (exit 3) + output channel discipline (JSON-only on stdout / human-only on stderr) + parseArgs flag wiring + source-inspection (indexed-loop refactor, listMigrations DI, runCheckDrift no `ensureLedger`, main() branch ordering, package.json scripts, workflow file shape, AGENTS.md snippet shape).
- [tests/hook-snippet-behaviour.test.mjs](tests/hook-snippet-behaviour.test.mjs) — 5 bash-driven tests extracting the operator-paste snippet from AGENTS.md and running it under `bash -e` with a mocked `node` shim returning each of {0,1,2,3}. Asserts the parent shell ALWAYS reaches the post-snippet sentinel — proves "advisory, never blocks" holds even under `set -e`.

### Files modified
- [scripts/setup-postgres.mjs](scripts/setup-postgres.mjs) — `parseArgs` refactored from `for (const a of argv)` to indexed `for (let i = 0; i < argv.length; i++)` so flag-with-value (`--format json`) can advance the iterator (Gemini-R2-H1 audit finding). `listMigrations(dir = MIGRATIONS_DIR)` accepts DI for tests. `main()` dispatch adds the `--check-drift` branch that handles cloud-disabled (pool null) → exit 0 BEFORE the generic null-pool guard, and skips preflight for read-only check-drift (faster pre-push). `_internals` extended with `runCheckDrift` + `renderHumanDriftReport` exports.
- [package.json](package.json) — `db:check-drift`, `db:check-drift:json`, `db:migrate`, `db:adopt` scripts. `check:integration` extended to chain `--check-drift` after `arch:refresh:full`.
- [scripts/.cli-catalog.json](scripts/.cli-catalog.json) — five catalog entries (four new + updated `check:integration` description).
- [AGENTS.md](AGENTS.md) — new "Migration-drift detection" subsection under Postgres-Parity Store: detect commands, exit-code table, one-time bootstrap recipe, operator pre-push snippet (with `# managed-by: migration-drift-detector` marker), and break-glass recipe with cross-platform `node -e` sha256 derivation (replaces `sha256sum` which isn't on macOS — Gemini-R2-L1).

### Decisions
- **Single-PR workstream** rather than per-step commits. The plan §3 chain is tight enough that splitting added churn without independence — the check mode is useless without the dispatch wiring; the npm scripts are useless without the mode; the AGENTS.md runbook is useless without the npm scripts. WS1/WS2/WS3 precedent of one bundled commit per plan.
- **`--check-drift` skips preflight** — preflight checks CREATEROLE + 3 extension installs (4 queries). The read-only check doesn't need any of that. Skipping keeps pre-push hook fast (the load-bearing use case).
- **Cloud-disabled → exit 0**, not exit 2. Matches the `cloud:false` graceful-no-op pattern used across the audit-loop store (arch:refresh, persona-test). Lets `check:integration` chain `arch:refresh:full && --check-drift` cleanly when AUDIT_DB_URL is unset — both halves skip-gracefully rather than the second half hard-failing on the pool guard.
- **Operator-paste pre-push snippet, NOT installer edit** (Gemini-R1 caught this). `scripts/install-prepush-hook.mjs` is the CONSUMER-repo installer (auto-runs `/audit-code`, uses `$AUDIT_LOOP_DIR`); editing it for the SOURCE-repo drift check was a category error. The snippet lives in AGENTS.md with a `managed-by:` marker comment that the test extracts.
- **Hook-snippet test is bash-driven** — for the load-bearing "never blocks under `set -e`" contract there's no substitute for actually running the snippet through bash. The test mocks `node` via a PATH-prepend so it never touches the real DB.
- **JSON output discipline**: `format=json` writes ONLY to stdout; `format=human` writes ONLY to stderr. This is the contract CI consumers depend on (`node ... --format json > file.json`). Tests assert both directions explicitly.

### Verification
- Full test suite: **2994/3011 passing, 0 failures** (was 2964; +30 net tests).
- `node scripts/setup-postgres.mjs --check-drift` syntax-checks clean and `_internals` export is callable.
- Workflow YAML lint clean.

### Pending — operator action (out-of-band)
Step 6 of plan §3 — Louis to run the one-time bootstrap to clear today's drift:

```bash
# Step 1: manually apply the 3 unapplied migrations via Supabase dashboard SQL editor:
#   supabase/migrations/20260519120000_plans_skill_unified.sql
#   supabase/migrations/20260520120000_consistency_source_kinds.sql
#   supabase/migrations/20260521120000_persona_test_candidates.sql
# Step 2: bootstrap the ledger via strict full-schema adopt
AUDIT_DB_URL=… node scripts/setup-postgres.mjs --adopt
# Step 3: confirm clean
AUDIT_DB_URL=… node scripts/setup-postgres.mjs --check-drift
```

Until step 6 lands, `--check-drift` will exit 3 with the bootstrap message (correct behaviour — surfaces today's reality). Going forward, every new migration goes through `npm run db:migrate` (idempotent, ledger-tracking) and the weekly CI catches anything that slips.

## 2026-05-22 — Sustainability cleanup WS3: refresh.mjs hardening + canonical sensitive-paths + structured VCS contract

Final workstream of the sustainability-cleanup-batch plan. `scripts/symbol-index/refresh.mjs` had ad-hoc subprocess error handling (try/catch-return-null), an inline `gitDiffWithWorkingTree` helper, and used five overlapping sensitive-path lists across consumer modules. WS3 collapses all three into two canonical modules with full structured contracts.

### Files added
- [scripts/lib/vcs.mjs](scripts/lib/vcs.mjs) — closed `VcsErrorCode` enum (5 codes), structured `gitCommitSha`/`gitDiffWithWorkingTree` returning `{ok, …} | {ok:false, error:{code,message,cause?}}`, `exitCodeFor()` mapper (127/5/4/5/1), `RETRYABLE_VCS_ERRORS` Set + `isRetryableVcsError(code)` accessor, relocated `isSafeGitRevision`.
- [scripts/lib/sensitive-paths.mjs](scripts/lib/sensitive-paths.mjs) — canonical two-category classifier (`sensitive` / `generatedNoise` / null) + state-aware `filterDiffFiles` covering all 12 cases incl. tombstone preservation + `shouldSkipForIndexing` predicate + `formatSkipLog` with the redaction policy (default aggregates sensitive into a single count line; `SENSITIVE_PATHS_DEBUG=1` emits `[redacted:<sha256-hex8>].<ext>` — never basenames).
- [tests/vcs.test.mjs](tests/vcs.test.mjs) — 21 tests covering all 5 ErrorCode values, DiffShape contract incl. rename pairs, `exitCodeFor` mapping, `isRetryableVcsError`, regex contract for `isSafeGitRevision`.
- [tests/sensitive-paths.test.mjs](tests/sensitive-paths.test.mjs) — 102 tests covering per-pattern positive + negative fixtures, classifyPath three-way return, 12-case state-aware matrix incl. tombstone preservation + rename rewriting, idempotency property, formatSkipLog default/debug/mixed modes, superset gate against an inlined legacy-pattern snapshot.
- [tests/refresh-cli-contract.test.mjs](tests/refresh-cli-contract.test.mjs) — 9 hermetic tests using `mkdtemp` + `git init`. Real-fixture integration through the full `vcs.gitDiffWithWorkingTree → filterDiffFiles → formatSkipLog` pipeline, rename-to-sensitive rewriting (tombstone preserved), full-vs-incremental skip parity, source-inspection of refresh.mjs wiring.

### Files modified
- [scripts/symbol-index/refresh.mjs](scripts/symbol-index/refresh.mjs) — 111-line diff. Inline VCS helpers deleted. `vcs.gitCommitSha` destructured via `{ok, sha}`. `vcs.gitDiffWithWorkingTree` failures route via `throwVcsError()` → outer `main()` catch → `abortRefreshRun` → `process.exit(vcs.exitCodeFor(err.vcsCode))` so the refresh_run is ALWAYS aborted before exit (R1-audit H10 fix). Incremental path runs `filterDiffFiles(['sensitive', 'generatedNoise'])` before extract; skip log via `formatSkipLog`.
- [scripts/symbol-index/extract.mjs](scripts/symbol-index/extract.mjs) — `isPathSensitive` → `shouldSkipForIndexing(rel, ['sensitive', 'generatedNoise'])`. Filters both categories so full-mode parity is achieved at the extract-time discovery. Aggregated skip log emitted ONCE at end via `formatSkipLog(logger: 'extract')`, not per file.
- [scripts/lib/quickfix-patterns.mjs](scripts/lib/quickfix-patterns.mjs) — inline `SENSITIVE_PATH_PATTERNS` removed; `isSensitivePath` thin-delegates to `classifyPath(p) === 'sensitive'`; `normalisePath` re-exports the canonical.
- [scripts/lib/audit-scope.mjs](scripts/lib/audit-scope.mjs) — inline 12-regex `SENSITIVE_PATTERNS` array removed; `isSensitiveFile` delegates to canonical. Lost the loose `secret-keys/`-substring catch (intentional precision/recall trade — documented in test comment + canonical module header).
- [scripts/lib/sensitive-egress-gate.mjs](scripts/lib/sensitive-egress-gate.mjs) — `DEFAULT_PATH_DENYLIST` + `micromatch` dependency dropped. `isPathSensitive` becomes `classifyPath(p) !== null` (blocks BOTH categories from LLM egress — preserves legacy lockfile-block behaviour per Gemini-r3-G2).
- [AGENTS.md](AGENTS.md) — new "Sensitive paths + VCS contract" subsection documents the canonical locations + closed `VcsErrorCode` enum. Architecture directory map updated with the two new files.
- [package.json](package.json) — `check:integration` opt-in script (end-to-end `arch:refresh --full` against the active repo + Postgres; NOT part of `npm test`).
- [scripts/.cli-catalog.json](scripts/.cli-catalog.json) — catalog entry for `check:integration`.
- [tests/file-io.test.mjs](tests/file-io.test.mjs) — dropped `app/secret-keys/main.yaml` over-aggressive fixture, with a comment explaining the intentional precision trade.
- [tests/quickfix-patterns.test.mjs](tests/quickfix-patterns.test.mjs) — dropped now-unexported `SENSITIVE_PATH_PATTERNS` import; added `myenv.env` + `production.env` as superset-positive cases.
- [tests/arch-memory-followups.test.mjs](tests/arch-memory-followups.test.mjs) — `isSafeGitRevision` source-inspection now reads `scripts/lib/vcs.mjs`.
- [docs/plans/sustainability-cleanup-batch.md](docs/plans/sustainability-cleanup-batch.md) — Status → Complete; full Implementation Log entry with WS3 deliveries + arch:refresh caller inventory + deviations.

### Decisions
- **Three sub-commits folded into ONE commit** (matches WS1 efca5ea + WS2 13a0af9 commit shapes). Tests verified green at each logical step during implementation; final suite is 2964/2981 (was 2825/2842 — +139 net tests, 0 failures).
- **Full-mode discovery stayed in extract.mjs** (its existing fs walk) rather than moving into refresh.mjs via a parallel `git ls-files` enumeration. Extract's filter now handles BOTH categories so the **net behaviour** (parity of skip set across `--full` and incremental) matches the plan's intent without a parallel discovery path.
- **`exitOnVcsError` → `throwVcsError`** (audit fix-up H10) — direct `process.exit()` inside the heartbeat block was bypassing the outer `abortRefreshRun` cleanup. Now propagates via a tagged `Error` (`err.code='VCS_FAILURE'`, `err.vcsCode`) so the catch block can abort the run before mapping to the exit code.
- **`Object.freeze(new Set(...))` is misleading** (audit fix-up M6) — V8 doesn't actually freeze Set mutation. Replaced the freeze with a documented comment + a read-only `isRetryableVcsError(code)` accessor. The Set is still exported for inspection but the canonical predicate is the function.
- **Coverage trade-offs documented in module header** (audit fix-up M8) — the WS3 migration intentionally tightened lexical recall for higher precision. `app/secret-keys/main.yaml` no longer matches; `src/secret-helper.ts` no longer false-positives. The header lists every intentional precision/recall change + reminds operators that renaming to `secrets/` reclaims coverage.

### Verification
- Full test suite: **2964/2981 passing, 0 failures** (17 skipped — pre-existing).
- `/audit-code` round 1: GPT verdict SIGNIFICANT_ISSUES, H:17 M:17 L:2. 3 findings in-scope and fixed (H10, M6, M8). 31 deferred as pre-existing/out-of-scope (egress-gate redaction symlink design, runJsonLines blocking heartbeat, WS2 dashboard concerns, etc.).
- `/audit-code` Step 7 Gemini final review: **APPROVE** in 149s. 1 LOW advisory on dashboard helpers `NON_OK` Set immutability (WS2 territory — out of scope, deferred).
- Plan §2 #7 arch:refresh blast-radius inventory completed: no caller relies on exit-0-on-failure. `architectural-drift.yml` already uses `|| true`. The new exit codes (4/5/127/1) are safe in every documented caller.

### Pending
- WS1, WS2, WS3 all complete. Plan status: **Complete**.

## 2026-05-22 — Sustainability cleanup WS2: dashboard renderer decomp

Second workstream of the sustainability-cleanup-batch plan. `scripts/lib/dashboard/render.mjs` was a 607-line monolith with 8 inline section renderers + shared helpers; split into a slim orchestrator (~150 lines) + 8 per-section modules + a single `helpers.mjs` that owns the markup primitives.

### Files added
- [scripts/lib/dashboard/helpers.mjs](scripts/lib/dashboard/helpers.mjs) — the **only** module that defines `escapeHtml`, `jsonScriptSafe`, `statusDot`, `tab`, `panel`, `warningPanel`, `emptyPanel`, `splitUsage`, plus `NON_OK` and the `buildUi()` factory that constructs the frozen helper bundle the orchestrator passes to each section.
- 8 section modules under [scripts/lib/dashboard/sections/](scripts/lib/dashboard/sections/) — `skills.mjs`, `cli.mjs`, `flows.mjs`, `architecture.mjs`, `plans.mjs`, `audit-runs.mjs`, `requirements.mjs`, `learning.mjs`. Each exports `default(viewModel, ui) → string` with a locked signature. Co-located constants stay with the section that owns them (`CLI_CATEGORY_ORDER`/`CLI_CATEGORY_TITLES` in `cli.mjs`; `ARCH_TIER_LABELS`/`archTiers`/`formatDepsSourceLine` in `architecture.mjs`; `planList` in `plans.mjs`; `REQ_STATUS_ORDER` in `requirements.mjs`).
- [tests/dashboard-section-contract.test.mjs](tests/dashboard-section-contract.test.mjs) — 22 new tests in four groups: (1) one-way import direction (sections must NOT import `render.mjs` or `helpers.mjs` directly — they receive `ui` via the orchestrator); (2) shape contract (every section exports `default` with arity 2); (3) `ui` bundle drift detection (exact key set); (4) `render.mjs` re-exports the backward-compat surface (`escapeHtml`, `jsonScriptSafe`, `renderDocument`) and imports every section.

### Files modified
- [scripts/lib/dashboard/render.mjs](scripts/lib/dashboard/render.mjs) — was 607 LOC, now ~165 LOC. Keeps `freshnessBanner`, `nav`, `renderDocument`. Re-exports `escapeHtml` + `jsonScriptSafe` from `helpers.mjs` for backward compat (existing test imports unchanged). Adds `SLICERS` map — each section receives a narrow viewModel slice (`{src, payload}`) rather than the whole `data` object, limits coupling per plan §2 #4.

### Decisions

- **Slicers in orchestrator, not in sections** — keeps the whole "what does this section need from data" decision in one file. Sections stay narrow: `(viewModel, ui)` in, HTML string out.
- **`buildUi()` factory pattern** — `helpers.mjs` exports a builder, not a literal `ui` object. Lets tests construct their own bundle if needed, and ensures the orchestrator gets a frozen instance per `renderDocument` call.
- **U+2028 / U+2029 escape via `\u`-notation in regex source** — these are JS line terminators; writing them as literal characters inside regex literals breaks the parser. Used `/ /g` form instead. Caught when first attempt failed module load.

### Verification

- Full test suite: **2825/2842 passing, 0 failures** (22 new + existing — deterministic-render contract held byte-identical).
- `npm run dashboard:build`: produces `dashboard/index.html` + `dashboard/telemetry.html` with `degraded: false`. Architecture-tab subtitle still reads "56 edges: 11 observed · 14 manual-only · 31 confirmed-by-both · refresh f5efcbe5" (the data path unchanged after WS2).

### Plan reference

[docs/plans/sustainability-cleanup-batch.md](docs/plans/sustainability-cleanup-batch.md) — WS1 + WS2 complete. WS3 (refresh.mjs hardening) remaining.

---

## 2026-05-22 — Sustainability cleanup WS1: arch-memory god-module split

First workstream of the sustainability-cleanup-batch plan. `scripts/lib/store/arch-memory.mjs` was an 838-line "largest M3 domain" file mixing 6 cohesive concerns; split into focused sub-modules under `scripts/lib/store/arch/` with the original path kept as a **thin barrel** so the `learning-store.mjs` frozen-export contract (107 names) holds unchanged.

### Files added
- [scripts/lib/store/arch/_shared.mjs](scripts/lib/store/arch/_shared.mjs) — 23 lines, narrowly scoped: `UPSERT_CHUNK_SIZE`, `IN_CHUNK`, `chunk()`. **No re-exports of generic db primitives** (R2-M3 — prevents the child file from becoming a new god-tier one layer deeper).
- [scripts/lib/store/arch/refresh-runs.mjs](scripts/lib/store/arch/refresh-runs.mjs) — 10 fns + file-private `GET_REFRESH_RUN_COLUMNS` (Gemini-r2-G1).
- [scripts/lib/store/arch/snapshots.mjs](scripts/lib/store/arch/snapshots.mjs) — 3 fns (active snapshot + embedding-model config).
- [scripts/lib/store/arch/symbols.mjs](scripts/lib/store/arch/symbols.mjs) — 7 fns + inline `vectorLiteral()` formatter for pgvector. **pgvector serialisation fix rolled into the split**: previous code passed JS `number[]` to `upsert()` which serialised as Postgres text-array `{"0.1",...}` → SQLSTATE 22P02 (`invalid input syntax for type vector`). Replaced with raw SQL using `[…]::vector` literal cast. Bug was pre-existing + flaky-reproducing; the split was the natural opportunity to land the fix.
- [scripts/lib/store/arch/imports.mjs](scripts/lib/store/arch/imports.mjs) — 6 fns (file-import graph + populated flag).
- [scripts/lib/store/arch/domain-summaries.mjs](scripts/lib/store/arch/domain-summaries.mjs) — 2 fns (per-domain Haiku cache).
- [scripts/lib/store/arch/neighbourhood.mjs](scripts/lib/store/arch/neighbourhood.mjs) — 3 fns (drift / duplicates / neighbourhood RPC adapters).
- [tests/arch-memory-split.test.mjs](tests/arch-memory-split.test.mjs) — 35 new tests in three groups: (1) explicit 31-name `EXPECTED_EXPORTS` manifest validates barrel resolution + `GET_REFRESH_RUN_COLUMNS` privacy + `learning-store.mjs` re-export coverage; (2) cloud-disabled neutral-value matrix per public fn (uses `before/after` hooks to unset `AUDIT_DB_URL` + drain pool, restore after); (3) cross-module separation (no sub-module imports a sibling).

### Files modified
- [scripts/lib/store/arch-memory.mjs](scripts/lib/store/arch-memory.mjs) — was 838 lines, now **31 lines**: pure `export *` × 6 sub-modules + a header comment with the export-ownership matrix. Path preserved so `learning-store.mjs` and the 18+ downstream callers behind it import everything unchanged.
- [tests/arch-memory-followups.test.mjs](tests/arch-memory-followups.test.mjs) — JSDoc-presence test now reads `arch/refresh-runs.mjs` (was checking `arch-memory.mjs`) since the `GLOBAL BY DESIGN` note travelled with `listPrunableRefreshRuns`.

### Decisions

- **Sub-modules under `arch/`, not at `store/` top-level** — leaves room for non-arch store concerns (`bandit-fp.mjs`, `repo.mjs`, etc.) to remain top-level peers. The `arch/` bundle is conceptually one super-domain.
- **`_shared.mjs` deliberately tiny (23 lines)** — would not pass Gemini-R2-M3 (refactor recreates god-module) if it re-exported db primitives. Each sub-module imports `many`/`one`/`upsert`/etc. directly from `../../db/query.mjs`.
- **pgvector fix landed inside WS1** — strictly speaking WS1 was meant to be behaviour-preserving, but the pre-split code was already broken under realistic conditions (just flaky). Fixing during the split was the smallest commit that ships both the refactor AND a working `arch:refresh`.

### Verification

- Full test suite: **2803/2820 passing, 0 failures** (35 new + existing — frozen-export count 107 intact).
- End-to-end `npm run arch:refresh`: succeeded against the live audit-loop Postgres (64 symbols embedded, 518 file-import edges, 1645 forward-copied untouched symbols, new snapshot `f5efcbe5…` published as active).

### Next steps

WS2 (renderer decomp) starts next session; WS3 (refresh.mjs hardening) after that. Plan: [docs/plans/sustainability-cleanup-batch.md](docs/plans/sustainability-cleanup-batch.md).

---

## 2026-05-22 — Observed domain-deps + dashboard architecture polish

Closes the architecture-tab bug class surfaced by the work-repo checklist
(`dashboard-arch-bug-checklist.md`) and replaces the manual-only
`allowedDeps` reader with a two-layer evidence-plus-intent model.

### 1. Tier A drive-bys (5 fixes)

- [.audit-loop/domain-map.json](.audit-loop/domain-map.json) — 3 missing `allowedDeps` keys (`claudemd-management`, `memory-health`, `root-scripts`); `scripts/lib/stores/**` glob → `scripts/lib/store/**` (legacy plural never matched after M3); `dashboard: ["arch-memory", "shared-lib"]` declared.
- [package.json](package.json) — `dashboard:setup` chain (`arch:refresh → arch:render → dashboard:build`).
- [scripts/build-dashboard.mjs:118-129](scripts/build-dashboard.mjs#L118-L129) — `reportDegraded()` now surfaces `missing-optional` for the architecture source with an actionable `npm run dashboard:setup` hint.
- [AGENTS.md](AGENTS.md) — bootstrap-order paragraph + two-layer dependency-model documentation.
- [scripts/.cli-catalog.json](scripts/.cli-catalog.json) — `dashboard:setup` entry (regression-gate test).

### 2. Tier B: observed-deps feature (plan `docs/plans/observed-domain-deps.md`)

Plan went through `/plan` (backend scope) → `/audit-plan` (R1+R2 + Gemini APPROVE) → implementation → `/audit-code` (5 GPT rounds + 4 Gemini rounds → APPROVE). Final architecture:

- **NEW** [scripts/lib/observed-deps.mjs](scripts/lib/observed-deps.mjs) — schema (Zod 4 `ObservedDepsSchema`), constants (`OBSERVED_FILE`, `OBSERVED_VERSION`), pure fns (`computeDomainMapDigest`, `computeObservedDomainDeps`, `mergeDomainDeps`, `flattenMergedDeps`). Lives at `lib/` not `lib/dashboard/` so writer (`arch-memory` domain) and reader (`dashboard` domain) both import a neutral `shared-lib` module rather than crossing domains.
- [scripts/lib/store/arch-memory.mjs](scripts/lib/store/arch-memory.mjs) — `listFileImportsForSnapshot(refreshId)` returns `[{importer, imported}]` from `symbol_file_imports`.
- [scripts/lib/symbol-index/domain-tagger.mjs](scripts/lib/symbol-index/domain-tagger.mjs) — `makeFastTagger(rules)` precompiles each rule's regex ONCE; ~50× faster than `tagDomain` for the ~190K hot-loop tag calls per render.
- [scripts/symbol-index/render-mermaid.mjs](scripts/symbol-index/render-mermaid.mjs) — writes versioned envelope `{version, refreshId, domainMapDigest, generatedAt, deps}` via `atomicWriteFileSync` after each render. `cleanupStaleObservedDeps()` + `writeAbortStub()` keep `architecture-map.md` and `domain-deps-observed.json` consistently absent/stubbed when arch:render aborts on cloud-off / no-repo / no-snapshot (prevents split-brain state).
- [scripts/lib/dashboard/collect-reference.mjs](scripts/lib/dashboard/collect-reference.mjs) — `readObservedEnvelope` + `readManualAllowedDeps` + `readDomainDeps` (exported for testing). Merges observed ∪ manual with per-edge `source ∈ {observed, manual, both}` provenance. Schema-validates the envelope, freshness-gates against current `domainMapDigest`, falls back to manual on any reject reason.
- [scripts/lib/dashboard/render.mjs](scripts/lib/dashboard/render.mjs) — `formatDepsSourceLine()` adds Architecture-tab subtitle: `"23 edges: 18 observed · 3 manual-only · 2 confirmed-by-both · refresh abc12345"`.
- [scripts/lib/dashboard/assets/dashboard.css:127-128](scripts/lib/dashboard/assets/dashboard.css#L127-L128) — `.section-note.section-warn` class for the muted-warning subtitle variant.
- [.gitignore](.gitignore) — `.audit-loop/domain-deps-observed.json` (derived; regenerated every `arch:render`).

### 3. Followup (4 items from prior Gemini /audit-code)

Separate post-feature cleanup PR ([tests/arch-memory-followups.test.mjs](tests/arch-memory-followups.test.mjs)):
- `getRefreshRun({select})` — `GET_REFRESH_RUN_COLUMNS` allowlist Set; throws on unknown columns; validation runs BEFORE the cloud-disabled early-return so programmer errors surface deterministically.
- `listPrunableRefreshRuns` — JSDoc `GLOBAL BY DESIGN` paragraph documenting that arch:prune is intentionally repo-global (false-positive Gemini finding given closer review).
- `discoverPlans` byDateDesc comparator — parses via `Date.parse`, uses comparison operators (not subtraction) to avoid `-Infinity - (-Infinity) = NaN` violating Array.sort contract.
- `isSafeGitRevision` — regex split into first-char class `[A-Za-z0-9._/@{}~^]` (no `-`) and tail class with `-`; rejects `--output=...`-style git argument injection.

### Test coverage

- **NEW** [tests/observed-deps.test.mjs](tests/observed-deps.test.mjs) — 36 tests covering pure compute, merge semantics, digest stability, schema validation, reader fallback, flatten adapter, and the `DANGEROUS_KEYS` prototype-pollution defense.
- **NEW** [tests/arch-memory-followups.test.mjs](tests/arch-memory-followups.test.mjs) — 7 tests for each followup fix + the NaN regression.
- [tests/learning-store-exports.test.mjs](tests/learning-store-exports.test.mjs) — frozen-export count 106 → 107 (added `listFileImportsForSnapshot`).
- Full suite: **2768 passing**.

### Decisions

- **Two-layer model (evidence + intent)**: observed deps from DB are NOT a replacement for manual `allowedDeps` — they're the evidence layer. Manual entries persist as the intent layer (dynamic imports, framework wiring, intentionally-forbidden edges the import graph can't see). The reader merges both with per-edge provenance.
- **`observed-deps.mjs` lives in `shared-lib`**, not `dashboard/` — keeps writer (`scripts/symbol-index/`) and reader (`scripts/lib/dashboard/`) from importing each other's domains.
- **Read-time freshness gate**: dashboard rejects the observed envelope when `domainMapDigest` mismatches the live rules (i.e. someone edited rules without `arch:render`), surfaces the reject reason in the subtitle.
- **Split-brain prevention**: render-mermaid early-exits (cloud-off / no-repo / no-snapshot) now write a stub markdown AND clear any stale observed file so the two artifacts are consistently absent.

### Out-of-scope deferred (Gemini-flagged pre-existing patterns to address later)

These are existing patterns in files the followup touched. Not introduced by this PR; documented for a future cleanup cycle:
- `scripts/lib/store/arch-memory.mjs` — sustainability split into smaller domain modules (god-module pattern).
- `scripts/lib/dashboard/render.mjs` — monolithic renderer; HTML-escape audit pass.
- `scripts/symbol-index/refresh.mjs` — sensitive-path discovery policy, structured VCS error reporting, child output JSON-lines protocol.

### Next steps

- Run `npm run arch:refresh && npm run arch:render` on this branch to materialise the first `.audit-loop/domain-deps-observed.json` and verify the Architecture tab renders with multiple tiers + correct edge-counts subtitle.
- After merging, consider opening a follow-up plan for the deferred sustainability items above.

---

## 2026-05-21 — Pre-public-release polish: dashboard mode label + repo-root cwd guard

Two ergonomic fixes ahead of opening the repo publicly:

### 1. Dashboard mode label — cloud, not supabase

The telemetry dashboard's freshness banner was hard-coding `'supabase'`
in the Zod enum + collector, so users on RDS / Neon / Railway / self-hosted
Postgres saw a misleading label. Since the M4 postgres-parity migration
unified everything onto `AUDIT_DB_URL` (no JS-level distinction between
"Supabase" and "Postgres"), the label is now `'cloud'`.

- [scripts/lib/dashboard/schema.mjs:140](scripts/lib/dashboard/schema.mjs#L140) — `z.enum(['supabase', 'local-only'])` → `z.enum(['cloud', 'local-only'])`
- [scripts/lib/dashboard/collect-telemetry.mjs:166](scripts/lib/dashboard/collect-telemetry.mjs#L166) — emits `'cloud'` when `auditRuns.data.cloud === true`

### 2. Repo-root cwd guard for CLI entry points

New helper [scripts/lib/assert-repo-root.mjs](scripts/lib/assert-repo-root.mjs)
walks up from the calling script's path to find its `scripts/` parent
directory, then asserts `process.cwd()` matches. On mismatch it writes
an actionable "cd to <path> && re-run" message and exits(1). Catches
the common mistake of cd'ing into `scripts/` or invoking a script with
a path prefix from the wrong directory — relative paths like
`.requirements/` and `.audit/` would otherwise resolve to surprising
locations.

Wired into 17 entry points using the uniform pattern
`async function main() { assertRepoRoot(import.meta.url); ... }`. The
6 oddballs that previously had bare top-level imperative code or
in-script `isMain` gates were refactored to the same `main()` shape
for uniformity — `sync-to-repos.mjs` was the biggest (188-line main
loop re-indented + wrapped, deprecation warning moved inside main()).

### Deliberately not guarded

[scripts/cross-skill.mjs](scripts/cross-skill.mjs) and
[scripts/skills-fit-check.mjs](scripts/skills-fit-check.mjs) are
designed to be invoked from arbitrary cwd (cross-skill is called by
tests with a temp dir as cwd; skills-fit-check accepts
`--repo-root <path>`). Both still got the uniform `main()` wrapping
for structural consistency, but no guard call.

### Honest limitation

The original user error that surfaced this (`node scripts/requirements.mjs`
from the repo's parent directory, no path prefix) fails at Node's module
loader BEFORE the script can run — no in-script guard can intercept it.
The guard catches the adjacent cases:
- `cd scripts && node requirements.mjs ...`
- `node claude-engineering-skills/scripts/requirements.mjs ...` from `C:\GIT/`

### Files Affected

- New: [scripts/lib/assert-repo-root.mjs](scripts/lib/assert-repo-root.mjs) — the helper
- New: [tests/assert-repo-root.test.mjs](tests/assert-repo-root.test.mjs) — 6 tests covering happy path, failure path, no-scripts-ancestor opt-out
- 17 entry points wired: `requirements.mjs`, `build-dashboard.mjs`, `gemini-review.mjs`, `openai-audit.mjs`, `refine-prompts.mjs`, `skills-help.mjs`, `bandit.mjs`, `friction-log.mjs`, `phase7-check.mjs`, `install-prepush-hook.mjs`, `sync-to-repos.mjs`, plus `postgres-parity/generate-expected-schema.mjs`, `security-memory/refresh-incidents.mjs`, and `symbol-index/{drift,duplicates,prune,refresh,render-mermaid}.mjs`
- 2 main()-wrapped but unguarded: `cross-skill.mjs`, `skills-fit-check.mjs`
- Dashboard label: `scripts/lib/dashboard/{schema,collect-telemetry}.mjs`

### Test cycle

One revert during the sweep — initially guarded `cross-skill.mjs` and
`skills-fit-check.mjs`, then the test suite caught it (`cross-skill
compute-target-domains` + 4 related failures, all because tests spawn
those scripts from temp dirs). Reverted the guard call from those two,
kept the `main()` wrapping. Final: 2729 tests, 0 failures.

### Next Steps

- None blocking. Repo ready for public release.

---

## 2026-05-21 — Setup-wizard rework: collapse pre-M4 adapter facade

Cleanup pass on the user-facing setup surfaces left stale by the M4
postgres-parity migration. The runtime already honoured `AUDIT_DB_URL`
only (legacy `SUPABASE_AUDIT_*` triplet fail-fasts at
[scripts/lib/db/client.mjs:79-91](scripts/lib/db/client.mjs#L79-L91)),
but the setup wizard, .env.example, and README still advertised the
old `AUDIT_STORE` adapter facade (noop / sqlite / supabase / postgres /
github) with `SUPABASE_AUDIT_URL` + `AUDIT_POSTGRES_URL` examples.
None of those env vars are read by the runtime anymore.

### Changes

- **[setup.mjs](setup.mjs)** — `DB_OPTIONS` collapsed from 4 entries
  (None / SQLite / Supabase / Postgres) to 2 (None / Postgres). The
  surviving Postgres option prompts for `AUDIT_DB_URL` and covers both
  managed (Supabase pooler) and self-hosted DSNs. Removed the dead
  `env: { AUDIT_STORE: '…' }` writes — no reader exists post-M4 —
  and the `Object.entries(selected.env)` loop that consumed them.
  Choice prompt updated `1-4` → `1-2`.
- **[.env.example](.env.example)** — Replaced the 5-backend adapter
  block (35 lines) with a focused `AUDIT_DB_URL` block (15 lines)
  matching AGENTS.md's connection model + `AUDIT_DB_SSL_MODE=no-verify`
  hint for Supabase poolers. Net −20 lines.
- **[README.md](README.md)** — Env-var table now shows `AUDIT_DB_URL`
  + `AUDIT_DB_SSL_MODE` instead of `AUDIT_STORE` /
  `SUPABASE_AUDIT_URL`+`ANON_KEY` / `AUDIT_POSTGRES_URL`. "Storage
  Adapters" 5-row table replaced with a brief "Learning Store"
  paragraph that links to AGENTS.md for the full setup recipe.

### Decisions

- **`SUPABASE_AUDIT_SERVICE_ROLE_KEY` preserved** — still actively
  read by `scripts/lib/config.mjs:240` for `npm run arch:refresh`
  (architectural-memory writes). Separate concern from the audit-loop
  cloud store; the variable's name is misleading post-M4 but renaming
  it would ripple through too many call sites for a doc-cleanup pass.
- **Legacy-detection error kept** — [scripts/lib/db/client.mjs:79-91](scripts/lib/db/client.mjs#L79-L91)
  still fires an actionable migration message when only the old
  `SUPABASE_AUDIT_*` vars are set. Intentional aid for users
  migrating from pre-M4 .env files.
- **Test fixtures kept** — `tests/fixtures/learning-store.legacy.mjs`
  and `tests/db-config-resolver.test.mjs` exercise the legacy-error
  path on purpose; the `.legacy.mjs` naming is the signal.

### Files Affected

- [setup.mjs](setup.mjs) — wizard DB_OPTIONS rework
- [.env.example](.env.example) — adapter docs → AUDIT_DB_URL block
- [README.md](README.md) — env-var table + Storage Adapters section
- [scripts/.sync-manifest.json](scripts/.sync-manifest.json) — regenerated bookkeeping from prior ship (timestamp + HEAD SHA refresh, no file-list change)

### Next Steps

- None blocking. If a future pass renames `SUPABASE_AUDIT_SERVICE_ROLE_KEY`
  to something matching the post-M4 model, the arch-memory call sites
  in [scripts/lib/config.mjs](scripts/lib/config.mjs) and
  [scripts/symbol-index/render-mermaid.mjs](scripts/symbol-index/render-mermaid.mjs)
  are the touch points.

---

## 2026-05-21 — Postgres-Parity COMPLETE (M0→M4) + plan archived

End-to-end ship of the postgres-parity plan — the audit-loop store now
talks to Postgres directly via the `pg` driver. `@supabase/supabase-js`
removed; the legacy adapter system (`scripts/lib/stores/**`) deleted;
the 2832-line `learning-store.mjs` god module rewritten as a 52-line
barrel over 10 focused domain modules. Plan landed across 8 commits in
3 days (2026-05-19 → 2026-05-21); Gemini final-review APPROVE.

### Changes (commits 6aec0b7 → 2235bea, 8 commits)

- **M0 prerequisites** (`78d598d`, `92d97f0`) — non-core dependency
  inventory, schema-coupling audit, contract matrix (93 functions),
  frozen `learning-store.legacy.mjs` snapshot, CI lint
  (`check-non-core-references.mjs`), live expected-schema manifest
  captured from the audit-loop Supabase (44 tables / 11 views / 27
  policies / 158 functions / 7 extensions).
- **M1 pg query layer** (`6aec0b7`, `6c43662`) —
  `scripts/lib/db/{client,query,rpc,errors}.mjs`. Single `pg.Pool`
  singleton with `AUDIT_DB_URL` resolver + legacy fail-fast,
  pool-scoped type parsers (timestamp/date/timestamptz OIDs → string,
  NOT global pg.types), AsyncLocalStorage transaction context with
  re-entrant `withTx` (SAVEPOINT for nested, never a second pool
  checkout), 8 explicit per-RPC wrappers. Plus 4 test files + M1 audit
  summary (R1→R3 + Gemini ×2, 7 fixes landed).
- **M2 setup CLI** (`be9545d`) — `scripts/lib/db/compat-bootstrap.sql`
  (auth schema + auth.users + auth.uid()-returning-NULL stubs, 3
  anon/authenticated/service_role roles via DO/EXCEPTION, 3 extensions);
  `scripts/setup-postgres.mjs` rewrite with `--migrate`/`--adopt`/
  `--preflight-only`/`--bootstrap-only`/`--dry-run` modes, privilege
  preflight (CREATEROLE + extensions), Supabase-managed-`auth` detection,
  idempotent migration ledger, 10-category schema-drift diff for
  adopt-mode. 14-test integration block (env-gated on AUDIT_DB_TEST_URL).
- **M3 atomic barrel + caller de-leak** (`d1ee5cc` additive +
  `63fba17` atomic) — 10 domain modules under `scripts/lib/store/`
  (repo, debt, bandit-fp, runs-findings, plans-ship, persona, security,
  learning-decisions, arch-memory) totalling 93 frozen-contract
  functions + 10 caller-helper exports. `learning-store.mjs` rewritten
  as a thin re-export barrel. 5 raw-client callers
  (`symbol-index/{prune,refresh}`, `learning/{quickfix-stats,replay,backfill-outcomes}`)
  migrated off `getReadClient`/`getWriteClient` to the new named
  exports. Plus exports-pinning test + contract-suite scaffold.
- **M4 cutover + cleanup** (`47a1368`) — dropped
  `@supabase/supabase-js`; promoted `pg` to runtime dependency; deleted
  `scripts/lib/stores/**`, `scripts/setup-{github,sqlite}-store.mjs`,
  `tests/stores/*` (8 test files); migrated 7 remaining supabase-js
  callers (`memory-health`, `audit-metrics`, `phase7-check`,
  `cache-hitrate-check`, `check-setup`, `check-sync`, `collect-telemetry`)
  through the pg seam; AGENTS.md env-table + privilege-model rewrite;
  `scripts/sync-to-repos.mjs` routing for `setup-postgres.mjs` +
  `compat-bootstrap.sql` + dynamic-enumerated migrations;
  `tests/sync-packaging.test.mjs` (8 structural assertions);
  `.github/workflows/postgres-parity.yml` (DB-backed parity suite,
  pgvector service container).
- **M3+M4 audit + recorder polish** (`42a893d`) — `/audit-code`
  R1 (H:1 M:11) → R2 (H:0 M:5) → Gemini **APPROVE** ("Ready for
  production"); fixes in `tests/sync-packaging.test.mjs` (tautological
  migration-order assertion, hardcoded counts, loose regexes) + the
  Gemini-G1 LOW in `tests/db-setup.test.mjs`;
  `record-golden-fixtures.mjs` gained `--allow-remote <project-ref>`
  with 3 safety guards (verified live: refused production ref +
  refused ref/URL mismatch + refused default policy).
- **Persona-test consolidation** (`9e43d9e`) — migrated 14 personas +
  46 test sessions from the legacy "Persona Test" Supabase project
  (`cnvxixhaubfuijldxyli`, since deleted) into the audit-loop project.
  `Audit-loop wins` collision policy (ON CONFLICT DO NOTHING); jsonb
  columns explicitly stringified; refuses any source ≠ Persona-Test
  project AND any target ≠ Audit-loop project (anti-direction-swap).
- **Plan completion + archive** (`2235bea` + this commit) — plan
  Status flipped Draft → Complete; §12 Completion Notes added (final
  commit map, net diff, live verification, deferred-follow-up
  rationale); all 6 postgres-parity docs moved to `docs/completed/`.

### Files Affected (this session — M3+M4 audit + plan archive)

- `tests/sync-packaging.test.mjs` — hardened per R1 audit (contractual
  naming check; `REQUIRED_MIGRATIONS` allowlist; array-anchored regexes;
  broadened scan)
- `tests/db-setup.test.mjs` — dropped hardcoded `>= 30` migration count
  per Gemini-G1
- `scripts/postgres-parity/record-golden-fixtures.mjs` —
  `--allow-remote <ref>` flag + 3 safety guards
- `tests/fixtures/contract/README.md` — path-A recipe updated with
  `--allow-remote` instructions
- `docs/plans/postgres-parity*.md` (6 files) → `docs/completed/`
- `docs/plans/postgres-parity.md` §12 Completion Notes section added

### Decisions Made

- **Live-DB fixture recording deferred** — the original §9 contract
  suite was the R1-mitigation gate (diff new pg path vs legacy
  supabase-js path). M4 deleted the legacy path, so fixtures today
  would only be a regression baseline, not a parity gate. Recipe +
  `--allow-remote` flag ready when this gets picked up.
- **Plan status uses plain "Complete"** (not bold markdown) so
  `scripts/archive-completed-plans.mjs` can auto-archive future plans
  without operator intervention.

### Next Steps

- Optional follow-up: provision a sandbox Supabase project, flesh out
  90 unseeded `INPUT_FACTORY[]` entries, record fixtures. Recipe in
  `docs/completed/postgres-parity.md` §12.
- AGENTS.md env-table cleanup follow-up: rename `PERSONA_TEST_SUPABASE_*`
  to reflect the consolidated reality (those env keys point at the
  Audit-loop project, not a separate Persona-Test project — confusing).

---

## 2026-05-20 — Persona-test consistency mode (Phases 0-6.5 + 7-round audit)

End-to-end ship of `/persona-test --mode consistency` — a deterministic,
code-driven Playwright runner that detects cross-step UI/state
contradictions against an HTML-attribute contract. Plan was audited
through 10 rounds before implementation (51 findings addressed) and the
implementation was audited through 7 more rounds (34 findings addressed)
before this ship.

### Changes (commits e6e731a → 0af636c, 8 commits over the cycle)

- **Phase 0 — contract layer** (e6e731a): Zod schemas
  (`scripts/lib/persona-test/schemas.mjs`), redaction adapter
  (`scripts/lib/redact.mjs`), additive Supabase migration
  (`supabase/migrations/20260520120000_consistency_source_kinds.sql`),
  authoritative HTML attribute contract doc
  (`docs/consistency-contract.md`), 62 tests
- **Phase 1 — diff + LLM boundary** (8d64312):
  `manifest-resolver.mjs` (priority-ordered, frozen DEFAULT_RESOLVERS),
  `consistency.mjs` (pure diffClaims with type coercion + stale-projection
  + null-grounded + negative-space + per-kind dispatch),
  `semantic-compare.mjs` (CROSS_STREAM_VIOLATION enforcement, redact-first
  egress, model-allowlist), `context.mjs`. Plus SKILL.md Phase 3b.
- **Phase 2 + 3 — capture + ledger** (9a5a6d8):
  `scripts/lib/ux-lock/capture.mjs` with `attachNetworkListener` (passive
  `page.on('response')`, cumulative LRU NetworkGroundTruth store),
  `stabiliseDom` content-hash poll loop, `extractDomClaims`,
  `captureWitness`; `scripts/lib/ux-lock/candidate-spec.mjs` (deterministic
  Playwright spec renderer with per-contradiction-kind assertion templates);
  `scripts/lib/persona-test/ledger.mjs` (atomic per-step writes,
  mandatory persistence on every terminal state, `normaliseForReplay` for
  idempotency).
- **Phase 4 — runner + canary + 6.5 bootstrap** (777e1b1):
  `scripts/lib/persona-test/canary.mjs` (loadCanary path-traversal safe,
  verifyExpectations min/max/shapes/kind), `scripts/persona-consistency-run.mjs`
  (the deterministic CLI with all 6 exit codes 0/2/3/4/5/6), playwright
  npm dep added, `checkPlaywrightAvailable()` in `scripts/check-setup.mjs`.
  cross-skill writers extended: `cmdListConsistencyCandidates`,
  `cmdPromoteRegressionSpec`.
- **Phase 6 — /ship promote + sync-to-repos** (2d65dfb):
  `scripts/persona-consistency-promote.mjs` (crash-tolerant two-phase
  journal: pending → DB commit → db-committed → rename → finalised, with
  reconcile recovery on every restart), `skills/ship/SKILL.md` Step 5.6,
  `playwright` added to consumer `OPTIONAL_DEPS`.
- **Audit-cycle fixes** (0af636c): 34 fixes across 4 /audit-code rounds +
  3 Gemini final reviews. Key landings: cycle detection via ancestor stack,
  redact-before-truncate, try/catch around LLM callbacks, fingerprint
  identity using scope+key (not selector), per-contradiction-kind
  assertions, refuse-promotion on `evaluate` steps, `unresolved-ground-truth`
  finding for unmatched DOM, `coerceDomKey` wired into diffClaims, model
  allowlist enforcement, promote+ship through cross-skill CLI per plan
  Phase 6 facade mandate. See
  `docs/plans/persona-test-consistency-mode-audit-summary.md` for the
  full round-by-round breakdown.

### Decisions made

- **Code-owned Playwright for consistency mode, NOT MCP** (locked in §2.0
  of the plan): the LLM authors canary JSON ahead of time; the runner
  executes deterministically. Trades the exploratory MCP loop for
  byte-identical replay. Exploratory persona-test mode unchanged.
- **No 2PC across Supabase + filesystem** (plan §11b): the promote uses
  a journal-based two-phase commit with reconciliation on next run.
  `reconcilePromotionJournal` DB-disambiguates pending entries; leaves
  them untouched when DB unreachable.
- **`evaluate` journey steps REFUSE promotion** (R2-H3/H10): a TODO
  comment isn't a regression lock. Candidate stays pending; operator
  rewrites the journey without evaluate to enable promotion.
- **Audit cycle stopped at round 7**: coherence reached "Strong" by
  Gemini-R2; further iteration would be rigor-pressure. 1 of 4 R3
  findings (G2 `keyNative === null` typo) was a Gemini hallucination of
  code that doesn't exist — verified by direct grep before dismissal.

### Tests

`npm test`: **2644 pass, 17 skip, 0 fail**. New test files this cycle:
`consistency-schemas`, `redact`, `persona-test-manifest-resolver`,
`persona-test-consistency`, `persona-test-semantic-compare`,
`ux-lock-capture`, `ux-lock-candidate-spec`, `persona-test-ledger`,
`persona-test-canary`, `persona-consistency-run-args`,
`persona-consistency-promote` (~160 test cases).

### Next steps

- Consumer-repo adoption: annotate `data-engine-claim`/`-value`/`-freshness`
  on first surface in wine-cellar-app (status chip + capacity feasibility
  is the canonical first target); author
  `.persona-test/canaries/oliver-infeasible-reorg.json` with
  `expectedContradictions: { min: 1 }`; run end-to-end against staging.
- Optional v2: contradiction-trends cross-skill table (plan §11b deferred
  until 2-3 real consumer adoptions produce session data to shape schema).
- Optional v2: auto-generate `surfaces.json` from `data-engine-claim`
  scans (plan §11b deferred — severity rubric still needs human input).

---

## 2026-05-19 — /plan emits Mermaid architecture diagrams

Added optional Mermaid diagram generation to the `/plan` skill. Phase 6 §2
"Proposed Architecture" now instructs the planner to emit a fenced
` ```mermaid ` block, with a scope→diagram-type table. New Phase 6.5
validates blocks via the Mermaid Chart MCP when available and degrades
silently when not — the MCP is validation-only, never an install
dependency.

### Changes
- `/plan` SKILL.md: §2 diagram-type table + mermaid-block instruction;
  §5 optional `stateDiagram-v2`; new Phase 6.5 (graceful validation);
  reference-table row for the new examples file
- New `skills/plan/examples/mermaid-blocks.md` — 5 copy-paste templates
  (sequenceDiagram, graph LR, graph TD + subgraph, erDiagram, stateDiagram-v2)
- Regenerated `.claude/skills/plan/` copies

### Decisions Made
- The Mermaid block is the *proposed* view, an artifact of the plan — not
  a maintained file. Existing structure still defers to the generated
  `docs/architecture-map.md`. Keeps the "generated, not maintained"
  philosophy and avoids reintroducing stale hand-drawn UML.
- Mermaid MCP validation is optional and graceful — Mermaid renders
  natively in GitHub/VS Code, and the MCP is a Claude.ai account-level
  connector the repo installer cannot manage. No install check added.

> Also shipped this push: a sync dependency-walker (`collectImportClosure`
> in `module-graph.mjs` + `sync-to-repos.mjs` refactor + tests) — committed
> separately; pre-existing working-set change not authored this session.

---

## 2026-05-17 — Requirements layer — a materialized view of de-facto requirements

Implemented `docs/plans/requirements-layer.md` (Plan-Phase A + B) — a new
subsystem that extracts the codebase's de-facto invariants
(security / safety / correctness / behavioural / persistence), reconciles
them into an ID'd ledger, and surfaces in-scope ones to `/audit-code` as
an invariant rubric. Plan audited (GPT 2r + Gemini 2r, 21 findings);
code audited (GPT 4r + Gemini 2r).

### Changes
- **NEW `scripts/lib/requirements/`** — `schema.mjs` (Zod contracts +
  shared `RequirementIdSchema`), `extract.mjs` (2×-run LLM extraction +
  merge, repo-root + symlink egress guards), `gap-challenge.mjs` (advisory
  gap classifier), `ledger.mjs` (pure `reconcile` + atomic load/write),
  `context.mjs` (`getRequirementsContext` — the audit rubric), `llm-json.mjs`
  (shared fenced-JSON parser).
- **NEW `scripts/requirements.mjs`** — CLI: `extract` / `reconcile` / `index`,
  repo-scoped `withFileLock`.
- **MOD `scripts/lib/audit/prompt-builder.mjs`** — `buildAuditPassPrompt`
  accepts a `requirementsRubric` slot (cacheable msg #1).
- **MOD `scripts/openai-audit.mjs`** — `runMultiPassCodeAudit` assembles the
  rubric via `getRequirementsContext` and threads it into every pass;
  non-blocking (ledger absent → audit unaffected).
- **MOD `scripts/sync-to-repos.mjs`** — 6 `requirements/` modules +
  `requirements.mjs` added to `CORE_SCRIPTS`.
- **NEW** `.requirements/README.md`; `tests/requirements-*.test.mjs`
  (5 suites, 54 tests) + `tests/prompt-builder.test.mjs` extension.

### Decisions Made
- `.requirements/` holds only `README.md` at rest — `candidates.json` /
  `gaps.json` / `ledger.json` are runtime-generated; `overrides.json` is
  user-curated. Override parse-failure fails **closed** (operator intent is
  never silently dropped); gap-challenge failure degrades **loudly**.
- Audit caught + fixed a real symlink-egress hole, a self-introduced
  advisory-pass-can-crash-`extract` regression, and a silent ledger
  data-loss path (`coveredFiles` now unions succeeded-batch files only).
  See `docs/plans/requirements-layer-audit-summary.md`.

### Next Steps
- Phase 2 (deferred): the requirement↔code/test drift-check, a `/ship`
  ledger-mutation-proposal flow, an `/audit-plan` consumer, and a
  precomputed reverse-dependency graph.

---

## 2026-05-17 — Adaptive context blast-radius — Phase 3: consumer rewiring (series complete)

Phase 3 of `docs/plans/adaptive-context-blast-radius.md` — wires the
Phase 2 context layer into the external-LLM audit path. Completes the
series (plan audited GPT 2r + Gemini 2r; Phases 1–3 each implemented +
R1-audited + shipped).

### Changes
- `scripts/openai-audit.mjs` — `/audit-code` injects a `getRepoContext`
  block into the cacheable prompt prefix (`fileListContext`): **T1** for
  `--scope diff` (inventory + import adjacency), **T3** for `--scope full`
  (symbol map). `/audit-plan` injects **T0** (inventory) into the
  plan-mode prompt so the auditor can tell "references a nonexistent
  module" from "duplicates an existing one". The gate now receives
  `inventoryComplete`.
- `scripts/gemini-review.mjs` — the final reviewer's prompt gains a
  `getRepoContext` block (T1 code / T0 plan) so it can *falsify* factual
  "missing module" claims in the transcript, not just judge deliberation.
- `scripts/lib/doc-sections.mjs` (new) — heading-aware section extraction
  (`extractSection`, `loadSection`) moved out of the `brainstorm/` feature
  namespace into shared `lib/` (audit P2-M15 / P3-M4); `arch-context.mjs`
  re-exports for back-compat.
- `scripts/lib/audit/finding-verification.mjs` — the gate degrades
  `confirmed` → `requires_verification` when the inventory is incomplete
  (audit P3-M2: provable absence needs a complete inventory).
- 13 new tests; suite green bar one pre-existing flaky timing test.

### Decisions Made
- Phase 3 R1 code-audit (7 findings): M2 (incomplete-inventory soundness)
  and M4 (section loader → neutral module) fixed; M1/M3 (regex-prose
  parsing, advisory T1 read-swallow) deferred with rationale; plan-prose
  path nits + the misplaced-security-policy LOW dismissed.
- **Deferred from Phase 3 scope** (documented in the plan): the
  `/brainstorm` rewiring onto `getRepoContext` (the `--with-arch` feature
  already supplies equivalent context; converting it is cosmetic
  consolidation with regression risk on a shipped feature) and the
  `/audit-plan` neighbourhood-duplication LLM pre-pass (a distinct
  sub-feature — T0 inventory injection already addresses the core gap).

### Files Affected
- `scripts/openai-audit.mjs`, `scripts/gemini-review.mjs`
- `scripts/lib/doc-sections.mjs` (new), `scripts/lib/brainstorm/arch-context.mjs`
- `scripts/lib/audit/finding-verification.mjs`, `scripts/lib/repo-context.mjs`
- `tests/doc-sections.test.mjs` (new), `tests/finding-verification.test.mjs`

### Next Steps
- Optional follow-ups: `/brainstorm` → `getRepoContext` T2 consolidation;
  `/audit-plan` neighbourhood-duplication pre-pass; the `/assess`
  standalone codebase-health skill (separate plan, depends on this layer).

---

## 2026-05-17 — Adaptive context blast-radius — Phase 2: the blast-radius context layer

Phase 2 of `docs/plans/adaptive-context-blast-radius.md` — the
context-provisioning layer with four blast-radius tiers. No consumer
wiring yet (that is Phase 3); the layer is self-contained and tested
directly.

### Changes
- `scripts/lib/repo-context.mjs` (new) — `getRepoContext({tier,scope,
  targetPaths,intent,baseDir})`: T0 inventory · T1 adjacency (imported-
  unchanged modules' public exports) · T2 intent-selected AGENTS.md
  section · T3 symbol map. Full fallback state machine
  (`resolvedTier`/`fallbackReason`), commit-SHA stamped, token-budgeted.
  `INTENT_SECTION_MAP` is the data-driven T2 selector.
- `scripts/lib/module-graph.mjs` — added `parseImports()` + `publicExports()`
  (comment-stripped ESM regex; advisory, for T1).
- `scripts/lib/brainstorm/arch-context.mjs` — generalised `loadArchSection`
  → `loadSection({heading})` + exported `extractSection`; `loadArchSection`
  kept as a back-compat wrapper.
- 26 new/extended tests; full suite green (2284, 0 fail).

### Decisions Made
- Phase 2 R1 code-audit (21 findings): ~11 genuine fixes applied — repo-root
  resolution in the inventory (`git rev-parse --show-toplevel` so subdir
  invocation still yields root-relative paths); symbol claims never refuted
  (a name-only lookup is not sound proof — gate adjudicates files only);
  `targetPaths` validated against the inventory before any read;
  `execSync` maxBuffer raised; fs-walk no longer blanket-skips dot-dirs;
  `complete` completeness flag; line-boundary truncation; honest T3
  artefact labelling; unknown-intent surfaced not silently defaulted;
  gate imports made static. Deferred with rationale: M15 (move `loadSection`
  to a neutral module — benign coupling), M11 (structured-citation
  contract — larger change). Dismissed: plan-prose path nits, the
  prior-adjudicated `@import` decision, context-provider≠audit-run.

### Files Affected
- `scripts/lib/repo-context.mjs` (new)
- `scripts/lib/repo-inventory.mjs`, `scripts/lib/module-graph.mjs`,
  `scripts/lib/brainstorm/arch-context.mjs`, `scripts/openai-audit.mjs`
- `tests/repo-context.test.mjs` (new), `tests/{module-graph,finding-verification}.test.mjs`

### Next Steps
- Phase 3: rewire `/audit-code`, `/audit-plan`, `gemini-review`,
  `/brainstorm` onto `getRepoContext`.

---

## 2026-05-17 — Adaptive context blast-radius — Phase 1: deterministic finding-verification gate

First phase of `docs/plans/adaptive-context-blast-radius.md` (the plan
synthesised from a multi-LLM brainstorm + audited GPT 2r / Gemini 2r, 15
findings). Phase 1 is the self-contained, highest-leverage unit — a
deterministic gate that stops the audit pipeline from emitting "missing
file/module" false positives (3 of 4 HIGH findings on the previous PR
were exactly that).

### Changes
- `scripts/lib/repo-inventory.mjs` (new) — `listRepoFiles()`: the canonical
  sensitive-path-filtered repo file list. Git inventory unions
  `ls-files` + `ls-files --others --exclude-standard` minus
  `ls-files --deleted` (tracked + new − ghost files); `.gitignore`-ish
  fs-walk fallback off-git. Sensitive paths filtered DURING traversal.
- `scripts/lib/module-graph.mjs` (new) — `resolveSpecifier()`: ESM-only
  deterministic specifier resolution; `exact` mode (no extensionless
  probing) for the gate; scoped packages / leading-slash → external /
  unresolvable, never guessed.
- `scripts/lib/audit/finding-verification.mjs` (new) — `verifyExistenceFindings()`:
  classifies "missing X" findings, extracts the cited entity anchored on
  the claim phrase (not first-quoted-token), resolves it against the repo,
  and downgrades ONLY provably-false ones (`refuted`). `confirmed` /
  `requires_verification` preserve the model's severity; missing-symbol
  claims are never `confirmed` (the AST index is incomplete).
- `scripts/lib/schemas.mjs` — `FindingVerificationSchema`; optional
  `verification` sibling on `PersistedFindingSchema` (immutable original).
- `scripts/openai-audit.mjs` — gate wired into `runMultiPassCodeAudit`
  (code mode only), post-normalize / pre-verdict; verdict counts
  `verdictSeverity`/`countsTowardVerdict`.
- 29 new tests across 3 suites; full suite green (2270, 0 fail).

### Decisions Made
- Phase 1 R1 code-audit (20 findings): ~11 genuine gate-correctness bugs
  fixed (anchored extraction, ESM-exact resolution, no `fs` fallback,
  scoped-package handling, sensitive-path filtering during walk); the rest
  were diff-scope artefacts (Phase 2 not built yet) or plan-prose path
  shorthand.
- Phases 2 (context tiers) + 3 (consumer rewiring) remain — separate
  cycles, as the plan sequences them.

### Files Affected
- `scripts/lib/repo-inventory.mjs`, `scripts/lib/module-graph.mjs`,
  `scripts/lib/audit/finding-verification.mjs` (new)
- `scripts/lib/schemas.mjs`, `scripts/openai-audit.mjs`
- `tests/{repo-inventory,module-graph,finding-verification}.test.mjs` (new),
  `tests/shared.test.mjs`

### Next Steps
- Phase 2: `scripts/lib/repo-context.mjs` blast-radius tiers (T0–T3).
- Phase 3: rewire `/audit-code`, `/audit-plan`, `gemini-review`,
  `/brainstorm` onto the context layer.

---

## 2026-05-17 — /brainstorm `--with-arch`: codebase context for external LLMs

Closes the asymmetry where Claude's `/brainstorm` take was codebase-grounded
but the external LLMs (OpenAI/Gemini) received only the topic string —
`/brainstorm` had no context-assembly step at all, unlike `/audit-code`.
Shipped via the full `/cycle` (plan → 3-round GPT + 3-round Gemini plan
audit → implement → code audit → ship).

### Changes
- `scripts/lib/brainstorm/arch-context.mjs` (new) — `loadArchSection()`
  extracts the `## Architecture` H2 from `AGENTS.md`→`CLAUDE.md` with a
  heading-aware, fence-tracking line parser (no regex — the section starts
  with a ``` directory-tree fence); `shouldAttachArch()` is a pure attach
  predicate. Candidate-walk file resolution; never throws (`fs` errors →
  `unreadable` state).
- `--with-arch` / `--no-arch` flags on `scripts/brainstorm-round.mjs`.
  Default: auto-attach when the topic shows architecture intent (shared
  `ARCH_INTENT_RE` keyword trigger). Mutually exclusive.
- `resume-context.mjs` — arch block redacted, wrapped in
  `<architecture_context>` XML tags (collision-proof vs the section's own
  ``` fences), wrapper-aware-truncated to a new `ARCH_CONTEXT_FRACTION`
  (0.1) budget slice, prepended to `systemPreface` (so the debate round
  inherits it for free).
- `schemas.mjs` — 3 envelope fields (`archContextAttached`,
  `archContextChars`, `archContextWarning`); `BrainstormEnvelopeWriteSchema`
  now genuinely strict (required arch fields) while V2 reads stay lenient.
- `session-store.mjs` — `loadSession()` normalizes legacy rows.
- 24 new tests (`tests/brainstorm-arch-context.test.mjs`); full suite green
  (2241 tests, 0 fail).

### Files Affected
- `scripts/lib/brainstorm/arch-context.mjs` — new loader + attach predicate
- `scripts/brainstorm-round.mjs` — flags, decision, envelope fields
- `scripts/lib/brainstorm/{depth-config,provider-limits,resume-context,schemas,session-store}.mjs`
- `skills/brainstorm/SKILL.md` (+ regenerated `.claude/` copy)
- `docs/plans/brainstorm-arch-context.md` + `-audit-summary.md`

### Decisions Made
- Auto-attach intent scan is bounded to the first 600 chars of `topic`
  only (not `--with-context`) — Gemini caught that scanning a piped file
  or large pasted context would false-positive on generic keywords.
- New module rather than reusing audit-domain `context.mjs` — keeps the
  `brainstorm` domain off the Anthropic-client dependency graph.
- 8 pre-existing session-store/provider-limits debt items surfaced by the
  diff-scope code audit were deferred (see audit summary), not fixed —
  scope discipline.

### Next Steps
- None for this feature. Deferred pre-existing debt tracked in the audit summary.

---

## 2026-05-15 — Architecture-Intent PR-C: Postgres adapter (series complete)

PR-C, the final adapter of the 3-PR architecture-intent series. Adds a
pure-JS Postgres `.sql` adapter so the architecture pass works on database
schema migrations. Shipped via the full `/cycle`.

**What shipped**:
- `scripts/lib/arch-intent/adapters/postgres.mjs` (new, ~430 LOC) —
  pure-JS Postgres DDL analyser, NO database/credentials, CI-safe.
  3-stage pipeline: `parseFile` (length-preserving lexical strip
  handling `--` comments, NESTED `/* */`, `'…'`/`E'…'` strings,
  `$tag$…$tag$` dollar-quotes, preserved quoted identifiers) →
  `buildSqlCatalog` (natural-sorted, epoch-tracked ordered replay —
  CREATE/REPLACE last-wins, DROP removes, named constraint/trigger/
  policy drop-matching; kind-separated relation/function/type maps) →
  `resolveEdges` (kind-aware three-state resolution). Seven edge kinds:
  foreign-key, view-select, function-call, trigger-binding,
  policy-reference, partition-of, column-type.
- `scripts/lib/repo-stack.mjs` — `hasPostgresSources()` (tiered
  detection: `supabase/migrations/` strong signal, else `.sql` +
  Postgres-distinctive content marker) + `postgres` in `stackKinds`.
- `scripts/sync-to-repos.mjs` — `postgres.mjs` added to `CORE_SCRIPTS`.
- `tests/arch-intent-adapter-postgres.test.mjs` (new, 44 tests),
  `tests/repo-stack.test.mjs` (+4 Postgres cases).
- `docs/plans/arch-intent-pr-c-postgres-adapter.md` (new),
  `docs/completed/arch-intent-pr-c-audit-summary.md` (new).

**Decisions Made**:
- *Pure-JS `.sql` parsing, not live `pg_catalog` introspection* — the
  parent plan sketched `pg_catalog`, but that needs a running DB +
  credentials and cannot run in CI. Overridden, same as PR-B overrode
  import-linter / ArchUnit codegen.
- *File-granularity domains* — objects inherit their defining `.sql`
  file's domain via the existing `mapped` contract input; NO
  `DomainMapSchema` change. Object-granularity (name-pattern → domain)
  explicitly deferred to a future PR.
- *Epoch-tracked ordered catalog* — migrations evolve schema; the
  current state (last `CREATE OR REPLACE`, post-`DROP`) is what's
  analysed, with per-object epochs so drop-then-recreate discards
  stale edges.
- Adapter contract frozen — PR-C conforms; did not modify it.
- Pre-existing `scripts/.sync-manifest.json` left unstaged (scope-discipline).

**Audit**: `/cycle` ran 3 GPT + 2 Gemini rounds at the plan stage and
2 GPT + 2 Gemini rounds at the code stage. Gemini coherence "Strong"
every round, 0 wrongly-dismissed every round; the final residual finding
(at the Gemini round-2 cap) was concrete and fixed. Full suite 2065 pass
/ 0 fail.

**The architecture-intent series is now complete** — JS/TS (PR-A),
Python + Java (PR-B, commit 18ecc5e), Postgres (PR-C). Four adapters,
one frozen contract.

---

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

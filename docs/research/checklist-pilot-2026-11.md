# Checklist pilot, 2026-11 (verification-lessons plan, Phase 5)

Status: **FAIL on thresholds (iii) held-out noise and the kernel-size target (v2). A redesigned v3 is built and FROZEN; its confirmation run on PRs merged after the freeze is a later task. Cluster F does not run.** AGENTS.md was not edited: every moved sentence exists in both AGENTS.md and the checklist. See section Decision.

Everything below is reproducible from the repo at a pinned tip (`9865dc651db4fc3f4faa554c5ea1c09c3a4f4ef6`, origin/main when measured):

```
# every replay names its checklist explicitly and records the sha256 of the file it read (checklistSha256 in the output)
npm run checklist:pilot -- --replay --tip 9865dc651db4fc3f4faa554c5ea1c09c3a4f4ef6 --skip 0  --checklist docs/research/checklist-pilot-2026-11-v1-checklist.json --json   # v1, pilot window
npm run checklist:pilot -- --replay --tip 9865dc651db4fc3f4faa554c5ea1c09c3a4f4ef6 --skip 30 --checklist docs/research/checklist-pilot-2026-11-v1-checklist.json --json   # v1, held-out window
npm run checklist:pilot -- --replay --tip 9865dc651db4fc3f4faa554c5ea1c09c3a4f4ef6 --skip 0  --checklist docs/research/checklist-pilot-2026-11-v2-checklist.json --json   # v2, pilot window  (the committed v2 as measured)
npm run checklist:pilot -- --replay --tip 9865dc651db4fc3f4faa554c5ea1c09c3a4f4ef6 --skip 30 --checklist docs/research/checklist-pilot-2026-11-v2-checklist.json --json   # v2, held-out window (the confirmation figure)
npm run checklist:pilot -- --replay --tip 9865dc651db4fc3f4faa554c5ea1c09c3a4f4ef6 --skip 0  --json                     # v3 = the committed .audit-loop/checklist.json
npm run checklist:pilot -- --incidents --json   # the commits that earned each entry
npm run checklist:pilot -- --controls  --json   # per-entry control / negative verdicts
npm run checklist:pilot -- --kernel    --json   # kernel size estimate
npm run checklist:pilot -- --verify-frozen      # sha256 of checklist, matcher and scoring code vs the pinned constants
```

Checklist sha256 (CRLF folded to LF): v1 `a328f88f964f2758c3b0d085b284aca013c31e15c21c963499d1dcf9f25a58da`, v2 `cbc40e19d1786c9367b95aee081e7018db8036bdacf21412d997787718949fed`, v3 `8a6555dd12b06cfd53724fcd7c0e6cae6994be461b67f6a14691b0ecf1aea36d`. The v1 and v2 numbers in this document were measured with exactly these two frozen files; the v2 file is byte-identical to what was committed when they were measured.

Per-entry evidence (the `pass` rows a Cluster F test would require): `docs/research/checklist-pilot-2026-11.json`. Frozen v1 entries: `docs/research/checklist-pilot-2026-11-v1-checklist.json`. The committed `.audit-loop/checklist.json` is generated (`npm run checklist:gen`, checked by `checklist:gen:check` in `check:static`).

## Inventory

**Correction to the plan: 27 gates, not 26.** The plan's "26 AGENTS.md sentences" is the count of AGENTS.md-quoting **gates** at `6680c819` as 25+1; the census (`statedIn == "AGENTS.md"` over `scripts/gate-contracts/*.json` and `skills/*/gate-contract.json`, derived, not listed) finds **26 in `scripts/gate-contracts/` (23 files; `skills-check.json` holds four) plus 1 in `skills/audit-code/gate-contract.json` = 27**. Result: **26 selectable, 1 kernel**.

| # | Gate (contract file) | Class | Checklist entry and trigger evidence | Other consumers of this sentence |
|---|---|---|---|---|
| 1 | `anthropic-pin-gate-detects-an-unpinned-system-call` (`scripts/gate-contracts/anthropic-pin-gate.json`) | **selectable** | `anthropic-pin-unserviceable-param`: paths: scripts/lib/anthropic-client.mjs, scripts/lib/anthropic-cli-faithfulness.mjs, .anthropic-pin-census.json; symbols: createAnthropicClient, unserviceableCliParams; patterns: `\btool_choice\s*:`; patterns count only in: scripts/*.mjs, scripts/**/*.mjs | impl `scripts/check-anthropic-pins.mjs`; tests `tests/gate-poison-pills.test.mjs`; poison-pill oracle (`gates:poison`); `gates:check`/`skills:check` |
| 2 | `bundle-deps-check-compares-the-derived-set` (`scripts/gate-contracts/bundle-deps-check.json`) | **selectable** | `generated-artifact-bundle-deps`: paths: scripts/lib/bundle-deps.json, scripts/generate-bundle-deps.mjs, scripts/lib/sync-entry-lists.mjs<br>selectable, with a known blind spot: it fires on the artifact and the sync entry lists, not on a new import in an arbitrary scripts file (the gate still catches that at push). | impl `scripts/generate-bundle-deps.mjs`; tests `tests/upstream-triage-2026-09-07.test.mjs`, `tests/gate-poison-pills.test.mjs`; poison-pill oracle (`gates:poison`); `gates:check`/`skills:check` |
| 3 | `context-check-rejects-missing-agents-import` (`scripts/gate-contracts/context-check.json`) | **selectable** | `context-check-agents-md-size`: paths: AGENTS.md, CLAUDE.md, .claude-context-allowlist.json, scripts/check-context-drift.mjs<br>CONTESTED -> selectable. The sentence is AGENTS.md's own preamble; it fires when AGENTS.md or CLAUDE.md is touched, which is exactly when it matters. | impl `scripts/check-context-drift.mjs`; tests `tests/gate-poison-pills.test.mjs`; poison-pill oracle (`gates:poison`); `gates:check`/`skills:check` |
| 4 | `db-enrolment-gate-detects-a-suite-no-runner-names` (`scripts/gate-contracts/db-enrolment-gate.json`) | **selectable** | `db-suite-two-edit-enrolment`: paths: scripts/lib/db-test-container.mjs, .github/workflows/postgres-parity.yml, scripts/check-db-suite-enrolment.mjs; patterns: `AUDIT_DB_TEST_URL`; patterns count only in: tests/*.mjs, tests/**/*.mjs | impl `scripts/check-db-suite-enrolment.mjs`; tests `tests/gate-poison-pills.test.mjs`; poison-pill oracle (`gates:poison`); `gates:check`/`skills:check` |
| 5 | `architecture-intent-check-detects-an-undocumented-domain` (`scripts/gate-contracts/docs-architecture-intent-check.json`) | **selectable** | `architecture-intent-domain-roster`: paths: .audit-loop/domain-map.json, docs/architecture-intent.md | impl `scripts/check-architecture-intent-drift.mjs`; tests `tests/check-architecture-intent-drift.test.mjs`, `tests/gate-poison-pills.test.mjs`; poison-pill oracle (`gates:poison`); `gates:check`/`skills:check` |
| 6 | `docs-synced-links-gate-rejects-a-relative-link-that-leaves-the-closure` (`scripts/gate-contracts/docs-synced-links-gate.json`) | **selectable** | `synced-markdown-relative-links`: paths: scripts/check-synced-doc-links.mjs; patterns: `\]\(\.\.?/[^)\s]+\.md`; patterns count only in: skills/**/*.md, docs/reference/consistency-contract.md | impl `scripts/check-synced-doc-links.mjs`; tests `tests/gate-poison-pills.test.mjs`, `tests/synced-doc-links.test.mjs`; poison-pill oracle (`gates:poison`); `gates:check`/`skills:check` |
| 7 | `emit-exit-gate-detects-a-new-declared-opt-out` (`scripts/gate-contracts/emit-exit-gate.json`) | **selectable** | `emit-softfail-opt-out`: paths: scripts/lib/cli-io.mjs, scripts/check-emit-exit-agreement.mjs; symbols: softFail; patterns: `\bsoftFail\s*:`; patterns count only in: scripts/*.mjs, scripts/**/*.mjs | impl `scripts/check-emit-exit-agreement.mjs`; tests `tests/gate-poison-pills.test.mjs`; poison-pill oracle (`gates:poison`); `gates:check`/`skills:check` |
| 8 | `gitignore-policy-rejects-undeclared-rules` (`scripts/gate-contracts/gitignore-policy-gate.json`) | **selectable** | `gitignore-rule-declares-why`: paths: .gitignore, .gitignore-policy-baseline.json | impl `scripts/check-gitignore-policy.mjs`; tests `tests/check-gitignore-policy.test.mjs`, `tests/gate-poison-pills.test.mjs`; poison-pill oracle (`gates:poison`); `gates:check`/`skills:check` |
| 9 | `help-readonly-gate-rejects-a-cli-that-runs-on-help` (`scripts/gate-contracts/help-readonly-gate.json`) | **selectable** | `cli-help-is-a-pure-read`: paths: scripts/*.mjs, scripts/lib/help-guard-run.mjs, scripts/check-help-readonly.mjs<br>CONTESTED -> selectable. Trigger is `scripts/*.mjs` (every CLI edit): real but broad, 18 of 30 window PRs, the noisiest entry. | impl `scripts/check-help-readonly.mjs`; tests `tests/gate-poison-pills.test.mjs`, `tests/help-readonly-gate.test.mjs`; poison-pill oracle (`gates:poison`); `gates:check`/`skills:check` |
| 10 | `mcp-parity-rejects-missing-dash-y` (`scripts/gate-contracts/mcp-parity-gate.json`) | **selectable** | `mcp-config-mirrored`: paths: .mcp.json, .vscode/mcp.json, scripts/check-mcp-parity.mjs | impl `scripts/check-mcp-parity.mjs`; tests `tests/mcp-parity.test.mjs`; poison-pill oracle (`gates:poison`); `gates:check`/`skills:check` |
| 11 | `own-model-coverage-gate-rejects-a-config-with-no-scan-boundary` (`scripts/gate-contracts/own-model-coverage-gate.json`) | **selectable** | `own-model-capture-column-coverage`: paths: .own-model-coverage.json, scripts/own-model-coverage.mjs, tests/fixtures/expected-schema.json; patterns: `ADD COLUMN|add column`; patterns count only in: supabase/migrations/** | impl `scripts/own-model-coverage.mjs`; tests `tests/own-model-pr3.test.mjs`, `tests/gate-poison-pills.test.mjs`; poison-pill oracle (`gates:poison`); `gates:check`/`skills:check` |
| 12 | `parity-coupling-rejects-new-schema-qualification` (`scripts/gate-contracts/parity-check-coupling.json`) | **selectable** | `migrations-schema-portable`: paths: supabase/migrations/**, scripts/postgres-parity/check-non-core-references.mjs | impl `scripts/postgres-parity/check-non-core-references.mjs`; tests `tests/gate-poison-pills.test.mjs`; poison-pill oracle (`gates:poison`); `gates:check`/`skills:check` |
| 13 | `plans-index-check-compares-rendered-content` (`scripts/gate-contracts/plans-index-check.json`) | **selectable** | `generated-artifact-plans-index`: paths: docs/plans/README.md, docs/plans/*.md, scripts/generate-plans-index.mjs | impl `scripts/generate-plans-index.mjs`; tests `tests/gate-poison-pills.test.mjs`; poison-pill oracle (`gates:poison`); `gates:check`/`skills:check` |
| 14 | `requirements-map-check-compares-rendered-content` (`scripts/gate-contracts/requirements-map-check.json`) | **selectable** | `generated-artifact-requirements-map`: paths: docs/requirements-map.md, .requirements/ledger.json, scripts/requirements.mjs | impl `scripts/requirements.mjs`; tests `tests/gate-poison-pills.test.mjs`; poison-pill oracle (`gates:poison`); `gates:check`/`skills:check` |
| 15 | `size-ratchet-rejects-growth-past-the-baseline` (`scripts/gate-contracts/size-ratchet-gate.json`) | **kernel** | CONTESTED -> kernel. The rule applies when ANY scripts/** file over 1000 lines is edited; that is a file attribute, not a path or symbol. The only honest trigger is `.file-size-baseline.json` (re-baselining), which is not when the mistake is made. `scripts/**` as a trigger would fire on most PRs: contrived, so kernel. Contract stays `statedIn: AGENTS.md`. | impl `scripts/file-size-ratchet.mjs`; tests `tests/file-size-ratchet.test.mjs`, `tests/gate-poison-pills.test.mjs`; poison-pill oracle (`gates:poison`); `gates:check`/`skills:check` |
| 16 | `skills-check-detects-hand-edited-generated-copy` (`scripts/gate-contracts/skills-check.json`) | **selectable** | `generated-skills-copy-never-hand-edited`: paths: .claude/skills/**, scripts/regenerate-skill-copies.mjs | impl `scripts/regenerate-skill-copies.mjs`; tests `tests/gate-poison-pills.test.mjs`; poison-pill oracle (`gates:poison`); `gates:check`/`skills:check` |
| 17 | `skills-check-detects-shared-reference-drift` (`scripts/gate-contracts/skills-check.json`) | **selectable** | `skill-reference-summary-byte-match`: paths: docs/audit/shared-references/**, scripts/sync-shared-audit-refs.mjs; patterns: `^summary:`, `^\| `references/`; patterns count only in: skills/*/references/*.md, skills/*/SKILL.md, docs/audit/shared-references/*.md | impl `scripts/sync-shared-audit-refs.mjs`; tests `tests/gate-poison-pills.test.mjs`; poison-pill oracle (`gates:poison`); `gates:check`/`skills:check` |
| 18 | `skills-check-detects-over-budget-description` (`scripts/gate-contracts/skills-check.json`) | **selectable** | `skill-frontmatter-description-budget`: paths: scripts/check-skill-descriptions.mjs; patterns: `^(name|description):`; patterns count only in: skills/*/SKILL.md | impl `scripts/check-skill-descriptions.mjs`; tests `tests/gate-poison-pills.test.mjs`; poison-pill oracle (`gates:poison`); `gates:check`/`skills:check` |
| 19 | `skills-check-detects-indented-frontmatter-key` (`scripts/gate-contracts/skills-check.json`) | **selectable** | `skill-frontmatter-indented-key-inert`: paths: scripts/check-skill-frontmatter.mjs; patterns: `^\s+(argument-hint|allowed-tools|user-invocable|disable-model-invocation|model|summary):`; patterns count only in: skills/*/SKILL.md | impl `scripts/check-skill-frontmatter.mjs`; tests `tests/gate-poison-pills.test.mjs`, `tests/skill-frontmatter-layout.test.mjs`; poison-pill oracle (`gates:poison`); `gates:check`/`skills:check` |
| 20 | `skills-consumer-refs-gate-rejects-an-undeclared-unreachable-pointer` (`scripts/gate-contracts/skills-consumer-refs-gate.json`) | **selectable** | `synced-skill-content-reachable-refs`: paths: .skill-consumer-refs-baseline.json; patterns: `npm run [a-z][\w:.-]*`, `docs/[\w./-]+\.md`; patterns count only in: skills/**/*.md | impl `scripts/check-skill-consumer-refs.mjs`; tests `tests/gate-poison-pills.test.mjs`, `tests/skill-consumer-refs.test.mjs`; poison-pill oracle (`gates:poison`); `gates:check`/`skills:check` |
| 21 | `skills-size-ratchet-rejects-growth-past-the-baseline` (`scripts/gate-contracts/skills-size-gate.json`) | **selectable** | `skill-markdown-size-ratchet`: paths: skills/**/*.md, docs/audit/shared-references/*.md, .skill-size-baseline.json | impl `scripts/skill-size-ratchet.mjs`; tests `tests/skill-size-ratchet.test.mjs`, `tests/gate-poison-pills.test.mjs`; poison-pill oracle (`gates:poison`); `gates:check`/`skills:check` |
| 22 | `stdout-flush-gate-detects-a-new-undrained-exit` (`scripts/gate-contracts/stdout-flush-gate.json`) | **selectable** | `exit-after-stdout-must-drain`: paths: scripts/lib/cli-io.mjs, scripts/check-stdout-flush.mjs; patterns: `\bprocess\.exit\(`; patterns count only in: scripts/*.mjs, scripts/**/*.mjs | impl `scripts/check-stdout-flush.mjs`; tests `tests/stdout-flush-detector.test.mjs`, `tests/gate-poison-pills.test.mjs`; poison-pill oracle (`gates:poison`); `gates:check`/`skills:check` |
| 23 | `upstream-coverage-gate-detects-an-unresolvable-probe-disposition` (`scripts/gate-contracts/upstream-coverage-gate.json`) | **selectable** | `upstream-report-disposition-resolves`: paths: scripts/upstream-dispositions.json, scripts/lib/doctor/registry.mjs, scripts/lib/doctor/probes.mjs, scripts/lib/upstream/** | impl `scripts/check-upstream-probe-coverage.mjs`; tests `tests/gate-poison-pills.test.mjs`; poison-pill oracle (`gates:poison`); `gates:check`/`skills:check` |
| 24 | `visual-contract-doc-drift-detected` (`scripts/gate-contracts/visual-contract-doc-gate.json`) | **selectable** | `visual-contract-doc-example-drift`: paths: skills/visual-audit/references/contract-and-bootstrap.md, scripts/check-visual-contract-doc-drift.mjs, scripts/lib/visual/** | impl `scripts/check-visual-contract-doc-drift.mjs`; tests `tests/visual-contract-doc-drift.test.mjs`; poison-pill oracle (`gates:poison`); `gates:check`/`skills:check` |
| 25 | `windowed-views-gate-rejects-an-undeclared-windowed-view` (`scripts/gate-contracts/windowed-views-gate.json`) | **selectable** | `windowed-view-declares-its-window`: paths: .windowed-views.json, scripts/check-windowed-views.mjs; patterns: `CREATE (OR REPLACE )?VIEW|create (or replace )?view`; patterns count only in: supabase/migrations/** | impl `scripts/check-windowed-views.mjs`; tests `tests/windowed-views.test.mjs`, `tests/gate-poison-pills.test.mjs`; poison-pill oracle (`gates:poison`); `gates:check`/`skills:check` |
| 26 | `worktree-preflight-rejects-skill-without-marker` (`scripts/gate-contracts/worktree-preflight-gate.json`) | **selectable** | `worktree-documented-command-reachable`: paths: scripts/check-worktree-preflight.mjs; patterns: `scripts/\.claude-skills/`; patterns count only in: skills/**/*.md | impl `scripts/check-worktree-preflight.mjs`; tests `tests/worktree-preflight-gate.test.mjs`, `tests/gate-poison-pills.test.mjs`; poison-pill oracle (`gates:poison`); `gates:check`/`skills:check` |
| 27 | `tiered-shadow-window-honesty` (`skills/audit-code/gate-contract.json`) | **selectable** | `tiered-shadow-window-epoch-gated`: paths: scripts/lib/tiered-shadow*.mjs, scripts/lib/tiered-recall/**; symbols: TIERED_SHADOW_CONTRACT_EPOCH, comparedRuns | impl `scripts/lib/audit/tiered-shadow-summary.mjs`; tests `tests/gate-honesty.test.mjs`; tiered-shadow-window oracle (`gates:poison`); `gates:check`/`skills:check` |

Contested calls: the size-ratchet gate (kernel), and three selectable calls with caveats (help-readonly breadth, context-check, bundle-deps blind spot) are annotated in the rows above.

**Other consumers of the 27 sentences, and their state after the migration** (all checked):

- `npm run gates:check` (`scripts/check-gate-contracts.mjs`): green. The shared per-gate validator in `scripts/lib/gate-honesty/schema.mjs` now admits `.audit-loop/checklist.json#<id>`, requires the entry to exist, to name the gate back and carry the same `stated`, and reads `stated` from the entry's `check` text. `loader.mjs` and `check-gate-contracts.mjs` needed no edit (both call the shared validator).
- `npm run skills:check`: green (it runs `gates:check`). `npm run gates:poison`: unaffected (the pills run the gate implementations, not the prose).
- `tests/gate-honesty*.test.mjs`, `tests/gate-poison-pills.test.mjs`, `tests/gate-contract-eol.test.mjs`: pass; new `tests/gate-honesty-checklist-statedin.test.mjs` covers the new spelling in both directions.
- Gate provenance (`.gate-files.json`, observe mode): `schema.mjs` is a registered gate-defining file and admitting a new `statedIn` source may classify as loosening; observe mode only prints.
- **Known stale references (left alone on purpose: re-extraction costs paid calls).** `.requirements/ledger.json` assertions that still say `statedIn` may be only SKILL.md or AGENTS.md: the entries at lines 60127 ("Every executable gate's stated text must occur verbatim in its approved statedIn file..."), 133894 ("...may cite only its owning skills/<skill>/SKILL.md or AGENTS.md as statedIn, while an executable CLI gate may cite only AGENTS.md") and 135625 ("...cite only the owning skill SKILL.md or AGENTS.md as statedIn..."). `requirements:map:check` compares the map to the ledger and stays green; the ledger is simply behind the code until the next extraction.
- AGENTS.md's own line "26 sentences here are quoted character-for-character by gate contracts" is now stale (26 of 27 moved); Cluster F owns that edit.

The trigger text above is generated from the CURRENT (v3) `.audit-loop/checklist.json`; the v1/v2 triggers it replaced are in the frozen v1/v2 files.

## Method

- **Window**: the 30 most recent PR squash commits (subject ends `(#n)`) first-parent from the pinned tip, each commit's own diff (`<sha>^..<sha>`, `--find-renames`) through `matchChecklist` with purpose `replay`. Pilot window = PRs #410..#442 (2026-11-20..2026-11-22). Held-out window = the 30 before it, #380..#409 (2026-11-17..2026-11-20).
- **Thresholds fixed before the replay (plan section 2.5)**: (i) every incident entry whose incident PR is in the window fires on it; (ii) every control fires and every declared negative is silent; (iii) median entries fired per PR <= 5 and no PR > 12.
- **In-window incident PRs** were curated from each entry's `incident` text: only `cli-help-is-a-pure-read` has its incident fix (`19e21e74`, #436) inside the pilot window. n = 1, so recall evidence in the window is thin; the supplementary out-of-window replay below is there because of that.

## v1 to v2: the trigger tuning, stated honestly

v1 was the first checklist written. Its replay on the pilot window gave **max 13, a threshold failure**. The diagnosis of that run, from the per-PR table, was two design defects, and v2 fixed those and nothing else:

1. **Patterns fired in every file type.** A pattern such as `process.exit(` fired on a markdown plan quoting it. Fix: a new optional `trigger.patternPaths` scopes where a pattern counts; 13 entries now scope theirs.
2. **Symbols and a pattern that fire on correct usage.** `finishAndExit` and `isInvokedAsScript` (the right calls) and `createHash(` (common, not the mistake) triggered the tripwires meant for the wrong ones. Removed.

**v2 was tuned on the same 30-PR sample it is then scored on**, so its pilot-window numbers are fit to that sample and are NOT the confirmation. The confirmation figure is the **held-out window (the 30 PRs before it), run with no further tuning**.

## Results

| Measure | v1 pilot window | v2 pilot window (tuned on it) | v1 held-out | **v2 held-out (confirmation)** |
|---|---|---|---|---|
| Entries | 39 | 39 | 39 | 39 |
| Entries fired per PR, median | 3 | 2.5 | 3 | **2** |
| Entries fired per PR, max | 13 | 10 | 15 | **14** |
| Threshold (iii) median <= 5 / max <= 12 | median PASS, max FAIL | median PASS, max PASS | median PASS, max FAIL | **median PASS, max FAIL** |
| Entries that never fired in the window | 9 | 12 | 19 | 22 |

Distribution of entries fired per PR (sorted): v2 pilot 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 4, 4, 5, 6, 6, 7, 7, 7, 9, 9, 10, 10; v2 held-out 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 3, 4, 4, 5, 7, 9, 10, 10, 11, 14.

**Why the held-out max is 14.** The worst held-out PRs are skills-touching feature PRs: #400 fires 14, and the next three fire 10-11. About nine entries are triggered by the same `skills/*/SKILL.md` / `skills/**` edit (`skill-frontmatter-description-budget`, `skill-frontmatter-indented-key-inert`, `skill-markdown-size-ratchet`, `skill-reference-summary-byte-match`, `synced-skill-content-reachable-refs`, `worktree-documented-command-reachable`, `generated-skills-copy-never-hand-edited`, plus `cli-help-is-a-pure-read` and `generated-artifact-plans-index` on the same PRs). That is a trigger-design finding (one contract per frontmatter rule means one entry per rule), not a threshold quirk: merging the skill-surface entries into one, or scoping the frontmatter pair by pattern on frontmatter lines, would cut it, but doing so now would be tuning on the held-out set.

### (i) Recall

| Check | Result |
|---|---|
| In-window incident entries that fired on their incident PR | 1 of 1 (`cli-help-is-a-pure-read` on #436, `19e21e74`), n = 1 |
| Incident replay, outside the window (supplementary, not a threshold): the commit that earned each entry fires it | 13 of 13 commits across 11 entries |

Incident replay rows: `cli-entry-guard-is-isinvokedasscript` @ `82b63557` fired (path+pattern); `disposable-db-allowlist` @ `0e7c63be` fired (path+symbol); `canonicalize-eol-before-hashing` @ `97988499` fired (path+symbol+pattern); `anthropic-pin-unserviceable-param` @ `3dabb3f3` fired (path+symbol); `provider-route-not-env-var` @ `3dabb3f3` fired (symbol+pattern); `jsonb-write-seam` @ `48611728` fired (path+symbol); `durable-write-registration` @ `72e0a0ef` fired (path+symbol); `durable-write-registration` @ `1019d519` fired (path+symbol); `exit-after-stdout-must-drain` @ `9c104381` fired (path+pattern); `prompt-seed-and-mechanical-wave` @ `6dedaca0` fired (symbol); `tiered-shadow-window-epoch-gated` @ `a584540c` fired (symbol); `domain-retag-both-directions` @ `d5e66d35` fired (path); `domain-retag-both-directions` @ `a146bb7b` fired (path).

### (ii) Controls

39 of 39 entries: the control fires it and the declared negative path stays silent (`tests/checklist-controls.test.mjs`, and `--controls` above). Controls for 7 entries use a real line (six from the incident commit named in the entry's `incident`, one a real call-site line); the other 32 are synthetic. The instrument is seen to fail: the test includes a broken control and a match-everything trigger, and the first run of the negatives caught two entries whose negative path sat inside their own trigger.

### Missed triggers

- **Incidents in the window whose entry did NOT fire: none** (the one in-window incident fired).
- **In-window fix PRs no entry claims.** Most `fix(...)` PRs in the pilot window (store reachability, arch-memory readers, model-eval corpus checks, fleet train ids) are not incidents recorded in AGENTS.md, so no entry could claim them; they are out of scope for recall by construction and say nothing about the entries.
- **Entries that never fired in the pilot window (v2):** `db-suite-two-edit-enrolment`, `synced-markdown-relative-links`, `emit-softfail-opt-out`, `gitignore-rule-declares-why`, `mcp-config-mirrored`, `generated-artifact-requirements-map`, `windowed-view-declares-its-window`, `cli-entry-guard-is-isinvokedasscript`, `jsonb-write-seam`, `provider-route-not-env-var`, `npm-run-flag-swallowed`, `learning-repo-name-is-owner-slash-repo`. Not a defect by itself (their paths are rarely edited), but a never-fired entry has only its control as evidence.
- **Known blind spots**: pattern-only entries (`npm-run-flag-swallowed`, `learning-repo-name-is-owner-slash-repo`) cannot fire at the pre-edit `--files` step, only at `--diff`; `bundle-deps` does not fire on a new import in an arbitrary file.

### Kernel size

| | chars |
|---|---|
| AGENTS.md today | 73364 (217 units: blank-line blocks split at list items and table rows) |
| Units hosting a moved sentence or migrated tripwire | 27 (all 39 entries anchored; unanchored: 0) |
| Removed if only the moved sentences leave (lower bound) | 12253 |
| Removed if the whole hosting units leave (upper bound) | 23991 |
| **Kernel remaining** | **49373 to 61111** |
| Target | 10,000 to 15,000 |

**Over target by roughly 34K to 46K chars.** This pilot's inventory covers 27 of 217 units. The remainder is cross-cutting doctrine (kernel by definition), or description that the plan routes to `enforced:` / `relocated:` dispositions in Cluster F's full-paragraph inventory. Per the plan, if the kernel exceeds 15K the shrink stops and reports rather than forcing triggers onto doctrine; this is that report.

### PASS / FAIL against the plan's thresholds

| Threshold | Verdict | Evidence |
|---|---|---|
| (i) every in-window incident entry fires on its PR | **PASS** (thin, n = 1) | 1/1; supplementary incident replay 13/13 |
| (ii) every control fires, every negative silent | **PASS** | 39/39 |
| (iii) median <= 5, max <= 12: v2 pilot window | PASS (tuned on it, not evidence) | median 2.5, max 10 |
| (iii) median <= 5, max <= 12: **held-out confirmation** | **FAIL on max** (median passes) | median 2, max 14 |
| Kernel <= 15K (plan target, not a pilot threshold) | **FAIL** | 49373 to 61111 chars remain |

**Overall: FAIL. Per plan section 2.5 ("Fail any, Cluster F does not run; the report says which") Cluster F does not run on this evidence.** What would change the answer is a human decision, not a rerun: either accept a revised noise rule, or redesign the skill-surface entries (merge, or pattern-scope) and re-measure on a fresh window that nobody has tuned on. Nothing was shrunk.


## Redesign (v3): skills-surface entries, and the new "individual checks" metric

The v2 held-out failure (max 14) was eight to nine entries firing on the same `skills/**` edit. The redesign follows the rule set after the brainstorm: **merge only entries that are truly redundant (same check, same trigger); narrow triggers where the diff can actually distinguish them; count individual checks so grouping cannot fake a pass.** The noise rule is unchanged (median <= 5, max <= 12), and v3 was NOT tuned against a threshold.

- **Merged: none.** No two entries are the same check with the same trigger: each of the 26 migrated entries is bound one-to-one to a gate contract, and the two frontmatter entries ask different questions (description budget and a silent bad `name`, versus an indented key that is inert). Entry count stays **39**.
- **Narrowed (5 entries, path trigger replaced by a pattern the diff can distinguish):** `skill-frontmatter-description-budget` (now fires on a changed `name:` or `description:` line), `skill-frontmatter-indented-key-inert` (an indented optional-key line), `synced-skill-content-reachable-refs` (an added `npm run` alias or a docs markdown path in skill markdown), `worktree-documented-command-reachable` (a line naming `scripts/.claude-skills/` in skill markdown), `skill-reference-summary-byte-match` (a changed `summary:` line or reference-index row; the shared-references path trigger is kept). **Cost, stated plainly:** these five no longer fire at the pre-edit `--files` step by path, only at `--diff`.
- **New metric, "individual checks a reviewer must perform" per PR (`checkCount`).** Each fired entry contributes its `checks` value (an optional entry field, default 1); an entry that merges k distinct checks MUST declare `checks: k`, so merging can never lower the figure. It is reported beside "entries fired", and the same rule (median <= 5, max <= 12) is read against it. Because nothing was merged, `checkCount` equals entries fired in v3; the metric is wired so a later merge cannot lower it.

**Seen data, NOT a confirmation. No threshold claim is made from these rows.** v3 was designed after both windows were examined, so its numbers on them are descriptive only:

| Entries fired / checks per PR, median / max | v2 | v3 (seen data) |
|---|---|---|
| Pilot window #410-#442 | 2.5 / 10 | 2.5 / 9 (checks 2.5 / 9) |
| Held-out window #380-#409 | 2 / 14 | 2 / 10 (checks 2 / 10) |

v3 on the old data also keeps: controls 39/39, the supplementary incident replay 13/13, the in-window incident on #436 firing, and kernel remaining 49373 to 61111 chars. The first run that counts is the confirmation below.

## Freeze

The instrument is frozen at this commit. Anything that decides a figure is pinned by sha256 (CRLF folded to LF) in `scripts/lib/checklist/frozen.mjs`; `npm run checklist:pilot -- --verify-frozen` reports any difference and `--replay --confirmation` refuses to run unless there is none (`tests/checklist-frozen.test.mjs`).

| Part | File | sha256 |
|---|---|---|
| Checklist | `.audit-loop/checklist.json` | `8a6555dd12b06cfd53724fcd7c0e6cae6994be461b67f6a14691b0ecf1aea36d` |
| Matcher | `scripts/lib/checklist/match.mjs` | `1cb66a51aa50c5eaffe26807a855090beda4ca2ffab852fa192db078c2770b28` |
| Scoring code | `scripts/lib/checklist/pilot.mjs` | `42880cd8725c485ab8c050a9cdf6de751046367c4c552f8923b9076286cbbb35` |

**Instrument change recorded before the re-test (round-2 audit fixes, same day):** the matcher (`match.mjs`) and the scoring code (`pilot.mjs`) changed after the first freeze; the checklist did not. Matcher: rename paths decoded like headers, code-point-safe path decoding, a hunk that disagrees with its `@@` counts is refused, containment by path segment. Scoring: relative `outDir` resolved against the repo, `--confirmation` verifies the checklist it was given. Frozen hashes before and after: checklist unchanged (`8a6555dd12b0`), matcher `7b58d81d5507` to `1cb66a51aa50`, scoring `4f3b957b1e60` to `42880cd8725c`. No confirmation window had been run, so nothing was invalidated.

**Confirmation (a later task, not run here):** replay the PRs merged AFTER the freeze lands on main, with `--confirmation`, and judge median <= 5 and max <= 12 on both entries fired and checks per PR. Editing any of the three ends the freeze: update the constants and this table together and start a new confirmation window after the new freeze.

## Audit-found trigger gaps, deferred to the redesign

Round-1 audit findings about trigger COVERAGE. They are deferred on purpose: changing triggers on seen data would make the pilot numbers stale and would be tuning on the held-out set. They are inputs to the next redesign, not defects of the tooling.

- M1, M16: `anthropic-pin-unserviceable-param` matches `tool_choice` but not `system` / `tools` in a client call.
- M4, M17: `npm-run-flag-swallowed` scopes to `.md`, `.json`, `.yml`; it omits `.yaml`, `.mjs`, `.js`, `.sh`.
- M6: `learning-repo-name-is-owner-slash-repo` misses an assignment followed by a trailing comment.
- M7: several controls match the oracle (a helper name, a path) rather than reproducing the incident they cite.
- M8: `provider-route-not-env-var` matches the negated key check but not a positive `ANTHROPIC_API_KEY` read.
- M18: `generated-skills-copy-never-hand-edited` covers `.claude/skills/**` but not `scripts/.claude-skills/**`.
- M19: the generator embeds trigger symbols, patterns and control examples in `gen.mjs`, so editing it fires many unrelated entries.
- M20: `generated-artifact-bundle-deps` names the artifact, generator and entry lists, not a new import elsewhere in the bundle.

Dismissed: H1 (`round-signals.mjs` belongs to Cluster D, not yet on main) and M21-M26 (adjacency-enumeration notices).

## Decision

**2026-11-22, the coordinator under Louis's delegation, after a /brainstorm with GPT and Gemini and a debate round.**

1. **No shrink; Cluster F does not run.** The plan's rule stands: a failed threshold stops the shrink.
2. **The noise rule is unchanged (median <= 5, max <= 12), with no post-hoc revision.** The skills-surface entries are redesigned (merge only true redundancy, narrow distinguishable triggers, count individual checks), the instrument is frozen, and the re-test runs on PRs merged after the freeze, as a later task.
3. **Ship observe-only.** Fire-logging is ON; prompt injection is OFF by default (`AUDIT_CHECKLIST_INJECT=1` opts in); AGENTS.md is untouched. **End date: 2026-12-06 or 150 merged PRs, whichever comes first.** At the end date the fire log is reviewed and the checklist is kept, redesigned or retired.
4. **The kernel target stays 10-15K for now.** The shrink becomes a separate plan for Louis: a full 217-unit inventory with four dispositions (`kernel`, `checklist`, `enforced`, `relocated`), and a check that each `enforced:` gate really fails on the mistake before its AGENTS.md text becomes a pointer.

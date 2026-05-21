# Project Status Log

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

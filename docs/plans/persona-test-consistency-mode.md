# Plan: Persona-Test Consistency Mode + UX-Lock Capture Library

- **Date**: 2026-05-20
- **Status**: Audited (4 GPT rounds + 6 Gemini rounds; 51 findings total — all addressed inline; coherence rated "Strong" from Gemini round 3 onwards; iteration stopped at diminishing-returns asymptote; residual debt captured in §11b)
- **Author**: Claude + Louis
- **Scope**: full-stack
- **Target domain(s)**: `scripts`, `shared-lib`, `skills-content`
- ⚠ **Cross-domain work** — touches >1 domain; the contract layer (Phase 0) spans `shared-lib` (schemas) + `scripts` (CLIs) + `skills-content` (SKILL.md flow). All three move together.

> **Neighbourhood considered**: no high-similarity matches (top score 0.68 = `cmdRecordPersonaSession`, recommendation `review`). The capture library, surfaces.json schema, and canary runner have no prior art in this repo — proceed greenfield. Existing cross-skill writers (`cmdRecordRegressionSpec`, `cmdRecordCorrelation`, `recordPersonaSession`) are the integration points we reuse, not extend.

> **Past incidents to verify against**: none. `get-incident-neighbourhood` returned zero records for DOM-scraping / network-capture / fixture-replay paths.

---

## 1. Context Summary

**Detected scope + stack**: full-stack, `js-ts` (no Python). The skill code lives in this repo; the contract attributes get applied per-consumer (wine-cellar-app, ai-organiser are the first two adopters).

**What exists today**:
- `/persona-test` ([skills/persona-test/SKILL.md](../../skills/persona-test/SKILL.md)) — LLM-driven Plan→Act→Reflect loop. Drives Playwright MCP directly. Writes findings to `persona_test_sessions` + correlations to `persona_audit_correlations`. **No backing script library.**
- `/ux-lock` ([skills/ux-lock/SKILL.md](../../skills/ux-lock/SKILL.md)) — LLM-driven Playwright-spec generator. Two modes: LOCK (post-fix DOM-contract pin) and VERIFY (Section 9 plan grading). Writes specs as files + rows to `regression_specs`. **No backing capture library** — the LLM picks selectors and writes spec text directly.
- Cross-skill bridge: [scripts/cross-skill.mjs](../../scripts/cross-skill.mjs) — facade for all Supabase writes. Already has `record-regression-spec` (line 180), `record-correlation` (line 219), `record-persona-session` (line ~390).
- `regression_specs` table — has `source_kind` CHECK constraint (extensible; migration `20260419130000_plan_verify.sql` already extended it once).

**Patterns reused vs new**:
- **Reuse**: Zod schemas at boundaries (per AGENTS.md "schema validation at boundaries"); cross-skill.mjs as the only Supabase writer; per-session JSON artefact pattern (mirrors audit-loop adjudication ledger); `source_kind` constraint extension for table-shape changes.
- **New**: `data-engine-claim` / `data-engine-value` / `data-freshness` HTML attribute contract; surfaces manifest; canaries JSON; capture library; consistency contradiction grammar.

**Known user-visible issues (from persona testing)**: none specific to this scope. `get-persona-sessions-by-repo` not queried (no relevant prior journeys).

---

## 2. Proposed Architecture

### 2.0 Execution-model ownership (resolves R1-H1)

**Consistency mode runs on code-owned Playwright, not Playwright MCP.** The
existing `/persona-test` exploratory mode keeps using MCP — that flow is
LLM-driven step-by-step and benefits from the MCP turn-taking model.
Consistency mode is different: the capture library must run on the *exact*
page object the journey just mutated, and the only way to guarantee that
without a custom MCP bridge is for the runner to own the Playwright
session directly.

**Mode split**:

| Mode | Browser driver | LLM role | Capture timing |
|---|---|---|---|
| **exploratory** (existing) | Playwright MCP via Claude Code tool calls | Drives every Plan→Act→Reflect cycle directly | n/a (no synchronous capture) |
| **consistency** (new) | `playwright` npm package via `scripts/persona-consistency-run.mjs` | Authors `journeySteps[]` in the canary file (one-shot, ahead of run); the runner executes them deterministically | Synchronous between each Act and the next Action — code-owned, no prompt discipline required |

The LLM authors the journey **before** the runner executes it (declared in
`canaries/<name>.json` per Phase 0). During the run the LLM has no
real-time role; the runner is fully deterministic. This is what makes
idempotency replay (Phase 5) work — the LLM's non-determinism is moved
out of the execution path entirely.

**Implication for ad-hoc test authoring**: a new flow lets the LLM
*generate* a candidate canary from a `/persona-test` exploratory session
("save this journey as a canary"). Existing exploratory mode is the
authoring tool; consistency mode is the execution + assertion engine.
That flow lands as a follow-on PR; v1 ships with manual canary authoring.

```mermaid
graph TD
  subgraph Consumer["Consumer App (wine-cellar-app, ai-organiser, ...)"]
    DOM["DOM with data-engine-claim<br/>data-engine-value<br/>data-freshness<br/>data-engine-scope (lists)"]
    NET["Network responses<br/>(engine endpoints)"]
    MAN["surfaces.json<br/>(resolution: .persona-test/ → root → src/)"]
    CAN[".persona-test/canaries/*.json"]
  end

  subgraph Runner["persona-consistency-run.mjs (code-owned)"]
    PW["playwright npm package<br/>owns the page object"]
    STEPS["execute canary.journeySteps[] deterministically"]
    CAP["scripts/lib/ux-lock/capture.mjs<br/>captureWitness(page, surfaces) — sync wrt page"]
    CONS["scripts/lib/persona-test/consistency.mjs<br/>diffClaims(dom, net)"]
    SEMA["scripts/lib/persona-test/semantic-compare.mjs<br/>LLM prose-vs-prose (gated by llmSafe)"]
    LED["scripts/lib/persona-test/ledger.mjs<br/>per-session JSON (always persisted)"]
    CANRUN["scripts/lib/persona-test/canary.mjs<br/>load + verify expectations"]
  end

  subgraph CrossSkill["cross-skill.mjs (single writer)"]
    RS["record-regression-spec<br/>source_kind=persona-consistency-candidate"]
    PS["record-persona-session"]
    PC["record-correlation"]
  end

  subgraph Ship["/ship"]
    PROMOTE["Promote candidates → source_kind=persona-consistency-locked"]
    GATE["Canary health gate (abort on rig-broken)"]
  end

  CAN --> STEPS
  MAN --> STEPS
  STEPS --> PW
  PW -->|each step| CAP
  CAP -->|read DOM attrs + data-engine-scope| DOM
  CAP -->|step-windowed network capture, latest 2xx JSON match wins| NET
  CAP --> CONS
  MAN --> CONS
  CONS -->|prose fields with llmSafe=true only| SEMA
  CONS --> LED
  SEMA --> LED
  CONS -->|contradiction → emit candidate (fingerprint-upsert)| RS
  STEPS --> CANRUN
  CANRUN -->|verify expected min/max| LED
  LED -->|session end OR canary-broken OR fatal| PS
  LED -->|P0/P1| PC
  RS --> PROMOTE
  LED --> GATE
```

### Key design decisions (with principle citations)

| Decision | Why | Principles |
|---|---|---|
| Network response = ground truth; DOM = claim harness via `data-engine-claim` attrs | No text-parsing. One contract for both layers. Portable across apps. | #1 DRY, #5 Single Source of Truth, #20 Long-Term Flexibility |
| Exact match for typed (counts, booleans, enums, IDs, freshness); semantic only between same-layer prose | Cheap deterministic verdicts where they matter; LLM-judge only where prose is unavoidable | #11 Testability, #16 Graceful Degradation |
| Per-session JSON ledger now; defer cross-skill contradiction table | Schema-without-data is wrong-schema | #20 Flexibility, #12 Validation (only at known boundaries) |
| Capture library `scripts/lib/ux-lock/capture.mjs` called synchronously inside Reflect | DOM evidence is perishable — post-hoc lookup is broken-by-design (the Post-Hoc Execution Fallacy) | #11 Testability, #14 Transaction Safety (capture is part of the step's atomic unit) |
| `regression_specs` rows tagged `source_kind='persona-consistency-candidate'` until `/ship` promotes them to `'persona-consistency-locked'`; **upserted by `candidateFingerprint = sha256(repoId + journeyKey + surfaceId + engineField + contradictionKind + normalisedLocator)`** — journeyKey included (resolves Gemini-R6-G2) so the same contradiction surface reached by a different journey produces a distinct candidate; without this, locking via Canary A would suppress legitimate findings from Canary B that exercises the same surface via a different navigation path with a PARTIAL unique index `WHERE source_kind='persona-consistency-candidate'` so reruns don't multiply rows AND locked specs don't block reborn candidates (resolves R1-M2 + R2-H5). **Re-emit suppression rule** (resolves R2-H5): before INSERTing a candidate, the writer queries `regression_specs` for any row with the same `candidate_fingerprint` AND `source_kind='persona-consistency-locked'`; if found, candidate-emission is skipped and a `suppressedByLockedSpec: <specId>` entry is added to the contradiction record in the ledger. This preserves the locked-spec lifecycle while letting the same contradiction re-surface in the ledger for observability. | Two artifact classes (evidence vs lock) without a new table; fingerprint + partial-index keeps the candidate queue bounded without blocking the locked-spec lifecycle | #13 Idempotency, #20 Flexibility, #18 Backward Compat |
| Severity rubric lives per-surface in `surfaces.json`, not in skill code | Each consumer tunes its own signal-to-noise; skill stays generic | #1 DRY, #4 No Hardcoding, #20 Flexibility |
| Surfaces manifest resolved in priority order, not hard-coded path | Different consumer-app layouts can adopt without code changes | #4 No Hardcoding, #20 Flexibility |

### Open question — **resolved**: where does `surfaces.json` live?

**Decision**: resolver-order, not single path. The skill resolves the first match:

1. `<repo-root>/.persona-test/surfaces.json` — colocated with canaries; explicit test config
2. `<repo-root>/persona-test-manifest.json` — alongside `package.json`; for repos that prefer surface authorship at root
3. `<src-root>/persona-test-surfaces.json` — for monorepo `src/` layouts

Lean (1) for new adopters. (2)/(3) exist so consumer-app frontend owners can author the manifest *next to* the code they're describing, without forcing a `.persona-test/` directory.

If none match, the skill exits with a clear bootstrap message (not a crash). Auto-generation from `data-engine-claim` scans is **deferred** — manual authorship gates the severity rubric, which can't be derived.

---

## 3. UX Design Decisions

The "UX" here is the rig's surface to the engineer running the test. UX principles cited (numbers from `references/ux-principles.md`):

| Choice | Principle |
|---|---|
| Contradiction findings render the **exact DOM selector + the exact engine field** that disagree — no inferred prose. | #3 Clarity over cleverness, #16 Recognition over recall (the engineer sees the locator, doesn't reconstruct it) |
| Canary-broken aborts the pipeline with one-line "Rig broken: canary `<name>` expected ≥`<min>` contradictions, found 0. Manifest/attributes drifted." | #8 Error prevention, #19 Status visibility |
| Candidate promotion prompt at `/ship` shows the 3 sample claims/CTAs from each candidate — not "approve 3 candidates? [y/N]". | #16 Recognition over recall, #2 Aesthetic & minimal design |
| Freshness violations show `data-freshness="stale"` literal in the finding so the engineer sees the contract was used as designed. | #19 Status visibility, #20 Help users recognise errors |

---

## 4. Technical Architecture

### File layout

```
skills/persona-test/
├── SKILL.md                                    # Add Phase 3b (consistency mode)
└── references/
    └── consistency-mode.md                     # NEW — full grammar + manifest + canary docs
skills/ux-lock/
├── SKILL.md                                    # Add note: capture library now backs both skills
└── references/
    └── candidate-promotion.md                  # NEW — promotion rules + /ship integration

scripts/lib/
├── ux-lock/
│   └── capture.mjs                             # NEW — captureWitness(page, surfaces) → WitnessRecord
├── persona-test/
│   ├── consistency.mjs                         # NEW — diffClaims(dom, net, surface) → Contradiction[]
│   ├── ledger.mjs                              # NEW — atomic-write per-session JSON
│   ├── canary.mjs                              # NEW — loadCanary + verifyExpectations
│   ├── manifest-resolver.mjs                   # NEW — resolves surfaces.json by priority
│   └── schemas.mjs                             # NEW — Zod for surfaces, canaries, witness, contradiction
└── ux-lock/
    └── candidate-spec.mjs                      # NEW — render Playwright spec from WitnessRecord

scripts/
├── persona-consistency-run.mjs                 # NEW — thin CLI wrapper for the skill
└── persona-consistency-promote.mjs             # NEW — /ship's batch promoter

supabase/migrations/
└── 20260520120000_consistency_source_kinds.sql # NEW — extend regression_specs source_kind CHECK

tests/
├── consistency-schemas.test.mjs                # NEW — Zod parses good + rejects bad
├── consistency-grammar.test.mjs                # NEW — exact + semantic + cross-stream rules
├── manifest-resolver.test.mjs                  # NEW — priority order + missing-file behaviour
├── canary-runner.test.mjs                      # NEW — min/max/shape verification
├── capture-witness.test.mjs                    # NEW — DOM + network capture (Playwright fixture)
├── idempotency-replay.test.mjs                 # NEW — same seed → identical claim set
└── negative-space.test.mjs                     # NEW — undeclared engine claim → P0
```

### State management

Per-session ledger shape (Zod-validated on write):

```ts
type SessionLedger = {
  sessionId: string;              // SID from /persona-test Phase 6
  canaryName: string | null;
  journeyKey: string;
  fixtureSeed: string | null;
  startedAt: string;              // ISO
  steps: Array<{
    stepIndex: number;
    plan: string;                 // the persona's Plan sentence (echoed from canary; consistency mode does NOT regenerate per-run)
    actionLabel: string;          // human-readable Act description
    witness: WitnessRecord;       // DOM claims + matched network responses
    contradictions: Contradiction[];
    freshness: FreshnessFinding[];
    warnings: RigWarning[];       // non-contradiction observations: settle-timeouts, partial-capture, prose-truncated, etc. (resolves Gemini-R5-G3)
    durationMs: number;
  }>;
  candidateSpecIds: string[];     // regression_specs rows written this session
  // Terminal outcome fields — resolves R1-H6 + Gemini-G1
  rigVerdict: 'healthy' | 'broken' | 'partial' | 'fatal' | 'app-error';
                                  // healthy:   ran to completion AND canary expectations met
                                  // broken:    canary expectations violated (min/max/shape) — rig itself is suspect
                                  // partial:   at least one step had partialCapture or capture errors
                                  // fatal:     bad-input / manifest-missing / playwright-disconnect — RIG could not produce a diff
                                  // app-error: a journey ACT step threw (e.g. Playwright TimeoutError on click — element didn't exist) — APP regression, NOT a rig issue
  stepFailureReason: string | null;  // populated when rigVerdict='app-error'; carries the Playwright error class + locator that failed
  canaryVerdict: 'passed' | 'broken' | 'not-applicable';
                                  // SET ONLY when a canary was provided; 'not-applicable' for ad-hoc runs
  failureReason: string | null;   // populated when rigVerdict ≠ 'healthy'; one-line human-readable
  truncated: boolean;             // true when the journey aborted mid-step
  endedAt: string;
};
```

**Ledger persistence is MANDATORY for all terminal states** (resolves R1-H6). The state machine writes the ledger BEFORE exiting on the rig-broken and fatal paths — exit-2 / exit-3 codes are emitted only AFTER `closeLedger()` returns successfully. If ledger write itself fails (disk full, permission), the runner logs to stderr and exits 4 (`LEDGER_PERSIST_FAILED`), distinguishing "rig found a problem" (exit 2) from "rig couldn't record a problem" (exit 4). The corresponding integration test in Section 9 covers all four exit codes.

### Event handling

The runner (NOT the LLM) executes one journey step at a time. Between the step's action and the capture, the runner enforces a **step-settle condition** (resolves R4-H3) — being "sync wrt the page object" is necessary but not sufficient; we also need to be sync wrt the app's async work. Default settle rules per action (overridable via the action's explicit `postWait`):

| Action | Default settle |
|---|---|
| `navigate` | wait for the `waitUntil` event the step declared (default `load`) |
| `click` | `postWait` if specified, else a 250ms fixed tick (resolves Gemini-R3-G2 — `networkidle` is explicitly NOT used as a default because Playwright discourages it; SPAs with long-lived sockets / SSE / analytics polling never reach `networkidle`. Canary authors who need a network-settle declare it explicitly as `postWait:{kind:'network', urlPattern:..., timeoutMs:...}`.) |
| `fill` | wait for `blurAfter` change-event (Playwright dispatches synchronously) |
| `wait` | wait for the declared condition |
| `evaluate` | wait for the evaluate Promise to resolve |

Settle conditions live ONLY on `JourneyStepSchema.postWait` — NOT on `surfaces.json` (resolves Gemini-R2-G2). Controls (Save buttons, form submits) aren't surfaces — they have no `data-engine-claim` — so a per-surface settle wouldn't help when the click target is a non-surface and the rendered surfaces are on the next page. Canary authors declare network-settle expectations alongside the action that triggers them: `{action:'click', locator:..., postWait:{kind:'network', urlPattern:'/api/cellar', timeoutMs:5000}}`. The runner emits a P1 finding "settle condition timed out" (NOT a contradiction) if the timeout fires without the expected response, so timeouts are observable, not silent.

Capture happens AFTER settle AND AFTER a **DOM-stabilisation tick loop** (resolves Gemini-R6-G1 — React/Vue/Svelte state updates from network responses take microtasks before the DOM reflects). The runner polls `data-engine-claim` element count + a content-hash of the captured surfaces; capture proceeds only when two consecutive polls 50ms apart return identical results, OR after a 500ms hard cap (the stabilisation cap emits a P2 warning `dom-stabilisation-cap-reached`). Capture timing is code-enforced (sequential `await` in the runner), not prompt-enforced. There is no LLM in the consistency-mode execution loop — the LLM's only role is authoring the canary JSON ahead of time.

### CSS / responsive

N/A — this plan touches no consumer-app visual surfaces. The HTML attribute contract is purely behavioural.

---

## 5. State Map

The runner state machine (Phase 1.5 execution model):

```mermaid
stateDiagram-v2
  [*] --> OpenLedger: SID + journey key recorded immediately
  OpenLedger --> CheckPlaywright
  CheckPlaywright --> Fatal_PlaywrightMissing: import fails OR npx playwright probe fails (resolves R4-M1)
  CheckPlaywright --> ResolveManifest: playwright available
  ResolveManifest --> Fatal_NoManifest: no file found
  ResolveManifest --> LoadCanary: file resolved
  LoadCanary --> Fatal_BadInput: --canary <name> not in canaries/ OR schema invalid
  LoadCanary --> AttachNetworkListener
  AttachNetworkListener --> Fatal_PlaywrightDisconnect: connection failed
  AttachNetworkListener --> NavigateInitial
  NavigateInitial --> StepLoop
  StepLoop --> Plan: echo from canary.journeySteps[i]
  Plan --> Act
  Act --> StepFailed: action throws (Playwright TimeoutError / element-missing / nav failure) — resolves Gemini-G1
  Act --> Capture: sync, before next mutation
  StepFailed --> CloseLedgerAppError: persist ledger with rigVerdict='app-error', stepFailureReason set
  Capture --> Diff: dom-claims vs net-responses (per captureWindow)
  Diff --> EmitCandidate: contradiction.severity ≥ P1 AND has observable-surface AND NOT covered by canary.expectedContradictions.shapes (resolves Gemini-R3-G1 — broken-canary self-tests don't pollute the candidates table with their intended contradictions)
  EmitCandidate --> StepLoop: more steps
  Diff --> StepLoop: no candidate (or candidate-suppressed because contradiction was canary-expected)
  StepLoop --> CanaryVerify: journey complete
  CanaryVerify --> CloseLedgerBroken: expected min/max/shape violated
  CanaryVerify --> CloseLedgerHealthy: expectations met
  Fatal_PlaywrightMissing --> CloseLedgerFatal
  Fatal_NoManifest --> CloseLedgerFatal
  Fatal_BadInput --> CloseLedgerFatal
  Fatal_PlaywrightDisconnect --> CloseLedgerFatal
  CloseLedgerHealthy --> SaveSession: rigVerdict=healthy/partial
  CloseLedgerBroken --> SaveSession: rigVerdict=broken; failureReason set
  CloseLedgerFatal --> SaveSession: rigVerdict=fatal; failureReason set ('playwright-missing' / 'manifest-missing' / 'bad-input' / 'playwright-disconnect')
  CloseLedgerAppError --> SaveSession: rigVerdict=app-error; stepFailureReason set
  SaveSession --> Exit
  Exit --> [*]: 0=healthy, 2=canary-broken, 3=fatal-rig, 4=ledger-persist-failed, 5=playwright-missing, 6=app-error (action threw — bug is in the app, not the rig; distinct from fatal-rig)
```

Component states (per consistency-mode component):

| Component | Empty | Loading | Error | Success | Edge case |
|---|---|---|---|---|---|
| Manifest resolver | "No surfaces.json found in any of: …" | n/a (sync) | Zod validation error → exit BAD_INPUT | resolved path + parsed schema | symlink → resolve real path, refuse if outside repo |
| Capture library | no surfaces declared → empty WitnessRecord | n/a | Playwright disconnect → capture marked `partial:true` | full WitnessRecord | data-engine-claim attribute without matching net response → marked `unmatched` |
| Consistency diff | no surfaces matched in DOM → zero contradictions | n/a | type mismatch (string vs bool in same field) → schema error | Contradiction[] | semantic-match attempted on typed field → throws `CROSS_STREAM_VIOLATION` |
| Canary runner | no canary → `canaryVerdict='not-applicable'` verdict still recorded | runner executing journey deterministically (per-step durationMs tracked) | canary file malformed → exit 3 with `rigVerdict='fatal'`, `failureReason='canary-schema-invalid'`, `steps:[]` ledger persisted | min/max/shape satisfied → `rigVerdict='healthy'` | shape spec given but order differs → still pass (set comparison, not list) |
| Ledger | always opened immediately after SID assignment; zero-step ledgers ARE persisted with explicit terminal fields (resolves R2-H2) | per-step atomic write via `file-io.mjs` atomicWrite pattern | disk full → stderr + retry once, then exit 4 (`LEDGER_PERSIST_FAILED`); no other exit code emitted | full session JSON written before any non-zero exit | session aborted mid-journey → ledger committed with `truncated:true` and `rigVerdict` set per cause |

---

## 6. Sustainability Notes

**Assumptions that could change**:
- Playwright MCP remains the browser driver. If we move to another tool, the capture library is the only file that wraps Playwright calls — the rest of the rig is tool-agnostic.
- `data-*` attributes are accessible from DOM in all consumer rendering paths. SSR-only fragments would need a different extractor — defer until a consumer needs it.
- `regression_specs.source_kind` constraint can grow. The migration in this plan adds two values; future plans (e.g. ai-organiser's incident-replay rig) can keep extending.

**How the design accommodates future change**:
- Severity in the manifest, not the skill → tightening signal/noise per-surface needs no code change.
- Contradiction grammar is data-driven (exact-fields list, semantic-prose list declared per-surface) → adding a new field type (e.g. `numeric-range`) is a manifest edit + one Zod variant, not a refactor.
- Phase 7 (cross-skill ledger table) is explicitly deferred — three real consumer adoptions (wine-cellar-app, ai-organiser, one more) will fit the schema; designing now would be wrong-schema.

**Extension points deliberately built in** (resolves R3-M2 — no global mutation):
- `scripts/lib/persona-test/manifest-resolver.mjs` exports a frozen `DEFAULT_RESOLVERS` constant; non-default layouts call `resolveManifest(repoRoot, [...customResolvers, ...DEFAULT_RESOLVERS])` with an explicit ordered list. No registry, no global mutation, no test contamination.
- `WitnessRecord` includes a `customClaims: Record<string, unknown>` field for surface-specific data the diff engine ignores but the consumer-app can read for its own reports.
- The capture library exports `captureWitness` *and* a lower-level `extractDomClaims` so ux-lock LOCK mode can call just the DOM half if it doesn't want a full network capture.

---

## 7. File-Level Plan

### Phase 0 — Contract Layer (load-bearing — DO NOT advance until done)

| File | Purpose | Key exports | Imports / Imported-by | Why this file (principle) |
|---|---|---|---|---|
| `scripts/lib/persona-test/schemas.mjs` | Single source of truth for all consistency Zod schemas. | `SurfaceManifestSchema`, `CanaryDefinitionSchema`, `WitnessRecordSchema`, `ContradictionSchema`, `SessionLedgerSchema`, `SemanticVerdictSchema` (resolves R2-M1 + Gemini-G4 — INNER schema only: `{matched: 'yes'\|'no'\|'uncertain', score?: number, reason?: string}`; `latencyMs`, `usage`, `costUsd` live in the OUTER `{result, usage, latencyMs}` envelope returned by the LLM wrapper, NOT inside the verdict — parse-failure fallback emits `{matched:'uncertain', reason:'provider-parse-failed'}`), `PersonaRunContextSchema` (resolves R2-H4 — `{repoId, personaId, journeyKey, deploymentId?, planId?, commitSha, branch}`), `ENGINE_CLAIM_FIELD_TYPES` (enum of typed-vs-prose) | imports `zod`; imported-by every consistency lib | #5 Single Source of Truth; schema-first prevents drift between files. |
| `scripts/lib/persona-test/context.mjs` **(NEW — resolves R2-H4)** | Resolve `PersonaRunContext` once at runner start; threaded through every cross-skill write so candidate-spec, persona-session, and correlation rows share a single identity. | `resolvePersonaRunContext(repoRoot, env, args): Promise<PersonaRunContext>` — derives `repoId` from `cross-skill.mjs resolve-repo-identity`; `personaId` from canary OR `$PERSONA_TEST_REPO_NAME` + matching record OR `null` (ad-hoc); `journeyKey` from `canary.name`; `commitSha`/`branch` from git; `planId` resolved when `--plan` flag passed; `deploymentId` from `--deployment-id` flag or null. Validates via `PersonaRunContextSchema`. | imported by `persona-consistency-run.mjs`, `persona-consistency-promote.mjs`, `cross-skill.mjs candidate write paths`. | #5 SSoT for run identity; #12 Validation at boundary. |
| `scripts/lib/redact.mjs` **(NEW — resolves R2-M2)** | Named shared redaction adapter. Wraps the existing secret patterns from `scripts/lib/quickfix-patterns.mjs` `SECRET_PATTERNS` into a clean exported API. | `redact(text: string): { redacted: string, count: number, patternsHit: string[] }`, `redactObject(obj: unknown, opts?: {depth?: number}): { redacted: unknown, count: number }` | imported by `semantic-compare.mjs` (pre-egress) AND `cross-skill.mjs` candidate-write path (pre-Supabase). | #1 DRY — one redactor across both boundaries; #18 reuses existing patterns. |
| `supabase/migrations/20260520120000_consistency_source_kinds.sql` | NEW migration file (existing applied migrations are immutable — resolves R2-H3). Contains: (a) extend `regression_specs.source_kind` CHECK to accept `'persona-consistency-candidate'` + `'persona-consistency-locked'`; (b) add nullable `candidate_fingerprint TEXT`, `witness_snapshot JSONB`, `contradiction_payload JSONB`, `journey_context JSONB` (resolves Gemini-R4-G1), `promoted_at TIMESTAMPTZ`, `promoted_by TEXT` columns; row-shape CHECK requires `journey_context NOT NULL` for both candidate and locked rows; (c) **partial** unique index `(repo_id, candidate_fingerprint) WHERE candidate_fingerprint IS NOT NULL AND source_kind = 'persona-consistency-candidate' AND repo_id IS NOT NULL` (resolves R2-H5 + Gemini-R5-G2 — Postgres considers `NULL` values distinct, so without the `repo_id IS NOT NULL` predicate ad-hoc runs without a resolved `repo_id` would silently allow duplicate candidate rows. The `cmdRecordRegressionSpec` validator additionally REFUSES candidate inserts where `repoId` is null, returning `BAD_INPUT 'consistency candidates require resolved repo identity'` — ad-hoc runs must resolve repo identity via `cmdResolveRepoIdentity` before emitting candidates); (d) **row-shape CHECK constraints** by source_kind (resolves R4-H2): `lock-mode`/`plan-frontend-verify` rows MUST have `spec_path NOT NULL` and SHOULD have `witness_snapshot NULL` (enforced as CHECK); `persona-consistency-candidate` rows MUST have `witness_snapshot NOT NULL` AND `contradiction_payload NOT NULL` AND `spec_path NULL` AND `promoted_at NULL`; `persona-consistency-locked` rows MUST have all five non-null. CHECK expression: `(source_kind IN ('lock-mode','plan-frontend-verify','manual')      AND witness_snapshot IS NULL AND contradiction_payload IS NULL AND spec_path IS NOT NULL) OR (source_kind = 'persona-consistency-candidate' AND witness_snapshot IS NOT NULL AND contradiction_payload IS NOT NULL AND spec_path IS NULL AND promoted_at IS NULL) OR (source_kind = 'persona-consistency-locked' AND witness_snapshot IS NOT NULL AND contradiction_payload IS NOT NULL AND spec_path IS NOT NULL AND promoted_at IS NOT NULL)`; (e) `CREATE OR REPLACE VIEW unlocked_fixes` excluding consistency candidates; (f) `CREATE OR REPLACE VIEW ship_gate_effectiveness` adding the new block reason. Reversible: down-migration drops constraints → index → columns → view recreates from prior definition (committed alongside as `..._down.sql` for ops use only; not auto-run). | (SQL DDL) | None | #18 Backward Compat — additive, applied migrations stay immutable; #12 Validation — DB enforces row-shape invariants. |
| `docs/consistency-contract.md` | The HTML attribute contract spec. Authoritative for consumer-app frontend devs. | (Documentation) | None | #1 DRY — one place to read the contract. |

#### Phase 0 — source_kind compatibility slice (resolves R1-M1)

Every place in the repo that consumes `regression_specs.source_kind` MUST be updated in the SAME PR as the migration. Audit of consumers:

| Consumer | File / location | Required change |
|---|---|---|
| Writer-side Zod enum | `scripts/learning-store.mjs` `recordRegressionSpec` source_kind whitelist | Add `'persona-consistency-candidate'`, `'persona-consistency-locked'` to permitted values; **AND make `specPath` conditional** (resolves Gemini-G2): require `specPath` when `sourceKind ∈ {'lock-mode','plan-frontend-verify','manual','persona-consistency-locked'}`, allow `specPath:null` (and require `witnessSnapshot`+`contradictionPayload`) when `sourceKind === 'persona-consistency-candidate'`. Mirrors the DB CHECK constraints. |
| CLI shim | `scripts/cross-skill.mjs` `cmdRecordRegressionSpec` validation | Same enum extension AND same conditional-specPath logic. Existing `if (!p.specPath || ...)` BAD_INPUT branch is REPLACED with a discriminated validator that varies by `sourceKind`. New required fields for candidates: `witnessSnapshot`, `contradictionPayload`, `candidateFingerprint`. |
| New read CLI | `scripts/cross-skill.mjs` `cmdListConsistencyCandidates` | NEW (resolves Gemini-R2-G3) — `list-consistency-candidates --repo-id <id> [--since <iso>]` SELECT from `regression_specs` WHERE `repo_id=$1 AND source_kind='persona-consistency-candidate' AND created_at>=$2`. Returns rows with `{specId, candidateFingerprint, surfaceId, engineField, contradictionKind, witnessSnapshot, contradictionPayload, createdAt}`. Used by `persona-consistency-promote.mjs` so all DB reads go through the bridge per architectural rule. |
| New CLI shim | `scripts/cross-skill.mjs` `cmdPromoteRegressionSpec` | NEW — atomic UPDATE setting `source_kind='persona-consistency-locked'` WHERE current is `'persona-consistency-candidate'` AND fingerprint matches |
| Spec-run recorder | `scripts/learning-store.mjs` `recordRegressionSpecRun` | No change — operates on spec_id, source-agnostic |
| `unlocked_fixes` view | re-created in the NEW migration via `CREATE OR REPLACE VIEW` — applied migration `20260419120000` is NOT touched | New view body adds `WHERE rs.source_kind NOT IN ('persona-consistency-candidate')` so candidates don't inflate the "needs lock" metric |
| `regression_saves` view | not re-created | No change — counts pass/fail runs regardless of source |
| `ship_gate_effectiveness` view | re-created in the NEW migration via `CREATE OR REPLACE VIEW` | New view body adds block_reason group `'persona-consistency-candidate-pending'` so candidate-prompt declines show in metrics |
| Dashboard | `dashboard/index.html` + `scripts/lib/dashboard/collect-*.mjs` | New "Consistency candidates" tile showing pending candidates by repo; "Locked specs" tile excludes candidate rows |
| Tests | `tests/cross-skill.test.mjs` (new file) | Cover round-trip: record candidate → promote → verify source_kind transition + fingerprint uniqueness |
| `/ship` SKILL.md | `skills/ship/SKILL.md` Step 5.6 (new) | Document the promotion prompt + the candidate-counter |

The migration file ships the SQL; the eight code/view changes ship in the SAME PR. Migration applied + readers updated = atomic boundary. No silent semantic drift.

### Phase 0 contract spec — the HTML attribute contract

Every state-rendering DOM element MUST carry these attributes when it asserts a claim about engine state:

| Attribute | Required | Value | Example |
|---|---|---|---|
| `data-engine-claim` | yes | dotted path of the engine field being projected; **for collection items use `[]` array notation** (NOT `[*]`) — the scope binding fills the index | `data-engine-claim="wines[].name"` |
| `data-engine-value` | yes | the projected value as a string; for booleans use `"true"`/`"false"`, for enums use the literal value | `data-engine-value="infeasible"` |
| `data-freshness` | yes | `current` / `stale` / `absent` — see freshness contract | `data-freshness="current"` |
| `data-engine-scope` | only if the claim is inside a collection | the collection's binding ID (matches a manifest `collectionBinding.id`); ancestor scope wins | `data-engine-scope="wines-grid"` |
| `data-engine-key` | only with `data-engine-scope` | the key value that identifies this item within the bound collection (used to match DOM element ↔ array entry) | `data-engine-key="wine-uuid-abc123"` |

**Scope semantics**: `data-engine-scope` declares "I am inside collection X". `data-engine-key` declares "I am the row keyed by Y within X". Together they let the rig match `<div data-engine-claim="wines[].name" data-engine-scope="wines-grid" data-engine-key="abc123">` to the network response entry where `wines[i].id === "abc123"`. The manifest's `collectionBinding` declares how to extract `id` from the response (Zod schema below). Nested scopes inherit through DOM ancestry — innermost wins.

**Freshness semantics**:
- `current` — value is from the most recent engine response known to this surface
- `stale` — value is older than the surface's staleness threshold (e.g. served from cache while a refetch is in flight)
- `absent` — surface knows no value (skeleton state, error state with no last-known)

**Stale-projection rule (resolves Gemini-R2-G4)**: `stale` + any visible claim emits a contradiction with `kind:'stale-projection'`. **Severity is taken from the surface's `severityFloor` in `surfaces.json`** — NOT a hardcoded P0 — so SWR / optimistic-update / background-sync patterns can be tuned per-surface (e.g. `severityFloor:'P2'` on a non-critical sync indicator vs `severityFloor:'P0'` on a status chip whose currency is contract-critical). To keep stale-projection observable when it's intentional, the contradiction still appears in the ledger with `kind:'stale-projection'` so engineers can audit even when severity is low.

### Phase 0 contract — surfaces.json schema (Zod)

```ts
// Discriminated union for locators — resolves R1-M3
const LocatorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('role'),   role: z.string(),  name: z.string().optional() }),
  z.object({ kind: z.literal('label'),  text: z.string() }),
  z.object({ kind: z.literal('testid'), id:   z.string() }),
  z.object({ kind: z.literal('css'),    selector: z.string(), warn: z.boolean().default(true) }),
]);

// Collection binding — resolves R1-H2
const CollectionBindingSchema = z.object({
  id: z.string(),                                          // referenced by DOM data-engine-scope
  urlPattern: z.string(),                                  // regex matching the endpoint
  jsonPath: z.string(),                                    // dotted path to the array in the response
  keyField: z.string(),                                    // field inside each array entry used as the row key (matched against DOM data-engine-key)
});

// Applicability metadata — resolves R1-M4
const SurfaceApplicabilitySchema = z.object({
  routePattern: z.string().optional(),                     // regex against page URL
  journeyStepLabels: z.array(z.string()).optional(),       // only evaluate during named steps
  requiresState: z.array(z.string()).optional(),           // surface only expected when these state tags are active
}).optional();

const SurfaceManifestSchema = z.object({
  $schema: z.string().optional(),
  version: z.literal(1),
  collections: z.array(CollectionBindingSchema).default([]),
  surfaces: z.array(z.object({
    id: z.string(),                                        // unique within manifest
    locator: LocatorSchema,                                // structured, not stringly-typed
    scope: z.string().optional(),                          // id of a CollectionBinding if this surface lives inside a list
    appliesTo: SurfaceApplicabilitySchema,                 // context gate for negative-space / freshness
    engineFields: z.array(z.object({
      field: z.string(),                                   // dotted path; supports `[]` for "current scope's array entry"
      type: z.enum([
        'boolean', 'enum', 'integer', 'count', 'id',
        'freshness', 'prose'
      ]),                                                  // determines exact vs semantic match
      semanticValues: z.array(z.string()).optional(),      // for 'enum'
      llmSafe: z.boolean().default(false),                 // resolves R1-H5: only llmSafe:true fields can be sent to semantic-compare
      llmMaxChars: z.number().int().min(1).max(20000).default(2000),  // resolves Gemini-R5-G1: max prose length before LLM call; payloads beyond cap are truncated AND flagged P2 'prose-truncated-for-llm' so the engineer knows comparison was lossy
      networkSource: z.object({                            // which endpoint(s) project this — resolves R3-H3
        urlPattern: z.string(),                            // regex against full URL
        method: z.enum(['GET','POST','PUT','PATCH','DELETE']).optional(),   // narrow by method (e.g. GraphQL is always POST /graphql)
        operationName: z.string().optional(),              // GraphQL operationName from body — when present, AND-matched with urlPattern
        requestMatchers: z.array(z.object({                // optional request-body or query-string disambiguators
          location: z.enum(['body-json','query-string']),
          jsonPath: z.string(),                            // dotted path for body-json; query-param name for query-string
          value: z.string(),                               // exact match
        })).optional(),
        jsonPath: z.string(),                              // dotted path into response (relative to collection entry when inside scope)
        captureWindow: z.enum(['step', 'step-end']).default('step-end'),
                                                           // step: any matching response during the step; step-end: only responses received AFTER the step's last action (catches click→refetch→update cases)
        winnerRule: z.enum(['latest', 'first']).default('latest'),
        excludeUrlPattern: z.string().optional(),          // regex; responses whose URL matches are filtered out before correlation (resolves Gemini-G3 — replaces the hallucinated page.route alias mechanism; runner correlates response URLs against this regex directly)
      }).optional(),                                       // omit for client-derived state (rare)
    })),
    severityFloor: z.enum(['P0', 'P1', 'P2', 'P3']),        // lowest severity a contradiction here can be
  })).min(1),
});
```

**Network capture (resolves R1-H3, R4-H1, Gemini-R1-G3, Gemini-R2-G1)**: per-surface `networkSource` declares the matching contract. The capture library attaches a `page.on('response')` handler at session start (passive observation — `page.route()` is request interception, wrong API) and maintains a **cumulative session-wide `NetworkGroundTruth` store** keyed by `(surfaceId, normalised request shape)`. Each matching response continuously updates its key — most-recent-wins by default. This handles SPA cache patterns (Apollo, React Query, SWR) where a navigation to a new tab renders from cache without firing a network request: the surface still has a ground-truth value because the store carries it from earlier in the session.

`captureWindow` becomes a PREFERENCE hint, not a hard filter:

- `step-end` (default) — the runner prefers responses received between the step's last action and the capture call; if none match, falls back to the most recent matching response in the session store.
- `step` — same, but the step-window is from step-start to capture; broader fallback.
- A `partialCapture: true` flag is set when the value comes from the cumulative store rather than the step window (so the engineer knows which surfaces are cache-derived).

Each captured response is correlated with its request via Playwright's `response.request()` for method / URL / `postDataJSON` body matching. To exclude mock-only or instrumentation traffic the runner filters by `excludeUrlPattern` (a regex matched against `response.url()`) — NOT by `page.route` aliases, which don't exist as a queryable concept in Playwright. On capture invocation, the runner reads the store keys matching the surface's `networkSource` contract:

1. Filter store entries: response with `status ∈ [200,299]` AND `Content-Type` JSON-parseable AND `jsonPath` resolves to a value.
2. Apply preference: prefer entries from the step window; fall back to the latest overall.
3. Apply `winnerRule` (`latest` by response receipt timestamp, default) for tie-break within the chosen window.
4. Store cap: 1024 keyed entries per session (configurable via `PERSONA_CONSISTENCY_BUFFER_CAP`). On overflow, oldest entries by-key are dropped and a `partialCapture: true` flag is set; the session-wide eviction policy is LRU per `(surfaceId, key)` tuple.

### Phase 0 contract — canaries/&lt;name&gt;.json schema (Zod)

Action-specific discriminated union (resolves R3-H2 — `action+target+payload` was too loose for a deterministic runner). Reuses `LocatorSchema` from the manifest contract.

```ts
const WaitConditionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('visible'),  locator: LocatorSchema, timeoutMs: z.number().int().positive().default(5000) }),
  z.object({ kind: z.literal('hidden'),   locator: LocatorSchema, timeoutMs: z.number().int().positive().default(5000) }),
  z.object({ kind: z.literal('url'),      urlPattern: z.string(), timeoutMs: z.number().int().positive().default(10000) }),
  z.object({ kind: z.literal('network'),  urlPattern: z.string(), method: z.enum(['GET','POST','PUT','PATCH','DELETE']).optional(), timeoutMs: z.number().int().positive().default(10000) }),
  z.object({ kind: z.literal('timeout'),  ms: z.number().int().positive().max(30000) }),
]);

const JourneyStepSchema = z.discriminatedUnion('action', [
  // XOR refine — resolves R4-M5: exactly one of url or routeKey
  z.object({
    action:  z.literal('navigate'),
    label:   z.string(),
    url:     z.string().optional(),
    routeKey: z.string().optional(),
    waitUntil: z.enum(['load','domcontentloaded','networkidle']).default('load'),
  }).refine(
    s => (!!s.url) !== (!!s.routeKey),
    { message: 'navigate requires EXACTLY ONE of url or routeKey, not both, not neither' }
  ),
  z.object({
    action:  z.literal('click'),
    label:   z.string(),
    locator: LocatorSchema,
    postWait: WaitConditionSchema.optional(),
  }),
  z.object({
    action:  z.literal('fill'),
    label:   z.string(),
    locator: LocatorSchema,
    value:   z.string(),
    blurAfter: z.boolean().default(true),
  }),
  z.object({
    action:  z.literal('wait'),
    label:   z.string(),
    condition: WaitConditionSchema,
  }),
  z.object({
    action:  z.literal('evaluate'),
    label:   z.string(),
    scriptId: z.string(),                   // resolved from canary.scripts map — NOT inline code (deterministic + auditable)
    args:    z.record(z.unknown()).optional(),
  }),
]);

const CanaryDefinitionSchema = z.object({
  $schema: z.string().optional(),
  name: z.string(),                                        // matches filename
  personaId: z.string(),                                   // ref to persona_dashboard.id, or "ad-hoc:<slug>"
  routes: z.record(z.string()).default({}),                // routeKey → path map (resolved against base URL)
  scripts: z.record(z.string()).default({}),               // scriptId → file path under .persona-test/scripts/
  // Discriminated by kind so each variant gates its required fields (resolves R4-M5)
  authBootstrap: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('none') }),
    z.object({ kind: z.literal('token'),        tokenEnv: z.string().min(1) }),
    z.object({ kind: z.literal('storageState'), storageStatePath: z.string().min(1) }),
  ]).default({ kind: 'none' }),
  journeySteps: z.array(JourneyStepSchema).min(1),
  fixtureSeed: z.string().nullable(),
  expectedContradictions: z.object({
    min: z.number().int().min(0).default(0),
    max: z.number().int().nullable().default(null),
    shapes: z.array(z.object({
      engineField: z.string(),
      surfaceId: z.string(),
    })).optional(),
  }),
});
```

`expectedContradictions.min > 0` ⇒ this is a **broken-canary canary**: rig-finds-zero = rig-broken. `min == 0 && max == 0` ⇒ clean reference journey: rig-finds-any = consumer regression.

### Phase 1 — Consistency mode in /persona-test

| File | Purpose | Key exports | Why |
|---|---|---|---|
| `scripts/lib/persona-test/manifest-resolver.mjs` | Resolve surfaces.json via priority order. **No global mutation** (resolves R2-M3) — resolver list is an immutable constant; consumers wanting a different order pass an ordered list to `resolveManifest()` directly. | `resolveManifest(repoRoot: string, resolvers?: Resolver[]): { path, manifest } | null` (resolvers default to `DEFAULT_RESOLVERS` constant), `DEFAULT_RESOLVERS: Resolver[]` (exported for inspection only — frozen) | #4 No Hardcoding — adopters choose layout via DI, not global mutation; #11 Testability — no order-dependent setup. |
| `scripts/lib/persona-test/consistency.mjs` | Diff DOM claims vs network ground truth. Apply contradiction grammar. **Pure** — never invokes LLM directly; routes prose to `semantic-compare.mjs`. **Type coercion contract** (resolves Gemini-R3-G3 + Gemini-R4-G2/G3): HTML `data-engine-value` and `data-engine-key` are always extracted as strings; before equality the diff coerces to the manifest's declared `type`:

- `'boolean'` → `'true'`/`'false'` map to `true`/`false`, anything else flagged P1 "value-coercion-error"
- `'integer'`/`'count'` → `parseInt(s, 10)` with `NaN` flagged P1
- `'enum'` → must be in `semanticValues` list
- `'id'`/`'prose'` → string compare
- **null ground-truth handling (Gemini-R4-G3)**: when the JSON ground-truth value is `null`, the DOM is REQUIRED to have `data-freshness="absent"` (any other freshness on a null-grounded surface emits a P1 "absent-not-rendered" contradiction). `data-engine-value` is ignored when freshness is `absent` (the value attribute carries no claim when the surface explicitly knows it has no value). If JSON is `null` AND `data-freshness="absent"` → no contradiction (correct).

**Key coercion (Gemini-R4-G2)**: `data-engine-key` undergoes the same coercion based on the `collectionBinding.keyField`'s actual JSON type (sampled from the first response that matches the urlPattern; cached for the session). If `keyField` resolves to an integer in JSON but DOM keys can't be parsed as integers, the runner emits P1 "key-coercion-error" per affected row instead of producing false negatives. Comparison happens AFTER coercion against the JSON ground-truth value (which arrives natively typed from the response). | `diffClaims(witness, manifest, semanticCompare): Contradiction[]`, `coerceDomValue(rawString, declaredType, semanticValues?): { ok, value?, error? }` | #11 Testability — pure function, deterministic; #12 Validation at boundary. |
| `scripts/lib/persona-test/semantic-compare.mjs` **(NEW — resolves R1-H4)** | LLM prose-vs-prose comparator. Only invoked for pairs where BOTH endpoints have `llmSafe:true`. **Returns the repo-standard `{result, usage, latencyMs}` envelope** (resolves R3-M1) where `result` is `SemanticVerdict = {matched:'yes'\|'no'\|'uncertain', score?:number, reason?:string}`. `costUsd` is derived in one shared place — `scripts/lib/llm-cost.mjs` (existing helper) — NOT computed in this module. Uses `scripts/lib/llm-wrappers.mjs` `callClaude`/`callGemini` to inherit existing retry, redaction, error classification. Model resolution goes through `scripts/lib/model-resolver.mjs` sentinels — set via `PERSONA_CONSISTENCY_SEMANTIC_MODEL` env (default sentinel `latest-haiku`). Cache: per-session JSON at `.persona-test/sessions/<SID>-semantic-cache.json` (per-session avoids the concurrent-write problem from R3-M3 — see below); on session close, a merge step folds the session cache into the shared `.persona-test/semantic-cache.json` via `proper-lockfile`-guarded read-modify-write. | `compare(textA, textB, opts): Promise<{result: SemanticVerdict, usage, latencyMs}>` | #4 No Hardcoding, #11 Testability, repo LLM call contract preserved. |
| `skills/persona-test/SKILL.md` | Add **Phase 3b — Consistency Mode** between current Phase 3 and Phase 4. Document `--mode consistency` and `--canary <name>` flags. | (Markdown) | #1 DRY — flag set lives where users discover it. |
| `skills/persona-test/references/consistency-mode.md` | Full grammar, manifest, canary docs (loaded on demand). | (Markdown) | Progressive disclosure (existing repo pattern). |

### Phase 2 — Capture Library Extraction

| File | Purpose | Key exports | Why |
|---|---|---|---|
| `scripts/lib/ux-lock/capture.mjs` | Sync DOM + matched-network capture against a Playwright page. | `captureWitness(page, manifest, options): Promise<WitnessRecord>`, `extractDomClaims(page, manifest)`, `attachNetworkListener(page, manifest): RemoveFn` | #11 Testability + the Post-Hoc Execution Fallacy. |
| `scripts/lib/ux-lock/candidate-spec.mjs` | Render a Playwright spec file from a WitnessRecord + contradiction + journey context. Three-section spec body: **(1) Setup** — emit `authBootstrap` (storage-state load or bearer-token env) + `routes` resolution; **(2) Navigate** — replay `journeyContext.journeySteps[]` translated to Playwright calls (`page.goto`, `locator.click`, etc.); **(3) Assert** — emit the contract assertion derived from the witness's matched DOM locator + the engineField that produced the contradiction (assert the expected value, fail on regression). Resolves Gemini-R4-G1. | `renderCandidateSpec(witness, contradiction, journeyContext): { filename, body }` | #13 Idempotency — same input = same spec text. |
| `skills/ux-lock/SKILL.md` | Add note: "Capture library now backs both /persona-test and /ux-lock LOCK mode. Manual invocation of /ux-lock still works." | (Markdown) | #18 Backward Compat. |

### Phase 3 — Per-Session JSON Ledger

| File | Purpose | Key exports | Why |
|---|---|---|---|
| `scripts/lib/persona-test/ledger.mjs` | Atomic per-step JSON writes to `.persona-test/sessions/<SID>.json`. | `openLedger(sessionId, journeyKey, canaryName)`, `appendStep(stepRecord)`, `closeLedger(verdict)` | #14 Transaction Safety — atomicWrite pattern from `file-io.mjs`. |
| `.gitignore` | Add blanket `.persona-test/sessions/`, `.persona-test/semantic-cache.json`, `.persona-test/semantic-egress.log` (resolves R2-L1). Keep `.persona-test/canaries/` and `.persona-test/surfaces.json` tracked. Plan documents retention policy in `docs/consistency-contract.md`: session JSONs older than 30 days are local-only artifacts and may be deleted at any time; semantic-cache.json is a derived cache and is safe to delete; semantic-egress.log is audit-only and rotates at 10MB. | n/a | (Operational) |
| **Concurrent-write safety for shared files (resolves R3-M3)** | Per-session ledgers + per-session semantic caches are isolated by SID, no locking needed. The two shared mutable artifacts (`.persona-test/semantic-cache.json` and `.persona-test/semantic-egress.log`) get explicit treatment: (a) `semantic-cache.json` is read-modify-write under a `proper-lockfile` mutex on `semantic-cache.json.lock`, AND uses the `atomicWriteFileSync` pattern from `scripts/lib/file-io.mjs` (temp+rename) so a crash mid-write leaves the old cache intact; (b) `semantic-egress.log` is append-only under the same lockfile, with 10MB rotation (rename to `.log.<timestamp>` then start fresh) guarded by the lock. New dep: `proper-lockfile` added to `package.json` (already used elsewhere in the ecosystem; no new licence concerns). | `scripts/lib/persona-test/shared-store.mjs` (NEW) — wraps both files behind `withCacheLock(fn)` / `appendEgress(record)` APIs. | #14 Transaction Safety; #11 Testability — locking is local to one module. |

### Phase 4 — Canary Mechanism + Pipeline Gate

| File | Purpose | Key exports | Why |
|---|---|---|---|
| `scripts/lib/persona-test/canary.mjs` | Load + parse + verify canary expectations. | `loadCanary(name, repoRoot): CanaryDefinition`, `verifyExpectations(canary, contradictions): { passed: boolean, reason: string }` | #11 Testability — pure verifier. |
| `scripts/persona-consistency-run.mjs` | Thin CLI wrapper invoked by the skill's Phase 3b. | `main()` parses `--canary`, `--journey`, `--url`, `--seed`; exits 2 on rig-broken. | #16 Graceful Degradation — exit code lets `/ship` gate without parsing logs. |

### Phase 5 — Negative-space, Freshness, Idempotency

| File | Purpose | Key exports | Why |
|---|---|---|---|
| `scripts/lib/persona-test/consistency.mjs` (extended) | Add: `detectNegativeSpace`, `detectFreshnessViolations`, `normaliseForReplay`. | (above) | #11 Testability — all pure. |

**Negative-space rule**: any DOM element matching `[data-engine-claim]` whose `data-engine-claim` value is NOT declared in `surfaces.json` ⇒ P0 finding "Undeclared engine claim: `<field>` at `<selector>`. Add to surfaces.json or remove from DOM." Bidirectional: any surface in manifest whose selector matches no element ⇒ P3 "Declared surface absent: `<id>`."

**Freshness rule**: `data-freshness="stale"` + element is visible (Playwright `isVisible()` true) ⇒ P0 finding regardless of `data-engine-value` accuracy.

**Idempotency replay**: `normaliseForReplay(ledger)` strips ALL nondeterministic operational telemetry (resolves R4-M3) — `startedAt`, `endedAt`, `durationMs`, per-step `durationMs`, AND from semantic verdicts `latencyMs`, `costUsd`, `usage.*`. The deterministic fields kept are: `result` (the SemanticVerdict's `matched`/`score`/`reason`), `contradictions[]`, `freshness[]`, `witness.domClaims[]` (sorted by `surfaceId + key`), `witness.networkClaims[]` (sorted by `surfaceId + field`). Two runs of the same canary + same `fixtureSeed` ⇒ deep-equal after normalisation. Cache-hit vs cache-miss for semantic verdicts is also stripped — same content in, same `result` out regardless of whether the LLM was actually called this run. Test asserts byte-equality.

### Phase 6 — /ship Integration

**Candidate artifact lifecycle (resolves R3-H1)**: the lifecycle is **DB-first, spec-on-promotion**. Candidates exist as `regression_specs` rows ONLY (no spec file on disk) until promoted. The witness snapshot is stored on the row as a JSON column. Promotion is the moment a real `.spec.js` file gets written. This avoids cluttering `tests/e2e/` with files for contradictions that may never be approved.

Concretely:

| Lifecycle stage | Filesystem artifact | DB state | Trigger |
|---|---|---|---|
| Captured (during run) | `.persona-test/sessions/<SID>.json` ledger entry (local-only) | `regression_specs` row inserted with `source_kind='persona-consistency-candidate'`, `candidate_fingerprint=<sha256>`, `spec_path=null`, NEW column `witness_snapshot JSONB` carries the WitnessRecord, NEW column `contradiction_payload JSONB` carries the Contradiction record, **NEW column `journey_context JSONB` carries the canary's `journeySteps[0..stepIndex]` slice + `authBootstrap` + `routes` map** (resolves Gemini-R4-G1 — the spec renderer needs the journey to reach the page state, not just the witness) | runner's diff emits a contradiction |
| Promoted (during /ship) | `tests/e2e/consistency-<surfaceId>-<short-fingerprint>.spec.js` written | Same row UPDATEd: `source_kind='persona-consistency-locked'`, `spec_path=<written path>`, `promoted_at=now()`, `promoted_by=<git user.email>` | user confirms at /ship prompt OR `--auto` flag |
| Demoted (rare — locked spec deleted) | spec file removed from disk | row DELETEd via cascade (current behaviour of `regression_specs` ON DELETE CASCADE chain) | manual `npm run consistency:demote --spec-id <id>` |

The migration adds `witness_snapshot JSONB` + `contradiction_payload JSONB` + `spec_path TEXT NULLABLE` + `promoted_at TIMESTAMPTZ NULLABLE` + `promoted_by TEXT NULLABLE` to `regression_specs`. All nullable on existing rows.

| File | Purpose | Key exports | Why |
|---|---|---|---|
| `scripts/persona-consistency-promote.mjs` | Batch-promote candidate `regression_specs` to locked. **Crash-tolerant two-phase pipeline** (resolves R4-M2): per candidate — (1) call `node scripts/cross-skill.mjs list-consistency-candidates --repo-id $REPO --since $SINCE` (NOT a direct DB call — resolves Gemini-R2-G3); (2) TTY prompt (or `--auto`); (3) for each approved: invoke `renderCandidateSpec(witnessSnapshot, contradictionPayload)` → `{filename, body}`; (4) **write journal entry** to `.persona-test/promotion-journal/<specId>.json` with `{specId, intendedPath, body, stage: 'pending'}` (atomic via temp+rename); (5) write spec to `tests/e2e/<filename>.tmp` (temp suffix); (6) `cross-skill.mjs promote-regression-spec` UPDATE in a single transaction recording `spec_path` → on success, journal entry advances to `stage: 'db-committed'`; (7) atomic-rename `tests/e2e/<filename>.tmp` → `tests/e2e/<filename>`; journal advances to `stage: 'finalised'`; (8) record `ship_event`; delete journal entry. **Recovery on next run**: `reconcilePromotionJournal()` runs at start — finds any `stage != 'finalised'` entries, queries DB for the row, either resumes (if DB committed) or rolls back (if not). Ensures filesystem and DB never diverge permanently. | `main()`, `promoteCandidate(candidateRow, opts): { ok, specPath?, error? }`, `reconcilePromotionJournal(repoRoot): Promise<{recovered, rolledBack}>` | #14 Transaction Safety with crash recovery; #19 Observability via ship_events. |
| `skills/ship/SKILL.md` | Add **Step 5.6 — Promote consistency candidates** between current Step 5.5 (Archive plans) and Step 6 (Tests). | (Markdown) | Discoverability — see what `/ship` does. |
| `scripts/cross-skill.mjs` | Add `promote-regression-spec` command. Takes `{specId, specPath, candidateFingerprint}`; atomically UPDATEs `source_kind='persona-consistency-locked'`, `spec_path=<path>`, `promoted_at=now()`, `promoted_by=<git user>`. Returns `{ok, rowsAffected}`. | `cmdPromoteRegressionSpec()` | #1 DRY — all Supabase writes through the bridge. |

### Phase 6.5 — Operational dependency + bootstrap (resolves R3-H4)

Consistency mode runs `playwright` directly (NOT through the existing Playwright MCP). The package isn't currently a dep of this repo OR of consumer repos — without this slice, the runner crashes on first invocation.

| File | Change |
|---|---|
| `package.json` | Add `playwright` to `dependencies` (NOT devDependencies — the runner is a shipped CLI, not a test-only tool). Pin to a minor version aligned with the Playwright MCP version range so consumer repos can share a single browser install. |
| `scripts/check-setup.mjs` | Add `checkPlaywrightAvailable()` probe using ESM dynamic import (resolves R4-M4 — repo is ESM-only, no `require()`): `try { await import('playwright'); } catch (e) { /* missing */ }` + spawn `npx playwright --version` via `execFile`. If browser binaries missing, suggest `npx playwright install chromium`. The same helper is imported by `persona-consistency-run.mjs` startup and `sync-to-repos.mjs` consumer bootstrap so all three setup paths share one resolution strategy. Surface in the existing setup-check report under a new "Consistency mode" section. |
| `scripts/sync-to-repos.mjs` | When syncing the consistency lib to consumer repos, ALSO add `playwright` to the consumer's `package.json` deps if absent. Idempotent. Document in the existing sync README. |
| `.github/workflows/test.yml` (if present in consumer repo) | Document that consistency-mode integration tests require `npx playwright install --with-deps chromium` in the CI setup step. Provide a snippet in `docs/consistency-contract.md`. |
| `docs/consistency-contract.md` | Add a "Setup" section: install command, browser binary location, CI tips. First thing a consumer-app dev sees when adopting. |
| `scripts/persona-consistency-run.mjs` | At runner start: call `checkPlaywrightAvailable()`. On miss, exit 5 (`PLAYWRIGHT_MISSING`) with a clear install hint. Distinguishes "rig is missing" (exit 5) from "rig found a problem" (exit 2) or "rig couldn't record" (exit 4). |

This phase is **load-bearing for v1 shipping** — landing the skill code without this slice means every adopter hits a cryptic `Cannot find module 'playwright'` error on first run.

### Phase 7 — DEFERRED (explicitly out of scope)

- Cross-skill contradiction-trends table (Supabase). Defer until 3 real consumer adoptions accumulate session data — schema must fit observed contradiction shapes, not hypothetical ones.
- Auto-generation of `surfaces.json` from `data-engine-claim` scans at build time. Defer until manual authorship pain shows up; severity rubric still requires human input.
- `/cycle` orchestration changes. The existing `/cycle persona-test → ux-lock → ship` chain already invokes the skills; consistency mode is automatic via canaries-dir detection. No `/cycle` code change.

---

## 8. Risk & Trade-off Register

| Risk / trade-off | Mitigation | Deferred why |
|---|---|---|
| **Annotation cost**: consumer apps need a one-time pass adding `data-engine-claim` attributes to every state-rendering surface. | Bootstrap script `scripts/persona-consistency-bootstrap.mjs` scans for likely surfaces (chips, status banners, advisory cards) and emits a starter `surfaces.json` with TODOs. Consumer-app dev fills in fields. | Manual fill of the engine-field path is unavoidable — the LLM can guess but a human owns the rubric. |
| **Network capture drift**: if the engine endpoint changes shape, `surfaces.json` `jsonPath` stops resolving. | Negative-space assertion *also* checks the reverse: any declared `engineFields[].field` whose `jsonPath` resolves to `undefined` in a captured response ⇒ P1 "Surface declares engineField path that the engine no longer returns." | (Caught by the rig itself.) |
| **Semantic-match cost**: every prose-prose comparison is an LLM call. | Cache by `(surfaceId, content-hash-pair)` per session — same prose pair re-encountered in later steps is free. Cap total semantic calls per session at 20; further calls degrade to "uncached — skipped, marked uncertain". | (Cache size + cap defined in `references/consistency-mode.md`.) |
| **Idempotency only as good as the fixture seed**: if the engine has internal non-determinism (e.g. wall-clock comparisons, RNG without seed), replay still drifts. | Document the contract: consumer-app must seed RNG + accept a fixture-clock injection point. Wine-cellar-app already has `__TEST_FIXTURE_SEED__` hook; ai-organiser will need one. | If a consumer can't seed, idempotency replay is skipped for that canary (declared via `fixtureSeed: null`). |
| **Capture library failure mid-step**: Playwright disconnect during `extractDomClaims`. | Capture wraps in try/catch; on failure emits a `WitnessRecord` with `partial: true` + `errorMessage`. Reflect treats partial witnesses as P2 (rig-degraded) not P0 (contradiction). | (Avoids confusing "we couldn't observe" with "we observed a contradiction".) |
| **regression_specs status semantics**: candidate rows look identical to enforceable to skills that read only `source_kind` filter on legacy values. | Migration `20260520120000` adds the two new values; existing readers (`unlocked_fixes` view, `ship_gate_effectiveness`) get a one-line WHERE-clause update to exclude `'persona-consistency-candidate'` from "locked specs" counts. | (No silent semantic drift.) |
| **Cross-domain scope** (touches `scripts` + `shared-lib` + `skills-content`): atomic landing required or skills will reference functions that don't exist yet. | Ship Phase 0 → Phase 1 in one PR; Phases 2+ can land incrementally because the skill flow only enables consistency mode when manifest + canary exist. | (Existing skills work uncanged.) |

---

## 9. Testing Strategy

### Unit tests

- `consistency-schemas.test.mjs` — Zod parses good manifests + good canaries; rejects malformed (missing fields, wrong types, version mismatch).
- `consistency-grammar.test.mjs` — exact match on typed; semantic match on prose; **`CROSS_STREAM_VIOLATION` thrown if semantic invoked on typed**.
- `manifest-resolver.test.mjs` — priority order; absent-file → null; symlink outside repo → refused.
- `canary-runner.test.mjs` — min/max/shape verification; empty journey → BAD_INPUT.
- `idempotency-replay.test.mjs` — same canary + seed, two runs, `normaliseForReplay` deep-equal.
- `negative-space.test.mjs` — DOM element with undeclared `data-engine-claim` → P0; declared surface absent from DOM → P3.

### Integration tests

- `capture-witness.test.mjs` — Playwright fixture with synthetic DOM + mocked network responses; assert WitnessRecord shape; assert partial-capture on disconnect.
- One end-to-end test using a fixture HTML page that *intentionally* has a known contradiction (`data-engine-claim="cellarOrganised" data-engine-value="true"` + network response `{cellarOrganised: false}`). Asserts: contradiction surfaced as P0; candidate `regression_specs` row written; ledger JSON well-formed.

### Manual checklist (consumer-app adoption)

- [ ] Wine-cellar-app: annotate status chip, Analysis headline, proposal modal, advisor panel, setup-tasks state.
- [ ] Wine-cellar-app: author `.persona-test/canaries/oliver-infeasible-reorg.json` with `expectedContradictions.min: 1`.
- [ ] Wine-cellar-app: run `/persona-test --mode consistency --canary oliver-infeasible-reorg <url>` → rig finds ≥1 contradiction; canary verdict `passed` (i.e. rig is healthy).
- [ ] Ai-organiser: same annotation pass; first canary picked once adopter decides which journey to canary on.

### A11y / responsive

- Capture library exercises elements via Playwright `getByRole` / `getByLabel` where possible (the existing ux-lock DOM-contract rule). Falls back to CSS selector only if `data-testid` is declared in the manifest.
- No responsive variance — `data-*` attributes are stable across viewports.

---

## 10. Acceptance Criteria (Playwright-verifiable)

> Section 9 of `/plan` for `/ux-lock verify` consumption. Each line: `[SEVERITY] [CATEGORY] description / Setup / Assert`.

```
- [P0] [state] Oliver canary detects ≥1 contradiction; exit 0; ledger persisted
  - Setup: run `node scripts/persona-consistency-run.mjs --canary oliver-infeasible-reorg --url <wine-cellar-staging>` from wine-cellar-app
  - Assert: exit code 0; ledger file exists at `.persona-test/sessions/<SID>.json` with `rigVerdict:'healthy'` AND `canaryVerdict:'passed'` AND `contradictions.length >= 1`

- [P0] [state] Rig-broken canary persists ledger before exit-2
  - Setup: temp-edit oliver canary to expect `min: 99` (impossible); rerun
  - Assert: exit code 2; ledger file exists with `rigVerdict:'broken'` AND `canaryVerdict:'broken'` AND `failureReason` matches /expected .* contradictions, found/

- [P0] [state] Fatal failure persists ledger before exit-3
  - Setup: invoke runner with non-existent manifest path
  - Assert: exit code 3; ledger file exists with `rigVerdict:'fatal'` AND `failureReason:'manifest-missing'` AND `steps:[]`

- [P0] [state] Playwright-missing exits 5 and persists fatal ledger (resolves R4-M1)
  - Setup: invoke runner in a fresh repo where `node_modules/playwright` doesn't exist
  - Assert: exit code 5; ledger file exists with `rigVerdict:'fatal'` AND `failureReason:'playwright-missing'`; stderr contains `npx playwright install chromium`

- [P0] [state] Act-step error (Playwright TimeoutError) exits 6 and persists app-error ledger (resolves Gemini-G1)
  - Setup: canary with a click step whose locator points at an element that doesn't exist; run against a real page
  - Assert: exit code 6; ledger file exists with `rigVerdict:'app-error'` AND `stepFailureReason` matching /TimeoutError.*locator/; ledger.steps has the failing step recorded with its plan/action/before-state; process did NOT crash

- [P0] [state] Ledger persist failure surfaces as exit-4 (distinct from rig-broken)
  - Setup: chmod 0 on `.persona-test/sessions/`; run a known-broken canary
  - Assert: exit code 4; stderr matches /LEDGER_PERSIST_FAILED/; no ledger file created

- [P0] [state] Negative-space assertion respects appliesTo context
  - Setup: surface declared with `appliesTo.routePattern: '^/admin'`; runner on `/dashboard` route
  - Assert: surface absence NOT reported as P3 finding (out-of-scope by route); on `/admin` it IS reported

- [P0] [state] Negative-space assertion fires on undeclared data-engine-claim
  - Setup: fixture HTML has `<div data-engine-claim="bogus.field" data-engine-value="x" data-freshness="current">`; surfaces.json does NOT declare bogus.field
  - Assert: ledger JSON contains a P0 contradiction with `kind:'undeclared-engine-claim'` AND `engineField:'bogus.field'`

- [P0] [state] Freshness contract: stale + visible emits stale-projection finding at the surface's severityFloor (resolves Gemini-R2-G4)
  - Setup A: surface with `severityFloor:'P0'`; fixture has `data-engine-value="true" data-freshness="stale"`; network response also says true
  - Assert A: ledger JSON contains a P0 contradiction with `kind:'stale-projection'` even though values match
  - Setup B: same fixture, surface with `severityFloor:'P2'` (e.g. SWR background-sync indicator)
  - Assert B: ledger JSON contains a P2 contradiction with `kind:'stale-projection'`

- [P0] [state] Collection-scope binding matches DOM rows to response entries
  - Setup: fixture has 3 `<li data-engine-scope="wines-grid" data-engine-key="A" data-engine-claim="wines[].vintage" data-engine-value="2020">` + similar for B, C; network response has `wines: [{id:'A',vintage:2021}, {id:'B',vintage:2020}, {id:'C',vintage:2020}]`
  - Assert: ledger has exactly ONE contradiction on key 'A' (DOM 2020 ≠ engine 2021); B and C produce zero contradictions

- [P0] [state] Network capture window respects step-end and latest winner
  - Setup: step fires two requests matching same urlPattern with different jsonPath values (`v:1` then `v:2`); capture invoked after both complete
  - Assert: witness records `v:2` as the matched value (latest winner); `v:1` is in the buffer but not the diff

- [P0] [security] Semantic compare refuses llmSafe:false fields
  - Setup: surface declares prose field with `llmSafe:false`; runner has a contradiction-eligible pair
  - Assert: NO LLM call recorded in `.persona-test/semantic-egress.log`; verdict recorded as `{matched:'uncertain', reason:'llm-unsafe-field'}`

- [P0] [security] Semantic-compare prose runs through redact.mjs before LLM call
  - Setup: prose contains a known synthetic API-key pattern; surface llmSafe:true
  - Assert: `semantic-egress.log` shows `redactionCount >= 1`; the LLM call payload (captured via test interceptor) does NOT contain the original pattern

- [P0] [state] Idempotency: same canary + same fixtureSeed = byte-identical normalised ledger
  - Setup: run oliver canary twice with same seed; load both ledgers; pipe through `normaliseForReplay`
  - Assert: `JSON.stringify(normalised1) === JSON.stringify(normalised2)`

- [P1] [state] Candidate fingerprint upsert prevents row growth on rerun
  - Setup: run a journey that produces 2 candidates; rerun the same journey 5 times
  - Assert: `regression_specs WHERE source_kind='persona-consistency-candidate' AND repo_id=...` returns exactly 2 rows after 5 runs (NOT 10)

- [P1] [interaction] /ship prompts for candidate promotion when candidates exist
  - Setup: run consistency mode that produces ≥1 candidate; then `/ship`
  - Assert: `/ship` stdout contains "consistency candidates pending" AND prompts y/N; on y, `regression_specs.source_kind` transitions to `persona-consistency-locked`

- [P1] [navigation] /ux-lock slash command still works in isolation
  - Setup: invoke `/ux-lock "modal closes before retry"` on a repo with a recent fix commit, no consistency mode involved
  - Assert: a spec file is created under `tests/e2e/`; row written to `regression_specs` with `source_kind = 'lock-mode'`; exit 0

- [P1] [state] Exploratory /persona-test mode unaffected
  - Setup: invoke `/persona-test "Pieter" <url> "adding a bottle"` with NO --canary flag and NO --mode flag
  - Assert: existing MCP-driven flow runs; no consistency-mode artifacts written; no surfaces.json required

- [P1] [state] Manifest resolver priority order
  - Setup: place `surfaces.json` in both `.persona-test/` and `<src-root>/`; run resolver
  - Assert: resolver returns the `.persona-test/` path; second call after deleting `.persona-test/` returns the `<src-root>/` path; deleting both returns null

- [P1] [state] Cross-stream violation throws on misuse
  - Setup: programmatically invoke `diffClaims` with a surface declaring `type:'boolean'` but a semantic-match override
  - Assert: throws Error matching /CROSS_STREAM_VIOLATION/; never makes an LLM call

- [P1] [state] source_kind compatibility — unlocked_fixes view excludes candidates
  - Setup: insert 1 candidate row + 1 lock-mode row for the same repo; query `unlocked_fixes` view
  - Assert: candidate row does NOT appear in `unlocked_fixes`; lock-mode row does (if its fix is unlocked)

- [P2] [a11y] Locator union enforces semantic preference
  - Setup: manifest entry uses `locator: {kind:'css', selector:'.status-chip', warn:true}`
  - Assert: ledger JSON includes a P2 finding "Surface uses CSS-class locator; prefer role/label/testid"
```

---

## 11. Security Considerations

Consistency mode introduces **two new egress boundaries** (resolves R1-H5). Section called out explicitly so the file-level plan can wire them.

### Boundary 1 — Semantic-compare LLM egress

The semantic-compare module sends prose pairs to an external LLM (Anthropic / Google). Without explicit gating, captured DOM/network text could include PII, business secrets, or auth tokens that a consumer-app surface happens to render.

**Defence-in-depth, in order**:

1. **Manifest gate (primary)**: `engineFields[].llmSafe` defaults to `false`. The semantic comparator REFUSES to compare any field where either endpoint is not `llmSafe:true`. Refused pairs are recorded as `{verdict:'uncertain', reason:'llm-unsafe-field'}` — surfaced in the report so the engineer knows where coverage stops.
2. **Pre-egress redaction**: even for `llmSafe:true` fields, the semantic-compare module runs the prose through `scripts/lib/redact.mjs` (NEW Phase 0 shared module — see file table; wraps the existing `SECRET_PATTERNS` from `quickfix-patterns.mjs`) before the LLM call.
3. **Allowlist of permitted egress destinations**: the semantic-compare module reads `PERSONA_CONSISTENCY_SEMANTIC_MODEL` and validates it resolves to a known Anthropic or Google model — refuses unknown providers with an explicit error.
4. **Audit trail**: every semantic call is logged to `.persona-test/semantic-egress.log` with `{timestamp, surfaceId, modelId, charsIn, costUsd, redactionCount}` (NOT the prose itself). Enables retrospective audit of egress volume per consumer.

Contract guidance (in `docs/consistency-contract.md`): only mark `llmSafe:true` for surfaces whose content is editorially safe — copy from your own design system, advisory prose, generic recommendations. Never mark user-input-derived prose `llmSafe:true` — those go un-compared.

### Boundary 2 — Supabase candidate-spec writes

`regression_specs` candidate rows now flow from consumer-app DOM/network data via cross-skill. These already go through the existing service-role-gated path with `learning-store.mjs` secret redaction. The cross-skill writer runs `redact.mjs` on **every JSONB column populated by consistency mode** (resolves Gemini-R6-G3 — earlier draft only redacted `selectorContextSnippet` + semantic prose, leaving `witness_snapshot` and `contradiction_payload` raw): `witness_snapshot` (recursive deep redact via `redactObject` — captured network response bodies can carry PII even when the diffed engineField is itself state-only), `contradiction_payload` (same), `journey_context` (action `payload` fields can carry form-input values), and `selectorContextSnippet`. The redactor's `count` is preserved on each row as `redaction_count INTEGER` so the egress audit can verify redaction fired and observability is preserved.

### Annotation contract guidance

`data-engine-value` could leak PII if consumers annotate identity-derived surfaces (email fields, names). **Contract rule** (in `docs/consistency-contract.md`): annotate STATE-derived surfaces (status, counts, feasibility), not IDENTITY-derived surfaces. A name field is a value the engine renders verbatim, not a state claim the engine makes — it doesn't belong in the contract at all.

---

## 11b. Known Limitations / Accepted at v1

After 4 GPT audit rounds + 5 Gemini final reviews (24 GPT findings + 13 Gemini findings = 37 total, all addressed), the following are accepted at v1 and tracked for the first implementation PR. They are NOT defects — they are deliberate trade-offs documented so the first implementer doesn't re-discover them.

| Item | Why accepted at v1 | Revisit trigger |
|---|---|---|
| **No declarative request-replay** — canaries assume the consumer-app's real backend (or its own fixture seeding) drives engine state; the rig doesn't intercept and replay request bodies | Designing a generic fixture/mock layer is its own plan; v1 leans on each consumer's existing fixture story (wine-cellar's `__TEST_FIXTURE_SEED__`, ai-organiser's TBD) | When a third consumer wants to adopt without an existing fixture mechanism |
| **No type-inference for `keyField`** — the runner samples the first response and caches the JSON type; if a later response returns a different shape, behaviour is undefined | Schema drift mid-session is rare; explicit P1 warning on shape change in v1.1 if needed | A real session encounters mid-run shape drift |
| **No multi-user / multi-tenant isolation in `.persona-test/`** — concurrent runs on the same machine share the lockfile-guarded semantic cache | The single-developer-laptop assumption holds for v1; if CI runs parallelise, the lockfile already serialises them correctly (slower but safe) | Sustained CI parallelism exceeds 4 concurrent canary runs |
| **`renderCandidateSpec` does not exercise `evaluate` journey steps** — script-based steps replay as TODO comments | `evaluate` is rarely used (we expect ≤5% of journeys) and faithful replay requires bundling `canary.scripts` paths | Any canary uses `evaluate` AND its candidate gets promoted |
| **No formal version migration story for `surfaces.json` v1 → v2** | `version: z.literal(1)` makes it explicit; a v2 plan will handle migration when needed | First breaking schema change to `SurfaceManifestSchema` |
| **Per-session `semantic-egress.log` not aggregated for cross-session audit** | Audit is per-session in v1; aggregation lands in Phase 7 (deferred contradiction-trends table) | Audit-team requests aggregated egress reporting |
| **Network listener has no public drain phase** — `attachNetworkListener` returns `{store, removeListener}`; in-flight async `response.json()` work can finish after `removeListener()` (audit-code R1-H6) | Late responses land in the cumulative store, not the witness already returned to the caller. The witness/diff path is sync wrt the page object; only the store mutates afterwards, which is harmless. | Real test flake attributable to a late listener firing during teardown |
| **Promotion is journal-based, not transactional** — `promoteOne` flips the DB row to `locked` BEFORE the final `fs.renameSync` (audit-code R1-H9) | Plan committed to this design: 2PC across Supabase + filesystem doesn't exist; `reconcilePromotionJournal` covers every crash window — pending → roll back .tmp; db-committed → complete deferred rename; finalised → janitor delete. | A recovery failure mode surfaces that the journal can't resolve |
| **Plan referenced ~5 file paths that never materialised as concrete files** — `shared-store.mjs`, `llm-cost.mjs`, `persona-consistency-bootstrap.mjs`, `tests/cross-skill.test.mjs`, inline oliver canary fixtures (audit-code R1-H1/H2/M1/M2/M3) | These are plan prose, not implementation gaps: lockfile/cache concerns inlined into `ledger.mjs` and `semantic-compare.mjs`; cost computed inline in semantic-compare; bootstrap remains a §11b deferral; `tests/cross-skill-*.test.mjs` cover the surface; oliver canary fixtures belong in wine-cellar-app per the cross-codebase split (this repo ships the schema + runner, not the canary instances). | A plan-vs-code reconciliation pass would help an external reviewer landing here fresh |
| **Audit-code cycle: 4 rounds + 3 Gemini rounds = 7 total** (R1 H 15→fixed 11, R2 H 12→fixed 10, R3 H 7→fixed 4, R4 H 8→fixed 2 + 6 dismissed as re-surfaces; Gemini-R1/R2/R3 added 7 more fixes including model-resolver allowlist, cross-skill CLI for promote+ship, defensive redact at CLI boundary, key-type coercion in diffClaims). Final Gemini-v3 verdict: CONCERNS_REMAINING with 4 findings — 3 fixed in final pass, G2 (`keyNative === null` typo) was a Gemini hallucination of code that doesn't exist (verified by direct grep). | Diminishing returns at round 7; further iteration would be rigor-pressure. Plan committed to ship at this state. | Real-world adoption surfaces a contradiction the audit cycle missed |

## 12. Why This Plan (One-Paragraph Summary)

`/persona-test` consistency mode + `/ux-lock` capture library + `/ship` candidate promotion turn three independent skills into one coherent workflow: persona-test finds semantic instability via a typed-vs-prose contradiction grammar over a portable HTML-attribute contract; ux-lock's capture engine (now a library) preserves perishable DOM evidence the moment a contradiction fires; ship decides which evidence becomes a regression lock. The Oliver canary self-tests the rig — zero findings on a journey with known contradictions aborts the pipeline. Every cross-codebase concern (surfaces manifest, severity per-surface, freshness, idempotency replay) lives in declarable JSON, not in skill code, so wine-cellar-app and ai-organiser can adopt without forking the skill. Phase 0 contracts (HTML attrs + surfaces.json schema + canary schema) are non-negotiable: nothing else in the plan works until they're stable.

# Plan: visual-audit "theme-safety" v1 — catch "color that didn't adapt"

- **Date**: 2026-07-01
- **Status**: Approved (v1 — GPT 3 rounds + Gemini coherence Strong, 0 over-engineering; 3 impl-completeness items folded in)
- **Author**: Claude + Louis
- **Scope**: backend (CLI tooling / skill extension — `js-ts`, `node --test`)
- **Target domain(s)**: `visual-audit` (single domain; no cross-domain, no untagged paths — `compute-target-domains` ruleCount=52)
- **Origin / brainstorm**: [`docs/plans/theme-parity-contrast-delta.md`](theme-parity-contrast-delta.md)
  (problem statement + the full multi-LLM brainstorm: OpenAI/Gemini/Claude converged on
  *home = visual-audit, advisory-first, delta is the general net*). This plan is the
  **smallest grounded v1** derived from that synthesis.
- **Audit trail**: `/audit-plan` R1 = H:4 M:4 L:1. All accepted. The origin-based redesign
  (R1-H2) also resolved the inheritance false-positive (R1-M2) and companion-rule case
  (R1-M1-runtime); PIECE 1b was cut to v1.1 (R1-M3, R1-L1). See §8 + **Out of Scope**.

> **Neighbourhood considered**: `get-neighbourhood` (cloud, 50 records in the visual-audit
> domain) surfaced no near-duplicate of the proposed detector. The plan **reuses**
> `resolveProvenance` (cascade winner) and **mirrors** `reconcile-tokens.mjs`'s per-node
> findings-producer shape — divergence into a new module is justified below (§2).

---

## 1. Context Summary

**What exists today (Code Trace — files read Phase 1):**
- **Static mode** produces findings via [`source-coherence.mjs`](../../scripts/lib/visual/source-coherence.mjs)
  (`runSourceCoherence` → `token_unreferenced` / `token_undefined_reference`, all
  `severity:'info'`, header says *"NEVER gate-eligible"*). Wired at
  [`visual-audit.mjs:28`](../../scripts/visual-audit.mjs#L28).
- **Static `--gate` is refused** at [`visual-audit.mjs:80-88`](../../scripts/visual-audit.mjs#L80):
  *"static mode emits no paint findings, so `--gate` would pass without checking any
  paint"* → **exit 2** (the gate-honesty guard shipped in `ee47c33`).
- **Finding taxonomy** is a closed enum + a gate-eligible subset:
  [`schema.mjs:50-82`](../../scripts/lib/visual/schema.mjs#L50) (`FINDING_CLASSES`,
  `GATE_ELIGIBLE_CLASSES`); severities at [`findings.mjs:18-26`](../../scripts/lib/visual/findings.mjs#L18).
  `contrast_failure` is already gate-eligible.
- **Cascade winner** — [`provenance-resolver.mjs:46`](../../scripts/lib/visual/provenance-resolver.mjs#L46)
  `resolveProvenance(declarations, property)` returns the winning declaration or **`null`
  when no declaration sets the property**; `expandFor` expands the **`border`** shorthand to
  `border-*-color` (lines 74-76) **but NOT `background`→`background-color`** (SHORTHAND_EXPANSIONS,
  lines 24-28) — a v1-critical gap (§2 decision 2). No declaration **origin** is captured
  today. `reconcile-tokens.mjs:95` shows the per-node consumption pattern.
- **Per-node evidence** — [`extract.mjs:257`](../../scripts/lib/visual/extract.mjs#L257)
  captures `[root, ...root.querySelectorAll('*')]` per contracted surface with `interactive`
  / `isImage` flags + computed styles; [`extract.mjs:300,328`](../../scripts/lib/visual/extract.mjs#L300)
  populates `declarations` via the CDP provenance pass **for exactly the interactive /
  focusable / disabled nodes** — the nodes this plan targets.
- **Runtime findings assembly** — `assembleLiveFindings(...)` at
  [`visual-audit.mjs:107`](../../scripts/visual-audit.mjs#L107); gate partition +
  changed-scope at [`visual-audit.mjs:108,127-164`](../../scripts/visual-audit.mjs#L108)
  via [`changed-scope.mjs`](../../scripts/lib/visual/changed-scope.mjs).

**Patterns reused vs new**: reuse `resolveProvenance` + `changed-scope` + capture honesty;
**mirror** `reconcile-tokens.mjs` for the new runtime producer; new = one pure static-lint
rule, one pure runtime producer, 2 finding classes, and one added CDP field (declaration
`origin`). **No** theme-toggle field in v1 (that was only for the deferred 1b).

**The bug this closes**: a bare `<button>`/`<select>` set `background`/`border` (shorthands)
but no `color`, so text fell back to the UA default (`ButtonText` ≈ black) — fine on light,
black-on-dark in dark mode. It fell in the gap: `click-test` reached it but has no color
check; `visual-audit` has the color check but only on contracted surfaces.

---

## 2. Proposed Architecture

Two pure producers feeding the existing static/verify pipelines — no new skill, no new
capture path, no full-DOM sweep. The runtime check is **origin-based** (see decision 2).

```mermaid
graph LR
  subgraph Static["static mode (no browser)"]
    SRC["resolved style-source records<br/>{path, content, surfaceIds}"] --> ICL["interactive-color-lint.mjs<br/>(NEW, pure)"]
    ICL -->|interactive_color_unset ADVISORY<br/>{class,sev,file,line,surfaceIds}| SF["static findings (report-only)"]
  end
  subgraph Verify["--verify (browser)"]
    EX["extract.mjs<br/>(+ declaration ORIGIN + text signal from CDP)"] --> UAC["unadapted-color.mjs<br/>(NEW, pure — mirrors reconcile-tokens)"]
    RP["provenance-resolver<br/>(+ winner ORIGIN, REUSED)"] --> UAC
    UAC -->|unadapted_text_color ADVISORY<br/>+ coverage diagnostics| LF["assembleLiveFindings (report-only)"]
    UAC -.->|any eligible node lacks evidence → warn;<br/>ALL lack evidence → unverified| UNV["honest coverage"]
  end
  SF -.->|advisory output| OUT["report"]
  LF -.->|advisory output| OUT
  NOTE["v1: NOTHING gates — both classes report-only.<br/>static --gate refusal unchanged. Gate promotion = v1.1"]
```

### Key design decisions (principles cited)

1. **Home = `visual-audit`, two pure producers, minimal new capture** (#1 DRY, #2 Modularity,
   #5 SSoT). PIECE 2 mirrors `reconcile-tokens.mjs` and reuses `resolveProvenance` + the
   CDP-populated `node.declarations`. `click-test` was rejected in the brainstorm (would
   re-implement capture honesty → two render models).

2. **The runtime signal is ORIGIN-based, not "declaration===null"** (#correctness — resolves
   R1-H2 / R1-M2 / R1-M1-runtime). The naive "`resolveProvenance(color)===null`" is **wrong
   three ways**: it misses the `background` shorthand (not expanded → false negative on the
   *exact* bug), false-positives on inherited author color, and false-positives when a
   companion author rule sets color. The correct fingerprint uses the CDP **declaration
   origin** the cascade already knows:
   - the **winning `color`** declaration's origin is **user-agent** (author set no color —
     locally, by inheritance, or by a companion rule; an author color of any of those wins
     over UA → origin=author → not flagged), **AND**
   - the **winning `background-color` OR `border-*-color`** declaration's origin is **author**
     (the box is author-styled — origin distinguishes it from the UA button chrome, and works
     on the `background`/`border` **shorthands**).

   This needs one added field threaded CDP → `extract.declarations[].origin` →
   `resolveProvenance().origin`. Single-render — no theme matrix. The exact bug both
   detectors target is thereby actually caught, precisely.

   **CDP origin mapping (R2-H2 — exact contract).** CDP `CSS.RuleMatch.origin` ∈
   `{regular, user-agent, injected, inspector}` plus node **inline** style + **attributes**
   style. Normalize: `user-agent` → `user-agent`; `regular` and **inline** → `author`;
   `injected` (constructed/adopted stylesheets, e.g. CSS-in-JS runtime) → `author`;
   `inspector` → ignored (never present in a headless capture). The winner is picked by the
   existing cascade comparator; only the mapping is new.

   **"Author-styled box" predicate (R2-M2 — not every shorthand is real color).** A winning
   `background-color`/`border-*-color` of origin `author` counts as box-styling ONLY when it
   is a *visible* author color: background-color is **not** `transparent`/`rgba(…,0)`; a
   border counts only with computed `border-width > 0` AND a resolved color that is **not**
   `currentColor` (which just re-inherits `color`). `background:none`/`border:0`/reset values
   therefore do not qualify — checked against the COMPUTED value, not the raw shorthand text.

   **v1 scope = NATIVE form controls only (R3-H3 — sidesteps inheritance depth).** v1 targets
   `<button>`, `<select>`, `<input>`, `<textarea>` — controls whose UA stylesheet sets `color`
   **directly on the element** (form controls do not inherit page `color`). So the winning
   `color` declaration is in the node's OWN matched rules (UA or author) — no need to flatten
   the CDP `inherited[]` chain. Non-form-control interactives (`[role=button]` on a `<div>`,
   which DO inherit `color` from an ancestor author rule) are **v1.1** (they need inherited-chain
   capture to avoid a false "unset" verdict). This keeps the exact bug (a `<button>`/`<select>`)
   in scope while the origin signal stays sound on the node's own declarations.

   **No text-content filter for form controls (Gemini NF-HIGH/MEDIUM).** Native form controls
   inherently paint **color-dependent content** — visible text, `value`/`placeholder` (even an
   empty input paints a caret + placeholder in `color`), the selected option, or a
   `currentColor` icon. Filtering on non-empty `textContent` would (a) skip nearly all inputs
   (empty on load) and (b) skip icon-only buttons whose `currentColor` glyph has the *same*
   UA-color bug. So v1 evaluates **every visible (not `display:none`/`hidden`/zero-rect)**
   form control, no text-content gate. A truly no-color-content control is a rare, acceptable
   *advisory* false positive (report-only). `extract.mjs` still captures visibility + the
   node's text/value signal for the finding's `textSnippet` (R3-H2), not as a skip gate.

3. **The exact bug needs no crawler in the DETECTOR; reach is orthogonal** (right-sizing —
   resolves R1-H3). The two-theme *parity delta* is v2. **Reach**: v1 asserts on any
   **directly-reachable** contracted surface (a surface whose `selector` is present at the
   captured URL/state, incl. an app that deep-links a modal open). The detector's correctness
   does **not** depend on reach — reach only delivers more nodes. The specific *modal instance*
   from the bug report is caught in v1 **only if** its surface is reachable at capture; a
   declared `surfaces[].activate` (click-to-open, reusing nav-audit's bounded activation pass)
   is the smallest v1.1 addition and is named in **Out of Scope**. §9's empirical target is
   scoped accordingly (a styled control on a reachable/fixture surface), so acceptance is
   honest, not contingent on deferred reach.

4. **Scope firewall honored verbatim** (SKILL.md): *"include a check only if you can assert
   it on a computed style without knowing what the page is FOR."* "Text color set by the UA
   on an author-styled control" is a universal physical property → in scope. No
   affordance/intent judgement (that's persona-test).

5. **BOTH v1 producers are report-only (advisory); nothing gates in v1** (brainstorm
   consensus: advisory-first — resolves R2-H1 / R2-M1 / R1-M1). `unadapted_text_color` (mirrors
   the report-only `component_inconsistency`) AND `interactive_color_unset` stay **out of**
   `GATE_ELIGIBLE_CLASSES`. Gating a *heuristic* static CSS lint in v1 would force a full
   parser-equivalence spec (grouped selectors, cascade layers, nested CSS, media queries) AND
   a silent-clean-on-unreadable-source hole (R2-H1) — disproportionate for v1. So the static
   lint SHOWS its finding in every static run (visible in review) but does not block CI, and
   the runtime check is advisory. **Promotion of `interactive_color_unset` to gate-eligible is
   deferred to v1.1** (after the parser is proven + the unreadable-source path degrades to
   `unverified`). *(Deviation from the initial "static lint gates" instruction — the audit
   surfaced concrete parser-rigor + gate-honesty reasons; advisory-then-promote is the
   structurally-honest order, matching the brainstorm consensus.)*

6. **PIECE 2 fails honest, never silent-clean — total AND partial** (#16, #19 — resolves
   R1-H4 + R3-H4). `findUnadaptedColors` returns `{findings, coverage:{eligible, withEvidence,
   skippedNoDecls, errors}}`. **Total** loss (`eligible > 0 && withEvidence === 0`) → the
   surface degrades to **`unverified`** (no clean pass). **Partial** loss
   (`0 < withEvidence < eligible`) → a per-surface **coverage warning** naming the skipped
   node count (the covered nodes' findings still stand, but the gap is surfaced, never
   silent). A per-node "skip on missing declarations" must never aggregate into "checked,
   found nothing" — at either granularity.

7. **Static-mode gate refusal is UNCHANGED** (the load-bearing simplification — addresses
   R1-H1 + R2-H1). Because PIECE 1a is advisory in v1 (decision 5), the `visual-audit.mjs:80-88`
   static `--gate` refusal (exit 2, shipped in `ee47c33`) is **left exactly as-is** — no
   evolution, no re-opening of the just-shipped gate-honesty guard. The static lint still
   produces a normalized `VisualFinding {class, severity, file, line, surfaceIds, message}`
   (the `file` anchor is authored now so v1.1 gate-promotion is a one-line
   `GATE_ELIGIBLE_CLASSES` add + wiring, not a rework), but in v1 those findings are advisory
   output only. This deletes the entire "static-gate evolution vs paint-honesty" risk from
   v1.

### Right-sizing gate

- **Band-aid**: PIECE 2 advisory only; the bug ships unnoticed until someone runs `--verify`
  on the right surface — no PR-time deterministic catch, and the naive detector silently
  misses the shorthand.
- **Over-engineered**: full two-theme parity-delta + full-DOM sweep + occlusion/ancestor
  tuning + a crawler↔evaluator bridge — the v2 surface, none of which the *current*
  requirement (catch THIS bug class precisely + cheaply) needs.
- **Chosen**: one deterministic static lint (advisory) + one origin-based single-render
  advisory runtime check, both on existing machinery, with one added CDP field. **Nothing
  gates in v1** (advisory-first); gate promotion is v1.1. The v2 items are named scope
  boundaries (**Out of Scope**), not silent gaps.

---

## 6. Sustainability Notes

- **Assumption**: interactive nodes get `declarations` (extract CDP pass). If a future
  extract refactor narrows that set, PIECE 2's **coverage diagnostic** (decision 6) surfaces
  it as `unverified` rather than a false clean.
- **Extension seam**: `unadapted-color.mjs` is the single choke point where (a) the v2
  two-theme delta plugs in (second render + compare), and (b) a future `surfaces[].activate`
  delivers more nodes without touching the producer.
- **Artifacts**: unchanged two-artifact split (committed `visual-contract.json` + gitignored
  observed/verify-result). No new persistent artifact. The `origin` field is transient CDP
  evidence, not persisted.

---

## 7. File-Level Plan

| File | Action | Purpose |
|---|---|---|
| [`schema.mjs`](../../scripts/lib/visual/schema.mjs) | modify | Add `interactive_color_unset` (static) + `unadapted_text_color` (runtime) to `FINDING_CLASSES`. **Neither** is added to `GATE_ELIGIBLE_CLASSES` in v1 (both advisory — decision 5). |
| [`findings.mjs`](../../scripts/lib/visual/findings.mjs) | modify | Severities (both advisory/report-only): `interactive_color_unset`→`info` (matches source-coherence's static advisory convention); `unadapted_text_color`→P2. Severity ≠ gate-eligibility (that's `GATE_ELIGIBLE_CLASSES`) — R3-M2. |
| [`extract.mjs`](../../scripts/lib/visual/extract.mjs) | modify | Additive to the existing interactive-node provenance pass: (1) capture declaration **`origin`** normalized per the CDP mapping in decision 2 into `declarations[].origin`; (2) capture the per-node **text signal** (`textContent`/`value`/`placeholder`/selected-option) so the pure producer decides text-bearing without a 2nd DOM pass (R3-H2). |
| [`provenance-resolver.mjs`](../../scripts/lib/visual/provenance-resolver.mjs) | modify | `resolveProvenance` also returns the winner's `origin`; add `resolveWinningOrigin(declarations, property)`. Also expand `background`→`background-color` in `SHORTHAND_EXPANSIONS` (belt-and-suspenders; origin does the real work). |
| `scripts/lib/visual/unadapted-color.mjs` | **create** | PIECE 2 (pure, mirrors `reconcile-tokens.mjs`). `findUnadaptedColors({nodes})` → `{findings, coverage}`. Per **native form-control** (button/select/input/textarea — decision 2 R3-H3), non-image, VISIBLE node (no text-content filter — Gemini NF-HIGH): flag `unadapted_text_color` when winning-`color` origin is `user-agent` AND a *visible* author box color exists (decision 2 predicate). **Report-only** → not changed-scope-keyed, so no `finding.file` needed (R3-M1). Fingerprint {surfaceId, nodeKey, tag/role, textSnippet, computedColor, computedBackground}. Coverage per decision 6 (total→unverified, partial→warn). |
| `scripts/lib/visual/interactive-color-lint.mjs` | **create** | PIECE 1a (pure, no browser, **advisory**). `lintInteractiveColor({styleSources})` over resolved style-source records, parsing CSS with the **regex/`.match()` convention already used by `tokens.mjs`** (NOT a new `postcss` dep — the repo deliberately regex-parses CSS for token extraction; an AST parser is unjustified for an *advisory* lint, and the runtime PIECE 2 is the precise net — R3-M3 tolerated because advisory). Flag a form-control selector (`button,select,input,textarea` + `.btn*` variants) whose rule sets `background`/`border` but has **no author `color`** — cleared when `color` is set in the same rule, same source block, or a companion selector matching the same target; grouped selectors handled. **Documented limits**: cascade layers, deep `:is()`/`:where()`, CSS-in-JS → out of static reach → runtime PIECE 2 is the second net. An **unreadable/unparseable** declared source emits a visible `warning` (never silently dropped — R3-M4; safe because advisory, no gate to false-green). Emits normalized `VisualFinding {class, severity, file, line, surfaceIds, message}` (the `file` anchor is authored now for v1.1 gate-promotion). |
| [`visual-audit.mjs`](../../scripts/visual-audit.mjs) | modify | Static mode: build resolved style-source records, run `lintInteractiveColor`, emit its (advisory) findings (banner updated: static mode now emits **deterministic advisory** findings). The `--gate` static-block refusal is **untouched** (decision 7). `--verify`: wire `findUnadaptedColors` into `assembleLiveFindings`; honor its `coverage` → `unverified` degradation. |
| [`SKILL.md`](../../skills/visual-audit/SKILL.md) + `references/ci-gate-and-verify.md` | modify | Document the 2 new classes (both advisory/report-only in v1), that the static `--gate` refusal is unchanged, and the origin-based runtime signal. Regenerate `.claude/skills` via `skills:regenerate`. |
| `tests/visual-unadapted-color.test.mjs`, `tests/visual-interactive-color-lint.test.mjs`, `tests/visual-theme-safety-cli.test.mjs` | **create** | Tier-1 pure tests + a CLI integration test (§9). |

### 7b. Implementation Phases

- **Phase 1 — Taxonomy + origin capture**: add the 2 classes + severities + gate-eligibility;
  thread declaration `origin` through CDP→extract→resolver. Files: `schema.mjs`,
  `findings.mjs`, `extract.mjs`, `provenance-resolver.mjs` (all modify).
- **Phase 2 — PIECE 2 runtime advisory (origin-based, single-render) + coverage honesty**:
  new producer + wire into `--verify` + `unverified` degradation. Files: `unadapted-color.mjs`
  (create), `visual-audit.mjs` (modify), `tests/visual-unadapted-color.test.mjs` (create).
- **Phase 3 — PIECE 1a static lint (advisory)**: new lint + resolved
  style-source records + emit in static mode (the `--gate` refusal is untouched — decision 7). Files:
  `interactive-color-lint.mjs` (create), `visual-audit.mjs` (modify),
  `tests/visual-interactive-color-lint.test.mjs` + `tests/visual-theme-safety-cli.test.mjs` (create).
- **Close-out (not a phase)**: `npm run skills:regenerate` + `npm run skills:check` +
  `npm test`, then the mandatory **empirical pre-ship verify** (§9).

> **No §11 clustering**: with PIECE 1b cut, the three phases are one cohesive seam (shared
> finding registry + `visual-audit.mjs` static/verify wiring); Gate-2 (≥2 clusters) is not
> met. `/cycle` audits the union as a single pass.

---

## 8. Risk & Trade-off Register

| Risk / fork | Decision | Mitigation |
|---|---|---|
| **Gating a heuristic static lint forces parser rigor + a silent-clean hole (R2-H1/M1)** | Advisory in v1 (decision 5) | Neither producer gates in v1; static findings are advisory output. This deletes the gate-honesty-evolution risk AND the unreadable-source-→-clean-gate hole from v1. Gate promotion is v1.1, once the parser is proven + the unreadable-source path degrades to `unverified`. The `file` anchor is authored now so promotion is a one-line change, not a rework. |
| **CDP `origin` not populated / provenance regresses** | Fail honest (decision 6) | Coverage diagnostic → `unverified`, never a false clean. A missing `origin` on a node → that node is `withEvidence:false`, not a finding. |
| **PIECE 1a static-parse limits** (CSS-in-JS, cascade layers, deep `:is()`) | Accept + documented | Static rule covers declared CSS text; runtime PIECE 2 is the second net for runtime-generated styles. Limits named in SKILL.md, not silent. |
| **PIECE 2 residual false positives** (advisory) | Accept (report-only) | Origin signal removes the inheritance/companion/shorthand classes; any residual is a *note*, never a CI block. Promotion to gate-eligible deferred until field data. |
| **Modal instance from the bug report unreachable in v1** | Scope honestly (decision 3) | Detector correctness is reach-independent; acceptance targets a reachable/fixture surface; `surfaces[].activate` is the named v1.1 reach addition. |
| **Full-DOM scope creep** | Refused in v1 | PIECE 2 stays on contracted surfaces (existing scope). |

### Out of Scope (Future — explicit boundaries, not silent gaps)

- **v1.1**: `token_undefined_in_theme` + per-theme static token index + declared
  `themes[].select` toggle (R1-M3 — needs a theme selector/media model + token-graph alias/cycle
  resolution; independent of the v1 detectors' correctness); a declared **`surfaces[].activate`**
  step to reach modals (reuse nav-audit's bounded activation pass); **promoting `interactive_color_unset`
  to gate-eligible** (needs a real CSS-AST parser-equivalence model + unreadable-source →
  `unverified` degradation — R2-H1/M1) and `unadapted_text_color` to gate-eligible, once field-proven.
- **v2**: two-theme **contrast parity-delta** (pass-in-one-theme/fail-in-other); **full-DOM**
  non-contracted sweep; ancestor-composite + min-area/visibility/**occlusion** tuning for the
  delta.
- **Taxonomy note (R1-L1)**: v1.1's `token_undefined_in_theme` (a token defined but only in
  one theme) is distinct from the existing `token_undefined_reference` (no definition anywhere);
  document the distinction when 1b lands.

---

## 9. Testing Strategy

- **Tier-1 (test-first, pure)**:
  - `unadapted-color.test.mjs`: winning-`color` origin `user-agent` + winning
    `background-color` origin `author` + text → `unadapted_text_color`; author `color` winner
    (local / **inherited** / **companion rule**) → **no** finding (origin=author); box styled
    only by **`background:` shorthand** (author) → **fires** (the exact-bug regression);
    image / non-interactive / no-text → skipped; **coverage**: eligible>0 & withEvidence=0 →
    `unverified` signalled (not empty-clean).
  - `interactive-color-lint.test.mjs`: `button{background:…}` no color → `interactive_color_unset`;
    color in same rule / same block / companion selector → **none**; `.btn` + grouped
    selectors matched; finding carries `file`/`line`/`surfaceIds`.
  - `schema` guard: both classes in `FINDING_CLASSES`; `interactive_color_unset` in
    `GATE_ELIGIBLE_CLASSES`; `unadapted_text_color` **not** gate-eligible.
- **Integration (same-commit — R1-M4, the risky CLI wiring)** — `visual-theme-safety-cli.test.mjs`
  with fixture contract + fixture style files + a fixture DOM/verify-result:
  - static mode emits the advisory `interactive_color_unset` finding (no longer "0 findings");
    static `--gate` (no `--verify`) still **exits 2** (the shipped refusal is unchanged —
    decision 7) — i.e. the advisory static finding does **not** flip any gate;
  - malformed/unreadable style source → advisory finding is skipped, not a crash (safe:
    advisory, so no gate to false-green);
  - `--verify` all-eligible-nodes-missing-declarations → run degrades to `unverified`
    (non-zero/`unverified`, never clean — the one honest-failure path that DOES matter in v1);
    `unadapted_text_color` never flips a gate (report-only).
- **Empirical (pre-ship, MANDATORY — the layer no static review replaces; R1-H3 scoped)**:
  run `visual-audit --verify <url>` against ONE real app with a **reachable** styled control
  reproducing the bug class (a bare styled button on a top-level contracted surface, or a
  fixture surface); confirm `unadapted_text_color` fires on it and does NOT flood clean
  controls, and the static lint flags the source rule. The specific *modal* instance is a
  documented v1 limitation until `activate` lands. Green unit suite alone is insufficient
  (browser-render assertion).

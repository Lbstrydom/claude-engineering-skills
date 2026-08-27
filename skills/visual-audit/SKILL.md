---
name: visual-audit
description: |
  Math-first, deterministic visual/paint inspection — the 4th UX lens, complementing
  persona-test (journey), click-test (page), and nav-audit (system). Drives Playwright +
  computed styles + bounding boxes + CDP forced-pseudo-state to audit declared-token
  conformance, light/dark theme parity, layout physics, and affordance signifiers. A VLM
  is advisory-only and never gates. CI gate is drift-only on the changed contracted surface.
  Triggers on: "visual audit", "check styling consistency", "theme parity", "dark mode parity",
  "design token drift", "paint audit", "button/card consistency", "focus ring audit",
  "/visual-audit".
---

# /visual-audit — the visual/paint inspection lens

Where **click-test** asserts semantic-HTML/DOM contracts and **persona-test** does narrative
QA, **visual-audit** asserts what the page *paints*: token conformance, theme parity, layout
physics, and affordance signifiers — deterministically, over computed-style evidence.

> **The one rule that defines scope** (write it into every judgement):
> **"Include a check only if you can assert it on a computed style without knowing what the
> page is FOR."** A focus ring's presence, a hover paint-delta, a disabled control's opacity —
> all assertable blind. "Is this the primary CTA?" / "would a user know to click?" require
> intent → that's **persona-test**, not here.

> **Worktree preflight** — in a linked git worktree the synced tooling tree
> `scripts/.claude-skills/` is absent — it is gitignored, so `git worktree add`
> does not populate it, and every command below that uses it dies on a bare
> `MODULE_NOT_FOUND`. Run `npm run skills:hydrate` first.
>
> If this repo defines no such script, it has not adopted the remedy yet. Add
> this entry to its `package.json` `scripts` and run it — it copies the tooling
> tree in from the main checkout, and leans on nothing but node and git:
>
> "skills:hydrate": "node -e \"const{execFileSync}=require('node:child_process'),p=require('node:path'),f=require('node:fs');const main=p.dirname(execFileSync('git',['rev-parse','--path-format=absolute','--git-common-dir'],{encoding:'utf8'}).trim());const dir='scripts/.claude-skills';const src=p.join(main,dir);if(p.resolve(dir)===p.resolve(src)){console.log('[hydrate] main checkout - nothing to do');process.exit(0)}if(!f.existsSync(src)){console.error('[hydrate] no tooling at '+src+' - re-sync the main checkout first');process.exit(1)}f.cpSync(src,dir,{recursive:true});console.log('[hydrate] copied '+src)\""
>
> Rationale (source repo only — `docs/runbooks/` is not synced to consumers):
> `docs/runbooks/consumer-adoption.md` §"Linked git worktrees".

## Static-primary? No — verify-primary (read this first)

Paint cannot be asserted without rendering. So unlike nav-audit (static-primary), visual-audit
is **verify-primary**:

- **Static run** (`/visual-audit`, no URL) = parse the declared token sources into an
  allowed-set + run the **source-coherence** lint (unreferenced / undefined / duplicate tokens).
  It emits **no paint findings** and says so (a banner). This is honest, not a bug.
- **`--verify <url>`** = where the four tiers actually run. All token/theme/layout/signifier
  findings are live evidence.

## A VLM can point, but computed evidence must convict

The assertion engine is pure math over `getComputedStyle` + `getBoundingClientRect` + CDP
matched/forced-pseudo-state. `--explain` (opt-in) may ask a VLM to *narrate* an already-found
finding; it creates zero findings and never touches the gate. Sending pixels requires the
second flag `--allow-external-screenshot`.

## The four tiers

1. **Declared-token reconciliation** (spine). A rendered value on a contracted surface must be
   on the declared scale OR set by a token-referencing declaration → else `token_violation`.
   Token-less apps get an inferred-cluster fallback: **report-only, never gating**.
2. **Theme parity** (light/dark). MUST-MATCH in-flow geometry (only for nodes rendered in
   *both* themes — a `display:none`-in-one-theme element is intentional). MAY-DIFFER colors are
   allowed when tokened; an untokened literal identical across themes → `theme_unmapped_token`.
   Contrast is a byproduct over the resolved opaque backdrop → `contrast_failure`.
3. **Layout physics**. `layout_overflow` / `content_clipping` / `unexpected_overlap` (excludes
   ancestor-descendant containment) / `image_distortion`.
4. **Signifier matrix** (affordances via math). `missing_visible_focus` (any visible focus
   indicator — outline OR ring OR border OR bg, ≥3:1) / `state_has_no_visual_delta` (no hover
   paint change) / `disabled_not_signified`. Pseudo-states read via CDP `forcePseudoState`
   (effective styles, no flaky mouse actuation), after freezing transitions/animations.

## Flow

- **Phase 0 — Bootstrap** (first run): `visual-audit --bootstrap` writes a review-queue
  `visual-contract.json`. Fill `surfaces[].sourceGlobs`, `tokenSources`, `themes`, then remove
  the `_note`. See `references/contract-and-bootstrap.md`.
- **Phase 1 — Static**: `visual-audit [--scope diff|full]` extracts the allowed-set + emits the
  observed envelope + source-coherence diagnostics. No browser.
- **Phase 2 — Verify**: `visual-audit --verify <url> --device desktop,mobile --theme light,dark`
  drives Chromium, runs the four tiers, writes the gitignored verify-result, renders the
  scorecard + findings.
- **Phase 3 — Gate** (CI): add `--gate`. Exits 1 only on a gate-eligible finding that survives
  the canonical `ChangedScopeResolver` on the changed surface. See `references/ci-gate-and-verify.md`.

## CLI

| Flag | Purpose |
|---|---|
| `--bootstrap [--from-url <url>] [--force]` | emit a review-queue `visual-contract.json` |
| `--scope diff\|full` | gate scope (default `diff` = changed contracted surface; `full` = whole contracted surface). Under `--gate`: `diff` blocks on findings whose surface's files changed; `full` blocks on every gate-eligible finding on a declared surface (both then filtered by the baseline) |
| `--verify <url>` | live computed-style reconcile + the four tiers |
| `--device <csv>` | device presets, default `desktop,mobile` (`desktop\|desktop-large\|tablet\|mobile\|mobile-small`) |
| `--theme <csv>` | subset of contract themes to capture (default all; unknown name → exit 2, never a silent drop) |
| `--full-dom [--full-dom-node-budget <n>]` | theme-safety v2: opt-in full-DOM contrast parity-delta sweep (verify-only — without `--verify` → exit 2; advisory, never gates; budget default 4000 emitted text candidates) |
| `--storage-state <file>` | Playwright storageState for auth |
| `--gate` | drift-only CI exit (non-zero on a changed-surface gate-blocker NOT in the baseline) |
| `--update-baseline` | snapshot today's gate-eligible findings into `visual-audit-baseline.json` (committed) so `--gate` then blocks only on NEW findings |
| `--explain [--allow-external-screenshot]` | opt-in VLM narration (advisory; egress-guarded) |
| `--out <file>` / `--format human\|json` / `--root <dir>` | output plumbing |

Exit codes: `0` clean/advisory · `1` gate-blocking divergence (`--gate`) · `2` tool error ·
`3` needs-bootstrap (no contract).

## Distinct from the other lenses (don't absorb their scope)

- touch-target **size** → click-test (it owns interaction mechanics; visual-audit owns paint).
- semantic-HTML / ARIA correctness → click-test / nav-audit.
- narrative affordance + CTA persuasiveness → persona-test.
- nav reachability → nav-audit. plan/design intent → plan / audit-code.
- image attribute-presence lint → click-test; visual-audit owns only the *rendered* distortion.

## Finding taxonomy (gate-eligible vs report-only)

`token_violation`, `theme_geometry_drift`, `theme_unmapped_token`, `contrast_failure`,
`layout_overflow`, `content_clipping`, `unexpected_overlap`, `image_distortion`,
`missing_visible_focus`, `disabled_not_signified` are **gate-eligible**.
`state_has_no_visual_delta`, `component_inconsistency`, `contrast_parity_delta`,
inferred-cluster outliers, and the `token_unreferenced` / `token_undefined_reference` /
`token_duplicate_definition` coherence diagnostics are **report-only**. Full rules:
`references/finding-taxonomy.md`.

**Theme-safety (v1 + v2, advisory) — "color that didn't adapt to dark mode".** Three
**report-only** classes. `interactive_color_unset` = the **static** lint (no browser): a
form-control selector (`button`/`select`/`input`/`textarea`/`.btn*`) sets `background`/`border`
but not `color`; runs in every static run (the `--gate` refusal is UNCHANGED — these are
advisory, not paint). `unadapted_text_color` = the **`--verify` single-render** check: the
winning `color` declaration's CDP origin is `user-agent` while an author sets a visible box
color (background/border). Origin-based (survives the `background` shorthand +
inherited/companion author color); scope = native form controls only. `contrast_parity_delta`
= the **v2 `--verify --full-dom`** check: a text node whose contrast **passes in one theme and
fails in the other** (the XOR fingerprint of a non-adapting color — decorative low-contrast
fails in *both* themes, so no delta). **Scope-disjoint by construction**: the gate-eligible
absolute `contrast_failure` sees contracted-surface nodes ONLY; the parity-delta sees the
full-DOM sweep's `scope:'fullDom'` nodes ONLY — never consolidate them, the split IS the
design (the delta is what keeps a full-page sweep low-noise where absolute contrast would
drown). Full-DOM joins across themes use the un-truncated `livePath` (the depth-8 `nodeKey`
collides on repeated deep structures); capture honesty degrades to `unverified` on empty
sweep / all-ambiguous joins / zero cross-theme joins / partial device×theme matrix — never a
silent clean. Known capture limits: `TreeWalker` does not pierce shadow roots; the budget
bounds *emitted text candidates* (default 4000, `truncated` stat on clip). NOTHING here gates —
gate-promotion of all three classes and modal `activate`-reach remain v1.1
(`docs/plans/visual-audit-theme-safety-v1.md`; v2: `visual-audit-theme-safety-v2.md`).

## Reference files

| File | Summary | Read when |
|---|---|---|
| `references/token-extraction-and-adapters.md` | Token-source adapters (Tailwind/CSS-vars/JSON), allowed-set normalization, inferred-cluster fallback. | Adding/​debugging a token source, or a value reconciles wrong. |
| `references/finding-taxonomy.md` | The 18 finding classes — severity, gate-eligibility, guards that prevent false positives. | Triaging a finding, or deciding if a check is in-scope. |
| `references/contract-and-bootstrap.md` | `visual-contract.json` schema + `--bootstrap` recipe, `data-visual-id` opt-in, theme-apply protocol. | Authoring/​editing the contract, or theme capture misbehaves. |
| `references/ci-gate-and-verify.md` | Drift-only changed-surface gate, the `ChangedScopeResolver` rules, capture-honesty, exit codes. | Wiring CI, or a finding gates/​doesn't-gate unexpectedly. |
| `examples/example-report.md` | A sample human + JSON visual-audit report for reference. | Want to see the output shape before running. |

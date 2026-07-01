# Proposal: Theme-parity contrast **delta** — catch "color that didn't adapt to dark mode"

- **Status**: Draft (feedback note, carried over from a wine-cellar-app session 2026-07-01)
- **Origin**: A real wine-cellar-app bug — a bare `<button>`/`<select>` inside a modal
  (`.mpc-add-btn` etc.) with no author `color` fell back to the UA default
  (`ButtonText` ≈ black), fine on light, black-on-dark in dark mode. It fell into
  the **gap between two skills** and neither caught it.
- **Scope**: `click-test` + `visual-audit` (UX-lens skills), plus a cheap static CSS lint.

> Not yet audited/approved — this is the written-up problem statement + approach for
> `/audit-plan` or a `/brainstorm` to pressure-test before it becomes a real plan.

---

## 1. Why it fell through the cracks (current-state, verified)

- **`visual-audit`** owns "light/dark theme parity" + "declared-token conformance" and
  **already computes a `contrast_failure`** over the in-browser-resolved opaque backdrop
  (SKILL.md Tier 2). BUT it is **scoped to a handful of contracted surfaces**
  (`visual-contract.json`: auth-card / app-header / drink-tonight-panel) and gates
  drift-only. A modal's add-button is not a contracted surface, so it was never looked at.
- **`click-test`** **walks every interactive element**, has `--scope a11y`, and reaches
  the bug's location because `--with-modals` opens each modal/dropdown and re-scans. BUT
  it asserts semantic-HTML contracts (duplicate IDs, orphan labels, ARIA, headings, touch
  targets) — it has **no theme toggle and no contrast check**.

So: **element enumeration + modal reach already live in `click-test`; the theme/contrast
concept already lives in `visual-audit`. Neither runs a per-element contrast check across
themes.** That intersection is the missing pass.

## 2. The key that makes it low-noise: parity **delta**, not absolute contrast

A naïve "flag anything under 4.5:1" is unusably noisy (gradients, text-over-image,
decorative, intentionally-muted copy). The high-precision signal for *exactly this bug
class* is a **delta across themes**:

> Render the same element in **both** themes; flag it only when contrast
> **passes in one theme and fails in the other.**

That delta is the fingerprint of "a color that didn't adapt" — a hardcoded literal, or a
UA-default text color on an author-styled box. A genuinely decorative low-contrast element
is usually low-contrast in *both* themes, so it does **not** trip the delta → few false
positives.

## 3. Concrete check spec (a11y scope, per element incl. inside opened modals)

1. Resolve the **effective background**: composite up the ancestor chain until a
   non-transparent layer. If it bottoms out on an image/gradient → **skip** (don't flag).
2. Compute WCAG contrast of computed `color` vs that background, in **light AND dark**.
3. **Flag when `pass(themeA) && fail(themeB)`** (the parity delta).
4. **Bonus high-signal sub-check** (also catchable statically): computed `color` resolves
   to a **system/UA keyword** (`ButtonText`, `canvastext`, …) while the element has an
   author-set `background`/`border` — the "styled the box, forgot the text" smell.

## 4. Cheap always-on complement (static, no browser)

A stylelint rule / contract test, zero-flake, every PR:
- an interactive selector (`button`, `select`, `[role=button]`, `input`, `.btn…`) that
  sets `background` or `border` but **not** `color`; and
- `var(--token)` **with no fallback** where `--token` is undefined in one theme (the
  `--bg-input`-only-in-light ghosting also hit in wine-cellar).

Catches both sub-issues **before** they ever render.

## 5. Recommendation (from the discussion)

- **Primary** — add the **theme-parity contrast delta** to `click-test --scope a11y`
  (it already enumerates elements + reaches modals + can toggle `data-theme` / emulate
  `prefers-color-scheme`). Needs a `--theme light,dark` matrix, mirroring its `--device`
  matrix.
- **Reinforce** — generalize `visual-audit`'s theme-parity lens to a **full-DOM advisory
  findings pass** (not just contracted surfaces) as a second net.
- **Guard** — ship the **static CSS lint** as the cheap always-on gate.

## 6. Open questions for the brainstorm / audit

- **Home**: one skill or split? `click-test` has the reach; `visual-audit` has the paint
  semantics + capture-honesty machinery (freeze transitions, `document.fonts.ready`,
  resolved-backdrop compositing, degrade-to-`unverified`). Duplicating theme capture in
  `click-test` risks re-implementing visual-audit's hard-won capture honesty.
- **Scope-firewall fit**: visual-audit's rule is *"include a check only if you can assert
  it on a computed style without knowing what the page is FOR."* Contrast-parity passes
  that test — but is a per-element **full-DOM** sweep still "drift-only gate-able," or is
  it advisory-only (like the VLM)?
- **Noise budget**: does the parity-delta alone hold on real apps, or does it need the
  ancestor-composite + image/gradient skip + a min-area/visibility filter to stay quiet?
- **Theme actuation**: how is "dark" driven per app — `data-theme` attr, `.dark` class,
  `prefers-color-scheme` emulation? Needs a declared toggle (contract field) since it's
  app-specific.

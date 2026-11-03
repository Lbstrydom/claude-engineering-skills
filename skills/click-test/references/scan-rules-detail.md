---
summary: Why the scan rules are what they are — perceivability, touch-target regions, severity intuition, FP notes, prep JSON.
---

# Scan rules — detail and rationale

Each section below backs a rule that stays resident in SKILL.md in one-line
form.

## click-test vs /persona-test

Walk every interactive element on each target route and assert the structural
HTML contract. **Not a persona test.** This is the mechanical sibling of
`/persona-test`:

| Skill | Catches | Misses |
|---|---|---|
| `/persona-test` | Narrative UX, confusing copy, missed migration glyphs, FAB-modal stacking, broken happy paths | Duplicate IDs (rendered fine), orphan labels (no visible symptom), undersized touch targets the persona's finger happens not to miss |
| `/click-test` | Structural / semantic / a11y contract violations across every interactive element | Whether the flow makes sense for any human |

Run **both**. Findings from each rarely overlap.

## Auth-gated routes — the shared driver connection (Phase 0b)

click-test itself never attempts to log in — credentials are out of scope
for this skill's own logic. But click-test drives the same browser
connection as persona-test (see `references/dom-scanner.md` and the
delegated browser-tool detection below), so the same session-level
pre-authentication applies here: if the target's primary surfaces need a
login, pre-authenticate the shared driver connection via `--storage-state`
BEFORE running click-test — see
[`references/auth-bootstrap.md`](auth-bootstrap.md)
for the sanctioned pattern (a per-repo sign-in script writing a
`storageState` file, wired into `.mcp.json`). Without it, `auth-required`
routes are real coverage gaps, not a v1 limitation. The OVERALL verdict
becomes at most `Incomplete` (never `Clean`) when any route is
`auth-required`.

## Device prep contract (Phase 3)

`node scripts/lib/device-presets.mjs prep-matrix` returns:

```json
{
  "kind": "click-test-prep",
  "version": 1,
  "matrixMode": true|false,
  "totalPasses": 1 | N,
  "passes": [
    {
      "passIndex": 0,
      "device": { "name": "desktop", "viewport": {"width": 1280, "height": 720}, ... },
      "expectedFirstMcpCall": { "tool": "browser_resize", "args": {"width": 1280, "height": 720} },
      "logLine": "[device-profile] explicit → desktop (1280x720, touch=false) [pass 1/2]"
    },
    ...
  ]
}
```

## `duplicate-aria-label` FP note

**`duplicate-aria-label` FP note**: this rule has high false-positive rates
on grid/card layouts where shared "Edit" / "Delete" buttons are
contextually disambiguated by surrounding text. The scanner downgrades it
to P2 by default and only fires when the duplicates share the same `role`
AND same parent component region (closest `[role="list"]`, `[role="grid"]`,
`<table>`, `<form>` — see scanner impl). If you want it ignored entirely,
use `--scope ids` or `--scope forms`.

## Why `--with-modals` exists

**Why this matters**: React/Vue/Svelte mount duplicate IDs *into* the live
DOM when a modal opens. Static scan won't see them — they only exist while
the modal is mounted. This is exactly what static template audits miss.

## Severity intuition (Phase 5)

The authoritative severity-per-kind mapping is the table in Phase 4 ("Finding
taxonomy"). The intuition behind those assignments:

| Code | Rule |
|---|---|
| **P0** | Breaks core function: React reconciliation (duplicate IDs), form submission (no name on field — wait, that's P1; let me explain), screen-reader announcement (input/button with no accessible name), click-to-focus (orphan `<label for>`) |
| **P1** | Degrades experience but flow still works: aria-hidden focusable (non-`inert` subtrees only), empty `<a href="#">`, form-field-no-name — **only when the form has an `action`** (the browser natively submits and that field's value is dropped). An action-less form has no native submission path, so the same finding is **P3 advisory**: in a JS-driven form the missing `name` is often deliberate, and pressing to add one without `method="post"` would arm a credentials-in-URL leak on native fallback (found live 2026-07-30). |
| **P2** | Polish / a11y suggestion: heading-skip, img-no-alt (decorative needs `alt=""`), small-touch-target, positive-tabindex, duplicate-aria-label (high FP rate) |
| **P3** | Findings whose element was **not perceivable** in the captured state (severity capped here from `declaredSeverity`), plus reserved future suggestions (redundant ARIA, decorative-near-interactive) |

## Perceivability cap (2026-07-30) — why

**Why this matters.** A `<input type="file" hidden>` — the standard
custom-upload-button pattern — has `type === 'file'`, so it slips past the
`type === 'hidden'` filter and was reported **P0 `input-no-name`**. A field run
produced 704 findings of which ~6 were real: all 31 `aria-hidden-focusable`
findings sat inside one `visibility:hidden` subtree, and 4 of 5 P0s were hidden
file inputs.

> **Scope note — this is NOT a release-gate fix.** `/ship` does **not** gate on
> click-test P0s: persistence to the shared store is deferred (Phase 7 below), so
> no `record-click-test` subcommand, table or `/ship` read path exists, and
> `/ship --ignore-p0` refers to **persona-test** P0s only. The harm being fixed
> is a human reading a P0 list and treating it as blocking, plus the noise ratio.
> Correcting severity *now* is preventive: it means the deferred v2 persistence
> cannot turn a cosmetic wrong into a real false gate.

The predicate's canonical source is
[`scripts/lib/browser/perceivable.mjs`](https://github.com/Lbstrydom/claude-engineering-skills/blob/main/scripts/lib/browser/perceivable.mjs);
the copy inside `references/dom-scanner.md` is drift-checked by
`tests/click-test-perceivability.test.mjs`. `/nav-audit --verify` injects the same
function to qualify its `authSentinel`, which is why it is a module rather than
scanner-local.

## Touch targets over activating regions (2026-07-31) — why

**Why this matters.** The visually-hidden-input + styled-label pattern is
ubiquitous, and measuring only the input reports a *guaranteed* false positive.
Field data from a consumer run (2026-07-31):

| Element | Input's own box | Real tap target (its `<label>`) |
|---|---|---|
| `#filter-reduce-now` | 1×1 | **74×44** |
| `#wine-grouped-select-all` | 13×13 | **75×24** |

The perceivability cap above cannot reach this class: these inputs are
`visibility: visible` and genuinely **painted** at 1×1 — they are simply not the
thing the user touches. Without this rule, any codebase using the standard
styled-checkbox pattern carries a permanent floor of false positives that each
need manual DOM verification to dismiss.

**Contiguous regions, not a bounding-box union.** A `label[for]` may sit anywhere
in the document, so a union spanning the gap between two far-apart boxes would
describe an activating region that does not exist — trading the false positive
for a false *negative*. WCAG 2.5.8 is satisfied when **some single** activating
region is ≥24×24, so the rule passes on the first adequate region and reports the
largest one (that is the number a verifier will measure).

**Not a "has a label ⇒ exempt" escape hatch.** A control whose every activating
region is undersized still fires, and a label that is not perceivable does not
rescue one. Both are pinned in `tests/click-test-perceivability.test.mjs`.

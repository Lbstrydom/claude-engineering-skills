# Pre-Ship Empirical Verify — for skills that assert on a live runtime

> Moved from AGENTS.md (2026-07-13 sprawl trim) — full worked detail;
> AGENTS.md keeps the doctrine summary + pointer. Deepest worked example:
> `skills/visual-audit/references/ci-gate-and-verify.md` (*Gate honesty*).

The multi-LLM audit (GPT+Gemini over plan/code) catches *static* error classes —
logic gaps, contract holes, unhandled states. It **cannot** catch the
data/runtime-dependent class: a bug that only manifests when a real browser renders
a real app's real data. The `/visual-audit` shakedown proved both halves — the
audit-catchable bugs (a device type-mismatch crash; an empty-capture-looks-clean
gate) AND the audit-blind ones (a consumer naming its font tokens `--font-*` so they
misclassified; reading `getComputedStyle` mid-theme-transition → a *fabricated* bug
reported as ground truth for four passes). **No amount of LLM review finds the
second half; one real `--verify` run finds it immediately.**

So for any skill that drives a browser / asserts on a live runtime
(**visual-audit, nav-audit `--verify`, persona-test, persona-consistency,
click-test, ux-lock**): **run it against ONE real app before declaring it done.**
This is the missing layer — empirical, not another AI gate. A field finding with a
green repro has *zero* uncertainty about existence, so it routes to a **regression
test** (permanent, ~free) + **one** focused review — NOT the multi-round
adjudication loop (that exists to resolve *uncertainty*, which a repro already
killed; spending it on a confirmed field bug is the rigor-pressure cliff). Then feed
any audit-catchable class back into the code-audit checklist so the *next* skill
catches it statically — that's where multi-LLM review compounds.

## Two recurring browser-capture bug classes to check by name

Both found in the visual-audit shakedown; the survey below records sibling status.

- **Mid-state-change capture** — reading computed *paint* right after a programmatic
  state flip (theme/route) captures the interpolated FROM value. Freeze
  transitions/animations AT RUNTIME after the flip (init-script injection alone is
  unreliable — `addInitScript` runs at document-start where `document.head` is null)
  and `await document.fonts.ready` before any forced reflow (a naive reflow races
  web-font loading and fabricates geometry drift). *Status: specific to
  `visual-audit` (it's the only skill reconciling paint across state flips) — fixed
  in `extract.mjs`. nav-audit reads visibility/presence (not transitioned paint) +
  a 1500ms settle; ux-lock reads visibility only — neither is exposed.*
- **Empty/failed capture must not read clean** — if zero states/elements were
  captured (dead server, ERR_CONNECTION_REFUSED, non-2xx), the run must degrade to
  `unverified` / non-zero exit, never "verified / 0 findings." *Status: handled in
  `nav-audit` (`statesCollected===0` guard), `persona-consistency`
  (`navResponseStatus` surfaces non-2xx), and `visual-audit` (exit 2). Worth a glance
  in `ux-lock` if its capture path grows.*

## Audit your success paths, not just your failure paths

The two classes above are instances of a broader rule: every branch that can
emit *pass / clean / 0 findings / green* is where to be adversarial, because a
wrong "pass" is **invisible** — nothing alarms (the
"looks-protected-but-isn't" class). For any gate / check / validation, ask
*"can this return green without having actually checked anything?"* and guard
each such path (degrade to non-zero / `unverified`, never silent-clean). The
visual-audit `--gate` alone yielded six — static-mode-gate, dead-server,
all-surfaces-stalled, `--scope full` no-op, **no-surfaces-gate**, and
**no-merge-base-gate** (the last two: a `--gate` over an empty contract, or
`--scope diff` with no resolvable merge-base, used to *warn-then-exit-0* — the
honesty principle was applied to capture but not to scope resolution; both now
exit 2) — none caught by static review; each was found by treating a green
exit as guilty until proven to have checked something. Worked detail:
`skills/visual-audit/references/ci-gate-and-verify.md` (*Gate honesty*).

No new DB/schema for any of this — it's a process convention + `tests/`
regression guards + this checklist. Queryable persistence of "was this
field-tested" is data nobody reads back (the over-engineering cliff).

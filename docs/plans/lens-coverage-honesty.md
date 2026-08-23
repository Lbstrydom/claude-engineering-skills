# Plan: Lens Coverage Honesty — a report states what it checked, not only what it found

- **Date**: 2026-08-20
- **Status**: Approved and implemented (2026-08-20, via `/cycle --autonomous`,
  degenerate single-cluster path) — see §10 Implementation Log.
- **Origin**: `/brainstorm` session 1787245915261 (2026-08-20), focal artifact
  [`docs/research/verification-loops-brainstorm-briefing.md`](../research/verification-loops-brainstorm-briefing.md).
  The briefing asked which of three verification-loop candidates to build; the
  idea that outlived all three was none of them — **a verification report should
  state COVERAGE, not just pass/fail**, because *a green that checked nothing is
  indistinguishable from a green that checked everything*.
- **Scope**: prose, plus the **existing** `sync-shared-audit-refs.mjs` mechanism
  (including its `EXPECTED_CONSUMERS` registry — see §5). No new tooling — a
  construction boundary, not an aspiration.
- **Audit trail**: GPT plan-audit R1 (`NEEDS_REVISION`, H:2 M:4 L:1, 7/7
  accepted) → R2 (`SIGNIFICANT_GAPS`, H:3 M:1, 4/4 accepted) → R3
  (`NEEDS_REVISION`, H:2 M:2, 4/4 accepted). 100% acceptance all three
  rounds — productive, not rigor pressure; HIGH count 2→3→2. Stopped at the
  round-3 default cap per the acceptance-rate rule. Gemini final gate:
  round 1 `CONCERNS` (2 new, 0 wrongly-dismissed — a genuine chronology bug
  in the R3 audit-code fix, plus a hardcoded-kind bug in its own verdict
  label; both fixed) → round 2 **`APPROVE`** (0 new, 0 wrongly-dismissed,
  "architectural coherence: Strong"). Within the 2-round Gemini cap. See §9.

---

## Thesis in one paragraph

`/ship` Step 6.8 already carries the rule in its strongest form: *three terminal
states, and only three — `verified`, `failed`, `unverified`; and `unverified`
must name a concrete blocked prerequisite, never a bare "not applicable"*. That
rule is scoped to one step of one skill, about one artifact class (what a
consumer receives after a push). The same asymmetry it closes — **a check that
wrongly fails is annoying and visible; a check that wrongly passes is invisible**
— applies to every lens in the bundle that emits a verdict. This plan promotes
the rule from a `/ship` step to a bundle-wide reporting contract, in the one
place that already syncs to seven (soon eight) skills, and then closes the
three specific report formats where a clean verdict is currently emittable over
an unstated itinerary — being honest, per R2, about which of those three fixes
is a full structural rewrite and which is a documentation of what already
exists.

---

## §0 — Phase 0 census (MEASURED, and it shrank the plan)

**Method**: read every `SKILL.md` under `skills/` plus the report-format
reference of each lens that emits one, at working-tree revision `ed8da0e9`
(2026-08-20). Not inferred from plan statuses — this repo's plan statuses are
systematically stale, and the brief said so.

| Skill | Emits a verdict? | Coverage-honesty state at `ed8da0e9` | Work |
|---|---|---|---|
| **click-test** | yes | **FULL — the exemplar.** Per-route `coverageStatus` (`scanned` / `auth-required` / `readiness-timeout`); an explicit `covered` vs `gaps` predicate; a 6-rule verdict precedence in which `Clean` *requires* `covered`, `Incomplete` is the zero-findings-with-gaps label, and `Broken+Incomplete` exists so **issues are never masked by coverage gaps** | **none — copy it** |
| **visual-audit** | yes | **FULL for its shape.** Static run "emits **no** paint findings **and says so** (a banner)." Capture honesty degrades to `unverified` on empty sweep / all-ambiguous joins / zero cross-theme joins / partial device×theme matrix. Two *executable* gate oracles bind it | **none** |
| **nav-audit** | yes | **PARTIAL — and, per R2's H1, its report cannot be brought to FULL kernel conformance inside this plan's boundary.** `authLiveness` degrades authoritative verdicts to `unverified`; a `coverage-gap` finding kind already exists (`SKILL.md:178-180`). But nav-audit's structured output is largely rendered by `scripts/nav-audit.mjs` (a CLI script), unlike the agent-composed report templates in ux-lock/persona-test/audit-code — so a full per-run "subject/instrument" line and per-edge taxonomy-classified rendering would be a **code** change, which §5 rules out. This plan does not claim to close that gap; it documents what nav-audit already has and defers the rest by name (see §3.4) | **packaging fix (M4) + an honest limits note — not a report rewrite** |
| **investigate** | yes | **STRONG** — Step 3 already carries figure provenance | **none** |
| **ship** | yes | **SOURCE of the kernel** (Step 6.8) | **none** |
| **audit-plan** | yes | verdict is over a document, not a surface; no coverage axis to state | **none** |
| **ux-lock** | yes | **GAP — sharpest, and it has a downstream consumer** | **§1.1, §3.1** |
| **persona-test** | yes | **GAP — a different shape than click-test's (§2.3), needing its own session-record contract (R2 H2)** | **§1.2, §3.2** |
| **audit-code** | yes | **GAP — and "ran" turned out to need five states, not the four I first drafted (R2 H3)** | **§1.3, §3.3** |
| plan · explain · cycle · brainstorm · security-strategy · ai-context-management · skills | no findings-over-a-surface verdict | n/a | none |

**Phase 0's answer to the question it was given**: three skills of structural
work, one canonical edit, one packaging fix. **Not seven, and not a fourth
report rewrite for nav-audit either** — R2 corrected an overclaim in this
row that R1 had already gotten partly wrong.

---

## §1 — The three gaps

### §1.1 ux-lock VERIFY — a skipped criterion is invisible to the verdict *and* to the gate

**Measured at `ed8da0e9`:**

- `skills/ux-lock/references/verify-mode-generation.md:116 (ed8da0e9)` — if no
  semantic hook can be added, *"flag the criterion as un-verifiable in Step V5
  and **skip it** rather than emitting a brittle assertion."*
- `skills/ux-lock/references/verify-mode-generation.md:209 (ed8da0e9)` — the
  rubric: *"`PLAN_SATISFIED` — all P0 and P1 criteria pass."*
- The report template (`…:190-208 (ed8da0e9)`) prints `Criteria: N total`, a
  per-severity `passed/total`, `Satisfaction: pct%`, `Status:`, and the failing
  P0 list. **There is no skipped line.**
- `skills/ux-lock/SKILL.md:296-300 (ed8da0e9)` — `/ship` gates on
  `plan_satisfaction.failing_p0_criteria`.

**The failure**: a skipped criterion neither passes nor fails, and the prose
rubric has no third state. A plan whose P0 criteria were largely un-verifiable
can read `PLAN_SATISFIED` with an empty failing-P0 list — and `/ship` will not
block, because a skipped criterion is correctly *not a failure*.

**The decisive finding, and why this is a prose fix rather than a code one.**
The store already draws exactly the right distinction, and has since
`supabase/migrations/20260704120000_plan_verify_skipped.sql`:

- `plan_verification_items.skipped` is a first-class column, and
  `plan_verification_runs.skipped_count` a first-class run field, written by
  `scripts/lib/store/plan-verification.mjs` (`skipped: item.skipped === true`).
- The migration's own column comment: *"A criterion with NO matching test is a
  coverage gap, NOT skipped — it stays a failure."*
- `satisfaction_pct` is `passed_count / total_criteria`, and `total_criteria`
  **includes** skipped. The stored number is already honest.

So the data layer is correct and complete. **Only the report format and the
status rubric fail to surface it.**

> **A second measurement, the same defect class one level up.**
> `skills/ux-lock/gate-contract.json`'s `status-rubric` gate justifies its
> `document-only` disposition with *"the … status rubric is computed by the
> verify runner over live plan_satisfaction data."* Measured: `PLAN_SATISFIED`
> occurs in exactly seven files — three under `skills/ux-lock/`, one under
> `skills/ship/references/`, and their three generated copies under
> `.claude/skills/`. **No script computes it**; it is emitted by the model from
> prose. The *disposition* is right; its stated *reason* is false. Correcting
> the reason string is in scope (§3.1).

### §1.2 persona-test — a verdict over a run that cannot enumerate what it missed

**Measured at `ed8da0e9`**, `skills/persona-test/SKILL.md:531-570`:

- The report header records persona, URL, focus, device, and `N steps`.
- `OVERALL: Ready for users | Needs work | Blocked`.
- The one coverage guard (`authWallUntested`) caps OVERALL at `Needs work`.

**The failure**: an 8–12 step exploration ends with zero findings and emits
`Ready for users`. `N steps` says how much was *done*, never what was *reached*.

**R1's H1, and why it invalidated my first design.** The R1 draft proposed a
`Reached` / `Not reached` block modelled on click-test's per-route table.
GPT correctly rejected it: *"a step record can prove only what was reached. It
cannot establish the complete set of applicable surfaces, nor distinguish an
unvisited route from an undiscovered route."* This is structural, not a
wording problem — `skills/persona-test/SKILL.md:369-379 (ed8da0e9)` (Phase 3,
Plan→Act→Reflect) shows the loop is **adaptive**: each step's "Plan" is
decided from what the persona has seen so far, not read off a pre-declared
itinerary. Phase 2 (`:351-368`) produces a five-dimension *profile*
(background, intent, first actions, patience, abandonment threshold) — not a
step-by-step plan either. There is no upfront list, inside the skill or
outside it, to diff "reached" against.

**R2's H2 sharpened the fix further**: even the boundary-disclosure design
(§2.3) needs its own defined vocabulary — "reached," "loop ended," and the
auth/origin state each need an exhaustive, non-ambiguous enum, or the new
report is exactly as unfalsifiable as the one it replaces, just with fewer
words. §3.2 now specifies a compact session work-record.

### §1.3 audit-code — a failed pass leaves no trace in the convergence report

**Measured at `ed8da0e9`:**

- `skills/audit-code/SKILL.md:729 (ed8da0e9)` — *"**Graceful degradation** —
  failed passes, missing keys, missing ledger all skip cleanly."*
- `skills/audit-code/SKILL.md:194-195 (ed8da0e9)` — the architectural-memory
  catalogue *"degrades to a silent, non-blocking `unavailable` state."*
- `skills/audit-code/SKILL.md:518-542 (ed8da0e9)` — Step 5.0b re-runs every
  detector at full scope; `evaluateConvergenceWithDetectors` requires
  `blocked === false`, but nothing distinguishes a detector that ran and found
  zero from one that errored before it could look.
- Step 6's convergence report (`SKILL.md:551-563`) prints `Final: H:0 M:2 L:1`,
  rounds, time, cost, files changed. **No field records which passes ran.**
- The five passes are named in code, not just prose:
  `scripts/lib/prompt-seeds.mjs:290-294 (ed8da0e9)` —
  `structure`/`wiring`/`backend`/`frontend`/`sustainability`. The three
  mechanical waves are named in `scripts/lib/audit-shadow.mjs:96` —
  `quickfix`/`duplication`/`adjacency`.

**The failure**: `H:0` from a run where the backend pass 4xx'd is
typographically identical to `H:0` from a run where all five passes and every
mechanical wave completed. "Skip cleanly" is fail-open phrasing — clean for the
*run*, silent for the *reader*.

**R1's H2** flagged that "ran" conflates attempted with successful. **R2's H3
went further and caught a real bug in my own R1 fix**: the amendment I wrote
to `SKILL.md:729` said a failed pass is *"reported as skipped"* — a fifth
word that did not exist in the four states (`ran-clean`/`errored`/`ineligible`/
`unavailable`) I had just defined two paragraphs earlier. §3.3 replaces the
whole design with a per-row census over stable pass/wave/capability
identifiers and a corrected five-state set that adds the missing `not-reached`.

---

## §2 — The kernel: `verification-discipline.md` §7

**One edit, to the canonical file only**:
`docs/audit/shared-references/verification-discipline.md`. The existing
`node scripts/sync-shared-audit-refs.mjs` propagates it byte-identically to
its consumers, and `npm run check` byte-verifies the copies. **Edit the
canonical, never a copy.**

### §2.1 Placement and framing

New section **§7 — A report states its coverage, not only its verdict**, placed
after §6, framed as a generalisation of §6: §6 says `unverified` must name a
concrete blocked prerequisite for one artifact class (what a consumer receives
after a push); §7 says the same sentence applies to every surface a lens
declines to check.

### §2.2 The three obligations, and the taxonomy that serves them

1. **The subject line — what was checked, with what instrument.** A verdict
   without an itinerary is unfalsifiable.

2. **The non-coverage line — what had no applicable check, and why, by a named
   kind.** For a lens that enumerates a bounded surface set (a route list, a
   pass/wave set), every surface **never attempted** carries a reason of one of
   **four** kinds:

   - `blocked` — a concrete missing prerequisite (an auth wall with no
     bootstrap, no network, an absent credential *or unset config for an
     optional capability* — the latter is still a nameable, concrete thing:
     "AUDIT_DB_URL unset", not a vaguer "disabled"). §6's rule verbatim.
   - `out-of-scope` — another lens owns it; **name that lens**.
   - `not-reached` — the run's own budget ran out (step cap, route list,
     device matrix, node budget) before the surface was attempted.
   - `not-applicable` — the check does not apply here at all: a detector
     ineligible for the resolved repo/language/scope, or a surface no lens in
     the bundle owns (an honest `not-applicable, unowned` is itself useful
     information — a gap in the *bundle*, not a defect in the *run*).

   **A surface that WAS attempted but did not complete is a different thing
   from a surface that was never attempted** (R2 H3, closing a hole R1 opened
   by conflating them). Call the attempted-but-failed outcome `errored`. It is
   **not** one of the four kinds above and must not be folded into one —
   doing so would hide whether the check ran at all, the exact ambiguity this
   section exists to prevent. Both `errored` and the four never-attempted
   kinds count as "not covered" for the obligation-3 verdict coupling below,
   but each is reported under its own distinct label.

   A bare "not applicable" with no kind and no name is not a reason.

3. **The verdict coupling — the clean label is reserved for a run that was
   also complete.** Zero findings plus a non-empty non-coverage line (of
   either shape — never-attempted or errored) gets a *distinct* label from
   zero findings with nothing uncovered. And: **issues are never masked by
   coverage gaps** — a run with findings *and* gaps surfaces both, never
   collapses to the gap label (click-test's rule).

### §2.3 Three shapes, not two — and not everything is an enumeration

Per §0's exemplars, generalised, and corrected by R1's H1:

- **Enumeration** (click-test, audit-code passes/waves) — the lens itself
  discovers or defines a bounded surface set, so it owes a per-surface state
  using the §2.2(2) vocabulary (one of the four never-attempted kinds,
  `errored`, or clean).
- **Degradation** (visual-audit) — a single verdict downgrades to `unverified`
  when capture is incomplete, carrying the same vocabulary applied to the
  capture as a whole, not per-surface.
- **Boundary disclosure** (persona-test, and any lens whose exploration is
  *adaptive* — plan-as-you-go rather than crawl-a-known-set) — there is no
  surface set to enumerate honestly, so the report states what was **actually
  reached** plus the **boundaries that bounded the run** (step budget, declared
  focus, safety-policy origin restriction, auth state), from a defined session
  record (§3.2), and says explicitly that this is not an inventory scan. The
  §2.2(2) taxonomy does **not** apply here — there is nothing to classify by
  kind, because there is no enumerated set for a kind to describe an entry of.

**A fourth case, named so it is not silently absorbed into one of the three
(R2 H1):** a lens whose report is **code-rendered** (a CLI script's own
output), not agent-composed from a SKILL.md template, cannot be brought to
full §7 conformance by this plan without a code change — out of scope by §5.
Such a lens is documented honestly: which existing mechanisms already serve
one of the three obligations, and which remain deferred, by name, as a
future code-bearing follow-up. nav-audit is the one instance (§3.4); this is
not a fourth shape to design for, it is a scope boundary to state.

§7 states the obligation and names all three shapes plus this boundary; it
prescribes no single artefact.

### §2.4 The reciprocal warning §7 must carry

**A coverage block is itself a claim, and an unchecked coverage block is the
same defect one level up.** So: **derive the block from the run's own record**,
never compose it at report time. Where nothing is recorded, the honest block
says that — it does not reconstruct.

### §2.5 The `summary:` frontmatter decision (trap 3)

**Measured**: `scripts/lib/skill-refs-parser.mjs` byte-compares **only**
`summary:` against the index row; `Read when` is checked for non-emptiness
only. **Decision: leave `summary:` unchanged** — zero SKILL.md reference-index
rows need editing for the kernel edit itself, so `skills:check` cannot fail on
it. `Read when` cells (outside the byte-match contract) are updated in the
touched skills to name the new trigger.

---

## §3 — Per-skill touch-ups

### §3.1 ux-lock (largest, and entirely prose)

**`references/verify-mode-generation.md`:**

1. **Add a skipped count to the report template**, and extend the evaluated
   denominator to **both** P0 and P1 (R1 M1 — the draft exposed it for P0
   only):

   ```
   Criteria: <N> total  (<passed> passed · <failed> failed · <skipped> skipped)
     P0: <passed>/<evaluated_p0> passing   (<skipped_p0> not evaluated)
     P1: <passed>/<evaluated_p1> passing   (<skipped_p1> not evaluated)
   ```

   `evaluated = total − skipped`, stated per severity so no reader has to infer
   a scope.

2. **A full, mutually-exclusive, first-match-wins precedence table** (R1 M1):

   ```
   1. PLAN_NOT_SHIPPED — any P0 criterion FAILED (evaluated, not passing).
   2. PLAN_PARTIAL     — not (1), AND (any P0 or P1 SKIPPED, OR any P1 FAILED).
   3. PLAN_SATISFIED   — all P0 and P1 criteria evaluated (zero skipped among
                          P0/P1) AND passing.
   ```

   First match wins. A failed P0 always reads `PLAN_NOT_SHIPPED` regardless of
   what else in the run is skipped. **P2/P3 skipped criteria never affect the
   label.**

   **Zero-evaluated rendering (R3 M2)**: when `evaluated_<severity> = 0` (every
   criterion at that severity was skipped), render `not evaluated (0
   evaluated; N skipped)` instead of a `0/0` fraction — a bare `0/0` reads as
   either total success or a calculation error, and it is neither. The
   precedence table's logic already handles this correctly without change:
   an all-skipped severity has `skipped > 0`, which fails rule 3's "zero
   skipped among P0/P1" condition and falls through to `PLAN_PARTIAL` — only
   the *rendering* was undefined, not the *outcome*.

3. **State plainly what the label is and is not**: `PLAN_SATISFIED` /
   `PLAN_PARTIAL` / `PLAN_NOT_SHIPPED` is **model-emitted report prose — no
   script computes it, and it is neither persisted nor parsed.** `/ship`'s gate
   reads `plan_satisfaction.failing_p0_criteria` directly (which the store
   already excludes skipped items from) — never this label.
4. **Record the downstream consequence beside the rubric**: a skipped P0 is
   invisible to the `/ship` gate **by design** — the report is the only place
   it can surface.
5. **Extend §V5's skip instruction**: flagging a criterion un-verifiable is
   legitimate; *dropping it from the report* is not.

**`SKILL.md`**: one line at Step V6 pointing at the skipped-criteria rule;
`Read when` cell updated per §2.5.

**`gate-contract.json`**: **two entries**:
- correct the existing `status-rubric` gate's `reason` string per §1.1's
  second measurement — stays `document-only`, reason updated to state the
  truth (agent-emitted from prose, no script, no exit code);
- add a **new** `document-only` gate, `status-rubric-precedence`, covering the
  first-match-wins table in item 2, same honest-reason pattern.

### §3.2 persona-test (redesigned per R1 H1 and R2 H2 — boundary disclosure over a defined session record)

**A session work-record, populated by Phase 3 as each action completes,
rendered by Phase 5 and never composed fresh** (R2 H2's fix — this is what
makes the boundary-disclosure block falsifiable rather than merely honest-sounding):

| Field | Definition |
|---|---|
| `visitedSurfaces` | ordered list of `{path, action}`, appended by Phase 3 after each Act step. Identity = normalized pathname (query/hash stripped, redirect followed to final URL); the list is a **chronological transition log**, not a deduped set — a reload is a repeat entry, not a new reach. The report's "N screens" figure is `unique(pathname)` over this list, computed at render time from the log, never asserted independently |
| `stepCount` | `{completed, cap}` — `cap` is the configured budget (8–12 per Phase 3, or an explicit override); `completed` is the number of Act steps the loop actually executed |
| `declaredFocus` | the `--focus` argument verbatim, or the literal string `"none — exploratory"` |
| `originPolicyResult` | one of `same-origin-only` (default; nothing cross-origin attempted) / `cross-origin-attempted-and-blocked` (the persona tried; Phase 3's safety policy refused) / `n/a` |
| `terminalReason` | **exhaustive, closed enum**: `goal-reached` / `step-budget-exhausted` / `abandonment-threshold-hit` / `auth-wall-blocked` / `tool-error` / `safety-refusal` — the loop already knows which applies when it stops; this only requires recording the enum value, not computing a new one |
| `authState` | `n/a-no-auth-encountered` / `authenticated-via-bootstrap` / `auth-wall-untested` (the last aligns with the existing `authWallUntested` flag) |

Report block, rendered strictly from the record above:

```
COVERAGE (relative to this persona's own session — not an inventory scan)
────────────────────────────────────────────────────
  Reached:        /  →  /cellar  →  /cellar/add   (3 unique screens, 9/12 steps)
  Loop ended:     <terminalReason>
  Focus:          <declaredFocus>
  Origin:         <originPolicyResult>
  Auth:           <authState>

  Not a surface-complete scan: this persona explored as it naturally would,
  not exhaustively. For surface-complete coverage, run /nav-audit or
  /click-test against the same URL.
```

**Verdict coupling — a composed eligibility predicate, not a single-field
check (R3 H1's fix).** The R2 revision capped `Ready for users` on
`terminalReason === 'goal-reached'` alone. R3 caught that this silently drops
the pre-existing `authWallUntested` guarantee: per `SKILL.md:409-410`, the
loop **continues** exploring public surfaces after an untested auth wall
rather than terminating, so `authState: 'auth-wall-untested'` and
`terminalReason: 'goal-reached'` can genuinely coexist in one session — a
single-field check would then wrongly clear the run as Ready. `Ready for
users` requires a clean run **and every one** of:

```
terminalReason      === 'goal-reached'
authState           !== 'auth-wall-untested'
originPolicyResult  !== 'cross-origin-attempted-and-blocked'
```

Any failing conjunct caps the verdict at `Needs work`, and the report renders
**every** failing conjunct by name (a run can fail more than one). This
generalises `authWallUntested`'s existing cap as one named conjunct of the
predicate — not implied by another field, not a special case beside it, and
not silently reachable around.

**`gate-contract.json`**: new `document-only` gate, `overall-verdict-boundary-cap`,
covering the generalised cap rule — same disposition class as click-test's
`verdict-precedence` (no CLI exit code; the verdict is computed by the agent
running the MCP-driven loop).

### §3.3 audit-code (redesigned per R2 H3 around a corrected five-state set, then given a lifecycle per R3 H2)

**Named states** — corrected from the four in the R1 draft (which R2 caught
introducing an undefined fifth, `skipped`, in prose two paragraphs later),
and `ran-clean` renamed to `completed` per R3's M1 (it collided linguistically
with "clean" meaning zero findings — a `backend completed` row next to
`Final: H:2` is unambiguous where `backend ran-clean` was not; **invariant**:
a `completed` pass stays `completed` regardless of whether it emitted zero,
one, or many findings — finding counts live in the existing severity totals,
never in this state):

| State | Meaning | Kernel mapping (§2.2) |
|---|---|---|
| `completed` | finished without error, applicable to the resolved scope | covered |
| `errored` | started, did not complete (exception, timeout, non-2xx from a provider) | attempted-but-failed, its own label — never folded into the four kinds |
| `ineligible` | does not apply to this repo's resolved language/scope (e.g. a frontend-specific pass on a backend-only diff) | `not-applicable` |
| `unavailable` | a concrete missing prerequisite — e.g. `AUDIT_DB_URL` unset for the architectural-memory catalogue | `blocked` |
| `not-reached` | the round's control flow did not get to this pass/wave before stopping | `not-reached` |

`not-reached` is included for consistency with the kernel taxonomy but is
**expected to be rare for audit-code**: all five passes and three mechanical
waves execute unconditionally every round by design, and Step 5.0b's
full-scope detector re-run is mandatory for convergence to be assessed at
all. If it appears, it signals an aborted run (killed process, hard timeout).

**A per-round execution record, not just a report shape (R3 H2's fix, then
corrected for a chronology bug by Gemini's G1).** R2's design specified the
desired census rows without saying where they come from; R3 correctly named
this as the same gap §2.4 exists to prevent — a coverage block composed at
report time rather than derived from a record. The record:

- **`arch-memory` is resolved once, before any round, never re-seeded
  `pending` (Gemini G1's fix).** Step 0.5 (`SKILL.md:50`) runs exactly once
  per audit-code invocation, **before** Step 1 (scope selection) and before
  Step 2's round loop begins — it is not inside the "Round 1 / Round 2+"
  structure that Step 2 contains. The R3 draft had Step 2 seed `arch-memory`
  `pending` at *each* round's start and Step 0.5 "transition" it — backwards,
  since Step 0.5 already finished before round 1's Step 2 even runs, and does
  not run again for round 2+. Corrected: Step 0.5 determines `arch-memory`'s
  state once — `completed` or `unavailable` under `--scope=full`, `ineligible`
  under `--scope=diff` (Step 0.5 is `--scope=full only`, §2.2's "not
  applicable" kind, distinct from `unavailable`'s "configured off") — and that
  single resolved value is carried forward and rendered identically in
  **every** round's census. It is never `pending` and never re-transitioned.
- **The five passes and three mechanical waves ARE seeded fresh each round**:
  at Step 2's round start, seed one row per pass/wave identifier as `pending`.
  Each owning step transitions only its own row(s): the five passes' dispatch
  (Step 2) transitions each to `completed`/`errored`/`ineligible`; the
  duplication wave (Step 2, Wave 5) and the quickfix/adjacency waves
  (Step 5.0b, Wave 6) transition theirs on their own invocation.
- **An aborted round finalizes every untouched pass/wave row as
  `not-reached`** at round-end, rather than leaving them `pending` (which the
  report must never render — `pending` is a mid-round state, not a reportable
  one). `arch-memory`'s row is unaffected by this — it was never `pending` to
  begin with.
- **Step 6 renders the current round's finalized pass/wave rows plus the
  once-resolved `arch-memory` row** — not cumulative across rounds for the
  former. An earlier round's pass/wave failures are that round's own
  convergence report, already shown when it ran; Step 6 does not re-surface
  them, closing R3's explicit question about which round the report reflects.

**One row per planned pass, mechanical wave, and optional capability, with
stable identifiers** (R2 H3's core demand — an aggregate count is not a
census), rendered from the record above, never recomposed:

```
CENSUS
  structure          completed
  wiring              completed
  backend             errored      (timeout after 90s)
  frontend            completed
  sustainability      completed
  quickfix (wave)     completed
  duplication (wave)  completed
  adjacency (wave)    completed
  arch-memory         unavailable  (AUDIT_DB_URL unset)
```

identifiers are the real ones — `structure`/`wiring`/`backend`/`frontend`/
`sustainability` from `scripts/lib/prompt-seeds.mjs:290-294`,
`quickfix`/`duplication`/`adjacency` from
`scripts/lib/audit-shadow.mjs:96`'s `MECHANICAL_WAVES` — not invented labels.
Every non-`completed` row carries a mandatory concrete reason in parentheses.

**Verdict coupling — the suffix names every kind present, not just `errored`
(Gemini G2's fix).** The R3 draft's example census above has **two**
non-`completed` rows of two *different* kinds (`backend errored`, `arch-memory
unavailable`), but its compound-label rule hardcoded `(1 errored — see
census)` — silently dropping `arch-memory`'s gap from the top-level verdict,
exactly the "issues never masked by coverage gaps" rule (§2.2 obligation 3)
this plan exists to enforce. A round with any non-`completed` row cannot print
a bare `CONVERGED`; it prints a suffix listing the count **per kind actually
present**, e.g. for the example census above:
`CONVERGED (1 errored · 1 unavailable — see census)`. A round with only
`ineligible` rows (an expected scope exclusion, e.g. no frontend passes on a
backend-only diff) is named as `ineligible`, never folded into "errored" —
mislabelling an expected exclusion as a failure is its own honesty bug. This
is the same compound-label move click-test's `Broken+Incomplete` makes,
generalised to an arbitrary kind-count rather than one hardcoded kind.

**Step 5.0b's "To determine" resolved, not left open:**
`evaluateConvergenceWithDetectors`'s existing code-level gate
(`blocked === false`) is **untouched** — no code change, per §5. What changes
is purely the human-readable census: a detector that errors during the
full-scope re-run is reported as `errored`, never silently folded into "the
census reached zero." The exit-2 case ("ledger could not be read … never a
pass") is already a hard code-level non-pass and is unaffected. Visibility
only — Step 6.7 / Step 7 (Gemini review) already has standing to act on what
the census now makes visible.

Amend `SKILL.md:729`'s *"failed passes, missing keys, missing ledger all skip
cleanly"* to split its three bundled causes into their correct states: a
failed pass → `errored`; a missing key for an optional pass → `unavailable`;
a missing ledger affects R2+ rulings-injection and suppression, a **different
mechanism** from pass/wave execution, and is out of this census's scope by
definition — named here so it is not mistaken for a fourth state rather than
silently dropped.

**`gate-contract.json`**: new `document-only` gate,
`convergence-census-and-label`, covering both the per-row census requirement
and the `CONVERGED (…)` compound-label rule as one gate (R2's M1 catches that
splitting this into two entries had produced a miscount — see §4 Trap 1's
disposition matrix) — reason: both are composed by the agent from the
round's own pass/wave outcomes in the convergence report; the underlying
convergence *boolean* is already covered by the existing
`convergence-threshold` executable gate, this wraps its human-readable label.

### §3.4 nav-audit — a packaging fix and an honest limits note, not a report rewrite (narrowed per R2 H1)

**R1's finding, still correct and unchanged**: `scripts/lib/skill-packaging.mjs`'s
strict packaging contract ships a skill's own `SKILL.md` plus shallow Markdown
under its own `references/`/`examples/` — nothing repo-root-level. A prose
pointer from a packaged `nav-audit/SKILL.md` at an installed consumer to
`docs/audit/shared-references/verification-discipline.md` resolves for
nobody but this repo's own contributors.

**The packaging fix, unchanged**: add `'nav-audit'` to
`EXPECTED_CONSUMERS['verification-discipline.md']` in
`scripts/sync-shared-audit-refs.mjs`. One-entry edit to a data map the
**existing** script already reads generically (`findSyncTargets` explicitly
supports the bootstrap case). Running the existing
`node scripts/sync-shared-audit-refs.mjs` after this edit creates
`skills/nav-audit/references/verification-discipline.md` as a byte-identical
copy. **Not new tooling** — see §5's explicit carve-in.

**What changed per R2's H1**: the R1 draft implied this packaging fix, plus a
one-line pointer, made nav-audit's *report* conform to the new §7 kernel. It
does not, and — per §2.3's new fourth case — cannot inside this plan's
no-code-changes boundary, because nav-audit's structured output is rendered
by `scripts/nav-audit.mjs`, not composed by the agent from a SKILL.md
template the way ux-lock/persona-test/audit-code's are. So the SKILL.md
change is now explicitly a **documentation, not implementation**, fix:

In `skills/nav-audit/SKILL.md`'s existing "Honest limits" section
(`:201-212`), add one paragraph naming which existing mechanisms are already
instances of the kernel's obligations — the `coverage-gap` finding kind
(`:178-180`, obligation 2's `not-reached`/`not-applicable` territory, already
surfaced as findings rather than silently dropped) and the `authLiveness`
degradation table (`:140-159`, obligation 3, one axis) — and states plainly
that a full per-run subject-line and per-edge taxonomy-classified rendering
(obligations 1 and the rest of 2) is **deferred**, because reaching it would
require changing `scripts/nav-audit.mjs`'s own output, which is code and is
out of this plan's scope. This is a **named, honest deferral**, not a silent
one — the difference this whole plan is about.

Add the reference-table row (`file`, `summary` — copied verbatim from the
canonical's frontmatter per §2.5's byte-match rule, `read when` — "reading
the Honest limits section, to see which existing mechanisms already serve
§7's obligations").

No `gate-contract.json` change for nav-audit — nothing verdict-shaped is
being added, only a documentation pointer.

---

## §4 — Pre-registered traps, and what measurement (and three audit rounds) did to each

### Trap 1 — a coverage claim is a gate claim

**Measured, and broader than pre-registered.**
`scripts/lib/gate-honesty/verb-pattern.mjs` freezes an enforcement-verb set
(`blocks/block/fails/fail/exits/exit/refuses/refuse/requires/require/must/
never/always/threshold/thresholds/cap/caps/max/gate/gates`); any new or
modified line in a contracted skill's `SKILL.md` containing one as a whole
word is a candidate, and must be covered by a gate's `stated` string or an
`ignoredCandidates[].line` entry — diff-scoped, contracted-skills-only. All
touched skills (ux-lock, persona-test, audit-code, nav-audit) are contracted.

**Disposition matrix (R2 M1's fix — the exact count that was wrong, and the
mapping GPT asked for so a reviewer does not have to re-derive it):**

| Skill | Gate id | Disposition | Covers |
|---|---|---|---|
| ux-lock | `status-rubric` (existing, corrected reason) | `document-only` | the existing "`PLAN_SATISFIED` — all P0 and P1 criteria pass" claim, reason now stating it is agent-emitted prose |
| ux-lock | `status-rubric-precedence` (new) | `document-only` | the §3.1 item 2 first-match-wins table |
| persona-test | `overall-verdict-boundary-cap` (new) | `document-only` | the §3.2 generalised `terminalReason`-driven verdict cap |
| audit-code | `convergence-census-and-label` (new) | `document-only` | the §3.3 per-row census requirement AND the `CONVERGED (…)` compound label, as one gate |

**Four entries, not five** — R2's M1 correctly counted the R1 draft's
enumerated work at four and found "five" repeated as an arithmetic error
across §4/§5/§6/§7. Corrected throughout this revision.

**Disposition rationale, per precedent, not an invented oracle**: click-test's
`verdict-precedence` gate is already `document-only` for the identical class
(agent-computed verdict, no CLI exit code). All four entries above follow the
same pattern, each with an honest reason naming *why* no registry oracle
applies. Extending the closed v1 oracle registry to mechanise these would be
new tooling (out of scope, §5) and would misrepresent what actually enforces
them — the agent reading the prose, not a script.

### Trap 2 — audit the success paths (every row dispositioned, per AC7)

| Branch | Can it green having checked nothing? | Disposition |
|---|---|---|
| ux-lock verify → `PLAN_SATISFIED` | **YES**, before this plan | `closed-here` — §3.1 items 1-3 |
| ux-lock LOCK → Step 5 `Passes: ✓ chromium-desktop, ✓ chromium-mobile` | Possibly, if the spec asserts something trivially true | `out-of-scope-with-reason` — governed by Step 2.5's existing prove-RED mandate; a spec-quality concern this plan does not touch |
| audit-code Step 6 → `CONVERGED … H:0` | **YES**, before this plan | `closed-here` — §3.3 |
| audit-code Step 5.0b → detector re-run | **YES** for the human-readable census (the code gate itself was already sound) | `closed-here` — §3.3's Step 5.0b resolution |
| persona-test → `Ready for users` | **YES**, before this plan | `closed-here` — §3.2 |
| persona-test Phase 6b → correlation summary self-verify | N/A to this plan | `out-of-scope-with-reason` — the 2026-08-11 `isP0OrP1` field-contract incident is a separate, already-resolved defect class, not a coverage-reporting gap |
| nav-audit `--gate` → exit 0 | No | `no-hole` — `authLiveness` degradation already covers it |
| nav-audit's own report → full §7 conformance | Cannot be claimed by this plan | `out-of-scope-with-reason` — code-rendered report, would need a `scripts/nav-audit.mjs` change; named and deferred, not silently gapped (R2 H1) |
| visual-audit `--gate` → exit 0 | No | `no-hole` — six prior holes found and closed; two executable oracles now bind it |

The last two rows are the control: this interrogation has been run before on
those skills and found real holes, which is why they now read clean.

### Trap 3 — frontmatter is a contract

Resolved in **§2.5**. Verification: `npm run skills:check` must pass after the
canonical edit — and per verification-discipline §3, it must also be **seen to
fail**: temporarily alter the canonical's `summary:` line without touching the
index rows, confirm `skills:check` goes red naming the mismatch, then restore.
Recorded in the Implementation Log (§10) when this plan executes.

---

## §5 — Hard boundary (by construction)

**In scope**: Markdown edits to one canonical reference, four `SKILL.md` files
(ux-lock, persona-test, audit-code, nav-audit), two reference files
(`verify-mode-generation.md` edited; `nav-audit/references/verification-discipline.md`
created, but only via the sync bootstrap — never hand-authored); three
`gate-contract.json` files carrying **four** gate-entry changes (ux-lock's
existing entry corrected + one new; persona-test one new; audit-code one new
— see §4 Trap 1's disposition matrix); propagation by the **existing**
`node scripts/sync-shared-audit-refs.mjs`; a **one-entry edit to that
script's own `EXPECTED_CONSUMERS` map** (§3.4 — data read by existing
generic code, not a new code path); regeneration of `.claude/skills/**` by
the **existing** `npm run skills:regenerate`.

**Out of scope, by construction — if a phase proposes one of these it has left
scope, and the correct response is to say so and stop:**

- any new script, npm script, hook, or CI step;
- any extension of the gate-honesty **oracle registry** (`cli-exit`,
  `convergence-threshold`, `tiered-shadow-window`, `visual-gate-unverified` is
  a closed v1 set) — every gate this plan adds is `document-only`;
- any change to `skills:check`, `gates:check`, or the ratchet, **beyond the
  one `EXPECTED_CONSUMERS` entry named above**, which those checks already
  validate generically;
- any code that **computes** a coverage block, verdict label, or state
  (`completed`/`errored`/etc.) — every one of these is agent-emitted prose per
  §4 Trap 1's disposition;
- **any change to `scripts/nav-audit.mjs`'s own report rendering** — named
  explicitly per §3.4/R2 H1, because it is the one place in this plan where
  "just write the prose fix" was tried and found to require code.
- any migration.

**The one place this boundary genuinely bites, stated rather than half-fixed**:
this plan makes ux-lock's **report** honest about skipped criteria. It does not
and cannot change what the **store** exposes downstream — and it does not need
to, because §1.1's measurement shows the store is already correct. Separately,
this plan does **not** bring nav-audit's report to full kernel conformance —
§3.4 documents what exists and defers the rest by name, because closing it
would cross into code.

*Adjacent observation, deliberately not actioned*:
`scripts/lib/store/plan-verification.mjs` retries the item insert without the
`skipped` column on Postgres `42703`, so a consumer DB predating migration
`20260704120000` records skipped criteria as failures. That direction
**over**-reports failure — visible, not silent — so it is outside this plan's
defect class. Noted so it is not rediscovered as new.

---

## §6 — Acceptance criteria

1. `docs/audit/shared-references/verification-discipline.md` carries §7 with
   the three obligations (§2.2), the three-shapes-plus-boundary framing
   (§2.3), and the reciprocal warning (§2.4). Its `summary:` line is
   byte-unchanged.
2. `node scripts/sync-shared-audit-refs.mjs` propagates it; `npm run check`
   reports zero drift across all **eight** consumers (seven existing +
   nav-audit).
3. `npm run skills:check` passes — **and was seen to fail** under the §2.5
   negative control, with the red output recorded in the Implementation Log
   (§10).
4. `npm run gates:check` passes: every enforcement-verb line added to a
   contracted skill is covered by a gate `stated` or an `ignoredCandidates`
   entry, matching §4 Trap 1's disposition matrix exactly (four entries).
5. `node --test tests/gate-honesty.test.mjs` passes, including ux-lock's
   corrected `status-rubric` reason and the three new gate entries.
6. Each of the three touched report formats, read cold, follows a documented
   format in which the clean label is never adjacent to a silently-omitted
   coverage/boundary line. This is a **documentation conformance** claim, not
   a mechanical-enforcement one — consistent with every gate above being
   `document-only`.
7. Every row in §4 Trap 2's table carries the disposition recorded there
   (`closed-here` / `out-of-scope-with-reason` / `no-hole`) — filled at
   authoring time in this revision, not deferred to implementation.
8. nav-audit's `SKILL.md` change is verified to be documentation-only: a diff
   of `scripts/nav-audit.mjs` across this plan's implementation is empty.

---

## §7 — File manifest

| File | Change |
|---|---|
| `docs/audit/shared-references/verification-discipline.md` | **+§7** (the kernel). `summary:` untouched |
| `skills/{investigate,audit-code,ux-lock,ship,explain,plan,audit-plan}/references/verification-discipline.md` | regenerated by the existing sync — **never hand-edited** |
| `scripts/sync-shared-audit-refs.mjs` | one-entry `EXPECTED_CONSUMERS` addition (`'nav-audit'`) |
| `skills/nav-audit/references/verification-discipline.md` | **new** — created by the sync's bootstrap path, not hand-authored |
| `skills/ux-lock/references/verify-mode-generation.md` | skipped counts (P0+P1); full precedence table; "prose, not code" note; V5 amendment |
| `skills/ux-lock/SKILL.md` | Step V6 pointer; `Read when` cell |
| `skills/ux-lock/gate-contract.json` | corrected `status-rubric` reason; **new** `status-rubric-precedence` gate |
| `skills/persona-test/SKILL.md` | session work-record schema; COVERAGE block (boundary-disclosure shape); generalised verdict cap; `Read when` cell |
| `skills/persona-test/gate-contract.json` | **new** `overall-verdict-boundary-cap` gate |
| `skills/audit-code/SKILL.md` | per-row census (5 passes + 3 waves + arch-memory), corrected five-state set; `:729` amendment split into its three causes; Step 5.0b resolution; `Read when` cell |
| `skills/audit-code/gate-contract.json` | **new** `convergence-census-and-label` gate |
| `skills/nav-audit/SKILL.md` | reference-table row; one documentation-only paragraph in "Honest limits" naming existing mechanisms + the deferred, code-bearing rest |
| `.claude/skills/**` | regenerated by `npm run skills:regenerate` |

**Four `SKILL.md` files. Two reference files touched/created. Three
`gate-contract.json` files carrying four gate-entry changes** (corrected from
the R2-flagged "five" arithmetic error — see §4 Trap 1's disposition matrix,
which is now the single source of truth for this count).

---

## §8 — Sequencing

1. **§2 kernel first**, then sync (including the `EXPECTED_CONSUMERS` edit —
   nav-audit's bootstrap copy must exist before nav-audit's SKILL.md can
   reference it).
2. **ux-lock** next — largest, sharpest, and the only one with a downstream
   consumer.
3. **audit-code**, then **persona-test**, then **nav-audit**'s reference row +
   Honest-limits paragraph.
4. **Gate dispositions last**, in one pass, following §4 Trap 1's disposition
   matrix exactly — `gates:check` is diff-scoped, so dispositioning while
   prose is still moving means redoing it.

**Risk**: the trap-1 disposition volume is the schedule risk, not the prose. If
it proves larger than the four-entry matrix above, the correct response is to
**tighten the prose to use fewer enforcement verbs** where meaning permits —
not to widen `ignoredCandidates` with thin reasons, which would be this plan's
own defect class committed against itself.

---

## §9 — Audit-round corrections (summary, for the audit trail)

**R2** (H:3 M:1, 4/4 accepted) caught four real problems in the R1 revision,
not rigor pressure:

1. **nav-audit overclaim (H1)** — R1 implied a cross-reference made nav-audit's
   report conform to the new kernel; it can't, without a code change §5 rules
   out. Narrowed to a documentation-only fix (§3.4, §0, §2.3's new "fourth
   case").
2. **persona-test's undefined vocabulary (H2)** — "Reached" and "Loop ended"
   had no canonicalization rule or exhaustive enum. Added a session
   work-record schema (§3.2) that Phase 3 populates and Phase 5 renders from.
3. **audit-code's internal inconsistency (H3)** — the R1 draft's own amendment
   introduced a `skipped` state absent from its own four-state table.
   Redesigned around a corrected five-state set and a per-row census over real
   pass/wave/capability identifiers (§3.3).
4. **Arithmetic error (M1)** — "five" gate entries was wrong; the real count
   is four, now tracked by a single disposition matrix (§4 Trap 1) rather than
   restated informally in four different sections.

**R3** (H:2 M:2, 4/4 accepted) caught two further real problems — both
refinements of designs R1/R2 had already fixed, not new categories, which is
why round 3 was the stopping point:

1. **persona-test's cap still had a hole (H1)** — the R2 fix capped `Ready for
   users` on `terminalReason === 'goal-reached'` alone, but `SKILL.md:409-410`
   shows the loop *continues* past an untested auth wall rather than
   terminating, so that field and `authState: 'auth-wall-untested'` can
   coexist — the single-field check would have silently dropped the
   pre-existing `authWallUntested` guarantee. Replaced with a composed
   eligibility predicate naming every boundary field as an independent
   conjunct (§3.2).
2. **audit-code's census had a report shape but no record lifecycle (H2)** —
   symmetric to R2's H2 fix for persona-test. Added initialization, per-step
   ownership, abort handling, and which round's record Step 6 renders (§3.3).
3. **Naming collision (M1)** — `ran-clean` read as "no findings" next to a
   `Final: H:2` line. Renamed to `completed`, decoupled from finding count by
   an explicit invariant.
4. **Undefined edge case (M2)** — an all-skipped severity produced an
   undefined `0/0`. Defined the rendering; the precedence-table *logic*
   already handled the case correctly (§3.1).

**Gemini G1** (`CONCERNS`, 2 new, 0 wrongly-dismissed) caught two further real
problems — both inside the audit-code lifecycle the R3/H2 fix had just added,
which is exactly the seam a second independent reviewer is for:

1. **Chronology bug (G1, HIGH)** — R3's H2 fix said `arch-memory` is seeded
   `pending` at each round's Step 2 start and transitioned by Step 0.5 — but
   Step 0.5 runs once, *before* Step 2's round loop even begins, and does not
   re-run for round 2+. The instruction as written was chronologically
   unexecutable. Fixed: `arch-memory` is resolved once, never seeded
   `pending`, and its single resolved value is carried forward into every
   round's census (§3.3).
2. **Hardcoded-kind bug (G2, MEDIUM)** — the R3 example census had two
   non-`completed` rows of two different kinds, but the compound-label rule
   hardcoded `(1 errored — …)`, silently dropping the `unavailable` row from
   the top-level verdict — the exact "issues masked by gaps" failure §2.2
   obligation 3 exists to prevent, reintroduced by this plan's own fix. Fixed:
   the suffix names every kind present, with its own count (§3.3).

---

## §10 — Implementation Log

### 2026-08-20 — implemented via `/cycle --autonomous` (degenerate single-cluster path)

Implemented as one unit (no §11 block — below the clustering threshold).

**Red-then-green negative control (AC3, §2.5, §4 Trap 3)** — two, since the
frontmatter contract has two enforcement points:
1. Mutated the canonical's `summary:` line only (no re-sync). `node
   scripts/sync-shared-audit-refs.mjs --check` → **RED**, exit 1, all 8
   consumers correctly reported `drifted from canonical`. Restored via `git
   checkout`; re-ran → clean (0 drifted).
2. Mutated `skills/nav-audit/references/verification-discipline.md`'s
   frontmatter only (its SKILL.md index row left untouched). `node
   scripts/check-skill-refs.mjs` → **RED**, exit 1, naming the exact expected
   mismatch (index text vs. frontmatter text). Restored via `git checkout`;
   re-ran → 16/16 passed.

**Gate-honesty D6 diff-scoped candidate coverage (AC4).** `resolvePushRange()`
cannot infer a range in this worktree (`inference-forbidden`) — confirmed by
running with `AUDIT_PUSH_RANGE_REQUIRED=1` first and observing the intended
hard failure, per the sandbox-honesty rule (a check must not read as clean
having verified nothing). Re-ran with an explicit
`AUDIT_PUSH_RANGE_BASE=ed8da0e9…/AUDIT_PUSH_RANGE_HEAD=<impl commit>` against
the real diff: first pass surfaced 27 undispositioned enforcement-verb lines
across ux-lock/persona-test/audit-code (hand-predicting line-wrap boundaries
before running the real diff would have missed several — the tool's output
was used verbatim as the `ignoredCandidates[].line` values). Second pass:
clean, 4 new/corrected document-only gates registered exactly as §4 Trap 1's
disposition matrix specified (ux-lock ×2, persona-test ×1, audit-code ×1),
zero undispositioned lines.

**§4 Trap 2 disposition re-check (AC7)**: all 8 rows re-read against the
code as implemented — no disposition changed. The two `no-hole` rows
(nav-audit/visual-audit `--gate`) were not touched by this plan by
construction.

**`scripts/nav-audit.mjs` untouched (AC8)**: confirmed — only
`skills/nav-audit/SKILL.md` and the newly-bootstrapped
`skills/nav-audit/references/verification-discipline.md` changed for
nav-audit; no `scripts/` file was edited for it.

**Deviation from the plan not anticipated in §7's file manifest**:
`tests/gate-honesty.test.mjs` needed a one-shot edit — it pins the exact v1
census of contracted-skill gate ids (`PINNED_DOCUMENT_ONLY` per skill + a
`totalDocOnly` count assertion) specifically so a coverage change can never
drift silently. `npm test` caught this immediately (`gate-honesty — real
skills/ … matches the pinned v1 census exactly`), which is the test doing
its job, not a plan defect — §5's "no new tooling" boundary covers new
scripts/checks, not registering a plan's own new gate ids with an existing
pinning test that exists for exactly this purpose. Added the 3 new
document-only gate ids to their skills' `PINNED_DOCUMENT_ONLY` arrays and
bumped `totalDocOnly` 45 → 48, each with a dated comment matching this
file's existing convention. `node --test tests/gate-honesty.test.mjs`:
40/40 pass after the fix.

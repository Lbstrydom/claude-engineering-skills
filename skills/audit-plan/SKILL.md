---
name: audit-plan
description: |
  Iteratively audit a plan file (docs/plans/*.md) with GPT + Gemini final gate.
  Multi-round refinement with an acceptance-rate early-stop (3 rounds default).
  Ledger-driven suppression on R2+ rounds prevents finding churn.
  Judges the plan DOCUMENT before anyone builds it. "Was the plan actually
  built?" is /ux-lock verify — that reads a live app, this reads only the file.
  Triggers on: "audit the plan", "iterate on the plan", "plan-audit",
  "audit docs/plans/", "review the plan", "is this plan good",
  "check the plan", "/audit-plan".
  Usage: /audit-plan <plan-file>             — Audit existing plan iteratively
  Usage: /audit-plan <task-description>      — Generate plan with /plan, then audit
---

# Plan Audit Loop

> **This skill's last line is an end marker naming the skill between em-dashes, after
> the Reference files table.** If that last line is not in your context (context
> compaction keeps only the start of a skill), re-read
> `.claude/skills/audit-plan/SKILL.md` in full before continuing — the later steps,
> including the mandatory final gate, still apply.

Iteratively refine a plan with GPT + Gemini final review until findings
plateau, then gate with the independent reviewer.

**Input**: `$ARGUMENTS` — either a plan file path (PLAN_AUDIT) or a task
description with no path (PLAN_CYCLE: generate-then-audit).

<!-- host-contract: input-acquisition; grammar=path+flags; empty=ask-and-stop -->

**Where `$ARGUMENTS` comes from** — orchestrator-supplied input first, else
the host's verbatim invocation suffix, else the span of the user's **current**
message naming this skill or its subject. Never inferred from surrounding
conversation. This site is `path+flags`; on empty input, ask whether to audit an existing plan or generate one, and stop — the two modes cost differently and are not interchangeable.
Full contract: `references/input-acquisition.md`.


> **Worktree preflight** — in a linked git worktree the synced tooling tree
> `scripts/.claude-skills/` is absent — it is gitignored, so `git worktree add`
> does not populate it, and every command below that uses it dies on a bare
> `MODULE_NOT_FOUND`. Run `npm run skills:hydrate` first. If this repo defines
> no such script, add it from `references/worktree-preflight.md`.

---

## Step 0 — Parse Input and Validate

| Input | Mode |
|---|---|
| `<plan-file>` | PLAN_AUDIT — audit existing plan iteratively |
| `<task description>` (no path) | PLAN_CYCLE — generate plan, then audit |

Validate: the helper scripts resolve, and a GPT route is available —
`OPENAI_API_KEY` **or** an active Azure profile (`AZURE_OPENAI_ENDPOINT`); ask
which ROUTE exists, not whether one variable is set. `GEMINI_API_KEY` for Step 6
(falls back to Claude Opus when absent). `AUDIT_DB_URL` for cloud learning
(optional).

**If a prerequisite does not resolve, follow `references/prerequisite-ladder.md`
— do not proceed as though it did, and do not die mid-flow.** It defines the
hydrate-then-retry step for absent helper scripts, the labelled adversarial-agent
substitute when the GPT legs have no route, and which of `AUDIT_DEGRADED` /
`AUDIT_NOT_RUN` to report so a run that did not happen stays distinguishable
from one that passed.

Initialise session ID: `SID=audit-plan-$(node -e "process.stdout.write(Date.now()+'-'+process.pid)")` — epoch ms plus a PID, so two sessions started in the same second get separate result, stderr and ledger files.

Kickoff card: `/audit-plan — [MODE] — Starting | Plan: <path> | 3 rounds default | SID: $SID`.

---

## Step 1 — Plan Generation (PLAN_CYCLE only)

<!-- host-contract: no-dispatch; preserves=step-order,step3-pause,skip-flags,blocked-propagation -->

> **No skill-to-skill dispatch on this host?** Open `.claude/skills/plan/SKILL.md` and
> follow it inline, passing the task description explicitly (orchestrator-supplied
> input, rule 0 of `references/input-acquisition.md`), then return here with the
> persisted plan path. Same fallback `/cycle` documents; blocked results must
> still reach this skill rather than being swallowed by the inlined planner.

Generate the plan with `/plan` (auto-detects backend / frontend / full-stack; pass
`--scope=…` if detection is wrong). Save to `docs/plans/<name>.md`. Skip for PLAN_AUDIT.

---

## Step 2 — Run Plan Audit

```bash
# PLAN_FILE = the ONE plan path /audit-plan was invoked with, assigned verbatim.
# Not a glob: an assignment does not expand it, so the CLI would get the pattern itself.
node scripts/openai-audit.mjs plan "$PLAN_FILE" --mode plan --out .audit/$SID-r1-result.json 2>.audit/$SID-r1-stderr.log
```

**Critical**: always pass `--mode plan`. Without it, Gemini in Step 6 can flag
absent implementations (the plan describes work that doesn't exist yet, which
is by design for plan-audit).

**Round 2+** — injects prior rulings as exclusions and suppresses re-raises against
the ledger:

```bash
node scripts/openai-audit.mjs plan "$PLAN_FILE" --mode plan --round 2 --ledger .audit/$SID-ledger.json --out .audit/$SID-r2-result.json 2>.audit/$SID-r2-stderr.log
```

Plan audit is single-file — no `--passes`, `--diff`, or `--changed`. When
`.requirements/ledger.json` exists the prompt gets a `<requirements_rubric>`
automatically; no flag. Show a results card per round:
`ROUND N PLAN AUDIT — <verdict> | H:x M:y L:z | Cost: ~$… | Top: [H1] …`.

---

## Step 3 — Triage (validity × scope × action)

For each finding, record three orthogonal judgements:

| Dimension | Values | Meaning |
|---|---|---|
| **validity** | `valid` / `invalid` / `uncertain` | Is the concern real for THIS plan? |
| **scope** | `in-scope` / `out-of-scope` | Does it cite a section the plan owns? |
| **action** | `fix-now` / `defer` / `dismiss` / `rebut` | What happens next? |

### Triage rules

- `validity=invalid` → action MUST be `dismiss` or `rebut`
- `validity=uncertain` → action MUST be `rebut` (GPT deliberation)
- `validity=valid` + `scope=in-scope` + HIGH/MEDIUM → `fix-now`
- `validity=valid` + `scope=out-of-scope` + **load-bearing** → `fix-now` (fold into the plan)
- `validity=valid` + `scope=out-of-scope` + **independent** → `defer` to "Out of Scope (Future)" plan section
- `validity=valid` + `scope=in-scope` + LOW → operator choice

**Scope is decided by impact, not ownership (load-bearing test).** "The plan
doesn't own that section" is NOT a defer pass. Ask: *does the success of this
plan's design depend on the cited concern?* **Load-bearing** → fold the resolution
into the plan (or an explicit dependency note stating the assumption and how it is
validated); **never silent-defer it**. **Independent** → defer. A `defer` must name
the independence in one sentence; if you can't write it truthfully, it's
load-bearing. When the cited concern is in a module/table the plan's design reads or
writes, independence needs the two-part answer (same column/constraint? same
transaction instance?) → `references/triage-rubrics.md` §Same-module independence.

**Rubrics — apply each; full text in `references/triage-rubrics.md`, read the section
when its condition holds:**
- **Grounding** — a non-trivial plan (≥6 files, ≥2 subsystems, a dependency chain, or
  >1 sitting) whose §1 Code Trace lacks concrete `file:line` refs **and a call path** is
  **HIGH `ungrounded-plan`**; spot-check each "what exists today" claim that drives a
  design decision — a design built on a mis-described existing contract is HIGH; an unpinned `file:line`
  is LOW (ask for `path:line (sha)`).
- **Test-premise lint** — "tests already cover X" with no executed command + result
  attached is a build-time spike, not evidence: flag it. Naming a source/field must
  also prove its semantics match the contract.
- **§11 clustering** (plan has the block) — check partition, coupling soundness,
  fix-gate placement, contiguous ordering, derived scope; a malformed block that would
  make `/cycle` build on un-audited coupled code is HIGH. `author-tier:` is advisory —
  never a finding.

### Tiered rebuttal

| Severity | Deliberation |
|---|---|
| HIGH | ALWAYS send to GPT deliberation |
| MEDIUM | ALWAYS send to GPT deliberation |
| LOW | Claude decides locally |

Only send rebuttal if rebut HIGH or MEDIUM findings exist:

```bash
REBUTTAL_FILE=.claude/tmp/rebuttal.md   # the rebuttal text you wrote for the disputed finding(s)
node scripts/openai-audit.mjs rebuttal "$PLAN_FILE" "$REBUTTAL_FILE" --out .audit/$SID-resolution.json 2>.audit/$SID-rebuttal-stderr.log
```

### Convergence — early-stop on rigor pressure

**Key on the ACCEPTANCE RATE, not the finding count.** `write-ledger-entries`
prints it for the round you just triaged (`acceptance 92% (accepted 11 ·
dismissed 1 · deferred 0)`):

| Acceptance rate this round | Read |
|---|---|
| **≥ ~⅔ accepted as fix-now** | **PRODUCTIVE** — the round bought real corrections. Continue (within the cap). |
| **≤ ~⅓** | **STOP** — you are dismissing/deferring most of what arrives. That is rigor pressure by definition. |
| in between | Decide on finding *character* (below), not on counts. |

The count is a **secondary backstop**, read with the rate (a rising HIGH count alone
is not a stop signal — fixes create new surface; evidence in
`references/convergence-evidence.md`):

| Condition | Action |
|---|---|
| HIGH count rising **and** acceptance rate low | **STOP** — the loop is manufacturing work |
| HIGH count rising **and** acceptance rate high | Continue — the plan is gaining real surface |
| HIGH count dropping | Continue (the classic converging case) |
| R2+ findings push for v2 features, parser deps | **STOP** — record as "Out of Scope" |

**Cap: 3 rounds, 5 absolute — enforced by `openai-audit.mjs`.** Round 4 exits
`4` (`CAPPED`) with a structural-or-stop card: a stop for a human call, never a
retry (`references/round-cap-and-structural-card.md`). At round 3 without
convergence run `node scripts/audit-structural-card.mjs --sid "$SID" --mode plan --plan "$PLAN_FILE"`
and **present the card to the operator** with its three choices (STOP /
STRUCTURAL / CONTINUE); continuing is their call. An **implementation-completeness**
finding ("specify the store step") belongs to the code audit. Record the call
(rounds, acceptance rate, card verdicts, why) in the plan's audit trail.

When stopping with deferrals, append a `## Out of Scope (Future)` section to
the plan listing deferred concerns with rationale.

**Step 6 (Gemini final review) is MANDATORY** after the last audit round,
regardless of convergence. No-key degradation ladder (same as audit-code's
`references/gemini-gate.md` — never a silent skip): Gemini → Claude Opus
fallback → an **independent adversarial review agent** over the plan +
findings (record its verdict in the same APPROVE/CONCERNS/REJECT shape) →
only when none of those is available, output `FINAL_GATE_SKIPPED` and do
not claim full final-gate validation.

---

## Step 3.5 — Update Adjudication Ledger

After each deliberation round, write ledger entries for every finding before
Step 4 — the ledger drives R2+ rulings injection and suppression. Write the
`--triage` file with an editor, never as a shell string (rationale prose has
apostrophes). Invocation + status semantics: `references/ledger-format.md`.

**Step 3.5b — record triage outcomes.** Cloud labels are automatic:
`write-ledger-entries.mjs` labels the round it triaged, and each R2+ `openai-audit.mjs
plan` re-checks the prior round. **Only if a `[finalize] WARN` line appeared**, run the
manual fallback in `references/convergence-evidence.md` §Step 3.5b. `labelled: 0` with a
non-zero `total` is a failure, never a pass. **Every round, also** record dismissed
scope-pressure findings into the LOCAL PlanFpTracker, so future plan audits suppress the
recurring ones:

```bash
# --outcomes = THIS round's finding ids and actions (the two below are an example only)
node scripts/write-plan-outcomes.mjs --result ".audit/$SID-r$ROUND-result.json" --outcomes '[{"id":"M3","action":"dismiss"},{"id":"H1","action":"fix-now"}]'
```

## Execution order

**Wait for rebuttal BEFORE editing the plan.** 1. send rebuttal (rebut HIGH/MEDIUM)
→ 2. wait for the response → 3. write the ledger (3.5) → 4. outcomes (3.5b,
automatic) → 5. edit the plan (Step 4) → 6. re-audit (Step 5).

---

## Step 4 — Edit Plan

Plans are single files — apply fixes via `Edit`. ALL HIGH must be addressed (fix or
defer-with-rationale). MEDIUM until ≤2 remain. LOW optional. Show a card:
`EDITING PLAN — N findings | Fixed: a | Deferred to "Out of Scope": b | Dismissed: c`.
After editing, update ledger entries to `remediationState: 'fixed'` for fixed items.

## Step 5 — Verify and Loop (R2+)

Re-audit with R2+ mode (Step 2) on the same plan path, passing `--round <N>` and
`--ledger .audit/$SID-ledger.json`; track churn with `_hash` (resolved / recurring /
new). Stop per the convergence rule above (acceptance rate primary; 3 rounds
default, 5 absolute).

---

## Step 6 — Gemini Independent Review (MANDATORY)

Run the final reviewer — the newest Gemini Pro by default (`latest-pro`, resolved at runtime; override with `FINAL_REVIEW_MODEL`) as the final gate. Falls back to Claude Opus when
`GEMINI_API_KEY` is absent.

**Build the transcript first** — the reviewer reads a file no earlier step
writes. One command; never hand-assemble the JSON:

```bash
node scripts/build-audit-transcript.mjs --sid $SID
```

It folds every `.audit/$SID-r<N>-result.json` and `.audit/$SID-ledger.json` into
`.audit/$SID-transcript.json` (mode inferred from the `audit-plan-` prefix).

```bash
RUN_ID=$(node -e "const fs=require('fs'); try { process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],'utf8'))._cloudRunId||''); } catch (e) { process.stderr.write('RUN_ID: result artifact unreadable (' + e.message + ') - the verdict will NOT be written back'); }" ".audit/$SID-r$ROUND-result.json")
node scripts/gemini-review.mjs review "$PLAN_FILE" .audit/$SID-transcript.json --mode plan --round 1 --run-id "$RUN_ID" --out .audit/$SID-gemini-result.json 2>.audit/$SID-gemini-stderr.log
```

**`--mode plan` is as load-bearing here as it is in Step 2** (it defaults to `code`,
which flags the absent implementations). **`--run-id` arms the `gemini_verdict`
write-back** — omit it and the verdict is recorded nowhere (measurement in
`references/convergence-evidence.md`).

Act on the result's code-computed `gateDisposition` (the `verdict` word is the
reviewer's own): `approve` → done. `approve_with_debt` → done — every remaining
finding is `release_blocking: false`; record each (id, severity, one line) in
the plan's Remaining / debt section (or `node scripts/debt-auto-capture.mjs
--final-review .audit/$SID-gemini-result.json`); never ask the user to override
it. `blocked` → deliberate on the named blocking items, edit the plan, re-run
as round 2 with `--round 2 --prior .audit/$SID-gemini-result.json --out
.audit/$SID-gemini-result-v2.json`.

### Gemini round cap — **max 2 rounds** (symmetric with the GPT cap)

**Hard cap: 2 Gemini rounds** — `gemini-review.mjs` refuses `--round 3`. After
round 2, if the disposition is still `blocked`:

| Round-2 finding character | Action |
|---|---|
| Concrete **design** defect (wrong contract, unsafe migration, dangling FK) | Fix it in the plan, then escalate to the user with the round-2 result — there is no third round |
| **Implementation-completeness** (missing step, parameter placement, "specify X") | **STOP** — fold into the plan as captured items; hand off to `/cycle`'s **code** audit, which verifies them against real code (the right artifact) |
| Rising **coherence/praise** + 1 nit/round | **STOP** — diminishing returns; record the nit, close the gate |

Never a third round for rigor pressure or implementation detail (why:
`references/convergence-evidence.md`). Record the stop decision (round count + why)
in the plan's audit trail. Deliberation protocol and category-error handling:
`references/gemini-gate.md`.

---

## UX Rules

1. Status card after every phase
2. Never dump raw JSON — parse and summarise
3. Show every plan edit with file + line reference
4. Cost tracking: `cost ≈ (input × 2.5 + output × 10) / 1M`
5. Batch all user decisions into one prompt

---

## Reference files

This skill's canonical flow is above. The files below cover specialised
situations — read them only when the trigger applies.

| File | Summary | Read when |
|---|---|---|
| `references/input-acquisition.md` | Where a skill's arguments come from on any host, and what to do when there are none. | Reading $ARGUMENTS on a host that does not substitute it, or deciding what empty input means at a site. |
| `references/triage-rubrics.md` | Step 3 rubrics in full — impact-test detail, grounding, test-premise lint, and the §11 execution-clustering checks. | Step 3 — applying a rubric whose one-line form leaves the call borderline, OR ruling on same-module independence. |
| `references/convergence-evidence.md` | Why the stop rules are what they are — acceptance-rate evidence, Gemini-cap rationale, outcome-recording fallback. | Step 3/6 — a stop decision is contested, OR a `[finalize] WARN` line appeared and Step 3.5b needs the manual fallback. |
| `references/ledger-format.md` | Adjudication ledger schema + writer invocation example for each finding outcome. | Step 3.5 — about to write ledger entries, OR diagnosing R2+ suppression misbehaviour. |
| `references/gemini-gate.md` | Step 7 Gemini independent review protocol — transcript, verdict handling, re-review loop. | Step 6 starting, OR Gemini returned CONCERNS/REJECT and need deliberation rules. |
| `references/round-cap-and-structural-card.md` | Enforced GPT round cap (plan 3/5, code 6/8), exit 4 CAPPED, and the structural-or-stop card read at the cap. | A round exited 4, OR the audit reached round 3 without converging. |
| `references/prerequisite-ladder.md` | Step 0 prerequisite ladder — absent helper bundle or auditor route, and reporting a run that did not happen. | Step 0 — a prerequisite did not resolve (helper scripts missing, no GPT route), OR about to report a run that degraded or did not happen. |
| `references/verification-discipline.md` | Verification discipline — pinned citations, figure provenance, two-direction proof, attribution, consumer-side checks. | Step 3 — applying the grounding rubric to a plan whose Code Trace cites `file:line`. |
| `references/worktree-preflight.md` | Worktree preflight remedy — the skills:hydrate npm script to add when a linked worktree lacks the tooling tree. | A command dies with `MODULE_NOT_FOUND` in a linked worktree AND this repo has no `skills:hydrate` script. |

— end of /audit-plan —

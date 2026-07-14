# IBM Full Stack — Breadth Evidence: `claude-engineering-skills`

Evidence dossier for the Kolb reflective essay (MSc Computer Science, IBM Full Stack
Software Developer certificate). Breadth-oriented: several insights across the
certificate, each pinned to a real, citable artefact in **this** repo.

- **Repo**: `claude-engineering-skills` (public). First commit `9c20840`, **2026-03-25**.
- **Concept alignment cross-read** (evidence not taken from these): `ibm-fs-00-index.md`,
  `ibm-fs-01-intro-software-engineering.md`, `ibm-fs-04-git-github.md`,
  `ibm-fs-14-generative-ai.md` in `C:\obsidian\Second Brain\2 Areas\6 Tech & AI\1 Foundations\Industry Specialisation\`.
- **Capture dates used for the per-module dating test**: C1 = **2026-06-22**,
  C4 = **2026-06-26**, C14 = **2026-07-11**.
- **Dating rule applied**: an artefact is COURSE-APPLIED only if it postdates *its own*
  module's capture date. Birth-vs-body is split honestly: several core files were born
  in March–May (PRE-COURSE) but carry a dated post-capture rewrite that IS course-applied;
  where that is so, the rewrite commit is cited, not the birth commit.
- **Provenance boundary**: this repo's skills are the subject. Where a skill was *run*
  against another repo (wine-cellar-app), the findings it produced there belong to that
  repo. Nothing below claims another repo's output as this repo's evidence.

> **Headline honesty note.** The repo predates the certificate by three months, so the
> *architecture* of the audit loop (multi-model orchestration, convergence, rebuttal) is
> **PRE-COURSE**. The course supplied the vocabulary (agentic loop, compound AI system,
> control-logic spectrum) to name what already existed. What is genuinely COURSE-APPLIED
> is the July 2026 work: empirical model evaluation, blast-radius gating of autonomous
> spend, and the "audit your success paths" testing doctrine. Those are the strongest
> citations and they are dated cleanly.

---

## Course 1 — Introduction to Software Engineering (capture 2026-06-22)

Concepts mapped (from `ibm-fs-01`): the six quality processes (testing verifies behaviour
*against requirements*; quality is built in step by step, not inspected at the end);
classic SDLC stages; CI/CD as automated build-and-test on each change.

### C1-A. "Pre-ship empirical verify" — a testing doctrine born from a *fabricated* bug

| | |
|---|---|
| **Type** | Doc / engineering doctrine (project instructions, read by every agent session) |
| **Location** | [AGENTS.md:366-388](AGENTS.md#L366-L388); full version extracted to [docs/pre-ship-empirical-verify.md](docs/pre-ship-empirical-verify.md) |
| **Dates** | Introduced `3204910` **2026-06-26**; extracted to `docs/` in `f78852c` **2026-07-13** |
| **Classification** | **COURSE-APPLIED** (postdates the 2026-06-22 C1 capture by four days) |

Snippet (AGENTS.md:368-388, abridged):

```markdown
The multi-LLM audit catches *static* error classes; it cannot catch bugs that
only manifest when a real browser renders a real app's real data (the
visual-audit shakedown proved this — a mid-theme-transition `getComputedStyle`
read *fabricated* a bug that survived four review passes).
...
3. **Audit your success paths**: any branch that can emit
   pass/clean/0-findings/green is where to be adversarial — ask *"can this
   return green without having actually checked anything?"* (the visual-audit
   `--gate` alone yielded six such holes; none caught by static review).
```

Reproduce: `git show 3204910 -- AGENTS.md`

**Why it is interesting**: it is the course's "testing verifies against requirements"
principle inverted into its sharpest form — *the reviewer itself can be wrong*. Four
passes of LLM review confirmed a bug that did not exist, because the capture was taken
mid-transition. The remedy is not more review; it is running the thing against a real
app once. And rule 3 is the non-obvious one: the dangerous branch is not the failing
one, it is the branch that can report **green without having checked anything**. That is
"quality is built in step by step, not inspected at the end", learned the expensive way.

### C1-B. Convergence criteria as an executable quality gate

| | |
|---|---|
| **Type** | Skill definition |
| **Location** | [skills/audit-code/SKILL.md:247-263](skills/audit-code/SKILL.md#L247-L263) |
| **Dates** | File born `b5f1274` **2026-04-27**; materially rewritten post-capture — `b9474f5` **2026-06-28** ("runtime-truth audit rules + topology honesty"), `6cf88fc` **2026-06-29** (deterministic outcome capture) |
| **Classification** | **PRE-COURSE** on the convergence design; the cited post-capture rewrites are COURSE-APPLIED on the body. Cite it as *"the course gave me the vocabulary (CI/CD, quality gates) for a mechanism I had already built"*. |

Snippet:

```markdown
### Convergence
Quality threshold: `HIGH == 0 && MEDIUM <= 2 && quickFix == 0`

| Condition | Action |
|---|---|
| Threshold NOT met | Fix → re-audit |
| Threshold met, new architectural | Fix → re-audit (stability resets) |
| Threshold met, mechanical only | Fix → re-audit (stability NOT reset) |
| Threshold met, 0 new, 2/2 stable | **CONVERGED** → Step 6, then REQUIRED Step 7 |
| Round 6, not stable | Present to user, then REQUIRED Step 7 |
```

**Why it is interesting**: "done" is defined as a *stability property over rounds*, not a
count of issues fixed. Two consecutive rounds producing nothing genuinely new — and a
deliberate asymmetry, where an architectural finding resets the stability counter but a
mechanical one does not, because only judgement-calls signal the audit is still learning.
It is a termination condition, which is a stronger object than a checklist.

### C1-C. The composite pre-push gate

| | |
|---|---|
| **Type** | Config / script |
| **Location** | [package.json:43](package.json#L43); installer at [scripts/install-prepush-hook.mjs:1-12](scripts/install-prepush-hook.mjs#L1-L12) |
| **Dates** | `check` script pre-dates capture; its newest member, `context:check` (fails when AGENTS.md exceeds 1200 lines), landed `f78852c` **2026-07-13** |
| **Classification** | **PRE-COURSE** (gate); **COURSE-APPLIED** on the 2026-07-13 addition |

```json
"check": "npm run context:check && npm run skills:check && npm run plans:lint && npm run efficacy:check && npm test"
```

**Why it is interesting**: local-first CI (the course's build-automation-server idea, run
on the developer's own pre-push hook rather than a hosted runner). The interesting member
is `context:check` — a gate on the *documentation's* size, on the theory that an
instruction file loaded into every AI session is a runtime cost, so doc sprawl is a
build-breaking regression, not a style nit.

---

## Course 4 — Git and GitHub (capture 2026-06-26)

Concepts mapped (from `ibm-fs-04`): the staging→commit model; a disciplined workflow with
traceability; "link the exact commit, not the repo root"; reversible history.

### C4-A. Generated-artifact policy — deciding what belongs *under* version control

| | |
|---|---|
| **Type** | Doc (invariant) + the commit that applied it |
| **Location** | Policy: [AGENTS.md:38-63](AGENTS.md#L38-L63). Applied: commit **`966cf30`** — *"chore(sync): gitignore the source sync-manifest (kill perpetual-dirty churn)"* |
| **Dates** | Policy born `881d298` **2026-06-04** (PRE-COURSE); the sync-manifest clause + the 298-line untracking landed **2026-06-28** |
| **Classification** | **COURSE-APPLIED** on the body (`966cf30`, two days after the C4 capture) |

Reproduce: `git show --stat 966cf30` (deletes `scripts/.sync-manifest.json`, 298 lines,
from tracking; adds the gitignore entry and the AGENTS.md clause).

The policy's decision rule:

```markdown
The test for a tracked generated file: *would two regenerations on the same
commit be byte-identical, and does a check enforce it?* If no → it belongs in
A (gitignore it), not committed. A committed artifact whose dirtiness carries
no information is churn, not a reference.
```

**Why it is interesting**: this is the single most useful thing the Git module's staging
model implies and never says out loud — the working tree is a *signal*, and a file that
is dirty on every push destroys that signal. The manifest carried a timestamp and a HEAD
sha, so it could never be a pure function of committed source; tracking it meant every
`git status` lied. The rule generalises into a two-category test (deterministic-from-source
→ commit **and** freshness-verify it; anything else → gitignore), with the middle ground
explicitly named as the failure mode.

### C4-B. `/ship` — the docs-sync → stage-by-name → commit → push pipeline

| | |
|---|---|
| **Type** | Skill definition |
| **Location** | [skills/ship/SKILL.md:363-396](skills/ship/SKILL.md#L363-L396) (Step 6 — Stage, Commit, Push); gates at [skills/ship/SKILL.md:49-72](skills/ship/SKILL.md#L49-L72) |
| **Dates** | File born `26bc61d` **2026-04-06**; the cited Step 6.0/6.1 text was written in `966cf30` **2026-06-28** |
| **Classification** | **PRE-COURSE** overall; **COURSE-APPLIED** on the Step 6.0/6.1 body (2026-06-28) |

Snippet (Step 6.1):

```markdown
Stage relevant files by name (be specific):
git add <list of changed source files>
git add status.md
# NOTE: do NOT `git add scripts/.sync-manifest.json` in the source repo — it's
# gitignored here (Category A; regenerated every sync). Consumers track their own.

**Do NOT stage**: `.env`, credentials, `node_modules/`, temp/generated files.
```

**Why it is interesting**: the *prohibition* is the content. `git add -A` is banned
outright (see AGENTS.md "Scope discipline"), because an agent that tidies the working
tree bundles the user's unrelated work into the commit and corrupts blame. The commit is
treated as an atomic unit of *authored intent*, not a snapshot of the disk — which is
exactly the staging-area distinction the module teaches, enforced against a party
(the AI) that has every incentive to be helpful and sweep everything in.

### C4-C. GitHub push-protection collided with a test fixture

| | |
|---|---|
| **Type** | Commit |
| **Location** | **`7a59181`** — *"test(secret-patterns): assemble Atlas DSN fixture at runtime (GH secret-scanning alert #3)"*, `tests/secret-patterns.test.mjs` (+6/-1) |
| **Dates** | **2026-07-02** |
| **Classification** | **COURSE-APPLIED** (postdates the 2026-06-26 C4 capture) |

Reproduce: `git show 7a59181`

**Why it is interesting**: a small commit with a genuinely non-obvious lesson about the
GitHub platform layer the module introduces. The test suite for the *secret redactor*
necessarily contains realistic-looking secrets — so GitHub's secret-scanning push
protection fired on a **fake** MongoDB Atlas DSN in a test fixture. The fix is not to
suppress the alert but to assemble the string at runtime so it never exists as a literal
in the repository's object store. Security tooling and test fixtures are in tension, and
the resolution is to keep the artefact out of git history rather than to argue with the
scanner.

### C4-D. Traceability: every AI audit run is keyed to a commit SHA

| | |
|---|---|
| **Type** | Script / schema |
| **Location** | `commit_sha`, `branch`, `plan_id` columns on `audit_runs`, written by `runMultiPassCodeAudit` — see [AGENTS.md "Added columns"](AGENTS.md) and [scripts/cross-skill.mjs](scripts/cross-skill.mjs) |
| **Dates** | `5cf7064` **2026-04-19** (cross-skill data loop) |
| **Classification** | **PRE-COURSE** — the course named it ("traceability"), it was already built |

**Why it is interesting**: the module's insight is that git makes work *citable*. This
extends the same idea to the review layer: an audit finding, its adjudication, and its
eventual fix are all joined back to a commit SHA, so "which review gated this line?" is a
query, not an archaeology exercise. See improvement opportunity **#1** below — the join
currently only runs in one direction.

---

## Course 14 — Generative AI in Software Development (capture 2026-07-11)

Concepts mapped (from `ibm-fs-14`): agentic loop (Plan → Act → Observe); the
control-logic spectrum (pragmatic vs agentic control); compound AI systems; RAG and
semantic search over a vector store, with a governed-data layer; MCP; security of
AI-assisted development; **and the module's own precision correction #3 — "per-tool
coding-assistant descriptions are vendor characterisations, not benchmarks."**

### C14-A. A model swap-in evaluation harness — and a verdict that *rejected* the new model ★

| | |
|---|---|
| **Type** | Script + research write-up |
| **Location** | Harness: [scripts/model-eval-auditor.mjs](scripts/model-eval-auditor.mjs), [scripts/lib/model-eval/](scripts/lib/model-eval/). Verdict: [docs/research/experiment-3-model-swap-glm-vs-gpt.md:30-42](docs/research/experiment-3-model-swap-glm-vs-gpt.md#L30-L42) |
| **Dates** | Harness `8999636` **2026-07-11** (same day as the C14 capture); verdict `67f339e` **2026-07-13** |
| **Classification** | **COURSE-APPLIED** — the verdict doc and its supporting fixes (`fe84b4e` 07-12, `7572c04` 07-12, `ceec3cd` 07-12) all postdate 2026-07-11 unambiguously. The harness's birth commit lands *on* the capture date; treat the harness as same-day and cite the verdict as the dated artefact. |

Snippet (the verdict):

```markdown
**Verdict: `keep`** (stay on GPT-5.6). Mechanically correct against the
configured thresholds (`auditor-thresholds.json`): GLM's false-positive rate
exceeded 1.15× GPT's (0.809 > 0.676×1.15 = 0.777), which fails the comparative
floor regardless of GLM's nominally higher recall.

## The confound — recall numbers are not a trustworthy quality signal here
```

Reproduce: `node scripts/model-eval-auditor.mjs --candidate <spec> --tier screen|promotion`

**Why it is interesting** — this is the strongest artefact in the repo for C14, on three
counts:

1. It answers the module's tool-selection question **empirically**, against the module's
   own warning that vendor labels are not benchmarks. A curated known-defect corpus, a
   pre-configured false-positive threshold, and a real $1.87 comparative run.
2. The answer was **"no"**. The candidate model was rejected, on a false-positive floor,
   *despite scoring higher on recall*. Building the apparatus that lets you decline the
   shiny new model is a harder engineering act than adopting it.
3. The write-up then **attacks its own metric** (§"The confound") — the recall column is
   untrustworthy because the oracle can only credit the one curated defect per case while
   the model legitimately finds others. A result that publishes the limits of its own
   measurement, and an accepted false-negative direction encoded in the schema (a
   restricted-catalog run can *never* emit `switch`, only `keep`/`inconclusive`).

### C14-B. `allowTiered` — a blast-radius gate on autonomous spend ★

| | |
|---|---|
| **Type** | Commit + script |
| **Location** | **`d73dc9d`** — *"fix: shadow flip incident #2 — allowTiered per-call gate stops real API calls leaking into unit tests"*. Code: [scripts/openai-audit.mjs:434-446](scripts/openai-audit.mjs#L434-L446) and [:782-784](scripts/openai-audit.mjs#L782-L784); guard test [tests/tiered-pipeline-wiring.test.mjs](tests/tiered-pipeline-wiring.test.mjs) (+115) |
| **Dates** | **2026-07-13** |
| **Classification** | **COURSE-APPLIED** |

Snippet (`scripts/openai-audit.mjs:434-446`, abridged):

```js
// `ctx.allowTiered` (shadow-flip incident fix, 2026-07-13): env flags are
// the *window*, not the *permission*. Both must hold.
if (tieredAuditConfig.pipelineEnabled && ctx.allowTiered) { ... }
const shadowTask = (tieredAuditConfig.shadowEnabled && ctx.allowTiered)
```
```js
// :782 — allowTiered: true — main() is the ONE production CLI entrypoint allowed
//        to spend. Library callers and tests can never construct a provider.
```

**Why it is interesting**: the incident is the course's *control-logic spectrum* made
concrete. An environment flag ("the experiment window is open") was being read by every
call site, so a unit test run silently made **real, billed API calls**. The fix separates
two things a single boolean was conflating: *eligibility* (env: is the window open?) and
*permission* (per-call: is this caller allowed to spend?). Only the production CLI's
`main()` asserts the second. That is the guardrail an agentic system needs before you
grant it autonomy — and it was found the way these things always are, by an incident,
labelled honestly as "#2".

### C14-C. Multi-model adjudication — the AI's findings are *challenged*, not accepted ★

| | |
|---|---|
| **Type** | Skill definition + scripts |
| **Location** | Triage rules [skills/audit-code/SKILL.md:178-192](skills/audit-code/SKILL.md#L178-L192); rebuttal [skills/audit-code/SKILL.md:232-244](skills/audit-code/SKILL.md#L232-L244); the mandatory independent gate [scripts/gemini-review.mjs](scripts/gemini-review.mjs) |
| **Dates** | `gemini-review.mjs` born `6034876` **2026-03-30**; audit-code skill `b5f1274` **2026-04-27** |
| **Classification** | **PRE-COURSE** — honestly flagged. The course supplied the names (compound AI system, multi-agent, "AI-generated code still requires developer review"); the mechanism predates it. |

Snippet (the triage matrix — every finding gets three independent axes):

```markdown
| **validity** | `valid` / `invalid` / `uncertain` | Is the concern real? |
| **scope**    | `in-scope` / `out-of-scope`       | Does it cite code this audit targeted? |
| **action**   | `fix-now` / `defer` / `dismiss` / `rebut` | What happens next? |

- `validity=invalid`   → action MUST be `dismiss` or `rebut`
- `validity=uncertain` → action MUST be `rebut` (GPT deliberation)
```

**Why it is interesting**: three models with *structurally different jobs* — Claude
authors, GPT audits, Gemini adjudicates independently and is **never** skipped, even when
GPT has converged (the whole point of an independent gate is that it does not take the
first two models' agreement as evidence). And a finding the author disagrees with cannot
simply be dismissed: `uncertain` **must** be rebutted, forcing the disagreement back
through the auditor. Human judgement is retained not by a review step bolted on the end,
but by making "I disagree" a first-class, costed state in the machine. The essay caveat
must be stated: this predates the C14 capture.

### C14-D. Architectural memory — RAG / semantic search, with a governance column

| | |
|---|---|
| **Type** | Doc (mandatory agent instruction) + script |
| **Location** | [AGENTS.md "Architectural Memory — Pre-fix Consultation (MANDATORY)"](AGENTS.md); [scripts/lib/neighbourhood-query.mjs](scripts/lib/neighbourhood-query.mjs) |
| **Dates** | `ffb9441` **2026-05-03** |
| **Classification** | **PRE-COURSE** |

```bash
node scripts/cross-skill.mjs get-neighbourhood --json '{
  "targetPaths": ["<files you intend to touch>"],
  "intentDescription": "<one-line summary of what you are about to write>", "k": 8 }'
```
Recommendation column: `reuse` (cosine ≥ 0.90) · `extend` (0.85–0.90) ·
`justify-divergence` (0.75–0.85) · `review` (< 0.75).

**Why it is interesting**: it is textbook RAG (embed every symbol, semantic search, inject
the retrieved context) put to an unusual end — not answering questions, but **preventing
the agent from writing a function that already exists**. The non-obvious part is that the
similarity score is bucketed into an *obligation*, not a suggestion: at 0.75–0.85 the
agent may still write new code but must **state in its reply why divergence is correct**.
Retrieval with a governance layer over it, which is precisely the module's governed-RAG
whiteboard, applied to code reuse rather than access control.

### C14-E. Security of AI-assisted development — the sensitive-path egress gate

| | |
|---|---|
| **Type** | Script |
| **Location** | [scripts/lib/sensitive-paths.mjs](scripts/lib/sensitive-paths.mjs) (single source of truth), [scripts/lib/sensitive-egress-gate.mjs](scripts/lib/sensitive-egress-gate.mjs); guards `tests/sensitive-egress.test.mjs`, `tests/audit-scope-egress.test.mjs` |
| **Dates** | Gate `ffb9441` **2026-05-03**; canonical classifier `d705331` **2026-05-22**; path-scan heuristics materially rewritten in `fe84b4e` **2026-07-12** |
| **Classification** | **PRE-COURSE** on birth; **COURSE-APPLIED** on the 2026-07-12 body rewrite |

**Why it is interesting**: the module's "security of AI-assisted development" section is
about the *output* (vulnerabilities in generated code). This is the inverse and less
discussed risk — the **input**. Every audit ships your source to a third-party LLM, so
`.env`, keys and certs must never enter a provider payload, and a symlink named
`notes.txt` pointing at `~/.ssh/id_rsa` must be caught by resolving to the canonical path
(fail-closed: if resolution errors, classify as sensitive). It is one of only two seams in
the repo where the testing doctrine is **hard test-first, non-negotiable** — because "a
leak ships credentials to a third party" is not a bug you get to fix afterwards.

### C14-F. MCP — the tool-integration layer, in use

| | |
|---|---|
| **Type** | Config |
| **Location** | [.mcp.json](.mcp.json) — two stdio MCP servers: `@playwright/mcp` (drives the browser for `/persona-test`, `/click-test`) and `mcp-mermaid` (validates plan diagrams before they persist) |
| **Dates** | `4578b41` **2026-04-15** |
| **Classification** | **PRE-COURSE** |

**Why it is interesting**: a modest but honest instance of the module's MCP architecture —
one host, several servers, tools reused across AI clients rather than integrated
per-application. Worth one sentence, not more; do not inflate it.

---

## 2. Improvement opportunities

Two clear the "real value independent of the essay" bar. Both are small, both close a gap
the repo has already *documented* but not *enforced*.

### Opportunity 1 — Git-native audit provenance trailers on `/ship` commits

**What.** Have `/ship` Step 6.2 append structured trailers to the commit message:

```
Audit-Run: <run_id>
Plan: docs/plans/<name>.md
Gate: converged R4 · gemini APPROVE
```

**Why it is valuable independently.** The join today runs one way: `audit_runs.commit_sha`
points *at* a commit, so answering "which review gated this line?" requires a live database.
The learning store is already known to be low-signal and fragmented by repo identity, and
it is a single point of failure for provenance. Git is the durable ledger — putting the
trail in the commit message makes it survive the database, work offline, and show up in
`git log`, `git blame`, and the GitHub UI with no tooling at all. It also makes the audit
loop's output *reviewable by a human reading history*, which is currently impossible.

**Course segment evidenced.** Course 4 (traceability, commit discipline, "link the exact
commit"); secondarily Course 1 (quality gates recorded at the point of release).

**Effort.** 2–3 hours. One skill-file edit (Step 6.2), one helper to format trailers, one
test asserting `/ship` emits them when an audit run exists and omits them cleanly when it
does not.

**Risk to repo quality.** Low. Commit-message-only; no schema change, no runtime path.
Worst case is a noisy trailer, revertible in one commit.

**Before/after commit shape.** `feat(ship): git-native audit provenance trailers` —
touches `skills/ship/SKILL.md`, `.claude/skills/ship/SKILL.md` (regenerated),
`scripts/lib/…/commit-trailers.mjs` (new), `tests/ship-commit-trailers.test.mjs` (new).
The *evidence* is then the first commit that carries the trailers — a before/after pair
in `git log` showing the same repo becoming self-documenting.

### Opportunity 2 — An executable "gate honesty" test suite

**What.** `tests/gate-honesty.test.mjs`: for each lens with a pass/green path
(`visual-audit --gate`, `nav-audit --gate`, `click-test`, `ux-lock verify`), feed it a
**failed or empty capture** fixture and assert it exits non-zero / reports `unverified` —
never "verified, 0 findings".

**Why it is valuable independently.** AGENTS.md:385-388 already names this as the repo's
own recurring bug class ("the visual-audit `--gate` alone yielded six such holes; none
caught by static review") — but it is currently **doctrine only**. There is no test that
stops the *next* lens from shipping a green path that can return clean without having
checked anything. This is the highest-value untested seam in the repo, by its own stated
history, and each new lens adds another instance of it.

**Course segment evidenced.** Course 1 (testing verifies behaviour against requirements;
quality built in, not inspected at the end — here applied to the *verifier itself*).
Secondarily Course 14 (AI-assisted checks require developer-owned guardrails).

**Effort.** 4–6 hours — most of it building the degraded-capture fixtures, not the
assertions.

**Risk to repo quality.** Low-to-medium, in the useful direction: it will likely fail on
first run and surface real holes. That is the point, but it means the commit may need to
carry fixes as well as tests, so budget for that.

**Before/after commit shape.** `test(gates): assert no lens can report green without
evidence` — adds `tests/gate-honesty.test.mjs` + `tests/fixtures/degraded-capture/`, plus
any lens fixes it forces. The evidence is the test file (the invariant, stated executably)
and the diff of whatever it caught.

---

## 3. Appendix table

| Appendix label | Course segment | Repo reference | What the marker should look at, and what it shows | Classification |
|---|---|---|---|---|
| **A1** — Empirical model evaluation, and the verdict to *not* switch | C14 | `docs/research/experiment-3-model-swap-glm-vs-gpt.md:30-42` (commit `67f339e`, 2026-07-13); harness `scripts/model-eval-auditor.mjs` | A candidate LLM was benchmarked against a curated defect corpus and **rejected** on a false-positive floor despite higher recall — then the write-up attacks the trustworthiness of its own recall metric. Tool choice as measurement, not marketing. | **COURSE-APPLIED** |
| **A2** — Blast-radius gate on autonomous AI spend | C14 | commit `d73dc9d` (2026-07-13); `scripts/openai-audit.mjs:434-446`, `:782-784`; `tests/tiered-pipeline-wiring.test.mjs` | An env flag meant "the window is open" and was misread as "you may spend" — real billed API calls leaked into unit tests. The fix splits eligibility from per-call permission; only the production entrypoint may spend. | **COURSE-APPLIED** |
| **A3** — Findings are challenged, not accepted | C14 | `skills/audit-code/SKILL.md:178-192` and `:232-244`; `scripts/gemini-review.mjs` | Three models with different jobs (author / auditor / independent adjudicator). A finding marked `uncertain` **must** be rebutted; the Gemini gate is mandatory even when the first two agree. Human judgement is a costed state, not a rubber stamp. | **PRE-COURSE** (course supplied the vocabulary) |
| **A4** — Testing doctrine: audit your success paths | C1 | `AGENTS.md:366-388` (commit `3204910`, 2026-06-26); `docs/pre-ship-empirical-verify.md` | Four LLM review passes confirmed a bug that did not exist (a mid-transition style read). Doctrine: run it against one real app, and be adversarial about any branch that can report green. | **COURSE-APPLIED** |
| **A5** — Convergence as the quality gate | C1 | `skills/audit-code/SKILL.md:247-263` | "Done" is a stability property over rounds, not a count of fixes: two stable rounds, with architectural findings resetting stability and mechanical ones not. | **PRE-COURSE** |
| **A6** — Composite local-first pre-push gate | C1 | `package.json:43`; `scripts/install-prepush-hook.mjs` | CI as a local hook. Note `context:check` — the docs themselves are gated on size, because an always-loaded instruction file is a runtime cost. | **PRE-COURSE** (2026-07-13 addition COURSE-APPLIED) |
| **A7** — What belongs under version control | C4 | commit `966cf30` (2026-06-28); policy at `AGENTS.md:38-63` | A 298-line generated manifest carrying a timestamp was untracked, because a file that is dirty on every push destroys the signal `git status` exists to give. Two-category test, with the middle ground named as the failure mode. | **COURSE-APPLIED** |
| **A8** — Staging discipline enforced against the agent | C4 | `skills/ship/SKILL.md:363-396` (Step 6.0/6.1, written 2026-06-28) | `git add -A` is banned outright: stage by name. The commit is an atomic unit of authored intent, not a snapshot of the disk — enforced against an AI that would otherwise helpfully sweep in the user's unrelated work. | **COURSE-APPLIED** (on this section) |
| **A9** — GitHub push protection vs. test fixtures | C4 | commit `7a59181` (2026-07-02), `tests/secret-patterns.test.mjs` | Secret-scanning fired on a *fake* Atlas DSN inside the secret-redactor's own test. Fixed by assembling the string at runtime so it never enters the object store — keep it out of history rather than argue with the scanner. | **COURSE-APPLIED** |
| **A10** — RAG applied to code reuse | C14 | `AGENTS.md` "Architectural Memory — Pre-fix Consultation"; `scripts/lib/neighbourhood-query.mjs` | Semantic search over an embedded symbol index, with the cosine score bucketed into an *obligation* (reuse / extend / justify-divergence-in-your-reply). Governed RAG, aimed at preventing duplicate code. | **PRE-COURSE** |
| **A11** — Egress security of AI-assisted development | C14 | `scripts/lib/sensitive-paths.mjs`; `tests/sensitive-egress.test.mjs`; body rewrite `fe84b4e` (2026-07-12) | The under-discussed direction: every audit ships source to a third party. Fail-closed symlink resolution; one of only two hard test-first seams in the repo. | **PRE-COURSE** (2026-07-12 rewrite COURSE-APPLIED) |
| **A12** — MCP in use | C14 | `.mcp.json` | Two MCP servers (Playwright, Mermaid) as the tool-integration layer for the browser-driving and diagram-validating skills. One sentence only. | **PRE-COURSE** |
| **F1** *(future)* — Git-native audit provenance trailers | C4 | Opportunity 1 above (not yet built) | Would make "which review gated this line?" answerable from `git log` alone. | **FUTURE POTENTIAL** |
| **F2** *(future)* — Executable gate-honesty suite | C1 | Opportunity 2 above (not yet built) | Would turn the repo's own most-repeated bug class from doctrine into an enforced invariant. | **FUTURE POTENTIAL** |

---

## 4. Nominations — the four to cite if the essay could use only a handful

1. **A1 — the model-evaluation harness and its `keep` verdict** (`67f339e`, 2026-07-13,
   COURSE-APPLIED). The single best artefact here. It answers the C14 module's own
   precision correction — that vendor tool descriptions are not benchmarks — by building
   the benchmark, and then it *declines the new model* on a false-positive floor and
   publishes the limits of its own metric. Cleanly dated after the 2026-07-11 capture.

2. **A2 — the `allowTiered` blast-radius gate** (`d73dc9d`, 2026-07-13, COURSE-APPLIED).
   The best short, incident-driven story in the repo, and it lands exactly on the module's
   control-logic spectrum: an autonomous system was granted spend by an ambient env flag,
   made real billed calls from a test run, and the fix separates *eligibility* from
   *permission*. It shows an AI workflow being bounded rather than trusted.

3. **A4 — "audit your success paths"** (`3204910`, 2026-06-26, COURSE-APPLIED). The
   strongest Course-1 citation and the most quotable: four passes of LLM review confirmed
   a bug that did not exist. The remedy — run it against one real app, and be adversarial
   about any branch that can report green — is the course's "quality is built in, not
   inspected at the end" arriving from an unexpected direction.

4. **A3 — findings are challenged, not accepted** (PRE-COURSE, flagged as such). The
   conceptual centrepiece: three models with structurally different jobs, a mandatory
   independent adjudicator that is *not* skipped when the first two agree, and a rebuttal
   path that makes "I disagree" a costed state rather than a silent dismissal. It must be
   cited with the honesty caveat — the mechanism predates the module, and the module gave
   it its vocabulary. That caveat is itself worth a Kolb sentence.

**Runner-up, if a fifth is allowed**: **A7** (`966cf30`) — the cleanest small Course-4
insight, that a file which is dirty on every push destroys the signal `git status` exists
to provide.

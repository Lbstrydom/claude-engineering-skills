---
name: audit-code
description: |
  Iteratively audit code against a plan with GPT + Gemini final gate.
  5-pass parallel static analysis (structure, wiring, backend, frontend,
  sustainability), R2+ ledger-driven suppression, debt capture for
  out-of-scope findings, max 6 rounds with 2-stable-rounds convergence.
  Invoke this for ANY code-correctness review, even a small pasted snippet
  or diff — don't just review it yourself directly; a single read-through
  is not a substitute for the multi-pass GPT+Gemini adjudication this skill
  performs, and skipping it means the review didn't actually happen.
  Triggers on: "audit my code", "audit my changes", "audit my PR",
  "check the implementation", "review my code", "audit code", "/audit-code",
  "audit this", "verify the implementation".
  Usage: /audit-code <plan-file>              — Audit code against plan (--scope diff default)
  Usage: /audit-code <plan-file> --scope plan — Audit only files mentioned in the plan
  Usage: /audit-code <plan-file> --scope full — Full repo audit
---

# Code Audit Loop

> **This skill's last line is an end marker naming the skill between em-dashes, after
> the Reference files table.** If that last line is not in your context (context
> compaction keeps only the start of a skill), re-read
> `.claude/skills/audit-code/SKILL.md` in full before continuing — the later steps,
> including the mandatory final gate, still apply.

Multi-pass code audit with GPT + Gemini final review. Iterates until
findings stabilise or max 6 rounds.

**Input**: `$ARGUMENTS` — plan file path (the spec the code is being audited
against). Optional flags: `--scope diff|plan|full`, `--require <paths>` (must-read files; any not FULL withholds convergence).

<!-- host-contract: input-acquisition; grammar=path+flags; empty=ask-and-stop -->

**Where `$ARGUMENTS` comes from** — orchestrator-supplied input first, else
the host's verbatim invocation suffix, else the span of the user's **current**
message naming this skill or its subject; never inferred from the conversation. This site is `path+flags`; on empty input, ask which plan to audit and stop — never guess a plan.
Full contract: `references/input-acquisition.md`.


> **Worktree preflight** — in a linked git worktree the synced tooling tree
> `scripts/.claude-skills/` is absent — it is gitignored, so `git worktree add`
> does not populate it, and every command below that uses it dies on a bare
> `MODULE_NOT_FOUND`. Run `npm run skills:hydrate` first. If this repo defines
> no such script, `references/worktree-preflight.md` holds the entry to add — ask
> the user first, since it edits their `package.json`.

---

## Step 0 — Parse Input and Validate

Validate: plan file exists, the helper scripts resolve, and a GPT route is
available — `OPENAI_API_KEY` **or** an active Azure profile
(`AZURE_OPENAI_ENDPOINT`); ask which ROUTE exists, not whether one variable is
set. Optional: `GEMINI_API_KEY` for Step 7 (falls back to Claude Opus when
absent). `AUDIT_DB_URL` for cloud learning (optional).

**If a prerequisite does not resolve, follow `references/prerequisite-ladder.md`
— do not proceed as though it did, and do not die mid-flow.** It defines the
hydrate-then-retry step for absent helper scripts, the labelled adversarial-agent
substitute when the GPT legs have no route, and which of `AUDIT_DEGRADED` /
`AUDIT_NOT_RUN` to report so a run that did not happen stays distinguishable
from one that passed.

Initialise session ID: `SID=audit-code-$(node -e "process.stdout.write(Date.now()+'-'+process.pid)")` — epoch ms plus a PID, so two sessions started in the same second get separate result, stderr and ledger files (a bare `$(date +%s)` gave both the same ones).

Kickoff card: `/audit-code — Starting | Plan: <path> | Max 6 rounds | SID: $SID`.

---

## Step 0.5 — Architectural-memory catalogue (--scope=full only)

When `--scope=full`, fetch the repo's symbol catalogue from architectural
memory (if populated) and inline a "Symbol catalogue" section into the
prompt context — it lets the auditor catch cross-file duplication that
diff-scope cannot see.

```bash
# .audit/ is gitignored — a fresh checkout or new linked worktree lacks it, and the redirect fails first.
mkdir -p .audit
# 1. Resolve repo identity + active snapshot. Read JSON with node, never jq (not in check-deps).
node scripts/cross-skill.mjs resolve-repo-identity > .audit/repo-identity.json
node scripts/cross-skill.mjs get-active-refresh-id --repo-uuid "$(node -p "require('./.audit/repo-identity.json').repoUuid")" > .audit/active-refresh.json
# 2. Fetch top-N symbols, CARRYING the refresh id forward (ARCH_AUDIT_FULL_TOPN, default 200) — never retype it.
REFRESH_ID=$(node -p "require('./.audit/active-refresh.json').refreshId")
node scripts/cross-skill.mjs list-symbols-for-snapshot --json "{\"refreshId\":\"$REFRESH_ID\",\"limit\":200}"
```

Format the rows as a `## Symbol catalogue (top N by domain)` section
with `(domain alphabetical, symbol_name alphabetical)` ordering. Note
truncation in the section header if `count == limit`.

States: `cloud:false` or `refreshId:null` → skip section silently;
`RPC_ERROR` → skip section, log warning to stderr. Advisory — never fail the run.

---

## Step 1 — Choose Audit Scope

GPT doesn't know what's "new" vs pre-existing — it flags everything in
scope, so choose deliberately:

| Scope mode | When to use | Behaviour |
|---|---|---|
| `--scope diff` (**DEFAULT**) | "audit my recent work", after implementing a phase | Auto-scopes to changed files with a **dirty-aware base** + unstaged + untracked (see below) |
| `--scope plan` | Large refactor touching many files; user wants broad view | All files referenced in the plan |
| `--scope full` | "audit the entire codebase" — explicit codebase-wide request | Full repo audit — slowest, catches cross-cutting issues |

Default is `--scope diff`. Switch only when the user explicitly asks or `git diff` is empty.

**Dirty-aware base**: with no `--base`, the CLI diffs a **dirty** tree against
`HEAD` (uncommitted work only) and a **clean** one against `HEAD~1` (last
commit); it logs `[scope] base resolved to <ref> …`. ⚠ With BOTH committed and
uncommitted work where the prior commit was already audited (a resumed
clustered build), pass `--base <clusterStartRef>` (or `--base HEAD`) and scope
the Gemini gate's `--diff` to the same range — never rely on the default across
a commit boundary. → `references/round-recipes.md` §Dirty-aware base — read when
resuming a clustered/partly-audited build.

---

## Step 2 — Run Code Audit

### Round 1

`$SCOPE` is the scope chosen in the table above — `diff` unless the user asked
for `plan` or `full`. **Pass it; do not hardcode `diff` here.** This block read
`--scope diff` literally until 2026-09-06, so a run the user had explicitly asked
to be `--scope full` executed as a diff audit and reported a clean result over a
fraction of what was requested — the scope flag this skill's own Usage lines
advertise was accepted and then dropped.

```bash
SCOPE=diff   # or plan / full, per the table above and the user's request
# PLAN_FILE = the ONE plan path /audit-code was invoked with, assigned verbatim.
# Not a glob: an assignment does not expand it, so the CLI would get the pattern itself.
node scripts/openai-audit.mjs code "$PLAN_FILE" --scope "$SCOPE" --out .audit/$SID-r1-result.json 2>.audit/$SID-r1-stderr.log
```

### Round 2+

R2+ mode changes the prompt rubric and enables ledger-driven suppression.
Full flag contract, smart pass selection, automatic behaviour, and
tool pre-pass rules: `references/r2-plus-mode.md`.

Diff base — match R1 (`git status --porcelain` counts UNTRACKED files as dirty;
never `git diff --quiet`, which ignores them). Non-empty output → `BASE=HEAD`
(dirty tree); empty → `BASE=HEAD~1` (clean, last commit). Pass
`--base`/clusterStartRef instead across an audited commit boundary.

```bash
BASE=$([ -n "$(git status --porcelain)" ] && echo HEAD || echo HEAD~1)
git diff --no-textconv --output=.audit/$SID-diff.patch "$BASE" -- .
```

Use `--output`, never a PowerShell `>` (it re-encodes the patch).
**Include UNTRACKED new files** — `git diff` omits them, so a brand-new file would
reach the auditor with no `[CHANGED]` annotation. Append each as a new-file diff
against `/dev/null`. **POSIX shell only** (Git Bash on Windows), even on a
Windows/Copilot host:

```bash
git ls-files --others --exclude-standard -z | xargs -0 -r -I{} git diff --no-index --no-color -- /dev/null "{}" >> .audit/$SID-diff.patch 2>.audit/$SID-untracked-diff-stderr.log || true
cat .audit/$SID-untracked-diff-stderr.log   # non-empty = a real failure occurred, not the expected exit
```

`|| true` absorbs only `git diff --no-index`'s expected exit 1; it writes nothing to
stderr in that case, so **a non-empty stderr log is a genuine failure — check it
before trusting the patch.** → `references/round-recipes.md` §untracked-file append
— read when that log is non-empty.

```bash
# CHANGED = the exact files you edited this round, comma-separated, no globs:
# the CLI splits on commas, so a pattern reaches it literally.
CHANGED="scripts/openai-audit.mjs,tests/audit-skill-shell-recipes.test.mjs"
FILES="$CHANGED"                            # + any dependent you also want in scope
PASSES="sustainability"                     # e.g. sustainability,backend — per r2-plus-mode.md
node scripts/openai-audit.mjs code "$PLAN_FILE" --round 2 --ledger .audit/$SID-ledger.json --diff .audit/$SID-diff.patch --changed "$CHANGED" --files "$FILES" --passes "$PASSES" --out .audit/$SID-r2-result.json 2>.audit/$SID-r2-stderr.log
```

**R2+'s scope is always the diff, not Round 1's `--scope`** — `--files` overrides
`--scope`, deliberately; do not add `--scope "$SCOPE"` to R2+ (it is silently
ignored). → `references/round-recipes.md` §R2+ scope — read when tempted to widen R2+.

### Automatic waves and rubrics (no flag)

- **Requirements rubric** — when `.requirements/ledger.json` exists every pass gets a
  `<requirements_rubric>`. A `[stale]` `[requirements]` stderr line → refresh with
  `node scripts/requirements.mjs extract --files <…>` then `reconcile`.
  → `references/round-recipes.md` §Requirements rubric — read when that line appears.
- **Duplication wave (Wave 5)** — a near-duplicate of an indexed symbol becomes a
  `[Duplication]` finding that **gates convergence like a `quickfix` finding**. JS/TS
  files only — another language is outside its coverage, never "clean". Intentional
  duplicate → `@duplicate-justification` pragma above the declaration (never under
  `tests/`, which is not read); a pragma whose target doesn't match raises its own
  `Orphaned suppression pragma` finding. Opt out with `--passes` omitting
  `duplication`. → `references/duplication-wave.md` — read when a `[Duplication]`
  finding is intentional or a pragma is not honoured.

### Handle results

If `verdict` is `INCOMPLETE` (passes timed out), offer: re-run with higher
timeout, or continue with partial results.

Results card per round: `ROUND N AUDIT — <verdict> | H:x M:y L:z | Deduped: d | Cost: ~$… | Top: [H1] …`.

---

## Step 3 — Triage (validity × scope × action)

**You are a peer, not a subordinate.** For each finding, record three
orthogonal judgements:

| Dimension | Values | Meaning |
|---|---|---|
| **validity** | `valid` / `invalid` / `uncertain` | Is the concern real? |
| **scope** | `in-scope` / `out-of-scope` | Does it cite code this audit targeted? |
| **action** | `fix-now` / `defer` / `dismiss` / `rebut` | What happens next? |

### Triage rules

- `validity=invalid` → action MUST be `dismiss` or `rebut`
- `validity=uncertain` → action MUST be `rebut` (GPT deliberation)
- `validity=valid` + `scope=in-scope` + HIGH/MEDIUM → `fix-now` (unless accepted-permanent debt)
- `validity=valid` + `scope=out-of-scope` + **load-bearing** → `fix-now` (treat as in-scope — see impact test below)
- `validity=valid` + `scope=out-of-scope` + **independent** → `defer` eligible (pre-existing debt)
- `validity=valid` + `scope=in-scope` + LOW → operator choice
- Only `validity=valid` findings can be deferred

**Scope is decided by impact, not authorship (load-bearing test).** "My PR
didn't touch this line" is NOT a defer pass. Before any `out-of-scope` finding
routes to `defer`, apply the test: *does the correctness or stability of the
change I'm shipping depend on the cited code path?*

- **Load-bearing** — the new code calls into, reads state from, or otherwise
  rides on the cited path → it is in-scope **for the fix/defer decision** even
  if pre-existing. `fix-now`, or explicitly gate the feature on it and say so.
  **Never silent-defer a load-bearing finding.**
- **Independent** — the path fails identically with or without this change; the
  new code does not depend on it → genuine `defer` (pre-existing debt).

A pre-existing finding **in a file you changed** is a yellow flag, not a green
one: you usually touched the file *because* your change now rides on its
behaviour. Default such findings to "prove independence" rather than to defer.
Passing tests don't clear this — a green suite only covers exercised paths, not
the load-bearing path's failure modes.

**Same-file independence needs more than "doesn't call it".** For a finding in a
file the diff touches, the independence sentence must truthfully state BOTH (a) the
cited code shares no column/constraint/invariant with the new code (a shared *table*
is not enough) and (b) its writes do not run in the SAME transaction instance (a
shared request/file/subsystem is not enough). Either unstateable → load-bearing.
→ `references/triage-rubrics.md` §Same-file independence — read when deferring a
same-file finding.

**Honest-deferral check.** Every `defer` of a valid finding names (1) the root
cause, (2) the minimal in-scope fix considered and rejected, (3) the residual risk;
an out-of-scope `defer` also names the independence (both parts above for same-file).
Can't write it truthfully → `fix-now`. **Never `defer` because the correct fix is
merely larger** — size is not scope, and neither is authorship.
→ `references/triage-rubrics.md` §Honest-deferral check — read when writing a defer.

### Mechanical vs architectural

Each finding has `is_mechanical: true/false` from GPT:
- **Mechanical**: deterministic fix. Fix immediately, no deliberation.
- **Architectural**: judgement call. Needs deliberation, resets stability if new.

### Tiered rebuttal (when action=rebut)

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

### Convergence

Quality threshold: `HIGH == 0 && MEDIUM <= 2 && quickFix == 0`

Stability uses `_hash` for exact cross-round matching:
- New hash not in prior set = genuinely new → resets stability
- Mechanical-only findings do NOT require stability rounds

| Condition | Action |
|---|---|
| Threshold NOT met | Fix → re-audit |
| Threshold met, new architectural | Fix → re-audit (stability resets) |
| Threshold met, mechanical only | Fix → re-audit (stability NOT reset) |
| Summary line ends `— not convergence evidence` (changed lines, an unrecognised file type, or a `--require` subject not read in full) | **Not stable, whatever H/M/L say** — the change was not read (`changed-lines-unread` / `unrecognised-files-unreviewed` / `required-subjects-not-full`). Re-run short files with `--files`; too big alone → report not converged. Unrecognised type: `.auditignore` it or report upstream. Required subject: fix the read, never `.auditignore` it |
| Threshold met, 0 new, 2/2 stable | **CONVERGED** → Step 6, then REQUIRED Step 7 |
| Same file/concern recurs 3 rounds running | **Pivot**: stop, propose a new design (`references/pivot-rule.md`) |
| Round 6, not stable | Run the structural-or-stop card, present it to the operator, then REQUIRED Step 7 |

**Max 6 rounds for code audits, 8 absolute — enforced by `openai-audit.mjs`.** Round 7 exits `4` (`CAPPED`) with
a structural-or-stop card: a stop for a human call, never a retry. At round 6 without convergence run
`node scripts/audit-structural-card.mjs --sid "$SID" --mode code --plan "$PLAN_FILE"` and present the card to the
operator (STOP / STRUCTURAL / CONTINUE); continuing is their call (`references/round-cap-and-structural-card.md`).

**Step 7 (Gemini final review) is MANDATORY** after the last audit round,
regardless of convergence. No-key degradation ladder (`references/gemini-gate.md`
— never a silent skip): Gemini → Claude Opus fallback → an **independent
adversarial review agent** over the code + findings (verdict in the same
APPROVE/CONCERNS/REJECT shape) → only when none is available, output
`FINAL_GATE_SKIPPED` and do not claim full final-gate validation.

---

### Step 3.7 — Detector-first census (cross-cutting findings)

**An audit's instance count is a floor, not a scope** — the *tool* enumerates, not you.
**Trigger is mechanical**: `affectedFiles.length > 1` (or an explicit `crossCutting: true`
you set at triage); single-file findings are exempt. For each cross-cutting finding,
record a **structured** `detector` (`kind`, `pattern`, `globs`, `baseline`,
`disposition`) on its ledger entry — never a shell command. Dispositions key on
`<path>::<trimmed matched line>`, never a line number. **The detector's output IS the
fix scope** — fix or disposition everything it finds, not only the instances the audit
named. → `references/detector-census.md` §Step 3.7 — read when recording a detector
(schema + key format).

## Step 3.5 — Update Adjudication Ledger

After each deliberation round, write ledger entries for every finding before
proceeding to Step 4. The ledger drives R2+ rulings injection and post-output
suppression.

Full writer invocation example + status field semantics: `references/ledger-format.md`.

**Dismissing a finding that carries `_priorRuling`** (kept beside an earlier
ruling, named with its category) needs a concern decision in its triage entry:
same concern reworded → `"sameConcernAs": "<its topicId>"`; a different defect
in the same file → `"newConcern": true`.
`write-ledger-entries` refuses a batch with an undecided one (exit 2).
Three linked dismissals hard-suppress the next raise. See `references/ledger-format.md`.

---

## Step 3.5b — Record Triage Outcomes (closes the adaptive-learning loop)

**Automatic — no manual step.** `write-ledger-entries.mjs` labels the round it just
triaged (once every finding has a ruling), and each R2+ `openai-audit.mjs` invocation
re-checks the prior round idempotently, so the **final** round is labelled too. It
bridges the ledger → `finding_adjudication_events` + `audit_pass_stats` +
`audit_findings` + `audit_runs.labeled` (cloud) and `.audit/outcomes.jsonl` (local
bandit reward). Best-effort: a failure logs `[finalize] WARN` and the audit proceeds.

**Manual fallback — only if that WARN appeared**, or on **non-Claude-Code / cloud-off
CI** where the orchestrator path didn't fire (inside `/cycle` it is fully covered):

```bash
ROUND=2   # the round number just completed
node scripts/write-code-outcomes.mjs --result ".audit/$SID-r$ROUND-result.json" --ledger .audit/$SID-ledger.json --round "$ROUND"
```

Both paths share `finalizeRoundOutcomes`, so they are idempotent (cloud re-labels; the
local append is marker-guarded). The ledger must already carry per-finding rulings
(Step 3.5): **`labelled: 0` with a non-zero `total` is a failure to fix, never a pass.**

---

## Step 3.6 — Debt Capture

Persist out-of-scope valid findings to `.audit/tech-debt.json` so future
audits suppress them automatically. Eligible candidates: Step 3 triage
findings with `action = defer`.

> **A rejected capture is a lost suppression.** An over-cap rationale is rejected and the run exits non-zero: any deferral that fails to land is never suppressed in a future audit — so `9 of 15 captured` is a failure, not a ship.
> Read the `Rejected entries:` listing, fix what it names, then re-run (capture is idempotent). Do not shorten a rationale to fit the 4000-char limit — the Step 3 honest-deferral requirement above (root cause + rejected minimal fix + residual risk + independence) is the point, and the limit is sized to it.

Full per-reason field requirements, capture flow, sensitivity-scan rules,
and status card format: `references/debt-capture.md`.

---

## Execution order — critical

**Wait for rebuttal BEFORE fixing.**

1. Send rebuttal (if rebut HIGH/MEDIUM findings from triage)
2. Wait for rebuttal response
3. Write adjudication ledger (Step 3.5)
4. Record triage outcomes — automatic next-round (Step 3.5b); manual CLI only for the final/1-round case
5. Capture deferrable debt (Step 3.6)
6. Fix ALL findings together (Step 4)
7. Run tests
8. Verification audit (Step 5) — debt suppression runs automatically

---

## Step 4 — Fix Findings

ALL HIGH must be fixed. MEDIUM until ≤2 remain. LOW if mechanical.

> **Read `finding.verification` before you triage on `finding.severity`.**
> The deterministic existence gate resolves every "file/module X is missing"
> claim against the real repo inventory and attaches a sibling `verification`
> object. `finding.severity` is the model's ORIGINAL claim and is deliberately
> never rewritten — so a **`verification.verification === 'refuted'`** finding
> still reads `HIGH` in `findings[]` while the audit verdict has already
> discounted it to `verdictSeverity: 'LOW'`.
>
> - `refuted` — **do not fix.** The cited file exists; the claim is a
>   `--scope diff` context artefact. Fixing it means editing a file that was
>   never missing. The stderr log names these: `[verify-gate] … REFUTED`.
> - `confirmed` / `requires_verification` — triage normally at `severity`.
>   A `requires_verification` on a list claim may say "N of M cited path(s) DO
>   exist" — the claim is partly false; verify the rest before acting.
>
> Triage on `effectiveSeverity(finding)` from
> [`finding-verification.mjs`](https://github.com/Lbstrydom/claude-engineering-skills/blob/main/scripts/lib/audit/finding-verification.mjs),
> never on a hand-rolled copy of the rule.

**Track which files you modify** — you'll need this for `--changed` in Step 5.
Card: `FIXING — N findings | Auto-fixed (mechanical): a | Per recommendation: b | Compromises: c | Skipped (LOW): d | Files modified: …`;
then list each fix: `[ID] description → file:lines`.

After fixing, update ledger entries to `remediationState: 'fixed'` for
fixed items.

### Step 4.5 — Prove every new guard in BOTH directions

For each finding fixed **with a new test, assertion or contract**: a green suite
does not distinguish "the fix worked" from "the check stopped looking". Only
revert-and-watch-it-go-red does, and it costs seconds.

1. Revert the fix (the fix only — not the test).
2. Run → **confirm RED**, and read the failure text: it must name the actual
   defect, not fail for an unrelated reason.
3. Where the fix closes **independent** failure modes, revert them **one at a
   time**. Two defects on one line mask each other — that is how a container
   health check shipped broken for months, each bug making the other invisible.
4. Restore → confirm GREEN. Record that you ran it, and what the red said.

A before/after observation of a pre-existing defect is **not** a negative control.
An "expect empty" assertion needs a vacuous-pass guard (one assertion proving the
probe can find something it must find). When the check itself fails, suspect the
instrument first. A guard worth keeping past this session gets the
`examples/contract-test-scaffold.md` skeleton (disposition + retirement fields).
→ `references/verification-discipline.md` §3, §5.

---

## Step 5 — Verify and Loop (R2+ Mode)

After fixes, re-audit using R2+ mode (back to Step 2):

1. Collect files modified during Step 4 → `--changed`
2. Compute scope: changed + importers → `--files`
3. Regenerate the diff with Step 2's Round 2+ recipe exactly — dirty-aware `BASE`,
   the untracked-file append, and the stderr-log check
4. Build `--passes` from file types
5. Run R2+ audit with `--round <N> --ledger --diff --changed --files`

Track finding churn using `_hash` fields: resolved / recurring / new.
Card: `ROUND N → ROUND N+1 (R2+ mode) | H:x M:y L:z | New: n | Suppressed: s | Stable: k/2`.

### Step 5.0b — Re-run every detector at FULL scope (blocks convergence)

```bash
node scripts/lib/audit/detector.mjs .audit/$SID-ledger.json
```

Exit 0 = every detector reached zero and every match is dispositioned; exit 1 =
blocked; exit 2 = the ledger could not be read, which is "no census happened"
and never a pass.

**At each detector's own `globs`, NOT the round's changed files** — a diff-scoped
re-run misses both the unfixed class members and any occurrence the fix itself just
wrote. Convergence requires `blocked === false`; `baseline` reports progress, never
the pass condition. A detector that errors here is reported `errored` in Step 6's
census, never folded into "reached zero". → `references/detector-census.md` §Step 5.0b
— read when a detector result is disputed.

### Step 5.1 — Debt Resolution Prompt

After verification, reopened debt topics with no matching finding this round
are candidates for resolution. Full prompt + resolver invocation:
`references/debt-capture.md`.

---

## Step 6 — Convergence Report (Pre-Final)

**Named states, per pass/wave/capability, not a bare "ran".** Attempted-but-
failed is a different thing from never-attempted (`references/verification-discipline.md`
§7):

| State | Meaning |
|---|---|
| `completed` | finished without error, applicable to the resolved scope — decoupled from finding count: a `completed` pass stays `completed` at 0, 1, or many findings |
| `errored` | started, did not complete (exception, timeout, non-2xx from a provider) |
| `ineligible` | does not apply to this repo's resolved language/scope (e.g. a frontend-specific pass on a backend-only diff) |
| `unavailable` | a concrete missing prerequisite — e.g. `AUDIT_DB_URL` unset for the architectural-memory catalogue |
| `not-reached` | the round's control flow did not get to this pass/wave before stopping (rare — see below) |
| `uncovered` | **file-level, from the result's `_coverage`, never from a pass:** changed files the audit did not (fully) examine — an unrecognised file type, an unreadable file, a deleted source file, a partial (head-cut or windowed) read. NOT `ineligible`: `ineligible` is an EXPECTED scope exclusion, and labelling a C# diff that way is exactly how twelve `.cs` files went unaudited under an APPROVE |

**Per-round record.** `arch-memory` is resolved once by Step 0.5 and carried into
every round's census (`ineligible` under `--scope=diff`). The five passes and three
mechanical waves are seeded `pending` at each round's start; on an aborted round every
untouched row finalizes `not-reached` (never left `pending`) — it signals a killed
process or hard timeout. Render the current round's rows plus `arch-memory`.
→ `references/convergence-report.md` §per-round execution record — read when a row's
state is ambiguous.

Report card: `CONVERGED[ (<count> <kind> · … — see census)] — Round N | Final: H:x M:y L:z | Rounds | Time | Cost | Files changed | Remaining (accepted): [Mn]…`,
then a `CENSUS` block — one `<identifier>  <state>  (<reason>)` row per pass, wave,
`arch-memory` and `file coverage`. → `references/convergence-report.md` §example
report card — read before printing a report with a non-`completed` row.

**A wave row over a change it could not read says so.** The four JS/TS-only waves (`orphan-introduced`, `event-wiring-symmetry`,
`duplication`, `adjacency`) report `ineligible (0 of N changed files are js/ts; nothing was examined)` — never `completed`,
`ANALYZED_CLEAN`, `clean` or `not-triggered` — when none of the changed files is one they can read; a partial one adds
`examined k of n`. The tool pre-pass likewise names each project's state (`ok` / `failed` / `timeout` / `deadline_exceeded` /
`ambiguous_project` / `no_project` / `skipped_budget` / `no_tool`) in `_coverage.tools`; none of them is a clean lint.

Identifiers are the real ones — `structure`/`wiring`/`backend`/`frontend`/
`sustainability` (`scripts/lib/prompt-seeds.mjs`), `quickfix`/`duplication`/
`adjacency` (`scripts/lib/audit-shadow.mjs`'s `MECHANICAL_WAVES`) — not
invented labels. Every non-`completed` row carries a concrete reason in parentheses.

**The `file coverage` row is rendered from the round's `_coverage` (`node -p` the result JSON; its `status`, `gate` and the
one-line suffix the summary already printed).** `complete` → `completed`; `partial` → `uncovered` with the suffix as its
reason; `none`/`incomplete` → the round is already `INCOMPLETE` (exit 3) and must not be reported as converged at all.
Copy the suffix, never paraphrase it: it names the files.

**A round with any non-`completed` row cannot print a bare `CONVERGED`.**
The suffix names **every kind present, with its own count** — never hardcode one
kind; a round with only `ineligible` rows names them `ineligible`, never "errored".

Save convergence snapshot to `docs/plans/<name>-audit-summary.md`.

Do not close the loop in Step 6 — completion requires Step 7.

### Step 6.5 — Regenerate Telemetry Dashboard (advisory, source-repo only)

**Source-repo-gated** — run ONLY when
`package.json.name === "claude-engineering-skills"`; skip silently elsewhere. Never
blocks the audit. Print the `file://…/dashboard/telemetry.html` link; never stage it.

```bash
node scripts/build-dashboard.mjs telemetry 2>&1 || true
```

→ `references/convergence-report.md` §Step 6.5 — read when running it in a consumer.

### Step 6.5b — Solo author-model control (background, toggle-gated)

**Source-repo-gated** — run ONLY when `package.json.name === "claude-engineering-skills"`
(skip silently in consumers). Fire it **in the background, non-blocking** (it takes
minutes; it must NEVER delay or gate the audit result). It self-gates on the
`arm-eval` shadow toggle and is incremental, so firing it unconditionally is safe;
a failure is logged and ignored.

```bash
node scripts/solo-control-audit.mjs run --model claude-sonnet-5
node scripts/solo-control-audit.mjs run --model claude-fable-5
# run each backgrounded / in its own terminal — they're independent, not chained
```

→ `references/convergence-report.md` §Step 6.5b — read when asked why it runs.

### Step 6.6 — Recommended next (à-la-carte advisor)

Suggest the FEW additional lenses that fit THIS change, grounded in the final-round
audit result:

```bash
FINAL_ROUND=2   # the last round actually run
node scripts/cross-skill.mjs recommend-skills --findings ".audit/$SID-r$FINAL_ROUND-result.json" --just-ran audit-code --format human
```

Print the card verbatim if non-empty; **if it's empty, say nothing** (silence is
correct, not a failure). A nudge, never a gate. → `references/convergence-report.md`
§Step 6.6 — read when explaining a recommendation.

### Step 6.7 — Cross-surface honesty clause (GREEN ≠ REALIZED)

When the change introduces a user-visible DYNAMIC value that duplicates or re-derives
one another surface shows (or a `derived-state-parity` finding was raised), a green
audit does not prove they agree at runtime: do not close it on "looks correct" —
require a shared SSoT, a parity assertion, or a declared `data-engine-claim` surface.
→ `references/convergence-report.md` §Step 6.7 — read when that pattern appears.

---

## Step 7 — Gemini Independent Review (MANDATORY)

> **Coverage rides into the review automatically.** The transcript builder projects each round's `_coverage` (every file
> short of full coverage, capped, plus a digest of the full ledger), and the review envelope opens with an **Audit Coverage**
> note naming what was NOT examined. Do not summarise it away in `--summary`; if the note is present the reviewer was told,
> and an APPROVE over it is an APPROVE of the examined files only. A coverage gap is not itself release-blocking.

Run the final reviewer — the newest Gemini Pro by default (`latest-pro`, resolved at runtime; override with `FINAL_REVIEW_MODEL`) as the final gate. Falls back to Claude Opus when
`GEMINI_API_KEY` is absent.

**Build the transcript first** — the reviewer reads a file no earlier step
writes. Never hand-assemble the JSON:

```bash
node scripts/build-audit-transcript.mjs --sid $SID --changed "$CHANGED"
```

It discovers every `.audit/$SID-r<N>-result.json`, folds in
`.audit/$SID-ledger.json` as the deliberation trail, and writes
`.audit/$SID-transcript.json`. **`--changed` is the reviewer's scope filter** —
pass the same list you gave the R1 audit; without it out-of-scope findings stop
being dropped and the builder warns on stderr.

Read the cloud run id from the LAST round's result, passing the path as an argument
(never a literal inside `-e`) — **`--run-id` arms the verdict write-back to
`audit_runs`; without it the verdict is persisted nowhere:**

```bash
ROUND=2   # the last round actually run
RUN_ID=$(node -e "const fs=require('fs'); try { process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],'utf8'))._cloudRunId||''); } catch { process.stdout.write(''); }" ".audit/$SID-r$ROUND-result.json")
```

If `gemini-review.mjs` warns that cloud is on but `--run-id` is absent, the extraction
failed — don't ignore it. → `references/convergence-report.md` §Step 7 RUN_ID — read
when `RUN_ID` is unexpectedly empty.

If `RUN_ID` is non-empty:

```bash
node scripts/gemini-review.mjs review "$PLAN_FILE" .audit/$SID-transcript.json --out .audit/$SID-gemini-result.json --run-id "$RUN_ID" 2>.audit/$SID-gemini-stderr.log
```

Otherwise (cloud genuinely off — `RUN_ID` empty):

```bash
node scripts/gemini-review.mjs review "$PLAN_FILE" .audit/$SID-transcript.json --out .audit/$SID-gemini-result.json 2>.audit/$SID-gemini-stderr.log
```

Add `--round 1` to the first run. **Hard cap: 2 final-review rounds** —
`gemini-review.mjs` refuses `--round 3`; never loop past it.

**Act on `gateDisposition`, not the verdict word.** The result JSON (and the
stdout summary `Gate: …`) carries a code-computed `gateDisposition`; `verdict`
stays the reviewer's own word:

| `gateDisposition` | Action |
|---|---|
| `approve` | Done → final report. |
| `approve_with_debt` | Done — also for `CONCERNS`/`CONCERNS_REMAINING`. Every remaining finding is `release_blocking: false`: capture them (below), list them in the report. Do **not** re-run the reviewer and do **not** ask the user to override. |
| `blocked` | `gateDispositionDetail.reasons` names why (a release-blocking finding, a HIGH `wrongly_dismissed`, `REJECT`, or coverage gate). Round 1 → Step 7.1: fix the blocking items, rebuild the transcript, run round 2. Round 2 → present the named blocking items to the user; there is no round 3. |

Round 2 takes the round-1 result as structured memory — its findings are
settled, and a re-raise is dropped in code unless marked `is_reopened`:

```bash
node scripts/gemini-review.mjs review "$PLAN_FILE" .audit/$SID-transcript-v2.json --round 2 --prior .audit/$SID-gemini-result.json --out .audit/$SID-gemini-result-v2.json 2>.audit/$SID-gemini-stderr-v2.log
```

Capture non-blocking findings as debt from the result that closed the gate
(`-v2` after round 2; release-blocking ones are never captured; `--dry-run`
previews):

```bash
node scripts/debt-auto-capture.mjs --final-review .audit/$SID-gemini-result.json --run $SID
```

Optional observation-only shadow reviewer (`FINAL_REVIEW_SHADOW`) — never gates.
→ `references/convergence-report.md` §shadow A/B reviewer — read when it is set.

Full transcript-building, verdict routing, Step 7.1 deliberation protocol,
and category-error handling: `references/gemini-gate.md`.

---

## UX Rules

1. Status card after every phase (compact format above)
2. Never dump raw JSON — parse and summarise
3. Show every fix with file + line reference
4. Cost tracking: `cost ≈ (input × 2.5 + output × 10) / 1M`
5. Batch all user decisions into one prompt
6. Progress: show pass timings from stderr

---

## Reference files

This skill's canonical flow is above. The files below cover specialised
situations — read them only when the trigger applies.

| File | Summary | Read when |
|---|---|---|
| `references/input-acquisition.md` | Where a skill's arguments come from on any host, and what to do when there are none. | Reading $ARGUMENTS on a host that does not substitute it, or deciding what empty input means at a site. |
| `references/round-recipes.md` | Step 1–2 detail — dirty-aware base rationale, diff-recipe stderr handling, R2+ scope rule, requirements rubric. | Resuming a partly-audited clustered build, OR the untracked-diff stderr log is non-empty, OR a `[stale]` requirements line appeared. |
| `references/duplication-wave.md` | Duplication wave (Wave 5) — what it scans, the @duplicate-justification pragma, test-dir and orphan rules. | A `[Duplication]` finding is intentional, OR a pragma is not being honoured. |
| `references/r2-plus-mode.md` | R2+ audit mode — ledger rulings, diff annotations, smart pass selection, suppression. | Round ≥ 2 AND need to choose passes OR troubleshoot suppression. |
| `references/triage-rubrics.md` | Step 3 rubrics in full — same-file independence (column/constraint + transaction) and the honest-deferral check. | Step 3 — about to defer a finding, especially one in a file the diff touches. |
| `references/detector-census.md` | Detector-first census — the ledger detector schema, disposition keys, and why Step 5.0b re-runs at full scope. | Step 3.7 — a finding spans more than one file, OR Step 5.0b — a detector result is disputed. |
| `references/ledger-format.md` | Adjudication ledger schema + writer invocation example for each finding outcome. | Step 3.5 — about to write ledger entries, OR diagnosing R2+ suppression misbehaviour. |
| `references/debt-capture.md` | Phase D debt ledger — persist out-of-scope valid findings so they don't re-surface. | Step 3.6 — candidate deferrals present, OR Step 5.1 — debt resolution prompt firing, OR periodically to cluster/resolve the accumulated backlog (see its "Periodic Debt Health" section). |
| `references/convergence-report.md` | Step 6–7 detail — census bookkeeping, example report card, source-repo steps, cross-surface clause, RUN_ID history. | Step 6 — printing a report with a non-`completed` row, OR Step 7 — `RUN_ID` is empty or `FINAL_REVIEW_SHADOW` is set. |
| `references/gemini-gate.md` | Step 7 Gemini independent review protocol — transcript, verdict handling, re-review loop. | Step 7 starting, OR Gemini returned CONCERNS/REJECT and need deliberation rules. |
| `references/round-cap-and-structural-card.md` | Enforced GPT round cap (plan 3/5, code 6/8), exit 4 CAPPED, and the structural-or-stop card read at the cap. | A round exited 4, OR the audit reached round 6 without converging. |
| `references/prerequisite-ladder.md` | Step 0 prerequisite ladder — absent helper bundle or auditor route, and reporting a run that did not happen. | Step 0 — a prerequisite did not resolve (helper scripts missing, no GPT route), OR about to report a run that degraded or did not happen. |
| `references/pivot-rule.md` | Pivot rule - findings recurring in one file or concern for 3 consecutive rounds mean rethink the design, not loop. | Step 3 - same file or concern accepted in 3 consecutive rounds. |
| `references/verification-discipline.md` | Verification discipline — pinned citations, figure provenance, two-direction proof, attribution, consumer-side checks. | Step 4.5 — a finding was fixed WITH a new test or guard and it must be proven red-then-green, OR authoring a contract test from a one-off check. ALSO Step 6 — about to emit the convergence report's pass/wave census, to apply §7's named-state rule. |
| `examples/contract-test-scaffold.md` | Contract-test scaffold — subject probe, negative control, vacuous-pass guard, disposition, retirement. | Step 4.5 — promoting a one-off check into a permanent contract test. |
| `references/worktree-preflight.md` | Worktree preflight remedy — the skills:hydrate npm script to add when a linked worktree lacks the tooling tree. | A command dies with `MODULE_NOT_FOUND` in a linked worktree AND this repo has no `skills:hydrate` script. |

— end of /audit-code —

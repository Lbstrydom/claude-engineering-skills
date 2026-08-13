---
name: audit-code
description: |
  Iteratively audit code against a plan with GPT + Gemini final gate.
  5-pass parallel static analysis (structure, wiring, backend, frontend,
  sustainability), R2+ ledger-driven suppression, debt capture for
  out-of-scope findings, max 6 rounds with 2-stable-rounds convergence.
  Triggers on: "audit my code", "audit my changes", "audit my PR",
  "check the implementation", "review my code", "audit code", "/audit-code",
  "audit this", "verify the implementation".
  Usage: /audit-code <plan-file>              — Audit code against plan (--scope diff default)
  Usage: /audit-code <plan-file> --scope plan — Audit only files mentioned in the plan
  Usage: /audit-code <plan-file> --scope full — Full repo audit
---

# Code Audit Loop

Multi-pass code audit with GPT + Gemini final review. Iterates until
findings stabilise or max 6 rounds.

**Input**: `$ARGUMENTS` — plan file path (the spec the code is being audited
against). Optional flags: `--scope diff|plan|full`.

---

## Step 0 — Parse Input and Validate

Validate: plan file exists, `OPENAI_API_KEY` is set. Optional:
`GEMINI_API_KEY` for Step 7 (falls back to Claude Opus when absent).
`SUPABASE_AUDIT_URL` for cloud learning (optional).

Initialise session ID: `SID=audit-code-$(date +%s)`.

Show kickoff card:
```
═══════════════════════════════════════
  /audit-code — Starting
  Plan: <path> | Max 6 rounds | SID: $SID
═══════════════════════════════════════
```

---

## Step 0.5 — Architectural-memory catalogue (--scope=full only)

When `--scope=full`, fetch the repo's symbol catalogue from architectural
memory (if populated) and inline a "Symbol catalogue" section into the
prompt context. This helps the auditor catch cross-file duplication that
diff-scope cannot see.

```bash
# 1. Resolve repo identity + active snapshot
node scripts/cross-skill.mjs get-active-refresh-id --repo-uuid "$(node scripts/cross-skill.mjs resolve-repo-identity | jq -r .repoUuid)"
# 2. Fetch top-N symbols (env-tunable: ARCH_AUDIT_FULL_TOPN, default 200)
node scripts/cross-skill.mjs list-symbols-for-snapshot --json '{"refreshId":"<from step 1>","limit":200}'
```

Format the rows as a `## Symbol catalogue (top N by domain)` section
with `(domain alphabetical, symbol_name alphabetical)` ordering. Note
truncation in the section header if `count == limit`.

States:
- `cloud:false` or `refreshId:null` → skip section silently (audit proceeds normally).
- `RPC_ERROR` → skip section, log warning to stderr.

This step is advisory. Audit must work even if architectural memory is
unavailable — never fail the run.

---

## Step 1 — Choose Audit Scope

**CRITICAL**: GPT doesn't know what's "new" vs pre-existing — it flags
everything in scope. Choose deliberately:

| Scope mode | When to use | Behaviour |
|---|---|---|
| `--scope diff` (**DEFAULT**) | "audit my recent work", after implementing a phase | Auto-scopes to changed files with a **dirty-aware base** + unstaged + untracked (see below) |
| `--scope plan` | Large refactor touching many files; user wants broad view | All files referenced in the plan |
| `--scope full` | "audit the entire codebase" — explicit codebase-wide request | Full repo audit — slowest, catches cross-cutting issues |

Default is `--scope diff`. Switch only when the user explicitly asks or `git diff` is empty.

**Dirty-aware base (default) + the `--base` override (read this before clustered/resumed audits).**
With no `--base`, `openai-audit.mjs` resolves the diff base by the working
tree's state: **dirty → `HEAD`** (audit only your *uncommitted* work) /
**clean → `HEAD~1`** (audit your last commit). This prevents the over-capture
failure where an **already-shipped + already-audited** prior commit gets
re-pulled into scope and floods the audit with out-of-scope findings (observed
in ai-organiser: 33/34 findings were a previous audited cluster). The resolved
base is logged as `[scope] base resolved to <ref> …`.

⚠ **When the prior commit was already audited but you have BOTH committed and
uncommitted work** (e.g. resuming a clustered build where Cluster A/B is
committed and Cluster C is in-flight), pass `--base` explicitly to scope to
exactly the new work — e.g. `--base <clusterStartRef>` or `--base HEAD` — and
likewise scope the Gemini gate's `--diff` to the same range. Never rely on the
default to separate audited-from-unaudited across a commit boundary.

---

## Step 2 — Run Code Audit

### Round 1

```bash
node scripts/openai-audit.mjs code <plan-file> \
  --scope diff \
  --out .audit/$SID-r1-result.json \
  2>.audit/$SID-r1-stderr.log
```

### Round 2+

R2+ mode changes the prompt rubric and enables ledger-driven suppression.
Full flag contract, smart pass selection, automatic behaviour, and
tool pre-pass rules: `references/r2-plus-mode.md`.

```bash
# Dirty-aware base — match R1's scope (which uses `git status --porcelain`, so
# UNTRACKED files count as dirty; do NOT use `git diff --quiet`, it ignores
# untracked). Dirty tree → HEAD (uncommitted work only); clean → HEAD~1 (last
# commit). The CLI's `[scope] base resolved to <ref>` log is the source of
# truth. Pass --base/clusterStartRef instead when separating audited-from-
# unaudited across a commit boundary.
BASE=$([ -n "$(git status --porcelain)" ] && echo HEAD || echo HEAD~1)
git diff "$BASE" -- . > .audit/$SID-diff.patch
# Include UNTRACKED new files — `git diff` omits them, so without this a brand-new file
# reaches the auditor with NO [CHANGED] annotation (it's still read in full via --files, but
# loses the diff focus markers). Append each as a /dev/null→file "new file" diff.
git ls-files --others --exclude-standard -z \
  | xargs -0 -r -I{} git diff --no-index --no-color -- /dev/null "{}" >> .audit/$SID-diff.patch 2>/dev/null || true
node scripts/openai-audit.mjs code <plan-file> \
  --round 2 \
  --ledger .audit/$SID-ledger.json \
  --diff .audit/$SID-diff.patch \
  --changed <csv> --files <csv> --passes <csv> \
  --out .audit/$SID-r2-result.json \
  2>.audit/$SID-r2-stderr.log
```

### Requirements rubric (automatic)

When `.requirements/ledger.json` exists, every code-audit pass is given a
`<requirements_rubric>` block — the repo's de-facto invariants (security /
safety / correctness / behavioural / persistence) the diff must not
violate. It is assembled by `getRequirementsContext` and injected through
the shared prompt builder; in-scope active requirements appear in full,
the rest as an index. No flag needed — ledger absent → audit is
unaffected. A stale ledger (in-scope files changed since extraction) or
uncovered target files surface as a `[requirements]` stderr line; if you
see `[stale]`, run `node scripts/requirements.mjs extract --files <…>`
then `reconcile` to refresh it. See `docs/plans/requirements-layer.md`.

### Duplication wave (Wave 5, automatic)

Alongside the 5 core passes, `/audit-code` always attempts a mechanical
**duplication** check: for each new/changed symbol in the diff, it queries
the architectural-memory index (read-only — never mutates it) for a
near-duplicate already indexed elsewhere. A genuine match becomes a
`[Duplication] Near-duplicate of existing symbol` finding that gates
convergence exactly like a `quickfix` finding does (reusing `is_quick_fix`).
Detection is pure Git (diffs the symbol against its base-revision content),
not the Postgres snapshot — so it's unaffected by a stale `arch:refresh`.
**Scope**: symbol extraction only covers JS/TS-family files
(`.js .jsx .mjs .cjs .ts .tsx`, ts-morph's parser) — a changed file in
another language isn't scanned and doesn't produce a "clean" verdict for
that file specifically; it's simply outside this wave's coverage today
(round-1 code-audit M8: an earlier draft of this section overclaimed
full multi-language scanning).

If the duplication is intentional (e.g. a CLI script deliberately staying
self-contained rather than taking a cross-module dependency), suppress it
in place with a pragma immediately above the declaration:

```js
// @duplicate-justification: target=scripts/lib/nav/schema.mjs:sha256 reason=nav-audit and visual-audit are deliberately independent sister lenses (AGENTS.md), not accidental duplication
```

The pragma's own MATCHING logic recognizes any comment syntax (`//`, `#`,
`/* */`, `<!-- -->`), for when JS/TS-family extraction eventually widens —
today it only ever fires on the JS/TS files the detector actually scans.
A pragma whose `target` doesn't actually match the detected near-duplicate
surfaces its own `[Duplication] Orphaned suppression pragma` finding
rather than being silently honoured or ignored.

Opt out for a single run with `--passes <csv>` omitting `duplication`
(same mechanism as any other pass). No `.env` var needed; it degrades to a
silent, non-blocking `unavailable` state when the architectural-memory
store isn't configured for this repo.

Plan: `docs/plans/audit-code-duplication-wave.md`.

### Handle results

If `verdict` is `INCOMPLETE` (passes timed out), offer: re-run with higher
timeout, or continue with partial results.

### Show results

```
═══════════════════════════════════════
  ROUND 1 AUDIT — SIGNIFICANT_ISSUES
  H:6 M:10 L:5 | Deduped: 3 | Cost: ~$0.45
  Top: [H1] Missing auth on /api/...
═══════════════════════════════════════
```

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

**Honest-deferral check (Design right-sizing, AGENTS.md — the band-aid escape
hatch).** `defer` is the place "patched the easy way" hides. A `defer` of a
`valid` `in-scope` finding must name three things: (1) the **root cause**;
(2) the **minimal in-scope fix you considered and rejected**; (3) the **residual
risk**. A `defer` of an `out-of-scope` finding must additionally name the
**independence** — one sentence stating the new code does not call/depend on the
cited path (the load-bearing test above). If you can't write that sentence
truthfully, it's load-bearing → `fix-now`. Invariant: **never `defer` because
the correct fix is merely larger** — size is not scope, and neither is
authorship. Legitimate `defer` = a true (impact-tested) scope boundary or
explicitly accepted, documented debt. Strongest form: drop a `TODO` at the cited
line naming the root cause, so the dodge becomes a visible artifact. (The
over-engineering cliff is caught symmetrically by Gemini's `over_engineering_flags`
in the final review.)

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
node scripts/openai-audit.mjs rebuttal <plan-file> <rebuttal-file> \
  --out .audit/$SID-resolution.json 2>.audit/$SID-rebuttal-stderr.log
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
| Threshold met, 0 new, 2/2 stable | **CONVERGED** → Step 6, then REQUIRED Step 7 |
| Round 6, not stable | Present to user, then REQUIRED Step 7 |

**Max 6 rounds for code audits.**

**Step 7 (Gemini final review) is MANDATORY** after the last audit round,
regardless of convergence — except when both `GEMINI_API_KEY` and
`ANTHROPIC_API_KEY` are absent.

---

### Step 3.7 — Detector-first census (cross-cutting findings)

**An audit's instance count is a floor, not a scope.** Measured 2026-07-31: a finding
reported 1 non-atomic writer (there were 4) and 3 misnamed call sites (there were 5). An
LLM enumerating a class by reading is doing exhaustive search with a next-token predictor;
it stops early. So the *tool* enumerates, not you.

**Trigger is mechanical**: `affectedFiles.length > 1` (or an explicit `crossCutting: true`
you set at triage). Single-file findings are exempt — this is not ceremony for every bug.

For each cross-cutting finding, record a detector on its ledger entry:

```json
{ "detector": { "kind": "regex",
                "pattern": "fs\.writeFileSync\(",
                "globs": ["scripts/**/*.mjs"],
                "baseline": 4,
                "disposition": { "scripts/<file>.mjs::const t = fs.writeFileSync(p)": "exempt — temp file" } } }
```

- **Structured, never a shell command.** `pattern`/`globs` reach ripgrep as argv. The
  ledger is LLM-authored and merge-edited; an executable string there is an injection
  surface.
- **Dispositions key on `<path>::<trimmed matched line>`**, never a line number — a line
  number orphans the moment anything above it shifts. Identical text repeated in one file
  gets `::#1`, `::#2`, … after the first, so exempting one copy does not exempt the rest
  (`matchKey` prints the key; copy it from the run's output rather than typing it).
- **The detector's output IS the fix scope.** Run it, fix what it found, or disposition it
  with a reason. Do not fix the instances the audit happened to name and stop.

## Step 3.5 — Update Adjudication Ledger

After each deliberation round, write ledger entries for every finding before
proceeding to Step 4. The ledger drives R2+ rulings injection and post-output
suppression.

Full writer invocation example + status field semantics: `references/ledger-format.md`.

---

## Step 3.5b — Record Triage Outcomes (closes the adaptive-learning loop)

**Automatic for rounds 1..N-1 — no manual step.** When you invoke
`openai-audit.mjs` for the next round (N ≥ 2), it finalizes the **prior** round's
accepted/dismissed outcomes from the ledger you just wrote, before running round N.
This relies on the `…-r<N>-result.json` `--out` naming convention (which this
skill already uses) and is best-effort — a failure logs and the audit proceeds.
It bridges the ledger → `finding_adjudication_events` + `audit_pass_stats` +
`audit_findings` + `audit_runs.labeled` (cloud) and `.audit/outcomes.jsonl` (local
bandit reward), idempotently. So the bandit / FP-learning / prompt evolution get
their ground-truth training signal without you remembering to run anything.

**Manual fallback — run ONLY when there is no "next round" to carry the capture:**
the **final converged round** of a standalone audit, a **1-round** audit, or
**non-Claude-Code / cloud-off CI** where the orchestrator path didn't fire. (Inside
`/cycle`, finalization is fully covered — skip this.)

```bash
node scripts/write-code-outcomes.mjs \
  --result .audit/$SID-r<N>-result.json \
  --ledger .audit/$SID-ledger.json \
  --round <N>
```

Both the automatic path and this CLI delegate to the same shared
`finalizeRoundOutcomes`, so they are idempotent — running the manual step after an
automatic capture re-labels (cloud) and skips the local append (marker-guarded),
never double-counting.

> **Precondition: the ledger must already carry per-finding rulings.** This CLI
> *records* adjudications; it does not make them. Run Step 3.5 first. With an
> empty or all-`pending` ledger it reports `0/N findings labelled · cloud=ok`
> and exits 0 — success-shaped, having closed nothing (reported live
> 2026-08-08). It now prints a `WARN:` line naming which of the three causes
> applies (no entries / all pending / ruled-but-unjoined identity mismatch) and
> carries the same text as `warning` on its JSON. **`labelled: 0` with a
> non-zero `total` is a failure to fix, never a pass.**

---

## Step 3.6 — Debt Capture

Persist out-of-scope valid findings to `.audit/tech-debt.json` so future
audits suppress them automatically. Eligible candidates: Step 3 triage
findings with `action = defer`.

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
> [`finding-verification.mjs`](../../scripts/lib/audit/finding-verification.mjs),
> never on a hand-rolled copy of the rule.

**Track which files you modify** — you'll need this for `--changed` in Step 5.

```
═══════════════════════════════════════
  FIXING — 17 findings
  Auto-fixed: 3 (mechanical)
  Fixed per recommendation: 8
  Compromises: 2
  Skipped (LOW): 4
  Files modified: shared.mjs, openai-audit.mjs
═══════════════════════════════════════
```

List each fix: `[ID] description → file:lines`.

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

**A before/after observation is not a negative control.** Watching a
*pre-existing* defect go red→green says nothing about whether the *repaired*
check would go red again — the repaired probe has then only ever been observed
passing, and an always-passes probe is indistinguishable from a correct one.

**Assertions of the form "expect empty" need a vacuous-pass guard.** A silently
broken search returns nothing, which is exactly what passing looks like. Add one
assertion proving the probe can find something it must find.

**When the check itself fails, suspect the instrument first.** In one measured
session, six consecutive verification-script failures were all instrument
defects — directory entries counted as files, XML entities breaking matches,
`grep` eating leading-dash content as flags.

**If the guard is worth keeping past this session, scaffold it properly** —
`examples/contract-test-scaffold.md` carries the three-part skeleton plus the
`disposition` and retirement fields, so a temporary guard cannot quietly become
a permanent one. → `references/verification-discipline.md` §3, §5.

---

## Step 5 — Verify and Loop (R2+ Mode)

After fixes, re-audit using R2+ mode (back to Step 2):

1. Collect files modified during Step 4 → `--changed`
2. Compute scope: changed + importers → `--files`
3. Generate diff (dirty-aware base, matching R1 — untracked counts): `BASE=$([ -n "$(git status --porcelain)" ] && echo HEAD || echo HEAD~1); git diff "$BASE" -- . > .audit/$SID-diff.patch` — then append UNTRACKED new files (`git diff` omits them): `git ls-files --others --exclude-standard -z | xargs -0 -r -I{} git diff --no-index --no-color -- /dev/null "{}" >> .audit/$SID-diff.patch 2>/dev/null || true`
4. Build `--passes` from file types
5. Run R2+ audit with `--round <N> --ledger --diff --changed --files`

Track finding churn using `_hash` fields: resolved / recurring / new.

```
═══════════════════════════════════════
  ROUND 2 → ROUND 3 (R2+ mode)
  H:0 M:2 L:1 | New: 0 | Suppressed: 11
  Stable: 1/2
═══════════════════════════════════════
```

### Step 5.0b — Re-run every detector at FULL scope (blocks convergence)

```bash
node scripts/lib/audit/detector.mjs .audit/$SID-ledger.json
```

Exit 0 = every detector reached zero and every match is dispositioned; exit 1 =
blocked; exit 2 = the ledger could not be read, which is "no census happened"
and never a pass.

**At each detector's own `globs`, NOT the round's changed files.** Restricting to the diff
defeats the census: fix 1 of 4 occurrences and the other 3 are absent from the diff, so the
detector returns 0 and the round converges clean — the audit's undercount faithfully
reproduced by the tool built to prevent it.

Full scope closes both gaps in one run:
- a class member left **unfixed** still matches (the census);
- an occurrence the fix itself **just wrote** also matches (author mimicry — twice on
  2026-07-31 a fix reproduced the class it was fixing, because the buggy shape was in the
  context window).

`evaluateConvergenceWithDetectors` (`scripts/lib/audit/convergence.mjs`) enforces this —
convergence requires `blocked === false`. `baseline` reports progress; it is never the pass
condition.

### Step 5.1 — Debt Resolution Prompt

After verification, reopened debt topics with no matching finding this round
are candidates for resolution. Full prompt + resolver invocation:
`references/debt-capture.md`.

---

## Step 6 — Convergence Report (Pre-Final)

```
═══════════════════════════════════════
  CONVERGED — Round 4
  Final: H:0 M:2 L:1
  Rounds: 4 | Time: 14m | Cost: ~$0.20
  Files changed: 6
  Remaining (accepted): [M3], [M7]
═══════════════════════════════════════
```

Save convergence snapshot to `docs/plans/<name>-audit-summary.md`.

Do not close the loop in Step 6 — completion requires Step 7.

### Step 6.5 — Regenerate Telemetry Dashboard (advisory, source-repo only)

**Source-repo-gated** — run ONLY when
`package.json.name === "claude-engineering-skills"`. Skip silently in
consumer repos (the dashboard is opt-in there — `docs/plans/local-dashboard.md`
§7.3). Never blocks the audit.

```bash
node scripts/build-dashboard.mjs telemetry 2>&1 || true
```

This refreshes the gitignored `dashboard/telemetry.html` so the just-run
audit's findings are visible in the local dashboard. Print the link:

```
Telemetry dashboard: file://<abs-path>/dashboard/telemetry.html
```

`telemetry.html` is gitignored — never staged, never committed.

### Step 6.5b — Solo author-model control (background, toggle-gated)

**Source-repo-gated** — run ONLY when `package.json.name === "claude-engineering-skills"`
(skip silently in consumers). The solo control is a *centralized* research baseline:
its blind human adjudication happens in one place, and a single source-repo run already
sweeps sibling repos' shadow commits via `SOLO_CONTROL_REPO_ROOTS`. So it collects
data for ALL local repos from here — it does not fragment across consumers.

Standing policy: whenever the model-A/B/C shadow (`arm-eval`) toggle is ON, keep the
**solo author-model baseline** current — clean Sonnet-5 + Fable-5 cold-diff over the
same shadow commits. This is the null-hypothesis control the A/B/C arms lack (do the
external auditor pipelines earn their keep vs a capable model reviewing the diff bare,
and is the *cheap* model already good enough?). See `docs/research/runbooks/solo-control-experiment.md`.

Fire it **in the background, non-blocking** (it takes minutes; it must NEVER delay or
gate the audit result):

```bash
node scripts/solo-control-audit.mjs run --model claude-sonnet-5 \
  && node scripts/solo-control-audit.mjs run --model claude-fable-5   # run backgrounded
```

The script **self-gates on the toggle** (no-ops when the shadow is off) and is
**incremental** (skips commits already covered), so this is safe to fire
unconditionally after every source-repo audit; sibling-repo shadow commits are swept
at the next source-repo run. Human blind adjudication is a separate offline step
(`solo-control merge` → label → `score`) — never inline. Best-effort: a failure here
is logged and ignored.

### Step 6.6 — Recommended next (à-la-carte advisor)

So the user doesn't have to remember the whole chain, suggest the FEW additional
lenses that fit THIS change. Pass the final-round audit result (the `--out` JSON —
its findings are the highest-signal input) so recommendations are grounded in what
the audit actually found:

```bash
node scripts/cross-skill.mjs recommend-skills \
  --findings .audit/$SID-r<final>-result.json --just-ran audit-code --format human
```

Print the card verbatim if non-empty; **if it's empty, say nothing** (a backend-only
change has no extra lenses — silence is correct, not a failure). It's an advisory
**nudge, never a gate** — the user chooses. The browser lenses (persona/click/nav/visual)
run against the **deployed** app, so at audit time they're "worth running after you
deploy"; `/ship` surfaces them again when the app is live. Ranked by leverage
(unguarded HIGH fix → theme → nav → semantic-DOM → journey), capped at 2, and it
never re-suggests a lens already covered for this commit.

### Step 6.7 — Cross-surface honesty clause (GREEN ≠ REALIZED)

A clean static audit is **necessary but not sufficient** for cross-surface agreement.
When the change introduces a user-visible DYNAMIC value (a count / status / total /
eligibility) that DUPLICATES or re-derives a value another surface shows, a green
verdict on the changed file does **not** prove the two will agree at runtime — this
class shipped a P0 past both `/audit-code` and the Gemini gate. If the frontend pass
raised a `derived-state-parity` finding (or you can see this pattern), do not close it
on "looks correct"; require one of the three checkable artifacts (shared SSoT / parity
assertion / a declared `data-engine-claim` surface) and **nudge the author to declare
the value as a `data-engine-claim` surface** so persona-test `--mode consistency`
verifies it at runtime. Affordance/intent judgements stay out of scope — this is only
the "two surfaces must show the same number" check.

---

## Step 7 — Gemini Independent Review (MANDATORY)

Run Gemini 3.1 Pro as the final gate. Falls back to Claude Opus when
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

```bash
# Pass --run-id <_cloudRunId> when the audit --out JSON carries one, so the
# final-review (and the optional shadow A/B reviewer) persist their per-finding
# results keyed to this audit_run. Read it from the audit result — pass the path
# as an ARGUMENT (process.argv[1]), never embed it as a literal string inside
# the -e source, so the SAME shell that resolved the audit's --out path resolves
# this one identically. (Artifacts now live in repo-relative `.audit/`, which
# every reader resolves the same way; under the old `/tmp/` layout Bash and Node
# disagreed outright — confirmed live 2026-07-26: Bash's /tmp landed in
# AppData/Local/Temp, Node's resolution of the same literal in C:\tmp, and the
# snippet threw MODULE_NOT_FOUND on a file that genuinely existed.) Found by tracing
# WHY a consumer repo's 101 real audit runs, over 30 days, all had a genuine
# Gemini verdict computed (visible in that session's own logs) but NEVER
# persisted to audit_runs — this exact snippet was silently throwing inside
# $(...), which discards the failure and leaves RUN_ID empty with no visible
# error. fs.readFileSync + JSON.parse (not require — this is a data file, not a
# module) with a try/catch fails safe to an empty RUN_ID rather than crashing.
# <N> = the last round actually run (matches the `-r<N>-result.json` convention
# Step 2/Step 3.5b/Step 6.6 already use — NOT a bare `-result.json`).
RUN_ID=$(node -e "const fs=require('fs'); try { process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],'utf8'))._cloudRunId||''); } catch { process.stdout.write(''); }" ".audit/$SID-r<N>-result.json")
# gemini-review.mjs itself now warns loudly (2026-07-26) when cloud is enabled
# but --run-id is absent — if you see that warning, the extraction above
# failed; don't ignore it. Omit --run-id only when cloud is genuinely off.
node scripts/gemini-review.mjs review <plan-file> .audit/$SID-transcript.json \
  --out .audit/$SID-gemini-result.json \
  ${RUN_ID:+--run-id "$RUN_ID"} 2>.audit/$SID-gemini-stderr.log
```

Verdict handling: `APPROVE` → done. `CONCERNS` → deliberate, fix, re-run
Gemini. `REJECT` → present to user.

**Shadow A/B reviewer (optional, observation-only)**: set `FINAL_REVIEW_SHADOW`
(e.g. `claude-opus`) to run a second blind reviewer in parallel with the
primary — it never gates the build, attributes findings per `source_model`, and
persists the diff for `final-review-stats`. No-op when unset or under an Azure
profile. See `docs/plans/final-review-shadow-reviewer.md`.

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

## Key Principles

1. **Peer relationship** — neither model blindly defers
2. **Three-model system** — Claude (author) + GPT (auditor) + Gemini (final arbiter)
3. **Fix all HIGH**, MEDIUM until ≤2, LOW optional
4. **Stability over speed** — 2 clean rounds required
5. **No quick fixes** — band-aids rejected by all models
6. **Deliberation is final** — no infinite debate
7. **Graceful degradation** — failed passes, missing keys, missing ledger all skip cleanly
8. **No self-review** — Step 7 final gate reviews Claude-GPT transcript
9. **Adaptive learning** — outcomes logged, FP patterns tracked, prompts improve

---

## Reference files

This skill's canonical flow is above. The files below cover specialised
situations — read them only when the trigger applies.

| File | Summary | Read when |
|---|---|---|
| `references/r2-plus-mode.md` | R2+ audit mode — ledger rulings, diff annotations, smart pass selection, suppression. | Round ≥ 2 AND need to choose passes OR troubleshoot suppression. |
| `references/ledger-format.md` | Adjudication ledger schema + writer invocation example for each finding outcome. | Step 3.5 — about to write ledger entries, OR diagnosing R2+ suppression misbehaviour. |
| `references/debt-capture.md` | Phase D debt ledger — persist out-of-scope valid findings so they don't re-surface. | Step 3.6 — candidate deferrals present, OR Step 5.1 — debt resolution prompt firing, OR periodically to cluster/resolve the accumulated backlog (see its "Periodic Debt Health" section). |
| `references/gemini-gate.md` | Step 7 Gemini independent review protocol — transcript, verdict handling, re-review loop. | Step 7 starting, OR Gemini returned CONCERNS/REJECT and need deliberation rules. |
| `references/verification-discipline.md` | Verification discipline — pinned citations, figure provenance, two-direction proof, attribution, consumer-side checks. | Step 4.5 — a finding was fixed WITH a new test or guard and it must be proven red-then-green, OR authoring a contract test from a one-off check. |
| `examples/contract-test-scaffold.md` | Contract-test scaffold — subject probe, negative control, vacuous-pass guard, disposition, retirement. | Step 4.5 — promoting a one-off check into a permanent contract test. |

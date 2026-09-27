---
summary: Step 7 Gemini independent review protocol — transcript, verdict handling, re-review loop.
---

# Gemini Independent Review — Step 7 Protocol

> **GENERATED COPY — do not edit.** The canonical is
> [`docs/audit/shared-references/gemini-gate.md`](https://github.com/Lbstrydom/claude-engineering-skills/blob/main/docs/audit/shared-references/gemini-gate.md).
> Regenerate with `node scripts/sync-shared-audit-refs.mjs`; `npm run check`
> fails on drift. Links above were re-spelled for this location — a target
> outside `skills/` becomes an absolute upstream URL, because this copy is
> copied again into `.claude/skills/` and then into consumer repos, where no
> relative path reaches it. So this file is NOT byte-identical to the
> canonical by design.

After the final GPT audit round (whether converged or not), run
Gemini 3.1 Pro as an independent third reviewer. This step is MANDATORY —
Gemini provides cross-model perspective that catches blind spots in the
Claude-GPT deliberation.

**Provider / no-key degradation ladder (don't just skip).** Each rung asks
whether a ROUTE exists, not whether one public variable is set — the rung 2a
Azure branch was missing until 2026-08-27, so on an Azure-only tenant (no
`GEMINI_API_KEY`, no `ANTHROPIC_API_KEY`) this ladder sent the reader to rung 3
while `gemini-review.mjs` would in fact have used Foundry Claude. That is the
env-var-instead-of-route class AGENTS.md records three prior instances of, and
it made this ladder disagree with the auto-selection order documented below.
1. `GEMINI_API_KEY` set → Gemini (preferred).
2. else the **Azure profile is active** (`AZURE_OPENAI_ENDPOINT`) → Foundry
   Claude, via `azureConfig.claudeRoute`. No flag needed, and no public key is
   involved — this rung is unreachable by a check that only reads
   `ANTHROPIC_API_KEY`.
3. else `ANTHROPIC_API_KEY` set → `gemini-review.mjs` auto-falls-back to Claude Opus (no flag needed).
4. **else no route at all** → do NOT silently skip. Run an **independent adversarial
   review agent** over the union diff as the gate: spawn a fresh agent (Task/Agent)
   with the plan + the diff + the accumulated findings and the instruction *"act as
   an independent final reviewer — find what the author and GPT missed; default to
   skepticism."* Record its verdict in the same `APPROVE`/`CONCERNS`/`REJECT` shape
   and run the same closed loop. This preserves the cross-perspective gate when no
   provider key is available (it is the documented substitute, not a bypass). This
   substitute stands on its own and carries **no `--gate` downgrade of its own** —
   the GPT audit already ran and produced a real transcript; only the SECOND
   opinion was substituted. Contrast `references/prerequisite-ladder.md` Rung 1,
   whose substitute stands in for the audit itself (no transcript exists at all)
   and is therefore disclosed as `AUDIT_DEGRADED` with a forced `--gate not-run` —
   a strictly worse degradation than this rung's. The two ladders cover different
   prerequisites (the auditor route vs. this one, the final-reviewer route) and
   can fire independently or together; only rung 5 below (no agent available for
   THIS rung either) produces a machine-visible signal of its own.
5. **only** when neither a route nor an independent agent is available → output
   `FINAL_GATE_SKIPPED` and do not claim full final-gate validation.

## Build the transcript — a REAL step, run it

`gemini-review.mjs review` reads a transcript file; nothing else in the flow
writes one. Build it first — **do not hand-assemble the JSON.** A consumer
following the skill literally hit `File not found` here and hand-rolled a shape
inferred from this document (reported 2026-08-08); the builder exists so the
MANDATORY gate is never blocked on invented state.

```bash
node scripts/build-audit-transcript.mjs --sid $SID --changed "$CHANGED"
```

**`--changed` is shown from the first example on purpose** — a code audit is
the common case and the builder REFUSES without it, so an example that omits it
is an example that does not run (round-6 audit M2). Plan mode is the exception
and is covered below.

That discovers every `.audit/$SID-r<N>-result.json`, picks up
`.audit/$SID-ledger.json` when present, infers the mode from the session-id
prefix (`audit-plan-…` / `audit-code-…`), and writes
`.audit/$SID-transcript.json`.

**Code audits REQUIRE `--changed`** — the builder refuses without it. It
populates `changed_files`, the reviewer's scope filter; an empty list makes the
filter a silent no-op and every out-of-scope finding is accepted (see "When
Gemini makes category errors"). Pass the same list you gave the R1 audit:

```bash
node scripts/build-audit-transcript.mjs --sid $SID --changed "$CHANGED"
```

To review corpus-wide on purpose, say so with `--no-scope-filter`; the refusal
exists because the one-flag form hits the unscoped path by construction, and a
warning was not enough. Plan mode is exempt — its `changed_files` is empty by
contract.

Other flags: `--mode plan|code` (required when the sid doesn't carry the
prefix — it never guesses), `--result <path>` (repeatable; for the consolidated
`/cycle` gate or non-standard locations — **mutually exclusive with `--sid`**,
so a transcript can never mix two sessions' rounds), `--ledger <path>`
(**also repeatable** — /cycle's clustered execution runs one `/audit-code` per
cluster, each writing its OWN ledger; pass one `--ledger` per cluster ledger
and their entries merge into one `claude_resolutions` trail, rather than only
the last one passed silently winning), `--dir` (default `.audit`), `--summary`,
`--out`, `--json`.

> **`.audit/`, never `/tmp/`.** The transcript is the only replayable input for
> evaluating a cheaper or newer final reviewer, and `/tmp` is OS-cleaned — on
> Windows, Bash's `/tmp` and Node's `/tmp` are two *different* directories, so
> half the runs vanish into a directory nothing scans. A shadow A/B spent $50.90
> and left zero transcripts to replay. `.audit/` is gitignored (in this repo and,
> via the managed block, in every consumer) and retains the newest 25 transcripts
> regardless of age. Sweep it with `node scripts/audit-clean.mjs` (dry-run;
`--apply` deletes) — by path, because the `npm run audit:clean` alias exists in
the source repo only.

### The shape it produces (concrete contract)

`runFinalReview()` parses the transcript as JSON. Only two fields are
structurally load-bearing — **`code_files`** (paths it re-reads from the working
tree and inlines as "Code Files", so they always reflect the post-fix tree) and
**`changed_files`** (the scope filter). Everything else is dumped verbatim into
the prompt under "Audit Transcript".

```json
{
  "audit_mode": "code",
  "changed_files": ["src/a.mjs", "src/b.mjs"],
  "code_files":    ["src/a.mjs", "src/b.mjs"],
  "summary": "One-paragraph what-shipped + how findings were resolved.",
  "rounds": [
    { "round": 1, "findings": [ {"id":"H1","severity":"HIGH","file":"src/a.mjs","detail":"…"} ] }
  ],
  "claude_resolutions": ["R1 H1 [HIGH] accepted/fixed (sustain) — …"]
}
```

**A plan transcript carries NO code files.** The reviewer's prompt keys "this is
a plan audit" off their absence, so one stray path flips the gate into judging
unbuilt work as missing implementation. The builder forces both lists empty in
plan mode rather than trusting the caller.

`claude_resolutions` (how each finding was ruled and remediated) is
non-structural but materially improves the review — the builder derives it from
the adjudication ledger, which is why passing `--ledger` (or letting `--sid`
find it) is worth the keystroke.

## Run the review

```bash
node scripts/gemini-review.mjs review $PLAN_FILE .audit/$SID-transcript.json --mode $AUDIT_MODE --out .audit/$SID-gemini-result.json 2>.audit/$SID-gemini-stderr.log
```

**`--mode` is not optional for a plan audit.** It defaults to `code`, and in
`plan` mode it appends the plan-review block that stops the reviewer judging
absent implementations — the same category error `openai-audit --mode plan`
prevents upstream. Set `AUDIT_MODE=plan` in `/audit-plan`, `code` in
`/audit-code`.

`--out` writes a durable artifact + a one-line stdout summary; use it for a
readable result. Termination is guaranteed **with or without** it (idempotent
`finishAndExit` + hard-deadline watchdog) — a background run can't hang on a
lingering provider socket either way.

Provider auto-selection order (first-party only):
1. Gemini (when `GEMINI_API_KEY` is set)
2. Azure Foundry Claude (when the Azure profile is active)
3. Claude Opus fallback (when `ANTHROPIC_API_KEY` is set)

Provider-agnostic routes — **explicit selection only** (`--provider` /
`FINAL_REVIEW_PROVIDER`, never auto-detect): `openai-compatible` and `openrouter`
(any OpenAI-shaped gateway: OpenRouter/Together/Fireworks/Groq/vLLM/Ollama/LM
Studio). See `docs/runbooks/azure-work-profile.md` §Provider-agnostic final review.

Pass `--round 1` on the first run; round 2 is shown under Step 7.1.

## Process the result — `gateDisposition`, not the verdict word

Every new finding carries `release_blocking` + `blocking_basis`
(`acceptance_criterion` | `changed_code_regression` | `security` | `data_loss` |
`runtime_failure` | `none` — `none` exactly when not blocking). From those,
`gemini-review.mjs` computes **in code** a `gateDisposition` on the result JSON
(and in the stdout summary, `Gate: …`); `verdict` is left as the reviewer's own
word. Act on the disposition:

| `gateDisposition` | When | Action |
|---|---|---|
| `approve` | `APPROVE`, nothing blocking | Done → final report |
| `approve_with_debt` | `CONCERNS`/`CONCERNS_REMAINING`, no release-blocking finding, no HIGH `wrongly_dismissed` | Done. Capture the findings as debt (below) and list them in the report. Do not re-run; do not ask the user to override. |
| `blocked` | `REJECT`; any release-blocking finding; a HIGH `wrongly_dismissed`; the coverage gate fired; or a finding with a missing/contradictory pair (fail-closed) | `gateDispositionDetail.reasons` names why. Round 1 → Step 7.1. Round 2 → present the named items to the user. |

`APPROVE` with a release-blocking finding is `blocked` (the contradiction
resolves closed); a finding the existence gate **refuted** neither blocks nor
becomes debt. For `CONCERNS_REMAINING`, the disputed items are already settled
by your cited challenges — do not re-litigate them.

Max 2 final-review rounds — a **hard** cap, not a target, and now enforced in
code: `gemini-review.mjs` refuses `--round 3`. Each rerun is a fresh full review
of a scope that has grown by every fix, so a round-N reviewer will almost
always find *something*; "the last run still found things" is expected
behaviour, not evidence the change is unfit to ship.

**Release-blocking is the only question the cap leaves open**, and the
reviewer answers it per finding: a finding blocks ship only when it names at
least one of the five bases above in the reviewed change. Everything else —
defensive hardening, maintainability, DRY, "track as debt", findings the
reviewer itself calls non-blocking — is **tracked debt**. Capture it from the
result that closed the gate (non-blocking findings only; `--dry-run` previews):

```bash
node scripts/debt-auto-capture.mjs --final-review .audit/$SID-gemini-result.json --run $SID
```

then close the gate as **approved-with-debt** and list the debt.

## Step 7.1 — Deliberate on Gemini Findings (round 1, `blocked` only)

When round 1 is `blocked`, Claude deliberates on each `new_findings`
and `wrongly_dismissed` item — same peer relationship as GPT deliberation.
Fixing is required for the release-blocking items; the rest may be fixed or
left as debt:

1. **For each Gemini finding**, decide: ACCEPT, PARTIAL, or CHALLENGE
   - CHALLENGE must cite evidence (file paths, code, conventions)
   - Gemini catches things GPT missed — give extra weight to Gemini findings
2. **Fix accepted findings** — track which files changed
3. **Rebuild the transcript** so it carries the Step-7.1 state — rerun the
   builder with `--out .audit/$SID-transcript-v2.json`, `--summary` describing
   the Gemini round, and a `--changed` list that is the **union** of the PR diff
   and every file the Step-7.1 fixes touched. `changed_files` accumulates across
   rounds; the scope filter uses the union, so a file fixed in 7.1 that is
   missing from the list makes its own follow-up finding look out-of-scope.
   `runFinalReview()` re-reads file contents from the working tree on every
   call, so no manual content re-inlining is needed.
4. **Re-run the review as round 2**, handing it the round-1 result as
   structured memory. Round 2 is told the round-1 findings are settled and to
   review only regressions introduced by the fixes plus unresolved blocking
   items; a round-2 finding whose topic matches a round-1 finding is dropped in
   code (`_priorSuppressedCount`) unless the reviewer marks it `is_reopened`
   and cites the changed line:

```bash
node scripts/gemini-review.mjs review $PLAN_FILE .audit/$SID-transcript-v2.json --mode $AUDIT_MODE --round 2 --prior .audit/$SID-gemini-result.json --out .audit/$SID-gemini-result-v2.json 2>.audit/$SID-gemini-stderr-v2.log
```

**CRITICAL**: Do NOT use GPT to verify Gemini's findings — GPT already
missed them. Gemini must verify its own concerns were addressed. This
closes the loop properly.

Round 2 `approve`/`approve_with_debt` → done (capture debt from the `-v2`
result).

**After round 2 there is no 3rd round** — `--round 3` is refused. A round-2
`blocked` goes to the user with its named blocking items. Triage them by
finding *character* first, so what you escalate is only what deserves it:

- **Concrete design/correctness defect** (wrong contract, unsafe migration,
  dangling FK, data loss) → fix it, then **escalate to the user** with the
  round-2 result and the fix: the user decides whether the fix is verified
  (e.g. by a test) or needs a fresh audit cycle. There is no automated third
  final-review round. (Before 2026-09-27 this bullet granted "fix + run ONE
  more round"; the history below is why that exception was measured as rare.)
  **History of the retired exception** — a consumer session tracked
  by upstream report `aa6469b3` used it twice back-to-back (round 3 *and*
  round 4, both genuine, since-fixed defects), which reads as more than
  "rare" from n=1. **Checked against a broader sample before treating that as
  a miscalibration signal** (2026-09-19, `audit_runs`, this repo's own store,
  filtered to real invocations — `arm_eval_run_id`/`experiment_tag`/
  `assignment_id` all null, which excludes the arm-eval/model-ab/shadow
  harnesses that otherwise dominate the row count): of 58 non-harness
  `/audit-plan` sessions across this repo, wine-cellar-app and ai-organiser
  that reached the Gemini gate at all, **zero** invoked Gemini a second time,
  let alone a third — every one of them settled on its first Gemini verdict.
  So the storyline session is a genuine outlier against this sample, not
  evidence the round-2 cap is generally too low; **do not raise the cap or
  loosen the exception's bar off this one session**. The caveat: storyline
  itself is barely represented in this store (3 rows, one session, no Gemini
  re-invocation recorded) because it reports upstream against its own Azure
  store, not this one — so this comparison is "this repo's workflow vs. one
  storyline session," not "storyline's own history vs. itself." If storyline
  (or any other consumer) sees the exception fire repeatedly across *its own*
  sessions, that pattern — not a single occurrence — is what would justify
  revisiting the cap. Note each escalation (what the defect was) so that
  pattern is visible to whoever next reviews this cap.
- **Implementation-completeness** ("specify the store step", "where does the
  cooldown go", a missing parameter) → **STOP**. Fold the items into the
  plan/PR as captured notes; these belong to the **code** audit, which checks
  them against the real implementation — the correct artifact. The gate proves
  *design soundness*, not implementation completeness.
- **Rising coherence/praise + ~1 nit/round** → **STOP**. The diminishing-returns
  tail; record the nit and close.

Record the stop (round count + why). Escalate to the user only for an
unresolved design defect, never for the implementation tail.

## When Gemini makes category errors

Two flavours surface repeatedly:

### Flavour 1 — Plan-vs-current-state confusion

Gemini sometimes reviews the current code state rather than the
plan/deliberation trail (e.g. flags "missing crash-safe WAL" when the
plan explicitly schedules that for a future phase). Claude should
CHALLENGE with evidence ("this is scheduled for Phase B.1, not yet
shipped"). Document the challenges in the final report so reviewers
see the deliberation trail.

### Flavour 2 — Out-of-scope file findings

Gemini sees the full code corpus (plan-referenced files + inlined
context) and sometimes flags issues in files NOT modified by this PR.
This is now mitigated by two layers:

1. **System-prompt rule 8** instructs the reviewer that
   `new_findings[]` entries must cite a file from the "Files In Scope
   (PR diff)" block.
2. **`applyScopeFilter()` post-output filter** drops `new_findings`
   whose `file` field isn't in the transcript's `changed_files[]`. The
   dropped count + IDs are logged to stderr as `[scope-dropped]` and
   recorded on the result envelope as `_scopeFilteredCount` +
   `_scopeFilteredFindings[]` so they're auditable.

For this to work you MUST populate `transcript.changed_files` — pass
`--changed` to the builder (see "Build the transcript" above; it warns on
stderr when a code-mode transcript ends up with an empty list). If the list is
empty, the filter is a no-op (Gemini auto-falls-back to corpus-wide review,
which is the pre-existing behaviour — at least the issue is visible in the
result envelope).

`wrongly_dismissed[]` is intentionally NOT scope-filtered: a finding
the GPT deliberation dismissed may live anywhere in the codebase
(including unchanged files referenced by changed code), so Gemini
re-raising it is legitimate cross-cutting analysis. Only `new_findings[]`
are scope-filtered. **In place of scope-filtering, `wrongly_dismissed`
entries are constrained by Rule 7's provenance requirement** — each
entry must either (i) cite a concrete prior dismissed finding by its
`original_finding_id`, or (ii) state the linkage from any cited
unchanged-file evidence to a changed file. Scope-creep that meets
neither bar is rejected at the prompt-rule layer.

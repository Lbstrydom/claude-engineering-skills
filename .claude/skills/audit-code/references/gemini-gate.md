---
summary: Step 7 Gemini independent review protocol — transcript, verdict handling, re-review loop.
---

# Gemini Independent Review — Step 7 Protocol

> **GENERATED COPY — do not edit.** The canonical is
> [`docs/audit/shared-references/gemini-gate.md`](../../../docs/audit/shared-references/gemini-gate.md).
> Regenerate with `node scripts/sync-shared-audit-refs.mjs`; `npm run check`
> fails on drift. Relative links above were rewritten for this location,
> so this file is NOT byte-identical to the canonical by design.

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
   provider key is available (it is the documented substitute, not a bypass).
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
so a transcript can never mix two sessions' rounds), `--ledger`, `--dir`
(default `.audit`), `--summary`, `--out`, `--json`.

> **`.audit/`, never `/tmp/`.** The transcript is the only replayable input for
> evaluating a cheaper or newer final reviewer, and `/tmp` is OS-cleaned — on
> Windows, Bash's `/tmp` and Node's `/tmp` are two *different* directories, so
> half the runs vanish into a directory nothing scans. A shadow A/B spent $50.90
> and left zero transcripts to replay. `.audit/` is gitignored (in this repo and,
> via the managed block, in every consumer) and retains the newest 25 transcripts
> regardless of age (`npm run audit:clean`).

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
node scripts/gemini-review.mjs review <plan-file> .audit/$SID-transcript.json \
  --mode $AUDIT_MODE \
  --out .audit/$SID-gemini-result.json 2>.audit/$SID-gemini-stderr.log
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

## Process the verdict

| Verdict | Action |
|---|---|
| `APPROVE` | Done → final report |
| `CONCERNS` | Step 7.1: Deliberate → fix → Gemini re-verify |
| `REJECT` | Present to user — needs human judgement |

Max 2 final-review rounds.

## Step 7.1 — Deliberate on Gemini Findings (CONCERNS only)

When Gemini returns `CONCERNS`, Claude deliberates on each `new_findings`
and `wrongly_dismissed` item — same peer relationship as GPT deliberation:

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
4. **Re-run Gemini review** with updated transcript:

```bash
node scripts/gemini-review.mjs review <plan-file> .audit/$SID-transcript-v2.json \
  --mode $AUDIT_MODE \
  --out .audit/$SID-gemini-result-v2.json 2>.audit/$SID-gemini-stderr-v2.log
```

**CRITICAL**: Do NOT use GPT to verify Gemini's findings — GPT already
missed them. Gemini must verify its own concerns were addressed. This
closes the loop properly.

If Gemini returns `APPROVE` on re-review → done.

**After round 2, do NOT auto-run a 3rd round.** Triage the round-2 `CONCERNS`
by finding *character* (mirrors the GPT "exceed cap only for genuine bugs" rule):

- **Concrete design/correctness defect** (wrong contract, unsafe migration,
  dangling FK, data loss) → the genuine-bug exception: fix + run ONE more round.
  Rare.
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

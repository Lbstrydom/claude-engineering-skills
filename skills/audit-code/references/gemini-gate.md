---
summary: Step 7 Gemini independent review protocol — transcript, verdict handling, re-review loop.
---

# Gemini Independent Review — Step 7 Protocol

After the final GPT audit round (whether converged or not), run
Gemini 3.1 Pro as an independent third reviewer. This step is MANDATORY —
Gemini provides cross-model perspective that catches blind spots in the
Claude-GPT deliberation.

**Provider / no-key degradation ladder (don't just skip):**
1. `GEMINI_API_KEY` set → Gemini (preferred).
2. else `ANTHROPIC_API_KEY` set → `gemini-review.mjs` auto-falls-back to Claude Opus (no flag needed).
3. **else neither key** → do NOT silently skip. Run an **independent adversarial
   review agent** over the union diff as the gate: spawn a fresh agent (Task/Agent)
   with the plan + the diff + the accumulated findings and the instruction *"act as
   an independent final reviewer — find what the author and GPT missed; default to
   skepticism."* Record its verdict in the same `APPROVE`/`CONCERNS`/`REJECT` shape
   and run the same closed loop. This preserves the cross-perspective gate when no
   provider key is available (it is the documented substitute, not a bypass).
4. **only** when neither a key nor an independent agent is available → output
   `FINAL_GATE_SKIPPED` and do not claim full final-gate validation.

## Build the transcript

Assemble `.audit/$SID-transcript.json` with the full audit trail:

> **`.audit/`, never `/tmp/` — the transcript is an artifact, not an
> intermediate.** It is the only replayable input for evaluating a cheaper or
> newer final reviewer, and `/tmp` is OS-cleaned (on Windows, Bash's `/tmp` and
> Node's `/tmp` are two different directories, so half the runs vanish into a
> directory nothing scans). A shadow A/B spent $50.90 and left zero transcripts
> to replay. Round results, diffs and stderr stay in `/tmp` — those genuinely
> are intermediates. `.audit/` is gitignored and retains the newest 25
> transcripts regardless of age (`npm run audit:clean`).

- Plan content, code files list
- **`changed_files: string[]`** — list of files modified by this PR (the
  `--changed` arg from your /audit-code R1 invocation). REQUIRED for
  scope-error prevention; see "When Gemini makes category errors" below.
- All rounds: GPT findings, Claude positions, GPT rulings, fixes applied
- Final state: remaining findings, dismissed findings
- Suppression data: kept / suppressed / reopened counts per round

### Standalone / consolidated transcript shape (concrete contract)

`runFinalReview()` parses the transcript as JSON; the only structurally-load-bearing
fields are **`code_files`** (paths it reads from the working tree and inlines as
"Code Files") and **`changed_files`** (the scope filter). Everything else is dumped
verbatim into the prompt under "Audit Transcript", so a hand-assembled object works
for a consolidated `/cycle` gate or any standalone call. Minimum viable shape:

```json
{
  "audit_mode": "code",
  "changed_files": ["src/a.mjs", "src/b.mjs"],
  "code_files":    ["src/a.mjs", "src/b.mjs"],
  "summary": "One-paragraph what-shipped + how findings were resolved.",
  "rounds": [
    { "round": 1, "findings": [ {"id":"H1","severity":"HIGH","file":"src/a.mjs","detail":"…"} ] }
  ],
  "claude_resolutions": ["H1 FIXED: …", "M2 DEFER (independent): …"]
}
```

To assemble from per-cluster `/audit-code` outputs: union the clusters'
`--changed` file sets into `changed_files`/`code_files`, and concatenate each
cluster's `--out` `findings` into the `rounds[]` trail (one entry per cluster or
round). `code_files` is re-read from disk on every call, so it always reflects the
post-fix tree — no manual content inlining. A `claude_resolutions` array (how each
finding was fixed/deferred/dismissed) is non-structural but materially improves the
review.

## Run the review

```bash
node scripts/gemini-review.mjs review <plan-file> .audit/$SID-transcript.json \
  --out /tmp/$SID-gemini-result.json 2>/tmp/$SID-gemini-stderr.log
```

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
3. **Update transcript** with Gemini findings, Claude positions, fixes applied.
   **Append any files modified during Step 7.1 to both `transcript.changed_files`
   and `transcript.code_files`.** `changed_files` accumulates across rounds (PR
   diff ∪ Step-7.1 fix-touched files); the scope filter uses the union.
   `runFinalReview()` re-reads file contents from the working tree on every
   call, so no manual content re-inlining is needed.
4. **Re-run Gemini review** with updated transcript:

```bash
node scripts/gemini-review.mjs review <plan-file> .audit/$SID-transcript-v2.json \
  --out /tmp/$SID-gemini-result-v2.json 2>/tmp/$SID-gemini-stderr-v2.log
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

For this to work you MUST populate `transcript.changed_files` (see
"Build the transcript" above). If the list is empty, the filter is a
no-op (Gemini auto-falls-back to corpus-wide review, which is the
pre-existing behaviour — at least the issue is visible in the result
envelope).

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

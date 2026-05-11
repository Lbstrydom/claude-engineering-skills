---
summary: Step 7 Gemini independent review protocol — transcript, verdict handling, re-review loop.
---

# Gemini Independent Review — Step 7 Protocol

After the final GPT-5.4 audit round (whether converged or not), run
Gemini 3.1 Pro as an independent third reviewer. This step is MANDATORY —
Gemini provides cross-model perspective that catches blind spots in the
Claude-GPT deliberation.

If `GEMINI_API_KEY` is not set, run Claude Opus fallback (`ANTHROPIC_API_KEY`).
Only skip Step 7 entirely when neither key is available. When skipped,
output `FINAL_GATE_SKIPPED` and do not claim full final-gate validation.

## Build the transcript

Assemble `/tmp/$SID-transcript.json` with the full audit trail:

- Plan content, code files list
- **`changed_files: string[]`** — list of files modified by this PR (the
  `--changed` arg from your /audit-code R1 invocation). REQUIRED for
  scope-error prevention; see "When Gemini makes category errors" below.
- All rounds: GPT findings, Claude positions, GPT rulings, fixes applied
- Final state: remaining findings, dismissed findings
- Suppression data: kept / suppressed / reopened counts per round

## Run the review

```bash
node scripts/gemini-review.mjs review <plan-file> /tmp/$SID-transcript.json \
  --out /tmp/$SID-gemini-result.json 2>/tmp/$SID-gemini-stderr.log
```

Provider auto-selection order:
1. Gemini (when `GEMINI_API_KEY` is set)
2. Claude Opus fallback (when `ANTHROPIC_API_KEY` is set)

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
node scripts/gemini-review.mjs review <plan-file> /tmp/$SID-transcript-v2.json \
  --out /tmp/$SID-gemini-result-v2.json 2>/tmp/$SID-gemini-stderr-v2.log
```

**CRITICAL**: Do NOT use GPT to verify Gemini's findings — GPT already
missed them. Gemini must verify its own concerns were addressed. This
closes the loop properly.

If Gemini returns `APPROVE` on re-review → done.
If `CONCERNS` again after 2 rounds → present to user.

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

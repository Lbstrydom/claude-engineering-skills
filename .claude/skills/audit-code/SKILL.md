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
  Usage: /audit-code <plan-file>             — Audit code against plan (--scope diff default)
  Usage: /audit-code <plan-file> --scope full — Full repo audit
---

# Code Audit Loop

Multi-pass code audit with GPT-5.4 + Gemini final review. Iterates until
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
| `--scope diff` (**DEFAULT**) | "audit my recent work", after implementing a phase | Auto-scopes to `git diff HEAD~1..HEAD` + unstaged + untracked files |
| `--scope plan` | Large refactor touching many files; user wants broad view | All files referenced in the plan |
| `--scope full` | "audit the entire codebase" — explicit codebase-wide request | Full repo audit — slowest, catches cross-cutting issues |

Default is `--scope diff`. Switch only when the user explicitly asks or `git diff` is empty.

---

## Step 2 — Run Code Audit

### Round 1

```bash
node scripts/openai-audit.mjs code <plan-file> \
  --scope diff \
  --out /tmp/$SID-r1-result.json \
  2>/tmp/$SID-r1-stderr.log
```

### Round 2+

R2+ mode changes the prompt rubric and enables ledger-driven suppression.
Full flag contract, smart pass selection, automatic behaviour, and
tool pre-pass rules: `references/r2-plus-mode.md`.

```bash
git diff HEAD~1 -- . > /tmp/$SID-diff.patch
node scripts/openai-audit.mjs code <plan-file> \
  --round 2 \
  --ledger /tmp/$SID-ledger.json \
  --diff /tmp/$SID-diff.patch \
  --changed <csv> --files <csv> --passes <csv> \
  --out /tmp/$SID-r2-result.json \
  2>/tmp/$SID-r2-stderr.log
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
then `reconcile` to refresh it. See `docs/completed/requirements-layer.md`.

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
- `validity=valid` + `scope=out-of-scope` → `defer` eligible (pre-existing debt)
- `validity=valid` + `scope=in-scope` + LOW → operator choice
- Only `validity=valid` findings can be deferred

Scope hint: compare the finding's cited files against `--changed` /
`--scope diff`. A finding pointing at code your PR didn't touch is
`out-of-scope` by definition.

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
  --out /tmp/$SID-resolution.json 2>/tmp/$SID-rebuttal-stderr.log
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

## Step 3.5 — Update Adjudication Ledger

After each deliberation round, write ledger entries for every finding before
proceeding to Step 4. The ledger drives R2+ rulings injection and post-output
suppression.

Full writer invocation example + status field semantics: `references/ledger-format.md`.

---

## Step 3.5b — Record Triage Outcomes (closes the adaptive-learning loop)

**MANDATORY after the ledger is written each round.** Persist the round's
accepted/dismissed outcomes so the adaptive-learning loop has ground truth:

```bash
node scripts/write-code-outcomes.mjs \
  --result /tmp/$SID-r<N>-result.json \
  --ledger /tmp/$SID-ledger.json \
  --round <N>
```

This bridges the adjudication ledger → `outcome-sync` → `finding_adjudication_events`
+ `audit_pass_stats` (accepted/dismissed) + `audit_findings` + `audit_runs.labeled`
(cloud) and `.audit/outcomes.jsonl` (local bandit reward). Without it those
columns stay 0 and the bandit / FP-learning / prompt evolution get **no
training signal** — the audit works but never improves.

Best-effort: a cloud failure logs and falls back to local-only; it never
blocks the audit. Run it once per round, after Step 3.5.

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
4. Record triage outcomes — `write-code-outcomes.mjs` (Step 3.5b)
5. Capture deferrable debt (Step 3.6)
6. Fix ALL findings together (Step 4)
7. Run tests
8. Verification audit (Step 5) — debt suppression runs automatically

---

## Step 4 — Fix Findings

ALL HIGH must be fixed. MEDIUM until ≤2 remain. LOW if mechanical.

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

---

## Step 5 — Verify and Loop (R2+ Mode)

After fixes, re-audit using R2+ mode (back to Step 2):

1. Collect files modified during Step 4 → `--changed`
2. Compute scope: changed + importers → `--files`
3. Generate diff: `git diff HEAD~1 -- . > /tmp/$SID-diff.patch`
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

---

## Step 7 — Gemini Independent Review (MANDATORY)

Run Gemini 3.1 Pro as the final gate. Falls back to Claude Opus when
`GEMINI_API_KEY` is absent.

```bash
node scripts/gemini-review.mjs review <plan-file> /tmp/$SID-transcript.json \
  --out /tmp/$SID-gemini-result.json 2>/tmp/$SID-gemini-stderr.log
```

Verdict handling: `APPROVE` → done. `CONCERNS` → deliberate, fix, re-run
Gemini. `REJECT` → present to user.

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
2. **Three-model system** — Claude (author) + GPT-5.4 (auditor) + Gemini (final arbiter)
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
| `references/debt-capture.md` | Phase D debt ledger — persist out-of-scope valid findings so they don't re-surface. | Step 3.6 — candidate deferrals present, OR Step 5.1 — debt resolution prompt firing. |
| `references/gemini-gate.md` | Step 7 Gemini independent review protocol — transcript, verdict handling, re-review loop. | Step 7 starting, OR Gemini returned CONCERNS/REJECT and need deliberation rules. |

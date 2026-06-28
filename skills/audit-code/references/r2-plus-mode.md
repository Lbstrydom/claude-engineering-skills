---
summary: R2+ audit mode — ledger rulings, diff annotations, smart pass selection, suppression.
---

# R2+ Audit Mode — Full Protocol

When `--round >= 2`, the audit script engages R2+ mode: a different prompt
rubric, ledger-driven rulings injection, diff-aware context, and
post-output fuzzy suppression of known-dismissed findings.

## Phase 0 — Tool Pre-Pass

Before GPT runs, the script executes language-appropriate static analysis:

- **JS/TS**: ESLint (+ `tsc --noEmit` for TS projects)
- **Python**: `ruff`, falling back to `flake8`

Tool findings carry a `classification` envelope with
`sourceKind: 'LINTER' | 'TYPE_CHECKER'` and are appended to `findings[]`
with `T`-prefixed IDs (`T1`, `T2`, ...).

| Flag | Default | Effect |
|---|---|---|
| `--no-tools` | off | Skip Phase 0 entirely. Use for untrusted repos — ESLint configs can `require()` arbitrary code. |
| `--strict-lint` | off (advisory) | Count tool findings in verdict math. Without this flag, tool findings are surfaced but don't affect PASS / NEEDS_FIXES / SIGNIFICANT_ISSUES. |

**Trust boundary**: running repo-configured linters executes code the repo
owner controls, equivalent to running `npm test`. Every invocation is
logged to stderr. See [scripts/lib/linter.mjs](scripts/lib/linter.mjs) for
full security notes.

**Advisory-by-default rationale**: tool availability varies across
machines (no `npx eslint` on a Python-only box). Counting tool findings in
the verdict would make it non-reproducible. Opt in with `--strict-lint`
when your CI environment has all the tools.

The result JSON includes
`_toolCapability: { toolsAvailable, toolsFailed, strictLint, disabled }`
so orchestrators can see which tools ran.

## Round 2+ invocation

```bash
# Generate diff from fixes
git diff HEAD~1 -- . > /tmp/$SID-diff.patch

# Build changed + files lists from Step 4 fix list
CHANGED="scripts/shared.mjs,scripts/openai-audit.mjs"
FILES="$CHANGED,scripts/gemini-review.mjs"  # changed + dependents

# Determine passes
PASSES="sustainability"  # always include
# Add backend if any backend file changed, frontend if frontend changed, etc.

node scripts/openai-audit.mjs code <plan-file> \
  --round 2 \
  --ledger /tmp/$SID-ledger.json \
  --diff /tmp/$SID-diff.patch \
  --changed $CHANGED \
  --files $FILES \
  --passes $PASSES \
  --out /tmp/$SID-r2-result.json \
  2>/tmp/$SID-r2-stderr.log
```

> **Windows / git-bash temp-path caveat (A3).** A `/tmp/...` path in an argv is
> MSYS-rewritten to `%LOCALAPPDATA%\Temp\...`, but a *literal* `/tmp/...` inside a
> separate `node -e` resolves to `C:\tmp\...` — so reconstructing the path in a
> follow-up command can miss the file. **Read the file back from the resolved
> absolute path the scripts echo** (`[out] Results written to <abs>` /
> `[ledger] wrote N entries → <abs>`), not from a re-typed `/tmp/...` literal.
> `--diff` expects a unified-diff **FILE** (not a git range), paired with `--changed`.

## CLI flag contract

| Flag | Source | Purpose |
|---|---|---|
| `--round <n>` | Orchestrator | Triggers R2+ mode (rulings, suppression, annotations) |
| `--ledger <path>` | Step 3.5 output | Adjudication ledger for rulings injection + suppression |
| `--diff <path>` | `git diff` output | Line-level change annotations in code context |
| `--changed <list>` | Step 4 fix list | **Authoritative** source for what was modified (reopen detection) |
| `--files <list>` | changed + dependents | Audit scope — what GPT sees in context |
| `--passes <list>` | Smart selection | Which passes to run |

## Smart pass selection

| Pass | When to skip on R2+ |
|---|---|
| `structure` | Skip ONLY if zero file additions/deletions/renames in the diff. Re-run if fixes created or deleted files. |
| `wiring` | Skip unless a route or API file was changed |
| `backend` | Run if any backend file changed |
| `frontend` | Run if any frontend file changed |
| `sustainability` | Always run (cross-cutting) |

## R2+ automatic behaviour

When `--round >= 2`, the script automatically:

1. **Loads ledger** → injects GPT's own prior rulings into system prompts
2. **Parses diff** → annotates changed lines with `// ── CHANGED ──` markers
3. **Computes impact set** → changed files + files that import from them
4. **Uses R2+ prompts** → "verify fixes + check regressions" instead of "find all issues"
5. **Post-output suppression** → fuzzy-matches findings against ledger, suppresses re-raises of dismissed items
6. **FP tracker** → auto-suppresses finding patterns with historically high dismiss rates

## R2+ post-processing report

The script automatically logs suppression stats to stderr:

```
═══════════════════════════════════════
  R2 POST-PROCESSING
  Kept: 2 | Suppressed: 11 | Reopened: 1
  Suppressed: a1b2c3 (0.82), 9f4d1e (0.78)...
═══════════════════════════════════════
```

Review suppressed topics to validate no legitimate findings were over-suppressed.

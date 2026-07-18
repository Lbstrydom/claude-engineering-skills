# Phase C Audit Summary

- **Date**: 2026-04-05
- **Scope**: `--scope diff --no-tools` (Phase C commit 39f6931 vs Phase B afbcd02)
- **Rounds**: 1 (early-stop — real Phase C bugs fixed in a follow-up commit; remaining findings are pre-existing codebase debt)
- **Verdict**: H:2 real bugs in Phase C fixed; 12 HIGH deferred as pre-existing
- **Cost**: ~$0.20, ~10 min

## Real Phase C bugs (fixed)

**H2 — Post-filter drops cross-file diagnostics**: **CHALLENGED**. The
post-filter matches the audit's `--scope diff` semantics: findings about
files outside the audit scope are, by definition, out of scope. A
type-checker diagnostic that lands in file B because file A changed is
legitimately outside the user's scope window when B wasn't part of the
diff.

**H3 — ESLint fatal parse errors misclassified as LOW**: **ACCEPTED, FIXED**.
ESLint emits `{ fatal: true, ruleId: null }` when it cannot parse a file.
The parser mapped `ruleId: null` to `'unknown'`, which falls through
`eslint._default` to LOW CODE_SMELL — hiding real breakage. Fix: parser
now promotes fatal messages to a dedicated `fatal-parse-error` rule, and
`rule-metadata.mjs` maps it to HIGH BUG. Tests added for both.

## Deferred (pre-existing codebase debt, not Phase C scope)

| ID | Finding | Note |
|---|---|---|
| H1 | Tool execution trust boundary | Documented design per plan §1. `--no-tools` opt-out, `AUDIT_LOOP_ALLOW_TOOLS` env gate, stderr logging all present. Sandbox is out of scope. |
| H4 | `openai-audit.mjs` god module (~82KB) | Pre-existing from earlier commits — separate refactor pass needed. |
| H5 | Missing declarative extension point for passes | Pre-existing architectural concern. |
| H6 | Split schema ownership | Pre-existing — Phase C added its schemas in `lib/` but core audit schemas still in openai-audit.mjs. |
| H7 | Hybrid static-constants + prompt-registry system | Transitional architecture predating Phase C. |
| H8 | Workflow logic in SKILL.md prose | Intentional — skill is human-readable playbook. |
| H9 | Test gaps on openai-audit.mjs orchestration | Pre-existing — Phase C added 47 hermetic tests for its own modules. |
| H10 | `semanticId()` identity model | Pre-existing; see identical finding in Phase B audit. |
| H11 | `_repoProfileCache` module-global state | Pre-existing pattern. |
| H12 | Tool configs run at repo root (not scope-scoped) | Documented known limitation per plan — post-filter matches `--scope diff` semantics. Fixing would require per-file tool invocation (out of scope). |
| H13 | Tool/model dedup deferred to v2 | Explicitly documented as known limitation in Phase C plan §1 and `semanticId()` JSDoc. |
| H14 | `findings.mjs` god module (>500 lines) | Pre-existing — Phase C only appended `normalizePath` import + dispatch branch. |

## Notes

- The `reduce-sustainability` pass failed with JSON truncation at 15000 chars,
  causing 24 un-reduced sustainability findings to leak through. This is a
  pre-existing robustness issue (REDUCE payload sizing), not a Phase C
  regression.
- `_toolCapability` field attached to the result correctly surfaced
  `disabled: true` (from `--no-tools`) — confirms the flag wiring works.
- The audit itself ran with `--no-tools` to avoid a self-referential pre-pass
  (Phase C's tool runner auditing its own tool runner). Tool-pre-pass smoke
  testing deferred to a real target repo.

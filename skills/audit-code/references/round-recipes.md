---
summary: Step 1–2 detail — dirty-aware base rationale, diff-recipe stderr handling, R2+ scope rule, requirements rubric.
---

# Round recipes — Step 1 and Step 2 detail

The commands live in `SKILL.md`; this file holds why they are shaped the way
they are. Read the section whose condition holds.

## Dirty-aware base — the over-capture it prevents

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

## Why `git diff --output`, not a shell redirect

`--output` makes git write the patch bytes itself. A PowerShell `>` re-encodes
them (UTF-16 on 5.1, CRLF on 7.x); the parser now tolerates both, but git's own
bytes are what the annotations were built for.

## The untracked-file append — `|| true` and the stderr log

The trailing `|| true` is required — `git diff --no-index` always exits 1 when the
compared files differ (expected on every invocation here, since one side is
always `/dev/null`), and `xargs` propagates that as its own nonzero exit even
on full success. But `2>/dev/null` used to throw away genuine `git ls-files`/
`xargs`/`git diff` failures alongside that expected exit, leaving no way to
tell "normal" from "broken" apart. Redirecting stderr to a file instead makes
real failures observable: `git diff --no-index` writes nothing to stderr for
the expected differ-from-`/dev/null` case, so any content in
`.audit/$SID-untracked-diff-stderr.log` is a genuine error — check it before
trusting the diff patch.

## R2+ scope is always the diff

**R2+'s scope is always the diff, not Round 1's `--scope` flag** — `--files`
is set on every R2+ invocation, and `openai-audit.mjs` ignores `--scope`
whenever `--files` is explicitly provided. This is deliberate, not a
propagation gap to close: Round 1's `--scope diff|plan|full` chooses what to
*discover*; once you're fixing specific findings, `$CHANGED`/`$FILES`
self-corrects to whatever you actually touched, which is the right R2+ scope
regardless of how broad Round 1 was. Do not add `--scope "$SCOPE"` here
expecting it to widen R2+ back to Round 1's scope — it would be silently
ignored by the same `--files` precedence rule.

## Requirements rubric (automatic)

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

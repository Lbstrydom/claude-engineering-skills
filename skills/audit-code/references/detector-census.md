---
summary: Detector-first census — the ledger detector schema, disposition keys, and why Step 5.0b re-runs at full scope.
---

# Detector-first census — Step 3.7 and Step 5.0b detail

## Step 3.7 — recording a detector (cross-cutting findings)

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

## Step 5.0b — why the re-run is at full scope

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

**Visibility, not a new gate.** This code-level convergence gate is unchanged.
What Step 6's census adds is purely the human-readable record: a detector
that errors during this full-scope re-run is reported as `errored` in the
CENSUS block, never silently folded into "the census reached zero." The
exit-2 case above ("no census happened … never a pass") is already a hard
code-level non-pass and is unaffected — Step 6.7 / Step 7 already have
standing to act on what the census now makes visible.

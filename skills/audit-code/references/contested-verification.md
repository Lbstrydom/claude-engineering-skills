---
summary: Quoted-line verification of contested findings: flow, item states, exit codes.
---

# Contested-finding verification

A finding the author disputes, or the auditor re-raises after a dismissal, used to cost a whole extra round to see whether it
came back. `node scripts/verify-findings.mjs` instead gives each such finding one deterministic evidence pack and one model call, so a
quoted line decides it inside the round. **A verdict is evidence for triage and is not a ruling**: nothing here writes the ledger
or dismisses a finding, and `adjudicationOutcome` still comes from your triage.

## Flow (Step 3, tiered rebuttal)

1. **Preliminary triage.** Write the triage JSON as usual. A row with `validity: "uncertain"` or `action: "rebut"` is a contest.
   In round 1 that file is the only source of contests; from round 2 a re-raised finding whose ledger entry was dismissed is also one.
2. **Verify, before you edit any file.** The evidence is read from the working tree, which must still be the audited tree.

   ```bash
   node scripts/verify-findings.mjs --sid "$SID" --round $R --triage .claude/tmp/triage-r$R.json --out .audit/$SID-r$R-verify.json
   node scripts/verify-findings.mjs --sid "$SID" --round $R --check .audit/$SID-r$R-verify.json
   ```

   `--check` re-validates each item against the repo and prints a `[verify: ...]` line **only for items that still validate**.
   Show triage those lines, never the raw artifact. Optional: `--max N` (default 10), `--run-test <tracked test path>` (at most two, named by you).
3. **Final triage.** Update the same triage file. A row that uses a verdict (for example a dismissal citing `refuted`) adds
   `"reliesOn": {"artifact": "<the --out path>", "packHash": "<the item's packHash>", "verdict": "refuted"}`.
   `write-ledger-entries.mjs` re-validates that item and refuses the whole batch if it no longer holds (`re-triage`).
4. **Rebuttal** receives only the `inconclusive`, `over-cap` and `failed` items, as today.

## What a verdict means

| Verdict | Shown to triage as | Triage may |
|---|---|---|
| `refuted`, evidence-backed | `[verify: refuted - E3 "..."]` | dismiss with `dismissReasonClass: false-positive`, citing the artifact |
| `confirmed`, evidence-backed | `[verify: confirmed - ...]` | keep the finding; `severityIfConfirmed` is advisory |
| `inconclusive` (raw or demoted) | `[verify: inconclusive -> rebuttal]` | send to rebuttal |

`evidence-backed` means the quoted text occurs verbatim in an eligible evidence item the model cited. It does not mean the quote
settles the question, so read it. A verdict whose quote is missing, too short, taken only from the finding's own text (`E0`),
from a withheld item or from a `--run-test` item is **demoted to `inconclusive`** with the rule that failed.
A same-family verification (verifier and finder from one vendor) is flagged `same-family`.

## Item states and exit codes

| State | Meaning | Goes to |
|---|---|---|
| `verified` | `confirmed` or `refuted`, evidence-backed | triage |
| `inconclusive` | no verdict met the bar | rebuttal |
| `over-cap` | beyond `--max`, not sent | rebuttal (the round card shows the count) |
| `failed` | call lost (429, timeout) or acquisition failed | rebuttal; the run is incomplete |

Exit `0` complete, `3` at least one item `failed` (INCOMPLETE: re-run), `2` bad input or the tree moved, `1` unsupported
`--model` (v1 takes GPT sentinels and ids only).

## Evidence and its limits

- Cited code (lines +/-40), an identifier grep over the working tree, history of the cited range (pinned to the HEAD sha, always
  redacted) and any `--run-test` summary, each through one acquisition boundary: sensitive and repo-escaping paths are withheld
  (the artifact records a hash, never the path), text is redacted and capped, the assembled pack is egress-checked.
- A **flip** (present, absent, present with no file change) is claimed only when the rounds carry `_auditedSha`; a flip whose
  latest appearance is before round N is listed in `notSelected`.
- Each round result is stamped with `_auditedTree`. A result without one (a round run before this stamp existed) is refused, and
  an edit between the round and the verification voids the run (exit 2).
- `--run-test` output and history items are context for the model and triage; neither can be the quoted proof.
- The final-review `wrongly_dismissed` items keep their own protocol (`references/gemini-gate.md`).

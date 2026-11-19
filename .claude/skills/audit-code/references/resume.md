---
summary: --resume - finish an INCOMPLETE round by replaying the passes that completed, so a 429 or timeout does not re-pay them.
---

# `--resume` - finish an INCOMPLETE round without re-paying finished passes

A round that ends `INCOMPLETE` (exit 3) because some passes were lost to a 429 or a timeout has already paid for the
passes that finished. Re-run **the same command with `--resume`** and only the lost calls go live.

```bash
# same --round, same --ledger/--diff/--files/--passes as the round that stopped, plus --resume
node scripts/openai-audit.mjs code "$PLAN_FILE" --round $R --resume --ledger .audit/$SID-ledger.json ... --out .audit/$SID-r$R-result.json
```

## What is replayed, and what is not

- Every **successful** structured call of a legacy code-audit round is recorded under
  `.audit/call-records/<auditedTree>/<sid>-r<round>/`. A failed, truncated or schema-rejected call is never recorded.
- A record replays only when ALL of these hold: same audited tree, same SID and round, same request (route, model,
  every output-affecting param, prompt, schema), and its stored result still parses against the current schema.
  Anything else is a miss and the call goes live. Time is never part of the identity.
- Without `--resume` nothing is replayed, so a fresh round stays fresh.

## What it refuses (exit 1, with the reason)

`--resume` on plan or rebuttal mode, with the tiered pipeline, with no audited-tree identity, without a resolvable
`--session-id`/`--round` (or a `<sid>-r<N>-result.json` `--out`), with `AUDIT_CALL_RECORD=0`, and when there is nothing
to resume for that SID and round at this tree. It never silently runs fresh.

## How a resumed round reads

The summary line carries `| resumed: <replayed>/<total> calls replayed` after the seconds field, the result carries
`_resume`, and the gate-evidence marker carries `resumed: true`. It is provenance, not a demotion: replayed responses
were produced for this exact tree and these exact prompts, so a completed resumed round counts like any other. A
resumed round that still has live failures is `INCOMPLETE` again (exit 3).

Records are kept for the newest 5 audited trees (`AUDIT_CALL_RECORD_KEEP`); `AUDIT_CALL_RECORD=0` turns recording off.

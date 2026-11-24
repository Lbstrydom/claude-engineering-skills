---
summary: Step 0.5h — triaging a consumer's upstream report: the owning store, the FULL uuid, and the freshness check.
---

# Triaging an upstream report (moved from SKILL.md Step 0.5h)

Triage against **the store that owns the row** — `upstream ack|fix|wont-fix`
writes to the ambient `AUDIT_DB_URL`, which is only one of them. For a report
belonging to another consumer's store, run the transition with that store's
DSN in the environment:

```bash
node scripts/cross-skill.mjs upstream ack --id ISSUE_UUID     # or fix --commit / wont-fix
```

Closing a report needs the **FULL uuid**, not a prefix — the committed
disposition ledger records what you typed, and `upstream:coverage:gate`
rejects a non-uuid key. Full ids: `node scripts/cross-skill.mjs upstream list
--worksheet` (ambient store) or the card above.

Before triaging, check `freshness` and `priorFixes` on the row: a report can
describe a defect that a LATER commit already fixed, so `fix --commit` may be
the correct verb on a report you have not touched. Confirm against current
code before closing one on the worksheet's evidence alone.

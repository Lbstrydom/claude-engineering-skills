# Deviation 1 — Pilot 1 is re-frozen as T1-only (epoch `seeded-bench-v2`)

**Signed by Louis, 2026-11-23, before any pilot data exists** — his words, typed in this session: "T1-only pilot - yes proceed - I approve". (An earlier relayed signature was withdrawn on 2026-11-23 pending the T2 investigation; this one is typed by Louis directly.) Machine-readable twin: [`deviation-1-t1-only.json`](deviation-1-t1-only.json), validated and
bound to this approval by a content digest (`DEVIATION_1_SHA256` in `pilot-deviation.mjs`).

## What changed and why

The meta-review's **T2** trigger (code round 4, admitted) needs the checkpoint-3 round signals to *fire*. A store-era reconstruction leaves `reopenRate`,
`severityDrift` and `retired` unmeasured, and an unmeasured signal never fires, so no T2 point can be reproduced. The free dry-run on a pinned main (2026-11-23)
found **0 of 14 T2 points runnable** across the rehearsal and pilot sets, leaving 1 of 5 rehearsal points and 6 of 16 pilot points: below the pre-registered
floor of 24 valid pairs, so the pilot would have been INVALID by construction.

Pilot 1 is therefore frozen as **T1-only**: it measures whether the meta step-back's decision at a round refused past the soft cap (plan round 4, code round 7)
is worth its cost. **It says nothing about the early stop at code round 4 (T2).** That limitation is carried into every result (the `score` output prints it) and must
appear in the pilot's report.

The freeze also now verifies, with cheap git lookups, that a point's plan file exists in the tree its round audits and that a code point has a diff base, so a
frozen set is runnable (40 further points failed this and were dropped at freeze: 143 recoverable T1 points, against 183 before).

## The new dataset and the calibration bridge

Same seed (`seeded-bench-v1-pilot1`), same partition rules; the dataset hash changes from `49d48e93…` to `da95b239…` (sets: calibration 30, rehearsal 5, pilot 16,
repeat 92). Verified by the free dry-run: **5 of 5 rehearsal and 16 of 16 pilot points are runnable.** The 260 calibration labels and the INCONCLUSIVE report belong to
the earlier dataset; they are evidence only under amendment 2, so the novelty step accepts the report for the new dataset **only** through this record (`--deviation`).

## Unchanged

Amendment 2 and every number in it, the Pilot 1 decision rule, the $125 / $100 caps metered per call, and human blind labelling.

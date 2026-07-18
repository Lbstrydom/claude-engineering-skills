-- Reconcile the audit_runs.gemini_verdict CHECK to the reviewer's actual
-- vocabulary.
--
-- Fourth instance of the same denormalization as
-- 20260718120000_plans_status_vocabulary.sql: one vocabulary, two definitions,
-- no source of truth —
--   • scripts/gemini-review.mjs:152   z.enum(['APPROVE','CONCERNS','CONCERNS_REMAINING','REJECT'])
--   • audit_runs.gemini_verdict CHECK      ('APPROVE','CONCERNS','REJECT')
--
-- `CONCERNS_REMAINING` is not an accident — it was added deliberately to
-- express "1 valid finding + 3 challenged", which `REJECT` (reserved for the
-- unambiguous case) overstates and `CONCERNS` understates. The store has never
-- been able to hold it.
--
-- This was latent rather than observed because NOTHING has ever written this
-- column: `recordRunComplete` hardcodes `geminiVerdict: null` and
-- `gemini-review.mjs` never called `updateRunMeta` at all (all 42 live rows
-- NULL). Wiring that writer without widening this CHECK would have converted a
-- silent no-op into a LOUD regression on exactly the runs that matter most:
-- `updateRunMeta` issues ONE atomic UPDATE, so a `CONCERNS_REMAINING` verdict
-- would abort the whole statement and take `final_review_model` and the shadow
-- token/latency telemetry down with it — the same atomic-failure class as the
-- un-awaited `recordRunComplete` fixed the same day.
--
-- Widen, don't remap. Collapsing CONCERNS_REMAINING → CONCERNS at the write
-- seam would fit the existing CHECK, but it would silently destroy the one
-- distinction the four-value enum exists to draw, in the store that later
-- analysis reads. Aligning the store to the producer is the smaller, honest
-- change.
--
-- Idempotent: drop-if-exists then re-add (stable constraint name, safe to
-- re-run). Purely widening, so no existing row can fail the new constraint.

ALTER TABLE audit_runs DROP CONSTRAINT IF EXISTS audit_runs_gemini_verdict_check;
ALTER TABLE audit_runs ADD CONSTRAINT audit_runs_gemini_verdict_check
  CHECK (gemini_verdict IN ('APPROVE', 'CONCERNS', 'CONCERNS_REMAINING', 'REJECT'));

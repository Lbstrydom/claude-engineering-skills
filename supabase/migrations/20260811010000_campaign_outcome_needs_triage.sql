-- `adjudication_outcome` gains 'needs_triage' — the honest value for a verdict
-- the instrument could NOT settle.
--
-- Plan: docs/plans/model-comparison-campaigns.md §2.5c.3.
--
-- WHY THIS IS A SEPARATE FILE. `20260811000000_campaign_adjudication.sql` is
-- already applied and ledgered; editing it in place would change its
-- canonicalised sha256 and `setup-postgres --migrate` classifies that as
-- `shaMismatch` — tampering, held for manual investigation — precisely so an
-- applied migration cannot be rewritten under a live database. Migrations are
-- cumulative; a correction is a new file.
--
-- WHAT THE DEFECT WAS. Campaign adjudication first wrote its accept/dismiss
-- verdict to `ruling`, whose CHECK is `(sustain, overrule, compromise)`. Those
-- are two different axes: `ruling` is the GPT-vs-Gemini DELIBERATION ruling,
-- while `adjudication_outcome` ∈ (accepted, dismissed, severity_adjusted) is
-- the verdict on the finding. The live suite caught it as a constraint
-- violation on every write; the store now writes `adjudication_outcome` and
-- leaves `ruling` NULL, because a campaign verdict is not a deliberation.
--
-- Correcting that exposed the real gap: the outcome vocabulary had no value
-- meaning "not decided". Without one, an `unverifiable` verdict would have to
-- be stored as `dismissed`, and a reader who checked the outcome without also
-- checking `method` would see a real dismissal — an unverified thing reading as
-- a decided thing, which is the exact failure the verify-don't-judge protocol
-- exists to prevent, and it would have been counted against the arm.
--
-- The word is BORROWED, not invented: `audit_findings.user_action` has meant
-- "routed to a human, undecided" by this name since the adaptive-learning
-- migration, so readers already know it. Widening a CHECK is backward-
-- compatible — every value existing writers emit stays legal, and no row needs
-- a backfill.

ALTER TABLE finding_adjudication_events DROP CONSTRAINT IF EXISTS finding_adjudication_events_adjudication_outcome_check;
ALTER TABLE finding_adjudication_events DROP CONSTRAINT IF EXISTS fae_adjudication_outcome_chk;
ALTER TABLE finding_adjudication_events ADD  CONSTRAINT fae_adjudication_outcome_chk
  CHECK (adjudication_outcome IN ('accepted', 'dismissed', 'severity_adjusted', 'needs_triage'));

-- A `needs_triage` event is by definition undecided, so it must carry the
-- method that says so. Without this, a future writer could record an undecided
-- outcome with `method: 'verified'` — a row claiming both that the claim was
-- settled against code and that nobody decided it.
ALTER TABLE finding_adjudication_events DROP CONSTRAINT IF EXISTS fae_needs_triage_is_unverifiable_chk;
ALTER TABLE finding_adjudication_events ADD  CONSTRAINT fae_needs_triage_is_unverifiable_chk
  CHECK (adjudication_outcome <> 'needs_triage' OR method IS NULL OR method = 'unverifiable');

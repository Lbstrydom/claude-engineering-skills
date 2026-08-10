-- Model-comparison campaigns: the relational spine, and adjudication provenance.
--
-- Plan: docs/plans/model-comparison-campaigns.md §7a.
--
-- ALTER, not create, for finding_adjudication_events. It already exists with
-- `ruling` CHECK'd and `remediation_state` + `round` NOT NULL — a write
-- constraint that has already caused one crash-on-every-call defect here. Every
-- column added below is NULLABLE with NO DEFAULT and NO BACKFILL, deliberately:
-- an existing row legitimately has no campaign provenance, and
-- `adjudicator_kind IS NULL` reads as "pre-campaign", which is true. A default
-- would manufacture provenance for rows that never had any. Campaign writers
-- must still supply the NOT NULL pair explicitly — the schema will not paper
-- over an omission.
--
-- ORDER IS LOAD-BEARING: `superseded_at` is added BEFORE the partial unique
-- index that filters on it. The plan's earlier draft had the index without the
-- column, so the migration would have failed at CREATE INDEX rather than at
-- review — the kind of defect that only surfaces at `--migrate` time against a
-- real database.

ALTER TABLE finding_adjudication_events ADD COLUMN IF NOT EXISTS adjudicator_kind   TEXT;
ALTER TABLE finding_adjudication_events ADD COLUMN IF NOT EXISTS adjudicator_model  TEXT;
ALTER TABLE finding_adjudication_events ADD COLUMN IF NOT EXISTS method             TEXT;
ALTER TABLE finding_adjudication_events ADD COLUMN IF NOT EXISTS self_family        BOOLEAN;
ALTER TABLE finding_adjudication_events ADD COLUMN IF NOT EXISTS overrides_event_id UUID REFERENCES finding_adjudication_events(id) ON DELETE SET NULL;
ALTER TABLE finding_adjudication_events ADD COLUMN IF NOT EXISTS campaign_arm_run_id UUID;
ALTER TABLE finding_adjudication_events ADD COLUMN IF NOT EXISTS evidence           JSONB;
ALTER TABLE finding_adjudication_events ADD COLUMN IF NOT EXISTS superseded_at      TIMESTAMPTZ;

-- Constrained as CHECKs rather than enums: adding a value to an enum type
-- cannot run inside the same transaction that uses it, which makes a future
-- vocabulary extension a two-migration dance for no benefit here.
ALTER TABLE finding_adjudication_events DROP CONSTRAINT IF EXISTS fae_adjudicator_kind_chk;
ALTER TABLE finding_adjudication_events ADD  CONSTRAINT fae_adjudicator_kind_chk
  CHECK (adjudicator_kind IS NULL OR adjudicator_kind IN ('agent', 'human'));

ALTER TABLE finding_adjudication_events DROP CONSTRAINT IF EXISTS fae_method_chk;
ALTER TABLE finding_adjudication_events ADD  CONSTRAINT fae_method_chk
  CHECK (method IS NULL OR method IN ('verified', 'unverifiable', 'override'));

-- A human override must NAME the agent verdict it overrides. Without this the
-- override rate — the campaign's published calibration figure — is computed
-- from a guess about which rows pair up.
ALTER TABLE finding_adjudication_events DROP CONSTRAINT IF EXISTS fae_override_names_target_chk;
ALTER TABLE finding_adjudication_events ADD  CONSTRAINT fae_override_names_target_chk
  CHECK (method IS DISTINCT FROM 'override' OR overrides_event_id IS NOT NULL);

-- At most ONE live agent verdict per finding. A re-adjudication supersedes
-- rather than accumulating, so "the agent's verdict" is a single row and not a
-- max()-by-timestamp convention every reader has to reimplement identically.
CREATE UNIQUE INDEX IF NOT EXISTS idx_fae_one_live_agent_verdict
  ON finding_adjudication_events (finding_id)
  WHERE adjudicator_kind = 'agent' AND superseded_at IS NULL;

-- ── The relational spine: campaign → cohort → snapshot → arm-run ────────────
-- The earlier draft had `campaigns(id, digest, state)`, which can hold only ONE
-- digest per campaign and therefore cannot represent a superseded cohort at all
-- — the exact thing the lock exists to produce.

CREATE TABLE IF NOT EXISTS campaigns (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id       UUID REFERENCES audit_repos(id) ON DELETE CASCADE,
  campaign_key  TEXT NOT NULL,
  -- A historical witness of what was DECLARED when the evidence was collected.
  -- Not the same duplication as a stored `target_n` would be: the committed
  -- config is the SSoT for what the rule IS, but it cannot tell you what it was.
  config_digest TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (repo_id, campaign_key)
);

-- No `state` and no `target_n` columns, deliberately (shadow/S5). State is
-- derived (§5); targetN lives in the committed config, and a stored copy could
-- only ever drift from the file the operator actually edits.

CREATE TABLE IF NOT EXISTS campaign_cohorts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id   UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  lock_digest   TEXT NOT NULL,
  resolved      JSONB,
  -- Superseded, never deleted and never relabelled: orphaned evidence stays
  -- readable, it just stops counting.
  superseded_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (campaign_id, lock_digest)
);

-- One snapshot, one revision, ENFORCED (shadow/S3). `audited_sha` is part of
-- snapshot identity, but as a plain column on the arm-run nothing stopped two
-- arm-runs under one snapshot_id recording different shas — which would make
-- the identity claim false and adjudication non-reproducible, since a verdict
-- is verified against that sha. The constraint now IS the invariant rather than
-- prose sitting next to a schema that permits the violation.
CREATE TABLE IF NOT EXISTS campaign_snapshots (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cohort_id       UUID NOT NULL REFERENCES campaign_cohorts(id) ON DELETE CASCADE,
  snapshot_id     TEXT NOT NULL,
  audited_sha     TEXT NOT NULL,
  transcript_path TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (cohort_id, snapshot_id)
);

CREATE TABLE IF NOT EXISTS campaign_arm_runs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cohort_id        UUID NOT NULL REFERENCES campaign_cohorts(id) ON DELETE CASCADE,
  snapshot_row_id  UUID NOT NULL REFERENCES campaign_snapshots(id) ON DELETE CASCADE,
  snapshot_id      TEXT NOT NULL,
  arm_id           TEXT NOT NULL,
  attempt          INTEGER NOT NULL DEFAULT 1,
  superseded_at    TIMESTAMPTZ,
  audit_run_id     UUID REFERENCES audit_runs(id) ON DELETE SET NULL,
  usage            JSONB,
  -- `cost_usd NULL` + `cost_status` keeps lesson (e) honest at the SCHEMA
  -- level: an unpriced run stores NULL with cost_status 'unpriced', never 0.
  -- A 0 here would be a claim that the call was measured and cost nothing.
  cost_usd         NUMERIC,
  cost_status      TEXT NOT NULL DEFAULT 'unknown',
  error            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (cohort_id, snapshot_id, arm_id, attempt),
  CONSTRAINT campaign_arm_runs_cost_status_chk
    CHECK (cost_status IN ('priced', 'unpriced', 'unknown')),
  -- An unpriced run must not carry a number, and a priced one must.
  CONSTRAINT campaign_arm_runs_cost_coherent_chk
    CHECK ((cost_status = 'priced' AND cost_usd IS NOT NULL)
        OR (cost_status <> 'priced' AND cost_usd IS NULL))
);

-- At most ONE live attempt per arm-run. The earlier draft promised `--force`
-- would "append a new row and mark the prior superseded" against a
-- three-column unique key that makes that insert impossible — a direct
-- contradiction. `attempt` in the key plus this partial index gives both:
-- retries append, and exactly one of them is current.
CREATE UNIQUE INDEX IF NOT EXISTS idx_campaign_arm_runs_one_live
  ON campaign_arm_runs (cohort_id, snapshot_id, arm_id)
  WHERE superseded_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_campaign_arm_runs_cohort ON campaign_arm_runs (cohort_id);
CREATE INDEX IF NOT EXISTS idx_campaign_snapshots_cohort ON campaign_snapshots (cohort_id);

-- Now that campaign_arm_runs exists, point the provenance column at it. Added
-- separately because the ALTER above runs before this table is created.
ALTER TABLE finding_adjudication_events DROP CONSTRAINT IF EXISTS fae_campaign_arm_run_fk;
ALTER TABLE finding_adjudication_events ADD  CONSTRAINT fae_campaign_arm_run_fk
  FOREIGN KEY (campaign_arm_run_id) REFERENCES campaign_arm_runs(id) ON DELETE SET NULL;

-- ── Adjudication: worksheets, clusters, and what the attempts cost ─────────

CREATE TABLE IF NOT EXISTS campaign_worksheets (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cohort_id    UUID NOT NULL REFERENCES campaign_cohorts(id) ON DELETE CASCADE,
  -- NAMES the key, never the key itself: an env-held secret must not land in a
  -- table that gets dumped, replicated and read by every consumer of this DSN.
  hmac_key_ref TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The row↔finding mapping and the calibration assignment are PERSISTED, not
-- recomputed. `calibration_assigned` being a stored boolean is what makes the
-- "deterministic sample" stable across a key rotation — recomputing it from the
-- key would silently resample the moment the key changed, and the sample would
-- have been reproducible only by accident.
CREATE TABLE IF NOT EXISTS campaign_worksheet_rows (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  worksheet_id         UUID NOT NULL REFERENCES campaign_worksheets(id) ON DELETE CASCADE,
  worksheet_row_id     TEXT NOT NULL,
  finding_id           UUID NOT NULL REFERENCES audit_findings(id) ON DELETE CASCADE,
  calibration_assigned BOOLEAN NOT NULL DEFAULT FALSE,
  agent_event_id       UUID REFERENCES finding_adjudication_events(id) ON DELETE SET NULL,
  attempt              INTEGER NOT NULL DEFAULT 1,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (worksheet_id, worksheet_row_id),
  UNIQUE (worksheet_id, finding_id)
);

-- Cross-arm attribution is a JOIN, not a re-run of a matcher whose threshold
-- may since have changed. Re-running at a new threshold writes a NEW cluster
-- set and the old one stays readable — the matcher is a post-hoc analytical
-- transform, which is exactly why it is NOT a lock input.
CREATE TABLE IF NOT EXISTS campaign_clusters (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cohort_id            UUID NOT NULL REFERENCES campaign_cohorts(id) ON DELETE CASCADE,
  snapshot_id          TEXT NOT NULL,
  matcher_version      TEXT NOT NULL,
  matcher_threshold    NUMERIC NOT NULL,
  canonical_finding_id UUID NOT NULL REFERENCES audit_findings(id) ON DELETE CASCADE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (cohort_id, snapshot_id, matcher_version, canonical_finding_id)
);

CREATE TABLE IF NOT EXISTS campaign_cluster_members (
  cluster_id UUID NOT NULL REFERENCES campaign_clusters(id) ON DELETE CASCADE,
  finding_id UUID NOT NULL REFERENCES audit_findings(id) ON DELETE CASCADE,
  arm_id     TEXT NOT NULL,
  PRIMARY KEY (cluster_id, finding_id)
);

-- Adjudication spend has a table BECAUSE IT IS SPEND (Gemini/G5). The earlier
-- draft gave adjudication a receipt protocol and an attempt counter but nowhere
-- to record what the attempts cost — and an `attempt` integer on the worksheet
-- row cannot hold per-attempt data at all, so a superseded attempt had no row
-- to exist in. Lesson (e) is exactly that an unrecorded charge reads as free.
CREATE TABLE IF NOT EXISTS campaign_adjudication_attempts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  worksheet_row_id UUID NOT NULL REFERENCES campaign_worksheet_rows(id) ON DELETE CASCADE,
  attempt          INTEGER NOT NULL,
  status           TEXT NOT NULL,
  usage            JSONB,
  cost_usd         NUMERIC,
  cost_status      TEXT NOT NULL DEFAULT 'unknown',
  superseded_at    TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (worksheet_row_id, attempt),
  CONSTRAINT campaign_adj_attempts_cost_status_chk
    CHECK (cost_status IN ('priced', 'unpriced', 'unknown')),
  CONSTRAINT campaign_adj_attempts_cost_coherent_chk
    CHECK ((cost_status = 'priced' AND cost_usd IS NOT NULL)
        OR (cost_status <> 'priced' AND cost_usd IS NULL))
);

-- Append-only lifecycle. `rule_changed` events are what protect
-- pre-registration now that the decision rule is deliberately NOT a lock input:
-- the evidence survives an edit, and the fact that the goalposts moved is
-- recorded beside the number instead of destroying the collection.
CREATE TABLE IF NOT EXISTS campaign_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  actor       TEXT,
  detail      JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_campaign_events_campaign ON campaign_events (campaign_id, created_at);

-- Enforced append-only, not merely documented as such: a lifecycle log that can
-- be edited cannot evidence that a rule change happened.
CREATE OR REPLACE FUNCTION campaign_events_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION
    'campaign_events is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS campaign_events_no_update ON campaign_events;
CREATE TRIGGER campaign_events_no_update
  BEFORE UPDATE OR DELETE ON campaign_events
  FOR EACH ROW EXECUTE FUNCTION campaign_events_append_only();

ALTER TABLE campaigns                      ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_cohorts               ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_snapshots             ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_arm_runs              ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_worksheets            ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_worksheet_rows        ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_clusters              ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_cluster_members       ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_adjudication_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_events                ENABLE ROW LEVEL SECURITY;
-- No policies → service-role only (same posture as upstream_issue_events).

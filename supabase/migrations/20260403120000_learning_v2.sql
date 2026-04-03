-- Learning System v2 Migration
-- Staged: additive changes first, then backfill, then constraints.

-- ═══════════════════════════════════════════════════════════════════════════
-- Stage 1: Additive changes only (safe to run on existing data)
-- ═══════════════════════════════════════════════════════════════════════════

-- Prompt revisions (new table — stores promoted prompt text)
CREATE TABLE IF NOT EXISTS prompt_revisions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  pass_name TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  prompt_text TEXT NOT NULL,
  checksum TEXT NOT NULL,
  promoted_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (pass_name, revision_id)
);

-- Prompt evolution experiments (new table)
CREATE TABLE IF NOT EXISTS prompt_experiments (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  experiment_id TEXT NOT NULL UNIQUE,
  pass_name TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  parent_revision_id TEXT,
  parent_ewr REAL,
  parent_confidence REAL,
  parent_effective_sample_size INT,
  rationale TEXT,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'converged', 'promoted', 'killed', 'stale')),
  created_at TIMESTAMPTZ DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  final_ewr REAL,
  final_confidence REAL,
  total_pulls INT DEFAULT 0
);

-- Add context_bucket to bandit_arms (nullable initially)
ALTER TABLE bandit_arms ADD COLUMN IF NOT EXISTS context_bucket TEXT;

-- Add explicit dimension columns to false_positive_patterns
ALTER TABLE false_positive_patterns ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE false_positive_patterns ADD COLUMN IF NOT EXISTS severity TEXT;
ALTER TABLE false_positive_patterns ADD COLUMN IF NOT EXISTS principle TEXT;
ALTER TABLE false_positive_patterns ADD COLUMN IF NOT EXISTS repo_id UUID DEFAULT '00000000-0000-0000-0000-000000000000';
ALTER TABLE false_positive_patterns ADD COLUMN IF NOT EXISTS file_extension TEXT DEFAULT 'unknown';
ALTER TABLE false_positive_patterns ADD COLUMN IF NOT EXISTS scope TEXT DEFAULT 'global';

-- ═══════════════════════════════════════════════════════════════════════════
-- Stage 2: Backfill — normalize NULL sentinels to non-null values
-- ═══════════════════════════════════════════════════════════════════════════

UPDATE bandit_arms SET context_bucket = 'global' WHERE context_bucket IS NULL;
ALTER TABLE bandit_arms ALTER COLUMN context_bucket SET DEFAULT 'global';
ALTER TABLE bandit_arms ALTER COLUMN context_bucket SET NOT NULL;

UPDATE false_positive_patterns SET file_extension = 'unknown' WHERE file_extension IS NULL;
ALTER TABLE false_positive_patterns ALTER COLUMN file_extension SET DEFAULT 'unknown';

UPDATE false_positive_patterns
  SET repo_id = '00000000-0000-0000-0000-000000000000'
  WHERE repo_id IS NULL;
ALTER TABLE false_positive_patterns ALTER COLUMN repo_id SET DEFAULT '00000000-0000-0000-0000-000000000000';

-- Stage 2b: Backfill old-format FP records (pattern_type/pattern_value -> explicit columns)
UPDATE false_positive_patterns
  SET category = split_part(pattern_value, '::', 1),
      severity = split_part(pattern_value, '::', 2),
      principle = split_part(pattern_value, '::', 3),
      auto_suppress = true,
      scope = 'global'
  WHERE category IS NULL AND pattern_value IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════════════════
-- Stage 3: Enforce NOT NULL (after backfill validation)
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE false_positive_patterns ALTER COLUMN file_extension SET NOT NULL;
ALTER TABLE false_positive_patterns ALTER COLUMN scope SET NOT NULL;

-- ═══════════════════════════════════════════════════════════════════════════
-- Stage 4: Enforce unique constraints (safe after backfill)
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE bandit_arms DROP CONSTRAINT IF EXISTS bandit_arms_pass_name_variant_id_key;
ALTER TABLE bandit_arms DROP CONSTRAINT IF EXISTS bandit_arms_unique;
ALTER TABLE bandit_arms ADD CONSTRAINT bandit_arms_unique
  UNIQUE (pass_name, variant_id, context_bucket);

-- ═══════════════════════════════════════════════════════════════════════════
-- RLS policies for new tables
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE prompt_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE prompt_experiments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_all_prompt_revisions" ON prompt_revisions FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_all_prompt_experiments" ON prompt_experiments FOR ALL TO anon USING (true) WITH CHECK (true);

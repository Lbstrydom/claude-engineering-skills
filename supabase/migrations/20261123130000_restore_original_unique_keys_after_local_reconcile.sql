-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║  restore_original_unique_keys_after_local_reconcile                        ║
-- ║                                                                            ║
-- ║  Why this exists: an UNTRACKED local migration ("reconcile_local_schema_   ║
-- ║  drift", 2026-08-21, never in this repo) was applied to a store on         ║
-- ║  2026-11-20 and replaced three unique keys with variants that include      ║
-- ║  `model`. The code upserts against the ORIGINAL keys, so ON CONFLICT       ║
-- ║  failed (42P10) and bandit / false-positive / prompt-variant writes were   ║
-- ║  lost silently for two weeks:                                              ║
-- ║    bandit_arms_unique                    (pass_name, variant_id,           ║
-- ║                                           context_bucket)                  ║
-- ║    false_positive_patterns_repo_pattern_key (repo_id, pattern_type,        ║
-- ║                                           pattern_value)                   ║
-- ║    prompt_variants_pass_variant_key      (pass_name, variant_name)         ║
-- ║                                                                            ║
-- ║  Behaviour, per key: already correct -> no-op (every healthy store).       ║
-- ║  Otherwise drop a same-named constraint with a different definition and    ║
-- ║  any unique constraint that is the original columns PLUS `model`, then     ║
-- ║  add the original. If duplicate rows under the original key would block    ║
-- ║  it, RAISE with the count and change nothing (the DO block is one          ║
-- ║  statement, so it is atomic). Idempotent, forward-only, schema-portable.   ║
-- ║  See also: setup-postgres.mjs refuses untracked migration files.           ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝

DO $$
DECLARE
  spec  RECORD;
  cons  RECORD;
  want  TEXT;
  dups  BIGINT;
  cols_arr TEXT[];
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      ('bandit_arms',             'bandit_arms_unique',                         ARRAY['pass_name','variant_id','context_bucket']),
      ('false_positive_patterns', 'false_positive_patterns_repo_pattern_key',   ARRAY['repo_id','pattern_type','pattern_value']),
      ('prompt_variants',         'prompt_variants_pass_variant_key',           ARRAY['pass_name','variant_name'])
    ) AS t(tbl, conname, cols)
  LOOP
    -- Tables absent on this store: nothing to repair.
    IF to_regclass(spec.tbl) IS NULL THEN CONTINUE; END IF;

    EXECUTE format('LOCK TABLE %I IN ACCESS EXCLUSIVE MODE', spec.tbl);
    cols_arr := spec.cols;
    want := 'UNIQUE (' || array_to_string(cols_arr, ', ') || ')';

    -- Already exactly right -> no-op.
    IF EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conrelid = to_regclass(spec.tbl) AND contype = 'u' AND conname = spec.conname
         AND pg_get_constraintdef(oid) = want
    ) THEN CONTINUE; END IF;

    -- Refuse rather than destroy: duplicates (all key columns non-NULL, as a unique key treats NULLs as distinct).
    EXECUTE format(
      'SELECT count(*) FROM (SELECT 1 FROM %I WHERE %s GROUP BY %s HAVING count(*) > 1) d',
      spec.tbl,
      (SELECT string_agg(format('%I IS NOT NULL', c), ' AND ') FROM unnest(cols_arr) c),
      (SELECT string_agg(format('%I', c), ', ') FROM unnest(cols_arr) c)
    ) INTO dups;
    IF dups > 0 THEN
      RAISE EXCEPTION
        '% cannot be restored to % : % duplicate group(s) share that key. Deduplicate the rows, then re-run --migrate. Nothing was changed.',
        spec.tbl, want, dups;
    END IF;

    -- Drop the same-named constraint with a different definition, and any unique constraint that is
    -- the original columns plus `model` (the drifted variant, whatever it was named).
    FOR cons IN
      SELECT c.conname
        FROM pg_constraint c
       WHERE c.conrelid = to_regclass(spec.tbl) AND c.contype = 'u'
         AND (
           c.conname = spec.conname
           OR (
             (SELECT array_agg(a.attname::text ORDER BY a.attname)
                FROM pg_attribute a WHERE a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey))
             = (SELECT array_agg(x ORDER BY x) FROM unnest(cols_arr || ARRAY['model']) x)
           )
         )
    LOOP
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', spec.tbl, cons.conname);
    END LOOP;

    -- A bare unique INDEX squatting on the name (not backed by a constraint) would make ADD CONSTRAINT fail.
    IF EXISTS (
      SELECT 1 FROM pg_class i
       WHERE i.relkind = 'i' AND i.relname = spec.conname
         AND i.relnamespace = (SELECT relnamespace FROM pg_class WHERE oid = to_regclass(spec.tbl))
    ) THEN
      EXECUTE format('DROP INDEX %I', spec.conname);
    END IF;

    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I %s', spec.tbl, spec.conname, want);
  END LOOP;
END $$;

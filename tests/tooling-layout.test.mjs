/**
 * @fileoverview The ONE oracle for "which tooling layout is this file installed under".
 *
 * The question has exactly two answers and they select two DIFFERENT databases'
 * schemas, so a wrong answer is not degraded — it is confidently wrong. This repo
 * is the only place where the old first-existing-wins ordering happened to be
 * right, which is why it shipped; every assertion below therefore drives the
 * CONSUMER layout explicitly, by path, rather than relying on where the test runs.
 *
 * The literals are pinned against `sync-path-map`, the sync's own source of
 * truth, so a rename there fails loudly here instead of silently resolving to
 * nothing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  MIGRATION_DIR_BY_LAYOUT,
  CONSUMER_TOOLING_SEGMENT,
  detectLayout,
  migrationsDirForLayout,
  resolveMigrationsLayout,
} from '../scripts/lib/tooling-layout.mjs';
import { LAYOUT_CONSTANTS, sourceRelToDestRel } from '../scripts/lib/sync-path-map.mjs';
import * as schemaRealization from '../scripts/lib/db/schema-realization.mjs';

test('the consumer tooling segment is the one the sync actually writes to', () => {
  assert.equal(CONSUMER_TOOLING_SEGMENT, `${LAYOUT_CONSTANTS.CONSUMER_TOOLING_DIR}/`);
});

test('the migration directories are the ones the sync maps between', () => {
  assert.equal(
    `${MIGRATION_DIR_BY_LAYOUT.source}/`,
    LAYOUT_CONSTANTS.MIGRATIONS_SRC_PREFIX,
  );
  assert.equal(
    `${MIGRATION_DIR_BY_LAYOUT.consumer}/`,
    LAYOUT_CONSTANTS.MIGRATIONS_DEST_PREFIX,
  );
  // And the mapping itself agrees, end to end.
  assert.equal(
    sourceRelToDestRel(`${MIGRATION_DIR_BY_LAYOUT.source}/20260101000000_x.sql`),
    `${MIGRATION_DIR_BY_LAYOUT.consumer}/20260101000000_x.sql`,
  );
});

test('detectLayout keys on the tooling dir, on both path separators', () => {
  assert.equal(detectLayout('/repo/scripts/check-windowed-views.mjs'), 'source');
  assert.equal(detectLayout('/repo/scripts/.claude-skills/check-windowed-views.mjs'), 'consumer');
  assert.equal(detectLayout('C:\\repo\\scripts\\.claude-skills\\lib\\db\\x.mjs'), 'consumer');
  assert.equal(detectLayout('C:\\repo\\scripts\\lib\\db\\x.mjs'), 'source');
});

test('migrationsDirForLayout refuses an unknown layout rather than returning undefined', () => {
  // An undefined directory would `path.join` to the repo root, where readdir
  // succeeds and finds no .sql — "no windowed views" from a scan that read nothing.
  assert.throws(() => migrationsDirForLayout('whatever'), /unknown layout/);
});

test('resolveMigrationsLayout picks by LAYOUT, never by which directory exists', () => {
  // A consumer has BOTH: `.audit-loop/migrations/` (the synced audit-loop schema)
  // and `supabase/migrations/` (its OWN app schema, unrelated by design). Nothing
  // here touches the filesystem, which is the point.
  const asConsumer = resolveMigrationsLayout('/c', '/c/scripts/.claude-skills/check-windowed-views.mjs');
  assert.equal(asConsumer.layout, 'consumer');
  assert.equal(asConsumer.dir, '.audit-loop/migrations');
  assert.equal(asConsumer.abs, path.join('/c', '.audit-loop/migrations'));

  const asSource = resolveMigrationsLayout('/s', '/s/scripts/check-windowed-views.mjs');
  assert.equal(asSource.layout, 'source');
  assert.equal(asSource.dir, 'supabase/migrations');
});

test('schema-realization still answers through the shared oracle', () => {
  // It held the only copy until 2026-11-14 and re-exports these names; a divergence
  // would mean two classifiers for one question, which is what the extraction removed.
  assert.deepEqual(schemaRealization.MIGRATION_DIR_BY_LAYOUT, MIGRATION_DIR_BY_LAYOUT);
  assert.equal(
    schemaRealization.detectLayout('/r/scripts/.claude-skills/lib/db/schema-realization.mjs'),
    'consumer',
  );
  assert.equal(
    schemaRealization.detectLayout('/r/scripts/lib/db/schema-realization.mjs'),
    'source',
  );
});

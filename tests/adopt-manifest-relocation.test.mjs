/**
 * @fileoverview `--adopt`'s schema manifest must survive relocation.
 *
 * `runAdopt` hard-aborts at its entrypoint when the expected-schema manifest
 * is missing. The manifest lived only at `tests/fixtures/expected-schema.json`
 * — a SOURCE-repo test path that is not in the consumer sync closure — so
 * `--adopt`, the documented one-time bootstrap for a pre-provisioned DB
 * (docs/runbooks/postgres-parity.md §"One-time bootstrap"), could not be run
 * in any consumer repo at all.
 *
 * The same blind spot as `compat-bootstrap.sql` and `oss-call-policy.json`:
 * an fs-read asset the import-graph walker cannot see. It failed louder than
 * those two, because the abort is unconditional.
 *
 * Found by /audit-code (R1 M2), confirmed by the consolidated Gemini gate.
 * Plan: docs/plans/debt-burndown-workstreams.md §3 WS-A.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  LAYOUT_CONSTANTS,
  destRelToSourceRel,
  sourceRelToDestRel,
} from '../scripts/lib/sync-path-map.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = LAYOUT_CONSTANTS.EXPECTED_SCHEMA_SRC;
const DEST = LAYOUT_CONSTANTS.EXPECTED_SCHEMA_DEST;

describe('expected-schema manifest — sync path mapping', () => {
  it('maps the source test-fixture path to an audit-loop-private runtime path', () => {
    assert.equal(sourceRelToDestRel(SRC), DEST);
  });

  it('round-trips (the property the whole map is held to)', () => {
    assert.equal(destRelToSourceRel(sourceRelToDestRel(SRC)), SRC);
    assert.equal(sourceRelToDestRel(destRelToSourceRel(DEST)), DEST);
  });

  it('lands beside the migrations, NOT in the consumer\'s own supabase/', () => {
    // A consumer's `supabase/` is their product's; absorbing audit-loop assets
    // there is what the `.audit-loop/` convention exists to prevent.
    assert.ok(DEST.startsWith('.audit-loop/'), `${DEST} must be audit-loop-private`);
    assert.ok(!DEST.startsWith('supabase/'));
    assert.ok(!DEST.startsWith('tests/'), 'tests/ is never synced to a consumer');
  });

  it('does not disturb the migrations mapping that shares the .audit-loop prefix', () => {
    const mig = `${LAYOUT_CONSTANTS.MIGRATIONS_SRC_PREFIX}20260101000000_x.sql`;
    assert.equal(sourceRelToDestRel(mig), `${LAYOUT_CONSTANTS.MIGRATIONS_DEST_PREFIX}20260101000000_x.sql`);
    assert.equal(destRelToSourceRel(sourceRelToDestRel(mig)), mig);
  });

  it('other tests/ paths are NOT remapped (this is one declared asset, not a rule)', () => {
    assert.equal(sourceRelToDestRel('tests/fixtures/something-else.json'), 'tests/fixtures/something-else.json');
    assert.equal(sourceRelToDestRel('tests/foo.test.mjs'), 'tests/foo.test.mjs');
  });
});

describe('expected-schema manifest — declared in the sync closure', () => {
  it('sync-to-repos ships it (an fs-read asset the import walker cannot see)', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'sync-to-repos.mjs'), 'utf-8');
    assert.ok(src.includes(`'${SRC}'`),
      `${SRC} must be declared in sync-to-repos.mjs — the import-graph walker never sees an fs read`);
  });

  it('the source manifest actually exists to be shipped', () => {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, SRC)), `${SRC} is missing from this repo`);
  });
});

describe('expected-schema manifest — consumer-layout resolution', () => {
  const tmpDirs = [];
  after(() => {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  /**
   * Resolve exactly as setup-postgres.mjs does: prefer the audit-loop-private
   * path, fall back to the source test-fixture path. Mirrored rather than
   * imported because the module computes it at import time from its own
   * REPO_ROOT — the behaviour under test is the PRECEDENCE, and a drift here
   * is caught by the source-scan assertion below.
   */
  const resolve = (root) => {
    const priv = path.join(root, '.audit-loop', 'expected-schema.json');
    return fs.existsSync(priv) ? priv : path.join(root, 'tests', 'fixtures', 'expected-schema.json');
  };

  const mkRoot = (layout) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adopt-manifest-'));
    tmpDirs.push(root);
    if (layout === 'consumer' || layout === 'both') {
      fs.mkdirSync(path.join(root, '.audit-loop'), { recursive: true });
      fs.writeFileSync(path.join(root, '.audit-loop', 'expected-schema.json'), '{"consumer":true}');
    }
    if (layout === 'source' || layout === 'both') {
      fs.mkdirSync(path.join(root, 'tests', 'fixtures'), { recursive: true });
      fs.writeFileSync(path.join(root, 'tests', 'fixtures', 'expected-schema.json'), '{"source":true}');
    }
    return root;
  };

  it('CONSUMER layout: finds the manifest under .audit-loop/ (the bug: it did not)', () => {
    const root = mkRoot('consumer');
    const resolved = resolve(root);
    assert.ok(fs.existsSync(resolved), 'a consumer-layout repo must resolve a manifest that exists');
    assert.equal(JSON.parse(fs.readFileSync(resolved, 'utf-8')).consumer, true);
  });

  it('SOURCE layout: still resolves the test fixture (this repo is unaffected)', () => {
    const root = mkRoot('source');
    assert.equal(JSON.parse(fs.readFileSync(resolve(root), 'utf-8')).source, true);
  });

  it('BOTH present: the audit-loop-private copy wins (matches MIGRATIONS_DIR precedence)', () => {
    const root = mkRoot('both');
    assert.equal(JSON.parse(fs.readFileSync(resolve(root), 'utf-8')).consumer, true);
  });

  it('NEITHER present: resolves to the source path so the abort names a real location', () => {
    const root = mkRoot('none');
    assert.equal(resolve(root), path.join(root, 'tests', 'fixtures', 'expected-schema.json'));
  });

  it('setup-postgres.mjs uses this precedence (guards against the mirror drifting)', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'setup-postgres.mjs'), 'utf-8');
    assert.match(src, /EXPECTED_SCHEMA_PRIVATE[\s\S]{0,200}existsSync\(EXPECTED_SCHEMA_PRIVATE\)/,
      'setup-postgres must prefer the .audit-loop path when it exists');
    assert.ok(src.includes(`'.audit-loop', 'expected-schema.json'`),
      'the private path must match LAYOUT_CONSTANTS.EXPECTED_SCHEMA_DEST');
  });
});

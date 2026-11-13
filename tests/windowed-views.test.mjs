/**
 * @fileoverview Which store views are time-windowed, and the gate over the declaration.
 *
 * The case this exists for is NOT a view that calls `now()` — it is the one that
 * does not: `unremediated_acceptances` reads `… FROM unremediated_acceptances_all
 * WHERE is_recent`, so a literal grep over the migrations calls it stable while two
 * counts five weeks apart share 0 rows. `docs/plans/standing-queue-burndown.md` §7.
 *
 * Gate contract: `windowed-views-gate-rejects-an-undeclared-windowed-view`
 * (`scripts/gate-contracts/windowed-views-gate.json`); the poison pill proves the
 * process, these tests prove the decisions it is built from.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  stripNonCode,
  parseViewStatements,
  collectViewDefinitions,
  classifyWindowedViews,
  readManifest,
  diffAgainstManifest,
  windowedQueueKeys,
} from '../scripts/lib/store/windowed-views.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A throwaway migrations tree; returns the root to point the collector at. */
function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'windowed-views-'));
  const dir = path.join(root, 'supabase', 'migrations');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, sql] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), sql, 'utf8');
  return root;
}
const classify = (files) => classifyWindowedViews(collectViewDefinitions(fixture(files)));

describe('stripNonCode', () => {
  test('a comment that talks about a view does not define one', () => {
    const sql = '-- the view only exists so that CREATE VIEW ghost AS is documented\nSELECT 1;';
    assert.deepEqual(parseViewStatements(stripNonCode(sql)), []);
  });

  test('a dollar-quoted body does not end the statement at its semicolons', () => {
    const sql = "CREATE FUNCTION f() RETURNS int AS $$ BEGIN; RETURN 1; END; $$ LANGUAGE plpgsql;\n"
      + 'CREATE VIEW v AS SELECT now();';
    assert.deepEqual(parseViewStatements(stripNonCode(sql)).map((x) => x.name), ['v']);
  });

  test('a string literal containing now() is not a clock call', () => {
    const c = classify({ '1.sql': "CREATE VIEW v AS SELECT 'now()' AS label FROM t;" });
    assert.equal(c.get('v').windowed, false);
  });
});

describe('classifyWindowedViews', () => {
  test('migrations are cumulative: the LAST definition of a name wins', () => {
    const c = classify({
      '20260101000000_a.sql': 'CREATE VIEW v AS SELECT * FROM t WHERE created_at > now() - interval \'7 days\';',
      '20260102000000_b.sql': 'CREATE OR REPLACE VIEW v AS SELECT * FROM t;',
    });
    assert.equal(c.get('v').windowed, false, 'the window was removed by the later migration');
  });

  test('windowedness PROPAGATES through a view reference (the case a grep misses)', () => {
    const c = classify({
      '1.sql': "CREATE VIEW base_all AS SELECT *, (created_at > now() - interval '14 days') AS is_recent FROM t;\n"
        + 'CREATE VIEW base AS SELECT * FROM base_all WHERE is_recent;\n'
        + 'CREATE VIEW grandchild AS SELECT count(*) FROM base;',
    });
    assert.equal(c.get('base').reason, 'inherits');
    assert.equal(c.get('base').via, 'base_all');
    assert.equal(c.get('grandchild').windowed, true, 'two hops from the clock is still windowed');
  });

  test('a name that is only a PREFIX of a windowed view does not inherit', () => {
    const c = classify({
      '1.sql': 'CREATE VIEW fixes_all AS SELECT * FROM t WHERE created_at > now();\n'
        + 'CREATE VIEW unrelated AS SELECT * FROM fixes_all_other;',
    });
    assert.equal(c.get('unrelated').windowed, false);
  });

  test('an empty or absent migrations tree FAILS — it never reads as "no windowed views"', () => {
    assert.throws(() => collectViewDefinitions(fixture({})), /refusing to report/);
    assert.throws(() => collectViewDefinitions(os.tmpdir(), { dir: 'nope' }), /cannot read migrations/);
  });
});

describe('the manifest', () => {
  const ok = { views: { v: { window: 'w', comparable: 'c' } }, exemptions: {} };
  const write = (obj) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'windowed-manifest-'));
    fs.writeFileSync(path.join(root, '.windowed-views.json'), typeof obj === 'string' ? obj : JSON.stringify(obj), 'utf8');
    return root;
  };

  test('an entry must state both the window and what is comparable instead', () => {
    assert.equal(readManifest(write(ok)).kind, 'ok');
    assert.match(readManifest(write({ views: { v: { window: 'w' } } })).reason, /comparable/);
    assert.match(readManifest(write({ views: { v: { comparable: 'c' } } })).reason, /window/);
    assert.match(readManifest(write({ views: { v: { window: '  ', comparable: 'c' } } })).reason, /window/);
  });

  test('an exemption must carry a reason, and malformed JSON is invalid, never empty', () => {
    assert.match(readManifest(write({ views: {}, exemptions: { v: '' } })).reason, /reason/);
    assert.equal(readManifest(write('{nope')).kind, 'invalid');
    assert.equal(readManifest(fs.mkdtempSync(path.join(os.tmpdir(), 'none-'))).kind, 'missing');
  });
});

describe('diffAgainstManifest', () => {
  const classified = new Map([
    ['win', { windowed: true, reason: 'clock-function', via: null, file: 'f.sql' }],
    ['stable', { windowed: false, reason: null, via: null, file: 'f.sql' }],
  ]);

  test('an undeclared windowed view fails', () => {
    const d = diffAgainstManifest(classified, { views: {}, exemptions: {} });
    assert.deepEqual(d.undeclared.map((x) => x.name), ['win']);
  });

  test('an exemption silences it, and a declaration does too', () => {
    assert.equal(diffAgainstManifest(classified, { views: {}, exemptions: { win: 'why' } }).undeclared.length, 0);
    assert.equal(diffAgainstManifest(classified, { views: { win: {} }, exemptions: {} }).undeclared.length, 0);
  });

  // The shrink direction: a declaration nobody removed is a false claim in the file
  // a reader consults, so it fails exactly as growth does (knip-gate's shape).
  test('a declaration for a view that is gone, or no longer windowed, fails', () => {
    const d = diffAgainstManifest(classified, { views: { stable: {}, vanished: {} }, exemptions: { stable: 'r' } });
    assert.deepEqual(d.staleDeclared.map((x) => x.name).sort(), ['stable', 'vanished']);
    assert.deepEqual(d.staleExempt.map((x) => x.name), ['stable']);
  });
});

describe('this repository', () => {
  const classified = classifyWindowedViews(collectViewDefinitions(REPO));
  const manifest = readManifest(REPO);

  test('the two standing-queue views classify as windowed, by inheritance', () => {
    for (const name of ['unremediated_acceptances', 'unlocked_fixes']) {
      const rec = classified.get(name);
      assert.ok(rec, `${name} is defined in the migrations`);
      assert.equal(rec.windowed, true, name);
      assert.equal(rec.reason, 'inherits', `${name}: its own body names no clock — this is the case a grep misses`);
    }
  });

  test('the committed manifest is valid and agrees with the migrations', () => {
    assert.equal(manifest.kind, 'ok', manifest.reason ?? '');
    const d = diffAgainstManifest(classified, manifest);
    assert.deepEqual([d.undeclared, d.staleDeclared, d.staleExempt].map((x) => x.map((y) => y.name)), [[], [], []]);
  });

  test('Q1 and Q2 are declared windowed queues (what the dashboard reads)', () => {
    assert.deepEqual([...windowedQueueKeys(manifest)].sort(), ['q1', 'q2']);
  });
});

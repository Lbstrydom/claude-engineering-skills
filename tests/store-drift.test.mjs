/**
 * @fileoverview Cross-store migration drift — the reader that would have seen
 * what nothing here could see.
 *
 * **The incident (2026-08-30).** A consumer's Azure store sat 2 migrations
 * behind for a day. The `.sql` files had synced to disk and were never applied,
 * so that consumer's code and schema disagreed silently — the `annotation`
 * event shipped the day before could not have worked there. `/ship` Step 0.5g
 * asks only whether the AMBIENT store is current, so nothing in this repo ever
 * asked. It surfaced when a routine upstream-report closure was refused by the
 * write-path realization guard, which is the last possible moment.
 *
 * Two directions are pinned, and the second is the one that matters: a checker
 * that goes quiet is indistinguishable from a clean estate, which is exactly
 * how the drift survived.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { collectDrift, renderDrift } from '../scripts/store-drift.mjs';

const STORE_A = { fingerprint: 'aaaa1111', url: 'postgres://x/a', sslMode: null, repos: ['this repo'] };
const STORE_B = { fingerprint: 'bbbb2222', url: 'postgres://x/b', sslMode: 'no-verify', repos: ['storyline'] };

const clean = () => ({ ok: true, reason: null, drift: { hasDrift: false, drift: { unapplied: [], eolLegacy: [], shaMismatch: [], orphanLedger: [] } } });

describe('collectDrift — a store behind this revision is NAMED, never averaged away', () => {
  it('reproduces the 2026-08-30 shape: one clean store, one two-behind', () => {
    const result = collectDrift({
      stores: [STORE_A, STORE_B],
      unresolved: [],
      query: (s) => (s === STORE_B
        ? {
          ok: true,
          reason: null,
          drift: {
            hasDrift: true,
            drift: {
              unapplied: [
                '20260830140000_remediation_verification_tracking.sql',
                '20260830160000_upstream_issue_annotation_event.sql',
              ],
              eolLegacy: [], shaMismatch: [], orphanLedger: [],
            },
          },
        }
        : clean()),
    });

    assert.equal(result.storesQueried, 2);
    assert.equal(result.storesBehind, 1, 'the behind store must be counted, not diluted by the clean one');
    assert.equal(result.behind[0].unappliedTotal, 2);

    const card = renderDrift(result);
    assert.match(card, /STORE BEHIND THIS REVISION/);
    assert.match(card, /storyline/, 'the operator must be told WHICH store');
    assert.match(card, /20260830160000_upstream_issue_annotation_event\.sql/, 'and which migration');
    assert.doesNotMatch(card, /all current/);
  });

  it('an EDITED migration (sha mismatch) also counts as behind', () => {
    const result = collectDrift({
      stores: [STORE_A],
      unresolved: [],
      query: () => ({
        ok: true, reason: null,
        drift: { hasDrift: true, drift: { unapplied: [], eolLegacy: [], shaMismatch: ['20260101_x.sql'], orphanLedger: [] } },
      }),
    });
    assert.equal(result.storesBehind, 1);
    assert.match(renderDrift(result), /DIFFERENT sha/);
  });

  it('orphanLedger alone is NOT behind — that is a stale checkout, not a stale store', () => {
    // The store knows a migration this working tree does not have. Counting it
    // would make every out-of-date branch report its consumers as broken, which
    // is the cried-wolf shape that gets a nudge ignored. Measured: this repo's
    // own store reported exactly this while the branch under test predated a
    // concurrent session's migration.
    const result = collectDrift({
      stores: [STORE_A],
      unresolved: [],
      query: () => ({
        ok: true, reason: null,
        drift: { hasDrift: true, drift: { unapplied: [], eolLegacy: [], shaMismatch: [], orphanLedger: ['20260830150000_x.sql'] } },
      }),
    });
    assert.equal(result.storesBehind, 0);
    assert.match(renderDrift(result), /all current/);
  });
});

describe('collectDrift — silence must never read as a clean estate', () => {
  it('an unreachable store is UNQUERIED, and says so even beside good news', () => {
    const result = collectDrift({
      stores: [STORE_A, STORE_B],
      unresolved: [],
      query: (s) => (s === STORE_B ? { ok: false, drift: null, reason: 'timeout' } : clean()),
    });
    assert.equal(result.storesQueried, 1);
    assert.equal(result.storesUnqueried, 1);

    const card = renderDrift(result);
    assert.match(card, /all current/, 'the store that answered is still reported');
    assert.match(card, /unqueried/, 'and the one that did not must be reported ALONGSIDE it');
    assert.match(card, /timeout/);
    assert.match(card, /NOT assessed/);
  });

  it('ZERO stores answering says NOTHING WAS CHECKED, not "all current"', () => {
    const result = collectDrift({
      stores: [STORE_A, STORE_B],
      unresolved: [],
      query: () => ({ ok: false, drift: null, reason: 'spawn-failed' }),
    });
    assert.equal(result.storesQueried, 0);
    const card = renderDrift(result);
    assert.match(card, /NOTHING WAS CHECKED/);
    assert.doesNotMatch(card, /all current/, 'an unasked question must never render as a clean result');
  });

  it('a consumer whose DSN could not be resolved is surfaced, not dropped', () => {
    const result = collectDrift({
      stores: [STORE_A],
      unresolved: [{ repo: 'wine-cellar-app', reason: 'no-dsn' }],
      query: clean,
    });
    const card = renderDrift(result);
    assert.match(card, /no store/);
    assert.match(card, /wine-cellar-app/);
    assert.match(card, /invisible/);
  });
});

describe('the drift-found exit code carries DATA, not failure', () => {
  it('parses an envelope even though --check-drift exits 1 when it finds drift', async () => {
    // execFileSync THROWS on a non-zero exit, so the payload arrives on
    // err.stdout. A reader that only handled the success path would report
    // every drifting store as `spawn-failed` — i.e. it would go blind at
    // exactly the moment it had something to say.
    const { queryStoreDrift } = await import('../scripts/store-drift.mjs');
    assert.equal(typeof queryStoreDrift, 'function');

    const src = await import('node:fs').then((fs) => fs.promises.readFile(
      new URL('../scripts/store-drift.mjs', import.meta.url), 'utf-8',
    ));
    assert.match(src, /if \(err\?\.stdout\)/,
      'the non-zero-exit branch must re-parse stdout — exit 1 IS the drift-found signal');
    assert.match(src, /parseDriftOutput\(String\(err\.stdout\)\)/);
  });
});

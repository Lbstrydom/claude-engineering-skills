/**
 * @fileoverview The write-side ratchet — `upstreamTransition` requires
 * `--disposition` for terminal states, writes the ledger BEFORE the DB call
 * (§2.4's sequential order), and never touches the ledger for `ack`.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { upstreamTransition, DISPOSITION_LEDGER_PATH } from '../scripts/lib/upstream/commands.mjs';

let repo;
const ISSUE_ID = 'aaaaaaaa-1111-2222-3333-444444444444';

before(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'upstream-ratchet-'));
});

after(() => {
  fs.rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe('upstreamTransition — the disposition ratchet', () => {
  it('a bare `fix` (no --disposition) is refused BEFORE any write', async () => {
    let called = false;
    const res = await upstreamTransition({
      repoRoot: repo, id: ISSUE_ID, to: 'fixed', commit: null,
      transitionFn: async () => { called = true; return { ok: true }; },
    });
    // --commit is missing too, but the disposition check is what this test
    // is about — assert whichever fires first still refuses cleanly.
    assert.equal(res.ok, false);
    assert.equal(called, false);
    assert.equal(fs.existsSync(path.join(repo, DISPOSITION_LEDGER_PATH)), false);
  });

  it('a bare `wont-fix` (no --disposition) is refused BEFORE any write', async () => {
    let called = false;
    const res = await upstreamTransition({
      repoRoot: repo, id: ISSUE_ID, to: 'wont_fix', note: 'a reason',
      transitionFn: async () => { called = true; return { ok: true }; },
    });
    assert.equal(res.ok, false);
    assert.match(res.errors.join(' '), /--disposition is required/);
    assert.equal(called, false);
  });

  it('an invalid --disposition value is refused before any write', async () => {
    const res = await upstreamTransition({
      repoRoot: repo, id: ISSUE_ID, to: 'wont_fix', note: 'a reason', disposition: 'not-a-valid-kind:x',
      transitionFn: async () => { throw new Error('must not be called'); },
    });
    assert.equal(res.ok, false);
  });

  it('closing by ID PREFIX is refused — the ledger key the gate reads is a uuid', async () => {
    // The writer used to accept a prefix (the store resolves it) and record it
    // verbatim, while `upstream:coverage:gate` requires a uuid-shaped issueId.
    // So a prefixed close SUCCEEDED and left `npm run check` permanently red
    // with the report already closed — a read handing back a key its writer
    // rejects, inverted. Hit live 2026-08-29 closing five reports.
    let called = false;
    const res = await upstreamTransition({
      repoRoot: repo, id: ISSUE_ID.slice(0, 8), to: 'wont_fix', note: 'a reason',
      disposition: 'exempt:some reason',
      transitionFn: async () => { called = true; return { ok: true }; },
    });
    assert.equal(res.ok, false);
    assert.match(res.errors.join(' '), /FULL uuid/);
    assert.equal(called, false, 'refused BEFORE the DB write');
    assert.equal(fs.existsSync(path.join(repo, DISPOSITION_LEDGER_PATH)), false,
      'refused BEFORE the ledger write');
  });

  it('a prefix is still fine for `ack`, which writes no ledger entry', async () => {
    // The direction the guard must NOT fire: the prefix ergonomics are only a
    // problem because of the ledger key, so a transition with no ledger entry
    // keeps them.
    const res = await upstreamTransition({
      repoRoot: repo, id: ISSUE_ID.slice(0, 8), to: 'acknowledged',
      transitionFn: async () => ({ ok: true }),
    });
    assert.equal(res.ok, true);
  });

  it('`ack` needs no disposition and never touches the ledger', async () => {
    let seen = null;
    const res = await upstreamTransition({
      repoRoot: repo, id: ISSUE_ID, to: 'acknowledged',
      transitionFn: async (a) => { seen = a; return { ok: true }; },
    });
    assert.equal(res.ok, true);
    assert.equal(seen.disposition, null);
    assert.equal(fs.existsSync(path.join(repo, DISPOSITION_LEDGER_PATH)), false);
  });

  it('a valid disposition writes the ledger THEN calls transitionFn with the formatted string', async () => {
    const order = [];
    const res = await upstreamTransition({
      repoRoot: repo, id: ISSUE_ID, to: 'wont_fix', note: 'a reason',
      disposition: 'exempt:no probe or test applies',
      transitionFn: async (a) => {
        order.push('db-write');
        assert.equal(fs.existsSync(path.join(repo, DISPOSITION_LEDGER_PATH)), true, 'ledger must exist BEFORE the DB write');
        return { ok: true, id: a.id };
      },
    });
    assert.equal(res.ok, true);
    const ledger = JSON.parse(fs.readFileSync(path.join(repo, DISPOSITION_LEDGER_PATH), 'utf-8'));
    assert.equal(ledger.entries.length, 1);
    assert.equal(ledger.entries[0].issueId, ISSUE_ID);
    assert.deepEqual(ledger.entries[0].disposition, { kind: 'exempt', value: 'no probe or test applies' });
  });

  it('re-transitioning the SAME issue upserts (replaces), never appends a duplicate', async () => {
    await upstreamTransition({
      repoRoot: repo, id: ISSUE_ID, to: 'wont_fix', note: 'a reason',
      disposition: 'exempt:updated reason',
      transitionFn: async (a) => ({ ok: true, id: a.id }),
    });
    const ledger = JSON.parse(fs.readFileSync(path.join(repo, DISPOSITION_LEDGER_PATH), 'utf-8'));
    assert.equal(ledger.entries.length, 1);
    assert.equal(ledger.entries[0].disposition.value, 'updated reason');
  });

  it('the ledger STAYS WRITTEN even when the subsequent DB transition fails (round-1 audit M16) — the documented, accepted §2.4 gap, exercised rather than merely asserted in prose', async () => {
    const failingId = 'bbbbbbbb-2222-3333-4444-555555555555';
    // `wont_fix` (not `fixed`) deliberately — `fixed` would first verify
    // `--commit` against real git, which `repo` (a plain temp dir, not a
    // git repo) cannot satisfy, and that unrelated failure would return
    // BEFORE this test ever reaches the ledger-write-then-DB-call path it
    // means to exercise.
    const res = await upstreamTransition({
      repoRoot: repo, id: failingId, to: 'wont_fix', note: 'a reason',
      disposition: 'probe:some-probe',
      transitionFn: async () => ({ ok: false, code: 'CONFLICT', error: 'state changed under us — re-read and retry' }),
    });
    // The function surfaces the failure honestly...
    assert.equal(res.ok, false);
    // ...but the ledger entry it wrote before calling transitionFn is NOT
    // rolled back. This is the accepted trade-off from the plan's own
    // Risk Register: "a crash between step (a) and (b) can still leave the
    // ledger updated with no matching DB write" — the reconciler
    // (upstream list --worksheet) is the advisory backstop for exactly this,
    // not a rollback in upstreamTransition itself.
    const ledger = JSON.parse(fs.readFileSync(path.join(repo, DISPOSITION_LEDGER_PATH), 'utf-8'));
    const entry = ledger.entries.find((e) => e.issueId === failingId);
    assert.ok(entry, 'the ledger entry must survive a failed DB transition — this is the documented gap, not a bug to silently fix here');
    assert.deepEqual(entry.disposition, { kind: 'probe', value: 'some-probe' });
  });
});

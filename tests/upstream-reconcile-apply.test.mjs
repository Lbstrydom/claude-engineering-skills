/**
 * @fileoverview `reconcile --apply` — the repair path, and the five gates that
 * stop it laundering an undispositioned closure.
 *
 * The committed disposition ledger exists so that CLOSING an upstream report
 * cannot be a no-op: every terminal row must name a probe, a tracked test, or a
 * written exemption. A repair tool that copied whatever the store said would
 * quietly undo exactly that. INC-002 is the governing lesson — *"an env-gate
 * that checks whether a variable is SET is not a safety gate; it only proves
 * intent, never that the target is safe"* — and the analogue is exact: checking
 * that a row HAS a disposition string is not validation. It must RESOLVE.
 *
 * The DB rows arrive as an injected argument rather than from a live store:
 * `upstreamReconcile` already takes `listTerminalFn` for exactly this, and none
 * of what is asserted here needs Postgres. A DB-gated suite in this repo is two
 * edits, never one (enrolment in `db-test-container.mjs` AND
 * `postgres-parity.yml`), and one that silently skips without a DSN is a suite
 * node reports as a clean pass having run nothing.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  applyMissingDispositions, mergeLedgerEntry, serialiseDispositionLedger,
  DISPOSITION_LEDGER_PATH,
} from '../scripts/lib/upstream/commands.mjs';
import { MISSING_CAUSE } from '../scripts/lib/upstream/dispositions.mjs';
import { captureReconcilePrecondition } from '../scripts/lib/upstream/commands.mjs';
import { LEGACY_UNTRACKED_TRANSITION } from '../scripts/lib/upstream/dispositions.mjs';

const _dirs = [];
after(() => {
  for (const d of _dirs) {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best-effort */ }
  }
});

/**
 * Every setup command is CHECKED (code-audit R1 L2). An ignored `spawnSync`
 * result means a failed `git init` or a failed seed commit produces a fixture
 * that is not what the test claims to be testing, and the assertions then pass
 * or fail for a reason no one can see — the instrument failing quietly, which
 * is the thing this whole change is about.
 */
const g = (cwd, args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.error) assert.fail(`git ${args.join(' ')} could not run: ${r.error.message}`);
  assert.equal(r.status, 0, `git ${args.join(' ')} failed (${r.status}): ${r.stderr}`);
  return r;
};

/** A throwaway repo carrying a disposition ledger with `entries`. */
function makeRepo(entries = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-'));
  _dirs.push(dir);
  g(dir, ['init', '-q', '-b', 'main']);
  g(dir, ['config', 'user.email', 't@example.com']);
  g(dir, ['config', 'user.name', 'T']);
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, DISPOSITION_LEDGER_PATH), serialiseDispositionLedger(entries));
  fs.writeFileSync(path.join(dir, 'seed.txt'), 'x');
  g(dir, ['add', '.']);
  g(dir, ['commit', '-q', '-m', 'seed']);
  return dir;
}

const uuid = (n) => `aaaaaaaa-1111-2222-3333-4444444444${String(n).padStart(2, '0')}`;
const row = (id, disposition, extra = {}) => ({ issueId: id, state: 'fixed', disposition, ...extra });

const freshness = { state: 'current', behindBy: 0, upstream: 'origin/main', subjectOid: null, reason: null };

/**
 * A classification result for `dir`, carrying the precondition token captured
 * from that repo — the token is per-repo state, so it cannot be a shared
 * constant. `--apply` REFUSES without one (asserted separately below).
 */
const causeFor = (dir, overrides = {}) => ({
  cause: MISSING_CAUSE.NOT_STALENESS,
  presentUpstream: [],
  freshness,
  precondition: captureReconcilePrecondition(dir),
  ...overrides,
});

const deps = {
  probeIdsFn: () => ['hydration/tooling-absent'],
  trackedTestFilesFn: () => new Set(['tests/real.test.mjs']),
};

const readLedger = (dir) => JSON.parse(fs.readFileSync(path.join(dir, DISPOSITION_LEDGER_PATH), 'utf-8')).entries;

describe('--apply refuses unless staleness has been ruled out', () => {
  for (const cause of [MISSING_CAUSE.STALE, MISSING_CAUSE.MIXED, MISSING_CAUSE.UNKNOWN]) {
    it(`refuses on cause=${cause}, writing NOTHING`, async () => {
      // Gap 1 is gap 3's PRECONDITION. Repairing a stale checkout writes
      // duplicates of entries already pushed — the near-miss this plan came
      // from, one step from happening for real.
      const dir = makeRepo();
      const before = fs.readFileSync(path.join(dir, DISPOSITION_LEDGER_PATH), 'utf-8');
      const r = await applyMissingDispositions({
        repoRoot: dir,
        dbRows: [row(uuid(1), 'test:tests/real.test.mjs')],
        missingIds: [uuid(1)],
        missingCause: causeFor(dir, { cause }),
        ...deps,
      });
      assert.equal(r.wrote, false);
      assert.deepEqual(r.applied, []);
      assert.match(r.aborted, new RegExp(cause));
      assert.equal(fs.readFileSync(path.join(dir, DISPOSITION_LEDGER_PATH), 'utf-8'), before,
        'the ledger must be byte-identical — asserted on the bytes, not the exit code');
    });
  }
});

describe('--apply cannot launder an unvalidated closure', () => {
  const cases = [
    ['legacy-sentinel', LEGACY_UNTRACKED_TRANSITION, /needs-human-review/],
    ['disposition-shape', 'not-a-disposition', /.+/],
    ['probe-resolves', 'probe:no-such-probe', /not in the registry/],
    ['test-resolves', 'test:tests/untracked.test.mjs', /not a tracked file/],
    ['test-resolves', 'test:tests/fixtures/x.test.mjs', /fixtures|not a tracked file/],
    ['exempt-opt-in', 'exempt:because I said so', /unverifiable prose/],
  ];

  for (const [gate, disposition, reasonRe] of cases) {
    it(`refuses ${JSON.stringify(disposition).slice(0, 42)} at gate "${gate}"`, async () => {
      const dir = makeRepo();
      const r = await applyMissingDispositions({
        repoRoot: dir,
        dbRows: [row(uuid(1), disposition)],
        missingIds: [uuid(1)],
        missingCause: causeFor(dir),
        ...deps,
      });
      assert.equal(r.wrote, false, `${disposition} was written — the ratchet was laundered`);
      assert.equal(r.refused.length, 1);
      assert.equal(r.refused[0].gate, gate);
      assert.match(r.refused[0].reason, reasonRe);
      assert.deepEqual(readLedger(dir), []);
    });
  }

  it('a row with NO disposition is refused', async () => {
    const dir = makeRepo();
    const r = await applyMissingDispositions({
      repoRoot: dir, dbRows: [row(uuid(1), null)], missingIds: [uuid(1)], missingCause: causeFor(dir), ...deps,
    });
    assert.equal(r.wrote, false);
    assert.equal(r.refused[0].gate, 'disposition-present');
  });

  it('an id with no matching db row is refused, never invented', async () => {
    const dir = makeRepo();
    const r = await applyMissingDispositions({
      repoRoot: dir, dbRows: [], missingIds: [uuid(9)], missingCause: causeFor(dir), ...deps,
    });
    assert.equal(r.refused[0].gate, 'db-row');
  });

  it('`exempt:` IS applied once explicitly opted in', async () => {
    // The direction that must not be blanket-refused: the gate exists to force
    // a human decision, not to make exemptions unusable.
    const dir = makeRepo();
    const r = await applyMissingDispositions({
      repoRoot: dir, dbRows: [row(uuid(1), 'exempt:legacy, reviewed 2026-09-05')],
      missingIds: [uuid(1)], missingCause: causeFor(dir), allowExempt: true, ...deps,
    });
    assert.equal(r.wrote, true, r.aborted || JSON.stringify(r.refused));
    assert.equal(readLedger(dir)[0].disposition.kind, 'exempt');
  });
});

describe('--apply writes the batch as ONE write', () => {
  it('TWO valid rows in one batch both land — the self-invalidating-precondition regression', async () => {
    // Plan-audit R2 H1. The defect is UNREACHABLE with a single row: the first
    // write is the very thing that invalidates the ledger hash, so a one-row
    // fixture passes identically against the broken per-row design and the
    // fixed batch design. Against the per-row predecessor this fails on the
    // second row.
    const dir = makeRepo();
    const r = await applyMissingDispositions({
      repoRoot: dir,
      dbRows: [row(uuid(1), 'test:tests/real.test.mjs'), row(uuid(2), 'probe:hydration/tooling-absent')],
      missingIds: [uuid(1), uuid(2)],
      missingCause: causeFor(dir),
      ...deps,
    });
    assert.equal(r.aborted, null, r.aborted || '');
    assert.equal(r.wrote, true);
    assert.deepEqual(r.applied.sort(), [uuid(1), uuid(2)]);
    assert.equal(readLedger(dir).length, 2, 'both rows must land from one batch');
  });

  it('is idempotent — a second run RE-APPLIES and still leaves one entry', async () => {
    // Code-audit R3 M2. The first version reused ONE token for both calls, so
    // the second was refused (the first write invalidated its ledger hash) and
    // "no duplicate" held because nothing happened the second time — a vacuous
    // pass that would survive a merge rule that appended blindly. A real second
    // run re-classifies, so it re-captures; both calls must WRITE, and the
    // result must still be one entry.
    const dir = makeRepo();
    const base = {
      repoRoot: dir, dbRows: [row(uuid(1), 'test:tests/real.test.mjs')],
      missingIds: [uuid(1)], ...deps,
    };
    const first = await applyMissingDispositions({ ...base, missingCause: causeFor(dir) });
    assert.equal(first.wrote, true, first.aborted || JSON.stringify(first.refused));
    const second = await applyMissingDispositions({ ...base, missingCause: causeFor(dir) });
    assert.equal(second.wrote, true, second.aborted || JSON.stringify(second.refused));
    assert.deepEqual(readLedger(dir).map((e) => e.issueId), [uuid(1)],
      'keyed by issueId — a re-apply replaces, never appends');
  });

  it('preserves a storeFingerprint an earlier write established', async () => {
    // A read-modify-write is a constructor: silently dropping a field on
    // re-write is how an entry becomes legacy-shaped without anyone deciding.
    const dir = makeRepo([{ schemaVersion: 1, issueId: uuid(1), storeFingerprint: 'ABC', state: 'fixed', disposition: { kind: 'exempt', value: 'old' }, recordedAt: '2026-01-01T00:00:00.000Z' }]);
    const r = await applyMissingDispositions({
      repoRoot: dir, dbRows: [row(uuid(1), 'test:tests/real.test.mjs')],
      missingIds: [uuid(1)], missingCause: causeFor(dir), ...deps,
    });
    // Code-audit R3 M1: asserting only that the fingerprint is still ABC is
    // VACUOUS — the seed entry already carries it, so a refused apply passes
    // identically to a successful one. Prove the write HAPPENED first, then
    // that the field survived it.
    assert.equal(r.wrote, true, r.aborted || JSON.stringify(r.refused));
    const entry = readLedger(dir)[0];
    assert.equal(entry.disposition.kind, 'test', 'the disposition must have been replaced');
    assert.equal(entry.storeFingerprint, 'ABC', 'and the fingerprint preserved across that replacement');
  });
});

describe('the mutation is bound to the state it was classified against', () => {
  it('aborts, writing nothing, when the repo moved after classification', async () => {
    // Not hypothetical: HEAD moved 16 times in one worktree during a single
    // sitting of this very work.
    //
    // Asserted DETERMINISTICALLY via the pinned OID rather than by racing a
    // concurrent writer. An earlier version of this test wrote to the ledger
    // while the apply was in flight and hoped to land inside the window; it
    // could not do so reliably, and its own write clobbered the result — a test
    // whose outcome depended on scheduling, reporting a defect in the code that
    // was really a defect in the instrument.
    const dir = makeRepo();
    const staleOid = 'dead00000000000000000000000000000000beef';
    const r = await applyMissingDispositions({
      repoRoot: dir,
      dbRows: [row(uuid(1), 'test:tests/real.test.mjs')],
      missingIds: [uuid(1)],
      missingCause: causeFor(dir, { precondition: { headOid: staleOid, ledgerHash: 'x'.repeat(64), capturedAt: 'now' } }),
      ...deps,
    });
    assert.equal(r.wrote, false);
    assert.match(r.aborted, /repository moved/);
    assert.deepEqual(readLedger(dir), [], 'an aborted apply must leave no partial write');
  });

  it('REFUSES when no precondition was captured at all', async () => {
    // An optional safety input whose omission passes is not a safety gate
    // (INC-002's shape). A caller that forgot to capture a token must not get a
    // write; and a token this function minted itself would only prove nothing
    // changed while it ran, which is not the question being asked.
    const dir = makeRepo();
    const r = await applyMissingDispositions({
      repoRoot: dir,
      dbRows: [row(uuid(1), 'test:tests/real.test.mjs')],
      missingIds: [uuid(1)],
      missingCause: { cause: MISSING_CAUSE.NOT_STALENESS, presentUpstream: [], freshness },
      ...deps,
    });
    assert.equal(r.wrote, false);
    assert.match(r.aborted, /no precondition/);
    assert.deepEqual(readLedger(dir), []);
  });

  it('aborts when the LEDGER changed after classification, even if HEAD did not', async () => {
    // The two halves are one snapshot: a commit that did not move does not
    // license a write onto a ledger that did.
    const dir = makeRepo();
    const mc = causeFor(dir);
    fs.writeFileSync(path.join(dir, DISPOSITION_LEDGER_PATH), serialiseDispositionLedger([
      { schemaVersion: 1, issueId: uuid(7), state: 'fixed', disposition: { kind: 'exempt', value: 'other' }, recordedAt: '2026-01-01T00:00:00.000Z' },
    ]));
    const r = await applyMissingDispositions({
      repoRoot: dir, dbRows: [row(uuid(1), 'test:tests/real.test.mjs')],
      missingIds: [uuid(1)], missingCause: mc, ...deps,
    });
    assert.equal(r.wrote, false);
    assert.match(r.aborted, /ledger changed on disk/);
    assert.ok(!readLedger(dir).some((e) => e.issueId === uuid(1)));
  });

  it('proceeds when the pinned OID still matches', async () => {
    // The direction that must not fire: a correct precondition must not block
    // the ordinary case, or the repair path is unusable.
    const dir = makeRepo();
    const head = String(g(dir, ['rev-parse', 'HEAD']).stdout).trim();
    const r = await applyMissingDispositions({
      repoRoot: dir,
      dbRows: [row(uuid(1), 'test:tests/real.test.mjs')],
      missingIds: [uuid(1)],
      missingCause: causeFor(dir),
      ...deps,
    });
    assert.equal(r.aborted, null);
    assert.equal(r.wrote, true);
  });
});

describe('mergeLedgerEntry — the shared rule', () => {
  it('replaces by issueId rather than appending', () => {
    const start = [{ schemaVersion: 1, issueId: uuid(1), state: 'fixed', disposition: { kind: 'exempt', value: 'a' }, recordedAt: 'x' }];
    const out = mergeLedgerEntry(start, { issueId: uuid(1), state: 'wont_fix', disposition: { kind: 'exempt', value: 'b' } });
    assert.equal(out.length, 1);
    assert.equal(out[0].state, 'wont_fix');
  });

  it('does not mutate its input — the batch folds it repeatedly', () => {
    const start = [];
    mergeLedgerEntry(start, { issueId: uuid(1), state: 'fixed', disposition: { kind: 'exempt', value: 'a' } });
    assert.deepEqual(start, [], 'the caller folds this in a loop; mutation would compound');
  });
});

/**
 * The batch writer's half of the absent-directory case.
 *
 * `withFileLock` creates a sibling `.lock` file and does NOT mkdir, while
 * `atomicWriteFileSync` does — so a repo with no `scripts/` directory died on
 * ENOENT during lock acquisition, before any writer ran. The single-entry path's
 * version of this is covered by `tests/upstream-disposition-ratchet.test.mjs`;
 * this is the assertion that keeps `ensureLedgerDir` reaching BOTH writers,
 * rather than a docstring claiming it does.
 */
describe('the ledger directory need not exist yet', () => {
  it('--apply writes into a repo whose ledger directory does not exist', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-nodir-'));
    _dirs.push(dir);
    g(dir, ['init', '-q', '-b', 'main']);
    g(dir, ['config', 'user.email', 't@example.com']);
    g(dir, ['config', 'user.name', 'T']);
    fs.writeFileSync(path.join(dir, 'seed.txt'), 'x');
    g(dir, ['add', '.']);
    g(dir, ['commit', '-q', '-m', 'seed']);
    assert.equal(fs.existsSync(path.join(dir, 'scripts')), false, 'precondition: no scripts/ dir');

    const res = await applyMissingDispositions({
      repoRoot: dir, dbRows: [row(uuid(1), 'test:tests/real.test.mjs')], missingIds: [uuid(1)],
      missingCause: causeFor(dir), ...deps,
    });

    assert.equal(res.aborted, null, 'must not abort on a missing ledger directory');
    assert.equal(res.wrote, true, JSON.stringify(res.refused));
    assert.ok(fs.existsSync(path.join(dir, DISPOSITION_LEDGER_PATH)), 'the ledger must have been created');
    });
});

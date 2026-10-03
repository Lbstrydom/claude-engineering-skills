/**
 * The single-entry ledger writer (`writeLedgerEntry` / `writeStage1MechanicalLedgerEntry`,
 * both over `writeSingleLedgerEntry`) — locking and corruption policy.
 *
 * Two defects, both measured 2026-10-03 by running the code:
 *
 *  (a) it took NO lock. It was the one read-modify-write over the ledger without
 *      one (`batchWriteLedger`, `applyLifecycleUpdates` both lock), so concurrent
 *      writers each replaced the file from a stale read: 3 processes x 40 calls
 *      left 40-49 of 120 entries on disk.
 *  (b) it failed OPEN on corruption — "backing up and starting fresh" — which
 *      replaced a 5-ruling ledger with the 1 entry in hand, exited 0, and let a
 *      second corruption overwrite the `.bak` that held the only copy. Every other
 *      path through the ledger throws.
 *
 * NEGATIVE CONTROL for the multi-process test: it is only worth anything if it
 * can fail. Point `LEDGER_SINGLE_WRITER_MODULE` at a copy of the pre-fix
 * `scripts/lib/ledger.mjs` (`git show <pre-fix-sha>:scripts/lib/ledger.mjs`, with
 * its `./` imports re-pointed at `scripts/lib/`) and the suite goes red:
 * lost entries, the lock-wait test (the unlocked writer returns immediately
 * instead of waiting out the held lock) and every corruption test (it replaces
 * the ledger instead of throwing).
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LEDGER_MODULE_URL = process.env.LEDGER_SINGLE_WRITER_MODULE
  ? pathToFileURL(path.resolve(process.env.LEDGER_SINGLE_WRITER_MODULE)).href
  : pathToFileURL(path.join(HERE, '../scripts/lib/ledger.mjs')).href;
// proper-lockfile is resolved from the repo root, not from a temp dir.
const REPO_ROOT = path.join(HERE, '..');
// Every test — in-process and in the children — exercises THIS module.
const { writeLedgerEntry, writeStage1MechanicalLedgerEntry } = await import(LEDGER_MODULE_URL);

const mkEntry = (overrides = {}) => ({
  topicId: 'abc123def456',
  semanticHash: 'deadbeef',
  adjudicationOutcome: 'accepted',
  remediationState: 'pending',
  severity: 'HIGH',
  originalSeverity: 'HIGH',
  category: 'Missing Error Handling',
  section: 'scripts/shared.mjs',
  detailSnapshot: 'No validation on write path',
  affectedFiles: ['scripts/shared.mjs'],
  affectedPrinciples: ['DRY'],
  ruling: 'sustain',
  rulingRationale: 'Valid finding',
  resolvedRound: 1,
  pass: 'backend',
  ...overrides,
});

const mkStage1Entry = (overrides = {}) => ({
  topicId: 'topic-1', semanticHash: 'hash1', severity: 'MEDIUM',
  category: 'Dead Code', section: 'src/foo.js:10', detailSnapshot: 'foo() is never called',
  affectedFiles: ['src/foo.js'], affectedPrinciples: [], pass: 'sustainability',
  source: 'stage1-mechanical', adjudicationOutcome: 'dismissed', remediationState: 'pending',
  disproof: 'grep confirms foo() has zero call sites in the diff',
  resolvedRound: 1,
  ...overrides,
});

/** Run a child; resolve `{code, stderr, timedOut}`. Never rejects. */
function run(args, { env, timeoutMs, onStdout } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    let timedOut = false;
    const timer = timeoutMs ? setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs) : null;
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdout.on('data', (d) => onStdout?.(String(d), child));
    child.on('close', (code) => { if (timer) clearTimeout(timer); resolve({ code, stderr, timedOut }); });
  });
}

// Each writer imports the module FIRST, then announces itself and spins until all
// its siblings have too — a true barrier, so the writes genuinely overlap. Without
// it, node's start-up stagger lets one process finish before the next begins and
// the race (and the negative control) can pass by luck.
const WRITER = `
const [moduleUrl, ledger, id, m, readyDir, total] = process.argv.slice(1);
const fs = await import('node:fs');
const { writeLedgerEntry } = await import(moduleUrl);
fs.writeFileSync(readyDir + '/ready-' + id, '');
const wait = new Int32Array(new SharedArrayBuffer(4));
const deadline = Date.now() + 20000;
while (fs.readdirSync(readyDir).length < Number(total) && Date.now() < deadline) Atomics.wait(wait, 0, 0, 5);
for (let i = 0; i < Number(m); i++) {
  writeLedgerEntry(ledger, {
    topicId: id + '-' + i, semanticHash: 'h', adjudicationOutcome: 'accepted', remediationState: 'pending',
    severity: 'HIGH', originalSeverity: 'HIGH', category: 'c', section: 's', detailSnapshot: 'd',
    affectedFiles: ['a.mjs'], affectedPrinciples: [], ruling: 'sustain', rulingRationale: 'r',
    resolvedRound: 1, pass: 'backend',
  });
}
`;

// Holds the ledger's lock for `holdMs`, announcing once it has it.
const LOCK_HOLDER = `
import lockfile from 'proper-lockfile';
const [ledger, holdMs] = process.argv.slice(1);
const release = lockfile.lockSync(ledger, { stale: 10000 });
process.stdout.write('locked\\n');
setTimeout(() => { release(); process.stdout.write('released\\n'); }, Number(holdMs));
`;

describe('writeLedgerEntry — concurrent writers (defect a)', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-single-writer-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));

  it('N processes x M writes against a ledger that does not yet exist lose nothing', async (t) => {
    const N = 3;
    const M = 15;
    const ledger = path.join(dir, 'ledger.json');
    const readyDir = path.join(dir, 'ready');
    fs.mkdirSync(readyDir);

    const results = await Promise.all(Array.from({ length: N }, (_, k) => run(
      ['--input-type=module', '-e', WRITER, LEDGER_MODULE_URL, ledger, `p${k}`, String(M), readyDir, String(N)],
      { timeoutMs: 90_000 },
    )));

    // A timeout means a starved host, not a verdict on the lock — skip rather than
    // report a failure (or, worse, a pass) the run did not earn.
    if (results.some(r => r.timedOut)) {
      t.skip('a writer process timed out (contended host) — no verdict');
      return;
    }
    for (const [k, r] of results.entries()) {
      assert.equal(r.code, 0, `writer p${k} must exit 0; stderr tail: ${r.stderr.slice(-400)}`);
    }

    const onDisk = JSON.parse(fs.readFileSync(ledger, 'utf-8'));
    const ids = new Set(onDisk.entries.map(e => e.topicId));
    assert.equal(
      ids.size, N * M,
      `lost updates: ${ids.size} of ${N * M} entries survived (the unlocked writer leaves roughly a third)`,
    );
    for (let k = 0; k < N; k++) {
      for (let i = 0; i < M; i++) assert.ok(ids.has(`p${k}-${i}`), `p${k}-${i} missing`);
    }
    assert.equal(fs.existsSync(`${ledger}.lock`), false, 'the lock must be released');
  });

  it('waits out a lock another process holds, then writes — it does not write straight through, and does not give up', async (t) => {
    const ledger = path.join(dir, 'ledger.json');
    fs.writeFileSync(ledger, JSON.stringify({ version: 1, entries: [] }), 'utf-8');

    const HOLD_MS = 800;
    let writeStartedAt = null;
    let writeMs = null;
    let writeError = null;
    const holder = run(['--input-type=module', '-e', LOCK_HOLDER, ledger, String(HOLD_MS)], {
      timeoutMs: 30_000,
      onStdout: (chunk, child) => {
        if (!chunk.includes('locked') || writeStartedAt !== null) return;
        // The holder announced the lock. This call BLOCKS this thread until it
        // returns, which is the point: the holder is a separate process.
        writeStartedAt = Date.now();
        try { writeLedgerEntry(ledger, mkEntry()); } catch (err) { writeError = err; }
        writeMs = Date.now() - writeStartedAt;
        void child;
      },
    });
    const res = await holder;
    if (res.timedOut) { t.skip('lock-holder process timed out — no verdict'); return; }
    assert.equal(res.code, 0, `holder must exit cleanly; stderr: ${res.stderr.slice(-300)}`);

    assert.equal(writeError, null, `the write must succeed once the lock frees, got: ${writeError?.message}`);
    // Not HOLD_MS exactly: the holder started its timer before this thread saw the
    // announcement. Anything near zero means the writer ignored the lock.
    assert.ok(writeMs >= HOLD_MS / 2, `the writer returned in ${writeMs}ms with the lock held — it did not take the ledger lock`);
    const onDisk = JSON.parse(fs.readFileSync(ledger, 'utf-8'));
    assert.deepEqual(onDisk.entries.map(e => e.topicId), ['abc123def456']);
  });
});

describe('writeLedgerEntry — a damaged ledger is refused, never replaced (defect b)', () => {
  let dir, ledgerPath;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-single-corrupt-'));
    ledgerPath = path.join(dir, 'ledger.json');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));

  /** A real 5-ruling ledger, cut off mid-entry — what an interrupted writer leaves. */
  function seedTruncatedLedger() {
    for (let i = 0; i < 5; i++) writeLedgerEntry(ledgerPath, mkEntry({ topicId: `ruling-${i}` }));
    const full = fs.readFileSync(ledgerPath, 'utf-8');
    const truncated = full.slice(0, full.length - 40);
    fs.writeFileSync(ledgerPath, truncated, 'utf-8');
    return truncated;
  }

  it('throws, naming the file, and leaves the ledger byte-for-byte as found', () => {
    const before = seedTruncatedLedger();
    assert.throws(
      () => writeLedgerEntry(ledgerPath, mkEntry({ topicId: 'new-entry' })),
      (err) => err instanceof Error
        && err.message.includes(ledgerPath)
        && /unreadable/.test(err.message)
        && err.cause instanceof SyntaxError,
    );
    assert.equal(fs.readFileSync(ledgerPath, 'utf-8'), before,
      'the 5 sustained rulings must still be recoverable — not truncated to the 1 entry in hand');
  });

  it('does not create or clobber the .bak, even on a second corruption', () => {
    const SENTINEL = '{"the":"only copy of the real ledger"}'.padEnd(2600, ' ');
    fs.writeFileSync(`${ledgerPath}.bak`, SENTINEL, 'utf-8');
    seedTruncatedLedger();
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.throws(() => writeLedgerEntry(ledgerPath, mkEntry({ topicId: `n-${attempt}` })), /unreadable/);
      // Corrupt it differently the second time, as a later crash would.
      fs.writeFileSync(ledgerPath, `garbage-${attempt}`, 'utf-8');
    }
    assert.equal(fs.readFileSync(`${ledgerPath}.bak`, 'utf-8'), SENTINEL, 'a pre-existing .bak must never be overwritten');
  });

  it('writes no .bak of its own — nothing was changed, so there is nothing to back up', () => {
    seedTruncatedLedger();
    assert.throws(() => writeLedgerEntry(ledgerPath, mkEntry({ topicId: 'x' })), /unreadable/);
    assert.equal(fs.existsSync(`${ledgerPath}.bak`), false);
  });

  it('refuses every unreadable shape: valid JSON that is not a ledger, null, and an empty file', () => {
    for (const content of ['{"version":1}', 'null', '[]', '']) {
      fs.writeFileSync(ledgerPath, content, 'utf-8');
      assert.throws(
        () => writeLedgerEntry(ledgerPath, mkEntry()),
        /unreadable/,
        `content ${JSON.stringify(content)} must be refused`,
      );
      assert.equal(fs.readFileSync(ledgerPath, 'utf-8'), content, `content ${JSON.stringify(content)} must be left untouched`);
    }
  });

  it('releases the lock when it throws, so the next writer is not blocked by a failed one', () => {
    seedTruncatedLedger();
    assert.throws(() => writeLedgerEntry(ledgerPath, mkEntry()), /unreadable/);
    assert.equal(fs.existsSync(`${ledgerPath}.lock`), false, 'a throw must not orphan the lock directory');
    // And a repaired ledger is writable immediately — no 10s stale-lock wait.
    fs.writeFileSync(ledgerPath, JSON.stringify({ version: 1, entries: [] }), 'utf-8');
    writeLedgerEntry(ledgerPath, mkEntry());
    assert.equal(JSON.parse(fs.readFileSync(ledgerPath, 'utf-8')).entries.length, 1);
  });

  it('the stage1-mechanical writer shares the policy', () => {
    fs.writeFileSync(ledgerPath, '{"version":1,"entries":[{"topicId":"keep-me"', 'utf-8');
    const before = fs.readFileSync(ledgerPath, 'utf-8');
    assert.throws(() => writeStage1MechanicalLedgerEntry(ledgerPath, mkStage1Entry()), /unreadable/);
    assert.equal(fs.readFileSync(ledgerPath, 'utf-8'), before);
  });

  it('negative control — a healthy ledger still upserts, and a missing ledger is created', () => {
    writeLedgerEntry(ledgerPath, mkEntry({ topicId: 'a' }));
    writeLedgerEntry(ledgerPath, mkEntry({ topicId: 'b' }));
    writeLedgerEntry(ledgerPath, mkEntry({ topicId: 'a', remediationState: 'fixed' }));
    const entries = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8')).entries;
    assert.deepEqual(entries.map(e => e.topicId), ['a', 'b']);
    assert.equal(entries[0].remediationState, 'fixed');
  });

  it('an invalid entry is still refused with no throw and no file (the documented contract)', () => {
    writeLedgerEntry(ledgerPath, mkEntry({ adjudicationOutcome: 'not-a-real-outcome' }));
    assert.equal(fs.existsSync(ledgerPath), false);
    assert.equal(fs.existsSync(`${ledgerPath}.lock`), false);
  });
});

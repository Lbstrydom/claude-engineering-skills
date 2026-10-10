/**
 * @fileoverview `upstream reconcile --gate` ATTRIBUTES divergence to the pushed
 * range (plan: docs/plans/upstream-disposition-landing.md).
 *
 * The incident (2026-10-10): `upstream fix` writes the disposition entry into
 * the closer's working tree, then transitions the store row. Until that one JSON
 * entry landed on main, every push from EVERY session failed the gate. It
 * happened twice in one day (#180, #183). The blocked sessions could not fix it
 * from their own commit.
 *
 * The rule tested here: a divergence BLOCKS only when the pushed range changed
 * that issue's ledger entry. Anything else is store movement, which is REPORTED
 * on every run with its cause. When the range cannot be attributed, the gate
 * fails closed (blocks everything, as before).
 *
 * Real git, in a temp repo: the dispatcher derives `repoRoot` from the cwd and
 * the base from `AUDIT_PUSH_RANGE_BASE`, the same env contract the pre-push
 * hook uses.
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { upstreamCmd } from '../scripts/lib/cross-skill/commands/quality.mjs';
import { _resetRepoRootCache } from '../scripts/lib/assert-repo-root.mjs';
import {
  changedLedgerIds, decideReconcileGate, readRangeBaseLedger,
  renderBlockingMessage, renderPreExistingLines,
} from '../scripts/lib/upstream/reconcile-gate.mjs';

const LEDGER_REL = path.join('scripts', 'upstream-dispositions.json');
const ID_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const ID_B = 'bbbbbbbb-0000-4000-8000-00000000000b';

const entry = (issueId, value = 'tests/x.test.mjs') => ({
  schemaVersion: 1, issueId, state: 'fixed',
  disposition: { kind: 'test', value }, recordedAt: '2026-10-01T00:00:00.000Z',
});
const row = (issueId, value = 'tests/x.test.mjs', closedAt = '2026-10-10T09:15:00.000Z') => ({
  issueId, state: 'fixed', disposition: `test:${value}`, closedAt,
});
const ledgerText = (entries) => `${JSON.stringify({ entries }, null, 2)}\n`;

let repo, baseSha, origCwd;
const savedEnv = {};
const ENV_KEYS = ['AUDIT_PUSH_RANGE_BASE', 'AUDIT_PUSH_RANGE_HEAD', 'AUDIT_PUSH_RANGE_REQUIRED', 'AUDIT_DB_URL'];

function git(...args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function writeLedger(entries) {
  fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(repo, LEDGER_REL), ledgerText(entries));
}

function makeCtx(rows) {
  return {
    verb: 'reconcile',
    cloud: { enabled: true },
    flag: () => null,
    hasFlag: (name) => name === 'gate',
    resolveScope: async () => ({ kind: 'none' }),
    deps: { listTerminalUpstreamIssues: async () => ({ ok: true, cloud: true, rows }) },
  };
}

async function runCapturingStderr(fn) {
  let err = '';
  const orig = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => { err += chunk; return orig.call(process.stderr, chunk, ...rest); };
  try {
    return { result: await fn(), stderr: () => err };
  } catch (e) {
    return { error: e, stderr: () => err };
  } finally {
    process.stderr.write = orig;
  }
}

before(() => {
  origCwd = process.cwd();
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-attr-'));
  git('init', '-q');
  git('config', 'user.email', 't@example.invalid');
  git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  writeLedger([entry(ID_A)]);
  git('add', '--', LEDGER_REL);
  git('commit', '-q', '-m', 'base ledger');
  baseSha = git('rev-parse', 'HEAD');
});

after(() => {
  process.chdir(origCwd);
  _resetRepoRootCache();
  fs.rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

beforeEach(() => {
  // Unstamped entries + no DSN keeps the store-scope partition out of these tests.
  delete process.env.AUDIT_DB_URL;
  process.env.AUDIT_PUSH_RANGE_BASE = baseSha;
  delete process.env.AUDIT_PUSH_RANGE_HEAD;
  delete process.env.AUDIT_PUSH_RANGE_REQUIRED;
  writeLedger([entry(ID_A)]);
  process.chdir(repo);
  _resetRepoRootCache();
});

afterEach(() => {
  process.chdir(origCwd);
  _resetRepoRootCache();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
});

describe('upstream reconcile --gate — attribution to the pushed range (dispatcher, real git)', () => {
  it('a closure whose entry was never landed does NOT block an unrelated push, and is reported with its cause', async () => {
    // B is terminal in the store, but neither the base nor this commit carries
    // its entry. This is exactly the 2026-10-10 incident shape.
    const { result, error, stderr } = await runCapturingStderr(
      () => upstreamCmd(makeCtx([row(ID_A), row(ID_B)])));
    assert.equal(error, undefined, `must not block: ${error?.message}`);
    assert.equal(result.ok, true);
    const out = stderr();
    assert.match(out, new RegExp(ID_B));
    assert.match(out, /NOT caused by this push/);
    assert.match(out, /2026-10-10T09:15/, 'names when the store row was closed');
    assert.match(out, /upstream:reconcile -- --apply/, 'names a remedy');
  });

  it('a push that REMOVES a disposition entry whose store row is terminal still blocks, naming the cause', async () => {
    writeLedger([]);
    const { error } = await runCapturingStderr(() => upstreamCmd(makeCtx([row(ID_A)])));
    assert.ok(error, 'must block');
    assert.equal(error.code, 'RECONCILE_NEEDS_REVIEW');
    assert.match(error.message, new RegExp(ID_A));
    assert.match(error.message, /removes/);
  });

  it('a push that ADDS an entry with no terminal store row blocks (the ledger-ahead-of-store shape)', async () => {
    writeLedger([entry(ID_A), entry(ID_B)]);
    const { error } = await runCapturingStderr(() => upstreamCmd(makeCtx([row(ID_A)])));
    assert.ok(error, 'must block');
    assert.equal(error.code, 'RECONCILE_NEEDS_REVIEW');
    assert.match(error.message, new RegExp(ID_B));
  });

  it('mixed: blocks on the attributable item only, and still reports the pre-existing one', async () => {
    writeLedger([entry(ID_A, 'tests/changed.test.mjs')]);
    const { error, stderr } = await runCapturingStderr(
      () => upstreamCmd(makeCtx([row(ID_A), row(ID_B)])));
    assert.ok(error, 'must block on A');
    assert.match(error.message, new RegExp(ID_A));
    assert.doesNotMatch(error.message, new RegExp(ID_B), 'B is not this push\'s divergence');
    assert.match(stderr(), new RegExp(`${ID_B}[\\s\\S]*NOT caused by this push|NOT caused by this push[\\s\\S]*${ID_B}`));
  });

  it('fails CLOSED when the range base cannot be resolved: every divergence blocks', async () => {
    process.env.AUDIT_PUSH_RANGE_BASE = 'f'.repeat(40);
    const { error } = await runCapturingStderr(() => upstreamCmd(makeCtx([row(ID_A), row(ID_B)])));
    assert.ok(error, 'unattributable must block');
    assert.equal(error.code, 'RECONCILE_NEEDS_REVIEW');
    assert.match(error.message, new RegExp(ID_B));
    assert.match(error.message, /could not attribute/i);
  });

  it('fails CLOSED when the head ledger is malformed, even with no per-id divergence', async () => {
    fs.writeFileSync(path.join(repo, LEDGER_REL), '{ not json');
    const { error } = await runCapturingStderr(() => upstreamCmd(makeCtx([])));
    assert.ok(error, 'a malformed ledger must never read as a clean empty one');
    assert.equal(error.code, 'RECONCILE_NEEDS_REVIEW');
    assert.match(error.message, /malformed/);
  });

  it('a clean reconciliation passes silently-clean (the direction it must NOT fire)', async () => {
    const { result, error, stderr } = await runCapturingStderr(() => upstreamCmd(makeCtx([row(ID_A)])));
    assert.equal(error, undefined);
    assert.equal(result.ok, true);
    assert.doesNotMatch(stderr(), /NOT caused by this push/);
  });
});

// ── The pure decision (Tier 1) ─────────────────────────────────────────────

const recon = (over = {}) => ({
  missingFromLedger: [], ledgerOnly: [], stateMismatch: [], dispositionMismatch: [], needsReview: [],
  stateMismatchIds: [], dispositionMismatchIds: [], otherStore: [], ...over,
});
const read = (entries) => ({ status: 'read', entries, reason: null, range: 'BASE..HEAD [explicit]' });
const ID_C = 'cccccccc-0000-4000-8000-00000000000c';

describe('changedLedgerIds', () => {
  it('names added, removed and edited entries, and nothing else', () => {
    const changed = changedLedgerIds({
      baseEntries: [entry(ID_A), entry(ID_C)],
      headEntries: [entry(ID_A, 'tests/other.test.mjs'), entry(ID_B)],
    });
    assert.deepEqual([...changed].sort(), [ID_A, ID_B, ID_C].sort());
  });

  it('key order alone is not a change (canonical comparison)', () => {
    const e = entry(ID_A);
    const reordered = Object.fromEntries(Object.entries(e).reverse());
    assert.equal(changedLedgerIds({ baseEntries: [e], headEntries: [reordered] }).size, 0);
  });

  it('a recordedAt-only rewrite IS a change (the conservative direction)', () => {
    const e = entry(ID_A);
    assert.deepEqual([...changedLedgerIds({ baseEntries: [e], headEntries: [{ ...e, recordedAt: 'later' }] })], [ID_A]);
  });
});

describe('decideReconcileGate', () => {
  it('every category on an UNCHANGED id is pre-existing, never blocking', () => {
    const d = decideReconcileGate({
      reconciliation: recon({
        missingFromLedger: [ID_B], ledgerOnly: [ID_A], stateMismatch: [`${ID_A}: x`], stateMismatchIds: [ID_A],
        dispositionMismatch: [`${ID_A}: y`], dispositionMismatchIds: [ID_A], needsReview: [ID_A],
      }),
      head: read([entry(ID_A)]), base: read([entry(ID_A)]),
    });
    assert.equal(d.attributable, true);
    assert.equal(d.blocking.length, 0);
    assert.deepEqual(d.preExisting.map((i) => i.category).sort(),
      ['dispositionMismatch', 'ledgerOnly', 'missing', 'needsReview', 'stateMismatch']);
  });

  it('every category on a CHANGED id blocks', () => {
    const d = decideReconcileGate({
      reconciliation: recon({
        ledgerOnly: [ID_B], dispositionMismatch: [`${ID_A}: y`], dispositionMismatchIds: [ID_A], needsReview: [ID_A],
      }),
      head: read([entry(ID_A, 'tests/edited.test.mjs'), entry(ID_B)]), base: read([entry(ID_A)]),
    });
    assert.equal(d.preExisting.length, 0);
    assert.equal(d.blocking.length, 3);
  });

  it('an absent base ledger is determinate: every head entry is new, so its divergence blocks', () => {
    const d = decideReconcileGate({
      reconciliation: recon({ ledgerOnly: [ID_A] }),
      head: read([entry(ID_A)]), base: { status: 'absent', entries: null, reason: null, range: 'r' },
    });
    assert.equal(d.attributable, true);
    assert.equal(d.blocking.length, 1);
  });

  for (const status of ['unresolved', 'unreadable', 'malformed']) {
    it(`a ${status} base fails CLOSED: everything blocks, and the reason is named`, () => {
      const d = decideReconcileGate({
        reconciliation: recon({ missingFromLedger: [ID_B] }),
        head: read([entry(ID_A)]), base: { status, entries: null, reason: 'because', range: null },
      });
      assert.equal(d.attributable, false);
      assert.equal(d.blocking.length, 1);
      assert.match(renderBlockingMessage(d), new RegExp(`could not attribute[\\s\\S]*${status}`));
    });
  }

  it('a malformed head blocks as an integrity failure even with zero per-id divergence', () => {
    const d = decideReconcileGate({
      reconciliation: recon(), head: { status: 'malformed', entries: null, reason: 'not valid JSON' }, base: read([]),
    });
    assert.equal(d.attributable, false);
    assert.equal(d.blocking.length, 1);
    assert.equal(d.blocking[0].category, 'ledger-unreadable');
  });

  it('a mismatch item without an id cannot be attributed, so it blocks', () => {
    const d = decideReconcileGate({
      reconciliation: recon({ stateMismatch: ['?: x'], stateMismatchIds: [] }),
      head: read([]), base: read([]),
    });
    assert.equal(d.blocking.length, 1);
  });
});

describe('renderPreExistingLines', () => {
  it('says the entry already landed upstream (rebase) when the missing id is on the upstream', () => {
    const d = decideReconcileGate({ reconciliation: recon({ missingFromLedger: [ID_B] }), head: read([]), base: read([]) });
    const lines = renderPreExistingLines(d, { rows: [row(ID_B)], presentUpstream: [ID_B] }).join('\n');
    assert.match(lines, /already landed upstream/);
    assert.match(lines, /rebas/);
    assert.doesNotMatch(lines, /--apply/);
  });

  it('is empty when there is nothing pre-existing (silent on a clean run)', () => {
    const d = decideReconcileGate({ reconciliation: recon(), head: read([]), base: read([]) });
    assert.deepEqual(renderPreExistingLines(d), []);
  });

  it('carries no angle-bracket placeholder (PowerShell-safe operator text)', () => {
    const d = decideReconcileGate({
      reconciliation: recon({ missingFromLedger: [ID_B], ledgerOnly: [ID_A], needsReview: [ID_A] }),
      head: read([entry(ID_A)]), base: read([entry(ID_A)]),
    });
    assert.doesNotMatch(renderPreExistingLines(d, { rows: [row(ID_B)] }).join('\n'), /<[a-z]/i);
  });
});

describe('readRangeBaseLedger (real git, temp repo)', () => {
  it('reads the ledger at an explicit range base', () => {
    const r = readRangeBaseLedger({ repoRoot: repo, env: { AUDIT_PUSH_RANGE_BASE: baseSha } });
    assert.equal(r.status, 'read');
    assert.deepEqual(r.entries.map((e) => e.issueId), [ID_A]);
    assert.match(r.range, /explicit/);
  });

  it('is `unresolved` (never an empty read) when the base does not resolve', () => {
    const r = readRangeBaseLedger({ repoRoot: repo, env: { AUDIT_PUSH_RANGE_BASE: 'e'.repeat(40) } });
    assert.equal(r.status, 'unresolved');
    assert.equal(r.entries, null);
  });

  it('is `absent` at a base that predates the ledger, and `malformed` at one with a broken ledger', () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-base-'));
    const g = (...a) => execFileSync('git', a, { cwd: scratch, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    try {
      g('init', '-q'); g('config', 'user.email', 't@example.invalid'); g('config', 'user.name', 'T');
      g('config', 'commit.gpgsign', 'false');
      fs.writeFileSync(path.join(scratch, 'README'), 'x\n');
      g('add', 'README'); g('commit', '-q', '-m', 'no ledger');
      const noLedger = g('rev-parse', 'HEAD');
      fs.mkdirSync(path.join(scratch, 'scripts'));
      fs.writeFileSync(path.join(scratch, LEDGER_REL), '{ broken');
      g('add', '--', LEDGER_REL); g('commit', '-q', '-m', 'broken ledger');
      const broken = g('rev-parse', 'HEAD');
      assert.equal(readRangeBaseLedger({ repoRoot: scratch, env: { AUDIT_PUSH_RANGE_BASE: noLedger } }).status, 'absent');
      assert.equal(readRangeBaseLedger({ repoRoot: scratch, env: { AUDIT_PUSH_RANGE_BASE: broken } }).status, 'malformed');
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});

/**
 * @fileoverview Unit tests for scripts/lib/debt-capture-trail.mjs — the pure
 * core that cross-checks round-ledger `ruling: 'defer'` entries against the
 * debt ledger. Tier 1 (deterministic seam) per AGENTS.md's testing doctrine:
 * crisp inputs/outputs, test-first.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  findRoundLedgers,
  readDeferredEntries,
  collectDebtIdentities,
  findUncapturedDeferrals,
  executeCheck,
} from '../scripts/lib/debt-capture-trail.mjs';

let tmpDir;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'debt-capture-trail-'));
});
afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* ignore */ }
});

function writeRoundLedger(name, entries) {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, JSON.stringify({ version: 1, entries }));
  return p;
}

describe('findRoundLedgers', () => {
  it('finds only *-ledger.json files, non-recursively', () => {
    writeRoundLedger('sid1-ledger.json', []);
    writeRoundLedger('sid2-ledger.json', []);
    fs.writeFileSync(path.join(tmpDir, 'tech-debt.json'), '{}'); // must NOT match
    fs.writeFileSync(path.join(tmpDir, 'notes.txt'), 'x');
    fs.mkdirSync(path.join(tmpDir, 'nested-ledger.json')); // a dir, not a file — must NOT match
    const found = findRoundLedgers(tmpDir).map((p) => path.basename(p));
    assert.deepEqual(found.sort(), ['sid1-ledger.json', 'sid2-ledger.json']);
  });

  it('returns [] for a missing directory rather than throwing', () => {
    assert.deepEqual(findRoundLedgers(path.join(tmpDir, 'does-not-exist')), []);
  });
});

describe('readDeferredEntries', () => {
  it('filters to ruling:defer only', () => {
    const p = writeRoundLedger('sid-ledger.json', [
      { topicId: 'a', ruling: 'defer' },
      { topicId: 'b', ruling: 'dismiss' },
      { topicId: 'c', ruling: 'defer' },
    ]);
    const { deferred, corrupt } = readDeferredEntries(p);
    assert.equal(corrupt, false);
    assert.deepEqual(deferred.map((e) => e.topicId), ['a', 'c']);
  });

  it('reports corrupt:true on invalid JSON without throwing', () => {
    const p = path.join(tmpDir, 'bad-ledger.json');
    fs.writeFileSync(p, '{not json');
    const result = readDeferredEntries(p);
    assert.equal(result.corrupt, true);
    assert.match(result.error, /./);
  });

  it('reports corrupt:true when entries array is missing', () => {
    const p = path.join(tmpDir, 'bad2-ledger.json');
    fs.writeFileSync(p, JSON.stringify({ version: 1 }));
    const result = readDeferredEntries(p);
    assert.equal(result.corrupt, true);
  });
});

describe('collectDebtIdentities', () => {
  it('collects topicId and contentAliases', () => {
    const ids = collectDebtIdentities([
      { topicId: 'a', contentAliases: ['a2', 'a3'] },
      { topicId: 'b', contentAliases: [] },
    ]);
    assert.deepEqual([...ids].sort(), ['a', 'a2', 'a3', 'b']);
  });

  it('handles an empty/undefined list', () => {
    assert.deepEqual([...collectDebtIdentities([])], []);
    assert.deepEqual([...collectDebtIdentities(undefined)], []);
  });
});

describe('findUncapturedDeferrals', () => {
  it('reports 0 uncaptured when every defer entry resolves', () => {
    const roundLedgers = [readDeferredEntries(writeRoundLedger('s1-ledger.json', [
      { topicId: 'a', ruling: 'defer', severity: 'HIGH' },
    ]))];
    const { uncaptured, deferredTotal } = findUncapturedDeferrals({
      roundLedgers,
      debtIdentities: new Set(['a']),
    });
    assert.equal(deferredTotal, 1);
    assert.deepEqual(uncaptured, []);
  });

  it('reports every defer entry with no matching debt identity', () => {
    const roundLedgers = [readDeferredEntries(writeRoundLedger('s1-ledger.json', [
      { topicId: 'a', ruling: 'defer', severity: 'HIGH', category: 'god-module', detailSnapshot: 'x' },
      { topicId: 'b', ruling: 'defer', severity: 'LOW' },
    ]))];
    const { uncaptured, deferredTotal } = findUncapturedDeferrals({
      roundLedgers,
      debtIdentities: new Set(['a']), // b is missing
    });
    assert.equal(deferredTotal, 2);
    assert.equal(uncaptured.length, 1);
    assert.equal(uncaptured[0].topicId, 'b');
    assert.equal(uncaptured[0].severity, 'LOW');
  });

  it('matches via contentAliases, not just topicId', () => {
    const roundLedgers = [readDeferredEntries(writeRoundLedger('s1-ledger.json', [
      { topicId: 'old-id', ruling: 'defer' },
    ]))];
    const { uncaptured } = findUncapturedDeferrals({
      roundLedgers,
      debtIdentities: new Set(['merged-id', 'old-id']), // captured under an alias
    });
    assert.deepEqual(uncaptured, []);
  });

  it('scans multiple round ledgers and aggregates deferredTotal', () => {
    const roundLedgers = [
      readDeferredEntries(writeRoundLedger('s1-ledger.json', [{ topicId: 'a', ruling: 'defer' }])),
      readDeferredEntries(writeRoundLedger('s2-ledger.json', [{ topicId: 'b', ruling: 'defer' }])),
    ];
    const { uncaptured, deferredTotal } = findUncapturedDeferrals({ roundLedgers, debtIdentities: new Set() });
    assert.equal(deferredTotal, 2);
    assert.equal(uncaptured.length, 2);
  });

  it('collects a corrupt ledger separately, without crashing the scan', () => {
    const good = readDeferredEntries(writeRoundLedger('s1-ledger.json', [{ topicId: 'a', ruling: 'defer' }]));
    const badPath = path.join(tmpDir, 's2-ledger.json');
    fs.writeFileSync(badPath, '{not json');
    const bad = readDeferredEntries(badPath);
    const { uncaptured, deferredTotal, corruptLedgers } = findUncapturedDeferrals({
      roundLedgers: [good, bad],
      debtIdentities: new Set(['a']),
    });
    assert.equal(deferredTotal, 1); // only from the good ledger
    assert.deepEqual(uncaptured, []);
    assert.equal(corruptLedgers.length, 1);
    assert.equal(corruptLedgers[0].path, badPath);
  });
});

describe('executeCheck', () => {
  it('ok:true when nothing deferred and nothing corrupt', () => {
    const result = executeCheck({ roundLedgers: [], debtLedgerAvailable: true, debtIdentities: new Set() });
    assert.equal(result.ok, true);
    assert.equal(result.deferredTotal, 0);
  });

  it('ok:false when any entry is uncaptured', () => {
    const roundLedgers = [readDeferredEntries(writeRoundLedger('s1-ledger.json', [
      { topicId: 'a', ruling: 'defer' },
    ]))];
    const result = executeCheck({ roundLedgers, debtLedgerAvailable: false, debtIdentities: new Set() });
    assert.equal(result.ok, false);
    assert.equal(result.debtLedgerAvailable, false);
    assert.equal(result.uncaptured.length, 1);
  });

  it('ok:false when a round ledger is corrupt, even if nothing is uncaptured', () => {
    const badPath = path.join(tmpDir, 's1-ledger.json');
    fs.writeFileSync(badPath, '{not json');
    const result = executeCheck({
      roundLedgers: [readDeferredEntries(badPath)],
      debtLedgerAvailable: true,
      debtIdentities: new Set(),
    });
    assert.equal(result.ok, false);
    assert.equal(result.corruptLedgers.length, 1);
  });
});

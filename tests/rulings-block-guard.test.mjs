/**
 * @fileoverview Defensive-guard tests for buildRulingsBlock (adjudication ledger).
 * A malformed/partial ledger entry (missing topicId, rationale, or affectedFiles)
 * must degrade gracefully — skip-and-warn or render with fallbacks — never throw
 * and take down an entire plan-audit R2 round. Mirrors the function's own
 * file-level graceful-degradation (missing file / parse error → '').
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { buildRulingsBlock } from '../scripts/lib/ledger.mjs';

let tmpDir;
let ledgerPath;

function writeLedger(entries) {
  fs.writeFileSync(ledgerPath, JSON.stringify({ entries }), 'utf-8');
}

function wellFormed(overrides = {}) {
  return {
    topicId: 'abcdef123456',
    pass: 'plan',
    adjudicationOutcome: 'dismissed',
    remediationState: 'pending',
    category: 'SOLID-SRP',
    rulingRationale: 'acceptable given the 2 consumers',
    affectedFiles: ['scripts/foo.mjs'],
    resolvedRound: 1,
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rulings-guard-'));
  ledgerPath = path.join(tmpDir, 'ledger.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe('buildRulingsBlock — malformed-entry defensive guards', () => {
  test('happy path still renders a well-formed dismissed entry', () => {
    writeLedger([wellFormed()]);
    const block = buildRulingsBlock(ledgerPath, 'plan');
    assert.match(block, /DISMISSED/);
    assert.match(block, /\[abcdef\]/); // topicId.slice(0,6)
    assert.match(block, /scripts\/foo\.mjs/);
  });

  test('an entry missing topicId is skipped, not thrown, and valid siblings survive', () => {
    writeLedger([
      wellFormed({ topicId: undefined, category: 'orphan' }), // the sharp edge
      wellFormed({ topicId: 'ffffff000000', category: 'kept' }),
    ]);
    let block;
    assert.doesNotThrow(() => { block = buildRulingsBlock(ledgerPath, 'plan'); });
    assert.match(block, /\[ffffff\]/);        // valid sibling rendered
    assert.doesNotMatch(block, /orphan/);     // malformed entry dropped
  });

  test('all entries malformed (no topicId) → empty string, no throw', () => {
    writeLedger([wellFormed({ topicId: undefined }), wellFormed({ topicId: '' })]);
    let block;
    assert.doesNotThrow(() => { block = buildRulingsBlock(ledgerPath, 'plan'); });
    assert.equal(block, '');
  });

  test('valid topicId but missing rulingRationale/affectedFiles renders without throwing', () => {
    writeLedger([wellFormed({ rulingRationale: undefined, affectedFiles: undefined })]);
    let block;
    assert.doesNotThrow(() => { block = buildRulingsBlock(ledgerPath, 'plan'); });
    assert.match(block, /\[abcdef\]/);
    assert.match(block, /Scope: /); // empty scope, but the line rendered
  });

  test('severity_adjusted + fixed entries with missing scope also survive', () => {
    writeLedger([
      wellFormed({ topicId: 'aaaaaa111111', adjudicationOutcome: 'severity_adjusted', originalSeverity: 'HIGH', severity: 'MEDIUM', affectedFiles: undefined }),
      wellFormed({ topicId: 'bbbbbb222222', adjudicationOutcome: 'accepted', remediationState: 'fixed', affectedFiles: null }),
    ]);
    let block;
    assert.doesNotThrow(() => { block = buildRulingsBlock(ledgerPath, 'plan'); });
    assert.match(block, /SEVERITY ADJUSTED/);
    assert.match(block, /FIXED/);
    assert.match(block, /HIGH→MEDIUM/); // adjusted line rendered
  });

  test('a non-object entry in the array does not throw', () => {
    writeLedger([null, wellFormed({ topicId: 'cccccc333333' })]);
    let block;
    assert.doesNotThrow(() => { block = buildRulingsBlock(ledgerPath, 'plan'); });
    assert.match(block, /\[cccccc\]/);
  });
});

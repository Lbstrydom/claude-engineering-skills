/**
 * R2+ Churn-Defense Regression Test
 *
 * Pins the invariant: when rulings are moved from system prompt → dynamic
 * user msg #2 (per the prompt-cache restructure), R2+ suppression accuracy
 * must NOT degrade.  Specifically: a finding paraphrased by GPT in R2
 * that semantically matches a prior R1 dismissal/severity-adjustment/fix
 * MUST be suppressed by `suppressReRaises()`.
 *
 * Fixture cases (tests/fixtures/r2-churn/):
 *   - r1-ledger.json: 3 R1-resolved entries (dismissed, fixed, severity_adjusted)
 *   - r2-findings.json: 4 R2 findings — 3 paraphrased re-raises + 1 genuinely new
 *
 * Expected: 3 suppressed (the re-raises), 1 kept (the new finding).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { suppressReRaises } from '../scripts/lib/ledger.mjs';

const FIXTURE_DIR = path.resolve(import.meta.dirname, 'fixtures/r2-churn');

const ledger = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'r1-ledger.json'), 'utf8'));
const findings = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'r2-findings.json'), 'utf8')).findings;

describe('R2+ churn-defense — paraphrased re-raises must be suppressed', () => {
  it('suppresses dismissed re-raise (style inconsistency)', () => {
    const { kept, suppressed } = suppressReRaises(findings, ledger);
    const styleSuppressed = suppressed.find(s => s.finding.id === 'M1');
    assert.ok(styleSuppressed, 'M1 (paraphrased "style inconsistency") MUST be suppressed — matches R1 dismissed entry abc123');
    assert.equal(styleSuppressed.matchedTopic?.includes('abc123') || styleSuppressed.matchedTopic === 'hard-suppress' || styleSuppressed.matchedSource === 'session', true,
      `expected match against R1 ledger entry, got ${JSON.stringify(styleSuppressed)}`);
  });

  it('suppresses fixed re-raise (auth middleware)', () => {
    const { suppressed } = suppressReRaises(findings, ledger);
    const authSuppressed = suppressed.find(s => s.finding.id === 'H1');
    assert.ok(authSuppressed, 'H1 (paraphrased auth-missing) MUST be suppressed — matches R1 fixed entry def456');
  });

  it('suppresses severity-adjusted re-raise (logging)', () => {
    const { suppressed } = suppressReRaises(findings, ledger);
    const loggingSuppressed = suppressed.find(s => s.finding.id === 'M2');
    assert.ok(loggingSuppressed, 'M2 (paraphrased logging-verbose) MUST be suppressed — matches R1 severity_adjusted entry ghi789');
  });

  it('keeps genuinely new finding (hardcoded config)', () => {
    const { kept } = suppressReRaises(findings, ledger);
    const newFinding = kept.find(f => f.id === 'M3');
    assert.ok(newFinding, 'M3 (genuinely new — hardcoded config) MUST be kept; no R1 entry matches');
  });

  it('overall: suppression rate matches expected (3 of 4)', () => {
    const { kept, suppressed } = suppressReRaises(findings, ledger);
    assert.equal(kept.length + suppressed.length, findings.length, 'kept + suppressed must equal total');
    assert.equal(suppressed.length, 3, `expected 3 suppressed (paraphrased re-raises), got ${suppressed.length}`);
    assert.equal(kept.length, 1, `expected 1 kept (the genuinely new finding), got ${kept.length}`);
  });
});

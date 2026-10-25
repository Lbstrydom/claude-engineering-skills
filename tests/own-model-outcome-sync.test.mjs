/**
 * @fileoverview outcome-sync hands the store the adjudicator kind and the
 * dismissal class (own-model telemetry gaps 2 and 3): the bulk producer of
 * adjudication events must never omit them. Runs in a scratch cwd because the
 * local outcome log is written relative to it.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('recordTriageOutcomes → recordAdjudicationEvent payload', () => {
  let recordTriageOutcomes;
  before(async () => {
    process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'omt-outcome-')));
    ({ recordTriageOutcomes } = await import('../scripts/lib/outcome-sync.mjs'));
  });

  const finding = (id, extra = {}) => ({
    id, severity: 'HIGH', category: `cat-${id}`, section: `sec-${id}`, detail: `detail ${id}`,
    _pass: 'structure', _hash: `hash-${id}`, ...extra,
  });

  it('passes kind "pipeline" always and the ledger class (or "unclassified") for a dismissal only', async () => {
    const calls = [];
    const store = { recordAdjudicationEvent: async (runId, fp, ev) => { calls.push({ fp, ev }); return { ok: true }; } };
    const findings = [finding('H1'), finding('M1'), finding('M2')];
    const { generateTopicId } = await import('../scripts/lib/ledger.mjs');
    const entry = (f, over) => ({
      topicId: generateTopicId(f), latestFindingId: f.id, adjudicationOutcome: 'accepted',
      remediationState: 'pending', ruling: 'sustain', ...over,
    });
    const ledger = { entries: [
      entry(findings[0], {}),
      entry(findings[1], { adjudicationOutcome: 'dismissed', ruling: 'overrule', dismissReasonClass: 'false-positive' }),
      entry(findings[2], { adjudicationOutcome: 'dismissed', ruling: 'overrule' }),
    ] };
    await recordTriageOutcomes(store, 'run-1', findings, ledger, { round: 1 });
    const by = Object.fromEntries(calls.map((c) => [c.fp, c.ev]));
    assert.equal(calls.length, 3);
    for (const ev of Object.values(by)) assert.equal(ev.adjudicatorKind, 'pipeline');
    assert.equal(by['hash-H1'].dismissReasonClass, undefined, 'an acceptance carries no dismissal class');
    assert.equal(by['hash-M1'].dismissReasonClass, 'false-positive');
    assert.equal(by['hash-M2'].dismissReasonClass, 'unclassified', 'absent is explicit, never NULL and never a silent "other"');
  });
});

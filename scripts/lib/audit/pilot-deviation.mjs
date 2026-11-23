/**
 * @fileoverview The signed DEVIATION record for Pilot 1 (docs/experiments/seeded-bench/deviation-1-t1-only.json): the pilot is re-frozen as
 * T1-only, and the calibration report of the OLD dataset is bridged to the NEW one explicitly. Like amendment 2 it is bound to its approval by a
 * content digest, so changing the scope or the bridge is a reviewed code change, never a quiet file edit.
 *
 * Domain: audit-orchestration.
 *
 * @module scripts/lib/audit/pilot-deviation
 */
import fs from 'node:fs';
import { canonicalSha256 } from './pilot-novelty-audit.mjs';
import { SEEDED_BENCH_EPOCH } from './meta-pilot-decision.mjs';

/** The approved content of deviation 1. A new freeze (a new dataset hash) is a new deviation: this digest then changes with it. */
export const DEVIATION_1_SHA256 = '131853c4ddaf7de3229e5521ada8f5b2280e569448699a911302ccef696d40e4';

/** Load and validate the deviation against ONE dataset and ONE calibration report. */
export function readDeviation(file, { dataset, calibration, digest = DEVIATION_1_SHA256, readText = (p) => fs.readFileSync(p, 'utf8') }) {
  let d; try { d = JSON.parse(readText(file)); } catch (err) { throw new Error(`deviation ${file} unreadable (${err?.message})`); }
  const bad = [];
  if (d.epoch !== SEEDED_BENCH_EPOCH) bad.push(`epoch is ${d.epoch}, expected ${SEEDED_BENCH_EPOCH}`);
  if (d.deviation !== 1 || d.scope !== 'T1-only') bad.push('not deviation 1 / T1-only');
  if (!d.signature?.signedBy || !d.signature?.signedAt || !d.signature?.signedWords || !d.signature?.condition) bad.push('signature incomplete');
  if (canonicalSha256(d) !== digest) bad.push('its content digest does not match the approved deviation (a change needs a reviewed code change to DEVIATION_1_SHA256)');
  if (!bad.length) {
    if (d.bridge?.toDatasetHash !== dataset.datasetHash) bad.push('the deviation was made for a different dataset (toDatasetHash)');
    if (d.bridge?.fromDatasetHash !== calibration.datasetHash) bad.push('the calibration report is not the one this deviation bridges (fromDatasetHash)');
    if (d.bridge?.fromReportSha256 !== canonicalSha256(calibration)) bad.push('the calibration report content is not the one this deviation bridges (fromReportSha256)');
    if (dataset.scope !== 'T1-only' || dataset.deviation !== 'deviation-1') bad.push('the dataset is not the T1-only freeze');
  }
  if (bad.length) throw new Error(`deviation ${file} is not valid: ${bad.join('; ')}`);
  return d;
}

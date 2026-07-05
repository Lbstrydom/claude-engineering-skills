import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreArms } from '../scripts/lib/solo-control/scoring.mjs';

test('collapse: xN repeated rows in one human_cluster count ONCE (R2-H2)', () => {
  const rows = [
    { arm: 'S-x3', commit: 'c1', severity: 'HIGH', label: 'proven', humanCluster: 'k1' },
    { arm: 'S-x3', commit: 'c1', severity: 'HIGH', label: 'proven', humanCluster: 'k1' },
    { arm: 'S-x3', commit: 'c1', severity: 'HIGH', label: 'proven', humanCluster: 'k1' },
  ];
  const s = scoreArms(rows, { apparatusArm: 'A' });
  assert.equal(s.arms['S-x3'].totalItems, 1);   // collapsed
  assert.equal(s.arms['S-x3'].value, 8);        // counted once (HIGH proven = 8)
  assert.equal(s.arms['S-x3'].repetitionBurden, 3); // 3 raw / 1 item
});

test('precision denominator includes plausible + false (R2-M2)', () => {
  const rows = [
    { arm: 'X', commit: 'c1', severity: 'HIGH', label: 'proven', humanCluster: 'a' },   // value 8, weight 8
    { arm: 'X', commit: 'c1', severity: 'HIGH', label: 'plausible', humanCluster: 'b' }, // value 0, weight 8
    { arm: 'X', commit: 'c1', severity: 'HIGH', label: 'plausible', humanCluster: 'c' }, // value 0, weight 8
  ];
  const s = scoreArms(rows, {});
  // precision = 8 / (8+8+8) = 0.333 — plausible flooding is penalized
  assert.equal(s.arms['X'].precision, 0.333);
});

test('eligibility: false-rate > 0.33 → ineligible; noise-rate > 0.5 → ineligible', () => {
  const falsey = [
    { arm: 'F', commit: 'c', severity: 'LOW', label: 'proven', humanCluster: '1' },
    { arm: 'F', commit: 'c', severity: 'LOW', label: 'false', humanCluster: '2' },
    { arm: 'F', commit: 'c', severity: 'LOW', label: 'false', humanCluster: '3' },
  ];
  assert.equal(scoreArms(falsey, {}).arms['F'].eligible, false);
  assert.equal(scoreArms(falsey, {}).arms['F'].ineligibleReason, 'false-rate>0.33');

  const noisy = [
    { arm: 'N', commit: 'c', severity: 'LOW', label: 'proven', humanCluster: '1' },
    { arm: 'N', commit: 'c', severity: 'LOW', label: 'plausible', humanCluster: '2' },
    { arm: 'N', commit: 'c', severity: 'LOW', label: 'plausible', humanCluster: '3' },
  ];
  assert.equal(scoreArms(noisy, {}).arms['N'].eligible, false);   // 2/3 noise > 0.5
});

test('underpowered arm → eligible:false (R2-M4)', () => {
  const rows = [{ arm: 'S-x3', commit: 'c', severity: 'HIGH', label: 'proven', humanCluster: '1' }];
  const s = scoreArms(rows, { underpowered: ['S-x3'] });
  assert.equal(s.arms['S-x3'].eligible, false);
  assert.equal(s.arms['S-x3'].ineligibleReason, 'underpowered');
});

test('known-defect recall = distinct KD linked to an accepted item', () => {
  const rows = [
    { arm: 'A', commit: 'c1', severity: 'HIGH', label: 'proven', humanCluster: '1', matches: 'KD-001' },
    { arm: 'A', commit: 'c2', severity: 'HIGH', label: 'proven', humanCluster: '2', matches: 'KD-002' },
    { arm: 'S', commit: 'c1', severity: 'HIGH', label: 'proven', humanCluster: '3', matches: 'KD-001' },
    { arm: 'S', commit: 'c2', severity: 'MEDIUM', label: 'false', humanCluster: '4', matches: 'KD-002' }, // false → not recalled
  ];
  const kd = [{ id: 'KD-001' }, { id: 'KD-002' }];
  const s = scoreArms(rows, { knownDefects: kd });
  assert.equal(s.arms['A'].knownDefectRecall, 1);      // 2/2
  assert.equal(s.arms['S'].knownDefectRecall, 0.5);    // 1/2 (KD-002 only via a false → not counted)
});

test('matchesApparatus: eligible + value >= 0.9*apparatus + kd-recall >= apparatus', () => {
  const rows = [
    { arm: 'A', commit: 'c', severity: 'HIGH', label: 'proven', humanCluster: '1', matches: 'KD-1' },
    { arm: 'S', commit: 'c', severity: 'HIGH', label: 'proven', humanCluster: '2', matches: 'KD-1' },
  ];
  const s = scoreArms(rows, { knownDefects: [{ id: 'KD-1' }], apparatusArm: 'A' });
  assert.equal(s.arms['S'].matchesApparatus, true);  // equal value + equal recall
  assert.equal(s.arms['A'].matchesApparatus, null);  // the apparatus vs itself
});

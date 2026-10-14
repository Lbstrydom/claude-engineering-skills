import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SUITE_RUN_SCHEMA, SUITE_RUN_MAX_AGE_DAYS, SUITE_RUN_CLOCK_SKEW_MS, recordSuiteRun, suiteRunPath, suiteRunKind, writeSuiteRunRecord, readSuiteRunRecord, coreCount,
} from '../scripts/lib/suite-run-record.mjs';

const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-run-')); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const rec = (over = {}) => ({
  schema: SUITE_RUN_SCHEMA, kind: 'full', wallMs: 562_830, files: 949, finishedAt: '2026-10-14T10:00:00.000Z', head: 'a'.repeat(40), cores: 32, platform: 'win32', ...over,
});
const NOW = new Date('2026-10-14T12:00:00.000Z');

describe('suite-run-record: the kind a run earns', () => {
  const none = { preflight: false, tierSkip: null, userArgs: [] };
  it('the default set is full', () => assert.equal(suiteRunKind(none), 'full'));
  it('a tier-skip run is branch', () => assert.equal(suiteRunKind({ ...none, tierSkip: { skipped: [] } }), 'branch'));
  it('a preflight is never a record', () => assert.equal(suiteRunKind({ ...none, preflight: true }), null));
  it('a preflight beats a tier-skip', () => assert.equal(suiteRunKind({ ...none, preflight: true, tierSkip: {} }), null));
  it('a caller-narrowed run is not the suite', () => assert.equal(suiteRunKind({ ...none, userArgs: ['tests/a.test.mjs'] }), null));
  it('narrowing beats a tier-skip: a narrowed tier run is not the branch tier', () => {
    assert.equal(suiteRunKind({ ...none, tierSkip: { skipped: [] }, userArgs: ['tests/a.test.mjs'] }), null);
  });
});

describe('suite-run-record: round trip and the unmeasured paths', () => {
  it('writes and reads back as a measured, lower-bound test-step duration', () => {
    const dir = tmp();
    writeSuiteRunRecord(dir, rec());
    const r = readSuiteRunRecord(dir, 'full', NOW);
    assert.equal(r.measured, true);
    assert.equal(r.value.ms, 562_830);
    assert.equal(r.value.workloadKind, 'full-suite');
    assert.equal(r.value.timingBasis, 'test-step');
    assert.equal(r.value.origin, 'this-repo-local');
    assert.equal(r.value.cores, 32);
  });
  it('a branch record reads as branch-tier', () => {
    const dir = tmp();
    writeSuiteRunRecord(dir, rec({ kind: 'branch' }));
    assert.equal(readSuiteRunRecord(dir, 'branch', NOW).value.workloadKind, 'branch-tier');
  });
  it('a missing record is unmeasured with a remedy, never a zero', () => {
    const r = readSuiteRunRecord(tmp(), 'full', NOW);
    assert.equal(r.measured, false);
    assert.match(r.why, /no suite-run full record/);
    assert.equal('value' in r, false);
  });
  it('no common dir is unmeasured', () => assert.equal(readSuiteRunRecord(null, 'full', NOW).measured, false));
  it('invalid JSON is unmeasured', () => {
    const dir = tmp(); fs.mkdirSync(path.join(dir, 'suite-runs'));
    fs.writeFileSync(suiteRunPath(dir, 'full'), '{nope');
    assert.match(readSuiteRunRecord(dir, 'full', NOW).why, /not JSON/);
  });
  it('a schema-invalid record is unmeasured', () => {
    const dir = tmp(); fs.mkdirSync(path.join(dir, 'suite-runs'));
    fs.writeFileSync(suiteRunPath(dir, 'full'), JSON.stringify({ ...rec(), wallMs: -1 }));
    assert.match(readSuiteRunRecord(dir, 'full', NOW).why, /invalid/);
  });
  it('an unknown extra key is invalid (strict)', () => {
    const dir = tmp(); fs.mkdirSync(path.join(dir, 'suite-runs'));
    fs.writeFileSync(suiteRunPath(dir, 'full'), JSON.stringify({ ...rec(), extra: 1 }));
    assert.equal(readSuiteRunRecord(dir, 'full', NOW).measured, false);
  });
  it('a branch record filed under full is a kind mismatch, not a full measurement', () => {
    const dir = tmp(); fs.mkdirSync(path.join(dir, 'suite-runs'));
    fs.writeFileSync(suiteRunPath(dir, 'full'), JSON.stringify(rec({ kind: 'branch' })));
    assert.match(readSuiteRunRecord(dir, 'full', NOW).why, /kind mismatch/);
  });
  it('a record older than the max age is unmeasured, naming its age', () => {
    const dir = tmp();
    writeSuiteRunRecord(dir, rec({ finishedAt: '2026-09-01T00:00:00.000Z' }));
    const r = readSuiteRunRecord(dir, 'full', NOW);
    assert.equal(r.measured, false);
    assert.match(r.why, new RegExp(`older than ${SUITE_RUN_MAX_AGE_DAYS} d`));
  });
  it('a record dated beyond the clock-skew tolerance is unmeasured, not trusted forever', () => {
    const dir = tmp();
    writeSuiteRunRecord(dir, rec({ finishedAt: new Date(NOW.getTime() + SUITE_RUN_CLOCK_SKEW_MS + 60_000).toISOString() }));
    assert.match(readSuiteRunRecord(dir, 'full', NOW).why, /dated in the future/);
  });
  it('a record inside the skew tolerance is accepted, and its age is not clamped', () => {
    const dir = tmp();
    writeSuiteRunRecord(dir, rec({ finishedAt: new Date(NOW.getTime() + 60_000).toISOString() }));
    const r = readSuiteRunRecord(dir, 'full', NOW);
    assert.equal(r.measured, true);
    assert.ok(r.value.ageMs < 0);
  });
  it('the freshness boundary: 29 d old is measured, 31 d old is not', () => {
    const dir = tmp();
    writeSuiteRunRecord(dir, rec({ finishedAt: new Date(NOW.getTime() - 29 * 86_400_000).toISOString() }));
    assert.equal(readSuiteRunRecord(dir, 'full', NOW).measured, true);
    writeSuiteRunRecord(dir, rec({ finishedAt: new Date(NOW.getTime() - 31 * 86_400_000).toISOString() }));
    assert.equal(readSuiteRunRecord(dir, 'full', NOW).measured, false);
  });
  it('an invalid duration is refused with a note, never clamped to a zero measurement', () => {
    for (const wallMs of [-5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const dir = tmp();
      const r = recordSuiteRun({ preflight: false, tierSkip: null, userArgs: [], exitCode: 0, wallMs, cwd: dir, commonDirOf: () => dir });
      assert.equal(r.written, false);
      assert.match(r.note, /invalid duration/);
      assert.equal(fs.existsSync(path.join(dir, 'suite-runs')), false);
    }
  });
  it('the writer refuses an invalid record rather than filing it', () => {
    assert.throws(() => writeSuiteRunRecord(tmp(), rec({ wallMs: 1.5 })));
    assert.throws(() => suiteRunPath('/x', 'nightly'));
  });
  it('coreCount is a positive integer', () => assert.ok(Number.isInteger(coreCount()) && coreCount() > 0));
});

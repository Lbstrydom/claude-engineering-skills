/**
 * @fileoverview The one reader of `run-tests/v1 failed-files:` (plan ship-trains §2.10a, R1 M3). The CI flake
 * classifier's own suite (`ci-flake-rerun.test.mjs`) is the regression for the reader that now delegates here.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { FAILED_FILES_MARKER, parseFailedFilesPayload } from '../scripts/lib/failed-files-marker.mjs';
import { failedFilesLine } from '../scripts/run-tests.mjs';
import { GUARD_REPORT_VERSION } from '../scripts/lib/test-guard-reporter.mjs';
import path from 'node:path';

describe('parseFailedFilesPayload', () => {
  test('unknown', () => assert.deepEqual(parseFailedFilesPayload(' unknown '), { kind: 'unknown' }));
  test('a file list, and the empty list, are files', () => {
    assert.deepEqual(parseFailedFilesPayload('["tests/a.test.mjs","tests/b.test.mjs"]'), { kind: 'files', files: ['tests/a.test.mjs', 'tests/b.test.mjs'] });
    assert.deepEqual(parseFailedFilesPayload('[]'), { kind: 'files', files: [] });
  });
  test('a non-string or empty entry, an object and non-JSON are malformed, with the raw text kept', () => {
    assert.equal(parseFailedFilesPayload('[1,2]').kind, 'malformed');
    assert.equal(parseFailedFilesPayload('[""]').kind, 'malformed');
    assert.equal(parseFailedFilesPayload('{"a":1}').kind, 'malformed');
    assert.deepEqual(parseFailedFilesPayload('not json'), { kind: 'malformed', raw: 'not json' });
    assert.equal(parseFailedFilesPayload('x'.repeat(200)).raw.length, 80);
  });
  test('round-trips the lines run-tests actually prints (files, and unknown)', () => {
    const root = path.resolve('/repo');
    const report = JSON.stringify({ version: GUARD_REPORT_VERSION, failures: [{ file: path.join(root, 'tests', 'z.test.mjs'), name: 'n' }] });
    const line = failedFilesLine(report, root);
    assert.ok(line.startsWith(FAILED_FILES_MARKER));
    assert.deepEqual(parseFailedFilesPayload(line.slice(FAILED_FILES_MARKER.length)), { kind: 'files', files: ['tests/z.test.mjs'] });
    assert.deepEqual(parseFailedFilesPayload(failedFilesLine(null, root).slice(FAILED_FILES_MARKER.length)), { kind: 'unknown' });
  });
});

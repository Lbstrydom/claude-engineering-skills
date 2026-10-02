/**
 * @fileoverview `applyRotation` — the write phase of status.md rotation.
 *
 * The conservation proof runs before anything is written, but the write phase
 * itself mutates three durable files in sequence: the month archives, the
 * manifest, then the truncated root log. A plain `fs.writeFileSync` truncates
 * its target and then writes, so a crash (or a disk-full error) partway through
 * the ROOT LOG write left `status.md` torn — the retained entries cut off in the
 * working tree, with only git (and only the committed part) to recover them.
 * PR #87 destroyed 19,257 lines of this file; this is the cheap half of making
 * that unrepeatable.
 *
 * The contract pinned here: whichever write fails, every file is EITHER its old
 * content OR its complete new content — never a torn prefix.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { applyRotation } from '../scripts/rotate-status-log.mjs';

const ROOT_OLD = '# Status\n\n## 2026-09-30 — new\nkeep me\n\n## 2026-08-01 — old\narchive me\n';
const ROOT_NEW = '# Status\n\n## 2026-09-30 — new\nkeep me\n';
const ARCHIVE_BODY = '## 2026-08-01 — old\narchive me\n';

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rotate-status-'));
  fs.writeFileSync(path.join(repo, 'status.md'), ROOT_OLD);
  return repo;
}

const args = (repo) => ({
  repo,
  archives: [{ month: '2026-08', path: 'docs/status/2026-08.md', body: ARCHIVE_BODY }],
  rootBody: ROOT_NEW,
});

test('happy path: archive, manifest and the truncated root log are all written', () => {
  const repo = makeRepo();
  try {
    assert.deepEqual(applyRotation(args(repo)), { ok: true });
    assert.equal(fs.readFileSync(path.join(repo, 'status.md'), 'utf-8'), ROOT_NEW);
    assert.equal(fs.readFileSync(path.join(repo, 'docs/status/2026-08.md'), 'utf-8'), ARCHIVE_BODY);
    const manifest = JSON.parse(fs.readFileSync(path.join(repo, 'docs/status/rotation-manifest.json'), 'utf-8'));
    assert.equal(manifest.archives['2026-08'].entries, 1);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('an existing archive with different content is refused before anything is written', () => {
  const repo = makeRepo();
  try {
    fs.mkdirSync(path.join(repo, 'docs/status'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'docs/status/2026-08.md'), 'something else\n');
    assert.deepEqual(applyRotation(args(repo)), { ok: false, collisions: ['docs/status/2026-08.md'] });
    assert.equal(fs.readFileSync(path.join(repo, 'status.md'), 'utf-8'), ROOT_OLD, 'root log untouched');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

describe('a write that dies partway leaves no torn file', () => {
  for (const victim of ['status.md', 'docs/status/2026-08.md', 'docs/status/rotation-manifest.json']) {
    test(`a crash while writing ${victim}`, (t) => {
      const repo = makeRepo();
      const target = path.resolve(repo, victim);
      const realWrite = fs.writeFileSync;
      // Simulate the crash at the byte level: half the data lands in the file
      // the write was aimed at, then the process "dies".
      t.mock.method(fs, 'writeFileSync', (file, data, opts) => {
        if (typeof file === 'string' && path.resolve(file) === target) {
          realWrite(file, String(data).slice(0, Math.floor(String(data).length / 2)), opts);
          throw Object.assign(new Error('simulated crash mid-write'), { code: 'ENOSPC' });
        }
        return realWrite(file, data, opts);
      });
      try {
        try { applyRotation(args(repo)); } catch { /* the crash */ }
        t.mock.restoreAll();

        const read = (rel) => {
          const p = path.join(repo, rel);
          return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null;
        };
        const root = read('status.md');
        assert.ok(root === ROOT_OLD || root === ROOT_NEW, `status.md is torn: ${JSON.stringify(root)}`);
        const archive = read('docs/status/2026-08.md');
        assert.ok(archive === null || archive === ARCHIVE_BODY, `archive is torn: ${JSON.stringify(archive)}`);
        const manifest = read('docs/status/rotation-manifest.json');
        assert.ok(manifest === null || (() => { try { JSON.parse(manifest); return true; } catch { return false; } })(),
          `manifest is torn: ${JSON.stringify(manifest)}`);
        // And no history was lost: the archived entry is still SOMEWHERE whole.
        assert.ok(root === ROOT_OLD || archive === ARCHIVE_BODY, 'the archived entry exists whole in at least one file');
      } finally {
        t.mock.restoreAll();
        fs.rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      }
    });
  }
});

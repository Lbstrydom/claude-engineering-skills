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
  // applyRotation writes through atomicWriteFileSync: a `.tmp-<pid>-<ts>` sibling
  // first, then a rename onto the final name. A fault injected at the FINAL path
  // never fires (nothing writes there directly), which is how an earlier version
  // of this test passed while testing nothing — so each case injects at a stage
  // the atomic writer really has, and asserts the fault was actually reached.
  // The three writes happen in this order, so the Nth temp write IS that file.
  const VICTIMS = [
    { rel: 'docs/status/2026-08.md', nth: 1, old: null },
    { rel: 'docs/status/rotation-manifest.json', nth: 2, old: null },
    { rel: 'status.md', nth: 3, old: ROOT_OLD },
  ];
  const isTemp = (file) => typeof file === 'string' && path.basename(file).startsWith('.tmp-');
  const crash = () => Object.assign(new Error('simulated crash mid-write'), { code: 'ENOSPC' });

  const readIfAny = (repo, rel) => {
    const p = path.join(repo, rel);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null;
  };
  const leftoverTemps = (repo) => [repo, path.join(repo, 'docs', 'status')]
    .filter((d) => fs.existsSync(d))
    .flatMap((d) => fs.readdirSync(d).filter((n) => n.startsWith('.tmp-')));

  for (const stage of ['temp write', 'rename']) {
    for (const victim of VICTIMS) {
      test(`a crash at the ${stage} of ${victim.rel}`, (t) => {
        const repo = makeRepo();
        const target = path.resolve(repo, victim.rel);
        const realWrite = fs.writeFileSync;
        let fired = false;
        let tempWrites = 0;
        if (stage === 'temp write') {
          // Half the bytes land in the temp file, then the process "dies".
          t.mock.method(fs, 'writeFileSync', (file, data, opts) => {
            if (isTemp(file) && ++tempWrites === victim.nth) {
              fired = true;
              realWrite(file, String(data).slice(0, Math.floor(String(data).length / 2)), opts);
              throw crash();
            }
            return realWrite(file, data, opts);
          });
        } else {
          const realRename = fs.renameSync;
          t.mock.method(fs, 'renameSync', (from, to) => {
            if (path.resolve(to) === target) { fired = true; throw crash(); }
            return realRename(from, to);
          });
        }
        try {
          let thrown = null;
          try { applyRotation(args(repo)); } catch (err) { thrown = err; }
          t.mock.restoreAll();

          // Vacuous-pass guard: the fault must have been reached, and must have
          // stopped the rotation. Without these, a never-firing mock reads as
          // "no file was torn".
          assert.ok(fired, `the injected fault at the ${stage} of ${victim.rel} was never reached`);
          assert.equal(thrown?.code, 'ENOSPC', 'applyRotation must surface the failed write, not swallow it');

          assert.equal(readIfAny(repo, victim.rel), victim.old, `${victim.rel} must be exactly its OLD content, never a torn prefix`);
          assert.deepEqual(leftoverTemps(repo), [], 'the half-written temp file is cleaned up');

          const root = readIfAny(repo, 'status.md');
          const archive = readIfAny(repo, 'docs/status/2026-08.md');
          const manifest = readIfAny(repo, 'docs/status/rotation-manifest.json');
          assert.ok(root === ROOT_OLD || root === ROOT_NEW, `status.md is torn: ${JSON.stringify(root)}`);
          assert.ok(archive === null || archive === ARCHIVE_BODY, `archive is torn: ${JSON.stringify(archive)}`);
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
  }
});

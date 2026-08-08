/**
 * @fileoverview Retention of final-review transcripts across `audit:clean`.
 *
 * The defect this guards: `.audit/*-transcript.json` matched a TRANSIENT
 * pattern with no exemption, so the 14-day sweep deleted the only replayable
 * input a reviewer/model comparison has. The closed final-review shadow A/B
 * spent $50.90 and left nothing to replay; the Kimi bake-off then ran on a
 * single surviving transcript. Retention alone is not the fix either — kept
 * forever, `.audit/` grows without bound — so the contract under test is
 * BOUNDED retention: newest-N survives at any age, the tail is still pruned.
 *
 * Two tiers, mirroring audit-clean-traversal.test.mjs: the SPLIT is unit-tested
 * in-process, the DELETION SINK is driven through the real CLI in a subprocess,
 * because only the sink can prove a file survived on disk.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { splitRetained, _internals } from '../scripts/audit-clean.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, '..', 'scripts', 'audit-clean.mjs');

const tmpDirs = [];
function mkTmp(label) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `audit-clean-ret-${label}-`));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best-effort */ }
  }
});

/** Write `p` with an mtime `ageDays` in the past. */
function agedFile(p, ageDays, content = 'x') {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  const t = new Date(Date.now() - ageDays * 86400000);
  fs.utimesSync(p, t, t);
  return p;
}

describe('audit-clean — transcript retention', () => {
  describe('splitRetained (the window)', () => {
    const rec = (p, ageDays) => ({ p, bytes: 1, mtimeMs: Date.now() - ageDays * 86400000 });

    it('keeps the newest N at ANY age, and prunes only the aged tail', () => {
      const cutoff = Date.now() - 14 * 86400000;
      const found = [rec('a', 200), rec('b', 100), rec('c', 50), rec('d', 1)];
      const { retained, deletable } = splitRetained(found, 2, cutoff);

      // 'd' (1d) and 'c' (50d) are the two newest — 'c' survives DESPITE being
      // 36 days past the cutoff. That is the whole point of the window.
      assert.deepEqual(retained.map((r) => r.p), ['d', 'c']);
      assert.deepEqual(deletable.map((r) => r.p), ['b', 'a']);
    });

    it('does not delete beyond the window when the tail is still young', () => {
      const cutoff = Date.now() - 14 * 86400000;
      const found = [rec('a', 3), rec('b', 2), rec('c', 1)];
      const { retained, deletable } = splitRetained(found, 1, cutoff);
      assert.deepEqual(retained.map((r) => r.p), ['c']);
      // 'a' and 'b' fall outside the window but are younger than the age gate —
      // the window is a retention floor, never a deletion trigger of its own.
      assert.deepEqual(deletable, []);
    });

    it('breaks mtime ties by path, so the retained set is not readdir-ordered', () => {
      const now = Date.now();
      const same = (p) => ({ p, bytes: 1, mtimeMs: now });
      const a = splitRetained([same('x'), same('b'), same('m')], 1, now - 1);
      const b = splitRetained([same('m'), same('x'), same('b')], 1, now - 1);
      assert.deepEqual(a.retained.map((r) => r.p), b.retained.map((r) => r.p));
    });
  });

  describe('TRANSIENT pattern coverage', () => {
    const entry = _internals.TRANSIENT.find((t) => t.keepNewest);

    it('is declared on the transcript class, and nowhere else', () => {
      assert.ok(entry, 'no retained class declared');
      assert.equal(_internals.TRANSIENT.filter((t) => t.keepNewest).length, 1);
      assert.ok(entry.re.test('audit-code-1785428132-transcript.json'));
    });

    it('matches the re-review and mode-suffixed variants', () => {
      // These never matched `-transcript\.json$`, so they were pruned by
      // NOTHING and grew without bound — the cap only bounds what it matches.
      assert.ok(entry.re.test('audit-plan-1784283000-transcript-v2.json'));
      assert.ok(entry.re.test('cycle-union-r2-transcript.json'));
      assert.ok(entry.re.test('audit-code-undo-1785138000-transcript-code.json'));
    });

    it('does not swallow neighbouring artifacts', () => {
      assert.equal(entry.re.test('union-gemini-r2.json'), false);
      assert.equal(entry.re.test('audit-code-1785428132-gemini-result.json'), false);
      assert.equal(entry.re.test('session-ledger.json'), false);
    });
  });

  describe('CLI sink (proves survival on disk)', () => {
    it('leaves an aged transcript inside the window on disk, and says so', () => {
      const root = mkTmp('sink');
      const audit = path.join(root, '.audit');
      const transcript = agedFile(path.join(audit, 'audit-code-999-transcript.json'), 90);
      // A neighbouring intermediate of the SAME age is the negative control: if
      // it also survived, the test would be passing on a broken sweep (nothing
      // deleted at all) rather than on retention.
      const ledger = agedFile(path.join(audit, 'audit-code-999-ledger.json'), 90);

      const r = spawnSync(process.execPath, [CLI, '--apply'], { cwd: root, encoding: 'utf8' });

      assert.equal(r.status, 0, r.stderr);
      assert.ok(fs.existsSync(transcript), 'transcript was deleted — retention did not hold');
      assert.equal(fs.existsSync(ledger), false, 'ledger survived — the sweep did not run at all');
      assert.match(r.stdout, /retained 1 replay input/);
    });

    it('prunes the aged tail once the window overflows', () => {
      const root = mkTmp('overflow');
      const audit = path.join(root, '.audit');
      const keep = _internals.TRANSIENT.find((t) => t.keepNewest).keepNewest;
      // keep + 2 transcripts, all past the age gate, newest first by index.
      const paths = [];
      for (let i = 0; i < keep + 2; i++) {
        paths.push(agedFile(path.join(audit, `audit-code-${String(i).padStart(3, '0')}-transcript.json`), 30 + i));
      }

      const r = spawnSync(process.execPath, [CLI, '--apply'], { cwd: root, encoding: 'utf8' });

      assert.equal(r.status, 0, r.stderr);
      const survivors = paths.filter((p) => fs.existsSync(p));
      assert.equal(survivors.length, keep, `expected exactly ${keep} survivors, got ${survivors.length}`);
      // The two OLDEST are the ones that went.
      assert.equal(fs.existsSync(paths[keep]), false);
      assert.equal(fs.existsSync(paths[keep + 1]), false);
    });
  });
});

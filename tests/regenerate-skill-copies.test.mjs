/**
 * @fileoverview `--dry-run` must not touch the filesystem.
 *
 * The bug this guards (2026-07-20): copyFileIfChanged and syncSkillToDests both
 * ran `fs.mkdirSync` UNCONDITIONALLY, ahead of the `opts.dryOrCheck` branch. So
 * `regenerate-skill-copies.mjs --keep-github-skills --dry-run` materialised 31
 * empty `.github/skills/<name>/` directories, which then hard-failed
 * `check-stale-skill-surface --gate` (a `.github/skills` tree shadows
 * `.claude/skills` for Copilot). A safety flag that still mutates the
 * filesystem is the same defect class as one that gets silently dropped — the
 * operator asked to be SHOWN, and the tool did something. mkdir now lives on
 * the write path only; this pins it.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { _internals } from '../scripts/regenerate-skill-copies.mjs';

const { copyFileIfChanged } = _internals;

let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'regen-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

describe('copyFileIfChanged — --dry-run creates nothing', () => {
  it('dryOrCheck does NOT mkdir the destination parent', () => {
    const src = path.join(tmp, 'src.md');
    fs.writeFileSync(src, 'hello');
    // A destination whose parent directory does not exist yet.
    const dst = path.join(tmp, 'brand', 'new', 'dir', 'out.md');

    const result = copyFileIfChanged(src, dst, { dryOrCheck: true });

    assert.equal(result, 'wrote', 'it still REPORTS the pending write (a create)');
    assert.equal(fs.existsSync(path.dirname(dst)), false, 'but must not have created the directory');
    assert.equal(fs.existsSync(dst), false, 'and must not have written the file');
  });

  it('the write path DOES mkdir + write (the fix did not disable real writes)', () => {
    const src = path.join(tmp, 'src.md');
    fs.writeFileSync(src, 'hello');
    const dst = path.join(tmp, 'brand', 'new', 'dir', 'out.md');

    const result = copyFileIfChanged(src, dst, { dryOrCheck: false });

    assert.equal(result, 'wrote');
    assert.equal(fs.existsSync(dst), true, 'the parent was created and the file written');
    assert.equal(fs.readFileSync(dst, 'utf-8'), 'hello');
  });

  it('an identical destination is unchanged in BOTH modes (no write, no mkdir)', () => {
    const src = path.join(tmp, 'src.md');
    const dst = path.join(tmp, 'out.md');
    fs.writeFileSync(src, 'same');
    fs.writeFileSync(dst, 'same');
    assert.equal(copyFileIfChanged(src, dst, { dryOrCheck: true }), 'unchanged');
    assert.equal(copyFileIfChanged(src, dst, { dryOrCheck: false }), 'unchanged');
  });
});

describe('importing the module is side-effect free', () => {
  it('exposes _internals without having run main()', () => {
    // If main() ran on import it would regenerate the real .claude/skills tree
    // and process.exit(0), killing this runner — the module-scope-main coupling
    // the isMain guard exists to prevent. Reaching this assertion proves it did
    // not fire.
    assert.equal(typeof copyFileIfChanged, 'function');
    assert.equal(typeof _internals.pruneFilesNotInSource, 'function');
  });
});

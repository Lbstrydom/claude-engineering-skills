/**
 * No tracked text source file may contain a RAW NUL byte.
 *
 * NUL is the natural separator for a composite key (`${a}\u0000${b}`) because it
 * cannot occur in the values — so the construct recurs, and writing it through
 * an editor puts the *literal* byte in the file instead of the escape. Runtime
 * is identical and every test passes, so nothing complains.
 *
 * What breaks is git. It classifies a blob as binary when it finds a NUL in the
 * **first 8000 bytes**, and a binary source file has no diff, no blame, and no
 * review surface. That threshold is why this hid: the three files found on
 * 2026-08-11 carried their NULs at offsets 9122, 11000 and 68377 — past the
 * sniff window, so git kept calling them text and the defect stayed latent for
 * however long they had been there. A new module written the same day put its
 * NUL at offset 2992 and committed as `Bin 0 -> 5823 bytes`.
 *
 * So the observable consequence is a coin-flip on byte offset. That is not a
 * property worth relying on, and "it happens to be past 8000" is not a review
 * you can perform. The escape is free; take it always.
 *
 * Fixing one: never through an editing tool (that re-introduces the byte).
 *   node -e "const fs=require('fs');const p='<file>';fs.writeFileSync(p,
 *     fs.readFileSync(p,'utf8').split(String.fromCharCode(0)).join('\\\\u0000'))"
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Extensions we assert on: text formats a NUL is never legitimate in. */
const TEXT_EXT = new Set(['.mjs', '.js', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.sql', '.md', '.yml', '.yaml']);

function trackedTextFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd: REPO_ROOT, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024,
  });
  return out.split('\0').filter(Boolean).filter((f) => TEXT_EXT.has(path.extname(f)));
}

describe('no raw NUL bytes in tracked source', () => {
  const files = trackedTextFiles();

  it('the file list is non-empty (anti-vacuous)', () => {
    // A `git ls-files` that returns nothing would make the assertion below pass
    // having read no files at all — the exact shape the sandbox-honesty rule
    // in AGENTS.md exists to catch.
    assert.ok(files.length > 500,
      `expected >500 tracked text files, got ${files.length} — the enumeration is broken, not the repo`);
  });

  it('no tracked text file contains a raw NUL', () => {
    const offenders = [];
    for (const f of files) {
      let buf;
      try { buf = fs.readFileSync(path.join(REPO_ROOT, f)); } catch { continue; }
      const at = buf.indexOf(0);
      if (at >= 0) {
        offenders.push(`${f} @byte ${at}` + (at < 8000 ? '  ← git will call this file BINARY' : ''));
      }
    }
    assert.deepEqual(offenders, [],
      `raw NUL byte(s) found — use the \\u0000 escape instead:\n  ${offenders.join('\n  ')}`);
  });

  it('negative control: the detector sees a NUL when one is present', () => {
    // Without this, "0 offenders" and "the scan is broken" are the same result.
    const withNul = Buffer.concat([Buffer.from('const k = `a'), Buffer.from([0]), Buffer.from('b`;\n')]);
    assert.equal(withNul.indexOf(0), 12, 'the detector must locate a planted NUL');
    const clean = Buffer.from('const k = `a\\u0000b`;\n');
    assert.equal(clean.indexOf(0), -1, 'the escaped form must NOT trip the detector');
  });
});

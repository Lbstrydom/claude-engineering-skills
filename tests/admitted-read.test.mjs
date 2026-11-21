/**
 * Tier 3 (sensitive-path egress) tests for the shared verified reader
 * (scripts/lib/symbol-index/admitted-read.mjs) and for both of its callers:
 * the Python stage and the ts-morph path (`extract.mjs::loadAndParseFile`).
 *
 * Every race is driven deterministically through the reader's injected hooks
 * (`beforeOpen`, `afterOpen`, `afterRead`): a swap between classification and
 * open, between open and the post-open recheck, and after the read. Each is
 * paired with a NEGATIVE CONTROL: the same scenario against a copy of the
 * reader with the guarding check cut out of its SOURCE must LEAK (return
 * ok), proving the scenario is a real attack and the check is what stops it.
 *
 * Plan: docs/plans/python-arch-memory-indexing.md §2.6, §8.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Project } from 'ts-morph';

import { readAdmittedSource, READ_OUTCOME } from '../scripts/lib/symbol-index/admitted-read.mjs';
import { extractSymbols, _internals } from '../scripts/symbol-index/extract.mjs';

const { classifySymbolsInFile, MAX_FILE_BYTES } = _internals;
import { resolveAndClassify } from '../scripts/lib/sensitive-paths.mjs';

const OUTCOME = READ_OUTCOME;
const READER_SRC = path.resolve(import.meta.dirname, '../scripts/lib/symbol-index/admitted-read.mjs');

let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'admitted-read-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

/** Directory link that needs no privilege on Windows (junction); false when unavailable. */
function linkDir(target, link) {
  try { fs.symlinkSync(target, link, 'junction'); return true; } catch (err) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(err.code)) return false;
    throw err;
  }
}

/**
 * A copy of the reader with every occurrence of each named check removed from
 * its source. Asserts each snippet is present, so a refactor of the reader
 * fails loudly instead of the control going vacuous.
 */
async function mutantReader(label, removals) {
  let src = fs.readFileSync(READER_SRC, 'utf8');
  for (const re of removals) {
    assert.match(src, re, `negative control "${label}": the check to remove is no longer in the reader`);
    src = src.replace(new RegExp(re.source, 'gm'), '');
  }
  const file = path.join(tmp, `mutant-${label}.mjs`);
  fs.writeFileSync(file, src);
  return (await import(`${pathToFileURL(file).href}?${label}`)).readAdmittedSource;
}
const CHECK = {
  fdPath: /^\s*if \(fdPath !== null && fdPath !== canonical\) return refuse\([^\n]*\n/m,
  stat: /^\s*if \(!same\(fs\.statSync\(canonical, \{ bigint: true \}\)\)\) return refuse\('opened file[^\n]*\n/m,
  readmit: /^\s*if \(!again\?\.admitted \|\| again\.canonicalPath !== canonical\) return refuse\([^\n]*\n/m,
  // A rename bumps the descriptor's ctime, so the post-read ctime comparison is a second layer over the same swaps.
  ctime: / \|\| st2\.ctimeNs !== st1\.ctimeNs/,
  final: /^\s*if \(!same\(fs\.statSync\(canonical, \{ bigint: true \}\)\)\) return refuse\('path no longer[^\n]*\n/m,
};

describe('readAdmittedSource — open-then-verify against a re-admission ', () => {
  const admitted = (p) => ({ canonicalPath: fs.realpathSync(p) });
  // A re-admission stub answering the way extract.mjs's admitFile does for a
  // plain in-repo file: admitted at its own canonical path.
  const readmitAt = (p) => () => ({ admitted: true, canonicalPath: fs.realpathSync(p) });
  function trySymlink(t, target, link) {
    try { fs.symlinkSync(target, link); return true; } catch (err) {
      if (err.code === 'EPERM' || err.code === 'EACCES') { t.skip(`symlinks unavailable here (${err.code})`); return false; }
      throw err;
    }
  }

  it('reads an admitted file into a buffer sized to the file, not the cap', () => {
    const p = path.join(tmp, 'a.py');
    fs.writeFileSync(p, 'def f():\n    return 1\n');
    const r = readAdmittedSource(admitted(p), { maxBytes: 1 << 20, readmit: readmitAt(p) });
    assert.equal(r.ok, true);
    assert.equal(r.bytes.toString(), 'def f():\n    return 1\n');
    assert.ok(r.bytes.buffer.byteLength < (1 << 16), `backing buffer ${r.bytes.buffer.byteLength}B must not scale with maxBytes`);
  });

  it('refuses when the re-admission (after the open) no longer admits the path', () => {
    const p = path.join(tmp, 'a.py');
    fs.writeFileSync(p, 'x = 1\n');
    const r = readAdmittedSource(admitted(p), { maxBytes: 1024, readmit: () => ({ admitted: false }) });
    assert.equal(r.outcome, OUTCOME.IDENTITY_CHANGED);
  });

  it('refuses a file replaced on the same path after the open (the fd is not the admitted file)', () => {
    const p = path.join(tmp, 'a.py');
    fs.writeFileSync(p, 'def f(): pass\n');
    const r = readAdmittedSource(admitted(p), {
      maxBytes: 1024, readmit: readmitAt(p),
      afterOpen: () => { fs.renameSync(p, path.join(tmp, 'moved.py')); fs.writeFileSync(p, 'other = 1\n'); },
    });
    assert.equal(r.ok, false);
    assert.equal(r.outcome, OUTCOME.IDENTITY_CHANGED);
  });

  it('swap-in-then-restore: a symlink to a sensitive target, opened, then the path restored, is refused', (t) => {
    const dir = path.join(tmp, 'pkg');
    fs.mkdirSync(dir);
    const p = path.join(dir, 'mod.py');
    fs.writeFileSync(p, 'def ok(): pass\n');
    const canonical = fs.realpathSync(p);
    const secret = path.join(tmp, 'secret.txt');
    fs.writeFileSync(secret, 'TOKEN = "do-not-read"\n');
    const stash = path.join(tmp, 'mod.stash');
    let swapped = false;
    const r = readAdmittedSource({ canonicalPath: canonical }, {
      maxBytes: 1024, readmit: readmitAt(p),
      beforeOpen: () => { fs.renameSync(p, stash); swapped = trySymlink(t, secret, p); if (!swapped) fs.renameSync(stash, p); },
      afterOpen: () => { if (swapped) { fs.unlinkSync(p); fs.renameSync(stash, p); } },
    });
    if (!swapped) return;
    assert.equal(r.ok, false, 'the secret bytes must not be returned');
    assert.equal(r.outcome, OUTCOME.IDENTITY_CHANGED);
  });

  it('a same-size rewrite after the read that restores mtime is still refused (ctime)', () => {
    const p = path.join(tmp, 'a.py');
    fs.writeFileSync(p, 'x = 1\n');
    const before = fs.statSync(p);
    const r = readAdmittedSource(admitted(p), {
      maxBytes: 1024, readmit: readmitAt(p),
      afterRead: () => { fs.writeFileSync(p, 'x = 2\n'); fs.utimesSync(p, before.atime, before.mtime); },
    });
    assert.equal(r.ok, false);
    assert.equal(r.outcome, OUTCOME.IDENTITY_CHANGED);
  });

  it('refuses growth of the same inode during the read (bounded read)', () => {
    const p = path.join(tmp, 'a.py');
    fs.writeFileSync(p, 'x = 1\n');
    const r = readAdmittedSource(admitted(p), { maxBytes: 1024, readmit: readmitAt(p), afterOpen: () => fs.appendFileSync(p, 'y = 2\n') });
    assert.equal(r.ok, false);
    assert.equal(r.outcome, OUTCOME.IDENTITY_CHANGED);
  });

  it('refuses a file over the cap without reading it', () => {
    const p = path.join(tmp, 'big.py');
    fs.writeFileSync(p, 'x'.repeat(100));
    const r = readAdmittedSource(admitted(p), { maxBytes: 10, readmit: readmitAt(p) });
    assert.equal(r.outcome, OUTCOME.SIZE_CAP);
  });

  it('a path swapped to a FIFO with no writer is refused without blocking', (t) => {
    if (process.platform === 'win32') { t.skip('no FIFOs on Windows; CI (Linux) runs this'); return; }
    const fifo = path.join(tmp, 'pipe.py');
    const mk = spawnSync('mkfifo', [fifo]);
    assert.equal(mk.status, 0, `mkfifo must exist on every non-Windows CI host: ${mk.error?.message ?? mk.stderr}`);
    const started = Date.now();
    const r = readAdmittedSource({ canonicalPath: fs.realpathSync(fifo) }, { maxBytes: 1024, readmit: readmitAt(fifo) });
    assert.equal(r.ok, false);
    assert.equal(r.outcome, OUTCOME.IDENTITY_CHANGED);
    assert.ok(Date.now() - started < 5000, 'the open must not hang on a writerless FIFO');
  });

  it('refuses to run without a re-admission (no silent pre-open-only mode)', () => {
    assert.throws(() => readAdmittedSource({ canonicalPath: tmp }, { maxBytes: 10 }), /readmit is required/);
  });
});


describe('the three race windows — each refused with nothing returned, each with a negative control', () => {
  // repo/src/mod.mjs is the admitted file; repo/secrets/mod.mjs is the sensitive
  // target a swapped path component would reach.
  function fixture() {
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'secrets'));
    fs.writeFileSync(path.join(repo, 'src', 'mod.mjs'), 'export function safe() { return 1; }\n');
    fs.writeFileSync(path.join(repo, 'secrets', 'mod.mjs'), 'export function leaked() { return "TOKEN"; }\n');
    const rel = 'src/mod.mjs';
    const abs = path.join(repo, rel);
    const swapDir = () => { fs.renameSync(path.join(repo, 'src'), path.join(repo, 'src.orig')); return linkDir(path.join(repo, 'secrets'), path.join(repo, 'src')); };
    const unswapDir = () => { fs.rmSync(path.join(repo, 'src'), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); fs.renameSync(path.join(repo, 'src.orig'), path.join(repo, 'src')); };
    const canonical = fs.realpathSync(abs);
    // The real gate, as extract.mjs's admitFile answers it: re-classify the path as it stands NOW.
    const readmit = () => {
      const c = resolveAndClassify(rel, { repoRoot: repo });
      return (c.resolutionFailed || c.escapedRepo || c.category === 'sensitive') ? { admitted: false } : { admitted: true, canonicalPath: c.canonical };
    };
    return { repo, rel, abs, canonical, swapDir, unswapDir, readmit };
  }

  it('swap between classification and open: the post-open re-admission refuses it', async (t) => {
    const f = fixture();
    let swapped = false;
    const hooks = { beforeOpen: () => { swapped = f.swapDir(); } };
    const real = readAdmittedSource({ canonicalPath: f.canonical }, { maxBytes: 1 << 20, readmit: f.readmit, ...hooks });
    if (!swapped) return t.skip('directory links unavailable here');
    assert.equal(real.ok, false, 'the swapped-in bytes must not be returned');
    assert.equal(real.outcome, OUTCOME.IDENTITY_CHANGED);
    // Negative control: without the post-open classification the swapped bytes leak.
    f.unswapDir();
    const leaky = await mutantReader('readmit-a', [CHECK.fdPath, CHECK.readmit]);
    const leak = leaky({ canonicalPath: f.canonical }, { maxBytes: 1 << 20, readmit: f.readmit, ...hooks });
    assert.equal(leak.ok, true, 'control: with the check removed the swap is NOT caught');
    assert.match(leak.bytes.toString(), /leaked/);
  });

  it('swap between the open and the post-open recheck: the identity check refuses it', async () => {
    const f = fixture();
    const alwaysAdmitted = () => ({ admitted: true, canonicalPath: f.canonical });
    const hooks = { afterOpen: () => { fs.renameSync(f.abs, `${f.abs}.moved`); fs.writeFileSync(f.abs, 'export const other = 1;\n'); } };
    const real = readAdmittedSource({ canonicalPath: f.canonical }, { maxBytes: 1 << 20, readmit: alwaysAdmitted, ...hooks });
    assert.equal(real.ok, false);
    assert.equal(real.outcome, OUTCOME.IDENTITY_CHANGED);
    fs.rmSync(f.abs, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); fs.renameSync(`${f.abs}.moved`, f.abs);
    const leaky = await mutantReader('stat-b', [CHECK.fdPath, CHECK.stat, CHECK.ctime, CHECK.final]);
    const leak = leaky({ canonicalPath: f.canonical }, { maxBytes: 1 << 20, readmit: alwaysAdmitted, ...hooks });
    assert.equal(leak.ok, true, 'control: with the identity checks removed the swap is NOT caught');
  });

  it('swap after the read: the final path-identity recheck refuses it and drops the bytes', async () => {
    const f = fixture();
    const alwaysAdmitted = () => ({ admitted: true, canonicalPath: f.canonical });
    const hooks = { afterRead: () => { fs.renameSync(f.abs, `${f.abs}.moved`); fs.writeFileSync(f.abs, 'export const other = 1;\n'); } };
    const real = readAdmittedSource({ canonicalPath: f.canonical }, { maxBytes: 1 << 20, readmit: alwaysAdmitted, ...hooks });
    assert.equal(real.ok, false);
    assert.equal(real.outcome, OUTCOME.IDENTITY_CHANGED);
    fs.rmSync(f.abs, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); fs.renameSync(`${f.abs}.moved`, f.abs);
    const leaky = await mutantReader('final-c', [CHECK.ctime, CHECK.final]);
    const leak = leaky({ canonicalPath: f.canonical }, { maxBytes: 1 << 20, readmit: alwaysAdmitted, ...hooks });
    assert.equal(leak.ok, true, 'control: with the final check removed the swap is NOT caught');
  });

  it('end to end through extractSymbols (ts-morph path): a swap before the open emits nothing', (t) => {
    const f = fixture();
    let swapped = false;
    const writes = [];
    t.mock.method(process.stdout, 'write', (chunk) => { writes.push(String(chunk)); return true; });
    const stats = extractSymbols([f.abs], f.repo, { readHooks: { beforeOpen: () => { swapped = f.swapDir(); } } });
    t.mock.restoreAll();
    if (!swapped) return t.skip('directory links unavailable here');
    assert.equal(stats.symbolCount, 0);
    assert.equal(stats.parseFailures, 1, 'a refused read is counted, never silent');
    assert.ok(!writes.join('').includes('leaked'), 'no symbol from the swapped-in file reached the emitter');
    assert.ok(!writes.some((w) => w.includes('"type":"symbol"')), 'nothing emitted');
  });
});

describe('ts-morph path: reading the bytes ourselves changes nothing downstream', () => {
  const sample = (root) => {
    const out = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '.git') continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(mjs|js|cjs|ts|tsx|jsx)$/.test(e.name) && fs.statSync(p).size < MAX_FILE_BYTES) out.push(p);
      }
    };
    walk(root);
    return out.sort().slice(0, 80);
  };
  const project = () => new Project({
    useInMemoryFileSystem: false, skipAddingFilesFromTsConfig: true, skipFileDependencyResolution: true,
    compilerOptions: { allowJs: true, checkJs: false },
  });

  it('createSourceFile(text) yields the same symbols as addSourceFileAtPath: fixtures incl. BOM, CRLF, tsx, plus the repo scripts', () => {
    const fx = path.join(tmp, 'fx');
    fs.mkdirSync(fx);
    fs.writeFileSync(path.join(fx, 'bom.mjs'), '﻿export function a(x) { return x; }\n');
    fs.writeFileSync(path.join(fx, 'crlf.mjs'), 'export const b = (y) => {\r\n  return y;\r\n};\r\nexport class C {}\r\n');
    // ts-morph's own path reader does NOT decode UTF-16 either (measured: both routes yield no symbols), so equivalence holds.
    fs.writeFileSync(path.join(fx, 'u16.mjs'), Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from('export function a() { return 1; }\n', 'utf16le')]));
    fs.writeFileSync(path.join(fx, 'v.tsx'), 'export const V = () => <div>hi</div>;\nexport function w(): number { return 1; }\n');
    const files = [...sample(fx), ...sample(path.resolve(import.meta.dirname, '../scripts/lib')).slice(0, 40)];
    assert.ok(files.length >= 43, 'vacuous-guard: the comparison must cover a real corpus');
    const ref = project();
    const viaText = project();
    for (const p of files) {
      const a = classifySymbolsInFile(ref.addSourceFileAtPath(p));
      const bytes = fs.readFileSync(p).toString('utf8').replace(/^﻿/, '');
      const b = classifySymbolsInFile(viaText.createSourceFile(p, bytes, { overwrite: true }));
      assert.deepEqual(b, a, `symbols differ for ${path.basename(p)}`);
    }
  });

  it('extractSymbols still reads a clean file through the verified reader (symbols emitted, no failures)', () => {
    const repo = path.join(tmp, 'ok');
    fs.mkdirSync(repo);
    fs.writeFileSync(path.join(repo, 'ok.mjs'), 'export function ok() { return 1; }\n');
    const stats = extractSymbols([path.join(repo, 'ok.mjs')], repo);
    assert.equal(stats.symbolCount, 1);
    assert.equal(stats.parseFailures, 0);
  });
});

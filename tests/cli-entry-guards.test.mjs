/**
 * @fileoverview Every "am I the entry script?" guard goes through
 * `isInvokedAsScript(import.meta.url)` (scripts/lib/cli-entry.mjs) — no ad-hoc
 * comparisons of `process.argv[1]` against `import.meta.url`.
 *
 * Why: Node realpaths the main module for `import.meta.url` but leaves
 * `process.argv[1]` as typed, so a lexical guard is false when the script is
 * reached through a symlink or junction — main() is skipped and the process
 * exits 0 having done nothing. The `file://${process.argv[1]}` concatenation
 * shape is false on every Windows path too, and the `argv[1].endsWith('x.mjs')`
 * shape is true for ANY script of that name. Measured 2026-10-13 on the
 * pre-migration tree: 16 of 26 `--selfcheck-relocation` CLIs run through a
 * junction exited 0 with no output; after migration, 26 of 26 printed OK.
 *
 * The census iterates the FILESYSTEM (scripts/** + root *.mjs), the only side
 * that can see a new CLI no list mentions. The helper's own semantics are
 * tested in tests/cli-entry.test.mjs; this file pins that nobody routes around it.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HELPER = 'scripts/lib/cli-entry.mjs';

/**
 * Lines that compare the entry path by hand: `process.argv[1]` with
 * `import.meta.url`/`__filename` within two lines either side, or a basename
 * `endsWith` on argv[1]. Comment lines are ignored.
 * Plain uses of argv[1] — `JSON.parse(process.argv[1])` in a `node -e`
 * child, printing the invoked path — are not guards and do not match.
 * @param {string} src
 * @returns {number[]} 1-based line numbers
 */
function findAdHocEntryGuards(src) {
  const lines = src.split(/\r?\n/);
  const isComment = (l) => /^\s*(\/\/|\*|\/\*)/.test(l);
  const hits = [];
  lines.forEach((line, i) => {
    if (isComment(line) || !/process\.argv\[1\]/.test(line)) return;
    const window = lines.slice(Math.max(0, i - 2), i + 3).filter((l) => !isComment(l)).join('\n');
    if (/import\.meta\.url|__filename/.test(window) || /process\.argv\[1\][^;]*\.endsWith\(/.test(line)) {
      hits.push(i + 1);
    }
  });
  return hits;
}

function census() {
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.claude-skills') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.mjs')) files.push(p);
    }
  };
  walk(path.join(ROOT, 'scripts'));
  for (const e of fs.readdirSync(ROOT)) if (e.endsWith('.mjs')) files.push(path.join(ROOT, e));
  return files.map((f) => path.relative(ROOT, f).split(path.sep).join('/')).filter((r) => r !== HELPER);
}

describe('findAdHocEntryGuards — the shapes it must catch', () => {
  const shapes = {
    'pathToFileURL equality': "if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {",
    'string concatenation': "const isMain = import.meta.url === `file://${process.argv[1]}`",
    'resolve vs fileURLToPath': 'const ok = path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);',
    'two-statement compare': "const invoked = process.argv[1] ? resolve(process.argv[1]) : '';\nif (invoked === fileURLToPath(import.meta.url)) {",
    '__filename compare': 'const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);',
    'basename endsWith': "if (process.argv[1]?.endsWith('x.mjs')) main();",
    'realpath canon': 'const here = canon(fileURLToPath(import.meta.url));\nif (process.argv[1] && here === canon(path.resolve(process.argv[1]))) await main();',
  };
  for (const [name, src] of Object.entries(shapes)) {
    it(`flags: ${name}`, () => assert.notDeepEqual(findAdHocEntryGuards(src), []));
  }
});

describe('findAdHocEntryGuards — the direction it must NOT fire', () => {
  const clean = {
    'the helper call': 'if (isInvokedAsScript(import.meta.url)) main();',
    'node -e payload': 'const cfg = JSON.parse(process.argv[1]);',
    'printing the invoked path': 'const self = path.resolve(process.argv[1]);\nconst rel = path.relative(cwd, self);',
    'a comment naming the old shape': '// was: import.meta.url === pathToFileURL(process.argv[1]).href',
  };
  for (const [name, src] of Object.entries(clean)) {
    it(`ignores: ${name}`, () => assert.deepEqual(findAdHocEntryGuards(src), []));
  }
});

describe('entry-guard census over scripts/** and root *.mjs', () => {
  it('no ad-hoc entry guards remain — use isInvokedAsScript(import.meta.url)', () => {
    const offenders = [];
    for (const rel of census()) {
      const hits = findAdHocEntryGuards(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
      if (hits.length) offenders.push(`${rel}:${hits.join(',')}`);
    }
    assert.deepEqual(offenders, [], `ad-hoc entry guards (import { isInvokedAsScript } from '${HELPER}'):\n  ${offenders.join('\n  ')}`);
  });

  it('the census is not vacuous: it sees the migrated guards', () => {
    const users = census().filter((rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').includes('isInvokedAsScript(import.meta.url)'));
    assert.ok(users.length >= 100, `expected the migrated population (>=100 files), saw ${users.length}`);
  });
});

describe('a migrated CLI reaches main() through a junction (real process)', () => {
  let tmp; let link;
  before(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ces-entry-guards-')));
    link = path.join(tmp, 'repo');
    fs.symlinkSync(ROOT, link, 'junction');
  });
  after(() => {
    fs.rmSync(link, { force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // check-plan-status.mjs: --selfcheck-relocation is main()'s first statement,
  // and pre-migration this exact run printed nothing and exited 0.
  for (const via of ['direct', 'junction']) {
    it(`check-plan-status.mjs --selfcheck-relocation prints OK (${via})`, () => {
      const base = via === 'direct' ? ROOT : link;
      const r = spawnSync(process.execPath, [path.join(base, 'scripts', 'check-plan-status.mjs'), '--selfcheck-relocation'], {
        cwd: ROOT, encoding: 'utf8', timeout: 30000,
      });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /^OK\s*$/m);
    });
  }
});

/**
 * @fileoverview The skill-markdown size ratchet (`npm run skills:size:gate`).
 *
 * Three layers, because each has a different silent failure:
 *   1. the shared decision core (`scripts/lib/size-ratchet.mjs`) in CHARACTER units;
 *   2. the collector — WHAT is governed (nested files in, generated copies and
 *      `.claude/skills` out, CRLF folded, a symlink fails closed);
 *   3. the CLI end to end against the real tree with crafted baselines — both the
 *      direction it must fire and the one it must NOT (a gate that cries wolf
 *      teaches `--no-verify`).
 *
 * Plan: docs/plans/skill-markdown-size-ratchet.md. The poison pill for the same
 * gate is `scripts/gate-contracts/skills-size-gate.json`; the gate id
 * `skills-size-ratchet-rejects-growth-past-the-baseline` is referenced here so the
 * contract validator can see this file knows about it.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  collectSkillSizes, diffAgainstBaseline, charCount, estimateTokens,
  LIMIT_CHARS, TOLERANCE_CHARS, GROWTH_PHRASE, GOVERNED_ROOTS, DEFAULT_BASELINE,
} from '../scripts/skill-size-ratchet.mjs';
import { readBaselineState, updatedBaseline } from '../scripts/lib/size-ratchet.mjs';

const GATE_ID = 'skills-size-ratchet-rejects-growth-past-the-baseline';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO, 'scripts', 'skill-size-ratchet.mjs');

const withTmp = (fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssr-'));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
};
const put = (root, rel, text) => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
};
const filler = (n) => 'x'.repeat(n);
/** Both governed roots must exist: a missing root is a failure, not an empty one. */
const skeleton = (root) => { fs.mkdirSync(path.join(root, 'docs/audit/shared-references'), { recursive: true }); fs.mkdirSync(path.join(root, 'skills'), { recursive: true }); };

describe(`the gate id the contract names (${GATE_ID})`, () => {
  test('the constants the contract and the docs state', () => {
    assert.equal(LIMIT_CHARS, 12000);
    assert.equal(TOLERANCE_CHARS, 200);
    assert.equal(GROWTH_PHRASE, 'skill markdown may not grow');
    assert.equal(DEFAULT_BASELINE, '.skill-size-baseline.json');
    assert.deepEqual([...GOVERNED_ROOTS], ['skills', 'docs/audit/shared-references']);
    assert.equal(estimateTokens(12000), 3000);
    assert.equal(estimateTokens(12001), 3001);
  });
});

describe('diffAgainstBaseline — character units, shared core', () => {
  test('growth beyond the tolerance fails; growth within it does not', () => {
    assert.equal(diffAgainstBaseline({ 'a.md': 15000 }, { 'a.md': 14000 }).grew.length, 1);
    assert.equal(diffAgainstBaseline({ 'a.md': 14000 + TOLERANCE_CHARS }, { 'a.md': 14000 }).grew.length, 0,
      'a gate that cries wolf earns --no-verify');
  });

  test('a file crossing the limit unbaselined is NEW>LIMIT (the hard ceiling)', () => {
    const r = diffAgainstBaseline({ 'new.md': LIMIT_CHARS + 1 }, {});
    assert.deepEqual(r.newOver, [{ file: 'new.md', size: LIMIT_CHARS + 1 }]);
  });

  test('shrank vs dropped stay distinct, and the THE TRAP holds', () => {
    assert.equal(diffAgainstBaseline({ 'a.md': 13000 }, { 'a.md': 14000 }).shrank.length, 1);
    assert.equal(diffAgainstBaseline({}, { 'a.md': 14000 }).dropped.length, 1);
    assert.equal(diffAgainstBaseline({ 'a.md': 13000 }, {}).newOver.length, 1);
  });

  test('an unchanged tree is clean in every bucket', () => {
    const same = { 'a.md': 13000, 'b.md': 20000 };
    const r = diffAgainstBaseline(same, { ...same });
    assert.deepEqual([r.grew, r.newOver, r.shrank, r.dropped], [[], [], [], []]);
  });
});

describe('collectSkillSizes — what is governed', () => {
  test('includes SKILL.md, references and examples, nested at any depth', () => withTmp((root) => {
    skeleton(root);
    put(root, 'skills/a/SKILL.md', filler(LIMIT_CHARS + 10));
    put(root, 'skills/a/references/r.md', filler(LIMIT_CHARS + 20));
    put(root, 'skills/a/examples/e.md', filler(LIMIT_CHARS + 30));
    put(root, 'skills/a/references/group/deep.md', filler(LIMIT_CHARS + 40));
    const out = collectSkillSizes(root);
    assert.deepEqual(Object.keys(out).sort(), [
      'skills/a/SKILL.md', 'skills/a/examples/e.md', 'skills/a/references/group/deep.md', 'skills/a/references/r.md',
    ]);
    assert.equal(out['skills/a/references/group/deep.md'], LIMIT_CHARS + 40, 'a nested file is MEASURED');
  }));

  test('a file under the limit is not in the result; one AT the limit is', () => withTmp((root) => {
    skeleton(root);
    put(root, 'skills/a/SKILL.md', filler(LIMIT_CHARS - 1));
    put(root, 'skills/a/references/r.md', filler(LIMIT_CHARS));
    assert.deepEqual(collectSkillSizes(root), { 'skills/a/references/r.md': LIMIT_CHARS });
  }));

  test('the canonical shared reference is governed; its generated copy is not', () => withTmp((root) => {
    put(root, 'docs/audit/shared-references/ledger-format.md', filler(LIMIT_CHARS + 100));
    // ledger-format.md is generated into audit-plan and audit-code (sync-shared-audit-refs EXPECTED_CONSUMERS)
    put(root, 'skills/audit-plan/references/ledger-format.md', filler(LIMIT_CHARS + 150));
    const out = collectSkillSizes(root);
    assert.deepEqual(Object.keys(out), ['docs/audit/shared-references/ledger-format.md']);
  }));

  test('.claude/skills is never walked', () => withTmp((root) => {
    skeleton(root);
    put(root, 'skills/a/SKILL.md', filler(100));
    put(root, '.claude/skills/a/SKILL.md', filler(LIMIT_CHARS * 2));
    assert.deepEqual(collectSkillSizes(root), {});
  }));

  test('CRLF and LF measure the same: the unit is the LF-canonical text', () => withTmp((root) => {
    const lf = `${'line of prose\n'.repeat(1000)}`;
    put(root, 'skills/a/references/lf.md', lf);
    put(root, 'skills/a/references/crlf.md', lf.replace(/\n/g, '\r\n'));
    assert.equal(charCount(path.join(root, 'skills/a/references/lf.md')), lf.length);
    assert.equal(charCount(path.join(root, 'skills/a/references/crlf.md')), lf.length);
  }));

  test('characters, not bytes: a multi-byte character counts once', () => withTmp((root) => {
    const p = put(root, 'skills/a/references/u.md', '→'.repeat(5));
    assert.equal(charCount(p), 5);
    assert.equal(fs.statSync(p).size, 15);
  }));

  test('a missing governed root throws: unmeasured must not read as clean', () => withTmp((root) => {
    put(root, 'skills/a/SKILL.md', 'x');
    assert.throws(() => collectSkillSizes(root), /cannot read governed root docs\/audit\/shared-references/);
  }));

  // Symlinks: skipped, with the reason stated, where the OS refuses to create one.
  const linkOrSkip = (t, target, link, type) => {
    try { fs.symlinkSync(target, link, type); return true; } catch (err) {
      // Only "this OS/user may not create links" skips; a fixture bug (EEXIST, ENOENT) must fail.
      if (!['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP', 'UNKNOWN'].includes(err.code)) throw err;
      t.skip(`cannot create a symlink here (${err.code})`);
      return false;
    }
  };

  test('a symlinked .md fails closed', (t) => withTmp((root) => {
    fs.mkdirSync(path.join(root, 'docs/audit/shared-references'), { recursive: true });
    const real = put(root, 'outside.md', filler(50));
    fs.mkdirSync(path.join(root, 'skills/a'), { recursive: true });
    if (!linkOrSkip(t, real, path.join(root, 'skills/a/SKILL.md'), 'file')) return;
    assert.throws(() => collectSkillSizes(root), /symbolic link in a governed tree: skills\/a\/SKILL\.md/);
  }));

  test('a symlinked references/ directory fails closed', (t) => withTmp((root) => {
    fs.mkdirSync(path.join(root, 'docs/audit/shared-references'), { recursive: true });
    fs.mkdirSync(path.join(root, 'elsewhere'), { recursive: true });
    fs.mkdirSync(path.join(root, 'skills/a'), { recursive: true });
    if (!linkOrSkip(t, path.join(root, 'elsewhere'), path.join(root, 'skills/a/references'), 'junction')) return;
    assert.throws(() => collectSkillSizes(root), /symbolic link in a governed tree: skills\/a\/references/);
  }));

  test('a symlinked governed ROOT fails closed', (t) => withTmp((root) => {
    fs.mkdirSync(path.join(root, 'docs/audit/shared-references'), { recursive: true });
    fs.mkdirSync(path.join(root, 'real-skills'), { recursive: true });
    if (!linkOrSkip(t, path.join(root, 'real-skills'), path.join(root, 'skills'), 'junction')) return;
    assert.throws(() => collectSkillSizes(root), /symbolic link in a governed tree: skills/);
  }));
});

describe('--update-baseline cases (shared core)', () => {
  test('absent bootstraps every over-limit file; a valid baseline only ratchets down', () => {
    assert.deepEqual(updatedBaseline({ 'a.md': 13000 }, null), { 'a.md': 13000 });
    const next = updatedBaseline({ 'crept.md': 14100, 'shrunk.md': 13000, 'fresh.md': 15000 }, { 'crept.md': 14000, 'shrunk.md': 20000 });
    assert.deepEqual(next, { 'crept.md': 14000, 'shrunk.md': 13000 }, 'creep not absorbed, shrink locked in, new file not admitted');
  });

  test('readBaselineState distinguishes absent, invalid and ok', () => withTmp((dir) => {
    assert.deepEqual(readBaselineState(path.join(dir, 'nope.json')), { kind: 'absent' });
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, '{ not json');
    assert.equal(readBaselineState(bad).kind, 'invalid');
    fs.writeFileSync(bad, '{"files":{"a.md":"13000"}}');
    assert.equal(readBaselineState(bad).kind, 'invalid', 'a non-numeric size is invalid');
    fs.writeFileSync(bad, '{"files":{"a.md":13000}}');
    assert.deepEqual(readBaselineState(bad), { kind: 'ok', files: { 'a.md': 13000 } });
  }));
});

describe('the CLI against the real tree', () => {
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', cwd: REPO });
  const current = collectSkillSizes(REPO);
  const files = Object.keys(current);

  test('vacuous-pass guard: the real tree has governed files and every one of them is measured', () => {
    // The crafted-baseline tests below pick files[0] and files[1] from the real tree, so they
    // need two governed files; if trimming ever empties the ledger, rewrite them against a tmp tree.
    assert.ok(files.length >= 2, `expected a plausible baseline population, got ${files.length}`);
    for (const f of files) assert.ok(current[f] >= LIMIT_CHARS, f);
  });

  // The baselines are crafted in a tmp dir and handed over with --baseline: the real one is never touched.
  const gate = (mutate, ...extra) => withTmp((dir) => {
    const b = path.join(dir, 'b.json');
    const map = mutate({ ...current });
    fs.writeFileSync(b, JSON.stringify({ files: map }));
    return run('--baseline', b, ...extra);
  });

  test('a baseline equal to the tree is clean, exit 0 — the direction it must NOT fire', () => {
    const r = gate((m) => m);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /clean/);
  });

  test('growth within the tolerance passes', () => {
    const r = gate((m) => { m[files[0]] -= TOLERANCE_CHARS; return m; });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });

  test('GREW: a baseline understated beyond the tolerance → exit 1 and the growth phrase', () => {
    const r = gate((m) => { m[files[0]] -= TOLERANCE_CHARS + 100; return m; });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /GREW/);
    assert.ok(r.stdout.includes(GROWTH_PHRASE), 'the poison pill matches this phrase');
  });

  test('NEW>LIMIT: a governed file missing from the baseline → exit 1 and the growth phrase', () => {
    const r = gate((m) => { delete m[files[0]]; return m; });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /NEW>LIMIT/);
    assert.ok(r.stdout.includes(GROWTH_PHRASE));
  });

  test('SHRANK: an overstated baseline is a shrink nobody re-baselined → exit 1', () => {
    const r = gate((m) => { m[files[0]] += TOLERANCE_CHARS + 1000; return m; });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /SHRANK/);
    assert.match(r.stdout, /skills:size:gate -- --update-baseline/);
  });

  test('DROPPED: a baselined file that is not over the limit → exit 1', () => {
    const r = gate((m) => { m['skills/ghost/SKILL.md'] = 20000; return m; });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /DROPPED/);
  });

  test('--report always exits 0, even on drift', () => {
    const r = gate((m) => { delete m[files[0]]; return m; }, '--report');
    assert.equal(r.status, 0);
    assert.match(r.stdout, /NEW>LIMIT/);
  });

  test('an absent baseline → exit 2 and says to create it; an invalid one is named as invalid', () => withTmp((dir) => {
    const r = run('--baseline', path.join(dir, 'nope.json'));
    assert.equal(r.status, 2);
    assert.match(r.stderr, /no baseline at/);
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, 'garbage');
    const r2 = run('--baseline', bad);
    assert.equal(r2.status, 2);
    assert.match(r2.stderr, /is invalid/);
    assert.doesNotMatch(r2.stderr, /no baseline at/);
  }));

  test('--update-baseline bootstraps an ABSENT baseline from the tree', () => withTmp((dir) => {
    const p = path.join(dir, 'b.json');
    const r = run('--baseline', p, '--update-baseline');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /bootstrap/);
    assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8')).files, current);
    assert.equal(run('--baseline', p).status, 0, 'and the bootstrapped baseline gates clean');
  }));

  test('--update-baseline refuses an INVALID baseline and leaves it byte-for-byte untouched', () => withTmp((dir) => {
    const p = path.join(dir, 'b.json');
    fs.writeFileSync(p, '{ "files": { "a.md": 1, ');
    const r = run('--baseline', p, '--update-baseline');
    assert.equal(r.status, 2);
    assert.match(r.stderr, /refusing --update-baseline/);
    assert.equal(fs.readFileSync(p, 'utf8'), '{ "files": { "a.md": 1, ');
  }));

  test('--update-baseline on a valid baseline never raises a mark and never admits a new file', () => withTmp((dir) => {
    const p = path.join(dir, 'b.json');
    const map = { ...current };
    map[files[0]] -= 100;                       // crept within tolerance: gate passes, mark must stay
    const dropped = files[1];
    delete map[dropped];                        // a governed file not in the baseline: must NOT be admitted
    fs.writeFileSync(p, JSON.stringify({ files: map }));
    const r = run('--baseline', p, '--update-baseline');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`NOT absorbed: ${dropped.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    const after = JSON.parse(fs.readFileSync(p, 'utf8')).files;
    assert.equal(after[files[0]], current[files[0]] - 100, 'the creep was not absorbed');
    assert.ok(!(dropped in after), 'a new over-limit file is not admitted by an update');
  }));

  test('an unknown flag exits 2; --baseline without a value exits 2; --selfcheck-relocation prints OK', () => {
    assert.equal(run('--bogus').status, 2);
    assert.equal(run('--baseline').status, 2);
    const r = run('--selfcheck-relocation');
    assert.equal(r.status, 0);
    assert.match(r.stdout, /OK/);
  });
});

describe('the committed baseline', () => {
  test('the real tree is clean against the committed baseline', () => {
    const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', cwd: REPO });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });
});

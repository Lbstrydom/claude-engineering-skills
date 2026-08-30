/**
 * @fileoverview `loadAllSkills` defaulted to a top-level `skills/` and returned
 * `[]` when it was absent — so in a consumer, which carries only the generated
 * `.claude/skills/`, `skills-help.mjs` printed "_No skills found in `skills/`._"
 * over 67 tracked skill files. A silently-wrong empty result, not an error, so
 * it read as "this repo has no skills" rather than "I looked in the wrong
 * place" (upstream report `5b67f273`, filed HIGH from `storyline`).
 *
 * The property that matters is not "it finds skills" — it is that the three
 * states stay DISTINGUISHABLE: found here, found nowhere, and no-root-at-all.
 * Collapsing the last two back together is the whole defect.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  loadAllSkills, resolveSkillsRoot, SKILL_ROOT_CANDIDATES,
} from '../scripts/lib/skills-index.mjs';

const SKILL = (name) => `---\nname: ${name}\ndescription: a test skill\n---\n\n# ${name}\n`;

function repo({ authoring = [], generated = [] } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skills-root-')));
  for (const [root, names] of [['skills', authoring], ['.claude/skills', generated]]) {
    if (!names.length) continue;
    for (const n of names) {
      fs.mkdirSync(path.join(dir, root, n), { recursive: true });
      fs.writeFileSync(path.join(dir, root, n, 'SKILL.md'), SKILL(n));
    }
  }
  return dir;
}

describe('resolveSkillsRoot', () => {
  test('prefers the authoring tree when both exist', () => {
    // The source repo has both; the dashboard and skills:index document the
    // AUTHORING tree, and the generated copy is a mirror of it.
    const dir = repo({ authoring: ['plan'], generated: ['plan'] });
    const r = resolveSkillsRoot(dir);
    assert.equal(r.origin, 'authoring');
    assert.equal(r.root, path.join(dir, 'skills'));
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  test('falls back to the generated tree — the consumer shape', () => {
    // Every consumer is this shape: the sync writes .claude/skills/ and the
    // authoring tree is source-repo-only.
    const dir = repo({ generated: ['plan', 'ship'] });
    const r = resolveSkillsRoot(dir);
    assert.equal(r.origin, 'generated');
    assert.equal(r.root, path.join(dir, '.claude', 'skills'));
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  test('reports `none` rather than guessing when neither exists', () => {
    const dir = repo();
    assert.deepEqual(resolveSkillsRoot(dir), { root: null, origin: 'none' });
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  test('the candidate order is the contract, not an implementation detail', () => {
    assert.deepEqual([...SKILL_ROOT_CANDIDATES], ['skills', '.claude/skills']);
  });
});

describe('loadAllSkills — the reported defect', () => {
  const withCwd = (dir, fn) => {
    const prev = process.cwd();
    process.chdir(dir);
    try { return fn(); } finally { process.chdir(prev); }
  };

  test('a consumer-shaped repo yields its skills, not an empty list', () => {
    // The regression under repair: this returned [] before.
    const dir = repo({ generated: ['plan', 'ship'] });
    const found = withCwd(dir, () => loadAllSkills(undefined, { onSkip: () => {} }));
    assert.deepEqual(found.map((s) => s.name).sort(), ['plan', 'ship']);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  test('a source-shaped repo still reads the AUTHORING tree', () => {
    // The direction that must not fire: the fallback must not start shadowing
    // the authoring tree in the repo that has both.
    const dir = repo({ authoring: ['plan'], generated: ['plan', 'stale-mirror-only'] });
    const found = withCwd(dir, () => loadAllSkills(undefined, { onSkip: () => {} }));
    assert.deepEqual(found.map((s) => s.name), ['plan'], 'read the generated mirror instead of the authoring tree');
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  test('an EXPLICIT root still wins outright', () => {
    // collect-reference passes one deliberately, because the dashboard
    // documents the authoring tree and must not silently fall back.
    const dir = repo({ authoring: ['plan'], generated: ['other'] });
    const found = loadAllSkills(path.join(dir, '.claude/skills'), { onSkip: () => {} });
    assert.deepEqual(found.map((s) => s.name), ['other']);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  test('no root at all REPORTS, rather than returning a silent empty list', () => {
    // "nothing here" and "no such directory" are different answers, and only
    // one of them is a fact about the skills. Collapsing them is the defect.
    const dir = repo();
    const skips = [];
    const found = withCwd(dir, () => loadAllSkills(undefined, { onSkip: (i) => skips.push(i) }));
    assert.deepEqual(found, []);
    assert.equal(skips.length, 1);
    assert.equal(skips[0].reason, 'no-skills-root');
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  test('an explicit root that does not exist is reported too, not swallowed', () => {
    const skips = [];
    const found = loadAllSkills('/definitely/not/here', { onSkip: (i) => skips.push(i) });
    assert.deepEqual(found, []);
    assert.deepEqual(skips.map((s) => s.reason), ['skills-root-absent']);
  });

  test('a root that EXISTS but holds no skills is a different, silent state', () => {
    // This one is genuinely "looked and found nothing" — it must NOT report a
    // missing root, or the two become indistinguishable again from the other side.
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skills-root-')));
    fs.mkdirSync(path.join(dir, '.claude', 'skills'), { recursive: true });
    const skips = [];
    const found = withCwd(dir, () => loadAllSkills(undefined, { onSkip: (i) => skips.push(i) }));
    assert.deepEqual(found, []);
    assert.deepEqual(skips, []);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
});

describe('this repo, which is the source shape', () => {
  test('still resolves to the authoring tree and finds every skill', () => {
    // Guards against the suite passing on fixtures while the real repo breaks.
    const repoRoot = path.resolve(import.meta.dirname, '..');
    assert.equal(resolveSkillsRoot(repoRoot).origin, 'authoring');
    assert.ok(loadAllSkills(path.join(repoRoot, 'skills'), { onSkip: () => {} }).length >= 16);
  });
});

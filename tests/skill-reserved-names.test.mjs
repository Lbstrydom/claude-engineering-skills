/**
 * Tests for scripts/lib/skill-reserved-names.mjs and its wiring into
 * scripts/check-skill-descriptions.mjs (part of `npm run skills:check`).
 *
 * Claude Code 2.1.330 does not load a skill named ship / ship-local / steward,
 * and `.claude/skills/steward/SKILL.md` is the file its watch reads as
 * instructions. Each rule is shown to FAIL on a planted violation (negative
 * control) before the live tree is shown to pass.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  findReservedNameCollisions, extractFrontmatterName, foldSkillName,
  RESERVED_SKILL_NAMES, KNOWN_RESERVED_COLLISIONS,
} from '../scripts/lib/skill-reserved-names.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const md = (name) => `---\nname: ${name}\ndescription: |\n  demo\n---\n\n# Body\n`;

describe('findReservedNameCollisions', () => {
  it('flags a skill named steward (negative control)', () => {
    const r = findReservedNameCollisions({ steward: md('steward') }, { known: {} });
    assert.deepEqual(r.violations, [{ skill: 'steward', name: 'steward' }]);
  });

  it('flags a reserved frontmatter name under an innocent directory', () => {
    const r = findReservedNameCollisions({ helper: md('Steward') }, { known: {} });
    assert.deepEqual(r.violations, [{ skill: 'helper', name: 'steward' }]);
  });

  it('flags ship-local and folds case and spacing as the host does', () => {
    assert.equal(foldSkillName(' Ship-Local '), 'ship-local');
    const r = findReservedNameCollisions({ 'SHIP-LOCAL': md('x') }, { known: {} });
    assert.equal(r.violations.length, 1);
  });

  it('passes a non-reserved name (positive control)', () => {
    const r = findReservedNameCollisions({ deploy: md('deploy') }, { known: {} });
    assert.deepEqual(r, { violations: [], tolerated: [], staleExceptions: [], unreadable: [] });
  });

  it('tolerates a declared exception, and reports it rather than hiding it', () => {
    const r = findReservedNameCollisions({ ship: md('ship') }, { known: { ship: { name: 'ship', reason: 'why' } } });
    assert.deepEqual(r.violations, []);
    assert.deepEqual(r.tolerated, [{ skill: 'ship', name: 'ship', reason: 'why' }]);
  });

  it('fails a stale exception once the skill is renamed', () => {
    const r = findReservedNameCollisions({ release: md('release') }, { known: { ship: { name: 'ship', reason: 'why' } } });
    assert.deepEqual(r.staleExceptions, ['ship']);
  });

  it('the reserved list matches the CC 2.1.330 debug line, and steward has no exception', () => {
    assert.deepEqual([...RESERVED_SKILL_NAMES].sort(), ['ship', 'ship-local', 'ship:steward', 'steward']);
    assert.equal(Object.values(KNOWN_RESERVED_COLLISIONS).some((e) => foldSkillName(e.name) !== 'ship'), false);
  });

  it('the exception is scoped to its directory: a second claimant of ship fails', () => {
    const known = { ship: { name: 'ship', reason: 'why' } };
    const r = findReservedNameCollisions({ ship: md('ship'), other: md('ship') }, { known });
    assert.deepEqual(r.violations, [{ skill: 'other', name: 'ship' }]);
  });

  it('a renamed original leaves the exception stale even if another skill claims the name', () => {
    const known = { ship: { name: 'ship', reason: 'why' } };
    const r = findReservedNameCollisions({ release: md('release'), other: md('ship') }, { known });
    assert.deepEqual(r.staleExceptions, ['ship']);
    assert.deepEqual(r.violations, [{ skill: 'other', name: 'ship' }]);
  });

  it('the exception covers only its declared name: the ship dir named steward fails', () => {
    const known = { ship: { name: 'ship', reason: 'why' } };
    const r = findReservedNameCollisions({ ship: md('steward') }, { known });
    assert.deepEqual(r.violations, [{ skill: 'ship', name: 'steward' }]);
  });

  it('reads YAML names the parser way: quoted, commented, block scalar', () => {
    assert.deepEqual(extractFrontmatterName(md('"ship"')), { ok: true, name: 'ship' });
    assert.deepEqual(extractFrontmatterName(md('steward # reserved')), { ok: true, name: 'steward' });
    assert.deepEqual(extractFrontmatterName(md('"steward" # reserved')), { ok: true, name: 'steward' });
    assert.deepEqual(extractFrontmatterName('---\nname: >-\n  steward\n---\n'), { ok: true, name: 'steward' });
    assert.deepEqual(extractFrontmatterName('no frontmatter'), { ok: true, name: null });
    const r = findReservedNameCollisions({ helper: md('steward # reserved') }, { known: {} });
    assert.deepEqual(r.violations, [{ skill: 'helper', name: 'steward' }]);
  });

  it('fails closed on a name it cannot read', () => {
    const r = findReservedNameCollisions({ helper: '---\nname: [steward\n---\n' }, { known: {} });
    assert.equal(r.unreadable.length, 1);
    const n = findReservedNameCollisions({ helper: '---\nname: 7\n---\n' }, { known: {} });
    assert.equal(n.unreadable.length, 1);
  });
});

describe('check-skill-descriptions CLI enforces it', () => {
  const run = (cwd) => spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts/check-skill-descriptions.mjs')], { cwd, encoding: 'utf8' });

  it('exits 1 on a planted steward skill (negative control)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reserved-names-'));
    try {
      for (const n of ['ship', 'steward']) {
        fs.mkdirSync(path.join(dir, 'skills', n), { recursive: true });
        fs.writeFileSync(path.join(dir, 'skills', n, 'SKILL.md'), md(n));
      }
      const r = run(dir);
      assert.equal(r.status, 1, r.stderr);
      assert.match(r.stderr, /\[steward\] uses "steward"/);
    } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  it('a skills/__proto__ directory is still checked, not swallowed by the prototype', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reserved-names-'));
    try {
      for (const [d, n] of [['ship', 'ship'], ['__proto__', 'steward']]) {
        fs.mkdirSync(path.join(dir, 'skills', d), { recursive: true });
        fs.writeFileSync(path.join(dir, 'skills', d, 'SKILL.md'), md(n));
      }
      const r = run(dir);
      assert.equal(r.status, 1, r.stderr);
      assert.match(r.stderr, /\[__proto__\] uses "steward"/);
    } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  it('exits 0 on the live skills/ tree', () => {
    const r = run(REPO_ROOT);
    assert.equal(r.status, 0, r.stderr);
  });
});

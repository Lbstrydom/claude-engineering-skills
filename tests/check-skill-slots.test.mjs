/**
 * @fileoverview `scripts/check-skill-slots.mjs`: the upstream slot-marker lint
 * fails closed on its input and fails on a misplaced marker.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { lintSkillSlots } from '../scripts/check-skill-slots.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-slots-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
const skill = (root, name, body) => {
  fs.mkdirSync(path.join(root, name), { recursive: true });
  fs.writeFileSync(path.join(root, name, 'SKILL.md'), body);
};

describe('check-skill-slots CLI — one JSON envelope with ok on every exit (code audit R4 M2)', async () => {
  const { execFileSync } = await import('node:child_process');
  const cli = path.resolve('scripts/check-skill-slots.mjs');
  const run = (args) => { try { return { code: 0, out: execFileSync(process.execPath, [cli, ...args], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }) }; } catch (e) { return { code: e.status, out: e.stdout }; } };
  it('clean, problems and usage error each emit {ok}', () => {
    const clean = run(['--json']);
    assert.equal(clean.code, 0); assert.equal(JSON.parse(clean.out).ok, true);
    const bad = path.join(tmp, 'cli-bad');
    skill(bad, 'x', '```\n<!-- sync-slot:a -->\n```\n');
    const p = run(['--json', '--root', bad]);
    assert.equal(p.code, 1); assert.equal(JSON.parse(p.out).ok, false);
    const u = run(['--json', '--root']);
    assert.equal(u.code, 2); assert.equal(JSON.parse(u.out).ok, false);
    assert.equal(run(['--help', '--bogus']).code, 2, 'an unknown flag beside --help is refused (code audit R5 M1)');
    assert.equal(run(['--help']).code, 0);
  });
});

describe('lintSkillSlots', () => {
  it('a missing root is unreadable and an empty root is no-skills — never a pass', () => {
    assert.equal(lintSkillSlots(path.join(tmp, 'absent')).status, 'unreadable');
    fs.mkdirSync(path.join(tmp, 'empty'));
    assert.equal(lintSkillSlots(path.join(tmp, 'empty')).status, 'no-skills');
    // A skill directory with no SKILL.md is reported, never skipped (audit R1 H4): the other skill being clean is not a pass.
    const mixed = path.join(tmp, 'mixed');
    skill(mixed, 'ok', '# ok\n');
    fs.mkdirSync(path.join(mixed, 'hollow'));
    const r = lintSkillSlots(mixed);
    assert.equal(r.status, 'problems');
    assert.deepEqual(r.problems.map((p) => p.code), ['skill-md-missing']);
    // A symbolic link (a junction on Windows) is reported, never followed and never skipped (audit R2 H2).
    skill(path.join(tmp, 'bad'), 'x', '---\nname: x\n---\n\n```\n<!-- sync-slot:a -->\n```\n');
    const linked = path.join(tmp, 'linked');
    skill(linked, 'real', '# real\n');
    fs.symlinkSync(path.join(tmp, 'bad', 'x'), path.join(linked, 'via-link'), 'junction');
    const lr = lintSkillSlots(linked);
    assert.equal(lr.status, 'problems');
    assert.ok(lr.problems.some((p) => p.code === 'skill-symlink'), JSON.stringify(lr.problems));
  });

  // Gate contract skills-check-detects-slot-marker-in-fence (scripts/gate-contracts/skills-check.json) pills this case.
  it('a fenced marker is a problem (negative control); a clean tree reports what it counted', () => {
    const bad = path.join(tmp, 'bad');
    skill(bad, 'x', '---\nname: x\n---\n\n```\n<!-- sync-slot:a -->\n```\n');
    const r = lintSkillSlots(bad);
    assert.equal(r.status, 'problems');
    assert.deepEqual(r.problems.map((p) => [p.line, p.code]), [[6, 'slot-in-fence']]);

    const good = path.join(tmp, 'good');
    skill(good, 'y', '---\nname: y\n---\n\n<!-- sync-slot:a -->\n');
    assert.deepEqual({ ...lintSkillSlots(good), problems: undefined }, { status: 'ok', files: 1, markers: 1, problems: undefined });
  });

  it('the real skills/ tree is clean and carries the target-adapter slot in the four UX lenses', () => {
    const r = lintSkillSlots(path.resolve('skills'));
    assert.equal(r.status, 'ok', JSON.stringify(r.problems));
    for (const s of ['click-test', 'nav-audit', 'persona-test', 'visual-audit']) {
      const text = fs.readFileSync(path.join('skills', s, 'SKILL.md'), 'utf-8');
      assert.ok(text.includes('\n<!-- sync-slot:target-adapter -->\n'), `${s} lacks the target-adapter slot`);
    }
  });
});

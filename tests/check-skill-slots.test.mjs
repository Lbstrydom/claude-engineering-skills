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
after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }));
const skill = (root, name, body) => {
  fs.mkdirSync(path.join(root, name), { recursive: true });
  fs.writeFileSync(path.join(root, name, 'SKILL.md'), body);
};

describe('lintSkillSlots', () => {
  it('a missing root is unreadable and an empty root is no-skills — never a pass', () => {
    assert.equal(lintSkillSlots(path.join(tmp, 'absent')).status, 'unreadable');
    fs.mkdirSync(path.join(tmp, 'empty'));
    assert.equal(lintSkillSlots(path.join(tmp, 'empty')).status, 'no-skills');
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

/**
 * Guards the worktree-preflight contract (scripts/lib/worktree-preflight.mjs).
 *
 * The tests that matter most here are the two DIRECTIONS, not the happy path:
 * a gate that only fires is as useless as one that never does. The
 * npm-indirection case is a regression test for a real miss — the first cut of
 * this feature picked its subject set by grepping `node scripts/*.mjs`, which
 * excluded `ai-context-management` (it reaches the tooling only through
 * `npm run context:check`) — the very skill the bug was reported against.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  MARKER_BLOCK,
  MARKER_KEY,
  checkSkill,
  skillsInvokingSyncedTooling,
} from '../scripts/lib/worktree-preflight.mjs';

/**
 * Build a throwaway repo with the given skills.
 * @param {Record<string,string>} scripts package.json scripts map
 * @param {Record<string,string>} skills  skill name -> SKILL.md body
 */
function makeRepo(scripts, skills) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wtpf-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts }));
  for (const [name, body] of Object.entries(skills)) {
    const dir = path.join(root, 'skills', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), body);
  }
  return root;
}

const WITH_MARKER = `# t\n\n${MARKER_BLOCK}\n\n## Step\n\n\`\`\`bash\nnode scripts/cross-skill.mjs detect-stack\n\`\`\`\n`;

describe('skillsInvokingSyncedTooling — subject set', () => {
  test('includes a skill that reaches the tooling only via `npm run`', () => {
    // The regression this whole gate exists to not repeat.
    const root = makeRepo(
      { 'context:check': 'node scripts/check-context-drift.mjs --strict' },
      { indirect: '# t\n\nRun `npm run context:check` to verify.\n\n## Step\n' },
    );
    assert.deepEqual(skillsInvokingSyncedTooling(root), ['indirect']);
  });

  test('includes a skill invoking `node scripts/<x>.mjs` directly', () => {
    const root = makeRepo({}, { direct: '# t\n\n```bash\nnode scripts/ship-commit.mjs\n```\n' });
    assert.deepEqual(skillsInvokingSyncedTooling(root), ['direct']);
  });

  test('finds commands in references/, not only SKILL.md', () => {
    const root = makeRepo({}, { deep: '# t\n\nno commands here\n' });
    const refs = path.join(root, 'skills', 'deep', 'references');
    fs.mkdirSync(refs, { recursive: true });
    fs.writeFileSync(path.join(refs, 'x.md'), '```bash\nnode scripts/cross-skill.mjs\n```\n');
    assert.deepEqual(skillsInvokingSyncedTooling(root), ['deep']);
  });

  // The direction the gate must NOT fire. A false positive here forces a
  // marker into a skill that cannot be bitten, which teaches people to ignore it.
  test('excludes a skill with no tooling commands at all', () => {
    const root = makeRepo({ lint: 'eslint .' }, { pure: '# t\n\nRun `npm run lint`, then `git status`.\n' });
    assert.deepEqual(skillsInvokingSyncedTooling(root), []);
  });

  test('excludes an `npm run` whose script never enters scripts/', () => {
    const root = makeRepo({ build: 'tsc -p .' }, { app: '# t\n\nRun `npm run build`.\n' });
    assert.deepEqual(skillsInvokingSyncedTooling(root), []);
  });

  test('fails closed when package.json is unreadable', () => {
    // A tolerated empty script map would silently shrink the subject set to
    // direct-invocation skills only — reinstating the original blind spot.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wtpf-'));
    fs.mkdirSync(path.join(root, 'skills'), { recursive: true });
    assert.throws(() => skillsInvokingSyncedTooling(root), /refusing to compute a subject set/);
  });
});

describe('checkSkill — marker states', () => {
  test('ok when the block is present verbatim', () => {
    const root = makeRepo({}, { s: WITH_MARKER });
    assert.equal(checkSkill(root, 's').status, 'ok');
  });

  test('missing when there is no marker', () => {
    const root = makeRepo({}, { s: '# t\n\n## Step\n\n`node scripts/x.mjs`\n' });
    assert.equal(checkSkill(root, 's').status, 'missing');
  });

  test('edited is distinct from missing', () => {
    // Two different failures needing two different remedies: "you never added
    // it" vs "you added it and then changed the wording".
    const root = makeRepo({}, { s: WITH_MARKER.replace('Run `npm run skills:hydrate` first.', 'Just hydrate.') });
    const r = checkSkill(root, 's');
    assert.equal(r.status, 'edited');
    assert.ok(fs.readFileSync(path.join(root, 'skills', 's', 'SKILL.md'), 'utf-8').includes(MARKER_KEY));
  });

  test('a CRLF checkout is not misread as edited', () => {
    // git calls such a file clean under .gitattributes eol=lf; a tool that
    // disagrees is comparing the wrong bytes.
    const root = makeRepo({}, { s: WITH_MARKER.replaceAll('\n', '\r\n') });
    assert.equal(checkSkill(root, 's').status, 'ok');
  });
});

describe('the poison pill stays wired to what it claims', () => {
  const contractPath = path.resolve(import.meta.dirname, '..', 'scripts', 'gate-contracts', 'worktree-preflight-gate.json');

  test('the contract declares worktree-preflight-rejects-skill-without-marker and its fixture exists', () => {
    const contract = JSON.parse(fs.readFileSync(contractPath, 'utf-8'));
    const pill = contract.gates.find(g => g.id === 'worktree-preflight-rejects-skill-without-marker');
    assert.ok(pill, 'the contract must declare the gate id this suite is registered against');
    const fixture = path.resolve(import.meta.dirname, '..', pill.poisonPill.overlay['skills/skills/SKILL.md']);
    assert.ok(fs.existsSync(fixture), 'the overlay fixture must exist');

    // The property that makes the pill non-vacuous: the fixture must still be
    // IN SCOPE after the overlay. Strip its tooling command and the skill drops
    // out of the subject set, the gate passes, and the pill proves nothing.
    const scoped = fs.mkdtempSync(path.join(os.tmpdir(), 'wtpf-pill-'));
    fs.writeFileSync(path.join(scoped, 'package.json'), JSON.stringify({ scripts: {} }));
    fs.mkdirSync(path.join(scoped, 'skills', 'skills'), { recursive: true });
    fs.copyFileSync(fixture, path.join(scoped, 'skills', 'skills', 'SKILL.md'));
    assert.deepEqual(skillsInvokingSyncedTooling(scoped), ['skills'], 'fixture must stay in scope');
    assert.equal(checkSkill(scoped, 'skills').status, 'missing', 'fixture must trip the gate');
  });
});

describe('the real repo satisfies its own gate', () => {
  test('every in-scope skill carries the marker', () => {
    const root = path.resolve(import.meta.dirname, '..');
    const bad = skillsInvokingSyncedTooling(root)
      .map(s => checkSkill(root, s))
      .filter(r => r.status !== 'ok');
    assert.deepEqual(bad, []);
  });

  test('the subject set is non-empty', () => {
    // Guards the vacuous pass: if the detector silently stopped matching,
    // every assertion above would still be green over an empty set.
    const root = path.resolve(import.meta.dirname, '..');
    assert.ok(skillsInvokingSyncedTooling(root).length >= 10);
  });
});

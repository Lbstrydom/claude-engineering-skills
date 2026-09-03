/**
 * @fileoverview Gate 9 — an inert SKILL.md frontmatter declaration in a
 * consumer's `.claude/skills/`, and the doctor probe that surfaces it.
 *
 * THE BLIND SPOT THIS LOCKS (measured 2026-09-03). A consumer's
 * `.claude/skills/audit/SKILL.md` — a skill this bundle retired in April, left
 * on disk because the sync never deletes — carried `disable-model-invocation:
 * true` indented inside `description: |`. Gate 2B hashes owned files (fine —
 * this one is not owned), gate 2C walks `scripts/.claude-skills/` only, gate 8
 * asks about OTHER roots. Nothing consumer-side read the frontmatter, so a
 * declared restriction had silently stopped applying and no gate could say so.
 *
 * Gate 9 fails on owned AND foreign skill dirs — an inert declaration is never
 * harmless — but only for the inert-declaration kinds on foreign ones; a
 * frontmatter-less consumer skill is `unverifiable`, reported, never failed.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { _internals, ALL_GATES, runGates } from '../scripts/lib/sync-isolation-verify.mjs';
import { hashFile } from '../scripts/lib/sync-manifest.mjs';
import { REGISTRY } from '../scripts/lib/doctor/registry.mjs';

const { gate9, gate2B, gate8, ownedSkillNamesFromManifest } = _internals;
const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const poison = fs.readFileSync(path.join(REPO_ROOT, 'tests', 'fixtures', 'poison', 'skill-frontmatter-indented-key.md'), 'utf-8');
const dedented = poison.replace(/^ {2}disable-model-invocation: true$/m, 'disable-model-invocation: true');

let root;
const write = (rel, body) => {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  return abs;
};
const manifestFor = (rels) => {
  const files = {};
  for (const rel of rels) files[rel] = hashFile(path.join(root, rel));
  return { files };
};
const ownedSkill = (name, body) => {
  write(`.claude/skills/${name}/SKILL.md`, body);
  return `.claude/skills/${name}/SKILL.md`;
};
const goodSkill = (name) => `---\nname: ${name}\ndescription: |\n  Fine.\ndisable-model-invocation: true\n---\n\n# ${name}\n`;

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'iso-fm9-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

describe('gate 9 — inert frontmatter declaration in .claude/skills/', () => {
  it('FAILS on a retired, consumer-resident skill carrying the real inert fixture (the measured case)', () => {
    const manifest = manifestFor([ownedSkill('ship', goodSkill('ship'))]);
    write('.claude/skills/audit/SKILL.md', poison);        // not in the manifest — retired upstream

    const res = gate9(root, manifest);
    assert.equal(res.pass, false);
    assert.match(res.error, /1 inert frontmatter declaration/);
    assert.match(res.error, /\.claude\/skills\/audit\/SKILL\.md:12/);
    assert.match(res.error, /`disable-model-invocation:`/);
    assert.match(res.error, /dedent the key to column 0/);
    assert.match(res.error, /delete the directory if the skill is no longer shipped/);
    assert.equal(res.details.checked, 2);
    assert.equal(res.details.ownedSkills, 1);
    assert.deepEqual(res.details.owned, []);
    assert.deepEqual(res.details.foreign.map((f) => [f.skill, f.kind, f.line]), [['audit', 'indented-known-key', 12]]);
  });

  it('gates 2B and 8 are BLIND to that same file (the gate is not redundant)', () => {
    const manifest = manifestFor([ownedSkill('ship', goodSkill('ship'))]);
    write('.claude/skills/audit/SKILL.md', poison);
    assert.equal(gate2B(root, manifest).pass, true, '2B iterates manifest entries; audit is not one');
    assert.equal(gate8(root, manifest).pass, true, '8 asks about .github/.agents roots, not .claude/skills content');
  });

  it('FAILS on an owned skill and says "re-sync" — the bundle itself shipped the defect', () => {
    const manifest = manifestFor([ownedSkill('audit', poison)]);
    const res = gate9(root, manifest);
    assert.equal(res.pass, false);
    assert.match(res.error, /re-sync for the bundle-owned file/);
    assert.deepEqual(res.details.owned.map((f) => [f.skill, f.kind]), [['audit', 'indented-known-key']]);
    assert.deepEqual(res.details.foreign, []);
  });

  it('PASSES the same tree once the key is dedented (positive control on the fix)', () => {
    const manifest = manifestFor([ownedSkill('ship', goodSkill('ship'))]);
    write('.claude/skills/audit/SKILL.md', dedented);
    const res = gate9(root, manifest);
    assert.equal(res.pass, true, res.error);
    assert.deepEqual(res.details, { checked: 2, ownedSkills: 1, owned: [], foreign: [], unverifiable: [] });
  });

  it('a frontmatter-less CONSUMER skill is unverifiable, reported, and does not fail the gate', () => {
    const manifest = manifestFor([ownedSkill('ship', goodSkill('ship'))]);
    write('.claude/skills/their-tool/SKILL.md', '# Their skill, no frontmatter\n');
    const res = gate9(root, manifest);
    assert.equal(res.pass, true, res.error);
    assert.deepEqual(res.details.unverifiable.map((f) => [f.skill, f.kind]), [['their-tool', 'no-frontmatter']]);
  });

  it('a frontmatter-less OWNED skill DOES fail — ours must be verifiable', () => {
    const manifest = manifestFor([ownedSkill('ship', '# no frontmatter\n')]);
    const res = gate9(root, manifest);
    assert.equal(res.pass, false);
    assert.deepEqual(res.details.owned.map((f) => [f.skill, f.kind]), [['ship', 'no-frontmatter']]);
  });

  it('says what it checked when .claude/skills/ is absent or holds no skills — never a silent green', () => {
    const manifest = { files: {} };
    assert.deepEqual(gate9(root, manifest), { gate: '9', pass: true, details: { checked: 0, ownedSkills: 0, note: '.claude/skills/ absent' } });
    write('.claude/skills/.keep', '');
    assert.equal(gate9(root, manifest).details.note, '.claude/skills/ holds no <name>/SKILL.md');
  });

  it('ownedSkillNamesFromManifest derives names from manifest keys in either slash style', () => {
    const ours = ownedSkillNamesFromManifest({ files: {
      '.claude/skills/ship/SKILL.md': 'x', '.claude\\skills\\plan\\references\\a.md': 'y', 'scripts/.claude-skills/x.mjs': 'z',
    } });
    assert.deepEqual([...ours].sort(), ['plan', 'ship']);
    assert.equal(ownedSkillNamesFromManifest(null).size, 0);
  });
});

describe('gate 9 wiring', () => {
  it('is in ALL_GATES and dispatched by runGates', () => {
    assert.ok(ALL_GATES.includes('9'));
    const manifestRel = 'scripts/.sync-manifest.json';
    write('.claude/skills/audit/SKILL.md', poison);
    const files = { '.claude/skills/audit/SKILL.md': hashFile(path.join(root, '.claude/skills/audit/SKILL.md')) };
    write(manifestRel, JSON.stringify({ schemaVersion: 1, layout: 'isolated', files }));
    const results = runGates({ consumerRoot: root, gates: ['9'] });
    // Either the manifest schema accepted the minimal stub (gate 9 ran and failed
    // on the fixture) or it refused it (preflight). Both are a non-pass; what must
    // not happen is a silent pass or "unknown gate".
    assert.equal(results.length, 1);
    assert.equal(results[0].pass, false);
    assert.doesNotMatch(results[0].error || '', /unknown gate/);
  });

  it('the doctor surfaces it as a repo-class probe with an actionable fix', () => {
    const probe = REGISTRY.find((p) => p.id === 'sync/skill-frontmatter-layout');
    assert.ok(probe, 'probe not registered');
    assert.equal(probe.class, 'repo');
    assert.match(probe.title, /sync gate 9/);
    assert.match(probe.fix, /column 0/);
    assert.match(probe.fix, /delete the directory/);
  });
});

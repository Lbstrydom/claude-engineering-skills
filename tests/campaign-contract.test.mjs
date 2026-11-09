/**
 * Campaign contract presence check + close-out evidence verification
 * (docs/plans/test-campaign-controls.md §2.4, §7.3).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  CAMPAIGN_SECTIONS, checkCampaignContract, verifyEvidenceAtRevision, isCampaignPlan, isContainedRelativePath,
} from '../scripts/lib/campaign-contract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'scripts', 'campaign-contract-check.mjs');
const DOC = path.join(ROOT, 'skills', 'plan', 'references', 'campaign.md');

const VALUES = {
  bound: '0 errors in 50 hits ⇒ lower bound 94.2%', items: '5', evidence: 'docs/evidence/rehearsal.md',
  'done-evidence': 'docs/evidence/rehearsal.md, docs/evidence/result.md',
};
function fullPlan(override = {}) {
  const out = ['# Plan: fixture', '', '- **Mode**: campaign', '', '## Campaign Contract', ''];
  for (const [id, spec] of Object.entries(CAMPAIGN_SECTIONS)) {
    if (override.dropSection === id) continue;
    out.push(`### ${id} — ${spec.title}`);
    for (const f of spec.fields) {
      const key = `${id}.${f}`;
      if (override.dropField === key) continue;
      const v = key in (override.values || {}) ? override.values[key] : (VALUES[f] ?? `the ${f}`);
      out.push(`- **${f}**: ${v}`);
    }
    out.push('');
  }
  if (override.dup) out.push(`### ${override.dup} — duplicate`, '- **x**: y', '');
  out.push('## 9. Audit Trail', '- **decision**: not part of the contract');
  return out.join('\n');
}
const ids = (r) => r.problems.map((p) => `${p.id}${p.field ? `.${p.field}` : ''}`);

describe('presence check', () => {
  it('a complete contract passes', () => {
    const r = checkCampaignContract(fullPlan(), { repoRoot: ROOT });
    assert.deepEqual(r.problems, []);
    assert.ok(isCampaignPlan(fullPlan()));
  });
  it('no contract section ⇒ one problem', () => {
    assert.deepEqual(ids(checkCampaignContract('# plan\n\n- **Mode**: campaign\n')), ['contract']);
  });
  it('each section removed is reported by id', () => {
    for (const id of Object.keys(CAMPAIGN_SECTIONS)) assert.deepEqual(ids(checkCampaignContract(fullPlan({ dropSection: id }), { repoRoot: ROOT })), [id], id);
  });
  it('each required field missing, empty or TBD is reported', () => {
    for (const [id, spec] of Object.entries(CAMPAIGN_SECTIONS)) {
      for (const f of spec.fields) {
        assert.deepEqual(ids(checkCampaignContract(fullPlan({ dropField: `${id}.${f}` }), { repoRoot: ROOT })), [`${id}.${f}`]);
        assert.deepEqual(ids(checkCampaignContract(fullPlan({ values: { [`${id}.${f}`]: 'TBD' } }), { repoRoot: ROOT })), [`${id}.${f}`]);
      }
    }
  });
  it('C3 bound without a number, C7 items below 5 or not an integer', () => {
    assert.deepEqual(ids(checkCampaignContract(fullPlan({ values: { 'C3.bound': 'probably fine' } }), { repoRoot: ROOT })), ['C3.bound']);
    for (const bad of ['3', 'five', '5.5']) assert.deepEqual(ids(checkCampaignContract(fullPlan({ values: { 'C7.items': bad } }), { repoRoot: ROOT })), ['C7.items'], bad);
  });
  it('evidence must be a repo-relative path inside the repo', () => {
    for (const bad of ['/etc/passwd', 'C:\\x\\y.md', '../outside.md', 'docs/../../x.md', 'docs/temp/../result.md']) {
      assert.deepEqual(ids(checkCampaignContract(fullPlan({ values: { 'C7.evidence': bad } }), { repoRoot: ROOT })), ['C7.evidence'], bad);
    }
    assert.equal(isContainedRelativePath('docs/x.md', ROOT), true);
    for (const empty of [',', ' , , ', '``']) assert.deepEqual(ids(checkCampaignContract(fullPlan({ values: { 'C11.done-evidence': empty } }), { repoRoot: ROOT })), ['C11.done-evidence'], empty);
  });
  it('a duplicate section is reported', () => {
    assert.ok(ids(checkCampaignContract(fullPlan({ dup: 'C4' }), { repoRoot: ROOT })).includes('C4'));
  });
  it('fields outside the contract section are ignored', () => {
    // the Audit Trail's "- **decision**:" line must not satisfy C1
    assert.deepEqual(ids(checkCampaignContract(fullPlan({ dropField: 'C1.decision' }), { repoRoot: ROOT })), ['C1.decision']);
  });
});

describe('campaign.md ⇔ CAMPAIGN_SECTIONS (both directions)', () => {
  const doc = fs.readFileSync(DOC, 'utf-8');
  const docSections = [...doc.matchAll(/^### (C\d+) — (.+)$/gm)].map((m) => [m[1], m[2].trim()]);
  it('every code section is documented with its title, and every documented section is in code', () => {
    assert.deepEqual(docSections.map(([id]) => id), Object.keys(CAMPAIGN_SECTIONS));
    for (const [id, title] of docSections) assert.equal(title, CAMPAIGN_SECTIONS[id].title, id);
  });
  it('every documented field is required by code, and vice versa', () => {
    const parts = doc.split(/^### (C\d+) — .+$/m);
    for (let i = 1; i < parts.length; i += 2) {
      const id = parts[i];
      const body = parts[i + 1].split(/^## /m)[0];
      const docFields = [...body.matchAll(/^- \*\*([a-z][a-z0-9-]*)\*\*:/gm)].map((m) => m[1]);
      assert.deepEqual(docFields, CAMPAIGN_SECTIONS[id].fields, id);
    }
  });
});

describe('--closeout (temp git repo)', () => {
  const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  function repo() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-'));
    sh(d, 'init', '-q', '-b', 'main');
    sh(d, 'config', 'user.email', 't@example.com');
    sh(d, 'config', 'user.name', 't');
    sh(d, 'config', 'core.autocrlf', 'false');
    fs.mkdirSync(path.join(d, 'docs', 'evidence'), { recursive: true });
    fs.writeFileSync(path.join(d, 'README.md'), 'x\n');
    sh(d, 'add', 'README.md');
    sh(d, 'commit', '-q', '-m', 'init');
    return d;
  }
  const plan = fullPlan({ values: { 'C7.evidence': 'docs/evidence/r.md', 'C8.evidence': 'docs/evidence/r.md', 'C11.done-evidence': 'docs/evidence/r.md' } });

  it('untracked evidence ⇒ problem', () => {
    const d = repo();
    fs.writeFileSync(path.join(d, 'docs/evidence/r.md'), 'rehearsal\n');
    assert.equal(verifyEvidenceAtRevision(plan, { repoRoot: d, rev: 'main' }).ok, false);
  });
  it('committed only on a branch ⇒ problem at the base rev, ok at the branch', () => {
    const d = repo();
    sh(d, 'checkout', '-q', '-b', 'feat');
    fs.writeFileSync(path.join(d, 'docs/evidence/r.md'), 'rehearsal\n');
    sh(d, 'add', 'docs/evidence/r.md');
    sh(d, 'commit', '-q', '-m', 'evidence');
    assert.equal(verifyEvidenceAtRevision(plan, { repoRoot: d, rev: 'main' }).ok, false);
    const r = verifyEvidenceAtRevision(plan, { repoRoot: d, rev: 'feat' });
    assert.equal(r.ok, true, JSON.stringify(r.problems));
    const hash = r.artifacts[0].sha256;
    fs.writeFileSync(path.join(d, 'docs/evidence/r.md'), 'edited in the working tree\n');
    assert.equal(verifyEvidenceAtRevision(plan, { repoRoot: d, rev: 'feat' }).artifacts[0].sha256, hash, 'committed content, not the working tree');
  });
  it('a committed symlink, or an empty file, is not evidence', () => {
    const d = repo();
    fs.writeFileSync(path.join(d, 'docs/evidence/real.md'), 'x\n');
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: d, input: 'real.md', encoding: 'utf-8' }).trim();
    sh(d, 'update-index', '--add', '--cacheinfo', `120000,${blob},docs/evidence/r.md`);
    sh(d, 'commit', '-q', '-m', 'symlink');
    const r = verifyEvidenceAtRevision(plan, { repoRoot: d, rev: 'main' });
    assert.equal(r.ok, false);
    assert.match(r.problems[0].why, /not a regular file/);
  });
  it('a ./-prefixed or doubled-separator path names the same committed file', () => {
    const d = repo();
    fs.writeFileSync(path.join(d, 'docs/evidence/r.md'), 'rehearsal\n');
    sh(d, 'add', 'docs/evidence/r.md');
    sh(d, 'commit', '-q', '-m', 'evidence');
    const variants = fullPlan({ values: { 'C7.evidence': './docs/evidence/r.md', 'C8.evidence': 'docs//evidence/r.md', 'C11.done-evidence': String.raw`docs\evidence\r.md` } });
    assert.deepEqual(checkCampaignContract(variants, { repoRoot: d }).problems, []);
    const r = verifyEvidenceAtRevision(variants, { repoRoot: d, rev: 'main' });
    assert.equal(r.ok, true, JSON.stringify(r.problems));
    assert.equal(new Set(r.artifacts.map((a) => a.path)).size, 1);
  });
  it('a directory path is not evidence, even though ls-tree lists its children', () => {
    const d = repo();
    fs.writeFileSync(path.join(d, 'docs/evidence/r.md'), 'rehearsal\n');
    sh(d, 'add', 'docs/evidence/r.md');
    sh(d, 'commit', '-q', '-m', 'evidence');
    const dirPlan = fullPlan({ values: { 'C7.evidence': 'docs/evidence/', 'C8.evidence': 'docs/evidence/r.md', 'C11.done-evidence': 'docs/evidence/r.md' } });
    const r = verifyEvidenceAtRevision(dirPlan, { repoRoot: d, rev: 'main' });
    assert.equal(r.ok, false, 'the returned entry (docs/evidence/r.md) is not the requested path');
  });
  it('a glob in an evidence path is literal, never a pathspec match', () => {
    const d = repo();
    fs.writeFileSync(path.join(d, 'docs/evidence/r.md'), 'rehearsal\n');
    sh(d, 'add', 'docs/evidence/r.md');
    sh(d, 'commit', '-q', '-m', 'evidence');
    const globPlan = fullPlan({ values: { 'C7.evidence': 'docs/evidence/r*.md', 'C8.evidence': 'docs/evidence/r.md', 'C11.done-evidence': 'docs/evidence/r.md' } });
    const r = verifyEvidenceAtRevision(globPlan, { repoRoot: d, rev: 'main' });
    assert.equal(r.ok, false);
    assert.match(r.problems[0].why, /r*.md/);
  });
  it('a git failure while inspecting the tree is "unverified", never "not committed"', () => {
    const d = repo();
    const oid = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: d, encoding: 'utf-8' }).trim();
    // corrupt the commit's tree object so ls-tree fails after rev-parse succeeded
    const tree = execFileSync('git', ['rev-parse', `${oid}^{tree}`], { cwd: d, encoding: 'utf-8' }).trim();
    const obj = path.join(d, '.git', 'objects', tree.slice(0, 2), tree.slice(2));
    fs.chmodSync(obj, 0o644);
    fs.writeFileSync(obj, 'not a zlib object');
    const r = verifyEvidenceAtRevision(plan, { repoRoot: d, rev: oid });
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((x) => /could not inspect/.test(x.why)), JSON.stringify(r.problems));
  });
  it('an escaping evidence path outside the contract fields is reported by closeout, never skipped', () => {
    const d = repo();
    const extra = plan.replace('### C9 — Contract epoch', '### C9 — Contract epoch\n- **evidence**: /etc/passwd');
    const r = verifyEvidenceAtRevision(extra, { repoRoot: d, rev: 'main' });
    assert.ok(r.problems.some((p) => p.id === 'C9' && /not a repo-relative path/.test(p.why)), JSON.stringify(r.problems));
  });
  it('an unresolvable rev ⇒ problem, never a pass', () => {
    assert.equal(verifyEvidenceAtRevision(plan, { repoRoot: repo(), rev: 'nope' }).ok, false);
  });
});

describe('CLI exit codes', () => {
  const run = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf-8', cwd: ROOT });
  it('0 complete, 1 problems, 2 unreadable / bad usage', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-cli-'));
    const good = path.join(d, 'good.md');
    const bad = path.join(d, 'bad.md');
    fs.writeFileSync(good, fullPlan());
    fs.writeFileSync(bad, fullPlan({ dropSection: 'C7' }));
    assert.equal(run([good]).status, 0);
    const r = run([bad, '--json']);
    assert.equal(r.status, 1);
    assert.deepEqual(JSON.parse(r.stdout).problems.map((p) => p.id), ['C7']);
    assert.equal(run([path.join(d, 'missing.md')]).status, 2);
    assert.equal(run([]).status, 2);
    assert.equal(run([good, '--bogus']).status, 2);
  });
});

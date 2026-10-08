/**
 * @fileoverview /fleet — consumer report 2026-10-08 (capstone repo, bundle 34e896d8):
 *   1. a local base that TRAILS its upstream produced phantom overlaps and a false
 *      BLOCK; overlaps are now measured from the fresher of local and upstream, and
 *      a remote-tracking `baseBranch` (`origin/main`) is refused, not half-accepted;
 *   2. the participant block carries the hydrate step a fresh worktree needs;
 *   3. `runIn: ["ready"]` lets a repo-owned check refuse `fleet ready`.
 * Each behaviour has its negative control beside it (the instrument must be able to fail).
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git } from './helpers/git.mjs';
import {
  cleanupFleetRoots, commitFile, makeFleetRepo, runFleet, scrubbedEnv, writeFile,
} from './helpers/fleet-repo.mjs';
import { resolveMeasurementBase } from '../scripts/lib/fleet/git-facts.mjs';
import { ConfigError, resolveConfig } from '../scripts/lib/fleet/config.mjs';
import { renderParticipantRules } from '../scripts/lib/fleet/render-train.mjs';
import { describeMeasurement } from '../scripts/lib/fleet/render.mjs';

after(cleanupFleetRoots);

const RULES_MD = path.resolve(import.meta.dirname, '..', 'skills', 'fleet', 'references', 'participant-rules.md');

function fixture(opts) {
  const fx = makeFleetRepo(opts);
  const env = scrubbedEnv({ FLEET_WORKTREE_ROOT: fx.wtRoot });
  const f = (args) => runFleet(args, { cwd: fx.repo, env });
  return { fx, env, f };
}

/** origin/main gains two docs commits; local main is reset back, so it trails by 2. */
function trailingBase(s) {
  const old = git(['rev-parse', 'HEAD'], s.fx.repo);
  commitFile(s.fx.repo, 'docs/guide.md', 'guide\n');
  commitFile(s.fx.repo, 'docs/faq.md', 'faq\n');
  git(['push', '-q', 'origin', 'main'], s.fx.repo);
  git(['reset', '-q', '--hard', old], s.fx.repo);
  return old;
}

/** A branch cut from origin/main (as a fresh session's would be), with one commit; stays checked out. */
function branchFromUpstream(s, name, files) {
  git(['checkout', '-q', '-b', name, 'origin/main'], s.fx.repo);
  for (const [rel, body] of Object.entries(files)) commitFile(s.fx.repo, rel, body);
}

describe('1. overlaps are measured from the fresher of the local base and its upstream', () => {
  it('a local base that trails origin no longer blocks a legitimate claim (the reported false BLOCK)', () => {
    const s = fixture();
    trailingBase(s);
    branchFromUpstream(s, 'other', { 'other/x.txt': 'x\n' });
    assert.equal(s.f(['claim', '--id', 'other', '--intent', 'other work', '--paths', 'other/**']).status, 0);
    branchFromUpstream(s, 'mine', {});
    const r = s.f(['claim', '--id', 'mine', '--intent', 'write the docs', '--paths', 'docs/**', '--json']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.json.verdict, 'ok');
    const st = s.f(['status', '--json']).json;
    const other = st.status.items.find((i) => i.id === 'other');
    assert.deepEqual(other.changedFiles, ['other/x.txt'], 'upstream commits are not the branch\'s own changes');
    assert.equal(st.status.base.measure.relation, 'local-trails');
    assert.equal(st.status.base.measure.behindBy, 2);
  });

  it('control: a REAL overlap with the same trailing base still blocks, and names what it measured from', () => {
    const s = fixture();
    trailingBase(s);
    branchFromUpstream(s, 'other', { 'docs/guide.md': 'rewritten\n' });
    assert.equal(s.f(['claim', '--id', 'other', '--intent', 'other work', '--paths', 'other/**']).status, 0);
    branchFromUpstream(s, 'mine', {});
    const r = s.f(['claim', '--id', 'mine', '--intent', 'write the docs', '--paths', 'docs/**']);
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.match(r.stdout, /BLOCKED/);
    assert.match(r.stdout, /docs\/guide\.md/);
    assert.doesNotMatch(r.stdout, /docs\/faq\.md/, 'only the real overlap is named');
    assert.match(r.stdout, /overlaps measured from origin\/main @ [0-9a-f]{12} \(local main trails it by 2\)/);
  });

  it('the startOid recorded by claim is the fork point on the upstream, not the stale local tip', () => {
    const s = fixture();
    const stale = trailingBase(s);
    branchFromUpstream(s, 'mine', { 'mine/a.txt': 'a\n' });
    const r = s.f(['claim', '--id', 'mine', '--intent', 'x', '--paths', 'mine/**', '--json']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.json.record.startOid, git(['rev-parse', 'origin/main'], s.fx.repo));
    assert.notEqual(r.json.record.startOid, stale);
  });

  describe('resolveMeasurementBase — every relation, against a real repo', () => {
    it('same / local-trails / local-ahead / diverged / local-only', () => {
      const s = fixture();
      const m = () => resolveMeasurementBase(s.fx.repo, { base: 'main', upstream: 'origin/main' });
      assert.equal(m().relation, 'same');
      assert.equal(m().source, 'local');

      const old = trailingBase(s);
      assert.deepEqual([m().relation, m().source, m().behindBy, m().oid], ['local-trails', 'upstream', 2, git(['rev-parse', 'origin/main'], s.fx.repo)]);

      git(['reset', '-q', '--hard', 'origin/main'], s.fx.repo);
      commitFile(s.fx.repo, 'local.txt', 'l\n');
      assert.deepEqual([m().relation, m().source], ['local-ahead', 'local'], 'unpushed base commits keep the local base');

      git(['reset', '-q', '--hard', old], s.fx.repo);
      commitFile(s.fx.repo, 'fork.txt', 'f\n');
      assert.deepEqual([m().relation, m().source], ['diverged', 'local']);
      assert.match(describeMeasurement(m(), 'main'), /DIVERGED.*may be phantom/);

      assert.equal(resolveMeasurementBase(s.fx.repo, { base: 'main', upstream: null }).relation, 'local-only');
      assert.equal(resolveMeasurementBase(s.fx.repo, { base: 'main', upstream: 'origin/nope' }).relation, 'local-only');
    });

    it('upstream-only when there is no local base branch; unresolvable when neither exists', () => {
      const s = fixture();
      git(['checkout', '-q', '--detach'], s.fx.repo);
      git(['branch', '-q', '-D', 'main'], s.fx.repo);
      const m = resolveMeasurementBase(s.fx.repo, { base: 'main', upstream: 'origin/main' });
      assert.deepEqual([m.relation, m.source, m.ref], ['upstream-only', 'upstream', 'origin/main']);
      const none = resolveMeasurementBase(s.fx.repo, { base: 'nope', upstream: 'origin/nope' });
      assert.deepEqual([none.ok, none.kind], [false, 'base-unresolvable']);
    });

    it('a git FAILURE is not an absence: it never silently selects the other ref', () => {
      const fake = (args) => (args[3].startsWith('refs/heads/')
        ? { ok: false, status: 128, stdout: '', reason: 'fatal: broken' }
        : { ok: true, status: 0, stdout: `${'a'.repeat(40)}\n` });
      const m = resolveMeasurementBase('/x', { base: 'main', upstream: 'origin/main' }, { git: fake });
      assert.deepEqual([m.ok, m.kind], [false, 'git-error']);
      assert.match(m.reason, /refs\/heads\/main/);
    });

    it('git could not compare the two (ancestry query failed) => local, reported as unknown', () => {
      const fake = (args) => {
        if (args[0] === 'rev-parse') return { ok: true, status: 0, stdout: `${args[3].includes('heads') ? 'a'.repeat(40) : 'b'.repeat(40)}\n` };
        return { ok: false, status: 128, stdout: '', reason: 'fatal' };
      };
      const m = resolveMeasurementBase('/x', { base: 'main', upstream: 'origin/main' }, { git: fake });
      assert.deepEqual([m.relation, m.source], ['unknown', 'local']);
      assert.match(describeMeasurement(m, 'main'), /may be phantom/);
    });
  });

  it('describeMeasurement says nothing when the local base is current or ahead', () => {
    for (const relation of ['same', 'local-ahead', 'local-only']) assert.equal(describeMeasurement({ ok: true, relation }), null, relation);
    assert.equal(describeMeasurement(null), null);
  });

  it('baseBranch "origin/main" is refused at config time, naming the branch to write instead', () => {
    const s = fixture({ fleetConfig: { baseBranch: 'origin/main' } });
    assert.throws(() => resolveConfig(s.fx.repo, { env: s.env }), (e) => e instanceof ConfigError && /remote-tracking ref, not a branch — set it to "main"/.test(e.message));
    const r = s.f(['claim', '--id', 'x', '--intent', 'x', '--paths', 'x/**']);
    assert.equal(r.status, 1, 'claim no longer half-accepts it');
    assert.match(r.stderr + r.stdout, /set it to "main"/);
    // control: the branch name itself is accepted
    writeFile(s.fx.repo, '.fleet.json', JSON.stringify({ baseBranch: 'main' }));
    assert.equal(resolveConfig(s.fx.repo, { env: s.env }).baseBranch, 'main');
  });
});

describe('2. the participant block carries the hydrate step', () => {
  it('rendered block: step 0 hydrates, before the claim step', () => {
    const rules = renderParticipantRules('node scripts/.claude-skills/fleet.mjs');
    const hydrate = rules.indexOf('npm run skills:hydrate');
    assert.ok(hydrate > 0, rules);
    assert.ok(hydrate < rules.indexOf('claim --id'), 'hydrate comes before claim');
  });
  it('reference block: step 0 hydrates, before register', () => {
    const md = fs.readFileSync(RULES_MD, 'utf-8');
    const block = md.slice(md.indexOf('```'), md.lastIndexOf('```'));
    assert.ok(block.indexOf('npm run skills:hydrate') > 0);
    assert.ok(block.indexOf('npm run skills:hydrate') < block.indexOf('claim --id'));
  });
});

describe('3. runIn: ["ready"] lets a check refuse `fleet ready`', () => {
  const script = (findings) => `
    let d = ''; process.stdin.on('data', (c) => { d += c; }).on('end', () => {
      require('node:fs').writeFileSync(${JSON.stringify('payload.json')}, d);
      process.stdout.write(JSON.stringify({ schemaVersion: 1, findings: ${JSON.stringify(findings)} }));
    });`;
  function readySetup(findings, runIn) {
    const s = fixture({ fleetConfig: { checks: [{ name: 'bundle', script: 'chk.cjs', severity: 'block', runIn }] } });
    writeFile(s.fx.repo, 'chk.cjs', script(findings));
    git(['checkout', '-q', '-b', 'feat'], s.fx.repo);
    const oid = commitFile(s.fx.repo, 'feat/a.txt', 'a\n');
    assert.equal(s.f(['claim', '--id', 'feat', '--intent', 'x', '--paths', 'feat/**']).status, 0);
    return { s, oid };
  }
  const BLOCK = [{ level: 'block', message: 'bundle is stale' }];

  it('a block finding refuses the mark (exit 3) and the session is NOT ready', () => {
    const { s, oid } = readySetup(BLOCK, ['ready']);
    const r = s.f(['ready', '--id', 'feat']);
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.match(r.stdout, /NOT marked ready/);
    assert.match(r.stdout, /bundle is stale/);
    const st = s.f(['status', '--json']).json.status.items.find((i) => i.id === 'feat');
    assert.notEqual(st.state, 'ready');
    const payload = JSON.parse(fs.readFileSync(path.join(s.fx.repo, 'payload.json'), 'utf-8'));
    assert.equal(payload.phase, 'ready');
    assert.deepEqual([payload.sessions.length, payload.sessions[0].id, payload.sessions[0].oid], [1, 'feat', oid]);
    assert.deepEqual(payload.sessions[0].changedFiles, ['feat/a.txt']);
  });

  it('control: a warn finding is disclosed and the mark is made', () => {
    const { s } = readySetup([{ level: 'warn', message: 'audit is old' }], ['ready']);
    const r = s.f(['ready', '--id', 'feat']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^ready: feat/m);
    assert.match(r.stdout, /warn: \[bundle\] audit is old/);
  });

  it('control: the same blocking check NOT listed for ready does not run at ready (opt-in)', () => {
    const { s } = readySetup(BLOCK, ['status', 'land']);
    const r = s.f(['ready', '--id', 'feat']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(fs.existsSync(path.join(s.fx.repo, 'payload.json')), false, 'the hook never ran');
  });
});

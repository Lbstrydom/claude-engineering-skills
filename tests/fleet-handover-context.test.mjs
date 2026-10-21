/**
 * @fileoverview The coordinator-context file and the wind-down gate (docs/plans/fleet-handover-winddown.md §2.1 to §2.3, D1):
 * section judgement, the prepare refusal and its recorded waiver, the context embedded in the handover and printed FIRST by
 * receive, and one context per switch. Every "does not" case has a control that fires the other way.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git } from './helpers/git.mjs';
import { cleanupFleetRoots, makeFleetRepo, runFleet, scrubbedEnv, tmpRoot } from './helpers/fleet-repo.mjs';
import { CONTEXT_PLACEHOLDER, CONTEXT_SECTIONS, contextPath, contextReasons, contextSkeleton, judgeSections } from '../scripts/lib/fleet/handover-context.mjs';

after(cleanupFleetRoots);

const filled = (over = {}) => CONTEXT_SECTIONS.map((n) => `## ${n}\n\n${over[n] ?? 'none'}\n`).join('\n');

describe('judgeSections', () => {
  it('the skeleton is all placeholder; the markers deleted with nothing written is all empty (neither reads as written)', () => {
    const skeleton = judgeSections(contextSkeleton('/r/demo'));
    assert.deepEqual([...new Set(Object.values(skeleton))], ['placeholder']);
    assert.equal(Object.keys(skeleton).length, CONTEXT_SECTIONS.length);
    const stripped = contextSkeleton('/r/demo').split(CONTEXT_PLACEHOLDER).join('');
    assert.deepEqual([...new Set(Object.values(judgeSections(stripped)))], ['empty']);
  });
  it('a comment-only or whitespace-only body is empty; an explicit none, or any text, is filled (control)', () => {
    const j = judgeSections(filled({ 'Peer handovers': '<!-- later -->', 'Waiting on the user': '   \n  ', 'Working-style notes': 'one line status notes', 'CI state at the switch': 'None' }));
    assert.equal(j['Peer handovers'], 'empty');
    assert.equal(j['Waiting on the user'], 'empty');
    assert.equal(j['Working-style notes'], 'filled');
    assert.equal(j['CI state at the switch'], 'filled');
    assert.equal(j['In flight (repo state)'], 'filled');
  });
  it('H2/M7: headings inside an HTML comment or a fenced block are not sections; the effective document is judged (control: the same text uncommented)', () => {
    const all = CONTEXT_SECTIONS.map((n) => `## ${n}\n\nnone\n`).join('\n');
    const hidden = judgeSections(`<!--\n${all}\n-->\n`);
    assert.deepEqual([...new Set(Object.values(hidden))], ['missing'], 'a required heading that exists only inside a comment is missing');
    const fenced = judgeSections(`\`\`\`\n${all}\n\`\`\`\n`);
    assert.deepEqual([...new Set(Object.values(fenced))], ['missing'], 'nor one inside a fenced code block');
    assert.deepEqual([...new Set(Object.values(judgeSections(all)))], ['filled'], 'control: uncommented, unfenced, the same text is complete');
    const partial = judgeSections(all.replace('## Working-style notes\n\nnone', '<!-- ## Working-style notes -->\nnone'));
    assert.equal(partial['Working-style notes'], 'missing');
    // a fence closes only on the same character, at least as long: three backticks do not end a four-backtick fence, tildes do not end a backtick one
    const long = judgeSections(`\`\`\`\`\n\`\`\`\n${all}\n\`\`\`\`\n`);
    assert.deepEqual([...new Set(Object.values(long))], ['missing'], 'a shorter fence inside a longer one does not close it');
    const mixed = judgeSections(`\`\`\`\n~~~\n${all}\n\`\`\`\n`);
    assert.deepEqual([...new Set(Object.values(mixed))], ['missing'], 'a tilde fence does not close a backtick fence');
    const after = judgeSections(`\`\`\`\ncode\n\`\`\`\n${all}`);
    assert.deepEqual([...new Set(Object.values(after))], ['filled'], 'control: once properly closed, the headings after it count');
  });
  it('a section with no heading is missing, and reasons name every section that is not filled', () => {
    const text = filled().replace('## In-session timers\n\nnone\n', '');
    const j = judgeSections(text);
    assert.equal(j['In-session timers'], 'missing');
    const reasons = contextReasons({ state: 'ok', sections: j });
    assert.match(reasons[0], /incomplete: In-session timers \(missing\)/);
    assert.deepEqual(contextReasons({ state: 'ok', sections: judgeSections(filled()) }), [], 'control: complete is ready');
  });
  it('absent, unreadable and too-large are named states, never an empty context; a stale one names the handover', () => {
    assert.deepEqual(contextReasons({ state: 'absent' }), ['coordinator context missing']);
    assert.match(contextReasons({ state: 'unreadable', reason: 'EACCES' })[0], /unreadable \(EACCES\)/);
    assert.match(contextReasons({ state: 'too-large', bytes: 70000 })[0], /70000 bytes/);
    assert.match(contextReasons({ state: 'ok', sections: judgeSections(filled()) }, '20261021T080000000Z-aaaaaa')[0], /identical to the one handed over in 20261021T080000000Z-aaaaaa/);
  });
});

describe('the wind-down gate and the context through the CLI', () => {
  const envFor = (cfg) => scrubbedEnv({ FLEET_TELEMETRY: 'off', CLAUDE_CONFIG_DIR: cfg, CLAUDE_AUDIT_LOOP_DIR: '' });
  const cfgRoot = () => { const d = tmpRoot('wd-acct-'); fs.mkdirSync(path.join(d, 'projects'), { recursive: true }); return d; };
  const run = (fx, cfg, args) => runFleet([...args, '--json'], { cwd: fx.repo, env: envFor(cfg) });
  const writeCtx = (fx, text) => { const f = contextPath(fx.repo); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f; };

  it('D1: prepare without a context refuses (exit 3) naming the repo and the file, artefacts written; with a recorded waiver it passes and says so', () => {
    const fx = makeFleetRepo(); const A = cfgRoot();
    const r = run(fx, A, ['handover', 'prepare']);
    assert.equal(r.status, 3, r.stdout);
    assert.match(r.json.reason, /not ready: winddown incomplete in .*repo: coordinator context missing/);
    const manifest = JSON.parse(fs.readFileSync(r.json.handover.json, 'utf8'));
    assert.equal(manifest.winddown.ready, false);
    assert.equal(manifest.winddown.waived, undefined);
    const waived = run(fx, A, ['handover', 'prepare', '--winddown-waived', 'prepare at 2 percent of credits']);
    assert.equal(waived.status, 0, waived.stdout);
    const m2 = JSON.parse(fs.readFileSync(waived.json.handover.json, 'utf8'));
    assert.deepEqual([m2.winddown.ready, m2.winddown.waived], [false, 'prepare at 2 percent of credits'], 'the verdict stays truthful; the waiver is recorded beside it');
    assert.match(fs.readFileSync(waived.json.handover.md, 'utf8'), /\*\*WAIVED\*\*: prepare at 2 percent of credits/);
  });

  it('a blank waiver reason, or the flag on receive, is an argv error', () => {
    const fx = makeFleetRepo(); const A = cfgRoot();
    assert.equal(run(fx, A, ['handover', 'prepare', '--winddown-waived', '  ']).status, 2);
    assert.equal(run(fx, A, ['handover', 'receive', '--from', 'x.json', '--winddown-waived', 'y']).status, 2);
  });

  it('winddown writes a skeleton once and never overwrites it; an untouched skeleton is NOT ready, a complete context is', () => {
    const fx = makeFleetRepo(); const A = cfgRoot();
    const first = run(fx, A, ['handover', 'winddown']);
    assert.equal(first.status, 3, first.stdout);
    const file = contextPath(fx.repo);
    assert.ok(fs.existsSync(file), 'the skeleton was written');
    assert.match(first.json.text, /WIND-DOWN for repo/);
    assert.match(first.json.text, /touch --id <id> --waiting-on human:account-switch/);
    assert.match(first.json.text, /coordinator context incomplete: .*\(placeholder\)/);
    fs.appendFileSync(file, '\nmy own note\n');
    const before = fs.readFileSync(file, 'utf8');
    run(fx, A, ['handover', 'winddown']);
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'a second run left the coordinator\'s edits alone');
    writeCtx(fx, filled({ 'Decided this stint (do not re-ask)': 'WP6 spend approved' }));
    const ready = run(fx, A, ['handover', 'winddown']);
    assert.equal(ready.status, 0, ready.stdout);
    assert.match(ready.json.text, /winddown: READY/);
  });

  it('prepare embeds the context; receive prints it FIRST, before the destination and memory lines; an older manifest prints no such block (control)', () => {
    const fx = makeFleetRepo(); const A = cfgRoot();
    writeCtx(fx, filled({ 'Decided this stint (do not re-ask)': 'D-L1 runs Sol and Opus blind' }));
    const p = run(fx, A, ['handover', 'prepare']);
    assert.equal(p.status, 0, p.stdout);
    const manifest = JSON.parse(fs.readFileSync(p.json.handover.json, 'utf8'));
    assert.equal(manifest.scope.repos[0].context.state, 'ok');
    const md = fs.readFileSync(p.json.handover.md, 'utf8');
    assert.match(md, /## Coordinator context: .*repo/);
    assert.match(md, /D-L1 runs Sol and Opus blind/);
    assert.ok(md.indexOf('## Coordinator context') < md.indexOf('## Sessions to resume'), 'the context precedes the sessions');
    assert.doesNotMatch(md, /^## Waiting on the user/m, 'the embedded headings are demoted so they cannot break the outline');
    const r = run(fx, A, ['handover', 'receive', '--from', p.json.handover.json]);
    const text = r.json.text;
    assert.ok(text.indexOf('COORDINATOR CONTEXT') > 0 && text.indexOf('COORDINATOR CONTEXT') < text.indexOf('destination config root'), text.slice(0, 400));
    assert.match(text, /\| .*D-L1 runs Sol and Opus blind/);
    assert.equal(r.json.handover.contexts[0].state, 'ok');
    // control: a manifest written before the context existed still parses and prints no context block
    delete manifest.winddown; for (const repo of manifest.scope.repos) delete repo.context;
    const old = path.join(path.dirname(p.json.handover.json), 'handover-20991231T235959999Z-abcdef.json');
    fs.writeFileSync(old, JSON.stringify({ ...manifest, id: '20991231T235959999Z-abcdef' }));
    const r2 = run(fx, A, ['handover', 'receive', '--from', old, '--dry-run']);
    assert.doesNotMatch(r2.json.text, /COORDINATOR CONTEXT/);
    assert.ok([0, 3].includes(r2.status), r2.stdout);
  });

  it('H2: a context handed over and received is STALE for the next switch until it is edited; re-running prepare before receive never reads stale; a dry run records nothing', () => {
    const fx = makeFleetRepo(); const A = cfgRoot();
    const file = writeCtx(fx, filled());
    const p1 = run(fx, A, ['handover', 'prepare']);
    assert.equal(p1.status, 0, p1.stdout);
    assert.equal(run(fx, A, ['handover', 'prepare']).status, 0, 'a second prepare, before any receive, is not stale');
    const dry = run(fx, A, ['handover', 'receive', '--from', p1.json.handover.json, '--dry-run', '--allow-older']);
    assert.equal(fs.readdirSync(path.dirname(p1.json.handover.json)).filter((n) => n.endsWith('.received.json')).length, 0, 'a dry run is not a receive');
    assert.ok([0, 3].includes(dry.status));
    run(fx, A, ['handover', 'receive', '--from', p1.json.handover.json, '--allow-older']);
    assert.equal(fs.readdirSync(path.dirname(p1.json.handover.json)).filter((n) => n.endsWith('.received.json')).length, 1);
    const stale = run(fx, A, ['handover', 'winddown']);
    assert.equal(stale.status, 3);
    assert.match(stale.json.text, /identical to the one handed over in/);
    fs.appendFileSync(file, '\nNew decision this stint: none re-asked.\n');
    assert.equal(run(fx, A, ['handover', 'winddown']).status, 0, 'one deliberate edit makes it current');
  });

  it('R3-audit H1: a repo is its MAIN checkout whichever worktree runs the command, so the context and its staleness are shared across worktrees', () => {
    const fx = makeFleetRepo(); const A = cfgRoot(); const env = envFor(A);
    const wt = path.join(tmpRoot('wd-link-'), 'linked');
    git(['worktree', 'add', '-q', '-b', 'linked', wt, 'main'], fx.repo);
    // written through the main checkout's path, read and judged from the linked worktree
    writeCtx(fx, filled());
    const fromLinked = runFleet(['handover', 'winddown', '--json'], { cwd: wt, env });
    assert.equal(fromLinked.status, 0, fromLinked.stdout);
    assert.equal(fromLinked.json.winddown.repos[0].path, fx.repo, 'the repo is named by its main checkout');
    const p = runFleet(['handover', 'prepare', '--json'], { cwd: wt, env });
    assert.equal(p.status, 0, p.stdout);
    assert.equal(runFleet(['handover', 'receive', '--from', p.json.handover.json, '--allow-older', '--json'], { cwd: fx.repo, env }).json.ok !== undefined, true);
    const stale = runFleet(['handover', 'winddown', '--json'], { cwd: fx.repo, env });
    assert.equal(stale.status, 3, 'received through one worktree, stale when judged from another');
    assert.match(stale.json.text, /identical to the one handed over in/);
  });

  it('R2: a live claim not parked on the switch is NOT ready, naming it; parked, it is ready (control)', () => {
    const fx = makeFleetRepo(); const A = cfgRoot(); const env = envFor(A);
    writeCtx(fx, filled());
    const wt = path.join(tmpRoot('wd-wt-'), 'w1');
    git(['worktree', 'add', '-q', '-b', 'w1', wt, 'main'], fx.repo);
    assert.equal(runFleet(['claim', '--intent', 'w1', '--paths', 'a.txt'], { cwd: wt, env }).status, 0);
    const bad = run(fx, A, ['handover', 'winddown']);
    assert.equal(bad.status, 3);
    assert.match(bad.json.text, /1 live claim\(s\) not parked on human:account-switch: w1/);
    assert.equal(runFleet(['touch', '--id', 'w1', '--waiting-on', 'human:account-switch'], { cwd: wt, env }).status, 0);
    assert.equal(run(fx, A, ['handover', 'winddown']).status, 0);
  });
});

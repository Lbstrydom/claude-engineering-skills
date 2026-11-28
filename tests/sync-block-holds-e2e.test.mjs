/**
 * @fileoverview Block holds end to end, through the real `sync-to-repos.mjs`
 * CLI against a real git consumer (docs/plans/sync-skill-block-holds.md).
 *
 * Tier 3 (consumer sync contract): the unit suites prove the grammar, the
 * declaration checks and the decision table; this proves the WIRING, which is
 * where a block could still be dropped, double-spliced or refused wrongly:
 *
 *   1. a declared block is spliced into its slot, the manifest agrees with the
 *      disk, and the DEPLOYED verifier inside the consumer passes gate 2B;
 *   2. upstream content outside the slot flows into a block-held file (the
 *      requirement itself: a whole-file hold could not do this);
 *   3. editing the fragment flows in; hand-editing the spliced span is refused
 *      with a hint naming the fragment;
 *   4. a declared slot upstream lacks fails the file, leaves it byte-unchanged
 *      and exits non-zero; a declaration for a path never delivered does too;
 *   5. an anchor moved under another heading is reported;
 *   6. a whole-file hold migrates to a block hold only with consent bound to
 *      the held bytes, and never over uncommitted work.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';

import { seedInstalledDeps, runSyncCli, whySyncFailed, git, syncExecOptions } from './helpers/consumer-fixture.mjs';

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const NAV = '.claude/skills/nav-audit/SKILL.md';
const VA = '.claude/skills/visual-audit/SKILL.md';
const PLAN = '.claude/skills/plan/SKILL.md';
const FRAG = '.sync-blocks/nav-audit.target-adapter.md';
const START = '<!-- sync-slot:target-adapter:start';
const END = '<!-- sync-slot:target-adapter:end -->';

let tmp;
let consumer;
const stripAnsi = (t) => String(t).replace(/\u001B\[[0-9;]*m/g, '');
const abs = (rel) => path.join(consumer, rel);
const read = (rel) => fs.readFileSync(abs(rel), 'utf-8');
const write = (rel, body) => { fs.mkdirSync(path.dirname(abs(rel)), { recursive: true }); fs.writeFileSync(abs(rel), body, 'utf-8'); };
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const lastSync = () => JSON.parse(read('.sync-receipt.json')).recentSyncs[0];
const commit = (msg) => { git(['add', '-A'], consumer); git(['commit', '-q', '-m', msg, '--no-gpg-sign', '--allow-empty'], consumer); };
const sync = async () => { const r = await runSyncCli(['--target-path', consumer, '--no-prompt']); return { ...r, text: stripAnsi(r.out) }; };
const overrides = (doc) => write('.sync-overrides.json', `${JSON.stringify({ version: 1, ...doc }, null, 2)}\n`);
const navBlock = { path: NAV, slot: 'target-adapter', from: FRAG, reason: 'no HTTP surface: drive the repo-local adapter' };
const FRAGMENT = '## Electron target (this repo)\n\nRun the repo adapter: node scripts/openai-audit.mjs --mine\n';

before(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ces-blocks-')));
  consumer = path.join(tmp, 'consumer');
  fs.mkdirSync(consumer, { recursive: true });
  git(['init', '--initial-branch=main'], consumer);
  git(['config', 'user.email', 'test@example.invalid'], consumer);
  git(['config', 'user.name', 'Block Holds Test'], consumer);
  write('package.json', JSON.stringify({ name: 'block-holds-fixture', type: 'module' }, null, 2));
  seedInstalledDeps(consumer);
  write('.gitignore', '');
  commit('init');
  const first = await sync();
  assert.equal(first.code, 0, whySyncFailed(first));
  assert.ok(read(NAV).includes('\n<!-- sync-slot:target-adapter -->\n'), 'positive control: upstream ships the bare marker');
  commit('first sync');
});

after(() => { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

describe('a declared block is spliced into its slot', () => {
  let r;
  it('syncs clean and splices the fragment verbatim (the rewriter never touches consumer lines)', async () => {
    write(FRAG, FRAGMENT);
    overrides({ blocks: [navBlock] });
    commit('declare block');
    r = await sync();
    assert.equal(r.code, 0, whySyncFailed(r));
    const text = read(NAV);
    const lines = text.split('\n');
    const at = lines.findIndex((l) => l.startsWith(START));
    assert.ok(at > 0, 'start line present');
    assert.deepEqual(lines.slice(at + 1, at + 5), ['## Electron target (this repo)', '', 'Run the repo adapter: node scripts/openai-audit.mjs --mine', END]);
    assert.ok(!text.includes('\n<!-- sync-slot:target-adapter -->\n'), 'the bare marker is consumed');
    assert.match(r.text, /block target-adapter \+\d+ chars/);
  });

  it('the manifest records the spliced bytes, and the receipt records the applied block', () => {
    const manifest = JSON.parse(read('scripts/.sync-manifest.json'));
    assert.equal(String(manifest.files[NAV]).replace(/^sha256:/, ''), sha(fs.readFileSync(abs(NAV))));
    const rec = lastSync().blocksApplied.find((b) => b.path === NAV);
    assert.equal(rec.slot, 'target-adapter');
    assert.equal(rec.from, FRAG);
    assert.equal(rec.anchorMoved, false);
  });

  it('the DEPLOYED verifier CLI passes gate 2B on the block-held file, and fails it when the file is tampered', async () => {
    // The fixture seeds stub packages (helpers/consumer-fixture.mjs). For this one read-only run, link the real ones over
    // the stubs, then put the stubs back: no sync or package manager runs while they are linked.
    const nm = abs('node_modules');
    const swapped = [];
    for (const dep of fs.readdirSync(nm)) {
      const scoped = dep.startsWith('@') ? fs.readdirSync(path.join(nm, dep)).map((d) => `${dep}/${d}`) : [dep];
      for (const name of scoped) {
        const real = path.join(REPO_ROOT, 'node_modules', name);
        if (!fs.existsSync(real)) continue;
        const stub = path.join(nm, name);
        fs.renameSync(stub, `${stub}.stub`);
        fs.symlinkSync(real, stub, 'junction');
        swapped.push(stub);
      }
    }
    const cli = abs('scripts/.claude-skills/lib/sync-isolation-verify.mjs');
    const run = () => execFileAsync(process.execPath, [cli, '--consumer-root', consumer, '--gates', '2B'], { cwd: consumer, windowsHide: true })
      .then((x) => ({ code: 0, out: x.stdout + x.stderr }), (e) => ({ code: e.code, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }));
    const good = fs.readFileSync(abs(NAV));
    try {
      const ok = await run();
      assert.equal(ok.code, 0, ok.out);
      fs.writeFileSync(abs(NAV), Buffer.concat([good, Buffer.from('tamper\n')]));
      const bad = await run();
      assert.notEqual(bad.code, 0, 'negative control: the deployed gate sees the block-held file');
    } finally {
      fs.writeFileSync(abs(NAV), good);
      for (const stub of swapped) { fs.rmdirSync(stub); fs.renameSync(`${stub}.stub`, stub); } // rmdirSync unlinks the junction, never its target
    }
  });

  it('the SHIPPED sync-overrides.mjs resolves its new imports in the consumer and validates the block', async () => {
    // The consumer verifier imports sync-overrides.mjs; an import the closure walk missed would kill it with
    // MODULE_NOT_FOUND in every consumer. This fixture seeds stub npm deps (no zod), so the full verifier CLI cannot start
    // here for unrelated reasons; importing the deployed module is the part this change can break.
    commit('after splice');
    assert.ok(fs.existsSync(abs('scripts/.claude-skills/lib/sync-slots.mjs')), 'the shipped closure carries sync-slots.mjs');
    const out = await execFileAsync(process.execPath, ['--input-type=module', '-e',
      `const m = await import(${JSON.stringify(new URL(`file:///${abs('scripts/.claude-skills/lib/sync-overrides.mjs').replace(/\\/g, '/')}`).href)});`
      + `const r = m.loadOverrides(${JSON.stringify(consumer)}); process.stdout.write(JSON.stringify({ blocks: r.blocks.length, errors: r.errors }));`],
    { cwd: consumer, windowsHide: true });
    assert.deepEqual(JSON.parse(out.stdout), { blocks: 1, errors: [] });
  });

  it('gate 2B passes on the block-held file with no override exemption', async () => {
    const { runGates } = await import('../scripts/lib/sync-isolation-verify.mjs');
    const gate = () => runGates({ consumerRoot: consumer, gates: ['2B'], checkout: { kind: 'main', reason: 'test fixture' } })[0];
    const g = gate();
    assert.equal(g.pass, true, JSON.stringify(g).slice(0, 2000));
    // Negative control: the same gate DOES fail when the block-held file's bytes stop matching the manifest.
    const good = fs.readFileSync(abs(NAV));
    try {
      fs.writeFileSync(abs(NAV), Buffer.concat([good, Buffer.from('tamper\n')]));
      assert.equal(gate().pass, false, 'gate 2B can see this file');
    } finally { fs.writeFileSync(abs(NAV), good); }
  });
});

describe('the rest of a block-held file keeps receiving upstream', () => {
  it('a consumer on an OLDER upstream rendering is brought current, block intact', async () => {
    // Simulate "the consumer last synced an older upstream": rewrite one upstream line and record those bytes as the base.
    const current = read(NAV);
    const older = current.replace('## Three modes', '## Three modes (an older upstream wording)');
    assert.notEqual(older, current, 'positive control: the fixture line exists');
    write(NAV, older);
    const manifest = JSON.parse(read('scripts/.sync-manifest.json'));
    manifest.files[NAV] = `sha256:${sha(Buffer.from(older))}`;
    write('scripts/.sync-manifest.json', JSON.stringify(manifest, null, 2));
    commit('older upstream');
    const r = await sync();
    assert.equal(r.code, 0, whySyncFailed(r));
    assert.equal(read(NAV), current, 'upstream text restored, block kept');
    assert.doesNotMatch(r.text, /overwrote consumer content/, 'an ordinary update, not a divergence');
    commit('caught up');
  });

  it('editing the fragment flows in on the next sync', async () => {
    write(FRAG, `${FRAGMENT}\nA second adapter line.\n`);
    commit('edit fragment');
    const r = await sync();
    assert.equal(r.code, 0, whySyncFailed(r));
    assert.match(read(NAV), /A second adapter line\.\n<!-- sync-slot:target-adapter:end -->/);
    commit('fragment synced');
  });

  it('hand-editing the spliced span is refused, with a hint naming the fragment', async () => {
    const before = read(NAV);
    write(NAV, before.replace('A second adapter line.', 'Edited in the synced copy.'));
    commit('hand edit');
    const r = await sync();
    assert.notEqual(r.code, 0, 'a committed divergence is refused');
    assert.match(r.text, new RegExp(`carries a block hold: edit ${FRAG.replace(/\./g, '\\.')}`));
    assert.match(read(NAV), /Edited in the synced copy\./, 'the consumer edit is intact');
    write(NAV, before);
    commit('undo hand edit');
    const again = await sync();
    assert.equal(again.code, 0, whySyncFailed(again));
  });
});

describe('a block that cannot be placed fails loudly and is never dropped', () => {
  it('a slot upstream lacks: ERR slot-missing, file byte-unchanged, exit non-zero, recorded', async () => {
    const planBefore = fs.readFileSync(abs(PLAN));
    write('.sync-blocks/plan.md', 'plan adapter\n');
    overrides({ blocks: [navBlock, { path: PLAN, slot: 'target-adapter', from: '.sync-blocks/plan.md', reason: 'test' },
      { path: '.claude/skills/no-such-skill/SKILL.md', slot: 'target-adapter', from: '.sync-blocks/plan.md', reason: 'typo' }] });
    commit('bad declarations');
    const r = await sync();
    assert.notEqual(r.code, 0, 'the target fails');
    assert.match(r.text, /slot "target-adapter" is declared but upstream's file has no <!-- sync-slot:target-adapter --> marker/);
    assert.match(r.text, /consumer block was KEPT/);
    assert.ok(fs.readFileSync(abs(PLAN)).equals(planBefore), 'the file was not written');
    assert.match(r.text, /no-such-skill\/SKILL\.md is not a file this sync delivers/);
    const codes = lastSync().blockErrors.map((e) => `${e.path}:${e.code}`).sort();
    assert.deepEqual(codes, [`.claude/skills/no-such-skill/SKILL.md:block-dest-unknown`, `${PLAN}:slot-missing`]);
    assert.ok(lastSync().blocksApplied.some((b) => b.path === NAV), 'the good block still landed');
    overrides({ blocks: [navBlock] });
    fs.rmSync(abs('.sync-blocks/plan.md'), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    commit('fix declarations');
  });

  it('an unreadable fragment aborts the target before any write', async () => {
    overrides({ blocks: [{ ...navBlock, from: '.sync-blocks/missing.md' }] });
    commit('missing fragment');
    const r = await sync();
    assert.notEqual(r.code, 0);
    assert.match(r.text, /missing\.md is absent/);
    overrides({ blocks: [navBlock] });
    commit('restore fragment');
  });
});

describe('an upstream slot moved under another heading is reported', () => {
  it('warns when the anchor heading differs from the last recorded one', async () => {
    const receipt = JSON.parse(read('.sync-receipt.json'));
    const rec = receipt.recentSyncs.find((e) => (e.blocksApplied || []).some((b) => b.path === NAV));
    rec.blocksApplied.find((b) => b.path === NAV).anchorHeading = '## Somewhere else';
    write('.sync-receipt.json', `${JSON.stringify(receipt, null, 2)}\n`);
    commit('pretend the slot used to sit elsewhere');
    const r = await sync();
    assert.equal(r.code, 0, whySyncFailed(r));
    assert.match(r.text, /upstream moved slot target-adapter in \.claude\/skills\/nav-audit\/SKILL\.md from under "## Somewhere else"/);
    commit('after anchor warning');
  });
});

describe('migrating a whole-file hold to a block hold', () => {
  const VA_FRAG = '.sync-blocks/visual-audit.target-adapter.md';
  const ADAPTER = '<!-- repo-electron-target:start -->\n## Electron target\nUse the repo driver.\n<!-- repo-electron-target:end -->\n';

  it('a held file with the block pasted in, then the declaration swapped: refused until consent names the bytes', async () => {
    overrides({ overrides: [{ path: VA, reason: 'carries the adapter block' }], blocks: [navBlock] });
    commit('hold visual-audit');
    const held = read(VA).replace('## Flow', `${ADAPTER}\n## Flow`).replace('## Flow', '## Flow (drifted)');
    write(VA, held);
    commit('consumer edits its held copy');
    let r = await sync();
    assert.equal(r.code, 0, whySyncFailed(r));
    assert.ok(lastSync().overridesHeld.some((h) => h.path === VA), 'the hold is on record');

    write(VA_FRAG, ADAPTER);
    overrides({ blocks: [navBlock, { path: VA, slot: 'target-adapter', from: VA_FRAG, reason: 'adapter block' }] });
    commit('swap hold for block, no consent yet');
    r = await sync();
    assert.notEqual(r.code, 0, 'refused without consent');
    const token = /"adoptHeldFile": "(sha256:[0-9a-f]{16})"/.exec(r.text)?.[1];
    assert.ok(token, `the refusal prints the consent token:\n${r.text.slice(-2000)}`);
    assert.equal(read(VA), held, 'the held file is untouched');

    // An UNTRACKED held file is refused too — never the generic untracked overwrite (audit R2 H2 of the plan; code R1 M10).
    git(['rm', '-q', '--cached', VA], consumer);
    commit('untrack the held file');
    r = await sync();
    assert.notEqual(r.code, 0, 'pending adoption refuses an untracked held file');
    assert.doesNotMatch(r.text, /diverged-untracked|untracked here/, 'not the generic untracked rule');
    assert.equal(read(VA), held);
    git(['add', VA], consumer);
    commit('track it again');

    // (d) uncommitted work is never migrated, even with the right consent.
    overrides({ blocks: [navBlock, { path: VA, slot: 'target-adapter', from: VA_FRAG, reason: 'adapter block', adoptHeldFile: token }] });
    commit('consent');
    write(VA, `${held}uncommitted tail\n`);
    r = await sync();
    assert.notEqual(r.code, 0);
    assert.match(r.text, /uncommitted changes/);
    write(VA, held);

    r = await sync();
    assert.equal(r.code, 0, whySyncFailed(r));
    assert.match(r.text, /whole-file hold adopted as a block hold/);
    assert.match(r.text, /adoptHeldFile on \.claude\/skills\/visual-audit\/SKILL\.md is now spent/);
    const text = read(VA);
    assert.ok(text.includes('## Flow\n') && !text.includes('(drifted)'), 'upstream text restored');
    assert.ok(text.includes(`${ADAPTER}<!-- sync-slot:target-adapter:end -->`), 'the block is spliced');
    assert.ok(lastSync().divergedOverwritten.some((d) => d.path === VA && d.reason === 'block-hold-migration'));
    commit('migrated');

    r = await sync();
    assert.equal(r.code, 0, whySyncFailed(r));
    assert.doesNotMatch(r.text, /block-hold-migration|adopted as a block hold/, 'a spent flag is inert');

    // A NEW hold generation: hold again, edit, then restore the old block entry with its stale token -> refused.
    overrides({ overrides: [{ path: VA, reason: 'held again' }], blocks: [navBlock] });
    commit('hold again');
    r = await sync();
    assert.equal(r.code, 0, whySyncFailed(r));
    write(VA, `${read(VA)}a newer held edit\n`);
    commit('edit the new held generation');
    await sync();
    overrides({ blocks: [navBlock, { path: VA, slot: 'target-adapter', from: VA_FRAG, reason: 'adapter block', adoptHeldFile: token }] });
    commit('restore the stale consent');
    r = await sync();
    assert.notEqual(r.code, 0, 'a token for an older generation never adopts a newer one');
    assert.match(read(VA), /a newer held edit/, 'the newer held edit is intact');
  });
});

describe('lifecycle against an ISOLATED source checkout: upstream changes, moves and removes the slot', () => {
  let src;
  let target;
  const srcCli = () => path.join(src, 'scripts', 'sync-to-repos.mjs');
  const srcGit = (...args) => git(['-c', 'user.email=test@example.invalid', '-c', 'user.name=Block Holds Test', ...args], src);
  const editSource = (fn, msg) => {
    for (const rel of ['skills/nav-audit/SKILL.md', NAV]) {
      const p = path.join(src, rel);
      fs.writeFileSync(p, fn(fs.readFileSync(p, 'utf-8').replace(/\r\n/g, '\n')));
    }
    srcGit('commit', '-q', '-am', msg, '--no-gpg-sign');
  };
  const syncFrom = async () => {
    const r = await execFileAsync(process.execPath, [srcCli(), '--target-path', target, '--no-prompt'], syncExecOptions({ cwd: src }))
      .then((x) => ({ code: 0, out: x.stdout + x.stderr }), (e) => ({ code: e.code, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }));
    return { ...r, text: stripAnsi(r.out) };
  };
  const tRead = (rel) => fs.readFileSync(path.join(target, rel), 'utf-8');
  const tCommit = (msg) => { git(['add', '-A'], target); git(['commit', '-q', '-m', msg, '--no-gpg-sign', '--allow-empty'], target); };

  before(async () => {
    src = path.join(tmp, 'source');
    git(['worktree', 'add', '-q', '--detach', src, 'HEAD'], REPO_ROOT);
    // Overlay the working tree under test (modified + untracked files), so the fixture syncs the code being tested even
    // before it is committed; then commit it there so the source is clean (a dirty source is its own sync condition).
    // Everything that differs from HEAD (staged AND unstaged) plus untracked files; a path gone from the working tree is
    // deleted in the fixture too, so it carries exactly the state under test.
    const changed = [
      ...git(['diff', '-z', '--name-only', 'HEAD'], REPO_ROOT).split('\0'),
      ...git(['ls-files', '-z', '--others', '--exclude-standard'], REPO_ROOT).split('\0'),
    ].filter(Boolean);
    for (const rel of new Set(changed)) {
      const from = path.join(REPO_ROOT, rel);
      const to = path.join(src, rel);
      if (!fs.existsSync(from)) { fs.rmSync(to, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); continue; }
      if (!fs.statSync(from).isFile()) continue;
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    }
    srcGit('add', '-A');
    srcGit('commit', '-q', '--allow-empty', '-m', 'working tree under test', '--no-gpg-sign');
    fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(src, 'node_modules'), 'junction');
    target = path.join(tmp, 'consumer-lifecycle');
    fs.mkdirSync(target, { recursive: true });
    git(['init', '-q', '--initial-branch=main'], target);
    git(['config', 'user.email', 'test@example.invalid'], target);
    git(['config', 'user.name', 'Block Holds Test'], target);
    fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({ name: 'block-holds-lifecycle', type: 'module' }, null, 2));
    seedInstalledDeps(target);
    fs.writeFileSync(path.join(target, '.gitignore'), '');
    tCommit('init');
    let r = await syncFrom();
    assert.equal(r.code, 0, r.text.slice(-3000));
    tCommit('first sync');
    fs.mkdirSync(path.join(target, '.sync-blocks'), { recursive: true });
    fs.writeFileSync(path.join(target, FRAG), FRAGMENT);
    fs.writeFileSync(path.join(target, '.sync-overrides.json'), JSON.stringify({ version: 1, blocks: [navBlock] }, null, 2));
    tCommit('declare block');
    r = await syncFrom();
    assert.equal(r.code, 0, r.text.slice(-3000));
    tCommit('spliced');
  });

  after(() => {
    // Unlink the node_modules JUNCTION first (rmdirSync removes the link, never its target), so no later recursive delete
    // of the temp tree can walk into this repo's real node_modules; then deregister the worktree (--force twice: it holds
    // untracked files), then prune whatever a locked directory left registered.
    try { fs.rmdirSync(path.join(src, 'node_modules')); } catch { /* junction already gone */ }
    try { git(['worktree', 'remove', '--force', '--force', src], REPO_ROOT); } catch { /* fall through to prune */ }
    try { git(['worktree', 'prune'], REPO_ROOT); } catch { /* best effort */ }
  });

  it('an upstream edit outside the slot reaches the block-held file, block intact', async () => {
    editSource((t) => t.replace('## Three modes', '## Three modes of operation'), 'upstream rewords a heading');
    const r = await syncFrom();
    assert.equal(r.code, 0, r.text.slice(-3000));
    const text = tRead(NAV);
    assert.match(text, /^## Three modes of operation$/m, 'the upstream change landed');
    assert.ok(text.includes('Run the repo adapter: node scripts/openai-audit.mjs --mine\n<!-- sync-slot:target-adapter:end -->'), 'the block is intact');
    assert.doesNotMatch(r.text, /overwrote consumer content/);
    tCommit('upstream edit');
  });

  it('upstream moving the slot under another heading lands the block there and reports it', async () => {
    editSource((t) => t.replace('<!-- sync-slot:target-adapter -->\n\n', '').replace('## Three modes of operation\n', '## Three modes of operation\n\n<!-- sync-slot:target-adapter -->\n'), 'upstream moves the slot');
    const r = await syncFrom();
    assert.equal(r.code, 0, r.text.slice(-3000));
    assert.match(r.text, /upstream moved slot target-adapter in \.claude\/skills\/nav-audit\/SKILL\.md from under "[^"]*" to under "## Three modes of operation"/);
    assert.match(tRead(NAV), /## Three modes of operation\n\n<!-- sync-slot:target-adapter:start/);
    tCommit('slot moved');
  });

  it('upstream removing the slot fails the file loudly and keeps the consumer block', async () => {
    const before = tRead(NAV);
    editSource((t) => t.replace('<!-- sync-slot:target-adapter -->\n', ''), 'upstream removes the slot');
    const r = await syncFrom();
    assert.notEqual(r.code, 0, 'the target fails');
    assert.match(r.text, /slot-missing|has no <!-- sync-slot:target-adapter --> marker/);
    assert.equal(tRead(NAV), before, 'the consumer file, block included, is untouched');
  });
});

/**
 * @fileoverview End-to-end guard for consumer-divergence durability, driven
 * through the real `sync-to-repos.mjs` CLI against a real git repository.
 *
 * **Tier 3** (AGENTS.md testing doctrine): the consumer sync contract, where a
 * break ships silently to repos we cannot observe. The unit suites next door
 * prove the decision table; this proves the WIRING, which is where the incident
 * actually lived — every part of the old ownership check was individually
 * correct, and the composition still reverted merged work.
 *
 * A real `git init` rather than the fake `.git` directory the sibling
 * `sync-target-path` fixtures use, because `readVcsState` is the whole point
 * here: with a non-repo the guard would read every path as unanswerable and the
 * test would pass for the wrong reason.
 *
 * Reproduces the 2026-08-29 sequence from upstream report `5b1a121e`:
 *   1. sync a fresh consumer            → receipt appears, in-repo
 *   2. consumer condenses a SKILL.md, COMMITS it, syncs again → REFUSED, file intact
 *   3. consumer declares the override   → HELD, file still intact, run is green
 *   4. consumer pins .vscode/mcp.json   → pinned launcher survives the merge
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO_ROOT, 'scripts', 'sync-to-repos.mjs');
const execFileAsync = promisify(execFile);

/** A synced, TRACKED destination — the half of the bundle a consumer can commit. */
const SUBJECT = '.claude/skills/plan/SKILL.md';
const MCP = '.vscode/mcp.json';

let tmp;
let consumer;

function git(args, cwd = consumer) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8', windowsHide: true });
}

async function sync(extra = [], root = consumer) {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath, [CLI, '--target-path', root, '--no-prompt', ...extra],
      { cwd: REPO_ROOT, timeout: 300_000, maxBuffer: 32 * 1024 * 1024 },
    );
    return { code: 0, out: stdout + stderr };
  } catch (err) {
    return { code: err.code ?? 1, out: (err.stdout ?? '') + (err.stderr ?? '') };
  }
}

// The CLI colours its output; every assertion below is about the WORDS.
const stripAnsi = (t) => String(t).replace(/\u001B\[[0-9;]*m/g, '');
const read = (rel) => fs.readFileSync(path.join(consumer, rel), 'utf-8');
const write = (rel, body) => fs.writeFileSync(path.join(consumer, rel), body, 'utf-8');
/** The whole receipt FILE (v2: an envelope around a newest-first list). */
const receiptFile = (root = consumer) => JSON.parse(fs.readFileSync(path.join(root, '.sync-receipt.json'), 'utf-8'));
/** The newest entry — "what did the last sync do", which is what these assert. */
const lastSync = (root = consumer) => receiptFile(root).recentSyncs[0];

before(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ces-diverge-')));
  consumer = path.join(tmp, 'consumer');
  fs.mkdirSync(consumer, { recursive: true });
  git(['init', '--initial-branch=main'], consumer);
  git(['config', 'user.email', 'test@example.invalid']);
  git(['config', 'user.name', 'Sync Divergence Test']);
  fs.writeFileSync(
    path.join(consumer, 'package.json'),
    JSON.stringify({ name: 'divergence-fixture', type: 'module' }, null, 2),
  );
  fs.writeFileSync(path.join(consumer, '.gitignore'), '');
  git(['add', '-A']);
  git(['commit', '-m', 'init', '--no-gpg-sign']);
});

after(() => { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

describe('sync into a fresh consumer', () => {
  let first;
  it('succeeds and writes an in-repo receipt', async () => {
    first = await sync();
    assert.equal(first.code, 0, first.out.slice(-3000));
    assert.ok(fs.existsSync(path.join(consumer, '.sync-receipt.json')), 'no .sync-receipt.json');
  });

  it('the receipt is NOT gitignored — an invisible trace is no trace', () => {
    // The manifest being gitignored is the whole reason the incident had no
    // in-repo evidence. Asked of GIT, not of our own ignore list, because the
    // question is whether the file will actually reach a reviewer's diff.
    // `check-ignore -q` exits 0 when ignored and 1 when not, so the throw is
    // the pass — and the manifest below is the positive control proving this
    // probe can detect an ignored file at all.
    let receiptIgnored = true;
    try {
      execFileSync('git', ['-C', consumer, 'check-ignore', '-q', '--', '.sync-receipt.json'],
        { windowsHide: true, stdio: 'ignore' });
    } catch { receiptIgnored = false; }
    let manifestIgnored = true;
    try {
      execFileSync('git', ['-C', consumer, 'check-ignore', '-q', '--', 'scripts/.sync-manifest.json'],
        { windowsHide: true, stdio: 'ignore' });
    } catch { manifestIgnored = false; }
    assert.equal(manifestIgnored, true, 'positive control failed: the manifest should be ignored');
    assert.equal(receiptIgnored, false, '.sync-receipt.json is gitignored — it would leave no in-repo trace');
  });

  it('the receipt names the source commit and what it created', () => {
    assert.equal(receiptFile().version, 2);
    const r = lastSync();
    assert.equal(r.source.repo, 'Lbstrydom/claude-engineering-skills');
    assert.match(String(r.source.commitSha ?? ''), /^[0-9a-f]{40}$/);
    assert.ok(r.counts.created > 100, `expected a full bundle, got ${r.counts.created}`);
    assert.ok(r.created.includes(SUBJECT));
  });

  it("the managed .gitignore block carries .audit-loop/cache/", () => {
    // Our own tooling writes it in every consumer, and it was missing from the
    // block — which is how a consumer that added the line itself, inside our
    // fence, had it deleted again.
    assert.match(read('.gitignore'), /^\.audit-loop\/cache\/$/m);
  });
});

describe('a consumer diverges on a tracked synced file, and commits it', () => {
  let result;

  it('the sync REFUSES to overwrite it and fails', async () => {
    git(['add', '-A']);
    git(['commit', '-m', 'adopt bundle', '--no-gpg-sign']);
    const original = read(SUBJECT);
    write(SUBJECT, original.replace(
      /> \*\*Worktree preflight\*\*/,
      '> **Worktree preflight** — CONSUMER FORM, deliberately condensed.\n> <!-- was: -->\n> **Worktree preflight**',
    ));
    assert.notEqual(read(SUBJECT), original, 'fixture did not actually diverge');
    git(['add', '--', SUBJECT]);
    git(['commit', '-m', 'condense the preflight block', '--no-gpg-sign']);

    result = await sync();
    assert.notEqual(result.code, 0, 'a refusal must fail the run');
    assert.match(result.out, /REFUSED/);
    assert.match(result.out, /diverged-committed|COMMITTED in this repo/);
  });

  it('names the diverged path, so the operator can act without guessing', () => {
    assert.ok(result.out.includes(SUBJECT), `output never named ${SUBJECT}`);
  });

  it('leaves the consumer content on disk — nothing was reverted', () => {
    assert.match(read(SUBJECT), /CONSUMER FORM, deliberately condensed/);
    assert.equal(git(['status', '--porcelain', '--', SUBJECT]).trim(), '',
      'the subject file should be clean at HEAD, i.e. untouched');
  });

  it('records the refusal in the committed receipt', () => {
    const r = lastSync();
    assert.ok(r.divergenceRefused.some((d) => d.path === SUBJECT), JSON.stringify(r.divergenceRefused));
  });

  it('offers the three ways out, including where to report a wrong upstream form', () => {
    assert.match(result.out, /\.sync-overrides\.json/);
    assert.match(result.out, /--overwrite-diverged/);
    assert.match(result.out, /upstream report/);
  });
});

describe('the refusal SURVIVES a second sync (it did not, and that shipped)', () => {
  // The defect this pins, in production on 2026-08-29: the manifest is rebuilt
  // from the bytes on disk, so a REFUSED path recorded the consumer's own
  // content as our base. The next run compared disk to that base, saw
  // PRISTINE, and overwrote all 16 SKILL.md of the consumer whose report
  // prompted this mechanism — receipt reading `divergenceRefused: 0`.
  //
  // The suite above could not see it because it ran exactly ONE sync after
  // diverging. A guard whose SECOND invocation is inert is indistinguishable
  // from a working one until you invoke it twice, and "it refused" was the
  // only thing being asserted.
  it('refuses again on the very next run, and still has not written the file', async () => {
    const second = await sync();
    assert.notEqual(second.code, 0, 'the second sync must refuse too, not overwrite');
    assert.match(stripAnsi(second.out), /REFUSED/);
    assert.ok(second.out.includes(SUBJECT), 'the second run stopped naming the diverged path');
    assert.match(read(SUBJECT), /CONSUMER FORM, deliberately condensed/,
      'the second sync reverted the consumer content the first one protected');
  });

  it('the manifest still records OUR last write, not the consumer bytes', async () => {
    // The mechanism, asserted directly rather than only through its symptom:
    // recording the consumer's hash is what makes the next run read PRISTINE.
    const manifest = JSON.parse(read('scripts/.sync-manifest.json'));
    const onDisk = `sha256:${createHash('sha256').update(fs.readFileSync(path.join(consumer, SUBJECT))).digest('hex')}`;
    assert.notEqual(manifest.files[SUBJECT], onDisk,
      'the manifest adopted the consumer content as our base — the refusal erased its own evidence');
  });

  it('and a THIRD run is still refusing — the state is stable, not merely delayed', async () => {
    const third = await sync();
    assert.notEqual(third.code, 0);
    assert.match(read(SUBJECT), /CONSUMER FORM, deliberately condensed/);
  });
});

describe('the consumer declares the divergence', () => {
  let result;

  it('the sync HOLDS the path and the run is green again', async () => {
    write('.sync-overrides.json', `${JSON.stringify({
      version: 1,
      overrides: [{ path: SUBJECT, reason: 'condensed preflight block; upstream report 5b1a121e' }],
    }, null, 2)}\n`);
    git(['add', '-A']);
    git(['commit', '-m', 'declare the override', '--no-gpg-sign']);

    result = await sync();
    assert.equal(result.code, 0, result.out.slice(-3000));
    assert.match(stripAnsi(result.out), /hold\s+\.claude\/skills\/plan\/SKILL\.md/);
  });

  it('the consumer content survives — this is the durability the whole change is for', () => {
    assert.match(read(SUBJECT), /CONSUMER FORM, deliberately condensed/);
  });

  it('the receipt records the hold with the reason the consumer gave', () => {
    const r = lastSync();
    const held = r.overridesHeld.find((h) => h.path === SUBJECT);
    assert.ok(held, 'the hold is absent from the receipt');
    assert.match(held.reason, /upstream report 5b1a121e/);
    assert.match(String(held.upstreamSha), /^[0-9a-f]{64}$/);
  });

  it('a re-sync is idempotent — the hold does not churn the receipt', async () => {
    git(['add', '-A']);
    git(['commit', '-m', 'receipt', '--no-gpg-sign']);
    const again = await sync();
    assert.equal(again.code, 0, again.out.slice(-2000));
    assert.equal(git(['status', '--porcelain', '--', '.sync-receipt.json']).trim(), '',
      'a no-op sync re-dirtied the receipt');
  });
});

describe('pinned launchers survive the JSON merge', () => {
  it("upstream's unpinned fetch never replaces a consumer's pinned path", async () => {
    // The sharpest half of the incident: pinned → `npx -y …@latest` is a
    // supply-chain regression whichever side is right about the rest of the file.
    //
    // Exercised UNDER `--overwrite-diverged` on purpose. With the divergence
    // gate active this file would simply be refused, so a plain sync would pass
    // this assertion without the pin guard existing at all — a vacuous green.
    // The flag is precisely the path where the consumer has said "overwrite my
    // changes", and the invariant must still hold there: un-pinning is not
    // something an operator can consent to by construction.
    const pinned = {
      servers: {
        playwright: {
          type: 'stdio',
          command: 'node',
          args: ['${workspaceFolder}/node_modules/@playwright/mcp/cli.js', '--headless'],
        },
      },
    };
    write(MCP, `${JSON.stringify(pinned, null, 2)}
`);
    git(['add', '-A']);
    git(['commit', '-m', 'pin the mcp servers', '--no-gpg-sign']);

    const result = await sync(['--overwrite-diverged']);
    assert.equal(result.code, 0, result.out.slice(-3000));

    const after = JSON.parse(read(MCP));
    assert.equal(after.servers.playwright.command, 'node',
      `pinned launcher was replaced: ${JSON.stringify(after.servers.playwright)}`);
    assert.ok(
      after.servers.playwright.args.some((a) => a.includes('node_modules')),
      'the pinned path did not survive',
    );
    // Negative control for the guard's scope: a server the consumer never had
    // is upstream's to introduce, unpinned and all.
    assert.equal(after.servers.mermaid.command, 'npx');
    assert.match(result.out, /pinned/);
  });
});

describe('a second sync before the first is COMMITTED (upstream report 1fb43574)', () => {
  // The receipt is written to the working tree and never committed, so the
  // record is only durable once a human commits it. Under v1 a second sync in
  // that window replaced the first's `created`/`updated` lists and source
  // commit outright — reproduced by construction 2026-09-03: sync A created
  // 771 files, sync B created 1, and the receipt then read `created: 1` with
  // A's record absent from the working tree, from HEAD, and from every object
  // in the repo.
  //
  // A SEPARATE consumer, deliberately: this is about the state between two
  // syncs, so it must not inherit the committed history the suites above build.
  let second;
  let firstEntry;
  const VICTIM_A = '.claude/skills/plan/SKILL.md';
  const VICTIM_B = '.claude/skills/ship/SKILL.md';

  before(async () => {
    second = path.join(tmp, 'consumer-b');
    fs.mkdirSync(second, { recursive: true });
    git(['init', '--initial-branch=main'], second);
    git(['config', 'user.email', 'test@example.invalid'], second);
    git(['config', 'user.name', 'Receipt Durability Test'], second);
    fs.writeFileSync(path.join(second, 'package.json'),
      JSON.stringify({ name: 'receipt-fixture', type: 'module' }, null, 2));
    fs.writeFileSync(path.join(second, '.gitignore'), '');
    git(['add', '-A'], second);
    git(['commit', '-m', 'init', '--no-gpg-sign'], second);

    const a = await sync([], second);
    assert.equal(a.code, 0, a.out.slice(-3000));
    firstEntry = lastSync(second);

    // NO COMMIT here — that is the window. Deleting a synced file is what makes
    // the next run propagate something, so both runs are real recorded events.
    fs.rmSync(path.join(second, VICTIM_A), { recursive: true, maxRetries: 3, retryDelay: 50 });
    const b = await sync([], second);
    assert.equal(b.code, 0, b.out.slice(-3000));
  });

  it("the second sync did NOT erase the first — both are on record", () => {
    const file = receiptFile(second);
    assert.equal(file.version, 2);
    assert.ok(file.recentSyncs.length >= 2,
      `only ${file.recentSyncs.length} entry on record — the second sync overwrote the first`);
    assert.equal(file.recentSyncs[0].syncedAt > file.recentSyncs[1].syncedAt, true,
      'entries are not newest-first');
  });

  it("the first sync's created list and source commit are still readable", () => {
    // The specific loss: 771 paths and the upstream commit that delivered them.
    const kept = receiptFile(second).recentSyncs[1];
    assert.equal(kept.syncedAt, firstEntry.syncedAt);
    assert.equal(kept.counts.created, firstEntry.counts.created);
    assert.ok(kept.counts.created > 100, `expected a full bundle, got ${kept.counts.created}`);
    assert.ok(kept.created.includes(VICTIM_A));
    assert.equal(kept.source.commitSha, firstEntry.source.commitSha);
  });

  it('entry 0 still answers "what did the last sync do"', () => {
    assert.deepEqual(lastSync(second).created, [VICTIM_A]);
  });

  it('durability came from the FILE, not from git — nothing was committed', () => {
    // Negative control on the claimed mechanism. If the fixture had committed
    // between the two syncs, git would have preserved the first record and this
    // suite would pass without the append-only shape existing at all.
    assert.match(git(['status', '--porcelain', '--', '.sync-receipt.json'], second), /^\?\?/,
      'the receipt was committed — this suite is not testing what it claims');
  });

  it('a v1 receipt migrates without spending the record it is migrating', async () => {
    // The consumer-visible migration: every consumer today has a COMMITTED
    // single-object receipt. The upgrade must carry it forward as an entry, not
    // consume it — otherwise the fix costs one more record on the way in.
    const legacy = {
      version: 1,
      _note: 'Written by the claude-engineering-skills sync. Committed on purpose: …',
      syncedAt: '2026-09-02T11:40:53.438Z',
      source: {
        repo: 'Lbstrydom/claude-engineering-skills',
        branch: 'main',
        commitSha: '4ee0721e4ee0721e4ee0721e4ee0721e4ee0721e',
        sourceDirty: false,
      },
      counts: {
        created: 10, updated: 24, unchanged: 735, gcDeleted: 0,
        overridesHeld: 0, divergedOverwritten: 0, divergenceRefused: 0,
      },
      created: ['legacy/created/path.md'],
      updated: [],
      gcDeleted: [],
      overridesHeld: [],
      divergedOverwritten: [],
      divergenceRefused: [],
    };
    fs.writeFileSync(path.join(second, '.sync-receipt.json'),
      `${JSON.stringify(legacy, null, 2)}\n`, 'utf-8');
    fs.rmSync(path.join(second, VICTIM_B), { recursive: true, maxRetries: 3, retryDelay: 50 });

    const out = await sync([], second);
    assert.equal(out.code, 0, out.out.slice(-3000));

    const file = receiptFile(second);
    assert.equal(file.version, 2);
    assert.deepEqual(file.recentSyncs[0].created, [VICTIM_B]);
    const migrated = file.recentSyncs[1];
    assert.equal(migrated.syncedAt, '2026-09-02T11:40:53.438Z');
    assert.equal(migrated.source.commitSha, '4ee0721e4ee0721e4ee0721e4ee0721e4ee0721e');
    assert.deepEqual(migrated.created, ['legacy/created/path.md']);
    assert.equal('version' in migrated, false, 'the v1 envelope leaked into an entry');
  });

  it('a FUTURE receipt version is refused, not overwritten', async () => {
    // The mirror of the defect: an older bundle must not replace a newer one's
    // history with a shape it cannot merge. Declining is not a failure — the
    // sync itself still succeeds, and says why the trace was not written.
    const future = { version: 99, recentSyncs: [], writtenBy: 'a newer bundle' };
    const bytes = `${JSON.stringify(future, null, 2)}\n`;
    fs.writeFileSync(path.join(second, '.sync-receipt.json'), bytes, 'utf-8');
    fs.rmSync(path.join(second, VICTIM_A), { recursive: true, maxRetries: 3, retryDelay: 50 });

    const out = await sync([], second);
    assert.equal(out.code, 0, out.out.slice(-3000));
    assert.equal(fs.readFileSync(path.join(second, '.sync-receipt.json'), 'utf-8'), bytes,
      'an older bundle overwrote a newer receipt');
    assert.match(stripAnsi(out.out), /receipt not written/);
    assert.match(stripAnsi(out.out), /version 99/);
  });
});

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

async function sync(extra = []) {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath, [CLI, '--target-path', consumer, '--no-prompt', ...extra],
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
    const r = JSON.parse(read('.sync-receipt.json'));
    assert.equal(r.version, 1);
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
    const r = JSON.parse(read('.sync-receipt.json'));
    assert.ok(r.divergenceRefused.some((d) => d.path === SUBJECT), JSON.stringify(r.divergenceRefused));
  });

  it('offers the three ways out, including where to report a wrong upstream form', () => {
    assert.match(result.out, /\.sync-overrides\.json/);
    assert.match(result.out, /--overwrite-diverged/);
    assert.match(result.out, /upstream report/);
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
    const r = JSON.parse(read('.sync-receipt.json'));
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

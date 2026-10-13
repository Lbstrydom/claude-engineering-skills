/**
 * @fileoverview End-to-end guard: a sync that FAILED part of its work must say
 * so (non-zero exit, honest manifest and receipt), and must never act outside
 * the consumer it was pointed at. Driven through the real `sync-to-repos.mjs`
 * CLI against real git fixture repos.
 *
 * **Tier 3** (AGENTS.md testing doctrine): the consumer sync contract. Every
 * case here was first reproduced against be057735 by a throwaway fixture, and
 * this file is the black-box regression for each — it imports nothing the fix
 * introduced, so it runs unchanged against the pre-fix CLI and fails there for
 * the stated reason. Plan: docs/plans/sync-to-repos-failure-honesty.md.
 *
 *   H3  a FAILED write must not record the consumer's bytes as our base —
 *       one-time `--overwrite-diverged` consent was laundered into a standing
 *       one: the next, unconsented run overwrote committed work, exit 0.
 *   H4  a FAILED gc deletion: exit 0, `gcDeleted` claimed it, the manifest
 *       dropped it, and no later run ever retried it.
 *   H2  gc unlinked THROUGH a junctioned `scripts/.claude-skills`, deleting a
 *       file outside the consumer, exit 0.
 *   H7  a failed managed-block (`.gitattributes`) write was logged, exit 0.
 *   H1  shell-string `git diff`: cmd.exe / sh expanded `%OS%` / `$HOME` in the
 *       consumer path, so the dry-run diff was "unavailable".
 *   H8  invoked through a junction/symlink, the entry guard skipped `main()`
 *       and exited 0 having done nothing.
 *   dry-run  the gc rework must never delete or persist under --dry-run.
 *
 * Failure injection is OS-specific where it has to be, and every case that has
 * no injection on this platform SKIPS WITH A REASON — never a silent pass.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { seedInstalledDeps, runSyncCli, whySyncFailed, git } from './helpers/consumer-fixture.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const execFileAsync = promisify(execFile);
const IS_WIN = process.platform === 'win32';
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;

const SUBJECT = '.claude/skills/plan/SKILL.md';
const RETIRED = 'scripts/.claude-skills/lib/retired-by-upstream.mjs';
const MANIFEST = 'scripts/.sync-manifest.json';

const strip = (t) => String(t).replace(/\u001B\[[0-9;]*m/g, '');
const sha = (buf) => 'sha256:' + createHash('sha256').update(buf).digest('hex');

let tmp;
before(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ces-failacct-'))); });
after(() => { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

/** A real git consumer with seeded deps and one commit. */
function makeConsumer(name) {
  const root = path.join(tmp, name);
  fs.mkdirSync(root, { recursive: true });
  git(['init', '--initial-branch=main'], root);
  git(['config', 'user.email', 'test@example.invalid'], root);
  git(['config', 'user.name', 'Sync Failure Accounting Test'], root);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'failacct-fixture', type: 'module' }, null, 2));
  seedInstalledDeps(root);
  fs.writeFileSync(path.join(root, '.gitignore'), '');
  git(['add', '-A'], root);
  git(['commit', '-q', '-m', 'init', '--no-gpg-sign'], root);
  return root;
}

async function sync(root, extra = []) {
  const r = await runSyncCli(['--target-path', root, '--no-prompt', ...extra]);
  return { ...r, text: strip(r.out) };
}

const readJson = (root, rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf-8'));
const lastReceipt = (root) => readJson(root, '.sync-receipt.json').recentSyncs[0];

/** Add a prior-manifest key, as if upstream had since retired a file we delivered. */
function recordPriorKey(root, rel, body) {
  const m = readJson(root, MANIFEST);
  m.files[rel] = sha(Buffer.from(body));
  fs.writeFileSync(path.join(root, MANIFEST), JSON.stringify(m, null, 2) + '\n');
}

/**
 * Make an existing file's atomic replacement fail. Win32: a read-only target
 * refuses `rename` onto it (EPERM). Posix: a non-writable parent refuses the
 * temp file + rename. Returns the undo, or null when no injection exists here.
 */
function makeUnreplaceable(abs) {
  if (IS_WIN) {
    fs.chmodSync(abs, 0o444);
    return () => fs.chmodSync(abs, 0o644);
  }
  if (IS_ROOT) return null;   // root ignores directory permissions
  const dir = path.dirname(abs);
  fs.chmodSync(dir, 0o555);
  return () => fs.chmodSync(dir, 0o755);
}

describe('H3 — a failed write never becomes the base', () => {
  let root;
  it('a consented overwrite whose WRITE fails exits non-zero', async (t) => {
    root = makeConsumer('h3');
    const first = await sync(root);
    assert.equal(first.code, 0, whySyncFailed(first));
    git(['add', '-A'], root);
    git(['commit', '-q', '-m', 'sync', '--no-gpg-sign'], root);
    fs.writeFileSync(path.join(root, SUBJECT), '# consumer-condensed plan skill\n');
    git(['commit', '-q', '-am', 'consumer change', '--no-gpg-sign'], root);

    const undo = makeUnreplaceable(path.join(root, SUBJECT));
    if (!undo) { t.skip('no write-failure injection when running as root'); root = null; return; }
    let r;
    try { r = await sync(root, ['--overwrite-diverged']); } finally { undo(); }
    assert.notEqual(r.code, 0, 'the failed write must fail the run');
    assert.match(r.text, /ERR\s+\.claude\/skills\/plan\/SKILL\.md/);
  });

  it('the NEXT, unconsented run refuses — the committed consumer content survives', async (t) => {
    if (!root) { t.skip('previous step skipped'); return; }
    const r = await sync(root);
    assert.equal(fs.readFileSync(path.join(root, SUBJECT), 'utf-8'), '# consumer-condensed plan skill\n',
      'committed consumer work was overwritten by a run that never had consent');
    assert.notEqual(r.code, 0, `an unconsented diverged path must be REFUSED (exit 1):\n${r.text.slice(-1500)}`);
    assert.ok(lastReceipt(root).divergenceRefused.some((d) => d.path === SUBJECT), 'receipt does not record the refusal');
  });
});

describe('H4 — a failed gc deletion is an error, stays tracked, and is retried', () => {
  let root;
  it('reports the failure and does not claim the deletion', async () => {
    root = makeConsumer('h4');
    const first = await sync(root);
    assert.equal(first.code, 0, whySyncFailed(first));
    // Injection, portable: unlink() of a non-empty DIRECTORY fails non-ENOENT
    // on every platform (stands in for a locked file).
    const abs = path.join(root, RETIRED);
    fs.mkdirSync(abs);
    fs.writeFileSync(path.join(abs, 'x'), 'x');
    recordPriorKey(root, RETIRED, '// retired\n');

    const r = await sync(root);
    assert.notEqual(r.code, 0, `a failed gc deletion must fail the run:\n${r.text.slice(-1500)}`);
    assert.ok(fs.existsSync(abs), 'positive control: the injected entry should still be there');
    assert.match(r.text, /gc FAILED\s+scripts\/\.claude-skills\/lib\/retired-by-upstream\.mjs/, 'the failed path is not named');
    assert.ok(!(lastReceipt(root).gcDeleted || []).includes(RETIRED), 'receipt claims a deletion that did not happen');
    assert.ok(RETIRED in readJson(root, MANIFEST).files, 'manifest dropped a path it failed to delete — it can never be retried');
  });

  it('the next run retries it and the deletion is recorded', async () => {
    const abs = path.join(root, RETIRED);
    fs.rmSync(abs, { recursive: true });
    fs.writeFileSync(abs, '// retired\n');
    const r = await sync(root);
    assert.equal(r.code, 0, whySyncFailed(r));
    assert.equal(fs.existsSync(abs), false, 'the retried deletion did not happen');
    assert.ok(lastReceipt(root).gcDeleted.includes(RETIRED));
    assert.ok(!(RETIRED in readJson(root, MANIFEST).files));
  });
});

describe('H2 — gc never deletes through a link out of the consumer', () => {
  it('a junctioned tooling dir: the outside file survives and the run fails', async () => {
    const root = makeConsumer('h2');
    const first = await sync(root);
    assert.equal(first.code, 0, whySyncFailed(first));
    const outside = path.join(tmp, 'h2-outside');
    const tooling = path.join(root, 'scripts', '.claude-skills');
    fs.cpSync(tooling, outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'lib', 'retired-by-upstream.mjs'), '// NOT the consumer repo\n');
    fs.rmSync(tooling, { recursive: true, force: true });
    fs.symlinkSync(outside, tooling, 'junction');   // 'junction' is ignored on posix (a dir symlink)
    recordPriorKey(root, RETIRED, '// retired\n');
    try {
      const r = await sync(root);
      assert.ok(fs.existsSync(path.join(outside, 'lib', 'retired-by-upstream.mjs')),
        'gc deleted a file OUTSIDE the consumer through a junction');
      assert.notEqual(r.code, 0, `a refused gc deletion must fail the run:\n${r.text.slice(-1500)}`);
      assert.match(r.text, /gc FAILED\s+scripts\/\.claude-skills\/lib\/retired-by-upstream\.mjs[^\n]*refused/,
        'the run failed, but not because containment refused the deletion');
    } finally {
      fs.rmSync(tooling, { force: true });   // the link itself, never its target
    }
  });
});

describe('H7 — a failed managed-block write fails the run', () => {
  it('.gitattributes cannot be written → non-zero exit', async () => {
    const root = makeConsumer('h7');
    // Injection, portable: the atomic rename onto an existing non-empty
    // directory fails on every platform.
    fs.mkdirSync(path.join(root, '.gitattributes'));
    fs.writeFileSync(path.join(root, '.gitattributes', 'x'), 'x');
    const r = await sync(root);
    assert.match(r.text, /\.gitattributes write failed/, 'positive control: the injected failure did not happen');
    assert.notEqual(r.code, 0, 'a failed managed-block write was reported as success');
  });
});

describe('H1 — no shell between the sync and git', () => {
  it('dry-run diff works for a consumer path the shell would expand', async () => {
    // cmd.exe expands %VAR% inside double quotes; sh expands $VAR.
    const root = makeConsumer(IS_WIN ? 'h1%OS%dir' : 'h1$HOMEdir');
    const first = await sync(root);
    assert.equal(first.code, 0, whySyncFailed(first));
    const rel = 'scripts/.claude-skills/cross-skill.mjs';
    fs.appendFileSync(path.join(root, rel), '\n// local edit\n');
    const r = await sync(root, ['--dry-run']);
    const at = r.text.indexOf(rel);
    assert.ok(at >= 0, 'positive control: the edited file should be listed as an update');
    const section = r.text.slice(at, at + 3000);
    assert.doesNotMatch(section, /diff unavailable/, `the diff went through a shell:\n${section.slice(0, 600)}`);
    assert.match(section, /@@ /, 'expected a unified-diff hunk');
  });
});

describe('H8 — the CLI runs when invoked through a link', () => {
  it('a junction/symlink to the checkout still reaches main()', async () => {
    const link = path.join(tmp, 'h8-link');
    fs.symlinkSync(REPO_ROOT, link, 'junction');
    try {
      let code = 0; let out = '';
      try {
        const res = await execFileAsync(process.execPath, [path.join(link, 'scripts', 'sync-to-repos.mjs'), '--no-such-flag'],
          { encoding: 'utf-8', windowsHide: true, timeout: 120_000 });
        out = res.stdout + res.stderr;
      } catch (err) { code = err.code; out = `${err.stdout ?? ''}${err.stderr ?? ''}`; }
      assert.equal(code, 2, `expected the flag diagnostic (exit 2) — main() did not run:\n${out}`);
      assert.match(out, /unknown flag/);
    } finally {
      fs.rmSync(link, { force: true });
    }
  });
});

describe('dry-run never deletes or persists', () => {
  it('a retired tooling file and every bookkeeping file are byte-identical after --dry-run', async () => {
    const root = makeConsumer('dryrun');
    const first = await sync(root);
    assert.equal(first.code, 0, whySyncFailed(first));
    fs.writeFileSync(path.join(root, RETIRED), '// retired\n');
    recordPriorKey(root, RETIRED, '// retired\n');
    const watched = [RETIRED, MANIFEST, '.sync-receipt.json', 'scripts/.sync-owned.json'];
    const before = Object.fromEntries(watched.map((rel) => [rel, fs.readFileSync(path.join(root, rel))]));
    const r = await sync(root, ['--dry-run']);
    for (const rel of watched) {
      assert.ok(fs.existsSync(path.join(root, rel)), `${rel} was deleted by a dry run`);
      assert.ok(before[rel].equals(fs.readFileSync(path.join(root, rel))), `${rel} changed under --dry-run`);
    }
    assert.match(r.text, /would be deleted/);
    assert.doesNotMatch(r.text, /gc: removed/);
  });
});

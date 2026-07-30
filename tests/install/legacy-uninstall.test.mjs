/**
 * `--uninstall-legacy` — the S3a outcome contract.
 *
 * This is the only code path in the bundle that deletes from a user's home
 * directory, so the properties worth pinning are the ones that keep it bounded:
 *
 *   - the delete set comes from RECEIPT MEMBERSHIP, never from reading the
 *     directory — a user's own `~/.claude/skills/<name>/` must be unreachable
 *     by construction, not by a filter (INC-002's lesson: "is the variable set"
 *     is not a safety gate, and neither is "a receipt exists");
 *   - a user-modified managed file is skipped and reported, never removed;
 *   - a `partial` run REWRITES the receipt to its survivors rather than deleting
 *     it — dropping it would discard the only bounded-membership record for the
 *     file still on disk and orphan it forever.
 *
 * Plan: docs/plans/repo-scoped-skill-surfaces-and-installer.md §6 S3/S3a.
 */
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(REPO_ROOT, 'scripts', 'install-skills.mjs');
const execFileAsync = promisify(execFile);

// @duplicate-justification: target=tests/install/lifecycle.test.mjs:sha12 reason=deliberate test-local fixture helper. Production digest conflict-detector.mjs::computeFileSha takes a PATH and returns null on any read error; these suites need the digest of an in-memory STRING before the file exists. A shared util for a one-line expression would couple otherwise-independent suites' fixtures, and the value is pinned by the production code both suites assert against.
const sha12 = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);

let tmp, home, repo;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ces-uninst-'));
  home = path.join(tmp, 'home');
  repo = path.join(tmp, 'repo');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(repo, { recursive: true });
});

afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

function seedGlobal(rel, content) {
  const abs = path.join(home, '.claude', 'skills', rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return { path: abs, sha: sha12(content), skill: rel.split(/[\\/]/)[0], scope: 'global' };
}

function writeGlobalReceipt(managedFiles) {
  fs.writeFileSync(path.join(home, '.audit-loop-install-receipt.json'), JSON.stringify({
    receiptVersion: 1, bundleVersion: 'test', sourceUrl: 'test', surface: 'claude',
    installedAt: new Date(0).toISOString(), managedFiles,
  }, null, 2));
}

function readGlobalReceipt() {
  const p = path.join(home, '.audit-loop-install-receipt.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}

async function run(extra = []) {
  const argv = [CLI, '--uninstall-legacy', '--home', home, '--repo-root', repo, ...extra];
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, argv, { cwd: REPO_ROOT });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

describe('--uninstall-legacy outcomes', () => {
  test('complete — every member removed, receipt removed, exit 0', async () => {
    const a = seedGlobal('plan/SKILL.md', 'a');
    const b = seedGlobal('ship/SKILL.md', 'b');
    writeGlobalReceipt([a, b]);

    const r = await run();
    assert.equal(r.code, 0);
    assert.match(r.stdout, /complete/);
    assert.equal(fs.existsSync(a.path), false);
    assert.equal(fs.existsSync(b.path), false);
    assert.equal(readGlobalReceipt(), null, 'receipt removed once nothing is owned');
  });

  test('partial — a modified member is skipped, reported, and KEPT in a reduced receipt', async () => {
    const clean = seedGlobal('plan/SKILL.md', 'original');
    const dirty = seedGlobal('ship/SKILL.md', 'original');
    writeGlobalReceipt([clean, dirty]);
    fs.writeFileSync(dirty.path, 'HAND EDITED BY THE USER');

    const r = await run();
    assert.equal(r.code, 0, 'a partial cleanup is a success WITH A REPORT');
    assert.equal(fs.existsSync(dirty.path), true, 'a user-modified file is never deleted');
    assert.equal(fs.readFileSync(dirty.path, 'utf8'), 'HAND EDITED BY THE USER');
    assert.match(r.stdout, /blocked|skipped|modified/i, 'the skip must be reported, not hidden behind a success line');

    const receipt = readGlobalReceipt();
    assert.ok(receipt, 'the receipt must survive so the remaining file stays bounded');
    const paths = receipt.managedFiles.map(m => path.resolve(m.path));
    assert.ok(paths.includes(path.resolve(dirty.path)), 'the survivor stays recorded');
    assert.ok(!paths.includes(path.resolve(clean.path)), 'the removed file drops out');
  });

  test('clean — no receipt at all is a named no-op, exit 0', async () => {
    const r = await run();
    assert.equal(r.code, 0);
    assert.match(r.stdout, /clean/);
  });

  test('blocked — an unparseable receipt never reads as clean', async () => {
    seedGlobal('plan/SKILL.md', 'still here');
    fs.writeFileSync(path.join(home, '.audit-loop-install-receipt.json'), '{ not json');

    const r = await run();
    assert.equal(r.code, 0, 'a blocked state does not fail the command');
    assert.match(r.stdout, /blocked/, 'must NOT report clean — a managed tree may still be there');
    assert.equal(fs.existsSync(path.join(home, '.claude', 'skills', 'plan', 'SKILL.md')), true);
  });
});

describe('--uninstall-legacy is bounded by the receipt, not by the directory', () => {
  test("a user's own global skill is never touched", async () => {
    const ours = seedGlobal('plan/SKILL.md', 'ours');
    writeGlobalReceipt([ours]);

    // A skill the user wrote themselves, sitting in the same directory tree and
    // never recorded in any receipt. Directory enumeration would sweep it up.
    const theirs = path.join(home, '.claude', 'skills', 'my-own-skill', 'SKILL.md');
    fs.mkdirSync(path.dirname(theirs), { recursive: true });
    fs.writeFileSync(theirs, 'the user wrote this');

    const r = await run();
    assert.equal(r.code, 0);
    assert.equal(fs.existsSync(ours.path), false, 'ours removed');
    assert.equal(fs.existsSync(theirs), true, "the user's own skill must be unreachable by construction");
    assert.equal(fs.readFileSync(theirs, 'utf8'), 'the user wrote this');
  });

  test('--dry-run changes nothing and lists what would go', async () => {
    const a = seedGlobal('plan/SKILL.md', 'a');
    writeGlobalReceipt([a]);

    const r = await run(['--dry-run']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /DRY RUN/);
    assert.match(r.stdout, /Would remove 1 file/);
    assert.equal(fs.existsSync(a.path), true, 'dry-run must not delete');
    assert.ok(readGlobalReceipt(), 'dry-run must not touch the receipt');
  });

  test('idempotent — a second run is a clean no-op', async () => {
    const a = seedGlobal('plan/SKILL.md', 'a');
    writeGlobalReceipt([a]);

    const first = await run();
    assert.equal(first.code, 0);
    const second = await run();
    assert.equal(second.code, 0);
    assert.match(second.stdout, /clean/);
  });

  test('the explicit --home is honoured, and a DIFFERENT ambient home is untouched (D6e)', async () => {
    // The regression this closes: --home parsed and logged, then ignored by a
    // zero-argument resolver, so the delete acted on the ambient home instead.
    //
    // Proving that needs TWO homes. An earlier version of this test asserted
    // only against `home` — the explicit target — which a resolver that ignored
    // its argument would also satisfy whenever the two happened to coincide. So
    // we plant an identical decoy tree in a separate ambient home, hand it to
    // the child via HOME/USERPROFILE, and require the decoy to survive.
    const ambient = path.join(tmp, 'ambient-home');
    const decoy = path.join(ambient, '.claude', 'skills', 'plan', 'SKILL.md');
    fs.mkdirSync(path.dirname(decoy), { recursive: true });
    fs.writeFileSync(decoy, 'a');                       // same bytes as the real target
    fs.writeFileSync(path.join(ambient, '.audit-loop-install-receipt.json'), JSON.stringify({
      receiptVersion: 1, bundleVersion: 'test', sourceUrl: 'test', surface: 'claude',
      installedAt: new Date(0).toISOString(),
      managedFiles: [{ path: decoy, sha: sha12('a'), skill: 'plan', scope: 'global' }],
    }, null, 2));

    const target = seedGlobal('plan/SKILL.md', 'a');
    writeGlobalReceipt([target]);

    const argv = [CLI, '--uninstall-legacy', '--home', home, '--repo-root', repo];
    const { stdout } = await execFileAsync(process.execPath, argv, {
      cwd: REPO_ROOT,
      env: { ...process.env, HOME: ambient, USERPROFILE: ambient },
    });

    assert.match(stdout, new RegExp(home.replace(/[\\^$*+?.()|[\]{}]/g, '\\$&')),
      'the run must report the injected home');
    assert.equal(fs.existsSync(target.path), false, 'the explicit home is what got cleaned');
    assert.equal(fs.existsSync(decoy), true,
      'a resolver that ignored --home would have deleted the ambient decoy instead');
    assert.equal(fs.readFileSync(decoy, 'utf8'), 'a');
  });
});

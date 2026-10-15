/**
 * @fileoverview A dry run of what `.github/workflows/release.yml` does with the manifest and the bundle.
 *
 * The workflow has never run (no tag has been pushed), so nothing had caught that its tarball step named
 * `scripts/check-skill-updates.mjs`, a file that no longer exists: `tar` exits non-zero on a missing input and the
 * release would have died there (finding p-20261015060428-86c5). Its checksum step had the quieter form of the same
 * fault: each script was guarded by `fs.existsSync`, so the missing name would have been DROPPED from `checksums.json`
 * and the release signed over a reduced set.
 *
 * `skills.manifest.json` is Category A (untracked; docs/plans/fleet-chips-and-merge-friction.md), and the workflow builds it
 * itself in the step before it reads it. This test performs the same sequence in a scratch directory: build the
 * manifest, run the workflow's OWN tag step, checksum script and tar command (each extracted from the YAML, not
 * re-typed). It reads the workflow text, so editing the workflow changes what is proved.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const REPO = path.resolve(import.meta.dirname, '..');
const WORKFLOW = fs.readFileSync(path.join(REPO, '.github/workflows/release.yml'), 'utf8');

/** The `node -e "..."` checksum script of the "Build checksums" step, exactly as the workflow runs it. */
function checksumScript(text) {
  const m = /node -e "\r?\n([\s\S]*?)\r?\n\s+" --input-type=module/.exec(text);
  return m ? m[1] : null;
}

/** The tar command line of the "Create skills bundle tarball" step. */
function tarCommand(text) {
  const m = /run: (tar -czf \S+ [^\r\n]+)/.exec(text);
  return m ? m[1].trim().split(/\s+/) : null;
}

/** The shell body of the "Determine tag" step, dedented. */
function tagStepScript(text) {
  const m = /- name: Determine tag[\s\S]*?run: \|\r?\n([\s\S]*?)\r?\n\r?\n\s+- name:/.exec(text);
  return m ? m[1].replace(/^ {10}/gm, '') : null;
}

const scratchDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'release-dry-run-'));
const cleanup = (dir) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });

/** Mirror only what the workflow's steps read. */
function stageCheckout(dir) {
  fs.cpSync(path.join(REPO, 'skills'), path.join(dir, 'skills'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'scripts'));
  for (const f of ['install-skills.mjs', 'build-manifest.mjs']) fs.copyFileSync(path.join(REPO, 'scripts', f), path.join(dir, 'scripts', f));
  // Step "Build manifest": the real builder against the real tree, writing where the later steps read.
  const built = spawnSync(process.execPath, [path.join(REPO, 'scripts/build-manifest.mjs'), '--manifest', path.join(dir, 'skills.manifest.json')], { cwd: REPO, encoding: 'utf8' });
  assert.equal(built.status, 0, `build-manifest failed: ${built.stderr}`);
}

/** The workflow's own invocation: `node -e "<script>" --input-type=module`, tag supplied through the environment. */
const runChecksums = (dir, env = { RELEASE_TAG: 'v0.0.0-dry-run' }) =>
  spawnSync(process.execPath, ['-e', checksumScript(WORKFLOW), '--input-type=module'], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } });

test('the workflow\'s tag step, checksum script and tar command can be located (the probe is not vacuous)', () => {
  assert.ok(checksumScript(WORKFLOW), 'checksum script not found in release.yml: this test would prove nothing');
  assert.ok(tagStepScript(WORKFLOW), 'tag step not found in release.yml');
  const tar = tarCommand(WORKFLOW);
  assert.ok(tar && tar.length > 3, 'tar command not found in release.yml');
  assert.ok(tar.includes('skills.manifest.json'), 'the tarball must carry the manifest the workflow just built');
});

test('negative control: a tar input that does not exist is detected', () => {
  const inputs = ['skills/', 'scripts/install-skills.mjs', 'scripts/check-skill-updates.mjs'];
  const missing = inputs.filter((p) => !fs.existsSync(path.join(REPO, p)));
  assert.deepEqual(missing, ['scripts/check-skill-updates.mjs'], 'the probe must see the file the workflow used to name');
});

test('dry run: the workflow\'s checksum script and tar command succeed in a scratch checkout', () => {
  const dir = scratchDir();
  try {
    stageCheckout(dir);
    const ran = runChecksums(dir);
    assert.equal(ran.status, 0, `the workflow's checksum script failed: ${ran.stderr}`);
    const sums = JSON.parse(fs.readFileSync(path.join(dir, 'checksums.json'), 'utf8'));
    assert.equal(sums.version, 'v0.0.0-dry-run', 'the tag arrives through the environment');
    // The whole path-to-digest map, computed independently: presence alone would pass a constant or a wrong-content hash.
    const sha = (rel) => 'sha256-' + createHash('sha256').update(fs.readFileSync(path.join(dir, rel))).digest('hex');
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'skills.manifest.json'), 'utf8'));
    const expected = {};
    for (const meta of Object.values(manifest.skills)) expected[meta.path] = sha(meta.path);
    for (const rel of ['scripts/install-skills.mjs', 'scripts/build-manifest.mjs', 'skills.manifest.json']) expected[rel] = sha(rel);
    assert.ok(Object.keys(manifest.skills).length >= 10, 'the manifest must list the skills, or this comparison is vacuous');
    assert.equal(Object.keys(expected).length, Object.keys(manifest.skills).length + 3, 'one entry per skill plus the three required files');
    assert.deepEqual(sums.files, expected, 'checksums.json must equal the independently computed digests of every required input');
    assert.equal(sums.bundleVersion, manifest.bundleVersion);

    const [tar, ...args] = tarCommand(WORKFLOW);
    const packed = spawnSync(tar, args, { cwd: dir, encoding: 'utf8' });
    assert.equal(packed.status, 0, `tar failed (a missing input exits non-zero): ${packed.stderr || packed.error}`);
    const listing = spawnSync('tar', ['-tzf', 'skills-bundle.tar.gz'], { cwd: dir, encoding: 'utf8' });
    assert.equal(listing.status, 0, listing.stderr);
    assert.ok(listing.stdout.includes('skills.manifest.json'), 'the tarball lacks the manifest');
    assert.ok(listing.stdout.includes('scripts/install-skills.mjs'), 'the tarball lacks the installer');
  } finally { cleanup(dir); }
});

test('the checksum script FAILS CLOSED: a required input that is missing produces no checksums.json', () => {
  const dir = scratchDir();
  try {
    stageCheckout(dir);
    fs.rmSync(path.join(dir, 'scripts/install-skills.mjs'));
    const ran = runChecksums(dir);
    assert.notEqual(ran.status, 0, 'a missing required input must fail the step, not be skipped silently');
    assert.ok(!fs.existsSync(path.join(dir, 'checksums.json')), 'and no publishable checksum file may be left behind');
    assert.match(ran.stderr, /install-skills\.mjs/, 'the failure names the missing file');
  } finally { cleanup(dir); }
});

test('the checksum script refuses to run without a release tag', () => {
  const dir = scratchDir();
  try {
    stageCheckout(dir);
    const ran = runChecksums(dir, { RELEASE_TAG: '' });
    assert.notEqual(ran.status, 0);
    assert.ok(!fs.existsSync(path.join(dir, 'checksums.json')));
  } finally { cleanup(dir); }
});

/** Run the workflow's own tag step under bash with the given environment; returns the tag it wrote, or null if it refused. */
function runTagStep(env) {
  const dir = scratchDir();
  try {
    const out = path.join(dir, 'github_output');
    fs.writeFileSync(out, '');
    const r = spawnSync('bash', ['-c', tagStepScript(WORKFLOW)], { cwd: dir, encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: out, ...env } });
    const written = fs.readFileSync(out, 'utf8');
    return { status: r.status, stderr: r.stderr, tag: /^tag=(.*)$/m.exec(written)?.[1] ?? null, sideEffect: fs.existsSync(path.join(dir, 'pwned')) };
  } finally { cleanup(dir); }
}

test('the tag step treats a dispatch input as DATA: a command substitution never runs, and an invalid tag is refused', () => {
  const evil = runTagStep({ EVENT_NAME: 'workflow_dispatch', INPUT_TAG: 'v1.2.3$(touch pwned)' });
  assert.notEqual(evil.status, 0, 'a tag that is not vMAJOR.MINOR.PATCH must be refused');
  assert.equal(evil.tag, null);
  assert.equal(evil.sideEffect, false, 'the substitution in the input must not have executed');

  // The whole value must be a tag: a valid tag LINE inside a multi-line value is not enough (grep -E anchors per line).
  for (const bad of ['v1.2.3\ntag=v9.9.9', 'tag=v9.9.9\nv1.2.3', 'v1.2.3\r', 'v1.2.3\n', 'v1.2.3 ', '']) {
    const r = runTagStep({ EVENT_NAME: 'workflow_dispatch', INPUT_TAG: bad });
    assert.notEqual(r.status, 0, `${JSON.stringify(bad)} must be refused`);
    assert.equal(r.tag, null, `${JSON.stringify(bad)} must write nothing to GITHUB_OUTPUT`);
  }

  const good = runTagStep({ EVENT_NAME: 'workflow_dispatch', INPUT_TAG: 'v1.2.3' });
  assert.equal(good.status, 0, good.stderr);
  assert.equal(good.tag, 'v1.2.3');

  const pushed = runTagStep({ EVENT_NAME: 'push', GITHUB_REF: 'refs/tags/v2.0.0-rc.1' });
  assert.equal(pushed.status, 0, pushed.stderr);
  assert.equal(pushed.tag, 'v2.0.0-rc.1');
});

test('negative control: the pre-fix interpolation form WOULD have executed the input (the probe can see it)', () => {
  const oldStep = 'echo "tag=${INPUT_TAG}" >> "$GITHUB_OUTPUT"'.replace('${INPUT_TAG}', 'v1.2.3$(touch pwned)');
  const dir = scratchDir();
  try {
    const out = path.join(dir, 'github_output');
    fs.writeFileSync(out, '');
    spawnSync('bash', ['-c', oldStep], { cwd: dir, encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: out } });
    assert.equal(fs.existsSync(path.join(dir, 'pwned')), true, 'interpolating the value into script text runs it: this is what the env form prevents');
  } finally { cleanup(dir); }
});

/**
 * @fileoverview A dry run of what `.github/workflows/release.yml` packs.
 *
 * The workflow has never run (no tag has been pushed), so nothing had caught that its tarball step named
 * `scripts/check-skill-updates.mjs`, a file that no longer exists: `tar` exits non-zero on a missing input and the
 * release would have died there (finding p-20261015060428-86c5). And its checksum step guards each script with
 * `fs.existsSync`, so the same missing name would have been DROPPED silently from `checksums.json` instead.
 *
 * `skills.manifest.json` is Category A (untracked; docs/plans/fleet-chips-and-merge-friction.md), and the workflow builds it
 * itself in the step before it reads it. This test performs the same sequence in a scratch directory: build the
 * manifest, run the workflow's OWN checksum script (extracted from the YAML, not re-typed), then run the workflow's OWN
 * tar command. It reads the workflow text, so editing the workflow changes what is proved.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '..');
const WORKFLOW = fs.readFileSync(path.join(REPO, '.github/workflows/release.yml'), 'utf8');

/** The `node -e "..."` checksum script of the "Build checksums" step, exactly as the workflow runs it. */
function checksumScript(text) {
  const m = /node -e "\r?\n([\s\S]*?)\r?\n\s+" --input-type=module/.exec(text);
  return m ? m[1].replace(/\$\{\{\s*steps\.tag\.outputs\.tag\s*\}\}/g, 'v0.0.0-dry-run') : null;
}

/** The tar command line of the "Create skills bundle tarball" step. */
function tarCommand(text) {
  const m = /run: (tar -czf \S+ [^\r\n]+)/.exec(text);
  return m ? m[1].trim().split(/\s+/) : null;
}

test('the release workflow\'s checksum script and tar command can be located (the probe is not vacuous)', () => {
  assert.ok(checksumScript(WORKFLOW), 'checksum script not found in release.yml: this test would prove nothing');
  const tar = tarCommand(WORKFLOW);
  assert.ok(tar && tar.length > 3, 'tar command not found in release.yml');
  assert.ok(tar.includes('skills.manifest.json'), 'the tarball must carry the manifest the workflow just built');
});

test('negative control: a tar input that does not exist is detected', () => {
  const inputs = ['skills/', 'scripts/install-skills.mjs', 'scripts/check-skill-updates.mjs'];
  const missing = inputs.filter((p) => !fs.existsSync(path.join(REPO, p)));
  assert.deepEqual(missing, ['scripts/check-skill-updates.mjs'], 'the probe must see the file the workflow used to name');
});

test('dry run: build the manifest, run the workflow\'s checksum script and tar command in a scratch directory', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'release-dry-run-'));
  try {
    // The workflow checks out the repo; mirror only what its steps read.
    fs.cpSync(path.join(REPO, 'skills'), path.join(scratch, 'skills'), { recursive: true });
    fs.mkdirSync(path.join(scratch, 'scripts'));
    for (const f of ['install-skills.mjs', 'build-manifest.mjs']) fs.copyFileSync(path.join(REPO, 'scripts', f), path.join(scratch, 'scripts', f));

    // Step "Build manifest": the workflow runs `node scripts/build-manifest.mjs` from its checkout root. Run the real
    // builder against the real tree, writing to the scratch path the later steps read.
    const built = spawnSync(process.execPath, [path.join(REPO, 'scripts/build-manifest.mjs'), '--manifest', path.join(scratch, 'skills.manifest.json')], { cwd: REPO, encoding: 'utf8' });
    assert.equal(built.status, 0, `build-manifest failed: ${built.stderr}`);

    // Step "Build checksums": the workflow's own script.
    const ran = spawnSync(process.execPath, ['--input-type=module', '-e', checksumScript(WORKFLOW)], { cwd: scratch, encoding: 'utf8' });
    assert.equal(ran.status, 0, `the workflow's checksum script failed: ${ran.stderr}`);
    const sums = JSON.parse(fs.readFileSync(path.join(scratch, 'checksums.json'), 'utf8'));
    // Its `fs.existsSync` guard drops a missing script SILENTLY, so assert each name the script lists is present.
    for (const name of ['scripts/install-skills.mjs', 'scripts/build-manifest.mjs', 'skills.manifest.json']) {
      assert.ok(sums.files[name], `checksums.json lacks ${name}: the workflow lists a path that is not there`);
    }
    const listed = [...checksumScript(WORKFLOW).matchAll(/'((?:scripts\/[\w.-]+|skills\.manifest\.json))',/g)].map((x) => x[1]);
    for (const name of listed) assert.ok(sums.files[name], `the workflow lists ${name} but checksums.json lacks it (silently skipped)`);

    // Step "Create skills bundle tarball": the workflow's own command.
    const [tar, ...args] = tarCommand(WORKFLOW);
    const packed = spawnSync(tar, args, { cwd: scratch, encoding: 'utf8' });
    assert.equal(packed.status, 0, `tar failed (a missing input exits non-zero): ${packed.stderr || packed.error}`);
    const listing = spawnSync('tar', ['-tzf', 'skills-bundle.tar.gz'], { cwd: scratch, encoding: 'utf8' });
    assert.equal(listing.status, 0, listing.stderr);
    assert.ok(listing.stdout.includes('skills.manifest.json'), 'the tarball lacks the manifest');
    assert.ok(listing.stdout.includes('scripts/install-skills.mjs'), 'the tarball lacks the installer');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

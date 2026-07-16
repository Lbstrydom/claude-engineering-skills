import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  ManifestSchema, MANIFEST_SUPPORTED_VERSIONS, FileEntrySchema, SkillEntrySchema,
} from '../../scripts/lib/schemas-install.mjs';

describe('MANIFEST_SUPPORTED_VERSIONS', () => {
  it('exports 1 and 2', () => {
    assert.ok(MANIFEST_SUPPORTED_VERSIONS.includes(1));
    assert.ok(MANIFEST_SUPPORTED_VERSIONS.includes(2));
  });

  it('is frozen', () => {
    assert.throws(() => MANIFEST_SUPPORTED_VERSIONS.push(3));
  });
});

describe('FileEntrySchema', () => {
  it('accepts a valid entry', () => {
    const e = FileEntrySchema.parse({ relPath: 'SKILL.md', sha: 'abc', size: 42 });
    assert.equal(e.relPath, 'SKILL.md');
  });

  it('rejects missing fields', () => {
    assert.throws(() => FileEntrySchema.parse({ relPath: 'x' }));
  });
});

describe('SkillEntrySchema', () => {
  it('accepts legacy v1 entry (files omitted)', () => {
    const e = SkillEntrySchema.parse({
      path: 'skills/x/SKILL.md', sha: 'abc', size: 10, summary: 'sum',
    });
    assert.equal(e.files, undefined);
  });

  it('accepts v2 entry with files array', () => {
    const e = SkillEntrySchema.parse({
      path: 'skills/x/SKILL.md', sha: 'abc', size: 10, summary: 'sum',
      files: [
        { relPath: 'SKILL.md', sha: 'abc', size: 10 },
        { relPath: 'references/x.md', sha: 'def', size: 20 },
      ],
    });
    assert.equal(e.files.length, 2);
  });
});

describe('ManifestSchema', () => {
  it('accepts v1 shape', () => {
    const m = ManifestSchema.parse({
      schemaVersion: 1,
      bundleVersion: 'abc',
      repoUrl: 'https://example.com',
      rawUrlBase: 'https://example.com/raw',
      updatedAt: new Date().toISOString(),
      skills: {
        demo: { path: 'skills/demo/SKILL.md', sha: 'aaa', size: 10, summary: 'demo' },
      },
    });
    assert.equal(m.schemaVersion, 1);
  });

  it('accepts v2 shape with files arrays', () => {
    const m = ManifestSchema.parse({
      schemaVersion: 2,
      bundleVersion: 'xyz',
      repoUrl: 'https://example.com',
      rawUrlBase: 'https://example.com/raw',
      updatedAt: new Date().toISOString(),
      skills: {
        demo: {
          path: 'skills/demo/SKILL.md', sha: 'aaa', size: 10, summary: 'demo',
          files: [{ relPath: 'SKILL.md', sha: 'aaa', size: 10 }],
        },
      },
    });
    assert.equal(m.schemaVersion, 2);
    assert.equal(m.skills.demo.files.length, 1);
  });
});

// End-to-end version-gate test: invoke the installer as a child process
// against a crafted unsupported-version manifest and verify it exits 1
// with UNSUPPORTED_MANIFEST_VERSION.
describe('installer version-gate entrypoint', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'install-gate-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

  it('rejects schemaVersion 99 with UNSUPPORTED_MANIFEST_VERSION', async () => {
    // Arrange a synthetic target dir with a skills/ and a v99 manifest
    const repoDir = path.join(tmp, 'repo');
    fs.mkdirSync(repoDir);
    fs.writeFileSync(path.join(repoDir, '.git'), '');
    fs.writeFileSync(path.join(repoDir, 'package.json'), '{}');
    fs.mkdirSync(path.join(repoDir, 'skills', 'demo'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'skills', 'demo', 'SKILL.md'), '# demo');
    fs.writeFileSync(path.join(repoDir, 'skills.manifest.json'), JSON.stringify({
      schemaVersion: 99,
      bundleVersion: 'x',
      repoUrl: 'https://example.com',
      rawUrlBase: 'https://example.com/raw',
      updatedAt: new Date().toISOString(),
      skills: {},
    }));

    const { spawnSync } = await import('node:child_process');
    const installerPath = path.resolve('scripts/install-skills.mjs');
    const result = spawnSync(process.execPath, [installerPath, '--local', '--dry-run'], {
      cwd: repoDir,
      encoding: 'utf-8',
      env: { ...process.env, NO_COLOR: '1' },
    });

    assert.notEqual(result.status, 0, `expected non-zero exit, got ${result.status}`);
    const combined = (result.stdout || '') + (result.stderr || '');
    assert.ok(combined.includes('UNSUPPORTED_MANIFEST_VERSION'), `missing error marker in: ${combined}`);
    assert.ok(combined.includes('99'), `missing version in error: ${combined}`);
  });
});

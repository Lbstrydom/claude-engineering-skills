import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
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

// The end-to-end "installer refuses a v99 manifest" test was REMOVED, not
// weakened, when the install path was retired
// (docs/plans/repo-scoped-skill-surfaces-and-installer.md §2 D2/D3/D4).
//
// The gate existed to protect ONE thing: an old installer reading a manifest
// written by a newer bundle. `skills.manifest.json` no longer has a runtime
// consumer — `build-manifest.mjs` writes and freshness-checks it, and
// `tiered-shadow-contract-digest.mjs` reads only its `bundleVersion` string.
// Nothing parses it as an install input, so there is no reader left to protect
// and no entrypoint left to invoke. Keeping the test would have required
// keeping a dead `loadManifest` in a script that can no longer install.
//
// The schema-level contract above is what survives and still matters: it is
// what `build-manifest.mjs` writes against, and MANIFEST_SUPPORTED_VERSIONS is
// still the declared compatibility window. If a manifest consumer is ever
// reintroduced, restore an entrypoint test with it — not before.

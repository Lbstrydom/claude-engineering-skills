/**
 * @fileoverview `--scope diff` admission (lib/diff-scope-admission.mjs).
 *
 * Field report 2026-09-26: a dirty tree with 26 persona screenshots printed
 * "34 changed files" and fed all 34 — PNGs included — into `changedFiles`, the
 * R2+ impact set, before `mergeScopeFiles` rejected them. These tests pin the
 * partition to the SAME allowlist `mergeScopeFiles` admits with.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { partitionDiffScope, formatDiffScopeNotices } from '../scripts/lib/diff-scope-admission.mjs';
import { resolveReferenceExtension } from '../scripts/lib/plan-paths.mjs';

const pngs = Array.from({ length: 26 }, (_, i) => `.audit/persona/shot-${i}.png`);

describe('partitionDiffScope — the field-report shape', () => {
  it('26 PNGs + 8 code files → 8 auditable, 26 ignored and grouped by extension', () => {
    const code = ['src/a.mjs', 'src/b.ts', 'docs/plans/x.md', 'db/1.sql', 'c.json', 'd.yml', 'e.py', 'f.sh'];
    const p = partitionDiffScope({ files: [...pngs, ...code] });
    assert.deepEqual(p.auditable, code, 'order preserved, nothing binary admitted');
    assert.equal(p.ignored.length, 26);
    assert.deepEqual(p.ignoredByExtension, { png: 26 });
    const lines = formatDiffScopeNotices(p);
    assert.deepEqual(lines, ['  [scope] 26 non-code file(s) ignored (png: 26)']);
  });

  it('uses the admission allowlist, not a second list (agreement with resolveReferenceExtension)', () => {
    const files = ['a.mjs', 'b.png', 'index.html.template', 'Dockerfile', 'pkg.json.lock', 'x.YAML', 'y.woff2'];
    const p = partitionDiffScope({ files });
    for (const f of files) {
      assert.equal(p.auditable.includes(f), resolveReferenceExtension(f) !== null, f);
    }
    assert.equal(p.ignoredByExtension['(no extension)'], 1);
  });

  it('negative control: an all-code set ignores nothing and prints nothing', () => {
    const p = partitionDiffScope({ files: ['a.mjs', 'b.md'], untracked: [], planText: '' });
    assert.equal(p.ignored.length, 0);
    assert.deepEqual(formatDiffScopeNotices(p), []);
  });
});

describe('partitionDiffScope — untracked files the plan never mentions', () => {
  it('warns for an untracked code file absent from the plan, and names --files', () => {
    const p = partitionDiffScope({
      files: ['scripts/lib/wanted.mjs', 'scratch/leftover.mjs'],
      untracked: ['scripts/lib/wanted.mjs', 'scratch/leftover.mjs'],
      planText: 'Add `scripts/lib/wanted.mjs` with a helper.',
    });
    assert.deepEqual(p.untrackedUnreferenced, ['scratch/leftover.mjs']);
    const warn = formatDiffScopeNotices(p).find((l) => l.includes('WARNING'));
    assert.match(warn, /1 untracked file\(s\) not referenced by the plan entered --scope diff: scratch\/leftover\.mjs/);
    assert.match(warn, /pass --files to pin scope/);
  });

  it('a plan citing only the basename counts as referenced', () => {
    const p = partitionDiffScope({ files: ['deep/dir/helper.mjs'], untracked: ['deep/dir/helper.mjs'], planText: 'see helper.mjs' });
    assert.deepEqual(p.untrackedUnreferenced, []);
  });

  it('TRACKED changes never trigger the untracked warning; ignored binaries never do either', () => {
    const p = partitionDiffScope({ files: ['a.mjs', ...pngs], untracked: [...pngs], planText: '' });
    assert.deepEqual(p.untrackedUnreferenced, []);
  });
});

/**
 * Extensionless git hook scripts are code (wine PR #1431, 2026-11-24).
 *
 * `.githooks/pre-push.local` was the ONLY file a consumer PR changed, and the taxonomy classified it `uncovered`: no
 * extension a table knows, no exact name. So it reached neither GPT nor the final gate, both "passed", and the gate
 * rated code coverage PARTIAL. CES's own `.githooks/pre-push` (with its fail-closed-on-signal trap) was invisible to its
 * audits in the same way. Every assertion in the first block fails on the pre-fix taxonomy (negative control).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  matchFileKind, fenceLanguageFor, commentPrefixFor, HOOK_SCRIPT_DIRS, HOOK_SCRIPT_PATH_PATTERN,
} from '../scripts/lib/file-taxonomy.mjs';
import { classifyFileCoverage, buildFileReferenceRegex } from '../scripts/lib/language-profiles.mjs';
import { resolveReferenceExtension, extractPlanPaths } from '../scripts/lib/plan-paths.mjs';
import { partitionDiffScope } from '../scripts/lib/diff-scope-admission.mjs';

const HOOKS = [
  '.githooks/pre-push',
  '.githooks/pre-push.local',
  '.githooks/post-merge',
  '.githooks\\post-checkout',          // a Windows-separated path is the same file
  '.husky/pre-commit',
  'frontend/.husky/commit-msg',        // a monorepo's husky dir is a hook dir too
];

describe('hook scripts are admitted as shell source', () => {
  for (const p of HOOKS) {
    it(`${p} → source/sh, admitted, model-only`, () => {
      const m = matchFileKind(p);
      assert.equal(m.kind, 'source', p);
      assert.equal(m.language, 'sh', p);
      assert.match(m.rule, /^hook-dir:/, p);
      assert.notEqual(resolveReferenceExtension(p), null, `${p} must pass the admission oracle`);
      assert.equal(classifyFileCoverage(p).class, 'model-only', p);
      assert.equal(fenceLanguageFor(p), 'bash', p);
      assert.equal(commentPrefixFor(p), '#', p);
    });
  }

  it('the diff-scope partition audits a hook instead of reporting it uncovered', () => {
    const p = partitionDiffScope({ files: ['.githooks/pre-push.local', '.githooks/pre-push'] });
    assert.deepEqual(p.auditable, ['.githooks/pre-push.local', '.githooks/pre-push']);
    assert.deepEqual(p.uncovered, []);
  });

  it('every declared hook dir is honoured (no dir in the list is inert)', () => {
    for (const d of HOOK_SCRIPT_DIRS) assert.equal(matchFileKind(`${d}/pre-push`).kind, 'source', d);
  });
});

describe('husky helper dir is generated, not reviewed', () => {
  // The nested ones: generated wins wherever it sits, not decided by which hook segment comes first (audit R1 H2/M2/M6).
  for (const p of ['.husky/_/husky.sh', '.husky/_/h', '.husky/_/pre-commit', '.husky/_/.gitignore',
    '.githooks/vendor/.husky/_/pre-commit', '.githooks/.husky/_/h']) {
    it(`${p} → non-code`, () => {
      assert.equal(matchFileKind(p).kind, 'non-code', p);
      assert.equal(resolveReferenceExtension(p), null, p);
    });
  }
});

describe('controls: the rule is scoped to hook directories and yields to real extensions', () => {
  it('an extensionless file outside a hook dir stays uncovered', () => {
    assert.equal(matchFileKind('scripts/pre-push').kind, 'uncovered');
    assert.equal(matchFileKind('bin/post-merge').kind, 'uncovered');
  });
  it('a FILE named like a hook dir is not a hook', () => {
    assert.equal(matchFileKind('docs/.githooks').kind, 'uncovered');
    assert.equal(matchFileKind('x/.husky').kind, 'uncovered');
  });
  it('a known extension inside a hook dir keeps its own classification', () => {
    assert.deepEqual([matchFileKind('.githooks/lib/check.mjs').kind, matchFileKind('.githooks/lib/check.mjs').language], ['source', 'js']);
    assert.equal(matchFileKind('.githooks/README.md').kind, 'declarative');
    assert.equal(matchFileKind('.githooks/diagram.png').kind, 'non-code');
    assert.equal(matchFileKind('.husky/.gitignore').rule, 'name:.gitignore');
    assert.equal(fenceLanguageFor('.husky/.gitignore'), 'js', 'fence follows the classifier, not the directory');
  });
});

describe('free-text references to hook scripts are extracted', () => {
  const refs = (text) => [...text.matchAll(buildFileReferenceRegex())].map((m) => m[1]);

  it('buildFileReferenceRegex captures hook paths whole, without trailing prose punctuation', () => {
    assert.deepEqual(
      refs('Edit .githooks/pre-push. Then `.githooks/check.sh.local` and frontend/.husky/pre-commit, plus Dockerfile.'),
      ['.githooks/pre-push', '.githooks/check.sh.local', 'frontend/.husky/pre-commit', 'Dockerfile'],
    );
  });
  it('control: an extensionless path outside a hook dir is still not a reference', () => {
    assert.deepEqual(refs('see scripts/pre-push here'), []);
  });
  it('a name the fragment cannot spell is skipped, never truncated to a different real path (audit R1 H3/M1/M4)', () => {
    assert.deepEqual(refs('see .githooks/pre-push+custom and .githooks/pre+push here'), []);
    assert.deepEqual(refs('(.githooks/pre-push), ".husky/pre-commit"; .githooks/post-merge!'),
      ['.githooks/pre-push', '.husky/pre-commit', '.githooks/post-merge']);
  });
  it('extractPlanPaths drops a hook inside node_modules at any depth (audit R1 H1/M3)', () => {
    const { allPaths } = extractPlanPaths('See frontend/node_modules/pkg/.husky/pre-commit and `node_modules/x/.githooks/pre-push`.');
    assert.deepEqual([...allPaths], []);
  });
  it('the fragment is capture-free (safe to splice into a caller regex)', () => {
    assert.equal(new RegExp(`${HOOK_SCRIPT_PATH_PATTERN}|`).exec('').length, 1);
  });
  it('extractPlanPaths finds a cited hook that exists in this repo', () => {
    assert.ok(fs.existsSync('.githooks/pre-push'), 'fixture: this repo carries .githooks/pre-push');
    const { found } = extractPlanPaths('Harden `.githooks/pre-push` and .githooks/post-checkout to fail closed.');
    assert.ok(found.includes('.githooks/pre-push'), JSON.stringify(found));
    assert.ok(found.includes('.githooks/post-checkout'), JSON.stringify(found));
  });
});

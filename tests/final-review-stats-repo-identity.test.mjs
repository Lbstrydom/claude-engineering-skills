/**
 * @fileoverview Regression guard: `final-review-stats --worksheet` must decide
 * "is the requested repo the one I'm standing in?" by FULL repo identity, never
 * a directory basename.
 *
 * Found in passing (2026-08-22) while implementing an unrelated cluster: the
 * ambient-vs-requested comparison went through `repoBaseName()` on both sides,
 * so two DISTINCT repositories that merely share a directory name (two orgs
 * each hosting a repo called "widget") would collide and be treated as the
 * same checkout — pulling THIS checkout's grounding notes (which read local
 * files at `primary_file` paths) into a worksheet meant for the other repo.
 * That is the sensitive-egress class AGENTS.md's sensitive-paths doctrine
 * names explicitly: compare full identity, never a substring/basename.
 *
 * `getFinalReviewStats(repoName)` resolves `--repo` with an EXACT
 * `WHERE name = $1` against `audit_repos.name` (the `owner/repo` slug —
 * AGENTS.md's `LEARNING_REPO_NAME` row), and `resolveRepoIdentity().name`
 * produces that same slug in the normal git-origin-present case. So the fix
 * compares `ambientName === repoName` directly — no basename step needed.
 *
 * This test drives the REAL `resolveRepoIdentity()` against this repo's own
 * git origin (no mocking layer exists for dynamic ES imports in this
 * codebase), then constructs a distinct fictitious repo name that shares only
 * the basename, and asserts the worksheet path tells the two apart.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dispatch } from '../scripts/lib/cross-skill/dispatch.mjs';
import { resolveRepoIdentity } from '../scripts/lib/repo-identity.mjs';
import { repoBaseName } from '../scripts/lib/repo-scope.mjs';
import { scratchPath } from '../scripts/lib/temp-paths.mjs';

const ambientName = resolveRepoIdentity(process.cwd())?.name ?? null;

function recordingDeps(shadowOnlyQueue) {
  return {
    getFinalReviewStats: async () => ({ ok: true, cloud: true, shadowOnlyQueue }),
  };
}

const QUEUE = [{
  run_id: '93580799-977d-4fef-9465-fbe4be47213c',
  finding_fingerprint: 'e476d966',
  severity: 'HIGH',
  category: 'Boundary Condition Error',
  primary_file: 'some/file.mjs',
  detail_snapshot: 'placeholder finding for the identity test',
  user_action: null,
}];

const outPath = () => scratchPath('final-review-repo-identity-test', `${Math.random().toString(36).slice(2)}.md`);

describe('final-review-stats --worksheet — repo identity, not basename', () => {
  before(() => {
    assert.ok(
      ambientName && ambientName.includes('/'),
      `precondition: this checkout must resolve an "owner/repo" identity (got ${JSON.stringify(ambientName)}) — ` +
      're-run inside a clone with a configured git origin',
    );
  });

  it('a DIFFERENT repo sharing only the basename is NOT treated as ambient', async () => {
    const base = repoBaseName(ambientName);
    const impostor = `some-other-org/${base}`;
    assert.notEqual(impostor, ambientName, 'precondition: impostor must differ in full identity');
    assert.equal(repoBaseName(impostor), base, 'precondition: impostor must share the basename (the collision this guards)');

    const out = outPath();
    const r = await dispatch(
      ['node', 'cross-skill.mjs', 'final-review-stats', '--repo', impostor, '--worksheet', '--out', out],
      { deps: recordingDeps(QUEUE), cloudGate: 'ready' },
    );
    assert.equal(r.exitCode, 0, JSON.stringify(r.envelope));
    const md = fs.readFileSync(out, 'utf8');
    assert.match(
      md, /Grounding notes OMITTED/,
      'a basename-only collision must not borrow this checkout\'s file-grounded notes for a different repo\'s worksheet',
    );
    assert.match(md, new RegExp(impostor.replace(/[/]/g, '\\/')), 'worksheet must name the requested (non-ambient) repo, not silently substitute the ambient one');
  });

  it('the REAL ambient repo IS treated as ambient (fix does not break the true-positive path)', async () => {
    const out = outPath();
    const r = await dispatch(
      ['node', 'cross-skill.mjs', 'final-review-stats', '--repo', ambientName, '--worksheet', '--out', out],
      { deps: recordingDeps(QUEUE), cloudGate: 'ready' },
    );
    assert.equal(r.exitCode, 0, JSON.stringify(r.envelope));
    const md = fs.readFileSync(out, 'utf8');
    assert.doesNotMatch(md, /Grounding notes OMITTED/, 'the true ambient repo must not be treated as a foreign checkout');
  });
});

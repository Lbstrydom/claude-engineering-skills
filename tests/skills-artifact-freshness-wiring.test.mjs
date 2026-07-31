/**
 * @fileoverview The regenerate/check PAIR must cover the same artifacts.
 *
 * `skills.manifest.json` is a Category-B artifact (a pure function of
 * `skills/**` — its `bundleVersion` is a content hash over every file's sha, so
 * the policy's "committed AND freshness-verified" rule applies). A freshness
 * gate for it already existed — `build-manifest.mjs --check` — and was correct.
 * Nothing ever called it.
 *
 * The result: both sides of the pair omitted the manifest. `skills:regenerate`
 * refreshed `.claude/skills/**` but not the manifest, so a developer who edited
 * a SKILL.md and ran the documented fix-it command produced a stale manifest —
 * and `skills:check` confirmed everything was fine. It stayed stale from
 * 2a4e613 until 2026-07-17, during which cross-repo installs of audit-code /
 * persona-test / ship failed outright on a SHA mismatch.
 *
 * That is the PARTIAL COLLECTION shape the backend rubric now names: one rule
 * ("keep skill-derived artifacts fresh") applied to only some of the artifacts
 * it must cover. So this asserts the INVARIANT — regenerate and check stay
 * symmetric — rather than just pinning today's missing line. A future artifact
 * added to one side and forgotten on the other fails here.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { buildManifest, extractSkillSummary } from '../scripts/build-manifest.mjs';
import { canonicaliseForHash } from '../scripts/lib/canonical-hash.mjs';

const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8'));
const regenerate = pkg.scripts['skills:regenerate'];
const check = pkg.scripts['skills:check'];
const fullCheck = pkg.scripts.check;

/** Generator scripts invoked by a chained npm script, e.g. `node scripts/x.mjs --check`. */
function scriptsIn(cmd) {
  return [...cmd.matchAll(/node\s+(scripts\/[\w./-]+\.mjs)/g)].map(m => m[1]);
}

describe('skills:regenerate and skills:check cover the same artifacts', () => {
  it('every generator run by skills:regenerate is verified by skills:check', () => {
    // The pair invariant. `check-skill-refs` / `check-gate-contracts` are
    // check-only (they generate nothing), so the containment is one-directional:
    // regenerate ⊆ check.
    const regenerated = scriptsIn(regenerate);
    const checked = new Set(scriptsIn(check));

    assert.ok(regenerated.length > 0, 'sanity: skills:regenerate must run generators');
    const unverified = regenerated.filter(s => !checked.has(s));
    assert.deepEqual(
      unverified, [],
      `these generators produce a committed artifact that NOTHING verifies for freshness: ${unverified.join(', ')}. `
      + 'Add a --check invocation to skills:check, or the artifact silently rots (as skills.manifest.json did).',
    );
  });

  it('the manifest is rebuilt AND verified — the case that actually rotted', () => {
    assert.match(regenerate, /build-manifest\.mjs/, 'skills:regenerate must rebuild the manifest');
    assert.match(check, /build-manifest\.mjs --check/, 'skills:check must verify the manifest');
  });

  it('the pre-push chain actually runs skills:check', () => {
    // A gate nobody calls is the defect this whole file exists for — the
    // manifest gate was correct and simply never invoked.
    assert.match(fullCheck, /skills:check/, 'npm run check must include skills:check');
  });
});

describe('build-manifest is deterministic — a true Category-B artifact', () => {
  it('a from-scratch regeneration is BYTE-IDENTICAL (no volatile provenance)', () => {
    // The policy's literal test (AGENTS.md generated-artifact invariant): "would
    // two regenerations on the same commit be byte-identical?" Until the volatile
    // `updatedAt` was removed, the answer was NO — the manifest sat in the
    // forbidden "messy middle" (committed AND freshness-checked, yet not a pure
    // function of source).
    //
    // `buildManifest()` is exported and PURE, so the property is asserted
    // directly on it. An earlier version of this test deleted the real
    // skills.manifest.json, spawned two builds and restored it in `finally` —
    // a Ctrl-C or a killed runner inside that window left the repo's COMMITTED
    // manifest deleted, and `node --test` runs files in parallel, so a
    // concurrent child could read it mid-flight. Never mutate a tracked file to
    // test a pure function.
    const a = buildManifest();
    const b = buildManifest();
    assert.deepEqual(a, b, 'two regenerations must be identical');
    assert.equal(JSON.stringify(a), JSON.stringify(b), 'and byte-identical once serialised');
    assert.ok(!('updatedAt' in a), 'no volatile provenance may reappear');
  });

  it('rebuilding an already-fresh manifest does not rewrite the file', () => {
    // Skip-if-identical is now pure UX (report "unchanged" rather than silently
    // re-touching); with no volatile field a rewrite would be byte-identical
    // anyway. Kept because a needless touch still reads as activity.
    //
    // Safe to run here: skills:check keeps the committed manifest fresh, so the
    // no-write path is the one under test. If it were stale this fails loudly —
    // which is itself correct, and exactly what the gate now blocks on.
    const manifestPath = path.join(process.cwd(), 'skills.manifest.json');
    const before = fs.readFileSync(manifestPath, 'utf-8');

    const r = spawnSync(process.execPath, ['scripts/build-manifest.mjs'], {
      cwd: process.cwd(), encoding: 'utf-8', timeout: 60_000,
    });

    assert.equal(r.status, 0, `build must succeed: ${r.stderr}`);
    assert.equal(
      fs.readFileSync(manifestPath, 'utf-8'), before,
      'a fresh manifest must be left byte-identical — otherwise every regenerate dirties the tree',
    );
    assert.match(r.stdout, /unchanged/, 'and it must say so, rather than claiming it wrote');
  });

  it('still REPAIRS a tampered manifest — idempotency must not break the remedy', () => {
    // The hole an earlier draft of the skip-if-unchanged guard opened: skipping
    // on a `bundleVersion` match alone let a hand-edited per-file `sha` (with
    // bundleVersion left intact) pass --check AND survive the rebuild. That
    // would break the one command every error message tells you to run.
    //
    // Runs against a THROWAWAY COPY via `--manifest`. This test used to tamper
    // with the repo's own committed manifest and restore it in `finally` — the
    // very thing the comment two tests above forbids. `node --test` runs files
    // in parallel, so that window was visible to concurrent readers, and a
    // killed runner left a TRACKED file mangled.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ces-manifest-'));
    const scratch = path.join(tmpDir, 'skills.manifest.json');
    try {
      const pristine = fs.readFileSync(path.join(process.cwd(), 'skills.manifest.json'), 'utf-8');
      const tampered = JSON.parse(pristine);
      const firstSkill = Object.keys(tampered.skills)[0];
      tampered.skills[firstSkill].sha = 'deadbeefcafe'; // bundleVersion untouched
      fs.writeFileSync(scratch, JSON.stringify(tampered, null, 2) + '\n');

      const r = spawnSync(process.execPath, ['scripts/build-manifest.mjs', '--manifest', scratch], {
        cwd: process.cwd(), encoding: 'utf-8', timeout: 60_000,
      });

      assert.equal(r.status, 0, `rebuild must succeed: ${r.stderr}`);

      const after = JSON.parse(fs.readFileSync(scratch, 'utf-8'));
      const expected = JSON.parse(pristine);
      assert.equal(
        after.skills[firstSkill].sha, expected.skills[firstSkill].sha,
        'the rebuild must repair the tampered sha, not skip the file as "unchanged"',
      );
      assert.deepEqual(after, expected, 'and restore the rest of the manifest exactly');
      assert.doesNotMatch(r.stdout, /unchanged/, 'a tampered manifest is NOT unchanged');

      // The committed file must be untouched by this test, by construction.
      assert.equal(
        fs.readFileSync(path.join(process.cwd(), 'skills.manifest.json'), 'utf-8'), pristine,
        'the tracked manifest must never be written by a test',
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});

/**
 * The Category-B contract is "a pure function of COMMITTED source". Hashing raw
 * working-tree bytes broke it silently: `.gitattributes` pins `* text=auto
 * eol=lf`, so committed content is LF, but a tool can leave CRLF in the working
 * tree — and git reports those files CLEAN because it normalises on comparison.
 * `bundleVersion` therefore became a function of local line endings, and 16
 * skill reference files were contaminated, so a fresh clone computed a
 * different hash and read STALE. Caught 2026-07-20 by the pre-push sandbox
 * (docs/runbooks/prepush-sandbox.md), which builds the manifest in a clean
 * checkout — the first thing that ever compared the two.
 */
describe('the manifest hashes committed source, not working-tree bytes', () => {
  it('canonicaliseForHash normalises CRLF to LF', () => {
    const crlf = Buffer.from('a\r\nb\r\n', 'utf-8');
    assert.equal(canonicaliseForHash(crlf).toString('utf-8'), 'a\nb\n');
  });

  it('leaves LF content byte-identical', () => {
    const lf = Buffer.from('a\nb\n', 'utf-8');
    assert.deepEqual(canonicaliseForHash(lf), lf);
  });

  it('does not strip a lone CR that is not a line ending', () => {
    const cr = Buffer.from('a\rb', 'utf-8');
    assert.equal(canonicaliseForHash(cr).toString('utf-8'), 'a\rb');
  });

  it('every manifest entry matches the sha of the file as COMMITTED', () => {
    // The real contract, asserted against git's own copy rather than the
    // working tree — so this holds regardless of local line endings and fails
    // if anyone reverts the normalisation.
    const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'skills.manifest.json'), 'utf-8'));
    for (const [name, skill] of Object.entries(manifest.skills)) {
      for (const f of skill.files) {
        const committed = execFileSync(
          'git', ['show', `HEAD:skills/${name}/${f.relPath}`],
          { cwd: process.cwd(), maxBuffer: 1e8 },
        );
        const sha = createHash('sha256').update(canonicaliseForHash(committed)).digest('hex').slice(0, 12);
        assert.equal(
          f.sha, sha,
          `skills/${name}/${f.relPath}: manifest sha tracks the working tree, not the commit`,
        );
      }
    }
  });
});

describe('build-manifest --check compares CONTENT, not just versions', () => {
  it('flags a manifest whose per-file sha was edited while bundleVersion stayed intact', () => {
    // The gate hole: `--check` compared only `bundleVersion` + `schemaVersion`,
    // which do not authenticate the rest of the artifact — so a hand-edited sha,
    // a dropped skill or a reordered key reported FRESH. A Category-B artifact's
    // whole contract is that a fresh clone regenerates it byte-identically, and
    // this is the gate that is supposed to prove it.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ces-check-'));
    const scratch = path.join(tmpDir, 'skills.manifest.json');
    try {
      const pristine = fs.readFileSync(path.join(process.cwd(), 'skills.manifest.json'), 'utf-8');
      const tampered = JSON.parse(pristine);
      tampered.skills[Object.keys(tampered.skills)[0]].sha = 'deadbeefcafe';
      fs.writeFileSync(scratch, JSON.stringify(tampered, null, 2) + '\n');

      const r = spawnSync(
        process.execPath, ['scripts/build-manifest.mjs', '--check', '--manifest', scratch],
        { cwd: process.cwd(), encoding: 'utf-8', timeout: 60_000 },
      );
      assert.equal(r.status, 1, 'a content-tampered manifest must FAIL --check');
      assert.match(r.stderr, /versions match/, 'and must say the versions matched but content differs');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('passes --check on the real, fresh manifest', () => {
    const r = spawnSync(process.execPath, ['scripts/build-manifest.mjs', '--check'], {
      cwd: process.cwd(), encoding: 'utf-8', timeout: 60_000,
    });
    assert.equal(r.status, 0, `the committed manifest must be fresh: ${r.stderr}`);
  });
});

describe('extractSkillSummary respects YAML block boundaries', () => {
  const mk = (d) => `---\nname: x\n${d}\n---\nbody\n`;

  it('an EMPTY block scalar does not swallow the next sibling key', () => {
    // Ignoring indentation made `description: |` followed by `version: 1` return
    // "version: 1" as the description — a neighbouring field silently becoming
    // the skill's advertised summary.
    assert.equal(extractSkillSummary(mk('description: |\nversion: 1')), null);
  });

  it('handles literal (|) and folded (>) block scalars and inline forms', () => {
    assert.equal(extractSkillSummary(mk('description: |\n  Literal.')), 'Literal.');
    assert.equal(extractSkillSummary(mk('description: >\n  Folded.')), 'Folded.');
    assert.equal(extractSkillSummary(mk('description: >-\n  Chomped.')), 'Chomped.');
    assert.equal(extractSkillSummary(mk('description: Inline.')), 'Inline.');
    assert.equal(extractSkillSummary(mk('description: "Quoted."')), 'Quoted.');
  });
});

/**
 * `--target-path` — sync into any repo, not only a registered one.
 *
 * This is a **Tier-3 seam** (AGENTS.md testing doctrine): the consumer
 * sync/relocation contract, where a break ships silently to repos we cannot
 * observe. So the central assertion is not "the flag works" but the D5a property
 * that makes it safe to have two target sources at all:
 *
 *   an ad-hoc target and a registry target must produce IDENTICAL output for the
 *   same directory
 *
 * If that ever diverges, `decorateTarget` has stopped being the single
 * construction site and one of the two sources is building its own target shape
 * — which is the exact failure mode `install.mjs`'s hand-maintained file list
 * already demonstrated once.
 *
 * Plan: docs/plans/repo-scoped-skill-surfaces-and-installer.md §2 D5/D5a, §6 S2.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  INSTALL_REQUIRED, DEPS_SATISFIED_MARKER, seedInstalledDeps, runSyncCli, whySyncFailed,
} from './helpers/consumer-fixture.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The sync installs the bundle's deps into the target, over the network — which
 * is what made the two deploy tests below fail intermittently, with no code
 * change involved: this file's 240s subprocess bound was TIGHTER than the
 * install's own caps, so on a slow network the parent killed the child and the
 * symptom was a bare `null !== 0`.
 *
 * Both halves of the fix now live in `helpers/consumer-fixture.mjs`, shared with
 * the two sibling suites that drive the same CLI — the derived budget, and the
 * seeding that keeps this file's SUBJECT (the `--target-path` deployment
 * contract, D5a) off the network entirely. Read that module's header for why.
 */

let tmp;

before(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ces-tpath-'))); });
after(() => { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

function mkRepo(name) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, '.git'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, type: 'module' }, null, 2));
  fs.writeFileSync(path.join(dir, '.gitignore'), '');
  seedInstalledDeps(dir);
  return dir;
}

/** The shared CLI wrapper — see helpers/consumer-fixture.mjs on why it is not local. */
const run = (argv, opts = {}) => runSyncCli(argv, opts);

/**
 * The sync's own bookkeeping files, which are EXPECTED to differ between runs
 * and between targets. Named explicitly rather than filtered by a loose pattern,
 * so an exclusion can never quietly grow to cover a real regression:
 *
 *  - `.sync-manifest.json`     — carries a timestamp + HEAD sha, and records the
 *                                destination repo's name.
 *  - `.sync-watermark.json`    — the ownership high-water mark; volatile by
 *                                design (LAYOUT_CONSTANTS.OWNERSHIP_WATERMARK).
 *  - `.skills-fit-check.json`  — NOT a synced file at all: a first-sync
 *                                diagnostic that `skills-fit-check.mjs` generates
 *                                ABOUT the target, carrying `generatedAt` and the
 *                                absolute `repoRoot`. Differing per target is its
 *                                correct behaviour, not a parity break.
 *
 * All three are Category-A artefacts (gitignored, derived from mutable state).
 * Every other byte in the tree must match.
 */
const VOLATILE_BOOKKEEPING = [
  'scripts/.sync-manifest.json',
  // The in-repo sync trace (lib/sync-receipt.mjs). Carries `syncedAt` and the
  // source stamp, so two targets synced seconds apart differ by construction —
  // the same reason the manifest above is excluded. Unlike the others it is
  // COMMITTED in a consumer on purpose; that makes its churn meaningful there
  // and still meaningless for a byte-parity comparison between two fixtures.
  '.sync-receipt.json',
  'scripts/.claude-skills/.sync-watermark.json',
  '.skills-fit-check.json',
  // npm-owned. Both embed the package NAME, which differs between fixture repos
  // by construction, so a byte comparison is meaningless here.
  //
  // But `package.json` is NOT purely npm's: the sync mutates it (`ensureAuditDeps`
  // adds the bundle's runtime dependencies), so excluding the whole file would
  // hide a real parity break in the one part of it we own. The idempotency test
  // below asserts on that part directly instead of waving the file away.
  'package.json',
  'package-lock.json',
];

/** The dependency set the sync itself installs — the part of package.json we own. */
function ownedDeps(repoDir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoDir, 'package.json'), 'utf8'));
  return { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
}

function dropVolatile(snap) {
  for (const rel of VOLATILE_BOOKKEEPING) snap.delete(rel);
  return snap;
}

/** Content-addressed snapshot of a tree: relPath -> sha256. */
function snapshot(dir, base = dir, out = new Map()) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    // ENOENT only. Any other failure — a permission error, a handle Windows
    // has not released — must surface: a partial snapshot compares clean
    // against another partial snapshot, so swallowing it turns an unreadable
    // subtree into a PASS on the idempotency assertions below (round-1 code
    // audit M7, 2026-09-04).
    if (err?.code !== 'ENOENT') {
      throw new Error(`snapshot(): could not enumerate ${dir}: ${err?.code ?? err?.message}`, { cause: err });
    }
    return out;
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    // Neither is deployed bundle content: `.git` is the consumer's own VCS
    // state, and `node_modules` is npm's (the sync installs the bundle's runtime
    // deps into the target, so it exists but is not something we wrote).
    if (e.name === '.git' || e.name === 'node_modules') continue;
    if (e.isDirectory()) snapshot(abs, base, out);
    else {
      out.set(
        path.relative(base, abs).replaceAll('\\', '/'),
        crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex'),
      );
    }
  }
  return out;
}

describe('sync --target-path — argument handling', () => {
  it('rejects --target and --target-path together rather than preferring one', async () => {
    const r = await run(['--dry-run', '--target', 'wine', '--target-path', tmp]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /mutually exclusive/);
  });

  it('rejects a non-existent path', async () => {
    const r = await run(['--dry-run', '--target-path', path.join(tmp, 'nope')]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /does not exist/i);
  });

  it('refuses to sync the source repo onto itself', async () => {
    const r = await run(['--dry-run', '--target-path', REPO_ROOT]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /source repo/i);
  });

  it('refuses a directory inside the source repo', async () => {
    const r = await run(['--dry-run', '--target-path', path.join(REPO_ROOT, 'scripts')]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /source repo/i);
  });

  it('is in KNOWN_FLAGS — an adjacent typo is refused, not ignored', async () => {
    const r = await run(['--dry-run', '--target-pathh', tmp]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr + r.stdout, /unknown flag/i);
  });
});

describe('sync --target-path — it actually deploys', () => {
  // Round-2 M4: the intentional no-install branch, named. It was previously
  // asserted only in passing inside the layout test, which made "this suite
  // deliberately does not provision dependencies" an implicit property — the
  // kind that gets deleted by someone who cannot see it was load-bearing.
  // Real provisioning is covered deterministically and offline by
  // tests/install-deps-contract.test.mjs, and end-to-end on demand by
  // SYNC_TARGET_PATH_INSTALL_REQUIRED=1.
  it('by default spawns NO package manager — the fixture is already satisfied', async (t) => {
    if (INSTALL_REQUIRED) {
      return t.skip('SYNC_TARGET_PATH_INSTALL_REQUIRED=1 — the real install branch is under test instead');
    }
    const target = mkRepo('no-install');
    const r = await run(['--target-path', target, '--no-prompt']);
    assert.equal(r.code, 0, whySyncFailed(r));
    const out = r.stderr + r.stdout;
    assert.match(out, new RegExp(DEPS_SATISFIED_MARKER), 'the sync must report the deps already present');
    assert.doesNotMatch(out, /Installing (required|optional) audit-loop deps/,
      'no install may be attempted against a satisfied consumer');
    assert.ok(!fs.existsSync(path.join(target, 'package-lock.json')),
      'a lockfile would prove a package manager ran');
  });

  it('produces the consumer layout in an EMPTY repo (the first-install case)', async () => {
    const target = mkRepo('fresh');
    const r = await run(['--target-path', target, '--no-prompt']);
    assert.equal(r.code, 0, whySyncFailed(r));

    // The seed took, so no package manager was spawned. Without this the file
    // could go back to installing over the network and nothing would say so.
    if (!INSTALL_REQUIRED) {
      assert.match(r.stderr + r.stdout, new RegExp(DEPS_SATISFIED_MARKER),
        'a seeded fixture must report its deps satisfied, not install them');
    }

    // The three halves that make a consumer functional.
    assert.ok(fs.existsSync(path.join(target, 'scripts', '.claude-skills')),
      'runners must land in the isolated tooling dir');
    assert.ok(fs.existsSync(path.join(target, '.claude', 'skills', 'ship', 'SKILL.md')),
      'skills must land at the canonical repo-scoped path');
    assert.ok(fs.existsSync(path.join(target, 'scripts', '.sync-manifest.json')),
      'the manifest must be written');

    // The COMMITTED ownership sidecar (2026-09-04). The manifest above is
    // gitignored on both sides, so it is absent from every fresh clone — this
    // file is what lets a consumer answer "is this mine to fix?" offline, and
    // asserting it HERE rather than only in a unit test is the difference
    // between "the builder works" and "the sync writes it".
    const sidecarPath = path.join(target, 'scripts', '.sync-owned.json');
    assert.ok(fs.existsSync(sidecarPath), 'the ownership sidecar must be written');
    const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
    assert.equal(sidecar.version, 1);
    assert.equal(sidecar.comparison, 'case-insensitive');
    assert.ok(sidecar.paths.length > 0, 'an empty path set would assert nothing is upstream-owned');
    assert.ok(sidecar.paths.includes('.claude/skills/ship/SKILL.md'),
      'it must cover the COMMITTED surfaces, which git-ignore state and the banner cannot classify');
    assert.ok(sidecar.paths.some((p) => p.startsWith('scripts/.claude-skills/')),
      'and the gitignored tooling tree too');
    // Committed artifact: no clock, no sha, or it churns on every push.
    assert.doesNotMatch(JSON.stringify(sidecar), /\d{4}-\d{2}-\d{2}T/);

    // And the whole point of the exercise: the SKILL.md must cite the CONSUMER
    // runner layout, not the source one. This is the bug the plan exists to fix.
    const ship = fs.readFileSync(path.join(target, '.claude', 'skills', 'ship', 'SKILL.md'), 'utf8');
    assert.ok(ship.includes('scripts/.claude-skills/ship-commit.mjs'),
      'runner paths must be rewritten for the consumer layout');
    assert.ok(!/node scripts\/ship-commit\.mjs/.test(ship),
      'no unrewritten source-layout runner path may survive');
  });

  // D5a: the regression lock. Two target SOURCES, one construction site.
  //
  // Asserted at `decorateTarget` rather than by running the registry path
  // end-to-end. The earlier version of this test wrote
  // `scripts/lib/consumer-repos.local.json` into the REAL checkout and restored
  // it in a `finally` — which mutates repository state a developer may be using
  // (that file is how a private consumer is registered), and loses on
  // interruption or a concurrent run. This repo routinely has two sessions in
  // one working tree, so that is not a theoretical hazard.
  //
  // Nothing is lost by moving down a layer: `decorateTarget` IS the single
  // construction site, so identical output from it is exactly the property that
  // makes the two sources interchangeable. The end-to-end half is still covered
  // — the ad-hoc path deploys for real in the test above, and the registry path
  // is exercised on every actual `npm run sync`.
  it('decorateTarget yields an identical bundle for registry and ad-hoc identities', async () => {
    const { decorateTarget } = await import('../scripts/sync-to-repos.mjs');

    const registryIdentity = { name: 'wine-cellar-app', alias: 'wine', path: path.join(tmp, 'as-registry') };
    const adhocIdentity = { name: 'as-adhoc', alias: null, path: path.join(tmp, 'as-adhoc') };

    const a = decorateTarget(registryIdentity);
    const b = decorateTarget(adhocIdentity);

    assert.deepEqual(a.files, b.files,
      'the deployed file set must not depend on which source produced the identity');
    assert.deepEqual(a.unresolved, b.unresolved);
    // And the identity itself must survive intact — decoration adds, never edits.
    assert.equal(a.name, registryIdentity.name);
    assert.equal(a.alias, 'wine');
    assert.equal(b.alias, null);
    assert.ok(a.files.length > 100, 'sanity: the bundle should be substantial, not empty');
  });

  it('is idempotent — a second run reports unchanged and rewrites nothing', async () => {
    const target = mkRepo('idem');
    const first = await run(['--target-path', target, '--no-prompt']);
    assert.equal(first.code, 0, whySyncFailed(first));
    const before = dropVolatile(snapshot(target));
    const depsBefore = ownedDeps(target);

    const second = await run(['--target-path', target, '--no-prompt']);
    assert.equal(second.code, 0, whySyncFailed(second));
    const after = dropVolatile(snapshot(target));

    // package.json is excluded from the byte snapshot because it carries the
    // repo's own name — but the part the SYNC owns must still be stable, or
    // "idempotent" would be asserted over a file we deliberately stopped looking at.
    assert.deepEqual(ownedDeps(target), depsBefore,
      'the dependency set the sync installs must not churn on re-sync');
    if (!INSTALL_REQUIRED) {
      // Under the seed that set is empty, and an empty-vs-empty comparison
      // proves nothing on its own — so state the stronger property it stands
      // for here: a sync into an already-satisfied consumer must not touch
      // package.json at all. A regression that ran `add -D` unconditionally
      // would fail this even though the two sets still matched each other.
      assert.deepEqual(depsBefore, {},
        'nothing may be added to a consumer that already has every dep');
      assert.match(second.stderr + second.stdout, new RegExp(DEPS_SATISFIED_MARKER));
    }
    assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());
    for (const [rel, sha] of before) assert.equal(sha, after.get(rel), `${rel} churned on re-sync`);

    // The DELIVERY post-condition, end to end: the manifest is a claim about
    // the consumer's tree, and until 2026-08-30 nothing ever checked it against
    // that tree. One consumer ended two pushes missing a migration its manifest
    // claimed — the JS half of a feature without the schema half — while every
    // source-side signal read `Targets: 3/3 reached`. The unit half lives in
    // tests/sync-delivery-postcondition.test.mjs; this is the half that proves
    // a REAL sync satisfies it.
    const manifest = JSON.parse(
      fs.readFileSync(path.join(target, 'scripts', '.sync-manifest.json'), 'utf8'),
    );
    const claimedButAbsent = Object.keys(manifest.files ?? {})
      .filter((rel) => !fs.existsSync(path.join(target, rel)));
    assert.deepEqual(claimedButAbsent, [],
      'the manifest must not claim files the consumer does not have');
  });
});

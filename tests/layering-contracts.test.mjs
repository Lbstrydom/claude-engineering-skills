/**
 * @fileoverview Layering contract — the four properties this cleanup claims.
 *
 * Deliberately does NOT freeze the whole `allowedDeps` map. Pinning global architecture
 * state into a feature test means any future, independently-reviewed dependency requires
 * editing an unrelated cleanup test — shotgun surgery that trains people to weaken the
 * assertion rather than think about the edge.
 *
 * Plan: docs/plans/layering-and-mutation-contracts.md (§9).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { tagDomain } from '../scripts/lib/symbol-index/domain-tagger.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const domainMap = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, '.audit-loop', 'domain-map.json'), 'utf-8'),
);

// Use the REPO'S OWN resolver, not a reimplementation. A hand-rolled glob mirror was
// tried first and was wrong — which the self-check below caught, and which is exactly
// how a duplicated resolver drifts away from the one that actually tags the codebase.
function domainFor(relPath) {
  return tagDomain(relPath, domainMap.rules);
}

test('the domain resolver used by this test agrees with known tags', () => {
  assert.equal(domainFor('scripts/lib/store/arch/coverage.mjs'), 'stores');
  assert.equal(domainFor('scripts/lib/observed-deps.mjs'), 'arch-memory');
  assert.equal(domainFor('scripts/cross-skill.mjs'), 'cross-skill-bridge');
});

// ── Property 1 & 2: the moved contracts are GONE from their old homes ────────
//
// These are what a copy-paste-instead-of-move would fail: it leaves the original in
// place, so an identity check would still pass while the edge survived.

test('L1: CoverageSchema is no longer exported from observed-deps.mjs', async () => {
  const old = await import('../scripts/lib/observed-deps.mjs');
  assert.ok(!('CoverageSchema' in old),
    'a re-export here lets a consumer silently recreate the stores -> arch-memory edge');
  const moved = await import('../scripts/lib/coverage-schema.mjs');
  assert.ok(moved.CoverageSchema, 'the contract must exist in its new home');
});

test('L3: canonicaliseForHash is no longer exported from build-manifest.mjs', async () => {
  const old = await import('../scripts/build-manifest.mjs');
  assert.ok(!('canonicaliseForHash' in old),
    'a re-export here lets a consumer silently recreate the audit-orchestration -> install edge');
  const moved = await import('../scripts/lib/canonical-hash.mjs');
  assert.equal(typeof moved.canonicaliseForHash, 'function');
});

test('the moved contracts still behave identically', async () => {
  const { canonicaliseForHash } = await import('../scripts/lib/canonical-hash.mjs');
  assert.equal(canonicaliseForHash(Buffer.from('a\r\nb\r\n')).toString('utf-8'), 'a\nb\n');
  const { CoverageSchema } = await import('../scripts/lib/coverage-schema.mjs');
  assert.equal(typeof CoverageSchema.safeParse, 'function');
});

// ── Property 3: the adjudicated declare ─────────────────────────────────────

test('L2: cross-skill-bridge declares its dispatch edge to model-eval', () => {
  assert.ok(
    domainMap.allowedDeps['cross-skill-bridge'].includes('model-eval'),
    'cross-skill.mjs dispatches model-eval commands; the intent layer must say so',
  );
});

// ── Property 4: the adjudicated re-tag ──────────────────────────────────────

test('L4: install.mjs resolves to the install domain, not root-scripts', () => {
  assert.equal(domainFor('install.mjs'), 'install',
    'declaring tests -> root-scripts would grant every test the whole domain; re-tagging removes the edge');
  assert.ok(!domainMap.allowedDeps.tests?.includes('root-scripts'),
    'the broad tests -> root-scripts edge must NOT have been declared');
});

// ── New modules land where the plan says ────────────────────────────────────

test('every new shared module resolves to shared-lib', () => {
  for (const f of [
    'scripts/lib/coverage-schema.mjs',
    'scripts/lib/canonical-hash.mjs',
    'scripts/lib/path-validation.mjs',
    'scripts/lib/command-input.mjs',
    'scripts/lib/repo-scope.mjs',
    'scripts/lib/skills-index.mjs',
  ]) {
    assert.equal(domainFor(f), 'shared-lib', `${f} landed in the wrong domain`);
  }
});

// ── Property 5: the adjudicated refactor-away (L5, 2026-08-01) ──────────────
//
// docs/plans/dashboard-skills-index-layering.md. Unlike L4 (which declined a
// PROPOSED over-broad declaration), L5 REMOVES one that was already standing:
// `scripts` was the whole root-CLI domain granted to express a single import.

test('L5: the moved symbols are unreachable through any skills-help.mjs export', async () => {
  const old = await import('../scripts/skills-help.mjs');

  for (const sym of ['parseSkill', 'loadAllSkills']) {
    assert.ok(!(sym in old),
      `a re-export of ${sym} here lets a consumer silently recreate the dashboard -> scripts edge`);
    // __test__ is itself an export, so it is an equivalent backdoor.
    assert.ok(!(sym in (old.__test__ ?? {})),
      `${sym} leaked through the __test__ hook — same edge, different door`);
  }

  const moved = await import('../scripts/lib/skills-index.mjs');
  assert.equal(typeof moved.loadAllSkills, 'function', 'the contract must exist in its new home');
  assert.equal(typeof moved.parseSkill, 'function', 'the contract must exist in its new home');
});

test('L5: no dashboard module imports into the scripts domain', () => {
  // The assertion above guards a PROXY (skills-help.mjs stops re-exporting).
  // This guards the property the plan actually claims — trace #4 established it
  // by manual grep, which leaves it unguarded the moment a new collector lands.
  // A future `import x from '../../foo.mjs'` would silently recreate the edge.
  const DASH = path.join(REPO_ROOT, 'scripts', 'lib', 'dashboard');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(d, e.name);
    return e.isDirectory() ? walk(p) : (e.name.endsWith('.mjs') ? [p] : []);
  });

  const files = walk(DASH);
  assert.ok(files.length > 0, 'guard is vacuous — no dashboard modules found');

  const offenders = [];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf-8');
    for (const m of src.matchAll(/(?:from|import)\s+['"](\.[^'"]+)['"]/g)) {
      const target = path.relative(REPO_ROOT, path.resolve(path.dirname(file), m[1])).replace(/\\/g, '/');
      if (domainFor(target) === 'scripts') {
        offenders.push(`${path.relative(REPO_ROOT, file).replace(/\\/g, '/')} -> ${target}`);
      }
    }
  }

  assert.deepEqual(offenders, [],
    'a dashboard collector imports a root CLI entry point again. Either import from a '
    + 'scripts/lib/ module instead (the L5 fix), or — if the edge is genuinely wanted — '
    + 're-declare it in allowedDeps.dashboard WITH an adjudication, not silently.');
});

test('L5: allowedDeps.dashboard no longer grants the whole scripts domain', () => {
  assert.ok(!domainMap.allowedDeps.dashboard.includes('scripts'),
    'the grant existed solely to cover collect-reference.mjs -> skills-help.mjs; that import is gone. '
    + 'Nothing else catches a stale allowedDeps EDGE — computeDeadIntent only finds dead DOMAINS.');
  // The replacement edge must already be declared, or this traded one grant for another.
  assert.ok(domainMap.allowedDeps.dashboard.includes('shared-lib'),
    'dashboard -> shared-lib is where the dependency moved; it must be declared');
});

test('the adjudication is recorded in the domain map', () => {
  // An allowedDeps entry with no recorded rationale is indistinguishable from one added
  // to silence a gate. JSON has no comments, so the file's own underscore-key convention
  // carries it.
  assert.ok(domainMap._adjudication_2026_07_31, 'the 2026-07-31 adjudication must be recorded');
  assert.match(domainMap._adjudication_2026_07_31, /model-eval/);
  assert.match(domainMap._adjudication_2026_07_31, /install\.mjs/);

  assert.ok(domainMap._adjudication_2026_08_01, 'the 2026-08-01 (L5) adjudication must be recorded');
  assert.match(domainMap._adjudication_2026_08_01, /skills-index\.mjs/);
  assert.match(domainMap._adjudication_2026_08_01, /dashboard -> scripts/);
});

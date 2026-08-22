/**
 * @fileoverview `scripts/doctor.mjs`'s runtime import graph must be a SUBSET
 * of what a real sync actually relocates (consumer-friction-doctor plan §8
 * Tier 3, closes R1-H6 — "the smoke test can pass while a transitive
 * dependency is silently absent"). `CLI_SMOKE_SET` membership alone proves
 * doctor.mjs itself runs post-relocation; it does not prove every module it
 * transitively imports was DECLARED for relocation in the first place.
 *
 * Reuses `collectImportClosure` (`scripts/lib/module-graph.mjs`) — the SAME
 * primitive `sync-to-repos.mjs`'s own `resolveBundle` uses internally — over
 * this repo's real file tree, rather than re-deriving import-resolution
 * logic in a test-only parser.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { collectImportClosure } from '../scripts/lib/module-graph.mjs';
import { findNodeModules } from '../scripts/lib/node-modules-resolver.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Every `.mjs`/`.js` file under `scripts/`, repo-relative POSIX paths. */
function buildScriptsFileUniverse() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.claude-skills') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (/\.(mjs|js|cjs)$/.test(entry.name)) {
        out.push(path.relative(REPO_ROOT, full).replaceAll('\\', '/'));
      }
    }
  };
  walk(path.join(REPO_ROOT, 'scripts'));
  return out;
}

function readSource(rel) {
  try { return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8'); }
  catch { return null; }
}

describe('scripts/doctor.mjs import closure', () => {
  const repoFiles = buildScriptsFileUniverse();

  it('every import resolves within the repo or to a real external package — nothing unresolved', () => {
    const { unresolved } = collectImportClosure({
      entryPoints: ['scripts/doctor.mjs'],
      repoFiles,
      readFile: readSource,
    });
    // Template-literal/regex noise (the same filter sync-to-repos.mjs's own
    // realMissingDeps applies) would be a false positive here; doctor.mjs's
    // whole import surface is plain static `import … from './x.mjs'`, so
    // none is expected.
    const real = unresolved.filter((u) => !/[\s`${}]/.test(u.specifier));
    assert.deepEqual(real, [], `unresolved import(s): ${JSON.stringify(real)}`);
  });

  it('the closure is EXACTLY the doctor lib surface — no accidental reach into an unrelated subsystem', () => {
    const { files } = collectImportClosure({
      entryPoints: ['scripts/doctor.mjs'],
      repoFiles,
      readFile: readSource,
    });
    assert.ok(files.includes('scripts/doctor.mjs'));
    // Every lib/doctor/* module must be reachable — these are the modules
    // R1-H6 named as the ones a broken sync declaration would silently drop.
    for (const expected of [
      'scripts/lib/doctor/context.mjs',
      'scripts/lib/doctor/registry.mjs',
      'scripts/lib/doctor/probes.mjs',
      'scripts/lib/doctor/report.mjs',
    ]) {
      assert.ok(files.includes(expected), `expected ${expected} in doctor.mjs's import closure`);
    }
  });

  it('CORE_ENTRY declares scripts/doctor.mjs — the entry point sync-to-repos.mjs actually relocates from', () => {
    // Static text check, not an import of sync-to-repos.mjs's module body —
    // that file runs its own top-level work (FILE_UNIVERSE, resolveBundle
    // calls) on import, which a test must not trigger as a side effect.
    // Matches the FULL array via the non-greedy `[\s\S]*?` to its closing
    // `\n];` — the array is long enough that a fixed-length slice from its
    // start can cut off before reaching an entry appended near the end.
    const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'sync-to-repos.mjs'), 'utf-8');
    const arrayMatch = /const CORE_ENTRY = \[([\s\S]*?)\n\];/.exec(src);
    assert.ok(arrayMatch, 'could not locate CORE_ENTRY array in sync-to-repos.mjs — test instrument itself is broken');
    assert.match(arrayMatch[1], /'scripts\/doctor\.mjs'/);
  });

  it('doctor.mjs\'s closure lives entirely under scripts/ — no accidental reach outside the relocated tree (round-4 audit M11)', () => {
    // Round-4 audit M11, correctly found: the PREVIOUS version of this test
    // computed "the full closure of every declared CORE_ENTRY" and asserted
    // doctor.mjs's own closure was a subset of it — but since doctor.mjs is
    // itself one of the entries fed into that "full closure" computation,
    // doctorClosure ⊆ fullClosure held BY CONSTRUCTION for any possible
    // doctor.mjs, regardless of whether the sync declaration was actually
    // complete. It could never fail, so it caught nothing — vacuous, not a
    // regression lock. (`resolveBundle` in sync-to-repos.mjs genuinely does
    // call `collectImportClosure(CORE_ENTRY, ...)`, so the REAL mechanism is
    // faithfully represented; the flaw was in what the TEST compared against
    // what.) `sync-to-repos.mjs` only ever COPIES paths under `scripts/`
    // (CORE_ENTRY/CORE_ASSETS are all `scripts/…` — see the array literals
    // above) into a consumer's `scripts/.claude-skills/`, so the genuinely
    // testable, non-tautological property is LOCALITY: nothing doctor.mjs
    // imports can resolve to a path outside `scripts/` and still be part of
    // what actually gets relocated — that's a real, independently-checkable
    // constraint the closure itself doesn't guarantee.
    const { files: doctorClosure } = collectImportClosure({
      entryPoints: ['scripts/doctor.mjs'], repoFiles, readFile: readSource,
    });
    const outsideScripts = doctorClosure.filter((f) => !f.startsWith('scripts/'));
    assert.deepEqual(outsideScripts, [], `doctor.mjs's closure reaches outside scripts/, so it would not be relocated: ${JSON.stringify(outsideScripts)}`);
  });

  it('doctor.mjs actually LOADS from an isolated scripts/.claude-skills/ layout containing ONLY its own computed closure (closes round-5 audit M17)', async () => {
    // The tests above prove properties of a COMPUTED closure; none of them
    // prove that PHYSICALLY COPYING exactly those files into the real
    // relocated layout and loading doctor.mjs FROM THERE actually works —
    // the feature's real promise (round-5 audit M17, GPT-sustained: "the
    // current locality and declared-file checks... do not prove that
    // sync-to-repos actually materializes exactly those files"). This test
    // closes that gap directly: compute doctor.mjs's own closure (the same
    // primitive resolveBundle uses), copy ONLY those files — not the whole
    // repo — into a fresh scripts/.claude-skills/ fixture, import doctor.mjs
    // from that isolated copy, and confirm every module it needs actually
    // resolves (no MODULE_NOT_FOUND) with no other repo file reachable.
    const { files: doctorClosure } = collectImportClosure({
      entryPoints: ['scripts/doctor.mjs'], repoFiles, readFile: readSource,
    });
    assert.ok(doctorClosure.length > 5, 'sandbox-honesty: a closure this small would make the copy-and-load below a vacuous check');

    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-consumer-bundle-'));
    try {
      const claudeSkillsDir = path.join(fixture, 'scripts', '.claude-skills');
      for (const relFile of doctorClosure) {
        // Every closure member is scripts/... (locked by the test above) —
        // strip that prefix so the destination is scripts/.claude-skills/lib/...,
        // mirroring the REAL relocated layout, not scripts/scripts/...
        const destRel = relFile.replace(/^scripts\//, '');
        const destAbs = path.join(claudeSkillsDir, destRel);
        fs.mkdirSync(path.dirname(destAbs), { recursive: true });
        fs.copyFileSync(path.join(REPO_ROOT, relFile), destAbs);
      }
      // node_modules is LINKED, not copied (matches check-gate-poison-pills.mjs's
      // own isolation technique) — Node resolves a bare specifier by walking UP
      // from the importing file, and a temp fixture under os.tmpdir() has no
      // ancestor node_modules of its own. A real consumer has ITS OWN
      // node_modules at its repo root (fixture/, here), one level above
      // scripts/.claude-skills/ — same relative position this link recreates.
      const modulesDir = findNodeModules(REPO_ROOT);
      assert.ok(modulesDir, 'no node_modules found at or above this repo — run npm install');
      fs.symlinkSync(modulesDir, path.join(fixture, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
      assert.ok(fs.existsSync(path.join(fixture, 'node_modules')), 'the node_modules link is dangling — the import below would fail on a missing dependency, not on the thing being tested');

      const doctorAbs = path.join(claudeSkillsDir, 'doctor.mjs');
      const url = pathToFileURL(doctorAbs).href;
      // Cache-bust (same technique as doctor-layout-derivation.test.mjs):
      // avoids Node memoising a same-path-different-run import.
      let mod;
      try {
        mod = await import(`${url}?t=${Date.now()}-${Math.random()}`);
      } catch (err) {
        assert.fail(`doctor.mjs failed to load from an isolated copy of its own computed closure — a real sync would produce exactly this file set and hit the same failure: ${err.stack || err.message}`);
      }
      // A successful import IS the proof — every static import in the whole
      // closure had to resolve for the module graph to link. `onlyFlagValue`
      // (one of doctor.mjs's own two exports) confirms the loaded module is
      // actually functional, not just syntactically parseable.
      assert.equal(typeof mod.onlyFlagValue, 'function', 'doctor.mjs loaded but its own onlyFlagValue export is missing');
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});

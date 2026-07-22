/**
 * @fileoverview Guards the whole class of "fs-read asset never shipped to
 * consumers", rather than one filename at a time.
 *
 * **The class.** `sync-to-repos.mjs` builds each consumer's file set by walking
 * the IMPORT graph from a few entry points. A module that reads a sibling data
 * file at runtime — `new URL('./thing.json', import.meta.url)` + `readFileSync`
 * — carries no import edge, so the walker cannot see it and the file silently
 * does not ship. The module lands in the consumer; its data file doesn't.
 *
 * **Why it bites so hard.** These readers tend to throw deliberately rather
 * than fall back to a default (a wrong budget/policy is worse than a loud
 * failure), so the missing file becomes a hard runtime error in a repo whose
 * `scripts/.claude-skills/` tree is gitignored and therefore invisible to
 * review. Observed 2026-07-18: `oss-call-policy.json` was never declared, so
 * every consumer tiered-shadow run died with
 * `[oss-call-policy] failed to read ...: ENOENT` and recorded
 * `fallback_legacy` — 15 observations burned out of a 10-15-run decision
 * window before anyone traced it. `compat-bootstrap.sql` was the same class,
 * caught earlier and pinned by name in `sync-packaging.test.mjs`.
 *
 * Pinning names one-by-one only ever catches the instance you already found.
 * This test detects the PATTERN and requires each hit to be declared.
 *
 * @see AGENTS.md — "sync-to-repos.mjs auto-resolves transitive deps ... only
 *      computed-import targets / fs-read assets need declaring"
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { collectMjs } from './helpers/fixtures.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const LIB_DIR = path.join(REPO_ROOT, 'scripts', 'lib');

/**
 * Module-relative asset reference: `new URL('./name.ext', import.meta.url)`.
 * Restricted to non-.mjs targets — a `.mjs` sibling referenced this way is
 * still reachable as a module and is handled by the walker.
 */
const ASSET_URL_RE = /new URL\(\s*['"`](\.\/[^'"`]+\.(?!mjs)[a-z0-9]+)['"`]\s*,\s*import\.meta\.url\s*\)/g;

describe('sync: module-relative fs-read assets are declared', () => {
  it('every `new URL(./asset, import.meta.url)` target under scripts/lib is in a sync array', () => {
    const syncSrc = fs.readFileSync(
      path.join(REPO_ROOT, 'scripts', 'sync-to-repos.mjs'), 'utf-8');

    // Array-element-shaped occurrence, so a mention inside a comment or a doc
    // URL cannot satisfy the assertion. Same approach as sync-packaging.test.mjs.
    const isDeclared = (rel) => {
      const escaped = rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`[\\[,\\s]['"\`]${escaped}['"\`]`).test(syncSrc);
    };

    const undeclared = [];
    for (const file of collectMjs(LIB_DIR)) {
      const src = fs.readFileSync(file, 'utf-8');
      for (const m of src.matchAll(ASSET_URL_RE)) {
        const assetAbs = path.resolve(path.dirname(file), m[1]);
        // Only real, committed files matter. A generated/optional target that
        // isn't present is not a packaging gap this test can reason about.
        if (!fs.existsSync(assetAbs)) continue;
        const assetRel = path.relative(REPO_ROOT, assetAbs).split(path.sep).join('/');
        if (!isDeclared(assetRel)) {
          const readerRel = path.relative(REPO_ROOT, file).split(path.sep).join('/');
          undeclared.push(`${assetRel}  (read by ${readerRel})`);
        }
      }
    }

    assert.deepEqual(
      undeclared,
      [],
      'These files are read at runtime via a module-relative URL but are NOT declared\n'
      + 'in sync-to-repos.mjs. The import-graph walker cannot see an fs read, so they\n'
      + 'will not ship — the module arrives in the consumer without its data file and\n'
      + 'fails at runtime, inside a gitignored tree nobody reviews.\n'
      + 'Add each to CORE_ASSETS:\n  ' + undeclared.join('\n  '),
    );
  });

  it('detects the pattern at all (guard against a silently-vacuous regex)', () => {
    // If the regex ever stops matching — a refactor to a different asset-read
    // idiom, say — the test above would pass by finding nothing, which is the
    // failure mode this whole file exists to prevent. Assert we still see the
    // known reader.
    const src = fs.readFileSync(path.join(LIB_DIR, 'oss-call-policy.mjs'), 'utf-8');
    const hits = [...src.matchAll(ASSET_URL_RE)].map((m) => m[1]);
    assert.ok(
      hits.includes('./oss-call-policy.json'),
      'ASSET_URL_RE no longer matches oss-call-policy.mjs\'s known asset read — '
      + 'the scan above is now vacuous. Update the regex to the new idiom.',
    );
  });
});

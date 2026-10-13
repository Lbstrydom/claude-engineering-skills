#!/usr/bin/env node
/**
 * @fileoverview Emit the bundle's own npm-dependency declaration.
 *
 * **The gap this closes.** The synced bundle imports ~16 npm packages and
 * declared none of them anywhere a consumer could read. The derived set already
 * existed — `bundleDeps()` / `requiredDeps()` in `lib/install/deps.mjs` — but it
 * is source-repo-only by construction: it walks `getAllConsumerInventories()`,
 * which needs the consumer registry that never syncs. So in a consumer the set
 * was unrepresentable, not merely unlisted, and three things went wrong at once
 * (reported 2026-09-07, upstream ea23dfda):
 *
 *   1. `check-setup.mjs` special-cased exactly ONE dependency (playwright) and
 *      exited 0 on an install missing `ts-morph` — the same "structurally unable
 *      to report the dependency four skills cannot run without" argument its own
 *      comment makes, applied to the other fifteen.
 *   2. A consumer's `knip` reported four of them as unused on a clean main and
 *      blocked every push: the tooling tree is gitignored, so knip only sees the
 *      importers when the tree is hydrated. Its "Remove from ignoreDependencies"
 *      hint has the same blindness, so it argued for uninstalling packages four
 *      skills require — which is what happened there on 2026-07-28.
 *   3. `addDevDepsArgs`/`displayAddDev` show these are meant as
 *      **devDependencies**, and nothing transmitted that intent. The reporting
 *      consumer had four of them in `dependencies`, shipping to a production
 *      image built with `npm ci --omit=dev`.
 *
 * **Category B generated artifact**: a pure, deterministic function of committed
 * source — no clock, no sha, no network — committed and freshness-verified in
 * the pre-push `check` via `--check`. Two regenerations of one commit are
 * byte-identical, which is the test AGENTS.md sets for a tracked generated file.
 *
 * It lands at `scripts/lib/bundle-deps.json` and is listed in CORE_ASSETS, so it
 * syncs like any other asset and is hashed into `scripts/.sync-manifest.json` —
 * which is what keeps gate 2C from reading it as an orphan.
 *
 * **The READ half is `lib/install/bundle-deps.mjs`, not here.** This CLI cannot
 * sync (it walks the consumer registry), and the reader has to run where the
 * bundle lands.
 *
 * Usage:
 *   node scripts/generate-bundle-deps.mjs            # write
 *   node scripts/generate-bundle-deps.mjs --check    # exit 1 on drift
 *   node scripts/generate-bundle-deps.mjs --json     # machine-readable result
 *
 * Exit codes: 0 fresh/written · 1 drifted (with --check) · 2 usage error
 *
 * @module scripts/generate-bundle-deps
 */
import fs from 'node:fs';
import path from 'node:path';

import { assertKnownFlags, ArgvError, finishAndExit } from './lib/cli-io.mjs';
import { BUNDLE_DEPS_RELATIVE_PATH } from './lib/install/bundle-deps.mjs';
import { OPTIONAL_DEPS } from './lib/install/deps.mjs';
import { getAllConsumerInventories } from './lib/sync-inventory.mjs';
import { sourceRelToDestRel } from './lib/sync-path-map.mjs';
import { IMPORT_PKG_ALLOW } from './lib/ux-lock/selector-policy.mjs';
import { isInvokedAsScript } from './lib/cli-entry.mjs';

const KNOWN_FLAGS = ['--check', '--json'];
const REPO_ROOT = path.resolve(import.meta.dirname, '..');

/**
 * Build the declaration.
 *
 * PURE over its injected inventory, so the shape is testable without walking a
 * real repo.
 *
 * **Importers are included deliberately.** A bare list of names invites exactly
 * the argument that produced this bug — "nothing seems to use it, remove it" —
 * and cannot be checked by a reader. Naming the bundle files that import each
 * package makes the entry self-justifying and, being derived, it cannot rot into
 * a claim the graph no longer supports.
 *
 * @param {Map<string, {external?: Array<{from: string, pkg: string}>}>} inventories
 * @param {string[]} optional - the curated optional set
 * @returns {object} the artifact, ready to serialise
 */
export function buildBundleDeps(inventories, optional = OPTIONAL_DEPS, specPackages = IMPORT_PKG_ALLOW) {
  const opt = new Set(optional);
  /** @type {Map<string, Set<string>>} */
  const importers = new Map();
  for (const inv of inventories.values()) {
    for (const e of inv.external || []) {
      if (!importers.has(e.pkg)) importers.set(e.pkg, new Set());
      // Record the path the file has IN A CONSUMER — this artifact is read
      // there, and a source-repo path names a file the reader does not have.
      importers.get(e.pkg).add(sourceRelToDestRel(e.from));
    }
  }
  const packages = [...importers.keys()].sort().map((name) => ({
    name,
    // "required" is the semantic question the import graph cannot answer, so it
    // comes from the hand-curated OPTIONAL_DEPS set and nowhere else. Everything
    // the bundle imports that is not curated as optional is required.
    required: !opt.has(name),
    importers: [...importers.get(name)].sort(),
  }));
  return {
    _generated: 'GENERATED FILE — do not edit. Regenerate: npm run bundle:deps',
    _why: 'Every npm package the synced bundle imports, derived from its own import graph. '
      + 'Read by check-setup.mjs so a consumer can verify its install, and by consumers building '
      + 'a knip/depcheck ignore list — a dead-code tool cannot see the importers, because the '
      + 'tooling tree is gitignored.',
    installAs: 'devDependencies',
    packages,
    // A SECOND kind of dependency, kept separate because the claim is different.
    // Nothing in the bundle imports these; the Playwright specs `/ux-lock`
    // GENERATES do. Folding them into `packages` would assert something about
    // the import graph that is false — the exact reason `@playwright/test` was
    // dropped from OPTIONAL_DEPS — but omitting them entirely is how a consumer
    // ends up with generated specs it cannot run. Derived from
    // `selector-policy.mjs`'s own allowlist, never restated.
    generatedSpecPackages: {
      _why: 'Not imported by the bundle. Imported by the Playwright specs /ux-lock generates, so a '
        + 'consumer that runs those specs needs them installed; a consumer that does not, does not.',
      packages: [...specPackages].sort(),
    },
  };
}

/** Deterministic bytes: 2-space JSON, trailing newline, LF. */
export function serialiseBundleDeps(doc) {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

async function main() {
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }
  try {
    assertKnownFlags(process.argv, KNOWN_FLAGS, { cli: 'generate-bundle-deps' });
  } catch (err) {
    if (err instanceof ArgvError) { process.stderr.write(`${err.message}\n`); return finishAndExit(2); }
    throw err;
  }
  const asJson = process.argv.includes('--json');
  const checkOnly = process.argv.includes('--check');
  const target = path.join(REPO_ROOT, BUNDLE_DEPS_RELATIVE_PATH);

  const doc = buildBundleDeps(getAllConsumerInventories());
  const next = serialiseBundleDeps(doc);
  // Compare on LF: a CRLF checkout is not drift, and git agrees.
  const current = fs.existsSync(target)
    ? fs.readFileSync(target, 'utf-8').replaceAll('\r\n', '\n')
    : null;
  const fresh = current === next;

  if (checkOnly) {
    if (asJson) console.log(JSON.stringify({ ok: fresh, path: BUNDLE_DEPS_RELATIVE_PATH, packages: doc.packages.length }));
    else if (fresh) console.log(`bundle-deps: ${doc.packages.length} package(s) — fresh`);
    else {
      process.stderr.write(
        `bundle-deps: ${BUNDLE_DEPS_RELATIVE_PATH} is stale (or absent). `
        + 'Regenerate with `npm run bundle:deps` and commit it — the bundle\'s declared '
        + 'dependencies must be a function of what it actually imports.\n');
    }
    return finishAndExit(fresh ? 0 : 1);
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, next);
  if (asJson) console.log(JSON.stringify({ ok: true, path: BUNDLE_DEPS_RELATIVE_PATH, packages: doc.packages.length, changed: !fresh }));
  else console.log(`bundle-deps: wrote ${BUNDLE_DEPS_RELATIVE_PATH} — ${doc.packages.length} package(s)${fresh ? ' (unchanged)' : ''}`);
  return finishAndExit(0);
}

if (isInvokedAsScript(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`[bundle-deps] fatal: ${err?.message || err}\n`);
    process.exit(1);
  });
}

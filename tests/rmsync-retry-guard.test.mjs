import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { findRmSyncCallSites } from '../scripts/lib/find-rmsync-sites.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const RETRY_MODULE_ABS_PATH = path.resolve(REPO_ROOT, 'scripts/lib/retry-transient-fs.mjs');

// Guard file discovery (audit R3-H2, widened R4-M2): walk BOTH tests/ and
// scripts/ recursively for every *.mjs file — not just *.test.mjs — so a
// future test-support/helper module without the .test.mjs suffix can't
// introduce an rmSync call invisible to this scan. A future script or
// helper anywhere under scripts/ or tests/ calling rmSync is therefore
// automatically in scope the next time `npm test` runs.
function walkMjsFiles(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.git')) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkMjsFiles(abs, out);
    } else if (entry.name.endsWith('.mjs')) {
      out.push(abs);
    }
  }
}

function discoverTargetFiles() {
  const out = [];
  walkMjsFiles(path.join(REPO_ROOT, 'tests'), out);
  walkMjsFiles(path.join(REPO_ROOT, 'scripts'), out);
  return out;
}

function isCompliantInline(properties) {
  if (!properties) return false;
  return properties.recursive === true
    && properties.maxRetries === 3
    && properties.retryDelay === 50;
}

/**
 * True iff `site.enclosingCallResolvesToWrapper` says the enclosing call's
 * callee resolves, via REAL lexical scope, to `retrySync` imported from
 * scripts/lib/retry-transient-fs.mjs.
 *
 * Was a SECOND independent parse + traverse of the same source, reconnected
 * to `find-rmsync-sites.mjs`'s AST via a hand-built `start:end` string key
 * (finding 2ee66195 — two `parse()` calls on identical text never produce
 * reference-equal node objects, so this file had no other way to reach real
 * scope info for the wrapper identifier). `findRmSyncCallSites`'s
 * `wrapperImportSpec` option now answers this in the SAME traversal that
 * finds the site, where the real NodePath still exists — no reconnection,
 * no second parse, no duplicated CJS-interop/parse/traverse setup.
 */
function isCompliantWrapped(site) {
  if (!site.enclosingCall) return false;
  return site.enclosingCallResolvesToWrapper === true;
}

describe('rmSync retry-guard (Windows EPERM/EBUSY hardening)', () => {
  const targetFiles = discoverTargetFiles();
  let totalSites = 0;

  it('found at least one target file to scan (guard is not vacuously passing)', () => {
    assert.ok(targetFiles.length > 50, `expected >50 .mjs files under tests/+scripts/, found ${targetFiles.length}`);
  });

  for (const fileAbsPath of targetFiles) {
    const relPath = path.relative(REPO_ROOT, fileAbsPath).replaceAll('\\', '/');
    it(`${relPath} — every fs.rmSync call site is retry-hardened`, () => {
      const sourceText = fs.readFileSync(fileAbsPath, 'utf-8');
      if (!sourceText.includes('rmSync')) return; // fast skip, no parse needed

      let sites;
      try {
        sites = findRmSyncCallSites(sourceText, {
          wrapperImportSpec: { importedName: 'retrySync', moduleAbsPath: RETRY_MODULE_ABS_PATH, fromFileAbsPath: fileAbsPath },
        });
      } catch (err) {
        assert.fail(`failed to parse ${relPath}: ${err.message}`);
        return;
      }
      totalSites += sites.length;
      if (sites.length === 0) return;

      for (const site of sites) {
        const compliant = isCompliantInline(site.properties) || isCompliantWrapped(site);
        assert.ok(
          compliant,
          `${relPath}:${site.line} — fs.rmSync call site is not retry-hardened `
          + `(expected inline {recursive:true, maxRetries:3, retryDelay:50} `
          + `or a call wrapped in retrySync(...) from scripts/lib/retry-transient-fs.mjs)`
        );
      }
    });
  }

  it('detected at least 200 fs.rmSync call sites total (guard is not vacuously passing on a detection collapse)', () => {
    // Every per-file test above only asserts when sites.length > 0 for THAT
    // file — a total detection collapse (e.g. the @babel/traverse rewrite
    // silently stops matching a shape it used to match) would otherwise pass
    // every per-file test silently. 200 is a floor calibrated against the
    // empirically-measured actual count (494 at the time this guard was
    // added), not the live count — so trimming a handful of real call sites
    // in the future doesn't make this brittle.
    assert.ok(totalSites >= 200, `expected >=200 total fs.rmSync call sites across the repo, found ${totalSites}`);
  });
});

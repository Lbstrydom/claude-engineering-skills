import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import { findRmSyncCallSites } from '../scripts/lib/find-rmsync-sites.mjs';

// @babel/traverse ships CJS; under ESM the callable lands on .default (and on
// .default.default via some interop paths). Same normalisation as
// find-rmsync-sites.mjs / adjacency-detector.mjs.
const traverse = _traverse?.default?.default ?? _traverse?.default ?? _traverse;

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

/**
 * Index every CallExpression in `sourceText` by its `start:end` byte-offset
 * pair, mapped to the Babel NodePath at that position — so a raw AST node
 * object obtained elsewhere (e.g. `site.enclosingCall`, extracted from a
 * SEPARATE parse of the same text by find-rmsync-sites.mjs) can be resolved
 * back to a NodePath with real scope info. Two independent `parse()` calls
 * on identical text never produce reference-equal node objects, but byte
 * offsets are stable for the same input — that's the join key.
 */
function buildCallExpressionPathIndex(sourceText) {
  const ast = parse(sourceText, { sourceType: 'module', plugins: [] });
  const index = new Map();
  traverse(ast, {
    CallExpression(path) {
      index.set(`${path.node.start}:${path.node.end}`, path);
    },
  });
  return index;
}

function isCompliantInline(properties) {
  if (!properties) return false;
  return properties.recursive === true
    && properties.maxRetries === 3
    && properties.retryDelay === 50;
}

/**
 * True iff `site.enclosingCall`'s callee identifier resolves, via REAL
 * lexical scope at the call site (not name-only matching), to the named
 * export `retrySync` imported from scripts/lib/retry-transient-fs.mjs.
 *
 * Name-only matching (checking whether the callee's text is in the set of
 * names ever imported as `retrySync` anywhere in the file) cannot tell a
 * genuine reference from a shadowing local parameter/variable of the same
 * name at THIS call site — exactly the gap find-rmsync-sites.mjs's own
 * @babel/traverse rewrite closed for the `fs`/`rmSync` side; this closes
 * the matching gap for the wrapper side of the same guard.
 */
function isCompliantWrapped(site, callPathIndex, fileAbsPath) {
  const call = site.enclosingCall;
  if (!call || call.callee.type !== 'Identifier') return false;
  const callPath = callPathIndex.get(`${call.start}:${call.end}`);
  if (!callPath) return false; // defensive — should always resolve for a real enclosingCall
  const binding = callPath.scope.getBinding(call.callee.name);
  if (!binding?.path?.isImportSpecifier() || binding.path.node.imported?.name !== 'retrySync') {
    return false;
  }
  const importDecl = binding.path.parentPath;
  if (!importDecl?.isImportDeclaration()) return false;
  const fileDir = path.dirname(fileAbsPath);
  const resolvedSource = path.resolve(fileDir, importDecl.node.source.value);
  return resolvedSource === RETRY_MODULE_ABS_PATH;
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
        sites = findRmSyncCallSites(sourceText);
      } catch (err) {
        assert.fail(`failed to parse ${relPath}: ${err.message}`);
        return;
      }
      totalSites += sites.length;
      if (sites.length === 0) return;

      const callPathIndex = buildCallExpressionPathIndex(sourceText);

      for (const site of sites) {
        const compliant = isCompliantInline(site.properties) || isCompliantWrapped(site, callPathIndex, fileAbsPath);
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

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from '@babel/parser';
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

/**
 * Collect local binding names that resolve, via import path, to the named
 * export `retrySync` from scripts/lib/retry-transient-fs.mjs — resolved
 * relative to the file being checked, not by name string-matching (audit
 * R3-M2: a locally shadowed or unrelated `retrySync` must not satisfy this).
 */
function collectRetrySyncBindings(sourceText, fileAbsPath) {
  const ast = parse(sourceText, { sourceType: 'module', plugins: [] });
  const bindings = new Set();
  const fileDir = path.dirname(fileAbsPath);
  for (const node of ast.program.body) {
    if (node.type !== 'ImportDeclaration') continue;
    if (!node.source.value.endsWith('retry-transient-fs.mjs')) continue;
    const resolvedSource = path.resolve(fileDir, node.source.value);
    if (resolvedSource !== RETRY_MODULE_ABS_PATH) continue;
    for (const spec of node.specifiers) {
      if (spec.type === 'ImportSpecifier' && spec.imported.name === 'retrySync') {
        bindings.add(spec.local.name);
      }
    }
  }
  return bindings;
}

function isCompliantInline(properties) {
  if (!properties) return false;
  return properties.recursive === true
    && properties.maxRetries === 3
    && properties.retryDelay === 50;
}

function isCompliantWrapped(site, retrySyncBindings) {
  const call = site.enclosingCall;
  if (!call) return false;
  return call.callee.type === 'Identifier' && retrySyncBindings.has(call.callee.name);
}

describe('rmSync retry-guard (Windows EPERM/EBUSY hardening)', () => {
  const targetFiles = discoverTargetFiles();

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
      if (sites.length === 0) return;

      const retrySyncBindings = collectRetrySyncBindings(sourceText, fileAbsPath);

      for (const site of sites) {
        const compliant = isCompliantInline(site.properties) || isCompliantWrapped(site, retrySyncBindings);
        assert.ok(
          compliant,
          `${relPath}:${site.line} — fs.rmSync call site is not retry-hardened `
          + `(expected inline {recursive:true, maxRetries:3, retryDelay:50} `
          + `or a call wrapped in retrySync(...) from scripts/lib/retry-transient-fs.mjs)`
        );
      }
    });
  }
});

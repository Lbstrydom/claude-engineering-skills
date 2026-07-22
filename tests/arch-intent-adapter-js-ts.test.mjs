/**
 * @fileoverview Tests for the architecture-intent JS/TS adapter
 * (scripts/lib/arch-intent/adapters/js-ts.mjs).
 *
 * Focus: dead-code-phase-1-followup fix — a literal `await import('./x.mjs')`
 * is dep-cruiser-resolvable exactly like a static import, so it must count
 * as "has a caller" in the orphan-graph track (callersByTarget/targetsByCaller)
 * even though it stays exempt from allowedDeps violation checks (dynamic
 * targets can't be statically verified against domain rules).
 *
 * Confirmed false-positive this guards against: a file imported only via
 * `await import('./lib/x.mjs')` was flagged as a born-orphan 41 times before
 * being wired up in other ways (scripts/lib/solo-control/stratified-sample.mjs,
 * imported from scripts/solo-control-audit.mjs:1299).
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import analyseImports from '../scripts/lib/arch-intent/adapters/js-ts.mjs';

let tmpDir;
let originalCwd;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-jsts-'));
  // dependency-cruiser emits mod.source/dep.resolved relative to
  // process.cwd() at call time (see diff-scope-resolver.mjs's cruiseTempRoot,
  // which documents + translates around the same quirk); js-ts.mjs's
  // normalisePath assumes repoPath === process.cwd() (true in production —
  // every real call site passes repoRoot: process.cwd()). chdir into the
  // fixture so that invariant holds here too, same as production.
  originalCwd = process.cwd();
  process.chdir(tmpDir);
});
afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

/** Write a {relPath: content} tree under tmpDir; return the root path. */
function writeTree(files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(tmpDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return tmpDir;
}

const domainMap = {
  rules: [
    { pattern: 'src/**', domain: 'app' },
    { pattern: 'restricted/**', domain: 'restricted' },
  ],
  allowedDeps: { app: [] }, // app -> restricted is NOT allowed (proves dynamic skips violation check)
};

describe('js-ts analyseImports — dynamic imports (dead-code-phase-1-followup)', () => {
  it('a literal dynamic import counts as a caller in the orphan-graph track', async () => {
    const repoPath = writeTree({
      'src/entry.mjs': `export async function load() {\n  return await import('./lib/target.mjs');\n}\n`,
      'src/lib/target.mjs': 'export const x = 1;\n',
    });
    const mapped = new Map([
      ['src/entry.mjs', 'app'],
      ['src/lib/target.mjs', 'app'],
    ]);
    const { _meta } = await analyseImports({ mapped, domainMap, repoPath });
    assert.ok(
      (_meta.callersByTarget['src/lib/target.mjs'] || []).includes('src/entry.mjs'),
      `expected src/entry.mjs in callersByTarget['src/lib/target.mjs'], got ${JSON.stringify(_meta.callersByTarget)}`,
    );
    assert.ok(
      (_meta.targetsByCaller['src/entry.mjs'] || []).includes('src/lib/target.mjs'),
      `expected src/lib/target.mjs in targetsByCaller['src/entry.mjs'], got ${JSON.stringify(_meta.targetsByCaller)}`,
    );
    assert.ok(_meta.allFiles.includes('src/lib/target.mjs'));
  });

  it('still records the resolvable dynamic edge in _meta.dynamicEdges (telemetry unchanged)', async () => {
    const repoPath = writeTree({
      'src/entry.mjs': `export async function load() {\n  return await import('./lib/target.mjs');\n}\n`,
      'src/lib/target.mjs': 'export const x = 1;\n',
    });
    const mapped = new Map([
      ['src/entry.mjs', 'app'],
      ['src/lib/target.mjs', 'app'],
    ]);
    const { _meta } = await analyseImports({ mapped, domainMap, repoPath });
    assert.ok(
      _meta.dynamicEdges.some(e => e.from === 'src/entry.mjs' && e.to === './lib/target.mjs'),
      `expected dynamicEdges entry, got ${JSON.stringify(_meta.dynamicEdges)}`,
    );
  });

  it('a dynamic import across a forbidden domain boundary is NOT flagged as a violation', async () => {
    const repoPath = writeTree({
      'src/entry.mjs': `export async function load() {\n  return await import('../restricted/secret.mjs');\n}\n`,
      'restricted/secret.mjs': 'export const s = 1;\n',
    });
    const mapped = new Map([
      ['src/entry.mjs', 'app'],
      ['restricted/secret.mjs', 'restricted'],
    ]);
    const { violations, _meta } = await analyseImports({ mapped, domainMap, repoPath });
    assert.equal(violations.length, 0, `expected no violations for a dynamic edge, got ${JSON.stringify(violations)}`);
    // ...but it still shows up in the orphan-graph track (has a caller).
    assert.ok(
      (_meta.callersByTarget['restricted/secret.mjs'] || []).includes('src/entry.mjs'),
      `expected restricted/secret.mjs to have a caller despite crossing domains, got ${JSON.stringify(_meta.callersByTarget)}`,
    );
  });

  it('an unresolvable dynamic import (variable specifier) is NOT counted as a caller', async () => {
    const repoPath = writeTree({
      'src/entry.mjs': `export async function load(name) {\n  return await import(\`./lib/\${name}.mjs\`);\n}\n`,
      'src/lib/target.mjs': 'export const x = 1;\n',
    });
    const mapped = new Map([
      ['src/entry.mjs', 'app'],
      ['src/lib/target.mjs', 'app'],
    ]);
    const { _meta } = await analyseImports({ mapped, domainMap, repoPath });
    assert.ok(
      !(_meta.callersByTarget['src/lib/target.mjs'] || []).includes('src/entry.mjs'),
      `an unresolvable dynamic specifier must NOT fabricate a caller edge, got ${JSON.stringify(_meta.callersByTarget)}`,
    );
  });
});

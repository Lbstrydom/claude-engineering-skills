/**
 * Tests for scripts/lib/module-graph.mjs
 * Plan: docs/plans/adaptive-context-blast-radius.md — Phase 1 (audit M1).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSpecifier, parseImports, publicExports, collectImportClosure } from '../scripts/lib/module-graph.mjs';

const REPO = new Set([
  'scripts/foo.mjs',
  'scripts/lib/schemas.mjs',
  'scripts/lib/audit/prompt-builder.mjs',
  'scripts/lib/dir/index.mjs',
]);

describe('resolveSpecifier', () => {
  it('resolves a relative specifier with extension probing', () => {
    const r = resolveSpecifier({ fromFile: 'scripts/foo.mjs', specifier: './lib/schemas.mjs', repoFiles: REPO });
    assert.equal(r.kind, 'repo');
    assert.equal(r.resolved, 'scripts/lib/schemas.mjs');
  });

  it('resolves an extensionless relative specifier', () => {
    const r = resolveSpecifier({ fromFile: 'scripts/foo.mjs', specifier: './lib/schemas', repoFiles: REPO });
    assert.equal(r.kind, 'repo');
    assert.equal(r.resolved, 'scripts/lib/schemas.mjs');
  });

  it('resolves a directory specifier to index.mjs', () => {
    const r = resolveSpecifier({ fromFile: 'scripts/foo.mjs', specifier: './lib/dir', repoFiles: REPO });
    assert.equal(r.kind, 'repo');
    assert.equal(r.resolved, 'scripts/lib/dir/index.mjs');
  });

  it('resolves ../ correctly', () => {
    const r = resolveSpecifier({ fromFile: 'scripts/lib/audit/prompt-builder.mjs', specifier: '../schemas.mjs', repoFiles: REPO });
    assert.equal(r.resolved, 'scripts/lib/schemas.mjs');
  });

  it('classifies a bare specifier as external (not a repo-existence question)', () => {
    assert.equal(resolveSpecifier({ fromFile: 'scripts/foo.mjs', specifier: 'zod', repoFiles: REPO }).kind, 'external');
    assert.equal(resolveSpecifier({ fromFile: 'scripts/foo.mjs', specifier: 'node:fs', repoFiles: REPO }).kind, 'external');
  });

  it('returns unresolvable when the importer is unknown', () => {
    const r = resolveSpecifier({ fromFile: null, specifier: './schemas.mjs', repoFiles: REPO });
    assert.equal(r.kind, 'unresolvable');
  });

  it('returns unresolvable for a genuinely-absent relative target', () => {
    const r = resolveSpecifier({ fromFile: 'scripts/foo.mjs', specifier: './nope.mjs', repoFiles: REPO });
    assert.equal(r.kind, 'unresolvable');
    assert.equal(r.resolved, null);
  });

  it('does not escape the repo root via ..', () => {
    const r = resolveSpecifier({ fromFile: 'scripts/foo.mjs', specifier: '../../etc/passwd', repoFiles: REPO });
    assert.equal(r.kind, 'unresolvable');
  });

  it('a leading-slash specifier is absolute, not a repo-root alias (audit M11)', () => {
    const r = resolveSpecifier({ fromFile: 'scripts/foo.mjs', specifier: '/scripts/lib/schemas.mjs', repoFiles: REPO });
    assert.equal(r.kind, 'unresolvable');
  });

  it('exact mode does NOT extension-probe — ESM rejects extensionless imports (audit H2)', () => {
    const probed = resolveSpecifier({ fromFile: 'scripts/foo.mjs', specifier: './lib/schemas', repoFiles: REPO });
    assert.equal(probed.kind, 'repo', 'default mode probes');
    const exact = resolveSpecifier({ fromFile: 'scripts/foo.mjs', specifier: './lib/schemas', repoFiles: REPO, exact: true });
    assert.equal(exact.kind, 'unresolvable', 'exact mode requires the extension');
  });
});

describe('parseImports', () => {
  const SRC = [
    "import a from './a.mjs';",
    "import {\n  b,\n  c,\n} from './b.mjs';",
    "export { d } from './c.mjs';",
    "import './side-effect.mjs';",
    "export * from './star.mjs';",
    "const x = await import('./dynamic.mjs');", // dynamic — intentionally skipped
  ].join('\n');

  it('extracts from-imports, side-effect imports and re-exports', () => {
    const specs = parseImports(SRC);
    assert.ok(specs.includes('./a.mjs'));
    assert.ok(specs.includes('./b.mjs'), 'multiline import');
    assert.ok(specs.includes('./c.mjs'), 'export … from');
    assert.ok(specs.includes('./side-effect.mjs'), 'side-effect import');
    assert.ok(specs.includes('./star.mjs'), 'export * from');
  });
  it('deduplicates and returns first-seen order', () => {
    assert.deepEqual(parseImports("import a from 'x';\nimport b from 'x';"), ['x']);
  });
});

describe('publicExports', () => {
  const SRC = [
    'export const A = 1;',
    'export function B() {}',
    'export async function asyncFn() {}',
    'export class C {}',
    'const d = 1, e = 2;',
    'export { d, e as F };',
    'export default function () {}',
  ].join('\n');

  it('extracts named declarations, export-lists (with `as`), and default', () => {
    const ex = publicExports(SRC);
    assert.ok(ex.includes('A') && ex.includes('B') && ex.includes('C'));
    assert.ok(ex.includes('asyncFn'), 'export async function');
    assert.ok(ex.includes('d'), 'export { d }');
    assert.ok(ex.includes('F'), 'export { e as F } → F');
    assert.ok(!ex.includes('e'), 'the local name is not the export name');
    assert.ok(ex.includes('default'));
  });
});

describe('parseImports — dynamic opt-in', () => {
  const SRC = [
    "import a from './a.mjs';",
    "const m = await import('./dyn.mjs');",
    "const n = import(\"./dyn2.mjs\");",
    "const c = await import(`./computed-${k}.mjs`);", // computed — never captured
  ].join('\n');

  it('skips dynamic import() by default', () => {
    const specs = parseImports(SRC);
    assert.ok(specs.includes('./a.mjs'));
    assert.ok(!specs.includes('./dyn.mjs'), 'dynamic skipped without opt-in');
  });
  it('captures string-literal dynamic imports with { dynamic: true }', () => {
    const specs = parseImports(SRC, { dynamic: true });
    assert.ok(specs.includes('./a.mjs'));
    assert.ok(specs.includes('./dyn.mjs'), 'await import(\'x\')');
    assert.ok(specs.includes('./dyn2.mjs'), 'import("x")');
  });
  it('never captures computed dynamic specifiers', () => {
    const specs = parseImports(SRC, { dynamic: true });
    assert.ok(!specs.some(s => s.includes('computed')), 'template-literal specifier skipped');
  });
});

describe('collectImportClosure', () => {
  // Virtual repo: entry → static dep → string-literal dynamic dep;
  // a computed import and a bare dep that must NOT be followed; a cycle.
  const FILES = {
    'scripts/entry.mjs': [
      "import { x } from './lib/a.mjs';",
      "import 'node:fs';",                       // bare → external, ignored
      "const lazy = await import('./lib/b.mjs');", // string-literal dynamic → followed
      "const c = await import(`./lib/${n}.mjs`);", // computed → NOT followed
    ].join('\n'),
    'scripts/lib/a.mjs': "import './c.mjs';\nimport { z } from './missing.mjs';",
    'scripts/lib/b.mjs': "import '../entry.mjs';", // cycle back to entry
    'scripts/lib/c.mjs': "export const c = 1;",
  };
  const repoFiles = new Set(Object.keys(FILES));
  const readFile = (rel) => (rel in FILES ? FILES[rel] : null);

  it('returns the transitive closure including entry points', () => {
    const { files } = collectImportClosure({
      entryPoints: ['scripts/entry.mjs'], repoFiles, readFile,
    });
    assert.deepEqual(files, [
      'scripts/entry.mjs',
      'scripts/lib/a.mjs',
      'scripts/lib/b.mjs',
      'scripts/lib/c.mjs',
    ]);
  });
  it('follows string-literal dynamic imports but not computed ones', () => {
    const { files } = collectImportClosure({
      entryPoints: ['scripts/entry.mjs'], repoFiles, readFile,
    });
    assert.ok(files.includes('scripts/lib/b.mjs'), 'string-literal dynamic followed');
  });
  it('records path-like specifiers that do not resolve', () => {
    const { unresolved } = collectImportClosure({
      entryPoints: ['scripts/entry.mjs'], repoFiles, readFile,
    });
    assert.ok(
      unresolved.some(u => u.from === 'scripts/lib/a.mjs' && u.specifier === './missing.mjs'),
      'unresolved missing dep surfaced',
    );
  });
  it('is cycle-safe and terminates', () => {
    const { files } = collectImportClosure({
      entryPoints: ['scripts/entry.mjs'], repoFiles, readFile,
    });
    assert.equal(files.length, 4, 'entry↔b cycle visited once');
  });
  it('tolerates unreadable entry points', () => {
    const { files } = collectImportClosure({
      entryPoints: ['scripts/entry.mjs', 'scripts/gone.mjs'], repoFiles, readFile,
    });
    assert.ok(files.includes('scripts/gone.mjs'), 'missing entry still listed');
    assert.ok(files.includes('scripts/lib/c.mjs'), 'reachable deps still walked');
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractPlanPaths, PLAN_REFERENCE_EXTENSIONS } from '../scripts/lib/plan-paths.mjs';
import {
  getAllProfiles,
  getProfile,
  getProfileForFile,
  countFilesByLanguage,
  detectDominantLanguage,
  buildLanguageContext,
  detectPythonPackageRoots,
  pythonBoundaryScanner,
  buildFileReferenceRegex,
  toExtensionAlternation,
  ALL_SUPPORTED_EXTENSIONS,
  ALL_EXTENSIONS_PATTERN
} from '../scripts/lib/language-profiles.mjs';

// ── Profile lookup ──────────────────────────────────────────────────────────

describe('getProfileForFile', () => {
  it("returns Python profile for .py", () => {
    assert.equal(getProfileForFile('foo.py').id, 'py');
  });
  it("returns Python profile for .pyi stubs", () => {
    assert.equal(getProfileForFile('stubs/foo.pyi').id, 'py');
  });
  it("returns TypeScript profile for .ts", () => {
    assert.equal(getProfileForFile('src/foo.ts').id, 'ts');
  });
  it("returns TypeScript profile for .tsx", () => {
    assert.equal(getProfileForFile('component.tsx').id, 'ts');
  });
  it("returns TypeScript profile for .mts/.cts", () => {
    assert.equal(getProfileForFile('foo.mts').id, 'ts');
    assert.equal(getProfileForFile('foo.cts').id, 'ts');
  });
  it("returns JS profile for .js/.mjs/.cjs/.jsx", () => {
    assert.equal(getProfileForFile('foo.js').id, 'js');
    assert.equal(getProfileForFile('foo.mjs').id, 'js');
    assert.equal(getProfileForFile('foo.cjs').id, 'js');
    assert.equal(getProfileForFile('foo.jsx').id, 'js');
  });
  it("returns UNKNOWN profile for unsupported extensions (not JS default)", () => {
    assert.equal(getProfileForFile('foo.xyz').id, 'unknown');
    assert.equal(getProfileForFile('foo').id, 'unknown');
  });
  it("case-insensitive extension matching", () => {
    assert.equal(getProfileForFile('FOO.PY').id, 'py');
    assert.equal(getProfileForFile('Foo.TS').id, 'ts');
  });
});

describe('getProfile by id', () => {
  it("returns profile for known id", () => {
    assert.equal(getProfile('js').id, 'js');
    assert.equal(getProfile('py').id, 'py');
  });
  it("returns UNKNOWN for unknown id", () => {
    assert.equal(getProfile('cobol').id, 'unknown');
  });
});

describe('getAllProfiles', () => {
  it("returns js, ts, py profiles", () => {
    const profiles = getAllProfiles();
    assert.ok(profiles.js);
    assert.ok(profiles.ts);
    assert.ok(profiles.py);
  });
});

// ── Profile immutability ────────────────────────────────────────────────────

describe('profile immutability', () => {
  it("PROFILES is frozen", () => {
    const profiles = getAllProfiles();
    assert.throws(() => { profiles.go = {}; }, TypeError);
  });
  it("individual profile is frozen", () => {
    const js = getProfile('js');
    assert.throws(() => { js.id = 'changed'; }, TypeError);
  });
  it("extensions array is frozen (not just shallow)", () => {
    const js = getProfile('js');
    assert.throws(() => { js.extensions.push('.foo'); }, TypeError);
  });
});

// ── Language counting & dominant detection ──────────────────────────────────

describe('countFilesByLanguage', () => {
  it("counts files per profile.id", () => {
    const counts = countFilesByLanguage(['a.py', 'b.py', 'c.js', 'd.ts', 'e.xyz']);
    assert.equal(counts.get('py'), 2);
    assert.equal(counts.get('js'), 1);
    assert.equal(counts.get('ts'), 1);
    assert.equal(counts.get('unknown'), 1);
  });
  it("handles empty input", () => {
    const counts = countFilesByLanguage([]);
    assert.equal(counts.size, 0);
  });
});

describe('detectDominantLanguage', () => {
  it("returns null for empty input (no hidden JS default)", () => {
    assert.equal(detectDominantLanguage([]), null);
  });
  it("returns null when only unknown files present", () => {
    assert.equal(detectDominantLanguage(['a.xyz', 'b.abc']), null);
  });
  it("returns 'py' for Python-heavy list", () => {
    assert.equal(detectDominantLanguage(['a.py', 'b.py', 'c.py', 'd.js']), 'py');
  });
  it("ignores unknown files when picking dominant", () => {
    assert.equal(detectDominantLanguage(['a.js', 'b.xyz', 'c.xyz', 'd.xyz']), 'js');
  });
});

// ── Import regex dispatch ───────────────────────────────────────────────────

describe('JS importRegex + importExtractor', () => {
  const js = getProfile('js');
  const extract = (src) => {
    const regex = new RegExp(js.importRegex.source, js.importRegex.flags);
    const results = [];
    let m;
    while ((m = regex.exec(src)) !== null) {
      const rec = js.importExtractor(m);
      if (rec) results.push(rec);
    }
    return results;
  };

  it("matches default import", () => {
    const r = extract("import x from 'y';");
    assert.deepEqual(r, [{ kind: 'es', specifier: 'y' }]);
  });
  it("matches named import", () => {
    const r = extract("import { x, z } from 'y';");
    assert.deepEqual(r, [{ kind: 'es', specifier: 'y' }]);
  });
  it("matches namespace import", () => {
    const r = extract("import * as x from 'y';");
    assert.deepEqual(r, [{ kind: 'es', specifier: 'y' }]);
  });
  it("matches side-effect import", () => {
    const r = extract("import 'y';");
    assert.deepEqual(r, [{ kind: 'es', specifier: 'y' }]);
  });
  it("matches re-export", () => {
    const r = extract("export { x } from 'y';");
    assert.deepEqual(r, [{ kind: 'es', specifier: 'y' }]);
  });
  it("matches export * from", () => {
    const r = extract("export * from 'y';");
    assert.deepEqual(r, [{ kind: 'es', specifier: 'y' }]);
  });
  it("matches dynamic import", () => {
    const r = extract("const m = await import('y');");
    assert.deepEqual(r, [{ kind: 'es', specifier: 'y' }]);
  });
  it("matches require() (CJS)", () => {
    const r = extract("const m = require('y');");
    assert.deepEqual(r, [{ kind: 'cjs', specifier: 'y' }]);
  });
});

describe('Python importRegex + importExtractor', () => {
  const py = getProfile('py');
  const extract = (src) => {
    const regex = new RegExp(py.importRegex.source, py.importRegex.flags);
    const results = [];
    let m;
    while ((m = regex.exec(src)) !== null) {
      const rec = py.importExtractor(m);
      if (rec) results.push(rec);
    }
    return results;
  };

  it("matches bare import", () => {
    const r = extract("import os\n");
    assert.deepEqual(r, [{ kind: 'import', dots: 0, modulePath: 'os', importedNames: [] }]);
  });
  it("matches dotted bare import", () => {
    const r = extract("import os.path\n");
    assert.deepEqual(r, [{ kind: 'import', dots: 0, modulePath: 'os.path', importedNames: [] }]);
  });
  it("matches from-import", () => {
    const r = extract("from module import x\n");
    assert.deepEqual(r, [{ kind: 'from', dots: 0, modulePath: 'module', importedNames: ['x'] }]);
  });
  it("matches from-import with multiple names", () => {
    const r = extract("from module import x, y, z\n");
    assert.deepEqual(r, [{ kind: 'from', dots: 0, modulePath: 'module', importedNames: ['x', 'y', 'z'] }]);
  });
  it("matches from-import with alias", () => {
    const r = extract("from module import x as xx\n");
    assert.deepEqual(r, [{ kind: 'from', dots: 0, modulePath: 'module', importedNames: ['x'] }]);
  });
  it("matches relative import (1 dot)", () => {
    const r = extract("from .module import x\n");
    assert.deepEqual(r, [{ kind: 'from', dots: 1, modulePath: 'module', importedNames: ['x'] }]);
  });
  it("matches multi-dot relative import", () => {
    const r = extract("from ..parent.module import x\n");
    assert.deepEqual(r, [{ kind: 'from', dots: 2, modulePath: 'parent.module', importedNames: ['x'] }]);
  });
  it("matches 'from . import X'", () => {
    const r = extract("from . import sibling\n");
    assert.deepEqual(r, [{ kind: 'from', dots: 1, modulePath: '', importedNames: ['sibling'] }]);
  });
  it("filters wildcard imports", () => {
    const r = extract("from module import *\n");
    assert.deepEqual(r, [{ kind: 'from', dots: 0, modulePath: 'module', importedNames: [] }]);
  });
  it("does NOT match inside comments (regex is line-anchored with ^)", () => {
    // Our regex uses ^ so indented content doesn't match
    const r = extract("    import indented_but_not_top_level\n");
    assert.deepEqual(r, []);
  });
});

// ── Boundary detection ──────────────────────────────────────────────────────

describe('JS getBoundaries', () => {
  const js = getProfile('js');
  it("matches top-level function", () => {
    const b = js.getBoundaries(['function foo() {}', '  nested();', '}']);
    assert.deepEqual(b, [0]);
  });
  it("matches async function", () => {
    const b = js.getBoundaries(['async function foo() {}']);
    assert.deepEqual(b, [0]);
  });
  it("matches class", () => {
    const b = js.getBoundaries(['class Foo {}']);
    assert.deepEqual(b, [0]);
  });
  it("matches export const arrow", () => {
    const b = js.getBoundaries(['export const foo = () => {};']);
    assert.deepEqual(b, [0]);
  });
});

describe('TS getBoundaries', () => {
  const ts = getProfile('ts');
  it("matches interface", () => {
    const b = ts.getBoundaries(['interface Foo {}']);
    assert.deepEqual(b, [0]);
  });
  it("matches type alias", () => {
    const b = ts.getBoundaries(['type Foo = string;']);
    assert.deepEqual(b, [0]);
  });
  it("matches enum", () => {
    const b = ts.getBoundaries(['enum Color { Red, Blue }']);
    assert.deepEqual(b, [0]);
  });
});

describe('pythonBoundaryScanner', () => {
  it("matches bare def at column 0", () => {
    const b = pythonBoundaryScanner(['def foo():', '    pass']);
    assert.deepEqual(b, [0]);
  });
  it("matches async def", () => {
    const b = pythonBoundaryScanner(['async def foo():', '    pass']);
    assert.deepEqual(b, [0]);
  });
  it("matches class", () => {
    const b = pythonBoundaryScanner(['class Foo:', '    pass']);
    assert.deepEqual(b, [0]);
  });
  it("groups single decorator with def", () => {
    const b = pythonBoundaryScanner(['@app.route("/")', 'def index():', '    pass']);
    assert.deepEqual(b, [0]); // boundary is at decorator line, not def line
  });
  it("groups multiple decorators with def", () => {
    const b = pythonBoundaryScanner(['@a', '@b', '@c', 'def foo():', '    pass']);
    assert.deepEqual(b, [0]);
  });
  it("ignores nested (indented) def", () => {
    const b = pythonBoundaryScanner(['def outer():', '    def inner():', '        pass']);
    assert.deepEqual(b, [0]);
  });
  it("resets decorator block on non-decorator code line", () => {
    const b = pythonBoundaryScanner(['@a', 'x = 5', 'def foo():', '    pass']);
    // decorator @a was interrupted by x=5, so boundary starts at def foo
    assert.deepEqual(b, [2]);
  });
  it("blank lines and indented lines don't break decorator grouping", () => {
    const b = pythonBoundaryScanner(['@a', '', '    # indented comment', '@b', 'def foo():']);
    // decorator block starts at @a; @b is part of same block; def at line 4
    assert.deepEqual(b, [0]);
  });
  it("returns multiple boundaries for multiple functions", () => {
    const b = pythonBoundaryScanner([
      'def foo():',
      '    pass',
      '',
      '@deco',
      'def bar():',
      '    pass',
      '',
      'class Baz:',
      '    pass'
    ]);
    assert.deepEqual(b, [0, 3, 7]); // foo, @deco (start of bar block), Baz
  });
});

// ── Python package root detection ───────────────────────────────────────────

describe('detectPythonPackageRoots', () => {
  it("includes repo root by default", () => {
    const roots = detectPythonPackageRoots([]);
    assert.deepEqual(roots, ['.']);
  });
  it("detects top-level package (app/__init__.py)", () => {
    const roots = detectPythonPackageRoots(['app/__init__.py', 'app/main.py']);
    // parent of app/ is '.', which is the root
    assert.ok(roots.includes('.'));
  });
  it("detects src/ layout", () => {
    const roots = detectPythonPackageRoots(['src/app/__init__.py', 'src/app/main.py']);
    assert.ok(roots.includes('src'));
    assert.ok(roots.includes('.'));
  });
  it("handles nested packages (app/services/__init__.py)", () => {
    const roots = detectPythonPackageRoots([
      'app/__init__.py',
      'app/services/__init__.py',
      'app/services/user.py'
    ]);
    // app/ is a root (parent '.'), app/services/ is NOT a root (its parent app/ is a package)
    assert.ok(roots.includes('.'));
    assert.ok(!roots.includes('app'));
  });
  it("supports .pyi stub packages", () => {
    const roots = detectPythonPackageRoots(['stubs/__init__.pyi']);
    assert.ok(roots.includes('.'));
  });
  it("returns deterministic sorted order", () => {
    const roots = detectPythonPackageRoots(['src/app/__init__.py', 'lib/app/__init__.py']);
    // Should be sorted: '.' first (shortest), then alphabetical
    assert.equal(roots[0], '.');
  });
});

// ── Import resolvers ────────────────────────────────────────────────────────

describe('jsResolveImport (via profile)', () => {
  const js = getProfile('js');

  it("resolves relative import with extension", () => {
    const r = js.resolveImport({ specifier: './foo.js' }, 'a/b.js', new Set(['a/foo.js']));
    assert.deepEqual(r, ['a/foo.js']);
  });
  it("resolves relative import without extension", () => {
    const r = js.resolveImport({ specifier: './foo' }, 'a/b.js', new Set(['a/foo.js']));
    assert.deepEqual(r, ['a/foo.js']);
  });
  it("resolves to /index.js", () => {
    const r = js.resolveImport({ specifier: './foo' }, 'a/b.js', new Set(['a/foo/index.js']));
    assert.deepEqual(r, ['a/foo/index.js']);
  });
  it("returns [] for external package", () => {
    assert.deepEqual(js.resolveImport({ specifier: 'react' }, 'a.js', new Set()), []);
  });
  it("returns [] when no file exists", () => {
    assert.deepEqual(js.resolveImport({ specifier: './missing' }, 'a.js', new Set(['a.js'])), []);
  });
});

describe('jsResolveImport language family preference', () => {
  const js = getProfile('js');
  const ts = getProfile('ts');

  it("TS importer prefers .ts over .js when both exist", () => {
    const files = new Set(['a/foo.ts', 'a/foo.js']);
    const r = ts.resolveImport({ specifier: './foo' }, 'a/b.ts', files);
    assert.deepEqual(r, ['a/foo.ts']);
  });
  it("JS importer prefers .js over .ts when both exist", () => {
    const files = new Set(['a/foo.ts', 'a/foo.js']);
    const r = js.resolveImport({ specifier: './foo' }, 'a/b.js', files);
    assert.deepEqual(r, ['a/foo.js']);
  });
  it("falls through to cross-family when same-family missing", () => {
    const files = new Set(['a/foo.js']);
    const r = ts.resolveImport({ specifier: './foo' }, 'a/b.ts', files);
    assert.deepEqual(r, ['a/foo.js']);
  });
});

describe('pyResolveImport', () => {
  const py = getProfile('py');
  const ctx = { pythonPackageRoots: ['.'] };

  it("resolves relative import (1 dot) to sibling file", () => {
    const files = new Set(['app/main.py', 'app/utils.py']);
    const r = py.resolveImport(
      { kind: 'from', dots: 1, modulePath: '', importedNames: ['utils'] },
      'app/main.py', files, ctx
    );
    assert.ok(r.includes('app/utils.py'));
  });
  it("resolves absolute 'from app.services import user'", () => {
    const files = new Set(['app/services/user.py', 'app/services/__init__.py', 'app/__init__.py']);
    const r = py.resolveImport(
      { kind: 'from', dots: 0, modulePath: 'app.services', importedNames: ['user'] },
      'main.py', files, ctx
    );
    assert.ok(r.includes('app/services/user.py'));
  });
  it("resolves 'import pkg' to __init__.py", () => {
    const files = new Set(['app/__init__.py', 'app/main.py']);
    const r = py.resolveImport(
      { kind: 'import', dots: 0, modulePath: 'app', importedNames: [] },
      'main.py', files, ctx
    );
    assert.deepEqual(r, ['app/__init__.py']);
  });
  it("returns [] for external package", () => {
    assert.deepEqual(
      py.resolveImport(
        { kind: 'import', dots: 0, modulePath: 'requests', importedNames: [] },
        'main.py', new Set(), ctx
      ),
      []
    );
  });
  it("resolves .pyi stub file", () => {
    const files = new Set(['types/foo.pyi']);
    const r = py.resolveImport(
      { kind: 'from', dots: 0, modulePath: 'types', importedNames: ['foo'] },
      'main.py', files, ctx
    );
    assert.ok(r.includes('types/foo.pyi'));
  });
  it("uses pythonPackageRoots for src/ layout", () => {
    const files = new Set(['src/app/services.py', 'src/app/__init__.py']);
    const srcCtx = { pythonPackageRoots: ['.', 'src'] };
    const r = py.resolveImport(
      { kind: 'from', dots: 0, modulePath: 'app', importedNames: ['services'] },
      'src/app/main.py', files, srcCtx
    );
    assert.ok(r.includes('src/app/services.py'));
  });
});

// ── LanguageContext ─────────────────────────────────────────────────────────

describe('buildLanguageContext', () => {
  it("builds repoFileSet from normalized paths", () => {
    const ctx = buildLanguageContext(['foo.py', 'bar.js']);
    assert.ok(ctx.repoFileSet instanceof Set);
    assert.equal(ctx.repoFileSet.size, 2);
  });
  it("detects Python package roots", () => {
    const ctx = buildLanguageContext(['app/__init__.py', 'app/main.py']);
    assert.ok(Array.isArray(ctx.pythonPackageRoots));
    assert.ok(ctx.pythonPackageRoots.includes('.'));
  });
  it("handles empty file list", () => {
    const ctx = buildLanguageContext([]);
    assert.equal(ctx.repoFileSet.size, 0);
    assert.deepEqual(ctx.pythonPackageRoots, ['.']);
  });
});

// ── Extension metadata ──────────────────────────────────────────────────────

describe('ALL_SUPPORTED_EXTENSIONS', () => {
  it("includes code extensions from profiles", () => {
    assert.ok(ALL_SUPPORTED_EXTENSIONS.includes('py'));
    assert.ok(ALL_SUPPORTED_EXTENSIONS.includes('js'));
    assert.ok(ALL_SUPPORTED_EXTENSIONS.includes('ts'));
    assert.ok(ALL_SUPPORTED_EXTENSIONS.includes('tsx'));
  });
  it("includes non-code referenced extensions", () => {
    assert.ok(ALL_SUPPORTED_EXTENSIONS.includes('json'));
    assert.ok(ALL_SUPPORTED_EXTENSIONS.includes('md'));
    assert.ok(ALL_SUPPORTED_EXTENSIONS.includes('sql'));
  });
  it("is frozen (immutable)", () => {
    assert.throws(() => { ALL_SUPPORTED_EXTENSIONS.push('foo'); }, TypeError);
  });
});

describe('ALL_EXTENSIONS_PATTERN', () => {
  it("is pipe-separated", () => {
    assert.ok(ALL_EXTENSIONS_PATTERN.includes('|'));
  });
  it("sorts longest-first so multi-char extensions match before prefixes", () => {
    const parts = ALL_EXTENSIONS_PATTERN.split('|');
    // Verify 'tsx' comes before 'ts', 'mjs' before 'js', etc.
    const tsxIdx = parts.indexOf('tsx');
    const tsIdx = parts.indexOf('ts');
    assert.ok(tsxIdx < tsIdx, "'tsx' should precede 'ts' in alternation");
    const mjsIdx = parts.indexOf('mjs');
    const jsIdx = parts.indexOf('js');
    assert.ok(mjsIdx < jsIdx, "'mjs' should precede 'js'");
    const pyiIdx = parts.indexOf('pyi');
    const pyIdx = parts.indexOf('py');
    assert.ok(pyiIdx < pyIdx, "'pyi' should precede 'py'");
  });
});

describe('buildFileReferenceRegex', () => {
  it("matches bare filenames", () => {
    const re = buildFileReferenceRegex();
    const m = [...' foo.py '.matchAll(re)];
    assert.equal(m[0][1], 'foo.py');
  });
  it("matches relative paths", () => {
    const re = buildFileReferenceRegex();
    const m = [...' ./app/main.py '.matchAll(re)];
    assert.equal(m[0][1], './app/main.py');
  });
  it("matches parent-relative paths", () => {
    const re = buildFileReferenceRegex();
    const m = [...' ../pkg/mod.py '.matchAll(re)];
    assert.equal(m[0][1], '../pkg/mod.py');
  });
  it("matches absolute paths", () => {
    const re = buildFileReferenceRegex();
    const m = [...' /abs/foo.py '.matchAll(re)];
    assert.equal(m[0][1], '/abs/foo.py');
  });
  it("matches backticked paths", () => {
    const re = buildFileReferenceRegex();
    const m = [...'see `scripts/foo.py` now'.matchAll(re)];
    assert.equal(m[0][1], 'scripts/foo.py');
  });
  it("matches paths with dots in directory names", () => {
    const re = buildFileReferenceRegex();
    const m = [...' .claude/skills/foo.md '.matchAll(re)];
    assert.equal(m[0][1], '.claude/skills/foo.md');
  });
});

describe('toExtensionAlternation — the ordering is a correctness property', () => {
  // Found live 2026-08-08 in a consumer's plan: plan-paths.mjs hand-maintained
  // its own `js|mjs|ts|tsx|…|json` alternation. JS alternation is
  // first-match-wins, so `personas.json` matched as `personas.js` — a file that
  // does not exist. Inside a fenced block (where the backtick-anchored regex
  // does not apply) the truncated form was the ONLY match, so the real path was
  // never found, deflating the resolvable-path count that decides whether fuzzy
  // keyword discovery fires.

  it('puts longer extensions before any extension that prefixes them', () => {
    const alt = toExtensionAlternation(['js', 'json', 'ts', 'tsx', 'mjs']);
    const order = alt.split('|');
    for (const [short, long] of [['js', 'json'], ['ts', 'tsx'], ['js', 'mjs']]) {
      assert.ok(
        order.indexOf(long) < order.indexOf(short),
        `${long} must be tried before ${short} (got ${alt})`,
      );
    }
  });

  it('NEGATIVE CONTROL: the naive insertion order really does truncate', () => {
    // Without this, the test above could pass against a regex that never had
    // the bug — proving the ordering matters, not just that it is applied.
    const naive = new RegExp(`([\\w.-]+\\.(?:${['js', 'json'].join('|')}))`);
    assert.equal('a/conf.json'.match(naive)[1], 'conf.js');

    const fixed = new RegExp(`([\\w.-]+\\.(?:${toExtensionAlternation(['js', 'json'])}))`);
    assert.equal('a/conf.json'.match(fixed)[1], 'conf.json');
  });

  it('is stable for a list with no shared prefixes', () => {
    assert.deepEqual(toExtensionAlternation(['py', 'rb', 'go']).split('|').sort(), ['go', 'py', 'rb']);
  });
});

describe('extractPlanPaths resolves every extension it claims to support', () => {
  it('extracts .json/.tsx/.mjs from a fenced block, with no truncated twin', () => {
    // A fenced block is the case that has no backtick anchor to fall back on.
    const md = [
      '```', 'scripts/harness/personas.json   # persona definitions',
      'src/ui/Deck.tsx', 'scripts/harness/driver.mjs', '```',
    ].join('\n');
    const got = [...extractPlanPaths(md, { allowInfraFiles: true }).allPaths].sort();
    assert.deepEqual(got, ['scripts/harness/driver.mjs', 'scripts/harness/personas.json', 'src/ui/Deck.tsx']);
  });

  it('covers every declared plan-reference extension', () => {
    for (const ext of PLAN_REFERENCE_EXTENSIONS) {
      const got = [...extractPlanPaths(`see a/b/file.${ext} here`, { allowInfraFiles: true }).allPaths];
      assert.deepEqual(got, [`a/b/file.${ext}`], `extension ${ext} did not round-trip`);
    }
  });
});

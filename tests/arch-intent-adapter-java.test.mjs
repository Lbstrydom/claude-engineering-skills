/**
 * Tests for the architecture-intent Java adapter
 * (scripts/lib/arch-intent/adapters/java.mjs).
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import analyseImports, { _internals } from '../scripts/lib/arch-intent/adapters/java.mjs';

const {
  stripJavaCommentsAndLiterals, extractImports, extractPackage,
  buildJavaResolutionIndex, resolveJavaImport,
} = _internals;

let tmpDir;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-java-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

function writeTree(files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(tmpDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return tmpDir;
}

// ── stripJavaCommentsAndLiterals ────────────────────────────────────────────

describe('stripJavaCommentsAndLiterals', () => {
  it('blanks // line comments', () => {
    const out = stripJavaCommentsAndLiterals('int x = 1; // import com.evil.Thing;');
    assert.ok(!out.includes('com.evil'));
    assert.ok(out.includes('int x = 1;'));
  });
  it('blanks /* */ block comments', () => {
    const out = stripJavaCommentsAndLiterals('/* import com.evil.Thing; */\nimport com.real.Thing;');
    assert.ok(!out.includes('com.evil'));
    assert.ok(out.includes('com.real'));
  });
  it('blanks string literals', () => {
    const out = stripJavaCommentsAndLiterals('String s = "import com.evil.Thing;";');
    assert.ok(!out.includes('com.evil'));
  });
  it('blanks text blocks (Java 15+)', () => {
    const src = 'String s = """\nimport com.evil.Thing;\n""";\nimport com.real.Thing;';
    const out = stripJavaCommentsAndLiterals(src);
    assert.ok(!out.includes('com.evil'));
    assert.ok(out.includes('com.real'));
  });
  it('handles an import split by a block comment mid-line', () => {
    const out = stripJavaCommentsAndLiterals('import com.foo./* x */Bar;');
    // comment blanked, the import tokens survive
    assert.ok(out.includes('import com.foo.'));
    assert.ok(out.includes('Bar;'));
  });
  it('preserves line count', () => {
    const src = '/*\na\nb\n*/\nimport x;';
    assert.equal(
      stripJavaCommentsAndLiterals(src).split('\n').length,
      src.split('\n').length);
  });
});

// ── extractPackage ──────────────────────────────────────────────────────────

describe('extractPackage', () => {
  it('extracts a package declaration', () => {
    assert.equal(extractPackage('package com.example.app;\nimport x;'), 'com.example.app');
  });
  it('returns empty string for the default package', () => {
    assert.equal(extractPackage('import com.x.Y;\nclass Z {}'), '');
  });
  it('finds package even when preceded by comment lines (already stripped)', () => {
    assert.equal(extractPackage('   \n\npackage com.foo;'), 'com.foo');
  });
});

// ── extractImports ──────────────────────────────────────────────────────────

describe('extractImports', () => {
  it('extracts a plain import', () => {
    const refs = extractImports('import com.foo.Bar;');
    assert.equal(refs.length, 1);
    assert.deepEqual(
      { fqn: refs[0].fqn, isWildcard: refs[0].isWildcard, isStatic: refs[0].isStatic },
      { fqn: 'com.foo.Bar', isWildcard: false, isStatic: false });
  });
  it('extracts a wildcard import', () => {
    const refs = extractImports('import com.foo.*;');
    assert.equal(refs[0].fqn, 'com.foo');
    assert.equal(refs[0].isWildcard, true);
  });
  it('extracts a static import', () => {
    const refs = extractImports('import static com.foo.Bar.method;');
    assert.equal(refs[0].fqn, 'com.foo.Bar.method');
    assert.equal(refs[0].isStatic, true);
  });
  it('extracts a static wildcard import', () => {
    const refs = extractImports('import static com.foo.Bar.*;');
    assert.equal(refs[0].fqn, 'com.foo.Bar');
    assert.equal(refs[0].isStatic, true);
    assert.equal(refs[0].isWildcard, true);
  });
  it('extracts an import wrapped across physical lines (L1)', () => {
    const refs = extractImports('import com.foo.\n  Bar;');
    assert.equal(refs.length, 1);
    assert.equal(refs[0].fqn, 'com.foo.Bar');
  });
  it('reports the line of the import keyword for a wrapped import', () => {
    const refs = extractImports('package com.x;\n\nimport com.foo.\n  Bar;');
    assert.equal(refs[0].line, 3);
  });
  it('extracts an import sharing a line with the package declaration (G1)', () => {
    const refs = extractImports('package com.x; import com.foo.Bar;');
    assert.equal(refs.length, 1);
    assert.equal(refs[0].fqn, 'com.foo.Bar');
  });
  it('extracts multiple imports on one physical line (G1)', () => {
    const refs = extractImports('import a.A; import b.B;');
    assert.deepEqual(refs.map(r => r.fqn).sort(), ['a.A', 'b.B']);
  });
});

// ── buildJavaResolutionIndex ────────────────────────────────────────────────

describe('buildJavaResolutionIndex', () => {
  it('indexes FQN -> file and derives source root', () => {
    const root = writeTree({
      'src/main/java/com/foo/Bar.java': 'package com.foo;\nclass Bar {}',
    });
    const mapped = new Map([['src/main/java/com/foo/Bar.java', 'app']]);
    const idx = buildJavaResolutionIndex(mapped, root);
    assert.deepEqual(idx.fqnToFiles.get('com.foo.Bar'), ['src/main/java/com/foo/Bar.java']);
    assert.equal(idx.fileToSourceRoot.get('src/main/java/com/foo/Bar.java'), 'src/main/java');
  });
  it('does not index package-info.java / module-info.java as classes (M3)', () => {
    const root = writeTree({
      'src/com/foo/package-info.java': 'package com.foo;',
      'src/com/foo/module-info.java': 'module com.foo {}',
      'src/com/foo/Real.java': 'package com.foo;\nclass Real {}',
    });
    const mapped = new Map([
      ['src/com/foo/package-info.java', 'app'],
      ['src/com/foo/module-info.java', 'app'],
      ['src/com/foo/Real.java', 'app'],
    ]);
    const idx = buildJavaResolutionIndex(mapped, root);
    assert.equal(idx.fqnToFiles.has('com.foo.package-info'), false);
    assert.equal(idx.fqnToFiles.has('com.foo.module-info'), false);
    assert.ok(idx.fqnToFiles.has('com.foo.Real'));
    assert.deepEqual(idx.packageToFiles.get('com.foo'), ['src/com/foo/Real.java']);
  });
  it('distinguishes same FQN across src/main and src/test source sets', () => {
    const root = writeTree({
      'src/main/java/com/foo/Bar.java': 'package com.foo;\nclass Bar {}',
      'src/test/java/com/foo/Bar.java': 'package com.foo;\nclass Bar {}',
    });
    const mapped = new Map([
      ['src/main/java/com/foo/Bar.java', 'app'],
      ['src/test/java/com/foo/Bar.java', 'tests'],
    ]);
    const idx = buildJavaResolutionIndex(mapped, root);
    assert.equal(idx.fqnToFiles.get('com.foo.Bar').length, 2);
  });
});

// ── resolveJavaImport ───────────────────────────────────────────────────────

describe('resolveJavaImport', () => {
  function idxOf(files) {
    const root = writeTree(files);
    const mapped = new Map(Object.keys(files).map(f => [f, 'x']));
    return buildJavaResolutionIndex(mapped, root);
  }

  it('resolves a plain class import', () => {
    const idx = idxOf({ 'src/com/foo/Bar.java': 'package com.foo;' });
    const res = resolveJavaImport(
      { fqn: 'com.foo.Bar', isStatic: false, isWildcard: false },
      'src/com/foo/Other.java', idx);
    assert.equal(res.state, 'resolved-local');
  });
  it('resolves a nested type import by progressive stripping (R3-H3)', () => {
    const idx = idxOf({ 'src/com/foo/Outer.java': 'package com.foo;' });
    const res = resolveJavaImport(
      { fqn: 'com.foo.Outer.Inner', isStatic: false, isWildcard: false },
      'src/com/foo/X.java', idx);
    assert.equal(res.state, 'resolved-local');
    assert.deepEqual(res.targetFiles, ['src/com/foo/Outer.java']);
  });
  it('resolves a lowercase static member import (G1)', () => {
    const idx = idxOf({ 'src/com/foo/Bar.java': 'package com.foo;' });
    const res = resolveJavaImport(
      { fqn: 'com.foo.Bar.method', isStatic: true, isWildcard: false },
      'src/com/foo/X.java', idx);
    assert.equal(res.state, 'resolved-local');
    assert.deepEqual(res.targetFiles, ['src/com/foo/Bar.java']);
  });
  it('resolves a static wildcard on a class (G2)', () => {
    const idx = idxOf({ 'src/com/foo/Bar.java': 'package com.foo;' });
    const res = resolveJavaImport(
      { fqn: 'com.foo.Bar', isStatic: true, isWildcard: true },
      'src/com/foo/X.java', idx);
    assert.equal(res.state, 'resolved-local');
    assert.deepEqual(res.targetFiles, ['src/com/foo/Bar.java']);
  });
  it('resolves a non-static type-import-on-demand wildcard (G2, JLS 7.5.2)', () => {
    // `import com.foo.Outer.*;` — Outer is a CLASS, not a package.
    const idx = idxOf({ 'src/com/foo/Outer.java': 'package com.foo;' });
    const res = resolveJavaImport(
      { fqn: 'com.foo.Outer', isStatic: false, isWildcard: true },
      'src/com/foo/X.java', idx);
    assert.equal(res.state, 'resolved-local');
    assert.deepEqual(res.targetFiles, ['src/com/foo/Outer.java']);
  });
  it('classifies a JDK import as proven-external', () => {
    const idx = idxOf({ 'src/com/foo/Bar.java': 'package com.foo;' });
    const res = resolveJavaImport(
      { fqn: 'java.util.List', isStatic: false, isWildcard: false },
      'src/com/foo/Bar.java', idx);
    assert.equal(res.state, 'proven-external');
  });
  it('classifies an unknown out-of-tree class as unresolved', () => {
    const idx = idxOf({ 'src/com/foo/Bar.java': 'package com.foo;' });
    const res = resolveJavaImport(
      { fqn: 'org.thirdparty.Lib', isStatic: false, isWildcard: false },
      'src/com/foo/Bar.java', idx);
    assert.equal(res.state, 'unresolved');
  });
});

// ── Integration — analyseImports against a fixture repo ─────────────────────

describe('java analyseImports (integration)', () => {
  function buildFixture() {
    return writeTree({
      'src/main/java/com/example/core/Model.java':
        'package com.example.core;\npublic class Model {}\n',
      'src/main/java/com/example/app/Service.java':
        'package com.example.app;\n' +
        'import com.example.core.Model;\n' +
        'import com.example.tests.Helper;\n' +
        'public class Service {}\n',
      'src/main/java/com/example/app/Handler.java':
        'package com.example.app;\n' +
        'import com.example.app.Service;\n' +
        'import java.util.List;\n' +
        'public class Handler {}\n',
      'src/main/java/com/example/app/WildUser.java':
        'package com.example.app;\n' +
        'import com.example.core.*;\n' +
        'public class WildUser {}\n',
      'src/test/java/com/example/tests/Helper.java':
        'package com.example.tests;\npublic class Helper {}\n',
    });
  }
  const mapped = new Map([
    ['src/main/java/com/example/core/Model.java', 'core'],
    ['src/main/java/com/example/app/Service.java', 'app'],
    ['src/main/java/com/example/app/Handler.java', 'app'],
    ['src/main/java/com/example/app/WildUser.java', 'app'],
    ['src/test/java/com/example/tests/Helper.java', 'tests'],
  ]);
  const domainMap = {
    rules: [
      { pattern: 'src/main/java/com/example/core/**', domain: 'core' },
      { pattern: 'src/main/java/com/example/app/**', domain: 'app' },
      { pattern: 'src/test/**', domain: 'tests' },
    ],
    allowedDeps: { app: ['core'], tests: ['core', 'app'] },
  };

  it('catches the deliberate app -> tests violation', async () => {
    const repoPath = buildFixture();
    const { violations } = await analyseImports({ mapped, domainMap, repoPath });
    const v = violations.find(x =>
      x.fromFile.endsWith('Service.java') && x.toFile.endsWith('Helper.java'));
    assert.ok(v, `expected Service -> Helper violation, got ${JSON.stringify(violations)}`);
    assert.equal(v.fromDomain, 'app');
    assert.equal(v.toDomain, 'tests');
  });
  it('does NOT flag the allowed app -> core edge or same-domain/vendor edges', async () => {
    const repoPath = buildFixture();
    const { violations } = await analyseImports({ mapped, domainMap, repoPath });
    assert.ok(!violations.some(x => x.toFile.endsWith('Model.java')));
    assert.ok(!violations.some(x => x.fromFile.endsWith('Handler.java')));
  });
  it('wildcard import com.example.core.* emits ONE edge to the domain, not per-file', async () => {
    const repoPath = buildFixture();
    const { violations } = await analyseImports({ mapped, domainMap, repoPath });
    // WildUser (app) -> core via wildcard: app->core is allowed, so zero violations.
    assert.ok(!violations.some(x => x.fromFile.endsWith('WildUser.java')));
  });
  it('_meta has all fixed keys incl. packagesSpanningDomains', async () => {
    const repoPath = buildFixture();
    const { _meta, analyzerVersion } = await analyseImports({ mapped, domainMap, repoPath });
    for (const k of ['edgeCount', 'localEdges', 'wildcardEdges', 'vendorEdges',
      'staticImports', 'unresolvedEdges', 'ambiguousEdges',
      'packagesSpanningDomains', 'unreadableFiles', 'sourceRoots', 'allFiles']) {
      assert.ok(k in _meta, `_meta missing key ${k}`);
    }
    assert.equal(analyzerVersion, 'java-1.0.0');
  });
  it('returns empty for a repo with no java files', async () => {
    const repoPath = writeTree({ 'readme.md': 'hi' });
    const { violations } = await analyseImports({ mapped: new Map(), domainMap, repoPath });
    assert.deepEqual(violations, []);
  });
});

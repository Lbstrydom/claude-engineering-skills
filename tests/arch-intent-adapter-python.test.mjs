/**
 * Tests for the architecture-intent Python adapter
 * (scripts/lib/arch-intent/adapters/python.mjs).
 *
 * Unit tests cover each pure helper; integration tests run analyseImports
 * against synthetic fixture repos written to a tmpdir.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import analyseImports, { _internals } from '../scripts/lib/arch-intent/adapters/python.mjs';
import { writeTree } from './helpers/fixtures.mjs';

const {
  stripPythonCommentsAndStrings, extractImports, discoverPythonRoots,
  buildPythonModuleIndex, resolvePythonImport,
} = _internals;

let tmpDir;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-py-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

// ── stripPythonCommentsAndStrings ───────────────────────────────────────────

describe('stripPythonCommentsAndStrings', () => {
  it('blanks # comments', () => {
    const out = stripPythonCommentsAndStrings('x = 1  # import os\ny = 2');
    assert.ok(!out.includes('import os'));
    assert.ok(out.includes('x = 1'));
    assert.ok(out.includes('y = 2'));
  });
  it('blanks single and double quoted strings', () => {
    const out = stripPythonCommentsAndStrings(`a = "import os"\nb = 'from x import y'`);
    assert.ok(!out.includes('import os'));
    assert.ok(!out.includes('from x import y'));
  });
  it('blanks triple-quoted docstrings', () => {
    const src = '"""\nimport os\nfrom x import y\n"""\nimport real';
    const out = stripPythonCommentsAndStrings(src);
    assert.ok(!out.includes('import os'));
    assert.ok(out.includes('import real'));
  });
  it('preserves line count', () => {
    const src = '"""\na\nb\n"""\nimport real';
    const out = stripPythonCommentsAndStrings(src);
    assert.equal(out.split('\n').length, src.split('\n').length);
  });
  it('handles prefixed strings (r, f, b)', () => {
    const out = stripPythonCommentsAndStrings('a = r"import os"\nb = b"from x import y"');
    assert.ok(!out.includes('import os'));
    assert.ok(!out.includes('from x import y'));
  });
  it('PEP 701 — f-string with reused quote inside interpolation does not desync', () => {
    // The inner "ok" reuses the same quote; without brace tracking the
    // scanner would terminate early and mis-read the rest.
    const src = 'msg = f"status: { "ok" } done"\nimport real_module';
    const out = stripPythonCommentsAndStrings(src);
    assert.ok(out.includes('import real_module'),
      `import after f-string must still be visible, got: ${JSON.stringify(out)}`);
  });
  it('f-string interpolation with a brace inside a nested string does not desync (M4)', () => {
    // The `}` lives inside the nested "}" string — it must NOT decrement
    // brace depth, or the f-string would close one char early.
    const src = 'v = f"{ d["}"] } tail"\nimport real_module';
    const out = stripPythonCommentsAndStrings(src);
    assert.ok(out.includes('import real_module'),
      `import after nested-brace f-string must still be visible, got: ${JSON.stringify(out)}`);
  });
});

// ── extractImports ──────────────────────────────────────────────────────────

describe('extractImports', () => {
  it('extracts plain import', () => {
    const refs = extractImports('import os');
    assert.equal(refs.length, 1);
    assert.equal(refs[0].module, 'os');
    assert.equal(refs[0].kind, 'import');
  });
  it('extracts comma-list import', () => {
    const refs = extractImports('import os, sys, json');
    assert.deepEqual(refs.map(r => r.module).sort(), ['json', 'os', 'sys']);
  });
  it('extracts import with alias', () => {
    const refs = extractImports('import numpy as np');
    assert.equal(refs[0].module, 'numpy');
  });
  it('extracts from-import', () => {
    const refs = extractImports('from app.services import user, order');
    assert.equal(refs[0].kind, 'from');
    assert.equal(refs[0].module, 'app.services');
    assert.deepEqual(refs[0].names.sort(), ['order', 'user']);
  });
  it('extracts parenthesised multi-line from-import', () => {
    const refs = extractImports('from app import (\n  a,\n  b,\n  c,\n)');
    assert.equal(refs[0].module, 'app');
    assert.deepEqual(refs[0].names.sort(), ['a', 'b', 'c']);
  });
  it('extracts relative import with dot count', () => {
    const refs = extractImports('from ..pkg import thing');
    assert.equal(refs[0].isRelative, true);
    assert.equal(refs[0].dotCount, 2);
    assert.equal(refs[0].module, 'pkg');
  });
  it('extracts star import', () => {
    const refs = extractImports('from app import *');
    assert.deepEqual(refs[0].names, ['*']);
  });
  it('handles backslash line continuation', () => {
    const refs = extractImports('import os, \\\n  sys');
    assert.deepEqual(refs.map(r => r.module).sort(), ['os', 'sys']);
  });
  it('handles semicolon-separated statements on one line (M9)', () => {
    const refs = extractImports('import os; import sys');
    assert.deepEqual(refs.map(r => r.module).sort(), ['os', 'sys']);
  });
  it('finds an import after a non-import statement on the same line (M9)', () => {
    const refs = extractImports('x = 1; import sys');
    assert.deepEqual(refs.map(r => r.module), ['sys']);
  });
  it('joins backslash continuation on CRLF files (M3)', () => {
    const refs = extractImports('import os, \\\r\n  sys');
    assert.deepEqual(refs.map(r => r.module).sort(), ['os', 'sys']);
  });
});

describe('stripPythonCommentsAndStrings — line preservation (L1)', () => {
  it('an unterminated single-quoted string does not duplicate the newline', () => {
    const src = "x = 'oops\nimport real\n";
    const out = stripPythonCommentsAndStrings(src);
    assert.equal(out.split('\n').length, src.split('\n').length,
      `line count must be preserved, got ${JSON.stringify(out)}`);
    assert.ok(out.includes('import real'));
  });
});

// ── discoverPythonRoots ─────────────────────────────────────────────────────

describe('discoverPythonRoots', () => {
  it('flat layout — repo root is a root', () => {
    const root = writeTree(tmpDir, { 'mod.py': '', 'other.py': '' });
    const mapped = new Map([['mod.py', 'core'], ['other.py', 'core']]);
    const roots = discoverPythonRoots(root, mapped);
    assert.ok(roots.includes(''));
  });
  it('src/ layout — src is discovered', () => {
    const root = writeTree(tmpDir, { 'src/pkg/mod.py': '', 'src/pkg/__init__.py': '' });
    const mapped = new Map([['src/pkg/mod.py', 'core'], ['src/pkg/__init__.py', 'core']]);
    const roots = discoverPythonRoots(root, mapped);
    assert.ok(roots.includes('src'), `roots=${JSON.stringify(roots)}`);
  });
  it('monorepo — nested src/ under apps/ is discovered (G2)', () => {
    const root = writeTree(tmpDir, {
      'apps/svc/pyproject.toml': '[tool.setuptools]\n',
      'apps/svc/src/pkg/mod.py': '',
    });
    const mapped = new Map([['apps/svc/src/pkg/mod.py', 'core']]);
    const roots = discoverPythonRoots(root, mapped);
    assert.ok(roots.includes('apps/svc/src'), `roots=${JSON.stringify(roots)}`);
  });
});

// ── buildPythonModuleIndex ──────────────────────────────────────────────────

describe('buildPythonModuleIndex', () => {
  it('indexes a file under its most-specific root only (H1)', () => {
    const mapped = new Map([['src/pkg/mod.py', 'core']]);
    const { moduleToFile } = buildPythonModuleIndex(mapped, ['', 'src']);
    assert.equal(moduleToFile.get('pkg.mod'), 'src/pkg/mod.py');
    assert.equal(moduleToFile.has('src.pkg.mod'), false,
      'must NOT create the bogus src.pkg.mod alias');
  });
  it('registers __init__.py as a package', () => {
    const mapped = new Map([['pkg/__init__.py', 'core']]);
    const { packageDirs } = buildPythonModuleIndex(mapped, ['']);
    assert.ok(packageDirs.has('pkg'));
  });
  it('records collisions deterministically', () => {
    // Two roots that are NOT prefixes of each other → same dotted name.
    const mapped = new Map([['a/mod.py', 'core'], ['b/mod.py', 'app']]);
    const { moduleToFile, indexCollisions } = buildPythonModuleIndex(mapped, ['a', 'b']);
    assert.equal(moduleToFile.get('mod'), 'a/mod.py'); // first sorted wins
    assert.equal(indexCollisions.length, 1);
    assert.equal(indexCollisions[0].dottedName, 'mod');
  });
});

// ── resolvePythonImport ─────────────────────────────────────────────────────

describe('resolvePythonImport', () => {
  const index = {
    moduleToFile: new Map([
      ['core.models', 'core/models.py'],
      ['app.svc', 'app/svc.py'],
    ]),
    packageDirs: new Set(['core', 'app']),
  };
  it('resolves a local absolute import', () => {
    const ref = { kind: 'import', module: 'core.models', names: [], isRelative: false, dotCount: 0 };
    const res = resolvePythonImport(ref, 'app/svc.py', index);
    assert.equal(res.state, 'resolved-local');
    assert.equal(res.targetFile, 'core/models.py');
  });
  it('classifies a stdlib import as proven-external', () => {
    const ref = { kind: 'import', module: 'os', names: [], isRelative: false, dotCount: 0 };
    assert.equal(resolvePythonImport(ref, 'app/svc.py', index).state, 'proven-external');
  });
  it('classifies an unknown third-party import as unresolved', () => {
    const ref = { kind: 'import', module: 'requests', names: [], isRelative: false, dotCount: 0 };
    assert.equal(resolvePythonImport(ref, 'app/svc.py', index).state, 'unresolved');
  });
  it('resolves from-import submodule even when package has no __init__ (G3)', () => {
    // Namespace package: a.b is NOT in packageDirs, but a.b.c IS in moduleToFile.
    const nsIndex = {
      moduleToFile: new Map([['a.b.c', 'a/b/c.py']]),
      packageDirs: new Set(), // no __init__.py anywhere
    };
    const ref = { kind: 'from', module: 'a.b', names: ['c'], isRelative: false, dotCount: 0 };
    const res = resolvePythonImport(ref, 'other.py', nsIndex);
    assert.equal(res.state, 'resolved-local');
    assert.ok(res.submodules.includes('a/b/c.py'));
  });
});

// ── Integration — analyseImports against a fixture repo ─────────────────────

describe('python analyseImports (integration)', () => {
  function buildFixture() {
    return writeTree(tmpDir, {
      'core/__init__.py': '',
      'core/models.py': 'import os\n',
      'app/__init__.py': '',
      'app/service.py': 'from core.models import Thing\nfrom tests.helper import mk\n',
      'app/handler.py': 'from app.service import run\nimport json\n',
      'tests/__init__.py': '',
      'tests/helper.py': '',
      'tests/test_app.py': 'from app.service import run\n',
    });
  }
  const mapped = new Map([
    ['core/__init__.py', 'core'], ['core/models.py', 'core'],
    ['app/__init__.py', 'app'], ['app/service.py', 'app'], ['app/handler.py', 'app'],
    ['tests/__init__.py', 'tests'], ['tests/helper.py', 'tests'], ['tests/test_app.py', 'tests'],
  ]);
  const domainMap = {
    rules: [
      { pattern: 'core/**', domain: 'core' },
      { pattern: 'app/**', domain: 'app' },
      { pattern: 'tests/**', domain: 'tests' },
    ],
    allowedDeps: { app: ['core'], tests: ['core', 'app'] },
  };

  it('catches the deliberate app -> tests violation', async () => {
    const repoPath = buildFixture();
    const { violations } = await analyseImports({ mapped, domainMap, repoPath });
    const v = violations.find(x => x.fromFile === 'app/service.py' && x.toFile === 'tests/helper.py');
    assert.ok(v, `expected app/service.py -> tests/helper.py violation, got ${JSON.stringify(violations)}`);
    assert.equal(v.fromDomain, 'app');
    assert.equal(v.toDomain, 'tests');
  });
  it('does NOT flag the allowed app -> core edge', async () => {
    const repoPath = buildFixture();
    const { violations } = await analyseImports({ mapped, domainMap, repoPath });
    assert.ok(!violations.some(x => x.toFile === 'core/models.py'));
  });
  it('does NOT flag same-domain or stdlib edges', async () => {
    const repoPath = buildFixture();
    const { violations, _meta } = await analyseImports({ mapped, domainMap, repoPath });
    // app/handler.py -> app/service.py is same-domain; import json is stdlib.
    assert.ok(!violations.some(x => x.fromFile === 'app/handler.py'));
    assert.ok(_meta.vendorEdges >= 2, `expected stdlib vendor edges, _meta=${JSON.stringify(_meta)}`);
  });
  it('_meta has all fixed keys', async () => {
    const repoPath = buildFixture();
    const { _meta, analyzerVersion } = await analyseImports({ mapped, domainMap, repoPath });
    for (const k of ['edgeCount', 'localEdges', 'vendorEdges', 'unresolvedEdges',
      'starImports', 'indexCollisions', 'sourceRoots', 'allFiles']) {
      assert.ok(k in _meta, `_meta missing key ${k}`);
    }
    assert.equal(analyzerVersion, 'python-1.0.0');
  });
  it('returns empty for a repo with no python files', async () => {
    const repoPath = writeTree(tmpDir, { 'readme.md': 'hi' });
    const { violations } = await analyseImports({ mapped: new Map(), domainMap, repoPath });
    assert.deepEqual(violations, []);
  });
});

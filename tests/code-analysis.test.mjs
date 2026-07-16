import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  extractImportBlock,
  splitAtFunctionBoundaries,
  chunkLargeFile,
  buildDependencyGraph,
  extractExportsOnly,
  buildAuditUnits,
} from '../scripts/lib/code-analysis.mjs';
import { getProfile, buildLanguageContext } from '../scripts/lib/language-profiles.mjs';

// ── Test fixtures ───────────────────────────────────────────────────────────

const JS_SOURCE = `import fs from 'fs';
import { x } from './x.js';

const CONFIG = { a: 1 };

export function foo() {
  return 1;
}

export const bar = () => 2;

class Baz {
  method() {}
}

export function qux() {
  return 3;
}
`;

const PY_SOURCE = `import os
from flask import Flask
from app.services import user_service

app = Flask(__name__)

@app.route('/')
def index():
    return 'hello'

@app.route('/users')
@login_required
def users():
    return user_service.list_users()

class UserController:
    def get(self, id):
        return self._fetch(id)

    def _fetch(self, id):
        return None

async def fetch_data():
    return await db.query()
`;

// ── Regression: JS legacy behavior preserved (no profile arg) ──────────────

describe('JS backward compat (no profile arg)', () => {
  it("extractImportBlock returns import header for JS", () => {
    const block = extractImportBlock(JS_SOURCE);
    assert.ok(block.startsWith("import fs from 'fs';"));
    assert.ok(block.includes("import { x } from './x.js';"));
    assert.ok(!block.includes('export function foo'));
  });

  it("splitAtFunctionBoundaries finds JS function boundaries", () => {
    const chunks = splitAtFunctionBoundaries(JS_SOURCE);
    // Expect chunks starting at: `export function foo`, `export const bar`, `class Baz`, `export function qux`
    assert.ok(chunks.length >= 4);
    assert.ok(chunks[0].source.includes('export function foo'));
    assert.ok(chunks.some(c => c.source.includes('export const bar')));
    assert.ok(chunks.some(c => c.source.includes('class Baz')));
    assert.ok(chunks.some(c => c.source.includes('export function qux')));
  });

  it("chunkLargeFile groups JS functions", () => {
    const chunks = chunkLargeFile(JS_SOURCE, 'foo.js', 10000);
    assert.ok(chunks.length >= 1);
    assert.ok(chunks[0].imports.includes("import fs from 'fs'"));
    assert.ok(chunks[0].items.length > 0);
  });
});

// ── Python decorator-aware chunking ─────────────────────────────────────────

describe('Python chunking with decorators', () => {
  const py = getProfile('py');

  it("extractImportBlock returns Python import header", () => {
    const block = extractImportBlock(PY_SOURCE, py);
    assert.ok(block.startsWith('import os'));
    assert.ok(block.includes('from flask import Flask'));
    // Should NOT include the Flask app initialization (that's before first def)
    // Actually our scanner stops at first def/class boundary, so app=Flask(...) IS in imports
    assert.ok(!block.includes('def index'));
  });

  it("splitAtFunctionBoundaries groups decorators with def", () => {
    const chunks = splitAtFunctionBoundaries(PY_SOURCE, py);
    // Find the @app.route('/') + def index() chunk
    const indexChunk = chunks.find(c => c.source.includes('def index'));
    assert.ok(indexChunk, 'should have index chunk');
    assert.ok(indexChunk.source.includes("@app.route('/')"),
      'decorator should be in same chunk as its def');
  });

  it("groups multiple decorators with def", () => {
    const chunks = splitAtFunctionBoundaries(PY_SOURCE, py);
    const usersChunk = chunks.find(c => c.source.includes('def users'));
    assert.ok(usersChunk, 'should have users chunk');
    assert.ok(usersChunk.source.includes('@app.route'), 'first decorator in chunk');
    assert.ok(usersChunk.source.includes('@login_required'), 'second decorator in chunk');
  });

  it("ignores nested def (indented inside class)", () => {
    const chunks = splitAtFunctionBoundaries(PY_SOURCE, py);
    // The class UserController should be one chunk containing both get() and _fetch() methods
    const classChunk = chunks.find(c => c.source.startsWith('class UserController'));
    assert.ok(classChunk, 'class chunk exists');
    assert.ok(classChunk.source.includes('def get'), 'nested method included in class chunk');
    assert.ok(classChunk.source.includes('def _fetch'), 'nested method included in class chunk');
    // And there shouldn't be a separate top-level chunk for the nested methods
    const fetchChunks = chunks.filter(c => c.source.startsWith('    def _fetch'));
    assert.equal(fetchChunks.length, 0);
  });

  it("matches async def", () => {
    const chunks = splitAtFunctionBoundaries(PY_SOURCE, py);
    const asyncChunk = chunks.find(c => c.source.includes('async def fetch_data'));
    assert.ok(asyncChunk, 'async def should create its own chunk');
  });
});

// ── extractExportsOnly — profile-dispatched ─────────────────────────────────

describe('extractExportsOnly', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-exports-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

  it("extracts JS exports", () => {
    const file = path.join(tmpDir, 'mod.js');
    fs.writeFileSync(file, "export const x = 1;\nexport function foo() {}\nconst y = 2;\n");
    const out = extractExportsOnly(file);
    assert.ok(out.includes('export const x'));
    assert.ok(out.includes('export function foo'));
    assert.ok(!out.includes('const y'));
  });

  it("extracts Python def/class/ALL_CAPS", () => {
    const file = path.join(tmpDir, 'mod.py');
    fs.writeFileSync(file, "CONSTANT = 1\ndef foo():\n    pass\nclass Bar:\n    pass\n_private = 2\n");
    const out = extractExportsOnly(file);
    assert.ok(out.includes('CONSTANT'));
    assert.ok(out.includes('def foo'));
    assert.ok(out.includes('class Bar'));
    assert.ok(!out.includes('_private'));
  });

  it("returns unsupported message for unknown extensions", () => {
    const file = path.join(tmpDir, 'mod.xyz');
    fs.writeFileSync(file, "content\n");
    const out = extractExportsOnly(file);
    assert.ok(out.includes('unsupported language'));
  });
});

// ── buildDependencyGraph — profile-dispatched ──────────────────────────────

describe('buildDependencyGraph — JS', () => {
  let tmpDir;
  const prevCwd = process.cwd();
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-graph-'));
    process.chdir(tmpDir);
  });
  afterEach(() => {
    process.chdir(prevCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it("resolves relative ESM imports", () => {
    fs.writeFileSync('a.js', "import { x } from './b.js';\n");
    fs.writeFileSync('b.js', "export const x = 1;\n");
    const graph = buildDependencyGraph(['a.js', 'b.js']);
    const aEdges = [...(graph.get('a.js') || [])];
    assert.ok(aEdges.includes('b.js'), `expected a.js→b.js, got ${aEdges}`);
  });

  it("resolves CommonJS require()", () => {
    fs.writeFileSync('a.js', "const { x } = require('./b.js');\n");
    fs.writeFileSync('b.js', "module.exports.x = 1;\n");
    const graph = buildDependencyGraph(['a.js', 'b.js']);
    const aEdges = [...(graph.get('a.js') || [])];
    assert.ok(aEdges.includes('b.js'));
  });

  it("resolves re-exports", () => {
    fs.writeFileSync('a.js', "export { x } from './b.js';\n");
    fs.writeFileSync('b.js', "export const x = 1;\n");
    const graph = buildDependencyGraph(['a.js', 'b.js']);
    const aEdges = [...(graph.get('a.js') || [])];
    assert.ok(aEdges.includes('b.js'));
  });

  it("skips external packages", () => {
    fs.writeFileSync('a.js', "import fs from 'fs';\nimport x from 'some-package';\n");
    const graph = buildDependencyGraph(['a.js']);
    assert.equal(graph.get('a.js').size, 0);
  });
});

describe('buildDependencyGraph — Python', () => {
  let tmpDir;
  const prevCwd = process.cwd();
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-graph-py-'));
    process.chdir(tmpDir);
  });
  afterEach(() => {
    process.chdir(prevCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it("resolves relative imports (from .x import y)", () => {
    fs.mkdirSync('app', { recursive: true });
    fs.writeFileSync('app/__init__.py', '');
    fs.writeFileSync('app/main.py', "from .utils import helper\n");
    fs.writeFileSync('app/utils.py', "def helper(): pass\n");
    const files = ['app/__init__.py', 'app/main.py', 'app/utils.py'];
    const ctx = buildLanguageContext(files);
    const graph = buildDependencyGraph(files, ctx);
    const edges = [...(graph.get('app/main.py') || [])];
    assert.ok(edges.includes('app/utils.py'), `expected main.py→utils.py, got ${edges}`);
  });

  it("resolves absolute imports with src/ layout", () => {
    fs.mkdirSync('src/app', { recursive: true });
    fs.writeFileSync('src/app/__init__.py', '');
    fs.writeFileSync('src/app/main.py', "from app.services import user\n");
    fs.writeFileSync('src/app/services.py', "def user(): pass\n");
    const files = ['src/app/__init__.py', 'src/app/main.py', 'src/app/services.py'];
    const ctx = buildLanguageContext(files);
    const graph = buildDependencyGraph(files, ctx);
    const edges = [...(graph.get('src/app/main.py') || [])];
    assert.ok(edges.includes('src/app/services.py'),
      `expected absolute resolution via src/ root, got ${edges}`);
  });

  it("resolves bare 'import pkg' to __init__.py", () => {
    fs.mkdirSync('app', { recursive: true });
    fs.writeFileSync('app/__init__.py', '');
    fs.writeFileSync('main.py', "import app\n");
    const files = ['app/__init__.py', 'main.py'];
    const ctx = buildLanguageContext(files);
    const graph = buildDependencyGraph(files, ctx);
    const edges = [...(graph.get('main.py') || [])];
    assert.ok(edges.includes('app/__init__.py'));
  });

  it("skips external imports (requests, os, flask)", () => {
    fs.writeFileSync('a.py', "import os\nimport requests\nfrom flask import Flask\n");
    const ctx = buildLanguageContext(['a.py']);
    const graph = buildDependencyGraph(['a.py'], ctx);
    assert.equal(graph.get('a.py').size, 0);
  });

  it("resolves 'from app.services import user' to submodule file", () => {
    fs.mkdirSync('app/services', { recursive: true });
    fs.writeFileSync('app/__init__.py', '');
    fs.writeFileSync('app/services/__init__.py', '');
    fs.writeFileSync('app/services/user.py', "def get(): pass\n");
    fs.writeFileSync('main.py', "from app.services import user\n");
    const files = ['app/__init__.py', 'app/services/__init__.py', 'app/services/user.py', 'main.py'];
    const ctx = buildLanguageContext(files);
    const graph = buildDependencyGraph(files, ctx);
    const edges = [...(graph.get('main.py') || [])];
    assert.ok(edges.includes('app/services/user.py'),
      `expected submodule resolution, got ${edges}`);
  });
});

describe('buildDependencyGraph — mixed JS+Python', () => {
  let tmpDir;
  const prevCwd = process.cwd();
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-graph-mixed-'));
    process.chdir(tmpDir);
  });
  afterEach(() => {
    process.chdir(prevCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it("each file uses its own profile's resolver", () => {
    fs.mkdirSync('app', { recursive: true });
    fs.writeFileSync('app/__init__.py', '');
    fs.writeFileSync('app/main.py', "from .utils import helper\n");
    fs.writeFileSync('app/utils.py', "def helper(): pass\n");
    fs.writeFileSync('client.js', "import { api } from './api.js';\n");
    fs.writeFileSync('api.js', "export const api = {};\n");
    const files = ['app/__init__.py', 'app/main.py', 'app/utils.py', 'client.js', 'api.js'];
    const ctx = buildLanguageContext(files);
    const graph = buildDependencyGraph(files, ctx);

    const pyEdges = [...(graph.get('app/main.py') || [])];
    assert.ok(pyEdges.includes('app/utils.py'), 'Python resolver should work');

    const jsEdges = [...(graph.get('client.js') || [])];
    assert.ok(jsEdges.includes('api.js'), 'JS resolver should work');
  });

  it("unsupported files are silently skipped (no crash)", () => {
    fs.writeFileSync('data.xml', "<root/>\n");
    fs.writeFileSync('a.js', "import './data.xml';\n");
    const ctx = buildLanguageContext(['data.xml', 'a.js']);
    const graph = buildDependencyGraph(['data.xml', 'a.js'], ctx);
    assert.ok(graph.has('a.js'));
    assert.ok(graph.has('data.xml'));
    // data.xml gets empty edge set (no profile = skip)
    assert.equal(graph.get('data.xml').size, 0);
  });
});

// ── buildAuditUnits — maxFilesPerUnit cap ────────────────────────────────────

/** Write a stub file and return its name. Content size controls token estimate. */
function writeStub(name, byteSize = 400) {
  fs.writeFileSync(name, 'x'.repeat(byteSize));
  return name;
}

describe('buildAuditUnits — maxFilesPerUnit', () => {
  let tmpDir;
  const prevCwd = process.cwd();
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-units-'));
    process.chdir(tmpDir);
  });
  afterEach(() => {
    process.chdir(prevCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('packs all files into one unit when under both caps', () => {
    const files = ['a.js', 'b.js', 'c.js'].map(f => writeStub(f, 400));
    const units = buildAuditUnits(files, 30000, Infinity);
    assert.equal(units.length, 1);
    assert.equal(units[0].files.length, 3);
  });

  it('splits into multiple units when maxFilesPerUnit exceeded', () => {
    const files = ['a.js', 'b.js', 'c.js', 'd.js'].map(f => writeStub(f, 400));
    const units = buildAuditUnits(files, 30000, 2);
    assert.equal(units.length, 2);
    assert.equal(units[0].files.length, 2);
    assert.equal(units[1].files.length, 2);
  });

  it('applies maxFilesPerUnit=4 (frontend default)', () => {
    const files = Array.from({ length: 6 }, (_, i) => writeStub(`f${i}.tsx`, 400));
    const units = buildAuditUnits(files, 30000, 4);
    assert.equal(units.length, 2);
    assert.equal(units[0].files.length, 4);
    assert.equal(units[1].files.length, 2);
  });

  it('still splits on token threshold even when file count is under cap', () => {
    // Two files ~600 tokens each (~2400 bytes) — token limit 1000 forces split
    const files = [writeStub('big1.js', 2400), writeStub('big2.js', 2400)];
    const units = buildAuditUnits(files, 1000, Infinity);
    assert.equal(units.length, 2);
  });

  it('returns empty array for empty input', () => {
    const units = buildAuditUnits([], 30000, 4);
    assert.equal(units.length, 0);
  });
});

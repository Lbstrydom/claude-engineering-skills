import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildLanguageContext } from '../scripts/lib/language-profiles.mjs';
import { buildDependencyGraph, chunkLargeFile } from '../scripts/lib/code-analysis.mjs';
import { populateFindingMetadata } from '../scripts/lib/ledger.mjs';

/**
 * Integration test: Python src/ layout end-to-end.
 *
 * Verifies Phase A's dependency resolution works on a realistic Python
 * package structure (src-layout with absolute imports). This is the
 * fixture-based integration test called out in
 * docs/complete/phase-a-language-aware-analysis.md §2.8.
 */

describe('Phase A integration — Python src/ layout', () => {
  let tmpDir;
  const prevCwd = process.cwd();

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase-a-integ-'));
    process.chdir(tmpDir);

    // Build fixture: src/app/{__init__.py, main.py, services.py, utils.py}
    fs.mkdirSync('src/app', { recursive: true });
    fs.writeFileSync('src/app/__init__.py', '');
    fs.writeFileSync('src/app/services.py',
      "def list_users():\n    return []\n\ndef get_user(id):\n    return None\n"
    );
    fs.writeFileSync('src/app/utils.py',
      "def helper():\n    pass\n"
    );
    fs.writeFileSync('src/app/main.py',
`from flask import Flask
from app.services import list_users, get_user
from .utils import helper

app = Flask(__name__)

@app.route('/')
def index():
    return 'hello'

@app.route('/users')
def users_endpoint():
    return list_users()

@app.route('/users/<id>')
def user_detail(id):
    return get_user(id)
`);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("LanguageContext detects src/ as Python package root", () => {
    const files = ['src/app/__init__.py', 'src/app/main.py', 'src/app/services.py', 'src/app/utils.py'];
    const ctx = buildLanguageContext(files);
    assert.ok(ctx.pythonPackageRoots.includes('src'),
      `expected 'src' in package roots, got ${ctx.pythonPackageRoots.join(',')}`);
    assert.ok(ctx.pythonPackageRoots.includes('.'),
      `expected '.' in package roots, got ${ctx.pythonPackageRoots.join(',')}`);
  });

  it("dependency graph resolves 'from app.services import list_users' via src/ root", () => {
    const files = ['src/app/__init__.py', 'src/app/main.py', 'src/app/services.py', 'src/app/utils.py'];
    const ctx = buildLanguageContext(files);
    const graph = buildDependencyGraph(files, ctx);

    const mainEdges = [...(graph.get('src/app/main.py') || [])];
    assert.ok(mainEdges.includes('src/app/services.py'),
      `expected main.py→services.py (absolute import), got: ${mainEdges.join(', ')}`);
  });

  it("dependency graph resolves relative 'from .utils import helper'", () => {
    const files = ['src/app/__init__.py', 'src/app/main.py', 'src/app/services.py', 'src/app/utils.py'];
    const ctx = buildLanguageContext(files);
    const graph = buildDependencyGraph(files, ctx);

    const mainEdges = [...(graph.get('src/app/main.py') || [])];
    assert.ok(mainEdges.includes('src/app/utils.py'),
      `expected main.py→utils.py (relative import), got: ${mainEdges.join(', ')}`);
  });

  it("dependency graph ignores external package (flask)", () => {
    const files = ['src/app/__init__.py', 'src/app/main.py', 'src/app/services.py', 'src/app/utils.py'];
    const ctx = buildLanguageContext(files);
    const graph = buildDependencyGraph(files, ctx);

    const mainEdges = [...(graph.get('src/app/main.py') || [])];
    // flask should not appear anywhere
    assert.ok(!mainEdges.some(e => e.includes('flask')),
      `external package should not be in graph, got: ${mainEdges.join(', ')}`);
  });

  it("decorator-aware chunking keeps @app.route with def across realistic file", () => {
    const source = fs.readFileSync('src/app/main.py', 'utf-8');
    const chunks = chunkLargeFile(source, 'src/app/main.py', 10000);
    // All 3 route handlers should have their decorator bundled in the same chunk
    const flatChunks = chunks.flatMap(c => c.items);
    const indexItem = flatChunks.find(it => it.source.includes('def index'));
    assert.ok(indexItem, 'def index chunk exists');
    assert.ok(indexItem.source.includes("@app.route('/')"),
      'decorator @app.route(/) should be grouped with def index');

    const usersItem = flatChunks.find(it => it.source.includes('def users_endpoint'));
    assert.ok(usersItem, 'users_endpoint chunk exists');
    assert.ok(usersItem.source.includes("@app.route('/users')"),
      'decorator should be grouped with def users_endpoint');
  });

  it("populateFindingMetadata extracts .py paths from finding text", () => {
    // Simulate an audit finding pointing at a Python file
    const finding = {
      section: 'src/app/services.py:4 missing input validation',
      category: 'defensive validation',
      principle: 'robustness',
    };
    populateFindingMetadata(finding, 'backend');
    assert.equal(finding._primaryFile, 'src/app/services.py',
      `expected .py path extraction, got: ${finding._primaryFile}`);
    assert.ok(finding.affectedFiles.includes('src/app/services.py'),
      'Python file should appear in affectedFiles');
  });

  it("full Python fixture: all edges resolved correctly", () => {
    const files = ['src/app/__init__.py', 'src/app/main.py', 'src/app/services.py', 'src/app/utils.py'];
    const ctx = buildLanguageContext(files);
    const graph = buildDependencyGraph(files, ctx);

    // main.py imports services.py AND utils.py
    const mainEdges = [...(graph.get('src/app/main.py') || [])].sort();
    assert.deepEqual(mainEdges, ['src/app/services.py', 'src/app/utils.py'],
      `expected both services.py + utils.py edges, got: ${mainEdges.join(', ')}`);

    // services.py and utils.py have no internal imports
    assert.equal([...(graph.get('src/app/services.py') || [])].length, 0);
    assert.equal([...(graph.get('src/app/utils.py') || [])].length, 0);
  });
});

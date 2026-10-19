/**
 * @fileoverview Consumer feedback PR 2, report 01a (docs/triage/copilot-feedback-2026-10-19.md): a Python-owned UI
 * (Streamlit and kin) was profiled backend-only, so the frontend and wiring passes were skipped silently. The profile is
 * built from the cwd, so each case runs in a child process inside a throwaway fixture repo.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const CONTEXT = pathToFileURL(path.resolve('scripts/lib/context.mjs')).href;
let root;

function fixture(name, files) {
  const dir = path.join(root, name);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

function profileOf(cwd) {
  const code = `import(${JSON.stringify(CONTEXT)}).then((m) => { const p = m.generateRepoProfile(); `
    + 'process.stdout.write(JSON.stringify({ b: p.fileBreakdown, r: p.passRelevance, s: p.stack, k: p.passSkips })); });';
  const r = spawnSync(process.execPath, ['-e', code], { cwd, encoding: 'utf8', env: { ...process.env, MODEL_CATALOG_REFRESH: 'skip' } });
  assert.equal(r.status, 0, r.stderr);
  return { ...JSON.parse(r.stdout), stderr: r.stderr };
}

describe('repo profile: Python-owned UI', () => {
  before(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'pyui-')); });
  after(() => { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

  it('a Streamlit app counts as frontend, so the frontend and wiring passes run', () => {
    const dir = fixture('streamlit', {
      'app.py': 'import streamlit as st\nst.title("x")\n',
      'pages/p1.py': 'from streamlit import button\nbutton("go")\n',
      'logic/model.py': 'def total(xs):\n    return sum(xs)\n',
    });
    const p = profileOf(dir);
    assert.equal(p.b.frontend, 2, 'the two files that import streamlit own UI');
    assert.equal(p.r.frontend, true);
    assert.equal(p.r.wiring, true);
    assert.equal(p.r.backend, true);
    assert.equal(p.s.frontend.framework, 'streamlit');
    assert.match(p.stderr, /Python UI: streamlit/);
  });

  it('other Python UI frameworks are recognised too', () => {
    for (const mod of ['gradio', 'dash', 'nicegui', 'flet', 'reflex', 'pywebio']) {
      const p = profileOf(fixture(mod, { 'main.py': `import ${mod}\n`, 'util.py': 'x = 1\n' }));
      assert.equal(p.r.frontend, true, mod);
    }
  });

  it('plain Python stays backend-only and names the passes that were not run and why', () => {
    const p = profileOf(fixture('plain', { 'a.py': 'import os\n', 'b.py': 'import json\n' }));
    assert.equal(p.r.frontend, false);
    assert.equal(p.r.wiring, false);
    assert.match(p.k.frontend, /no frontend files/i);
    assert.match(p.k.frontend, /streamlit/, 'the reason lists the recognised Python UI frameworks');
    assert.match(p.stderr, /NOT run.*frontend/s);
  });

  it('a UI file under a frontend/ path is counted once, not twice', () => {
    const p = profileOf(fixture('fe-path', { 'frontend/app.py': 'import streamlit\n' }));
    assert.equal(p.b.frontend, 1);
    assert.equal(p.b.backend, 0, 'it was never a backend file, so it is not added to backend');
    assert.equal(p.r.wiring, false, 'there is no backend file to wire it to');
  });

  it('a multi-module import and production names that contain test or spec are still recognised', () => {
    const p = profileOf(fixture('names', {
      'special_app.py': 'import os, streamlit as st\n',
      'contest/app.py': 'import gradio\n',
      'svc.py': 'x = 1\n',
    }));
    assert.equal(p.b.frontend, 2);
    assert.equal(p.r.wiring, true);
  });

  it('a scan that could not read everything keeps the frontend and wiring passes ON (absence is unproven)', () => {
    const big = '# filler\n'.repeat(40000) + 'import streamlit\n'; // the import sits past the 256 KB read window
    const p = profileOf(fixture('partial', { 'big.py': big, 'svc.py': 'x = 1\n' }));
    assert.equal(p.r.frontend, true);
    assert.equal(p.r.wiring, true);
    assert.match(p.stderr, /Python UI scan INCOMPLETE/);
  });

  it('a mention of a framework in a comment or string is not an import', () => {
    const p = profileOf(fixture('mention', {
      'a.py': '# we used to import streamlit here\nNAME = "import gradio"\nprint("from dash import x")\n',
    }));
    assert.equal(p.r.frontend, false);
  });

  it('test files do not make a repo a UI repo', () => {
    const p = profileOf(fixture('testonly', { 'tests/test_ui.py': 'import streamlit\n', 'svc.py': 'x = 1\n' }));
    assert.equal(p.r.frontend, false);
  });
});

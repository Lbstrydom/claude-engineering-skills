import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectPythonUi, isPythonTestPath, pythonUiFrameworkOf, PYTHON_UI_FRAMEWORKS } from '../scripts/lib/python-ui-detect.mjs';

describe('pythonUiFrameworkOf', () => {
  it('recognises a top-level import of each listed framework', () => {
    for (const fw of PYTHON_UI_FRAMEWORKS) {
      assert.equal(pythonUiFrameworkOf(`import ${fw}\n`), fw);
      assert.equal(pythonUiFrameworkOf(`import os\nfrom ${fw}.sub import x\n`), fw);
      assert.equal(pythonUiFrameworkOf(`    import ${fw} as ui\n`), fw, 'indented (inside try:)');
    }
  });

  it('finds the framework in a multi-module import, a submodule import and an aliased import', () => {
    assert.equal(pythonUiFrameworkOf('import os, streamlit as st\n'), 'streamlit');
    assert.equal(pythonUiFrameworkOf('import os,gradio\n'), 'gradio');
    assert.equal(pythonUiFrameworkOf('import streamlit.web.cli\n'), 'streamlit');
    assert.equal(pythonUiFrameworkOf('from streamlit import (\n  button,\n)\n'), 'streamlit');
  });

  it('does not match a comment, a string, a longer module name or an unrelated import', () => {
    assert.equal(pythonUiFrameworkOf('# import streamlit\n'), null);
    assert.equal(pythonUiFrameworkOf('x = "import gradio"\n'), null);
    assert.equal(pythonUiFrameworkOf('import streamlitx\n'), null);
    assert.equal(pythonUiFrameworkOf('import dashboard\n'), null);
    assert.equal(pythonUiFrameworkOf('import os, sys\nfrom . import dash\n'), null);
    assert.equal(pythonUiFrameworkOf(''), null);
    assert.equal(pythonUiFrameworkOf('DOC = """\nimport streamlit\n"""\nimport os\n'), null, 'inside a triple-quoted string');
    assert.equal(pythonUiFrameworkOf("'''\nfrom gradio import x\n'''\n"), null);
    assert.equal(pythonUiFrameworkOf('"""doc"""\nimport streamlit\n'), 'streamlit', 'an import after a closed docstring still counts');
  });
});

describe('isPythonTestPath', () => {
  it('excludes real test files by directory and file-name convention', () => {
    for (const p of ['tests/test_ui.py', 'pkg/tests/x.py', 'test_app.py', 'app_test.py', 'conftest.py', 'a/Fixtures/b.py', 'spec/c.py']) {
      assert.equal(isPythonTestPath(p), true, p);
    }
  });

  it('keeps production files whose names merely contain test or spec', () => {
    for (const p of ['special_app.py', 'contest/app.py', 'latest/app.py', 'inspector.py', 'pages/inspection/dashboard.py', 'attestation.py']) {
      assert.equal(isPythonTestPath(p), false, p);
    }
  });
});

describe('detectPythonUi', () => {
  const files = { 'a.py': 'import streamlit\n', 'b.py': 'import os\n', 'c.py': 'from gradio import Blocks\n' };
  const read = (rel) => ({ text: files[rel], truncated: false });

  it('returns the owning files and the frameworks found, and says the scan was complete', () => {
    const r = detectPythonUi(Object.keys(files), read);
    assert.deepEqual(r.files, ['a.py', 'c.py']);
    assert.deepEqual(r.frameworks.sort(), ['gradio', 'streamlit']);
    assert.equal(r.complete, true);
    assert.deepEqual(r.incomplete, []);
  });

  it('an unreadable file makes the scan incomplete instead of being skipped silently', () => {
    const r = detectPythonUi(['a.py', 'gone.py'], (rel) => { if (rel === 'gone.py') throw new Error('ENOENT'); return read(rel); });
    assert.deepEqual(r.files, ['a.py']);
    assert.equal(r.complete, false);
    assert.match(r.incomplete.join(), /1 file\(s\) unreadable/);
  });

  it('a partly read file and a capped file list both make it incomplete, with the counts', () => {
    const partial = detectPythonUi(['big.py'], () => ({ text: 'x = 1', truncated: true }));
    assert.equal(partial.complete, false);
    assert.match(partial.incomplete.join(), /read in part/);
    const many = Array.from({ length: 2050 }, (_, i) => `f${i}.py`);
    const capped = detectPythonUi(many, () => ({ text: 'x = 1', truncated: false }));
    assert.equal(capped.scanned, 2000);
    assert.equal(capped.complete, false);
    assert.match(capped.incomplete.join(), /50 of 2050/);
  });
});

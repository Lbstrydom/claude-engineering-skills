/**
 * @fileoverview Which Python files OWN a browser UI. Repo profiling decided "frontend" from path shapes (`public/`, `client/`,
 * `.css`, `.html`) and `package.json`, so a Streamlit app (no such paths, no package.json frameworks) profiled as backend-only
 * and its frontend and wiring passes were skipped without a word (consumer report 01a, 2026-10-18).
 *
 * The signal is the file's own import of a UI framework: direct evidence the file draws the page, where a manifest entry only
 * says the framework is installed. A negative answer is only as good as the scan, so the result says whether the scan was
 * COMPLETE (every candidate read in full); an incomplete scan that found nothing is "unknown", not "absent".
 *
 * @module scripts/lib/python-ui-detect
 */
import fs from 'node:fs';
import path from 'node:path';

/** Python frameworks whose source files ARE the UI. Add one by adding its import name. */
export const PYTHON_UI_FRAMEWORKS = Object.freeze([
  'streamlit', 'gradio', 'dash', 'nicegui', 'panel', 'flet', 'reflex', 'pywebio', 'shiny', 'taipy', 'fasthtml',
]);
const FRAMEWORKS = new Set(PYTHON_UI_FRAMEWORKS);

const MAX_FILES = 2000;
const HEAD_BYTES = 256 * 1024;
const TEST_DIRS = new Set(['test', 'tests', '__tests__', 'spec', 'specs', 'fixture', 'fixtures', 'benchmark', 'benchmarks']);

/**
 * A Python TEST file by directory and file-name convention, not by substring: `special_app.py` and `contest/app.py` are
 * production code. A UI test is not the UI.
 */
export function isPythonTestPath(rel) {
  const parts = String(rel).split(/[\\/]/).filter(Boolean);
  const base = (parts.pop() ?? '').toLowerCase();
  if (parts.some((p) => TEST_DIRS.has(p.toLowerCase()))) return true;
  return base.startsWith('test_') || base.endsWith('_test.py') || base === 'conftest.py';
}

/**
 * The UI framework a Python source text imports, else null. Handles `import a, streamlit as st`, `from streamlit import x` and
 * submodules (`import streamlit.web`), at any indentation; a comment or a string that merely mentions one is not an import.
 * @returns {string|null}
 */
export function pythonUiFrameworkOf(text) {
  // Triple-quoted blocks (docstrings, embedded code samples) are dropped first. This is not a Python parser: an unterminated or
  // exotic literal can still fool it, and the error that leaves is a spurious "UI found", which only turns extra passes ON.
  const code = String(text).replace(/("""|''')[\s\S]*?\1/g, '');
  for (const m of code.matchAll(/^[ \t]*(from|import)[ \t]+([^\n#]+)/gm)) {
    const names = m[1] === 'from'
      ? [m[2].trim().split(/[ \t]/)[0]]
      : m[2].split(',').map((part) => part.trim().split(/[ \t]/)[0]);
    for (const name of names) {
      const root = name.split('.')[0];
      if (FRAMEWORKS.has(root)) return root;
    }
  }
  return null;
}

/**
 * @param {string[]} pyFiles - repo-relative `.py` paths, tests already removed
 * @param {(rel: string) => {text: string, truncated: boolean}} [readHead] - injectable reader (default: the first 256 KB from the cwd)
 * @returns {{files: string[], frameworks: string[], scanned: number, complete: boolean, incomplete: string[]}}
 *   `complete` is false when a file was not scanned, could not be read, or was only partly read
 */
export function detectPythonUi(pyFiles, readHead = defaultRead) {
  const files = [];
  const frameworks = new Set();
  const list = pyFiles.slice(0, MAX_FILES);
  let unreadable = 0;
  let partial = 0;
  for (const rel of list) {
    let head;
    try { head = readHead(rel); } catch { unreadable++; continue; }
    if (head.truncated) partial++;
    const fw = pythonUiFrameworkOf(head.text);
    if (fw) { files.push(rel); frameworks.add(fw); }
  }
  const incomplete = [];
  if (pyFiles.length > MAX_FILES) incomplete.push(`${pyFiles.length - MAX_FILES} of ${pyFiles.length} Python file(s) not scanned (cap ${MAX_FILES})`);
  if (unreadable > 0) incomplete.push(`${unreadable} file(s) unreadable`);
  if (partial > 0) incomplete.push(`${partial} file(s) larger than ${HEAD_BYTES / 1024} KB read in part`);
  return { files, frameworks: [...frameworks], scanned: list.length, complete: incomplete.length === 0, incomplete };
}

function defaultRead(rel) {
  const full = path.resolve(rel);
  const fd = fs.openSync(full, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(Math.min(size, HEAD_BYTES));
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return { text: buf.toString('utf8', 0, n), truncated: size > HEAD_BYTES };
  } finally { fs.closeSync(fd); }
}

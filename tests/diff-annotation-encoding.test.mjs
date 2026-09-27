/**
 * Field report 2026-09-26 (Windows, PowerShell 7): every R2 logged
 * "[diff] Parsed 0 files, 0 hunks" against a visibly non-empty patch. The
 * patch was UTF-8 with CRLF endings — PowerShell's `>` re-encodes native
 * output — and `(.+)$` cannot match `+++ b/x\r`. Windows PowerShell 5.1 writes
 * UTF-16LE with a BOM instead. Both must parse identically to git's own bytes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseDiffFile, parseDiffText, decodeDiffBytes } from '../scripts/lib/diff-annotation.mjs';

// Shape of the field patch: two files, three hunks, a non-ASCII byte in context.
const LF_PATCH = [
  'diff --git a/app/lib/roles.py b/app/lib/roles.py',
  'index 5d9906c..e36182a 100644',
  '--- a/app/lib/roles.py',
  '+++ b/app/lib/roles.py',
  '@@ -10,9 +10,8 @@ from __future__ import annotations',
  ' import streamlit as st',
  '-SALES_LEAD = "Sales Lead"',
  '+from gd_deal_room import SALES_LEAD',
  '@@ -52,6 +51,12 @@ class RoleResolutionError(RuntimeError):',
  '+def _store() -> None:',
  'diff --git a/app/views/1_pipeline_list.py b/app/views/1_pipeline_list.py',
  '--- a/app/views/1_pipeline_list.py',
  '+++ b/app/views/1_pipeline_list.py',
  '@@ -1,6 +1,5 @@',
  ' """Screen 1 — pipeline view."""',
  '-from datetime import datetime',
  '',
].join('\n');

function summarise(map) {
  return [...map.entries()].map(([f, d]) => [f, d.hunks.map((h) => `${h.startLine},${h.lineCount}`)]);
}

const EXPECTED = [
  ['app/lib/roles.py', ['10,8', '51,12']],
  ['app/views/1_pipeline_list.py', ['1,5']],
];

function withPatchFile(bytes, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-enc-'));
  const p = path.join(dir, 'x.patch');
  fs.writeFileSync(p, bytes);
  try { return fn(p); } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
}

test('control: an LF patch parses (the instrument works)', () => {
  assert.deepEqual(summarise(parseDiffText(LF_PATCH)), EXPECTED);
});

test('CRLF text parses identically to LF', () => {
  assert.deepEqual(summarise(parseDiffText(LF_PATCH.replace(/\n/g, '\r\n'))), EXPECTED);
});

test('a UTF-8 BOM does not hide the first header', () => {
  const bomFirstHeader = '﻿' + LF_PATCH.split('\n').slice(3).join('\n');
  assert.equal(parseDiffText(bomFirstHeader).get('app/lib/roles.py')?.hunks.length, 2);
});

test('parseDiffFile: PowerShell 7 shape (UTF-8, CRLF) → same map', () => {
  const map = withPatchFile(Buffer.from(LF_PATCH.replace(/\n/g, '\r\n'), 'utf-8'), parseDiffFile);
  assert.deepEqual(summarise(map), EXPECTED);
});

test('parseDiffFile: Windows PowerShell 5.1 shape (UTF-16LE + BOM, CRLF) → same map', () => {
  const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(LF_PATCH.replace(/\n/g, '\r\n'), 'utf16le')]);
  assert.deepEqual(summarise(withPatchFile(bytes, parseDiffFile)), EXPECTED);
});

test('decodeDiffBytes: UTF-16BE + BOM decodes', () => {
  const le = Buffer.from('diff --git a/x b/x\n', 'utf16le');
  const be = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(le).swap16()]);
  assert.equal(decodeDiffBytes(be), 'diff --git a/x b/x\n');
});

test('a non-empty diff that parses to 0 hunks warns loudly; an empty file does not', () => {
  const writes = [];
  const orig = process.stderr.write;
  process.stderr.write = (s) => { writes.push(String(s)); return true; };
  try {
    // Header present but no `+++ b/` line: unparseable, yet visibly a diff.
    withPatchFile('diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n', parseDiffFile);
    withPatchFile('', parseDiffFile);
  } finally {
    process.stderr.write = orig;
  }
  const warnings = writes.filter((w) => w.includes('parsed to 0 hunks'));
  assert.equal(warnings.length, 1, writes.join(''));
  assert.match(warnings[0], /git diff --output=/);
});

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// readFilesAsAnnotatedContext requires a CWD with files — import after setup
import { readFilesAsAnnotatedContext, isAuditInfraFile, isSensitiveFile, readFilesAsContext } from '../scripts/lib/file-io.mjs';

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a minimal Map<relPath, {hunks}> for readFilesAsAnnotatedContext.
 * hunks: Array<{startLine: number, lineCount: number}>
 */
function makeDiffMap(entries) {
  const m = new Map();
  for (const [relPath, hunks] of entries) m.set(relPath, { hunks });
  return m;
}

// ── readFilesAsAnnotatedContext — code files (block-comment style) ───────────

describe('readFilesAsAnnotatedContext — JS/TS code files (block style)', () => {
  let tmpDir;
  const prevCwd = process.cwd();

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-io-test-'));
    process.chdir(tmpDir);
  });
  afterEach(() => {
    process.chdir(prevCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('returns full file content unchanged when no diff entry', () => {
    fs.writeFileSync('mod.js', 'const x = 1;\nconst y = 2;\n');
    const result = readFilesAsAnnotatedContext(['mod.js'], new Map());
    assert.ok(result.includes('const x = 1;'));
    assert.ok(result.includes('const y = 2;'));
    // No UNCHANGED markers when there is no diff entry
    assert.ok(!result.includes('UNCHANGED'));
  });

  it('wraps unchanged region before a changed hunk', () => {
    const src = 'line1\nline2\nline3\nline4\nline5\n';
    fs.writeFileSync('mod.js', src);
    // Hunk at line 4, 1 line changed
    const diffMap = makeDiffMap([['mod.js', [{ startLine: 4, lineCount: 1 }]]]);
    const result = readFilesAsAnnotatedContext(['mod.js'], diffMap);
    assert.ok(result.includes('UNCHANGED CONTEXT'), 'unchanged region before hunk');
    assert.ok(result.includes('CHANGED'), 'changed marker present');
    assert.ok(result.includes('line4'), 'changed line present');
  });

  it('wraps unchanged region after a changed hunk', () => {
    const src = 'line1\nline2\nline3\nline4\nline5\n';
    fs.writeFileSync('mod.js', src);
    // Hunk at line 1-2, trailing lines 3-5 are unchanged
    const diffMap = makeDiffMap([['mod.js', [{ startLine: 1, lineCount: 2 }]]]);
    const result = readFilesAsAnnotatedContext(['mod.js'], diffMap);
    assert.ok(result.includes('END UNCHANGED CONTEXT'), 'unchanged region after hunk');
    assert.ok(result.includes('line3'), 'trailing unchanged line present');
  });

  it('no UNCHANGED marker when entire file is changed', () => {
    // No trailing newline — avoids empty string artifact from split('\n')
    const src = 'a\nb\nc';
    fs.writeFileSync('mod.ts', src);
    const diffMap = makeDiffMap([['mod.ts', [{ startLine: 1, lineCount: 3 }]]]);
    const result = readFilesAsAnnotatedContext(['mod.ts'], diffMap);
    assert.ok(!result.includes('UNCHANGED CONTEXT'), 'should be no unchanged markers');
    assert.ok(result.includes('// ── CHANGED ──'), 'changed marker present');
  });

  it('annotates a Python file with block style', () => {
    fs.writeFileSync('service.py', 'def foo():\n    pass\ndef bar():\n    pass\n');
    const diffMap = makeDiffMap([['service.py', [{ startLine: 3, lineCount: 2 }]]]);
    const result = readFilesAsAnnotatedContext(['service.py'], diffMap);
    assert.ok(result.includes('UNCHANGED CONTEXT'), 'unchanged region before bar()');
    assert.ok(result.includes('def bar'), 'changed function present');
  });
});

// ── readFilesAsAnnotatedContext — non-code files (header-only style) ─────────

describe('readFilesAsAnnotatedContext — JSON/YAML/Markdown (header-only style)', () => {
  let tmpDir;
  const prevCwd = process.cwd();

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-io-test-'));
    process.chdir(tmpDir);
  });
  afterEach(() => {
    process.chdir(prevCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('injects line numbers into JSON file content', () => {
    fs.writeFileSync('config.json', '{\n  "key": "val"\n}\n');
    const diffMap = makeDiffMap([['config.json', [{ startLine: 2, lineCount: 1 }]]]);
    const result = readFilesAsAnnotatedContext(['config.json'], diffMap);
    // Line numbers should appear in the margin
    assert.ok(/\s*1 \|/.exec(result), 'line 1 margin present');
    assert.ok(/\s*2 \|/.exec(result), 'line 2 margin present');
  });

  it('includes CHANGED — LINES range in block header for JSON', () => {
    fs.writeFileSync('data.json', '{"a":1}\n{"b":2}\n{"c":3}\n');
    const diffMap = makeDiffMap([['data.json', [{ startLine: 2, lineCount: 1 }]]]);
    const result = readFilesAsAnnotatedContext(['data.json'], diffMap);
    assert.ok(result.includes('CHANGED — LINES'), 'changed line range annotation present');
    assert.ok(result.includes('REVIEW ONLY THESE LINES'), 'review instruction present');
  });

  it('includes CHANGED — LINES range for YAML file', () => {
    fs.writeFileSync('config.yaml', 'a: 1\nb: 2\nc: 3\n');
    const diffMap = makeDiffMap([['config.yaml', [{ startLine: 1, lineCount: 1 }]]]);
    const result = readFilesAsAnnotatedContext(['config.yaml'], diffMap);
    assert.ok(result.includes('CHANGED — LINES'), 'range annotation in YAML block header');
  });

  it('includes CHANGED — LINES range for Markdown file', () => {
    // Use lowercase filename — normalizePath() lowercases keys, so diffMap keys must match
    fs.writeFileSync('readme.md', '# Title\n\nParagraph\n');
    const diffMap = makeDiffMap([['readme.md', [{ startLine: 3, lineCount: 1 }]]]);
    const result = readFilesAsAnnotatedContext(['readme.md'], diffMap);
    assert.ok(result.includes('CHANGED — LINES'), 'range annotation in MD block header');
  });

  it('does NOT inject block-comment UNCHANGED markers for JSON', () => {
    fs.writeFileSync('config.json', '{\n  "a": 1,\n  "b": 2\n}\n');
    const diffMap = makeDiffMap([['config.json', [{ startLine: 2, lineCount: 1 }]]]);
    const result = readFilesAsAnnotatedContext(['config.json'], diffMap);
    assert.ok(!result.includes('UNCHANGED CONTEXT'), 'no block-comment markers in JSON');
    assert.ok(!result.includes('/* ━━━━'), 'no block-comment markers in JSON');
  });
});

// ── readFilesAsAnnotatedContext — files with no diff (pass-through) ──────────

describe('readFilesAsAnnotatedContext — unchanged files (no diff entry)', () => {
  let tmpDir;
  const prevCwd = process.cwd();

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-io-test-'));
    process.chdir(tmpDir);
  });
  afterEach(() => {
    process.chdir(prevCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('outputs file verbatim with no annotations when diffMap is empty', () => {
    fs.writeFileSync('mod.js', 'export const x = 1;\n');
    const result = readFilesAsAnnotatedContext(['mod.js'], new Map());
    assert.ok(result.includes('export const x = 1;'));
    assert.ok(!result.includes('CHANGED'));
    assert.ok(!result.includes('UNCHANGED'));
  });

  it('outputs JSON verbatim (no line numbers) when not in diff', () => {
    fs.writeFileSync('config.json', '{"key":"value"}\n');
    const result = readFilesAsAnnotatedContext(['config.json'], new Map());
    assert.ok(result.includes('"key":"value"'));
    assert.ok(!result.includes('| '), 'no line number margins when not in diff');
  });

  it('handles missing file gracefully — omits from output', () => {
    // No file written, just reference it
    const result = readFilesAsAnnotatedContext(['missing.js'], new Map());
    assert.equal(result.trim(), '');
  });
});

// ── Budget / omission handling ────────────────────────────────────────────────

describe('readFilesAsAnnotatedContext — budget limits', () => {
  let tmpDir;
  const prevCwd = process.cwd();

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-io-test-'));
    process.chdir(tmpDir);
  });
  afterEach(() => {
    process.chdir(prevCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('omits files beyond maxTotal budget and reports count', () => {
    fs.writeFileSync('a.js', 'x'.repeat(1000));
    fs.writeFileSync('b.js', 'y'.repeat(1000));
    fs.writeFileSync('c.js', 'z'.repeat(1000));
    // maxTotal just barely fits one file
    const result = readFilesAsAnnotatedContext(['a.js', 'b.js', 'c.js'], new Map(), { maxTotal: 1200 });
    assert.ok(result.includes('omitted'), 'omission notice present');
  });
});

// ── isAuditInfraFile ──────────────────────────────────────────────────────

describe('isAuditInfraFile', () => {
  it('identifies top-level audit scripts', () => {
    assert.ok(isAuditInfraFile('scripts/openai-audit.mjs'));
    assert.ok(isAuditInfraFile('scripts/gemini-review.mjs'));
    assert.ok(isAuditInfraFile('scripts/bandit.mjs'));
    assert.ok(isAuditInfraFile('scripts/learning-store.mjs'));
  });

  it('identifies lib/ audit modules', () => {
    assert.ok(isAuditInfraFile('scripts/lib/schemas.mjs'));
    assert.ok(isAuditInfraFile('scripts/lib/ledger.mjs'));
    assert.ok(isAuditInfraFile('scripts/lib/sanitizer.mjs'));
    assert.ok(isAuditInfraFile('scripts/lib/config.mjs'));
  });

  it('handles backslash paths (Windows)', () => {
    assert.ok(isAuditInfraFile(String.raw`scripts\lib\schemas.mjs`));
    assert.ok(isAuditInfraFile(String.raw`scripts\gemini-review.mjs`));
  });

  it('rejects project files that are NOT audit infra', () => {
    assert.ok(!isAuditInfraFile('scripts/migrate.mjs'));
    assert.ok(!isAuditInfraFile('scripts/seed-db.mjs'));
    assert.ok(!isAuditInfraFile('src/services/audit.mjs'));
    assert.ok(!isAuditInfraFile('src/lib/config.mjs'));
    assert.ok(!isAuditInfraFile('lib/schemas.mjs'));
    // Consumer paths under src/scripts/ must NOT be excluded (M4 fix)
    assert.ok(!isAuditInfraFile('src/scripts/config.mjs'));
    assert.ok(!isAuditInfraFile('app/scripts/lib/schemas.mjs'));
  });

  it('requires scripts/ prefix — bare basenames do not match', () => {
    assert.ok(!isAuditInfraFile('schemas.mjs'));
    assert.ok(!isAuditInfraFile('ledger.mjs'));
  });
});

// ── isSensitiveFile (Phase 1 — full-path matching) ────────────────────────

describe('isSensitiveFile — full path matching', () => {
  it('catches files under sensitive directories', () => {
    assert.ok(isSensitiveFile('config/credentials/prod.json'));
    assert.ok(isSensitiveFile('secrets/db-config.json'));
    // Note: `app/secret-keys/main.yaml` was previously matched via the
    // loose substring rule `/secret/i`. The canonical predicate
    // (sensitive-paths.mjs) anchors on `secrets/` exactly to keep
    // precision high — `src/secret-helper.ts` no longer false-positives.
    // If `secret-keys/` truly carries credentials in a given repo,
    // rename it to `secrets/` to recover the protection.
  });

  it('still catches basename-level matches', () => {
    assert.ok(isSensitiveFile('.env'));
    assert.ok(isSensitiveFile('.env.production'));
    assert.ok(isSensitiveFile('server.pem'));
    assert.ok(isSensitiveFile('id_rsa'));
    assert.ok(isSensitiveFile('id_ed25519'));
    assert.ok(isSensitiveFile('cert.pfx'));
  });

  it('does NOT false-positive on tokenizer or password-strength paths', () => {
    assert.ok(!isSensitiveFile('src/tokenizer/utils.js'));
    assert.ok(!isSensitiveFile('src/password-strength/check.mjs'));
    assert.ok(!isSensitiveFile('lib/detokenize.mjs'));
  });

  it('catches actual token/password files and directories', () => {
    assert.ok(isSensitiveFile('config/tokens/api.json'));
    assert.ok(isSensitiveFile('password.txt'));
    assert.ok(isSensitiveFile('token.json'));
  });

  it('handles Windows backslash paths', () => {
    assert.ok(isSensitiveFile(String.raw`config\credentials\prod.json`));
    assert.ok(isSensitiveFile(String.raw`secrets\db.json`));
  });
});

// ── readFilesAsContext (Phase 1 — safety) ─────────────────────────────────

describe('readFilesAsContext — safety', () => {
  let tmpDir, origCwd;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-safety-'));
    origCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('rejects paths that escape the CWD via ../', () => {
    fs.writeFileSync('legit.js', 'ok');
    const result = readFilesAsContext(['legit.js', '../escape.js']);
    assert.ok(result.includes('legit.js'), 'legit file included');
    assert.ok(result.includes('omitted'), 'escape path omitted');
  });

  it('skips non-existent files without aborting', () => {
    fs.writeFileSync('a.js', 'aaa');
    const result = readFilesAsContext(['a.js', 'ghost.js', 'phantom.js']);
    assert.ok(result.includes('a.js'), 'existing file included');
    assert.ok(result.includes('omitted'), 'missing files omitted');
  });

  it('skips directories in file list', () => {
    fs.mkdirSync('subdir');
    fs.writeFileSync('ok.js', 'content');
    const result = readFilesAsContext(['ok.js', 'subdir']);
    assert.ok(result.includes('ok.js'), 'regular file included');
    assert.ok(result.includes('omitted'), 'directory omitted');
  });

  it('excludes sensitive files by full path', () => {
    fs.mkdirSync('config/credentials', { recursive: true });
    fs.writeFileSync('config/credentials/prod.json', '{"key":"val"}');
    fs.writeFileSync('safe.js', 'ok');
    const result = readFilesAsContext(['safe.js', 'config/credentials/prod.json']);
    assert.ok(result.includes('safe.js'));
    assert.ok(result.includes('sensitive'), 'sensitive file excluded');
    assert.ok(!result.includes('prod.json'));
  });
});

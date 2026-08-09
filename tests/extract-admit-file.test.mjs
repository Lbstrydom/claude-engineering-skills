/**
 * @fileoverview Unit tests for extract.mjs's decomposed per-file admission
 * pipeline (symbol-index-pipeline-reliability-hardening plan, Theme 3):
 * `admitFile`'s four independently-testable reason values (resolution-failed,
 * escaped-repo, sensitive, extension-not-allowlisted — each stubbable via
 * `classify` injection with no real filesystem symlink), plus the size-cap/
 * stat-error/lexical-skip/admitted paths, and `enumerateFiles`'s tri-state
 * `restrictFiles` fix (extract.mjs:560 in the pre-decomposition file).
 *
 * Complements (does not replace) tests/symbol-index-extract-failure-counters.test.mjs,
 * which exercises the same paths end-to-end through extractSymbols() with a
 * real ts-morph parse.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _internals, enumerateFiles } from '../scripts/symbol-index/extract.mjs';

const { admitFile, classifySymbolsInFile, redactAndEmit, MAX_FILE_BYTES, parseArgs } = _internals;

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'extract-admit-'));
}

/** A classify stub that always returns a fully-healthy, admit-ready cls shape. */
function healthyClassify(canonical) {
  return () => ({ category: null, lexical: null, canonical, escapedRepo: false, resolutionFailed: false });
}

describe('admitFile — the four classify-stubbable reason values (no real symlink fixture)', () => {
  it('resolution-failed: a broken/unresolvable symlink refuses admission outright', () => {
    const root = mkTmp();
    try {
      const abs = path.join(root, 'broken-link.mjs');
      fs.writeFileSync(abs, 'export function x() {}\n'); // file must exist for path.relative to make sense; classify is stubbed
      const classify = () => ({ category: 'sensitive', lexical: null, canonical: null, escapedRepo: false, resolutionFailed: true });
      const result = admitFile(abs, { repoRoot: root, classify });
      assert.equal(result.admitted, false);
      assert.equal(result.reason, 'resolution-failed');
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('escaped-repo: a canonical target outside repoRoot refuses admission outright', () => {
    const root = mkTmp();
    try {
      const abs = path.join(root, 'escapee.mjs');
      fs.writeFileSync(abs, 'export function x() {}\n');
      const classify = () => ({ category: 'sensitive', lexical: null, canonical: '/outside/repo/real.mjs', escapedRepo: true, resolutionFailed: false });
      const result = admitFile(abs, { repoRoot: root, classify });
      assert.equal(result.admitted, false);
      assert.equal(result.reason, 'escaped-repo');
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('sensitive: a canonical-sensitive target refuses admission outright', () => {
    const root = mkTmp();
    try {
      const abs = path.join(root, 'notes.mjs');
      fs.writeFileSync(abs, 'export function x() {}\n');
      const classify = () => ({ category: 'sensitive', lexical: null, canonical: path.join(root, 'secrets/real.mjs'), escapedRepo: false, resolutionFailed: false });
      const result = admitFile(abs, { repoRoot: root, classify });
      assert.equal(result.admitted, false);
      assert.equal(result.reason, 'sensitive');
      // action-string derivation (mirrors extractSymbols' caller-side switch):
      // lexical !== 'sensitive' here → 'skip-canonical-sensitive', not 'dropped'.
      assert.equal(result.cls.lexical, null);
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('extension-not-allowlisted: the gate runs on the CANONICAL path, not the raw rel (D4)', () => {
    const root = mkTmp();
    try {
      // Lexically named `.mjs` (would pass an extension check on the RAW
      // path) but its canonical target is a `.json` file — the fixed gate
      // must reject based on the CANONICAL extension.
      const abs = path.join(root, 'looks-like-source.mjs');
      fs.writeFileSync(abs, '{}');
      const canonical = path.join(root, 'real-target.json');
      const classify = healthyClassify(canonical);
      const result = admitFile(abs, { repoRoot: root, classify });
      assert.equal(result.admitted, false);
      assert.equal(result.reason, 'extension-not-allowlisted');
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('the inverse also holds: a lexically-unsafe-looking name whose canonical target IS source is admitted (D4 closes both directions)', () => {
    const root = mkTmp();
    try {
      const abs = path.join(root, 'looks-like-data.json');
      fs.writeFileSync(abs, 'export function x() {}\n');
      const canonical = path.join(root, 'real-target.mjs');
      fs.writeFileSync(canonical, 'export function x() {}\n');
      const classify = healthyClassify(canonical);
      const result = admitFile(abs, { repoRoot: root, classify });
      assert.equal(result.admitted, true, 'canonical .mjs target must be admitted even though the visible name is .json');
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});

describe('admitFile — lexical-skip, size-cap, stat-error, and the happy path', () => {
  it('lexical-skip: a generatedNoise path (package-lock.json) is refused before classify ever runs', () => {
    const root = mkTmp();
    try {
      const abs = path.join(root, 'package-lock.json');
      fs.writeFileSync(abs, '{}');
      let classifyCalled = false;
      const classify = () => { classifyCalled = true; return { category: null, lexical: null, canonical: abs, escapedRepo: false, resolutionFailed: false }; };
      const result = admitFile(abs, { repoRoot: root, classify });
      assert.equal(result.admitted, false);
      assert.equal(result.reason, 'lexical-skip');
      assert.equal(result.lexicalSkip.category, 'generatedNoise');
      assert.equal(classifyCalled, false, 'a lexical-skip must short-circuit before the (more expensive) classify call');
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('size-cap: a file over MAX_FILE_BYTES is refused, using the CANONICAL path stat (not the raw abs)', () => {
    const root = mkTmp();
    try {
      const abs = path.join(root, 'source.mjs');
      fs.writeFileSync(abs, 'small'); // the raw path is tiny...
      const canonical = path.join(root, 'big.mjs');
      fs.writeFileSync(canonical, 'x'.repeat(MAX_FILE_BYTES + 1)); // ...but its canonical target is over the cap
      const classify = healthyClassify(canonical);
      const result = admitFile(abs, { repoRoot: root, classify });
      assert.equal(result.admitted, false);
      assert.equal(result.reason, 'size-cap');
      assert.ok(result.size > MAX_FILE_BYTES);
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('stat-error: a canonical path that cannot be stat-ed is refused, not thrown', () => {
    const root = mkTmp();
    try {
      const abs = path.join(root, 'source.mjs');
      fs.writeFileSync(abs, 'export function x() {}\n');
      const canonical = path.join(root, 'does-not-exist.mjs'); // never written
      const classify = healthyClassify(canonical);
      const result = admitFile(abs, { repoRoot: root, classify });
      assert.equal(result.admitted, false);
      assert.equal(result.reason, 'stat-error');
      assert.ok(result.error instanceof Error);
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('admitted: a clean, allowlisted, under-cap file is admitted with its canonical path + size', () => {
    const root = mkTmp();
    try {
      const abs = path.join(root, 'clean.mjs');
      const body = 'export function ok() { return 1; }\n';
      fs.writeFileSync(abs, body);
      const classify = healthyClassify(abs);
      const result = admitFile(abs, { repoRoot: root, classify });
      assert.equal(result.admitted, true);
      assert.equal(result.canonicalPath, abs);
      assert.equal(result.size, Buffer.byteLength(body));
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});

describe('classifySymbolsInFile + redactAndEmit — pure decomposition parity', () => {
  it('redactAndEmit honours the thin-delegate + includeDelegates flag and updates stats', () => {
    const stats = { symbolCount: 0, skippedDelegate: 0, redacted: 0 };
    // A thin delegate (single-expression arrow calling through) and a real function.
    const candidates = [
      { symbolName: 'delegate', kind: 'function', startLine: 1, endLine: 1, signature: 'const delegate = ArrowFunction', bodyText: 'target.method(...args)', isExported: true },
      { symbolName: 'real', kind: 'function', startLine: 2, endLine: 4, signature: 'function real()', bodyText: 'return doWork();', isExported: true },
    ];
    redactAndEmit(candidates, { rel: 'f.mjs', includeDelegates: false, stats });
    assert.equal(stats.skippedDelegate, 1, 'the thin delegate is skipped by default');
    assert.equal(stats.symbolCount, 1, 'only the real function is emitted');
  });

  it('includeDelegates:true bypasses the thin-delegate filter', () => {
    const stats = { symbolCount: 0, skippedDelegate: 0, redacted: 0 };
    const candidates = [
      { symbolName: 'delegate', kind: 'function', startLine: 1, endLine: 1, signature: 'const delegate = ArrowFunction', bodyText: 'target.method(...args)', isExported: true },
    ];
    redactAndEmit(candidates, { rel: 'f.mjs', includeDelegates: true, stats });
    assert.equal(stats.skippedDelegate, 0);
    assert.equal(stats.symbolCount, 1);
  });
});

describe('enumerateFiles — tri-state restrictFiles contract (extract.mjs:560 fix)', () => {
  it('null → full walk (no restriction)', () => {
    const root = mkTmp();
    try {
      fs.writeFileSync(path.join(root, 'a.mjs'), '');
      fs.writeFileSync(path.join(root, 'b.mjs'), '');
      const files = enumerateFiles(root, null);
      assert.equal(files.length, 2);
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('undefined → full walk (same as null)', () => {
    const root = mkTmp();
    try {
      fs.writeFileSync(path.join(root, 'a.mjs'), '');
      const files = enumerateFiles(root, undefined);
      assert.equal(files.length, 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('a genuinely EMPTY array → zero files, NOT a full walk (the exact bug this fix closes)', () => {
    const root = mkTmp();
    try {
      fs.writeFileSync(path.join(root, 'a.mjs'), '');
      fs.writeFileSync(path.join(root, 'b.mjs'), '');
      const files = enumerateFiles(root, []);
      assert.deepEqual(files, [], 'an empty restriction must extract NOTHING, not silently promote to a full walk');
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('a non-empty array → restricted to exactly those files (relative paths resolved against repoRoot)', () => {
    const root = mkTmp();
    try {
      fs.writeFileSync(path.join(root, 'a.mjs'), '');
      fs.writeFileSync(path.join(root, 'b.mjs'), '');
      const files = enumerateFiles(root, ['a.mjs']);
      assert.deepEqual(files, [path.join(root, 'a.mjs')]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('a non-empty array of absolute paths passes through unchanged', () => {
    const root = mkTmp();
    try {
      const abs = path.join(root, 'a.mjs');
      fs.writeFileSync(abs, '');
      const files = enumerateFiles(root, [abs]);
      assert.deepEqual(files, [abs]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});

describe('parseArgs — flag-value-swallow guard (round-1 L1)', () => {
  const argv = (...rest) => ['node', 'extract.mjs', ...rest];

  it('parses --root/--files/--mode normally', () => {
    const args = parseArgs(argv('--root', '/repo', '--files', 'a.mjs,b.mjs', '--mode', 'incremental'));
    assert.equal(args.root, '/repo');
    assert.deepEqual(args.files, ['a.mjs', 'b.mjs']);
    assert.equal(args.mode, 'incremental');
  });

  it('--files followed immediately by another flag throws instead of silently consuming it (the exact bug)', () => {
    assert.throws(
      () => parseArgs(argv('--files', '--mode', 'incremental')),
      /--files requires a non-empty value/,
    );
  });

  it('--mode at end-of-argv throws', () => {
    assert.throws(() => parseArgs(argv('--mode')), /--mode requires a non-empty value/);
  });

  it('--since-commit is REJECTED — it was accepted and then read by nothing', () => {
    // It used to parse into `args.sinceCommit`, which no code path ever read
    // and no caller ever passed. Silently accepting a flag that does nothing is
    // the accepted-then-ignored bug refresh-args.mjs documents, so it is gone
    // from KNOWN_FLAGS rather than listed inertly. Rejecting tells an operator
    // with muscle memory that the flag has no effect; ignoring it did not.
    assert.throws(
      () => parseArgs(argv('--since-commit', 'abc123')),
      /unknown flag "--since-commit"/,
    );
  });

  it('--root at end-of-argv throws', () => {
    assert.throws(() => parseArgs(argv('--root')), /--root requires a non-empty value/);
  });

  it('the loop index still advances correctly after a guarded flag (no double-consumption / no re-processing)', () => {
    // Regression for the i++ side-effect inside requireFlagValue(argv, i++, ...):
    // a flag AFTER a value-bearing one must still be parsed, proving the outer
    // loop's `i` landed on the right position, not one-off in either direction.
    const args = parseArgs(argv('--mode', 'incremental', '--include-delegates'));
    assert.equal(args.mode, 'incremental');
    assert.equal(args.includeDelegates, true);
  });
});

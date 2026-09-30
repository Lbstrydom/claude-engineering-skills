/**
 * Drift contract for "which files are code" (docs/plans/file-coverage-contract-and-csharp.md §9).
 *
 * The defect (storyline, 2026-09-30): a dozen independent extension lists disagreed with each
 * other, so twelve `.cs` files were silently never audited. Two guards, in this order of authority:
 *
 *   (a) PRIMARY — a behavioural matrix. For every registered GENERIC decision point, run the whole
 *       taxonomy through its real API and assert the answer. This is what fails when a decision point
 *       is reverted to its own hand list.
 *   (b) SECONDARY — a filesystem net. Walk scripts/**\/*.mjs for extension-list shapes
 *       (tests/helpers/extension-list-scan.mjs). Every hit must be in CAPABILITY_BOUND below, with a
 *       reason: those lists MUST stay narrower than the taxonomy because their parser or adapter only
 *       handles those languages. A hit in a file not listed here is a new hand-kept list. This catches
 *       a list that no matrix row names; it does not claim to catch a dynamically assembled one.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  SOURCE_CODE_EXTENSIONS, AUDITABLE_EXTENSIONS, EXTENSION_FENCES, matchFileKind, fenceLanguageFor,
} from '../scripts/lib/file-taxonomy.mjs';
import { buildFileReferenceRegex } from '../scripts/lib/language-profiles.mjs';
import { resolveReferenceExtension } from '../scripts/lib/plan-paths.mjs';
import { classifyPath } from '../scripts/lib/sensitive-paths.mjs';
import { extractPaths } from '../scripts/lib/audit/finding-grounding.mjs';
import { findExtensionLists } from './helpers/extension-list-scan.mjs';

const REPO = path.resolve(import.meta.dirname, '..');

// ── (a) the behavioural matrix ───────────────────────────────────────────────

describe('drift contract (a) — every generic decision point agrees with the taxonomy', () => {
  it('admission: every source and declarative extension is admitted', () => {
    for (const ext of AUDITABLE_EXTENSIONS) {
      assert.notEqual(resolveReferenceExtension(`some/dir/file${ext}`), null, ext);
    }
  });

  it('file references in prose: every auditable extension is recognised as a path', () => {
    for (const ext of AUDITABLE_EXTENSIONS) {
      const re = buildFileReferenceRegex();
      const hit = [...`see src/deep/file${ext} here`.matchAll(re)].map((m) => m[1]);
      assert.ok(hit.some((h) => h.endsWith(`file${ext}`)), `${ext} not recognised: ${JSON.stringify(hit)}`);
    }
  });

  it('finding grounding: a cited path with any auditable (2+ char) extension is extracted', () => {
    for (const ext of AUDITABLE_EXTENSIONS.filter((e) => e.length > 2)) {
      assert.ok(extractPaths(`The file src/lib/thing${ext} lacks a guard.`).some((p) => p.endsWith(`thing${ext}`)), ext);
    }
  });

  it('fence language: every auditable extension gets EXACTLY its taxonomy fence', () => {
    for (const ext of AUDITABLE_EXTENSIONS) {
      assert.equal(fenceLanguageFor(`x${ext}`), EXTENSION_FENCES[ext], ext);
      assert.ok(EXTENSION_FENCES[ext], `${ext} has no fence entry`);
    }
  });

  it('sensitive-path carve-out: a code module named after a credential concept is not sensitive, in any source language', () => {
    for (const ext of SOURCE_CODE_EXTENSIONS) {
      for (const stem of ['token', 'tokens', 'Password']) {
        assert.equal(classifyPath(`src/auth/${stem}${ext}`), null, `${stem}${ext}`);
      }
    }
  });

  it('...while the credential-DATA forms stay sensitive (the carve-out must not swallow them)', () => {
    for (const p of ['token.json', 'tokens.yaml', 'password.txt', 'auth/tokens/x.txt', 'password/hash.cs', 'src/tokens/Foo.cs']) {
      assert.equal(classifyPath(p), 'sensitive', p);
    }
  });

  it('repo profiling counts a source file of ANY taxonomy language as code (child process, real fs)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-profile-'));
    try {
      fs.writeFileSync(path.join(dir, 'Program.cs'), 'class P { }\n');
      fs.writeFileSync(path.join(dir, 'main.go'), 'package main\n');
      const url = pathToFileURL(path.join(REPO, 'scripts/lib/context.mjs')).href;
      const r = spawnSync(process.execPath, ['-e',
        `import(${JSON.stringify(url)}).then((m) => { const p = m.generateRepoProfile(); process.stdout.write(JSON.stringify(p.fileBreakdown)); });`,
      ], { cwd: dir, encoding: 'utf-8', env: { ...process.env, LEARNING_DISABLE: '1', AUDIT_DB_URL: '' }, timeout: 60000 });
      assert.equal(r.status, 0, r.stderr);
      const fb = JSON.parse(r.stdout.slice(r.stdout.lastIndexOf('{')));
      assert.equal(fb.total, 2, `a C# / Go-only repo must profile as code, got ${JSON.stringify(fb)}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});

// ── (b) the filesystem net ───────────────────────────────────────────────────

/**
 * Lists that MUST stay narrower than the taxonomy, each with the reason. `max` is the number of
 * hits the file is allowed to carry (drift-only: growth fails, and so does an unrecorded shrink,
 * so this cannot quietly become a permissive registry).
 */
const CAPABILITY_BOUND = {
  // THE registry itself
  'scripts/lib/file-taxonomy.mjs': { max: 12, reason: 'the registry: language definitions' },
  // parser- / adapter-bound (the parser only understands these languages)
  'scripts/lib/arch-intent/adapter-contract.mjs': { max: 1, reason: 'architecture inventory is adapter-capability-bound (REQ-correctness-067bf187)' },
  'scripts/lib/arch-intent/adapters/python.mjs': { max: 2, reason: 'Python adapter parses .py/.pyi only' },
  'scripts/lib/language-profiles.mjs': { max: 1, reason: 'Python import resolver stub/module suffixes' },
  'scripts/lib/audit/diff-scope-resolver.mjs': { max: 2, reason: 'dependency-cruiser JS/TS graph + outDir remap' },
  'scripts/lib/audit/event-wiring-corpus.mjs': { max: 1, reason: 'JS/TS/HTML listener corpus (Babel)' },
  'scripts/lib/symbol-index/graph-coverage.mjs': { max: 1, reason: 'dependency-cruiser cruisable set' },
  'scripts/lib/sensitive-egress-gate.mjs': { max: 1, reason: 'symbol-extractor egress allowlist (ts-morph handles these only)' },
  'scripts/lib/accepted-debt-check.mjs': { max: 2, reason: 'Babel-parsed JS/TS verifier' },
  'scripts/lib/efficacy-lints.mjs': { max: 3, reason: 'AST-vs-regex gate (Babel) and a comment-syntax table' },
  'scripts/lib/quickfix-patterns.mjs': { max: 6, reason: 'JS/TS-syntax pattern language guards' },
  'scripts/lib/module-graph.mjs': { max: 1, reason: 'Node module-specifier resolution' },
  'scripts/lib/ux-lock/selector-policy.mjs': { max: 1, reason: 'JS import resolution for generated Playwright specs' },
  // tables that are not source-file predicates
  'scripts/lib/config.mjs': { max: 1, reason: 'LANGUAGES bandit-bucket enum (learning context), not a file predicate' },
  'scripts/lib/context.mjs': { max: 1, reason: 'TypeScript stack detection (a .ts file implies typescript)' },
  // repo-internal tooling that scans THIS repo's own files
  'scripts/check-emit-exit-agreement.mjs': { max: 1, reason: 'repo-internal gate over this repo\'s own .mjs/.js sources' },
  'scripts/check-stdout-flush.mjs': { max: 1, reason: 'repo-internal gate over this repo\'s own .mjs/.js sources' },
  'scripts/lib/sync-eol-pins.mjs': { max: 1, reason: 'consumer-sync EOL policy for script files' },
  'scripts/lib/sync-rewriter.mjs': { max: 1, reason: 'sync command rewriter file kinds' },
  'scripts/spikes/observed-graph-discovery-spike.mjs': { max: 1, reason: 'throwaway spike script, not shipped to consumers' },
  // doc / reference path-token recognition (prose, not admission)
  'scripts/lib/backfill-parser.mjs': { max: 1, reason: 'path tokens in backfill prose' },
  'scripts/lib/context-staleness.mjs': { max: 1, reason: 'path tokens in context docs' },
  'scripts/lib/bakeoff/relatedness.mjs': { max: 1, reason: 'path tokens for bake-off relatedness' },
  'scripts/lib/claudemd/ref-checker.mjs': { max: 3, reason: 'AGENTS.md / CLAUDE.md reference checker path tokens' },
};

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.claude-skills') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.mjs')) out.push(p);
  }
  return out;
}

describe('drift contract (b) — the filesystem net', () => {
  const found = {};
  for (const abs of walk(path.join(REPO, 'scripts'))) {
    const rel = path.relative(REPO, abs).split(path.sep).join('/');
    const hits = findExtensionLists(fs.readFileSync(abs, 'utf8'));
    if (hits.length) found[rel] = hits;
  }

  it('no NEW hand-kept extension list: every hit is in the capability-bound registry, within its allowance', () => {
    const unregistered = Object.entries(found)
      .filter(([f, hits]) => !CAPABILITY_BOUND[f] || hits.length > CAPABILITY_BOUND[f].max)
      .map(([f, hits]) => `${f}: ${hits.length} hit(s), allowed ${CAPABILITY_BOUND[f]?.max ?? 0} — ${hits.map((h) => `L${h.line} ${h.exts.join('/')}`).join('; ')}`);
    assert.deepEqual(unregistered, [], 'derive from scripts/lib/file-taxonomy.mjs, or (only if the list is capability-bound) register it here with a reason');
  });

  it('drift-only: an allowance the code no longer needs is reported, so the registry cannot go stale-permissive', () => {
    const stale = Object.entries(CAPABILITY_BOUND)
      .filter(([f, v]) => (found[f]?.length ?? 0) < v.max)
      .map(([f, v]) => `${f}: allows ${v.max}, found ${found[f]?.length ?? 0}`);
    assert.deepEqual(stale, [], 'lower the allowance (or delete the entry) — a shrink is progress and must be recorded');
  });

  it('every registry entry has a real reason and points at a real file', () => {
    for (const [f, v] of Object.entries(CAPABILITY_BOUND)) {
      assert.ok(v.reason.length > 10, f);
      assert.ok(fs.existsSync(path.join(REPO, f)), `${f} does not exist`);
    }
  });

  it('the census is non-vacuous (negative control: the scanner finds the known lists)', () => {
    assert.ok(Object.keys(found).length >= 15, `only ${Object.keys(found).length} files flagged`);
    assert.ok(found['scripts/lib/quickfix-patterns.mjs'], 'a known regex-alternation list was not found');
    assert.ok(found['scripts/lib/sensitive-egress-gate.mjs'], 'a known multi-line collection was not found');
  });
});

describe('drift contract (b) — the scanner detects each shape (negative controls)', () => {
  const flagged = (src) => findExtensionLists(src).length > 0;

  it('a two-item list', () => assert.ok(flagged("const E = ['.cs', '.go'];")));
  it('a bare-word list', () => assert.ok(flagged("const E = new Set(['cs', 'go', 'rs']);")));
  it('a multi-line list with a comment and a trailing comma', () => assert.ok(flagged("const E = [\n  '.ts', // ts\n  '.py',\n];")));
  it('a capturing regex alternation', () => assert.ok(flagged('const R = /\\.(cs|go)$/;')));
  it('a non-capturing regex alternation', () => assert.ok(flagged('const R = /\\.(?:cs|go)$/;')));
  it('an endsWith chain', () => assert.ok(flagged("if (f.endsWith('.cs') || f.endsWith('.go')) x();")));
  it('an extname chain', () => assert.ok(flagged("if (path.extname(f) === '.cs' || path.extname(f) === '.rs') x();")));

  it('does NOT flag a single comparison, a prose comment, or non-source extensions', () => {
    assert.ok(!flagged("if (f.endsWith('.mjs')) x();"), 'one comparison is a filename check');
    assert.ok(!flagged("// the list ['.cs', '.go'] lives elsewhere\nconst x = 1;"), 'comments are prose');
    assert.ok(!flagged("const E = ['.png', '.woff'];"), 'non-source extensions are not a language list');
  });

  it('flags the registry itself when a language is added by hand (the taxonomy is the only place)', () => {
    assert.ok(matchFileKind('a.cs').kind === 'source');
    assert.ok(flagged("const HAND = ['.cs', '.fs'];"));
  });
});

describe('drift contract (b) — comment handling in the scanner (audit-code cluster A R2-M4/M8)', () => {
  it('a trailing comment after code is not scanned as code', () => {
    assert.equal(findExtensionLists("const x = 1; // was ['.cs', '.go']").length, 0);
    assert.equal(findExtensionLists("const x = 1; /* ['.cs', '.go'] */").length, 0);
  });
  it('a // inside a string is NOT a comment, so a real list after it is still found', () => {
    assert.ok(findExtensionLists("const u = 'http://x'; const E = ['.cs', '.go'];").length > 0);
  });
});

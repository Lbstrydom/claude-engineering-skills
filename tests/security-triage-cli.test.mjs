/**
 * Phase 3 — the CLI I/O boundary.
 * Plan: docs/plans/sast-triage-routing.md §7b, §9.
 *
 * This is the layer that enforces every invariant the pure layers only
 * describe: config discovery + validation, exit-code precedence, the bounded
 * read, canonicalization, and post-redaction output.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  runTriage,
  resolveRunStatus,
  resolveRepoRoot,
  loadConfig,
  classifyLocationPath,
  readBoundedLines,
  renderReport,
  EXIT_CODES,
} from '../scripts/security-triage.mjs';
import { ConfigSchema, TriageReportSchema } from '../scripts/lib/security/sarif.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const EXAMPLE_CONFIG = path.join(REPO, '.security-triage.example.json');

const CONFIG = {
  version: 1,
  pathScope: { nonReachableGlobs: ['tests/**'] },
  sinkMismatch: { pairs: [{ ruleId: 'javascript/reDOS', sinkFunction: 'caches.match' }] },
  sanitizerWrapped: { sanitizers: ['esc', 'escapeHtml'] },
};

/** A disposable repo root. Realpath'd — macOS /tmp is a symlink. */
async function makeRepo() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sec-triage-'));
  return fs.realpathSync(dir);
}

function writeFile(root, rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

function sarifDoc(results) {
  return {
    version: '2.1.0',
    runs: [{ tool: { driver: { name: 'TestTool' } }, results }],
  };
}

function resultAt(uri, line, over = {}) {
  const loc = {
    physicalLocation: {
      artifactLocation: { uri, uriBaseId: '%SRCROOT%' },
      region: { startLine: line, endLine: line, startColumn: 1, endColumn: 40 },
    },
  };
  return {
    ruleId: 'javascript/DOMXSS',
    level: 'warning',
    message: { text: 'flows into innerHTML' },
    locations: [loc],
    codeFlows: [{ threadFlows: [{ locations: [{ location: loc }] }] }],
    ...over,
  };
}

/** Run the CLI against a temp repo, returning the validated report. */
async function run(root, { results, config = CONFIG, argvExtra = [], deps = {} } = {}) {
  const sarifPath = path.join(root, 'scan.sarif');
  fs.writeFileSync(sarifPath, JSON.stringify(sarifDoc(results)));
  fs.writeFileSync(path.join(root, '.security-triage.json'), JSON.stringify(config));
  return runTriage(['--sarif', sarifPath, '--repo-root', root, ...argvExtra], deps);
}

// ---------------------------------------------------------------------------

describe('resolveRunStatus — exit-code precedence is TOTAL (D5a)', () => {
  // §9 item 3: a run that is both config-invalid and malformed exits 6.
  test('every adjacent pair in the precedence table resolves to the earlier one', () => {
    const pairs = [
      [{ configInvalid: true, inputUnreadable: true }, 'config_invalid'],
      [{ inputUnreadable: true, inputMalformed: true }, 'input_unreadable'],
      [{ inputMalformed: true, zeroResults: true }, 'input_malformed'],
      [{ zeroResults: true, bucketANonEmpty: true }, 'unverified'],
      [{ bucketANonEmpty: true }, 'needs_review'],
      [{}, 'routed_clean'],
    ];
    for (const [flags, expected] of pairs) {
      assert.equal(resolveRunStatus(flags).runStatus, expected, JSON.stringify(flags));
    }
  });

  test('config_invalid wins over EVERY later state simultaneously', () => {
    const r = resolveRunStatus({
      configInvalid: true, inputUnreadable: true, inputMalformed: true,
      zeroResults: true, bucketANonEmpty: true,
    });
    assert.equal(r.runStatus, 'config_invalid');
    assert.equal(r.exitCode, 6);
  });

  test('exit codes match the plan table exactly', () => {
    assert.deepEqual(EXIT_CODES, {
      config_invalid: 6, input_unreadable: 4, input_malformed: 5,
      unverified: 4, needs_review: 3, routed_clean: 0,
    });
  });
});

describe('config discovery + validation', () => {
  let root;
  before(async () => { root = await makeRepo(); });
  after(async () => { await fsp.rm(root, { recursive: true, force: true }); });

  // No implicit default policy: a silently-defaulted security policy reads as
  // configured when it isn't.
  test('an ABSENT config is config_invalid (exit 6), never a default policy', async () => {
    const sarifPath = writeFile(root, 'scan2.sarif', JSON.stringify(sarifDoc([])));
    const r = await runTriage(['--sarif', sarifPath, '--repo-root', root, '--config', path.join(root, 'nope.json')]);
    assert.equal(r.runStatus, 'config_invalid');
    assert.equal(r.exitCode, 6);
  });

  test('malformed JSON in the config is config_invalid', () => {
    const p = writeFile(root, 'bad.json', '{ not json');
    assert.equal(loadConfig(p).ok, false);
  });

  test('an unknown key is config_invalid — a typo must never silently disable a predicate', () => {
    const p = writeFile(root, 'typo.json', JSON.stringify({ ...CONFIG, pathScoope: {} }));
    const res = loadConfig(p);
    assert.equal(res.ok, false);
    assert.match(res.error, /validation/);
  });

  test('a bound above its hard ceiling is config_invalid, not a clamp', () => {
    const p = writeFile(root, 'over.json', JSON.stringify({ ...CONFIG, bounds: { maxResults: 999_999_999 } }));
    assert.equal(loadConfig(p).ok, false);
  });

  test('the config defaults to .security-triage.json at repoRoot', async () => {
    const r = await run(root, { results: [resultAt('src/a.js', 1)] });
    assert.notEqual(r.runStatus, 'config_invalid');
  });

  // A shipped example that fails its own schema is a classic rot.
  test('the committed .security-triage.example.json validates against ConfigSchema', () => {
    const parsed = ConfigSchema.safeParse(JSON.parse(fs.readFileSync(EXAMPLE_CONFIG, 'utf8')));
    assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues?.slice(0, 3)));
  });
});

describe('input handling', () => {
  let root;
  before(async () => { root = await makeRepo(); });
  after(async () => { await fsp.rm(root, { recursive: true, force: true }); });

  test('a missing SARIF is input_unreadable (exit 4)', async () => {
    fs.writeFileSync(path.join(root, '.security-triage.json'), JSON.stringify(CONFIG));
    const r = await runTriage(['--sarif', path.join(root, 'absent.sarif'), '--repo-root', root]);
    assert.equal(r.runStatus, 'input_unreadable');
    assert.equal(r.exitCode, 4);
  });

  test('non-JSON content is input_malformed (exit 5)', async () => {
    const p = writeFile(root, 'bad.sarif', 'not json at all');
    const r = await runTriage(['--sarif', p, '--repo-root', root]);
    assert.equal(r.runStatus, 'input_malformed');
    assert.equal(r.exitCode, 5);
  });

  test('a non-2.1.0 SARIF is input_malformed', async () => {
    const p = writeFile(root, 'v2.sarif', JSON.stringify({ version: '2.0.0', runs: [] }));
    const r = await runTriage(['--sarif', p, '--repo-root', root]);
    assert.equal(r.runStatus, 'input_malformed');
  });

  // The bound is enforced by `stat` BEFORE the read, so an oversized file is
  // never allocated.
  test('a SARIF above maxSarifBytes is input_unreadable and is never read', async () => {
    const p = writeFile(root, 'big.sarif', JSON.stringify(sarifDoc([resultAt('src/a.js', 1)])));
    fs.writeFileSync(path.join(root, '.security-triage.json'),
      JSON.stringify({ ...CONFIG, bounds: { maxSarifBytes: 10 } }));
    // Spy on the SARIF path specifically — the config is legitimately read.
    let sarifRead = false;
    const r = await runTriage(['--sarif', p, '--repo-root', root], {
      readFileSync: (target, ...rest) => {
        if (String(target) === p) sarifRead = true;
        return fs.readFileSync(target, ...rest);
      },
    });
    assert.equal(r.runStatus, 'input_unreadable');
    assert.equal(sarifRead, false, 'the oversized SARIF must never be read');
  });
});

describe('canonicalization (SC1) + the bounded read', () => {
  let root;
  before(async () => { root = await makeRepo(); });
  after(async () => { await fsp.rm(root, { recursive: true, force: true }); });

  // Gemini G3 — without the absolute→relative conversion, `tests/**` matches
  // nothing and path-scope becomes a no-op that reads as configured.
  test('classifyLocationPath returns a REPO-RELATIVE path, not the absolute realpath', () => {
    writeFile(root, 'tests/x.js', 'x();');
    const c = classifyLocationPath('tests/x.js', root);
    assert.equal(c.pathClassification, 'ok');
    assert.equal(c.repoRelativePath, 'tests/x.js');
    assert.ok(path.isAbsolute(c.canonicalPath));
  });

  test('a nonexistent path fails closed as unresolved', () => {
    assert.equal(classifyLocationPath('src/ghost.js', root).pathClassification, 'unresolved');
  });

  test('a sensitive path classifies as sensitive', () => {
    writeFile(root, '.env', 'SECRET=x');
    assert.equal(classifyLocationPath('.env', root).pathClassification, 'sensitive');
  });

  test('readBoundedLines refuses to OPEN a file above the byte bound', async () => {
    const p = writeFile(root, 'big.js', 'x'.repeat(5000));
    const res = await readBoundedLines(p, 10, 100);
    assert.equal(res.lines, null);
    assert.equal(res.withheld, 'too-large');
  });

  test('readBoundedLines stops at the last line needed, not EOF', async () => {
    const p = writeFile(root, 'long.js', Array.from({ length: 5000 }, (_, i) => `line${i}`).join('\n'));
    const res = await readBoundedLines(p, 5, 10 * 1024 * 1024);
    assert.equal(res.lines.length, 5);
    assert.equal(res.lines[0], 'line0');
  });

  test('readBoundedLines reports an unreadable file rather than throwing', async () => {
    const res = await readBoundedLines(path.join(root, 'nope.js'), 5, 1024);
    assert.equal(res.lines, null);
    assert.equal(res.withheld, 'unreadable');
  });
});

describe('end-to-end routing through the CLI', () => {
  let root;
  before(async () => { root = await makeRepo(); });
  after(async () => { await fsp.rm(root, { recursive: true, force: true }); });

  test('a sanitized template routes to C and the run needs review only if A is non-empty', async () => {
    writeFile(root, 'src/view.js', 'el.innerHTML = `<b>${esc(a)}</b>`;');
    const r = await run(root, { results: [resultAt('src/view.js', 1)] });
    assert.equal(r.counts.C, 1);
    assert.equal(r.counts.A, 0);
    assert.equal(r.runStatus, 'routed_clean');
    assert.equal(r.exitCode, 0);
  });

  test('an unsanitized sink stays in A and the run is needs_review (exit 3)', async () => {
    writeFile(root, 'src/raw.js', 'el.innerHTML = `<b>${r.reason}</b>`;');
    const r = await run(root, { results: [resultAt('src/raw.js', 1)] });
    assert.equal(r.counts.A, 1);
    assert.equal(r.runStatus, 'needs_review');
    assert.equal(r.exitCode, 3);
  });

  test('both signals agreeing demotes to D', async () => {
    writeFile(root, 'tests/spec.js', 'const token = "abc";');
    const r = await run(root, {
      results: [resultAt('tests/spec.js', 1, { ruleId: 'javascript/PT/test' })],
    });
    assert.equal(r.counts.D, 1);
  });

  test('the emitted report satisfies TriageReportSchema', async () => {
    writeFile(root, 'src/view2.js', 'el.innerHTML = `<b>${esc(a)}</b>`;');
    const r = await run(root, { results: [resultAt('src/view2.js', 1), resultAt('src/raw.js', 1)] });
    const parsed = TriageReportSchema.safeParse(r);
    assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues?.slice(0, 3)));
  });

  // SC2: sourceContext is redacted at the boundary where it first exists.
  test('sourceContext reaching the report is redacted', async () => {
    const secret = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
    writeFile(root, 'src/leak.js', `const t = "${secret}";`);
    const r = await run(root, { results: [resultAt('src/leak.js', 1)] });
    assert.ok(!JSON.stringify(r).includes(secret), 'secret must not survive into the report');
  });

  test('the renderer never prints an unused predicate as good news', async () => {
    writeFile(root, 'src/plain.js', 'doThing();');
    const r = await run(root, { results: [resultAt('src/plain.js', 1)] });
    const out = renderReport(r);
    assert.ok(r.unusedPredicates.length > 0, 'precondition: some predicate matched nothing');
    assert.match(out, /ambiguous, not clean/);
    assert.match(out, /either no such findings exist, or this predicate is broken/);
  });
});

describe('resolveRepoRoot', () => {
  test('an explicit root is canonicalized, so repo-relative paths resolve', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sec-root-'));
    const res = resolveRepoRoot(dir);
    assert.equal(res.ok, true);
    assert.equal(res.repoRoot, fs.realpathSync(dir));
    await fsp.rm(dir, { recursive: true, force: true });
  });

  // Guessing cwd would silently relocate the entire policy.
  test('a non-git cwd with no --repo-root is refused, not defaulted', () => {
    const res = resolveRepoRoot(null, {
      execFileSync: () => { throw new Error('not a git repo'); },
    });
    assert.equal(res.ok, false);
    assert.match(res.error, /--repo-root/);
  });
});

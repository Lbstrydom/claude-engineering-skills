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
import { writeFile } from './helpers/fixtures.mjs';

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

  // A pre-open stat is a TOCTOU window — the file can grow between the check
  // and the open. The during-read cap is the half that cannot be raced.
  test('the byte bound is enforced DURING the read, not only by the pre-open stat', async () => {
    // ~10 KB of real content, but stat reports 1 byte — the shape of a file
    // that grew (or was swapped) between the check and the open.
    const p = writeFile(root, 'grows.js', Array.from({ length: 200 }, () => 'x'.repeat(50)).join('\n'));
    const res = await readBoundedLines(p, 1000, 1_000, {
      fstat: async () => ({ size: 1, isFile: () => true }),
    });
    assert.equal(res.lines, null, 'the read must abort once the real bytes exceed the bound');
    assert.equal(res.withheld, 'too-large');
  });

  test('a non-regular file is refused rather than streamed', async () => {
    const res = await readBoundedLines(root, 10, 10_000_000);
    assert.equal(res.lines, null);
    assert.equal(res.withheld, 'unreadable');
  });

  /**
   * A single enormous line with no newline emits no `line` event until EOF, so
   * a line-event byte counter reports `too-large` only AFTER the whole thing
   * has been buffered. The verdict is therefore not the interesting part — the
   * ALLOCATION is. This asserts on bytes actually pulled off the stream, which
   * is what the read-range cap bounds; asserting the verdict alone passes with
   * the cap removed, so it would not have caught its own regression.
   */
  test('a single enormous line with no newline is bounded in BYTES READ, not just verdict', async () => {
    const p = writeFile(root, 'oneline.js', 'x'.repeat(500_000));
    let bytesRead = 0;
    const res = await readBoundedLines(p, 10, 1_000, {
      fstat: async () => ({ size: 1, isFile: () => true }), // under-report: simulate a race
      createReadStream: (target, opts) => {
        const s = fs.createReadStream(target, opts);
        s.on('data', (c) => { bytesRead += Buffer.byteLength(c, 'utf8'); });
        return s;
      },
    });
    assert.equal(res.withheld, 'too-large');
    assert.equal(res.lines, null, 'must not hand back a truncated window');
    assert.ok(
      bytesRead <= 2_000,
      `read must stay near the 1000-byte bound; actually read ${bytesRead} bytes`,
    );
  });

  test('a file that fits the bound still reads normally', async () => {
    const p = writeFile(root, 'small.js', 'a\nb\nc');
    const res = await readBoundedLines(p, 10, 1_000_000);
    assert.deepEqual(res.lines, ['a', 'b', 'c']);
    assert.equal(res.withheld, null);
  });

  /**
   * Classification and read are two claims about two possibly-different
   * objects: O_NOFOLLOW stops a symlink at the final component, but a path
   * swapped for a different REGULAR file passes it silently. The dev+ino
   * comparison is what turns that swap from effective into refused.
   */
  test('a file whose identity differs from the classified object is refused', async () => {
    const p = writeFile(root, 'swapped.js', 'a\nb');
    // BigInt: a Windows inode exceeds Number.MAX_SAFE_INTEGER, so `+ 1` on a
    // float is a no-op and the "wrong" value would silently equal the right one.
    const real = fs.statSync(p, { bigint: true });
    const wrong = { dev: real.dev, ino: real.ino + 1n };
    assert.notEqual(String(wrong.ino), String(real.ino), 'sanity: the wrong ino really differs');
    const res = await readBoundedLines(p, 10, 1_000_000, {}, wrong);
    assert.equal(res.lines, null, 'a swapped object must not be read');
    assert.equal(res.withheld, 'unreadable');
  });

  test('a matching identity reads normally', async () => {
    const p = writeFile(root, 'stable.js', 'a\nb');
    const real = fs.statSync(p, { bigint: true });
    const res = await readBoundedLines(p, 10, 1_000_000, {}, { dev: real.dev, ino: real.ino });
    assert.deepEqual(res.lines, ['a', 'b']);
  });

  test('classifyLocationPath records the identity of what it classified', () => {
    const p = writeFile(root, 'ident.js', 'x');
    const c = classifyLocationPath('ident.js', root);
    const st = fs.statSync(p, { bigint: true });
    assert.equal(String(c.identity.ino), String(st.ino));
    assert.equal(String(c.identity.dev), String(st.dev));
  });

  // The region comes from the SARIF, so it is attacker-influenced.
  test('sourceContext is clamped to maxSinkLines even when the region is larger', async () => {
    const root2 = await makeRepo();
    try {
      writeFile(root2, 'src/big.js', Array.from({ length: 200 }, (_, i) => `line${i}`).join('\n'));
      const wide = resultAt('src/big.js', 1);
      wide.locations[0].physicalLocation.region = { startLine: 1, endLine: 150, startColumn: 1, endColumn: 5 };
      wide.codeFlows[0].threadFlows[0].locations[0].location = wide.locations[0];
      const r = await run(root2, { results: [wide], config: { ...CONFIG, bounds: { maxSinkLines: 5 } } });
      const ctx = r.findings[0].sourceContext;
      assert.ok(ctx != null, 'context should be present');
      assert.ok(ctx.split('\n').length <= 5, `expected ≤5 lines, got ${ctx.split('\n').length}`);
    } finally {
      await fsp.rm(root2, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
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

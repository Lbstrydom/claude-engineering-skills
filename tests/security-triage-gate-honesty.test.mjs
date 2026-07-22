/**
 * Gate honesty — the never-green invariants (D5a, SC1, SC2, D1).
 * Plan: docs/plans/sast-triage-routing.md §9.
 *
 * Tier 3 (HARD test-first). These exist to answer one question about every
 * success path: *can this return green without having actually checked
 * anything?* Auditing the success paths is the point — a clean verdict is
 * where a broken detector hides, because a detector that stopped looking and a
 * detector that found nothing are indistinguishable from the outside.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runTriage, resolveRunStatus, EXIT_CODES, classifyLocationPath } from '../scripts/security-triage.mjs';
import { ingestSarif, BUCKETS, BOUND_DEFAULTS } from '../scripts/lib/security/sarif.mjs';
import { routeFindings } from '../scripts/lib/security/triage-router.mjs';
import { writeFile } from './helpers/fixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORPUS = path.join(HERE, 'fixtures', 'security-triage', 'corpus.sarif');
const MANIFEST = path.join(HERE, 'fixtures', 'security-triage', 'corpus.expected.json');

const CONFIG = {
  version: 1,
  pathScope: { nonReachableGlobs: ['tests/**'] },
  sinkMismatch: { pairs: [] },
  sanitizerWrapped: { sanitizers: ['esc', 'escapeHtml'] },
};

async function makeRepo() {
  return fs.realpathSync(await fsp.mkdtemp(path.join(os.tmpdir(), 'sec-gate-')));
}

function sarifDoc(results) {
  return { version: '2.1.0', runs: [{ tool: { driver: { name: 'T' } }, results }] };
}

function resultAt(uri, line = 1, over = {}) {
  const loc = {
    physicalLocation: {
      artifactLocation: { uri, uriBaseId: '%SRCROOT%' },
      region: { startLine: line, endLine: line, startColumn: 1, endColumn: 20 },
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

async function run(root, results, config = CONFIG, deps = {}) {
  const p = path.join(root, 'scan.sarif');
  fs.writeFileSync(p, JSON.stringify(sarifDoc(results)));
  fs.writeFileSync(path.join(root, '.security-triage.json'), JSON.stringify(config));
  return runTriage(['--sarif', p, '--repo-root', root], deps);
}

// ---------------------------------------------------------------------------

describe('exit 0 is unreachable from an empty, failed, or unparsed input', () => {
  let root;
  before(async () => { root = await makeRepo(); });
  after(async () => { await fsp.rm(root, { recursive: true, force: true }); });

  // §9 item 2. A real scan finds SOMETHING to say; zero results are
  // indistinguishable from a scanner that never ran, so this must never be 0.
  test('a valid SARIF with ZERO results is unverified (exit 4), never routed_clean', async () => {
    const r = await run(root, []);
    assert.equal(r.runStatus, 'unverified');
    assert.equal(r.exitCode, 4);
    assert.notEqual(r.exitCode, 0);
  });

  test('an empty runs array is also unverified, not clean', async () => {
    const p = path.join(root, 'empty.sarif');
    fs.writeFileSync(p, JSON.stringify({ version: '2.1.0', runs: [] }));
    fs.writeFileSync(path.join(root, '.security-triage.json'), JSON.stringify(CONFIG));
    const r = await runTriage(['--sarif', p, '--repo-root', root]);
    assert.equal(r.exitCode, 4);
  });

  /**
   * The exhaustive form: enumerate every reachable status and assert that the
   * ONLY one carrying exit 0 is `routed_clean`, and that `routed_clean` is
   * only reachable when findings were actually parsed AND bucket A is empty.
   */
  test('routed_clean is the ONLY zero-exit state, and it requires a parsed non-empty run', () => {
    const zeroStates = Object.entries(EXIT_CODES).filter(([, code]) => code === 0);
    assert.deepEqual(zeroStates.map(([s]) => s), ['routed_clean']);

    for (const flag of ['configInvalid', 'inputUnreadable', 'inputMalformed', 'zeroResults', 'bucketANonEmpty']) {
      const r = resolveRunStatus({ [flag]: true });
      assert.notEqual(r.exitCode, 0, `${flag} must never exit 0`);
    }
    assert.equal(resolveRunStatus({}).exitCode, 0);
  });

  test('a config failure cannot produce a clean run even with a perfect SARIF', async () => {
    writeFile(root, 'src/ok.js', 'el.innerHTML = `<b>${esc(a)}</b>`;');
    const p = path.join(root, 'good.sarif');
    fs.writeFileSync(p, JSON.stringify(sarifDoc([resultAt('src/ok.js')])));
    const r = await runTriage(['--sarif', p, '--repo-root', root, '--config', path.join(root, 'missing.json')]);
    assert.equal(r.runStatus, 'config_invalid');
    assert.equal(r.exitCode, 6);
    assert.deepEqual(r.counts, { A: 0, C: 0, D: 0 });
  });

  // §9 item 9 — refusing is the only outcome consistent with BOTH the
  // every-finding-appears-once contract and the bound meaning anything.
  test('maxResults exceeded REFUSES the run: exit 4, zero counts, no partial prefix', async () => {
    const r = await run(root, [resultAt('src/a.js'), resultAt('src/b.js'), resultAt('src/c.js')],
      { ...CONFIG, bounds: { maxResults: 2 } });
    assert.equal(r.exitCode, 4);
    assert.deepEqual(r.counts, { A: 0, C: 0, D: 0 });
    assert.deepEqual(r.findings, [], 'never a truncated prefix');
  });
});

describe('SC1 / INC-001 — canonicalization before any path decision', () => {
  let root;
  before(async () => { root = await makeRepo(); });
  after(async () => { await fsp.rm(root, { recursive: true, force: true }); });

  /**
   * §9 item 4. A symlink whose visible name matches a non-reachable glob but
   * whose target escapes repoRoot must land in `A`, not `D`. Skipped — never
   * silently passed — where the platform denies symlink creation.
   */
  test('a symlink escaping repoRoot routes to A, not D', async (t) => {
    const outside = await makeRepo();
    fs.writeFileSync(path.join(outside, 'real.js'), 'el.innerHTML = x;');
    fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
    const link = path.join(root, 'tests', 'mock.js');
    try {
      fs.symlinkSync(path.join(outside, 'real.js'), link, 'file');
    } catch {
      t.skip('platform denies symlink creation — NOT silently passed');
      await fsp.rm(outside, { recursive: true, force: true });
      return;
    }
    const r = await run(root, [resultAt('tests/mock.js', 1, { ruleId: 'javascript/PT/test' })]);
    assert.equal(r.counts.D, 0, 'an escaped symlink must never reach the bottom bucket');
    assert.equal(r.counts.A, 1);
    await fsp.rm(outside, { recursive: true, force: true });
  });

  test('an unresolvable path fails closed to A rather than being guessed', async () => {
    const r = await run(root, [resultAt('src/ghost.js', 1, { ruleId: 'javascript/PT/test' })]);
    assert.equal(r.counts.A, 1);
    assert.equal(r.counts.D, 0);
  });

  // §9 item 6 — SC1 depends on the URI resolving honestly, never to a guess.
  test('an unresolvable SARIF URI routes to A with a diagnostic', async () => {
    const bad = {
      ruleId: 'javascript/DOMXSS', level: 'warning', message: { text: 'x' },
      locations: [{ physicalLocation: { artifactLocation: { uri: 'https://evil/x.js' } } }],
    };
    const r = await run(root, [bad]);
    assert.equal(r.counts.A, 1);
    assert.ok(r.findings[0].diagnostics.some((d) => d.startsWith('uri-unsupported-scheme')));
  });
});

describe('SC2 — a sensitive path is never OPENED', () => {
  let root;
  before(async () => { root = await makeRepo(); });
  after(async () => { await fsp.rm(root, { recursive: true, force: true }); });

  /**
   * §9 item 5. Asserting the classifier was *called* is not the same as
   * asserting the file was not read — so this spies on the read adapter and
   * requires the sensitive path to be absent from what was opened.
   */
  test('no read is attempted for a finding located in a credential file', async () => {
    writeFile(root, '.env', 'API_KEY=sk-live-not-a-real-key-000');
    const opened = [];
    const r = await run(root, [resultAt('.env', 1)], CONFIG, {
      stat: async (p) => { opened.push(String(p)); return fsp.stat(p); },
      createReadStream: (p, o) => { opened.push(String(p)); return fs.createReadStream(p, o); },
    });
    assert.equal(r.counts.A, 1, 'a sensitive finding must be reviewed by a human');
    assert.ok(
      !opened.some((p) => p.endsWith('.env')),
      `.env must never be opened; opened=${JSON.stringify(opened)}`,
    );
  });

  // Gemini G1 — the security-invariant bypass, asserted end-to-end rather
  // than implied by the classifier having been called.
  test('a sensitive path matching a nonReachableGlobs entry still lands in A', async () => {
    writeFile(root, 'tests/.env', 'SECRET=x');
    const r = await run(root, [resultAt('tests/.env', 1, { ruleId: 'javascript/PT/test' })]);
    assert.equal(r.counts.A, 1);
    assert.equal(r.counts.D, 0, 'the glob must NOT be able to demote a credential file');
  });

  test('a withheld-context finding is marked, not silently context-free', async () => {
    writeFile(root, 'tests/.env', 'SECRET=x');
    const r = await run(root, [resultAt('tests/.env', 1)]);
    assert.equal(r.findings[0].contextWithheld, 'sensitive');
  });
});

describe('D1 — every ingested finding appears in exactly one bucket', () => {
  const opts = { timeout: 60_000 };

  /**
   * §9 item 1, on the real 240-result corpus. The corpus names files that do
   * not exist here, so every path fails closed and the whole corpus lands in
   * `A` — which is exactly the assertion worth making: the conservative path
   * still routes every finding, loses none, and duplicates none.
   */
  test('all 240 corpus findings route, exactly once each', opts, () => {
    const doc = JSON.parse(fs.readFileSync(CORPUS, 'utf8'));
    const { findings } = ingestSarif(doc);
    assert.equal(findings.length, 240);

    const routable = findings.map((f) => ({
      ...f,
      location: f.location && {
        ...f.location, canonicalPath: `/x/${f.location.path}`,
        repoRelativePath: f.location.path, pathClassification: 'ok',
      },
      sinkLocation: f.sinkLocation && {
        ...f.sinkLocation, canonicalPath: `/x/${f.sinkLocation.path}`,
        repoRelativePath: f.sinkLocation.path, pathClassification: 'ok',
      },
    }));

    const r = routeFindings(routable, CONFIG, { bounds: BOUND_DEFAULTS, getSource: () => null });

    assert.equal(r.findings.length, 240, 'no finding is dropped');
    assert.equal(r.counts.A + r.counts.C + r.counts.D, 240, 'counts sum to the input length');
    assert.equal(new Set(r.findings.map((f) => f.findingId)).size, 240, 'no finding is conflated');
    // §9 item 10 — the unreachable-bucket removal stays removed.
    for (const f of r.findings) assert.ok(BUCKETS.includes(f.bucket), f.bucket);
  });

  /**
   * The routing manifest (plan §8). Its whole purpose is to make a routing
   * change show up as a reviewable line, so this compares the SHIPPED router's
   * output against the committed expectation finding-by-finding. If this fails,
   * read the diff and decide whether the new routing is right — do not
   * regenerate the manifest to make it pass.
   */
  test('the corpus routes exactly as the committed manifest says', opts, () => {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    const doc = JSON.parse(fs.readFileSync(CORPUS, 'utf8'));
    const { findings } = ingestSarif(doc);

    // Same stub-tree treatment the manifest was generated under: paths exist,
    // so canonicalization succeeds; files are empty, so no source is read.
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-check-')));
    try {
      for (const f of findings) {
        for (const loc of [f.location, f.sinkLocation]) {
          if (!loc) continue;
          const abs = path.join(root, loc.path);
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          if (!fs.existsSync(abs)) fs.writeFileSync(abs, '');
        }
      }
      const routable = findings.map((f) => {
        const out = { ...f };
        for (const key of ['location', 'sinkLocation']) {
          if (!f[key]) continue;
          // `identity` is adapter-internal read plumbing; the strict routable
          // schema rejects it, exactly as it does in the real CLI path.
          const { identity, ...locFields } = classifyLocationPath(f[key].path, root);
          out[key] = { ...f[key], ...locFields };
        }
        return out;
      });
      const routed = routeFindings(routable, manifest.config, {
        bounds: BOUND_DEFAULTS,
        getSource: () => null,
      });

      assert.deepEqual(routed.counts, manifest.counts, 'bucket counts drifted');
      assert.equal(routed.findings.length, manifest.totalFindings);

      const actual = routed.findings.map((f) => ({
        findingId: f.findingId,
        bucket: f.bucket,
        reasons: f.matches.filter((m) => m.reason !== 'no-match').map((m) => m.reason),
      }));
      const expected = manifest.findings.map((f) => ({
        findingId: f.findingId, bucket: f.bucket, reasons: f.reasons,
      }));
      assert.deepEqual(actual, expected, 'per-finding routing drifted from the manifest');
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  /**
   * The manifest's own numbers are cross-checked against the plan's §2b
   * measurements, so a corpus swap or a producer change cannot quietly
   * invalidate the design's stated evidence.
   */
  test('the manifest reproduces the §2b measurements', opts, () => {
    const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    assert.equal(m.totalFindings, 240);
    assert.equal(m.findings.filter((f) => /\/test$/.test(f.ruleId)).length, 95);
    assert.equal(m.findings.filter((f) => f.sinkPath && f.path !== f.sinkPath).length, 42);
    const reason = (s) => m.findings.filter((f) => f.reasons.some((r) => r.includes(s))).length;
    assert.equal(reason('producer-and-glob-agree'), 92);
    assert.equal(reason('disagree-producer-only'), 3);
    assert.equal(reason('disagree-glob-only'), 0);
  });

  // §9 item 8 — duplicate preservation and per-occurrence routing must BOTH
  // be verifiable, which a map keyed on the content hash alone would prevent.
  test('byte-identical duplicate results stay two distinct rows', () => {
    const { findings } = ingestSarif(sarifDoc([resultAt('src/a.js'), resultAt('src/a.js')]));
    assert.equal(findings.length, 2);
    assert.deepEqual(findings.map((f) => f.occurrenceIndex), [0, 1]);
    assert.notEqual(findings[0].findingId, findings[1].findingId);
  });
});

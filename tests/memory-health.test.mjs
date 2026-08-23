import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { _internals } from '../scripts/memory-health.mjs';

const tmpDirs = [];
function mkTmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-health-test-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop();
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best-effort */ }
  }
});

describe('memory-health.mjs — atomicWrite (atomic-write-adoption plan)', () => {
  it('writes content atomically and creates parent directories', () => {
    const tmpDir = mkTmp();
    const target = path.join(tmpDir, 'nested', 'report.md');

    _internals.atomicWrite(target, '# Memory Health\n\nGREEN\n');

    assert.equal(fs.readFileSync(target, 'utf-8'), '# Memory Health\n\nGREEN\n');
  });

  it('overwrites existing content', () => {
    const tmpDir = mkTmp();
    const target = path.join(tmpDir, 'report.md');
    _internals.atomicWrite(target, 'first');
    _internals.atomicWrite(target, 'second');
    assert.equal(fs.readFileSync(target, 'utf-8'), 'second');
  });
});

// ── numEnv bounds (aad83769 — a 0/-1/fractional value must never silently
// defeat the guard it configures) ───────────────────────────────────────────
describe('numEnv bounds', () => {
  const { numEnv } = _internals;
  const envVars = [];
  function setEnv(name, value) { envVars.push(name); process.env[name] = value; }
  afterEach(() => {
    while (envVars.length) delete process.env[envVars.pop()];
  });

  it('MEMORY_HEALTH_MIN_FINDINGS=0 falls back and warns — the exact bypass this bound closes', () => {
    setEnv('X_MIN_FINDINGS', '0');
    const n = numEnv('X_MIN_FINDINGS', 50, { min: 1, integer: true });
    assert.equal(n, 50, 'a threshold of 0 can never satisfy `total < 0` since total is always >= 0');
  });

  it('MEMORY_HEALTH_MIN_FINDINGS=-1 falls back (the originally reported bug)', () => {
    setEnv('X_MIN_FINDINGS', '-1');
    assert.equal(numEnv('X_MIN_FINDINGS', 50, { min: 1, integer: true }), 50);
  });

  it('a positive integer within bounds passes through unchanged', () => {
    setEnv('X_MIN_FINDINGS', '10');
    assert.equal(numEnv('X_MIN_FINDINGS', 50, { min: 1, integer: true }), 10);
  });

  it('MEMORY_HEALTH_WINDOW_DAYS=0 falls back — a 0-day window is degenerate', () => {
    setEnv('X_WINDOW_DAYS', '0');
    assert.equal(numEnv('X_WINDOW_DAYS', 30, { min: 1, integer: true }), 30);
  });

  it('a fractional value for an integer-bounded var falls back', () => {
    setEnv('X_MIN_FINDINGS', '2.5');
    assert.equal(numEnv('X_MIN_FINDINGS', 50, { min: 1, integer: true }), 50);
  });

  it('clusterMedianPairs allows 0 (it gates the OTHER direction, >=)', () => {
    setEnv('X_CLUSTER_MEDIAN', '0');
    assert.equal(numEnv('X_CLUSTER_MEDIAN', 5, { min: 0, integer: true }), 0);
  });

  it('a ratio var (min:0,max:1) rejects out-of-range values', () => {
    setEnv('X_FUZZY_RATE', '1.5');
    assert.equal(numEnv('X_FUZZY_RATE', 0.15, { min: 0, max: 1 }), 0.15);
    setEnv('X_FUZZY_RATE', '-0.1');
    assert.equal(numEnv('X_FUZZY_RATE', 0.15, { min: 0, max: 1 }), 0.15);
    setEnv('X_FUZZY_RATE', '0.5');
    assert.equal(numEnv('X_FUZZY_RATE', 0.15, { min: 0, max: 1 }), 0.5);
  });

  it('a whitespace-only explicit value hard-fails through CONFIG_ERRORS, never silently becomes 0', () => {
    // Number(" ") === 0 in JS, so for clusterMedianPairs ({min:0}) a bare
    // coercion would let whitespace pass validity as a "legitimate explicit
    // 0" (R2-H2). Treating it as merely "absent" (silent fallback, no
    // signal) was itself wrong (R3-H3) — it's an EXPLICIT malformed value,
    // so it must hard-fail the same way any other bad value does.
    const before = _internals.CONFIG_ERRORS.length;
    setEnv('X_CLUSTER_MEDIAN', '   ');
    assert.equal(numEnv('X_CLUSTER_MEDIAN', 5, { min: 0, integer: true }), 5, 'must fall back to the default value');
    assert.equal(_internals.CONFIG_ERRORS.length, before + 1, 'must ALSO be recorded as a config error, not silently absorbed');
  });

  it('a genuinely absent (never-set) var is NOT a config error', () => {
    const before = _internals.CONFIG_ERRORS.length;
    numEnv('X_TRULY_ABSENT_VAR', 5, { min: 0, integer: true });
    assert.equal(_internals.CONFIG_ERRORS.length, before, 'absence is a normal default, not a misconfiguration');
  });

  it('RPC_TIMEOUT_MS=0 falls back — 0 is Postgres\'s "unlimited timeout" sentinel', () => {
    setEnv('X_RPC_TIMEOUT', '0');
    assert.equal(numEnv('X_RPC_TIMEOUT', 240_000, { min: 1, integer: true }), 240_000);
  });

  it('THRESHOLDS.minFindingsForSignal is itself bounded >= 1 in the live config', () => {
    // Guards against a future edit accidentally reverting the {min:1} bound
    // on the actual configured threshold, not just the numEnv primitive.
    assert.ok(_internals.THRESHOLDS.minFindingsForSignal >= 1);
  });

  it('records a config error only for an explicit-but-invalid value, never for an absent one', () => {
    const before = _internals.CONFIG_ERRORS.length;
    numEnv('X_ABSENT_VAR_DOES_NOT_EXIST', 50, { min: 1, integer: true });
    assert.equal(_internals.CONFIG_ERRORS.length, before, 'an absent var is not a misconfiguration');

    setEnv('X_INVALID_EXPLICIT', '0');
    numEnv('X_INVALID_EXPLICIT', 50, { min: 1, integer: true });
    assert.equal(_internals.CONFIG_ERRORS.length, before + 1, 'an explicit invalid value must be recorded');
    assert.match(_internals.CONFIG_ERRORS.at(-1), /X_INVALID_EXPLICIT/);
  });
});

// ── main() hard-fails on invalid explicit config (audit R1-H5) ─────────────
describe('memory-health CLI — invalid config is a hard failure, not a silent fallback', () => {
  it('exits 2 with an explanatory message when an explicit threshold is invalid', () => {
    let threw = null;
    try {
      execFileSync(process.execPath, [path.join(process.cwd(), 'scripts', 'memory-health.mjs')], {
        encoding: 'utf-8',
        env: { ...process.env, MEMORY_HEALTH_MIN_FINDINGS: '-1' },
      });
    } catch (err) {
      threw = err;
    }
    assert.ok(threw, 'main() must exit non-zero, not proceed with a silently-substituted default');
    assert.equal(threw.status, 2);
    assert.match(threw.stderr, /invalid config value/);
    assert.match(threw.stderr, /MEMORY_HEALTH_MIN_FINDINGS/);
  });
});

// ── evaluateClusterDensity: semantic primary + coverage honesty + fallback ──
describe('evaluateClusterDensity (semantic migration)', () => {
  const { evaluateClusterDensity, THRESHOLDS } = _internals;
  const trigram = { median_similar_pairs: 30, per_repo: [] };

  it('uses the SEMANTIC median as the trigger when the RPC is present', () => {
    const m = { cluster_density: trigram, semantic_cluster: {
      median_similar_pairs: 8, coverage: { pct: 90 } } };
    const t = evaluateClusterDensity(m, false);
    assert.equal(t.actual, 8, 'semantic median, not the trigram 30');
    assert.equal(t.fired, 8 >= THRESHOLDS.clusterMedianPairs);
    assert.match(t.similarity, /semantic/);
  });

  it('falls back to trigram (byte-identical to pre-migration) when the RPC is absent', () => {
    const m = { cluster_density: trigram, semantic_cluster: null };
    const t = evaluateClusterDensity(m, false);
    assert.equal(t.actual, 30);
    assert.match(t.similarity, /trigram/);
    assert.equal(t.fired, true);
  });

  it('COVERAGE HONESTY: below the floor → unknown, NOT a false green', () => {
    const m = { cluster_density: trigram, semantic_cluster: {
      median_similar_pairs: 1, coverage: { pct: 20 } } }; // low median but low coverage
    const t = evaluateClusterDensity(m, false);
    assert.equal(t.unknown, true);
    assert.equal(t.fired, false, 'low coverage never FIRES, but...');
    assert.match(t.reading, /UNKNOWN/, '...it must NOT read as a clean green either');
  });

  it('good coverage + low median = a real green', () => {
    const m = { cluster_density: trigram, semantic_cluster: {
      median_similar_pairs: 2, coverage: { pct: 95 } } };
    const t = evaluateClusterDensity(m, false);
    assert.ok(!t.unknown, 'good coverage is not unknown');
    assert.equal(t.fired, false);
  });

  it('insufficient data never fires regardless of median', () => {
    const m = { cluster_density: trigram, semantic_cluster: {
      median_similar_pairs: 50, coverage: { pct: 99 } } };
    assert.equal(evaluateClusterDensity(m, true).fired, false);
  });
});

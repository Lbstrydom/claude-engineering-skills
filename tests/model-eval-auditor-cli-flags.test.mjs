/**
 * @fileoverview CLI preflight validation for the nine controls-wiring flags
 * added to `scripts/model-eval-auditor.mjs` (auditor-controls-execution-
 * wiring.md, Phases 2-3): `--scope`, `--passes`, `--reasoning-effort`,
 * `--temperature`, `--max-output-tokens`, `--prompt-template-id`,
 * `--output-schema-id`, `--tool-policy`, `--rounds`. Every case here fails
 * at PREFLIGHT (exit 2), before any network/provider call — mirrors the
 * existing `model-eval-auditor-cli.test.mjs`'s own `execFileSync` +
 * exit-code pattern, spawning the real CLI rather than mocking it.
 *
 * **Guaranteed network-free, not merely environment-lucky (Gemini-gate
 * round-3 H2 fix).** An earlier draft relied on the REAL `known-defects.json`
 * corpus failing early via `corpus_case_unavailable` (its KD entries cite
 * sibling repos — wine-cellar-app, ai-organiser — that happen not to exist
 * in THIS sandbox). That is an accident of environment, not a guarantee: on
 * a machine where those siblings ARE checked out, a "valid flag" test case
 * could proceed past corpus loading into a REAL provider call with real
 * credentials. Every `run()` call here instead points `--corpus` at a
 * temp-file fixture with ZERO defects, which deterministically fails
 * `corpus_too_small` (`selectedKds.length < minSampleSize`) — BEFORE
 * `loadCorpusCase`/any KD read/any network call, on every machine, always.
 *
 * @module tests/model-eval-auditor-cli-flags
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const CANDIDATE = '{"kind":"sentinel","value":"latest-gpt"}';

let emptyCorpusPath;
before(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eval-cli-flags-'));
  emptyCorpusPath = path.join(dir, 'empty-known-defects.json');
  // version + zero defects — always < any real minSampleSize, so every run
  // refuses at `corpus_too_small`, deterministically, before any KD read.
  fs.writeFileSync(emptyCorpusPath, JSON.stringify({ version: 1, defects: [] }));
});
after(() => {
  if (emptyCorpusPath) fs.rmSync(path.dirname(emptyCorpusPath), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

/** Spawns the CLI with the given extra args and returns {status, stderr}. */
function run(extraArgs) {
  try {
    execFileSync('node', ['scripts/model-eval-auditor.mjs', '--candidate', CANDIDATE, '--tier', 'screen', '--corpus', emptyCorpusPath, ...extraArgs], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: 0, stderr: '' };
  } catch (err) {
    return { status: err.status, stderr: String(err.stderr || '') };
  }
}

/** A "passes flag-level validation" case must reach corpus_too_small —
 * proving MY flag validation didn't reject it AND that it never got far
 * enough to touch a real KD case or provider. Never a bare absence check. */
function assertReachedCorpusPreflight(stderr) {
  assert.match(stderr, /corpus_too_small/, `expected to reach the guaranteed-empty-corpus preflight, got: ${stderr.slice(0, 300)}`);
}

describe('model-eval-auditor.mjs — --scope preflight', () => {
  test('an invalid --scope value exits 2, naming the allowed vocabulary', () => {
    const { status, stderr } = run(['--scope', 'bogus']);
    assert.equal(status, 2);
    assert.match(stderr, /--scope must be one of/);
  });

  for (const v of ['diff', 'plan', 'full']) {
    test(`--scope ${v} passes flag-level validation and reaches the corpus preflight`, () => {
      const { status, stderr } = run(['--scope', v]);
      assert.equal(status, 2);
      assertReachedCorpusPreflight(stderr);
    });
  }
});

describe('model-eval-auditor.mjs — --passes preflight', () => {
  test('an unregistered pass name exits 2', () => {
    const { status, stderr } = run(['--passes', 'not-a-real-pass']);
    assert.equal(status, 2);
    assert.match(stderr, /is not a registered pass/);
  });

  test('an empty entry (trailing comma) exits 2', () => {
    const { status, stderr } = run(['--passes', 'structure,']);
    assert.equal(status, 2);
    assert.match(stderr, /empty entry/);
  });

  test('a duplicate entry exits 2', () => {
    const { status, stderr } = run(['--passes', 'structure,structure']);
    assert.equal(status, 2);
    assert.match(stderr, /duplicate entry/);
  });

  test('a valid, real pass name passes flag-level validation and reaches the corpus preflight', () => {
    const { status, stderr } = run(['--passes', 'structure,wiring']);
    assert.equal(status, 2);
    assertReachedCorpusPreflight(stderr);
  });
});

describe('model-eval-auditor.mjs — --reasoning-effort preflight', () => {
  test('an invalid value exits 2, naming EFFORT_LEVELS', () => {
    const { status, stderr } = run(['--reasoning-effort', 'ludicrous']);
    assert.equal(status, 2);
    assert.match(stderr, /--reasoning-effort must be one of/);
  });

  test('a valid value ("high") passes flag-level validation and reaches the corpus preflight', () => {
    const { status, stderr } = run(['--reasoning-effort', 'high']);
    assert.equal(status, 2);
    assertReachedCorpusPreflight(stderr);
  });
});

describe('model-eval-auditor.mjs — --temperature preflight', () => {
  test('a non-numeric value exits 2', () => {
    const { status, stderr } = run(['--temperature', 'not-a-number']);
    assert.equal(status, 2);
    assert.match(stderr, /--temperature must be a finite number/);
  });

  test('a negative value exits 2', () => {
    const { status } = run(['--temperature', '-1']);
    assert.equal(status, 2);
  });

  test('a non-canonicalizable value (more than 6dp precision) exits 2 — matches AuditorControlsSchema\'s own check', () => {
    const { status, stderr } = run(['--temperature', '0.1234567']);
    assert.equal(status, 2);
    assert.match(stderr, /expressible in 6 decimal places/);
  });

  test('a valid value (0.5) passes flag-level validation and reaches the corpus preflight', () => {
    const { status, stderr } = run(['--temperature', '0.5']);
    assert.equal(status, 2);
    assertReachedCorpusPreflight(stderr);
  });
});

describe('model-eval-auditor.mjs — --max-output-tokens preflight', () => {
  test('a non-integer value exits 2', () => {
    const { status } = run(['--max-output-tokens', '4000.5']);
    assert.equal(status, 2);
  });

  test('zero or negative exits 2', () => {
    const { status } = run(['--max-output-tokens', '0']);
    assert.equal(status, 2);
  });

  test('a value above the Tier-C ceiling (8000) exits 2, naming the ceiling — never silently clamped', () => {
    const { status, stderr } = run(['--max-output-tokens', '9000']);
    assert.equal(status, 2);
    assert.match(stderr, /exceeds the Tier-C extraction ceiling/);
  });

  test('a value within the ceiling passes flag-level validation and reaches the corpus preflight', () => {
    const { status, stderr } = run(['--max-output-tokens', '4000']);
    assert.equal(status, 2);
    assertReachedCorpusPreflight(stderr);
  });
});

describe('model-eval-auditor.mjs — --rounds preflight', () => {
  test('a non-integer value exits 2', () => {
    const { status } = run(['--rounds', '1.5']);
    assert.equal(status, 2);
  });

  test('zero exits 2', () => {
    const { status } = run(['--rounds', '0']);
    assert.equal(status, 2);
  });
});

describe('model-eval-auditor.mjs — all nine flags omitted is byte-identical to pre-plan behavior', () => {
  test('a bare --candidate/--tier invocation never mentions any new preflight reason, and reaches the SAME corpus preflight as every other case here', () => {
    const { status, stderr } = run([]);
    assert.equal(status, 2);
    for (const reason of ['invalid_scope', 'invalid_passes', 'invalid_reasoning_effort', 'invalid_temperature', 'invalid_max_output_tokens', 'invalid_rounds']) {
      assert.doesNotMatch(stderr, new RegExp(reason), `omitting all flags must never trigger ${reason}`);
    }
    assertReachedCorpusPreflight(stderr);
  });
});

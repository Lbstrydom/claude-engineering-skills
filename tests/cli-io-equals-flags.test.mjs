/**
 * @fileoverview `--flag=value` must reach the reader that consumes it.
 *
 * THE DEFECT (consolidated Gemini gate, 2026-08-12, confirmed by execution).
 * The two halves of this seam disagreed: `assertKnownFlags` explicitly accepts
 * `--flag=value` — it validates the name half — while `argOption` looked the
 * flag up with `indexOf('--limit')`, which matches the exact token only. So
 * `--limit=10` passed validation and then returned the DEFAULT.
 *
 * Accepted, validated, and silently dropped. That is precisely the
 * accepted-and-inert class `cli:flags:gate` exists to catch, occurring one
 * layer BELOW the gate — in the helper every guarded CLI delegates to.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { argOption, hasFlag, assertKnownFlags, ArgvError } from '../scripts/lib/cli-io.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let realArgv;
beforeEach(() => { realArgv = process.argv; });
afterEach(() => { process.argv = realArgv; });
const argv = (...rest) => { process.argv = ['node', 'x.mjs', ...rest]; };

describe('argOption reads both spellings', () => {
  it('--name value', () => {
    argv('--limit', '10');
    assert.equal(argOption('limit', 'D'), '10');
  });

  it('--name=value — the form that was silently dropped', () => {
    argv('--limit=10');
    assert.equal(argOption('limit', 'D'), '10');
  });

  it('a value containing = survives (only the FIRST = separates)', () => {
    argv('--dsn=postgres://u:p@h/db?x=1');
    assert.equal(argOption('dsn'), 'postgres://u:p@h/db?x=1');
  });

  it('an empty --name= yields an empty string, not the default', () => {
    // "the operator passed nothing" and "the operator passed empty" are
    // different, and the default would hide the second.
    argv('--note=');
    assert.equal(argOption('note', 'D'), '');
  });

  it('an absent flag still yields the default', () => {
    argv('--other=1');
    assert.equal(argOption('limit', 'D'), 'D');
  });

  it('a prefix match does not leak across flag names', () => {
    argv('--limit-offset=5');
    assert.equal(argOption('limit', 'D'), 'D', '--limit-offset is not --limit');
  });
});

describe('hasFlag reads both spellings, and an explicit falsy value means OFF', () => {
  it('a bare --name is present', () => {
    argv('--dry-run');
    assert.equal(hasFlag('dry-run'), true);
  });

  it('--name=true is present', () => {
    argv('--dry-run=true');
    assert.equal(hasFlag('dry-run'), true);
  });

  for (const v of ['false', '0', 'no', 'off', '', 'FALSE']) {
    it(`--name=${v || '(empty)'} is NOT present`, () => {
      argv(`--dry-run=${v}`);
      assert.equal(hasFlag('dry-run'), false,
        '`--dry-run=false` reading as "dry-run enabled" is the one interpretation nobody expects');
    });
  }

  it('an absent flag is absent', () => {
    argv('--other');
    assert.equal(hasFlag('dry-run'), false);
  });
});

describe('hasFlag refuses a value it cannot classify (closed value set)', () => {
  // THE DEFECT (ledger 77cee58d, executed 2026-10-03). Only false/0/no/off/'' meant
  // OFF; every other `=value` meant ON. `scripts/defect-harvest.mjs` reads
  // `hasFlag('apply')` on a MUTATING path, so `--apply=fasle` — one transposed
  // letter — ENABLED the write. Accepted-and-inverted is worse than
  // accepted-and-inert: the operator asked for less and got more.
  for (const v of ['fasle', 'nope', 'n', 'y', '2', 'ture', ' false', 'false ', 'disabled']) {
    it(`--apply=${JSON.stringify(v)} throws ArgvError naming the flag and BOTH accepted sets`, () => {
      argv(`--apply=${v}`);
      assert.throws(() => hasFlag('apply'), (err) => {
        assert.ok(err instanceof ArgvError, 'must be ArgvError so an entry point can map it to a usage error');
        assert.equal(err.code, 'ARGV_ERROR');
        assert.match(err.message, /--apply/);
        for (const accepted of ['true', 'yes', 'on', 'false', 'no', 'off']) {
          assert.ok(err.message.includes(accepted), `message must list "${accepted}" — got: ${err.message}`);
        }
        return true;
      });
    });
  }

  for (const v of ['true', 'TRUE', 'True', '1', 'yes', 'Yes', 'ON', 'on']) {
    it(`--apply=${v} is accepted as ON`, () => {
      argv(`--apply=${v}`);
      assert.equal(hasFlag('apply'), true);
    });
  }

  it('an invalid EARLIER occurrence still throws although a later one is valid', () => {
    // Last-wins is for VALID occurrences. A wrapper appending `--apply=false` to
    // an inherited list must not be able to launder an upstream typo.
    argv('--apply=fasle', '--apply=false');
    assert.throws(() => hasFlag('apply'), ArgvError);
  });

  it('an invalid value after the -- terminator is a positional, not a flag', () => {
    argv('--', '--apply=fasle');
    assert.equal(hasFlag('apply'), false);
  });

  it('an invalid value on a DIFFERENT flag does not throw for this one', () => {
    argv('--other=fasle');
    assert.equal(hasFlag('apply'), false);
  });

  it('end-to-end: defect-harvest --apply=fasle refuses and writes nothing (negative control: unfixed code writes the file)', () => {
    // NEGATIVE CONTROL, run by hand against the unfixed code (2026-10-03): with
    // `--since 6` the typo'd run printed "Harvested 14 candidate(s)" and WROTE
    // the file, exit 0. `--since 6` keeps that control fast — the default window
    // (400 commits) blames every fix commit and takes minutes; fixed code throws
    // before harvesting, so the small window costs this test nothing.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hasflag-typo-'));
    const out = path.join(dir, 'candidates.json');
    try {
      const r = spawnSync(process.execPath,
        ['scripts/defect-harvest.mjs', '--apply=fasle', '--since', '6', '--out', out],
        { cwd: REPO_ROOT, encoding: 'utf8', timeout: 120_000 });
      assert.notEqual(r.status, 0, `a typo'd boolean must not exit 0 — stderr: ${r.stderr}`);
      assert.match(r.stderr, /--apply/, 'the refusal must name the flag');
      assert.equal(fs.existsSync(out), false, 'the typo must NOT have enabled the mutation (the candidates file was written)');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});

describe('the guard and the readers agree — that is the whole point', () => {
  // The regression this file exists for is a DISAGREEMENT, so assert the pair
  // together: anything the validator accepts must be readable.
  for (const [flag, read] of [
    ['--limit=10', () => argOption('limit')],
    ['--limit', () => argOption('limit')],
    ['--dry-run=true', () => hasFlag('dry-run')],
    ['--dry-run', () => hasFlag('dry-run')],
  ]) {
    it(`${flag} is accepted AND readable`, () => {
      argv(...(flag === '--limit' ? [flag, '10'] : [flag]));
      assert.doesNotThrow(() => assertKnownFlags(process.argv, ['--limit', '--dry-run'], { cli: 'probe' }));
      const v = read();
      assert.ok(v !== null && v !== false && v !== undefined,
        `${flag} passed validation but the reader got ${JSON.stringify(v)} — accepted and inert`);
    });
  }
});

describe('LAST occurrence wins — the wrapper-override convention', () => {
  // The first cut was bare-wins/first-wins: `hasFlag` returned true for a bare
  // `--name` found ANYWHERE, so a later `--name=false` was silently ignored —
  // an override that validates and does nothing, which is the same
  // accepted-and-inert class this whole seam was being fixed for. A wrapper
  // appending an override to an inherited argument list is the real case.
  it('a later --flag=false overrides an earlier bare --flag', () => {
    argv('--dry-run', '--dry-run=false');
    assert.equal(hasFlag('dry-run'), false);
  });

  it('a later bare --flag overrides an earlier --flag=false', () => {
    argv('--dry-run=false', '--dry-run');
    assert.equal(hasFlag('dry-run'), true);
  });

  it('the last value wins for argOption, across both spellings', () => {
    argv('--limit', '10', '--limit=99');
    assert.equal(argOption('limit'), '99');
    argv('--limit=99', '--limit', '10');
    assert.equal(argOption('limit'), '10');
  });
});

describe('hasFlag short-flag alias (e.g. -h) is checked in the same -- terminated region', () => {
  // Several call sites read `--help`/`-h` as `hasFlag('help') || args.includes('-h')`
  // — the bare `args.includes('-h')` half reintroduces the exact pre-`--`-terminator
  // bug this file exists to fix, just for the one-letter spelling. `short` folds
  // both spellings through the one region so there is a single place that decides
  // where flags end.
  it('a bare short flag is present', () => {
    argv('-h');
    assert.equal(hasFlag('help', { short: 'h' }), true);
  });

  it('a short flag after -- is a positional, not a flag', () => {
    argv('--', '-h');
    assert.equal(hasFlag('help', { short: 'h' }), false);
  });

  it('the long flag before -- is still read alongside an unrelated positional -h', () => {
    argv('--help', '--', '-h');
    assert.equal(hasFlag('help', { short: 'h' }), true);
  });

  it('without a short option, the short spelling is not checked (backward compatible)', () => {
    argv('-h');
    assert.equal(hasFlag('help'), false);
  });
});

describe('the POSIX `--` terminator ends flag parsing', () => {
  // The dispatcher's flagRegion already stopped at `--`; these helpers did not,
  // so the two DISAGREED about where flags end — the same validated-vs-consumed
  // drift Cluster D fixed inside the dispatcher, at the layer below it. A
  // literal `--limit` after `--` is a positional meant for a sub-command, and
  // reading it as a flag is how a wrapper eats its child's argument.
  it('argOption ignores a flag after --', () => {
    argv('--', '--limit', '10');
    assert.equal(argOption('limit', 'D'), 'D');
  });

  it('argOption ignores the equals form after --', () => {
    argv('--', '--limit=10');
    assert.equal(argOption('limit', 'D'), 'D');
  });

  it('hasFlag ignores a flag after --', () => {
    argv('--', '--dry-run');
    assert.equal(hasFlag('dry-run'), false);
  });

  it('flags BEFORE -- are still read (the terminator narrows, it does not disable)', () => {
    argv('--limit=5', '--', '--limit=99');
    assert.equal(argOption('limit'), '5');
  });
});

describe('emit refuses what stdout cannot carry', () => {
  it('an unserialisable value throws rather than writing "undefined"', async () => {
    const { emit } = await import('../scripts/lib/cli-io.mjs');
    assert.throws(() => emit(undefined), /does not serialise to JSON/);
  });

  it('a softFail reason must be a NON-EMPTY string, not merely truthy', async () => {
    const { emit } = await import('../scripts/lib/cli-io.mjs');
    const realWrite = process.stdout.write;
    process.stdout.write = () => true;
    try {
      for (const bogus of [{}, [], '   ', 0, true]) {
        assert.throws(() => emit({ ok: false }, { softFail: true, reason: bogus }),
          /requires a written `reason`/, `reason: ${JSON.stringify(bogus)} must not pass`);
      }
    } finally { process.stdout.write = realWrite; }
  });
});

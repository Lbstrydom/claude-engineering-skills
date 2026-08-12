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
import { argOption, hasFlag, assertKnownFlags } from '../scripts/lib/cli-io.mjs';

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

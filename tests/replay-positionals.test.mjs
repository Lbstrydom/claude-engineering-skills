/**
 * @fileoverview `replay <decision_type>` must survive a flag placed before it.
 *
 * THE DEFECT (consolidated Gemini gate, 2026-08-12, confirmed by execution).
 * Positionals were `args.filter(a => !a.startsWith('--'))`, which cannot tell a
 * positional from a VALUE. `replay --repo owner/repo pass_selection` therefore
 * took `owner/repo` as the decision type and failed with
 *
 *   no built-in rewardFn for decision_type='owner/repo'
 *
 * — a message that reads as "you named a decision type that does not exist",
 * sending the operator to look at the decision-type list rather than at their
 * own command line. A misparse wearing a domain error's clothes.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { replayPositionals, parseReplayArgs } from '../scripts/learning/replay.mjs';

describe('replayPositionals', () => {
  it('the plain case', () => {
    assert.deepEqual(replayPositionals(['pass_selection']), ['pass_selection']);
  });

  it('a valued flag BEFORE the positional does not eat it (the defect)', () => {
    assert.deepEqual(
      replayPositionals(['--repo', 'owner/repo', 'pass_selection']),
      ['pass_selection'],
    );
  });

  it('a valued flag AFTER the positional is unaffected', () => {
    assert.deepEqual(
      replayPositionals(['pass_selection', '--repo', 'owner/repo']),
      ['pass_selection'],
    );
  });

  it('several valued flags, both sides', () => {
    assert.deepEqual(
      replayPositionals(['--since', '30d', 'convergence_predict', '--format', 'markdown']),
      ['convergence_predict'],
    );
  });

  it('the --flag=value form consumes nothing extra', () => {
    // A token that carries its own value must not swallow the next one, or the
    // fix would break the spelling cli-io.mjs was just taught to read.
    assert.deepEqual(
      replayPositionals(['--repo=owner/repo', 'pass_selection']),
      ['pass_selection'],
    );
  });

  it('an UNKNOWN flag consumes nothing — a value-less flag must not eat a positional', () => {
    // The complement of the defect: skipping the next token after every `--x`
    // would break boolean flags. Only the DECLARED valued flags consume.
    assert.deepEqual(
      replayPositionals(['--dry-run', 'pass_selection']),
      ['pass_selection'],
    );
  });

  it('a missing decision type is still missing (no positional invented)', () => {
    assert.deepEqual(replayPositionals(['--repo', 'owner/repo']), []);
  });

  it('everything after the POSIX -- terminator is a positional (round-1 plan audit M1)', () => {
    assert.deepEqual(
      replayPositionals(['pass_selection', '--', '--policy=x.mjs', '--since', '7d']),
      ['pass_selection', '--policy=x.mjs', '--since', '7d'],
    );
  });
});

describe('parseReplayArgs — ONE tokenizer feeds both the positionals and the options', () => {
  // Ledger af81be85 (d): `replayPositionals` understood `--name=value` while the
  // option reader did not — two readers of one argv disagreeing about its grammar,
  // so `--since=7d` was accepted by the flag allowlist, skipped by the positional
  // scan, and then silently absent from the options. One function now owns it.
  it('--name=value and --name value land in the same place', () => {
    assert.deepEqual(parseReplayArgs(['pass_selection', '--since=7d']).opts, { since: '7d' });
    assert.deepEqual(parseReplayArgs(['pass_selection', '--since', '7d']).opts, { since: '7d' });
  });

  it('only the first = separates (a value may contain =)', () => {
    assert.deepEqual(parseReplayArgs(['--policy=C:/a=b/p.mjs']).opts, { policy: 'C:/a=b/p.mjs' });
  });

  it('LAST occurrence wins, across both spellings', () => {
    assert.equal(parseReplayArgs(['--since', '14d', '--since=7d']).opts.since, '7d');
    assert.equal(parseReplayArgs(['--since=7d', '--since', '14d']).opts.since, '14d');
  });

  it('a space-form flag NEVER swallows the next flag — it records an empty value instead', () => {
    // `--policy --since 7d` read `--since` as a module path and then left `7d`
    // as a stray positional. The empty value is what validateReplayOptions refuses.
    const p = parseReplayArgs(['pass_selection', '--policy', '--since', '7d']);
    assert.deepEqual(p.opts, { policy: '', since: '7d' });
    assert.deepEqual(p.positionals, ['pass_selection']);
  });

  it('a trailing valued flag with no value records an empty value', () => {
    assert.deepEqual(parseReplayArgs(['pass_selection', '--since']).opts, { since: '' });
    assert.deepEqual(parseReplayArgs(['pass_selection', '--since=']).opts, { since: '' });
  });

  it('an unknown or boolean-looking flag is not an option and consumes nothing', () => {
    const p = parseReplayArgs(['--dry-run', 'pass_selection']);
    assert.deepEqual(p.opts, {});
    assert.deepEqual(p.positionals, ['pass_selection']);
  });

  it('after -- nothing is an option, and the terminator itself is dropped', () => {
    const p = parseReplayArgs(['pass_selection', '--', '--policy=x.mjs']);
    assert.deepEqual(p.opts, {}, 'a post-terminator --policy must not reach loadPolicy');
    assert.deepEqual(p.positionals, ['pass_selection', '--policy=x.mjs']);
  });
});

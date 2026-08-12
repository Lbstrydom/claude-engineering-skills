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
import { replayPositionals } from '../scripts/learning/replay.mjs';

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
});

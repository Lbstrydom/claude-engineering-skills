/**
 * @fileoverview CLI_SMOKE_SET membership obliges declaring the script in
 * sync-to-repos.mjs. Enforce that HERE, where it is cheap to notice.
 *
 * sync-isolation-verify.mjs's own comment states the rule and its failure mode:
 * the set asserts CONSUMER PRESENCE, so an entry that is never synced makes
 * gate 4 fail in every consumer "while this repo's `npm test` stays green".
 *
 * The prediction came true. Commit 8999636 added model-eval-auditor.mjs and
 * model-eval-adjudicator.mjs to the set without declaring them in
 * sync-to-repos.mjs; gate 4 failed in wine-cellar-app for months and nothing in
 * this repo noticed, because the only check that could see it runs in the
 * consumer — a repo whose isolation tree is gitignored and which nobody runs
 * the verifier in by default. Discovered 2026-07-19 only because a sync
 * bookkeeping commit happened to run the verifier by hand.
 *
 * A documented obligation that only fails somewhere you don't look is not a
 * gate. This is the mechanical version.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _internals } from '../scripts/lib/sync-isolation-verify.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SYNC_SRC = fs.readFileSync(path.join(ROOT, 'scripts/sync-to-repos.mjs'), 'utf8');

describe('CLI_SMOKE_SET ↔ sync-to-repos parity', () => {
  test('every CLI_SMOKE_SET entry is declared as a synced script', () => {
    const undeclared = _internals.CLI_SMOKE_SET.filter(rel => !SYNC_SRC.includes(`scripts/${rel}`));
    assert.deepEqual(
      undeclared, [],
      'These CLIs are asserted to be PRESENT in every consumer but are not declared in ' +
      'sync-to-repos.mjs, so they will never be synced and gate 4 will fail in every ' +
      'consumer while this repo stays green. Either declare them as a sync entry point, ' +
      'or remove them from CLI_SMOKE_SET (correct when the CLI is a source-repo-only tool ' +
      '— see the model-eval / verify-anchor-contract notes in sync-isolation-verify.mjs).',
    );
  });

  test('every CLI_SMOKE_SET entry actually exists in this repo', () => {
    // A typo'd entry would otherwise pass the parity check only if the typo also
    // appeared in sync-to-repos.mjs, and fail confusingly in consumers.
    const absent = _internals.CLI_SMOKE_SET.filter(rel => !fs.existsSync(path.join(ROOT, 'scripts', rel)));
    assert.deepEqual(absent, [], 'CLI_SMOKE_SET names a script that does not exist in scripts/');
  });

  test('the two known source-repo-only CLIs stay OUT of the set', () => {
    // Regression pin: both read docs/experiments/audit-effectiveness/known-defects.json,
    // a corpus graded on THIS repo's finding distribution that is deliberately
    // never synced. Shipping the CLIs without it would deliver tools that cannot
    // run, so the correct fix is exclusion, not declaration.
    for (const rel of ['model-eval-auditor.mjs', 'model-eval-adjudicator.mjs', 'verify-anchor-contract.mjs']) {
      assert.ok(
        !_internals.CLI_SMOKE_SET.includes(rel),
        `${rel} is a source-repo-only tool (reads an unsynced corpus / pins a source sha) — ` +
        'adding it to CLI_SMOKE_SET breaks gate 4 in every consumer.',
      );
    }
  });
});

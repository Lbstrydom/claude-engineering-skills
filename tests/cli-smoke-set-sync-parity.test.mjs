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
const SYNC_INVENTORY_SRC = fs.readFileSync(path.join(ROOT, 'scripts/lib/sync-inventory.mjs'), 'utf8');

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

  test('the known source-repo-only CLIs stay OUT of the set', () => {
    // Regression pin: model-eval-auditor.mjs / model-eval-adjudicator.mjs /
    // verify-anchor-contract.mjs all read docs/experiments/audit-effectiveness/
    // known-defects.json, a corpus graded on THIS repo's finding distribution
    // that is deliberately never synced. check-accepted-debt.mjs is the same
    // shape for a different reason: its registry (ACCEPTED_DEBT_ROWS) is
    // hardcoded to THIS repo's own 6 AGENTS.md rows and their exact
    // fingerprints — running it against a consumer's own AGENTS.md would
    // report the whole table unregistered forever (round-2 code-audit
    // Quickfix M7). This pin is what makes "excluded from sync today" a
    // tested, permanent invariant rather than a silent absence a future
    // change could reintroduce without reconsidering the design (round-4
    // code-audit M2/M7/Quickfix M8 — "excluding a script from today's sync
    // manifest does not make it immune to drift").
    for (const rel of ['model-eval-auditor.mjs', 'model-eval-adjudicator.mjs', 'verify-anchor-contract.mjs', 'check-accepted-debt.mjs']) {
      assert.ok(
        !_internals.CLI_SMOKE_SET.includes(rel),
        `${rel} is a source-repo-only tool — adding it to CLI_SMOKE_SET breaks gate 4 in every consumer.`,
      );
    }
  });

  test('check-accepted-debt.mjs and its lib files stay OUT of sync-to-repos.mjs / sync-inventory.mjs entirely', () => {
    // Round-5 code-audit be-services M1 / Sustainability M4: this test's NAME
    // named both files but its body only ever read SYNC_SRC — sync-inventory.mjs
    // was never actually checked, so a reintroduction there would have passed
    // silently. Both sources are asserted now.
    for (const rel of ['scripts/check-accepted-debt.mjs', 'scripts/lib/accepted-debt-check.mjs', 'scripts/lib/accepted-debt-registry.mjs']) {
      assert.ok(!SYNC_SRC.includes(`'${rel}'`), `${rel} must not be declared in sync-to-repos.mjs — see the source-repo-only rationale above`);
      assert.ok(!SYNC_INVENTORY_SRC.includes(`'${rel}'`), `${rel} must not be declared in sync-inventory.mjs — see the source-repo-only rationale above`);
    }
  });
});

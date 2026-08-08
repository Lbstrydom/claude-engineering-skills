/**
 * The adjudication-ledger writer CLI.
 *
 * It replaced a heredoc recipe in `references/ledger-format.md` that could not
 * run in a consumer repo at all (it imported `../../scripts/shared.mjs`, which
 * lives under `scripts/.claude-skills/` there, and the sync's command rewriter
 * only relocates `node scripts/<path>` invocations).
 *
 * What the tests pin is the reason the CLI exists rather than a script: the
 * operator supplies ONLY the judgement, and every identity field is derived
 * from the round's own finding. A hand-constructed identity joins to nothing —
 * suppression never engages and outcome labeling reports `0/N labelled`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { generateTopicId, populateFindingMetadata } from '../scripts/lib/ledger.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO_ROOT, 'scripts', 'write-ledger-entries.mjs');

const FINDING = {
  id: 'H1',
  severity: 'HIGH',
  category: 'Conflicting contract',
  section: 'src/a.mjs: §4',
  detail: 'The exit-code contract contradicts itself.',
  principle: 'Explicit error contracts',
  _pass: 'plan',
  _hash: 'abc12345',
};

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-cli-'));
  const resultPath = path.join(dir, 'audit-plan-1-r1-result.json');
  const ledgerPath = path.join(dir, 'audit-plan-1-ledger.json');
  const triagePath = path.join(dir, 'triage.json');
  fs.writeFileSync(resultPath, JSON.stringify({ round: 1, findings: [FINDING, { ...FINDING, id: 'M2', severity: 'MEDIUM', _hash: 'def67890' }] }));
  return { dir, resultPath, ledgerPath, triagePath };
}

const run = (args) => execFileSync(process.execPath, [CLI, ...args], {
  encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
});

describe('write-ledger-entries', () => {
  it('derives topicId/semanticHash from the finding, not from the operator', () => {
    const { resultPath, ledgerPath, triagePath } = fixture();
    fs.writeFileSync(triagePath, JSON.stringify({
      // An apostrophe in the rationale is the whole reason this is a FILE.
      H1: { outcome: 'accepted', state: 'planned', ruling: 'sustain', why: "valid — the plan's fix is scheduled" },
    }));
    run(['--result', resultPath, '--ledger', ledgerPath, '--triage', triagePath]);

    const entry = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8')).entries[0];
    const expected = { ...FINDING };
    populateFindingMetadata(expected, 'plan');
    assert.equal(entry.topicId, generateTopicId(expected), 'topicId must match what the audit itself derives');
    assert.equal(entry.semanticHash, FINDING._hash);
    assert.equal(entry.latestFindingId, 'H1', 'the second join key must survive the schema, not be stripped');
    assert.equal(entry.rulingRationale, "valid — the plan's fix is scheduled");
    assert.equal(entry.adjudicationOutcome, 'accepted');
    assert.equal(entry.pass, 'plan');
  });

  it('warns about findings left un-ruled instead of reporting a clean write', () => {
    const { resultPath, ledgerPath, triagePath } = fixture();
    fs.writeFileSync(triagePath, JSON.stringify({
      H1: { outcome: 'dismissed', state: 'pending', ruling: 'overrule', why: 'not applicable here' },
    }));
    const out = execFileSync(process.execPath, [CLI, '--result', resultPath, '--ledger', ledgerPath, '--triage', triagePath], {
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.match(out, /1\/2 findings ruled/);
    // The un-ruled one is the silent half of a later `0/N labelled` report.
    const json = JSON.parse(run(['--result', resultPath, '--ledger', ledgerPath, '--triage', triagePath, '--json']));
    assert.deepEqual(json.unruled, ['M2']);
  });

  it('refuses a triage id that is not in the round result', () => {
    const { resultPath, ledgerPath, triagePath } = fixture();
    fs.writeFileSync(triagePath, JSON.stringify({
      H9: { outcome: 'accepted', state: 'fixed', ruling: 'sustain', why: 'typo in the id' },
    }));
    assert.throws(
      () => run(['--result', resultPath, '--ledger', ledgerPath, '--triage', triagePath]),
      (err) => err.status === 2 && /not in .*r1-result\.json/.test(String(err.stderr)),
    );
    assert.equal(fs.existsSync(ledgerPath), false, 'nothing may be written when an id is unknown');
  });

  it('refuses an out-of-enum outcome/state/ruling and a missing rationale', () => {
    const { resultPath, ledgerPath, triagePath } = fixture();
    for (const [bad, pattern] of [
      [{ H1: { outcome: 'fixed-it', state: 'planned', ruling: 'sustain', why: 'x' } }, /H1\.outcome must be one of/],
      [{ H1: { outcome: 'accepted', state: 'done', ruling: 'sustain', why: 'x' } }, /H1\.state must be one of/],
      [{ H1: { outcome: 'accepted', state: 'planned', ruling: 'agree', why: 'x' } }, /H1\.ruling must be one of/],
      [{ H1: { outcome: 'accepted', state: 'planned', ruling: 'sustain', why: '  ' } }, /H1\.why .* is required/],
    ]) {
      fs.writeFileSync(triagePath, JSON.stringify(bad));
      assert.throws(
        () => run(['--result', resultPath, '--ledger', ledgerPath, '--triage', triagePath]),
        (err) => err.status === 2 && pattern.test(String(err.stderr)),
        `expected refusal matching ${pattern}`,
      );
    }
  });

  it('--mark-fixed flips remediationState by topicId and leaves other fields intact', () => {
    const { resultPath, ledgerPath, triagePath } = fixture();
    fs.writeFileSync(triagePath, JSON.stringify({
      H1: { outcome: 'accepted', state: 'planned', ruling: 'sustain', why: 'scheduled' },
    }));
    run(['--result', resultPath, '--ledger', ledgerPath, '--triage', triagePath]);
    const before = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8')).entries[0];

    run(['--ledger', ledgerPath, '--mark-fixed', before.topicId]);
    const after = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8')).entries[0];
    assert.equal(after.remediationState, 'fixed');
    assert.equal(after.adjudicationOutcome, before.adjudicationOutcome);
    assert.equal(after.rulingRationale, before.rulingRationale);
  });

  it('rejects an unknown flag instead of ignoring it', () => {
    assert.throws(
      () => run(['--ledger', 'x.json', '--mark-fixed', 'abc', '--nope']),
      (err) => err.status === 2 && /unknown flag/.test(String(err.stderr)),
    );
  });
});

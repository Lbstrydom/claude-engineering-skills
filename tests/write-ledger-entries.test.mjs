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
import { execFileSync, execFile } from 'node:child_process';
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

describe('write-ledger-entries — a write that did not happen cannot report success', () => {
  // Round-1 audit finding H1/H2, reproduced live 2026-08-08: `--round nope`
  // became NaN, LedgerEntrySchema rejected every entry, writeLedgerEntry
  // returned after one stderr line, and the CLI printed `1/1 findings ruled ·
  // acceptance 100%` and exited 0 — with NO ledger file on disk at all.

  it('refuses a non-integer --round instead of coercing it to NaN', () => {
    const { resultPath, ledgerPath, triagePath } = fixture();
    fs.writeFileSync(triagePath, JSON.stringify({
      H1: { outcome: 'accepted', state: 'planned', ruling: 'sustain', why: 'x' },
    }));
    assert.throws(
      () => run(['--result', resultPath, '--ledger', ledgerPath, '--triage', triagePath, '--round', 'nope']),
      (err) => err.status === 2 && /--round must be a positive integer/.test(String(err.stderr)),
    );
    assert.equal(fs.existsSync(ledgerPath), false, 'no ledger may be written for a rejected round');
  });

  it('refuses a zero/negative round', () => {
    const { resultPath, ledgerPath, triagePath } = fixture();
    fs.writeFileSync(triagePath, JSON.stringify({
      H1: { outcome: 'accepted', state: 'planned', ruling: 'sustain', why: 'x' },
    }));
    for (const bad of ['0', '-3', '1.5']) {
      assert.throws(
        () => run(['--result', resultPath, '--ledger', ledgerPath, '--triage', triagePath, '--round', bad]),
        (err) => err.status === 2,
        `--round ${bad} must be refused`,
      );
    }
  });

  it('exits non-zero when an entry does not land on disk', () => {
    // Drive a rejection through the real schema: a finding whose severity the
    // ledger schema does not accept. The CLI must NOT report it as written.
    const { ledgerPath, triagePath } = fixture();
    const dir = path.dirname(ledgerPath);
    const resultPath = path.join(dir, 'audit-plan-9-r1-result.json');
    fs.writeFileSync(resultPath, JSON.stringify({
      round: 1,
      findings: [{ ...FINDING, severity: 'CATASTROPHIC' }],
    }));
    fs.writeFileSync(triagePath, JSON.stringify({
      H1: { outcome: 'accepted', state: 'planned', ruling: 'sustain', why: 'x' },
    }));
    assert.throws(
      () => run(['--result', resultPath, '--ledger', ledgerPath, '--triage', triagePath]),
      (err) => err.status === 2 && /would be rejected by the ledger schema/.test(String(err.stderr)),
      'a schema-rejected entry must fail the run, not be counted as ruled',
    );
    assert.equal(
      fs.existsSync(ledgerPath), false,
      'the batch is validated before anything is written — a rejected entry leaves no partial ledger',
    );
  });

  it('--mark-fixed exits non-zero if an entry is not actually marked', () => {
    // A ledger whose entry cannot survive re-validation: the read-modify-write
    // rebuilds it, the schema rejects it, and nothing changes on disk.
    const { ledgerPath } = fixture();
    fs.writeFileSync(ledgerPath, JSON.stringify({
      version: 1,
      entries: [{ topicId: 'zz', severity: 'HIGH' }],   // missing every required field
    }));
    const before = fs.readFileSync(ledgerPath, 'utf-8');
    assert.throws(
      () => run(['--ledger', ledgerPath, '--mark-fixed', 'zz']),
      (err) => err.status === 2 && /would be rejected by the ledger schema/.test(String(err.stderr)),
    );
    assert.equal(fs.readFileSync(ledgerPath, 'utf-8'), before, 'the ledger must be untouched');
  });
});

describe('the ledger batch is one write, not N', () => {
  // Round-4 audit H1/M1/M3. Honest limit, stated rather than papered over: a
  // crash or I/O failure mid-batch is NOT hermetically constructible, so no
  // test here proves atomicity itself. What IS pinnable is the design that
  // delivers it — a single write path — so a later edit cannot quietly
  // reintroduce the per-entry loop that made a batch land in pieces.
  it('routes every write through one atomicWriteFileSync, never per-entry writeLedgerEntry', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'write-ledger-entries.mjs'), 'utf-8');
    const code = src.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(
      !/\bwriteLedgerEntry\s*\(/.test(code),
      'write-ledger-entries must not call writeLedgerEntry per entry — that is the N-mutation path',
    );
    assert.equal(
      (code.match(/atomicWriteFileSync\s*\(/g) || []).length, 1,
      'exactly one atomic write call should exist',
    );
  });

  it('a multi-entry batch lands complete', () => {
    const { resultPath, ledgerPath, triagePath } = fixture();
    fs.writeFileSync(triagePath, JSON.stringify({
      H1: { outcome: 'accepted', state: 'planned', ruling: 'sustain', why: 'a' },
      M2: { outcome: 'dismissed', state: 'pending', ruling: 'overrule', why: 'b' },
    }));
    run(['--result', resultPath, '--ledger', ledgerPath, '--triage', triagePath]);
    const entries = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8')).entries;
    assert.equal(entries.length, 2);
    assert.deepEqual(entries.map(e => e.latestFindingId).sort(), ['H1', 'M2']);
  });
});

describe('concurrent adjudication does not lose a ruling', () => {
  // Round-5 audit H1: the atomic rename protects the WRITE, not the
  // read-merge-write TRANSACTION. Two processes read the same prior state and
  // each replaced the file, so the second silently discarded the first's
  // rulings — and this repo's working tree is routinely shared by concurrent
  // sessions, so that is an ordinary Tuesday, not a thought experiment.
  it('two simultaneous writers both land their entries', async () => {
    const { resultPath, ledgerPath, dir } = fixture();
    const triageA = path.join(dir, 'a.json');
    const triageB = path.join(dir, 'b.json');
    fs.writeFileSync(triageA, JSON.stringify({
      H1: { outcome: 'accepted', state: 'planned', ruling: 'sustain', why: 'from writer A' },
    }));
    fs.writeFileSync(triageB, JSON.stringify({
      M2: { outcome: 'dismissed', state: 'pending', ruling: 'overrule', why: 'from writer B' },
    }));

    const spawn = (triage) => new Promise((resolve, reject) => {
      execFile(process.execPath,
        [CLI, '--result', resultPath, '--ledger', ledgerPath, '--triage', triage],
        (err) => (err ? reject(err) : resolve()));
    });
    await Promise.all([spawn(triageA), spawn(triageB)]);

    const entries = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8')).entries;
    assert.deepEqual(
      entries.map(e => e.latestFindingId).sort(), ['H1', 'M2'],
      'a lost ruling means the second writer overwrote the first\'s merge',
    );
  });
});

describe('a structurally-wrong ledger is preserved, not replaced', () => {
  // Round-6 audit H1, a regression I introduced: the single-write path treated
  // "parseable but not a ledger" as "no ledger" and then WROTE over it, losing
  // whatever was there. writeSingleLedgerEntry backs such a file up; this path
  // took over from it and had dropped that.
  it('backs up the old file and warns before starting fresh', () => {
    const { resultPath, ledgerPath, triagePath } = fixture();
    fs.writeFileSync(ledgerPath, JSON.stringify({ version: 1, notEntries: 'precious' }));
    fs.writeFileSync(triagePath, JSON.stringify({
      H1: { outcome: 'accepted', state: 'planned', ruling: 'sustain', why: 'x' },
    }));
    const proc = execFileSync(process.execPath,
      [CLI, '--result', resultPath, '--ledger', ledgerPath, '--triage', triagePath],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });

    assert.match(proc, /1\/2 findings ruled/);
    const backup = JSON.parse(fs.readFileSync(`${ledgerPath}.bak`, 'utf-8'));
    assert.equal(backup.notEntries, 'precious', 'the prior file must survive as a .bak');
    assert.equal(JSON.parse(fs.readFileSync(ledgerPath, 'utf-8')).entries.length, 1);
  });

  it('a well-formed ledger is NOT backed up — the guard must not fire on the normal path', () => {
    // Vacuous-pass guard: a version that backed up unconditionally would satisfy
    // the test above while littering a .bak beside every ordinary run.
    const { resultPath, ledgerPath, triagePath } = fixture();
    fs.writeFileSync(triagePath, JSON.stringify({
      H1: { outcome: 'accepted', state: 'planned', ruling: 'sustain', why: 'x' },
    }));
    run(['--result', resultPath, '--ledger', ledgerPath, '--triage', triagePath]);
    run(['--result', resultPath, '--ledger', ledgerPath, '--triage', triagePath]);
    assert.equal(fs.existsSync(`${ledgerPath}.bak`), false);
  });
});

describe('--mark-fixed derives from the ledger UNDER the lock', () => {
  // Gemini final gate, round 2: the lock added in round 5 made the WRITE
  // atomic while --mark-fixed still read the ledger BEFORE acquiring it, then
  // handed those stale rows in for a replace-by-topicId merge. A triage
  // decision landing in between was silently overwritten by the stale copy —
  // the very data loss the lock was added to stop, one step upstream.
  //
  // Asserted STRUCTURALLY, and deliberately so: a two-process race test was
  // written first and passed against BOTH implementations (the processes
  // serialize on the lock, so the stale-read window is not reliably hit). A
  // probe that cannot fail proves nothing, so it was removed rather than kept
  // as decoration. What is checkable is that the derivation happens inside the
  // lock callback and nothing reads the ledger before it.
  it('does not read the ledger outside the lock', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'write-ledger-entries.mjs'), 'utf-8');
    const code = src.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const markFixedBranch = code.slice(code.indexOf('const fixedIds = markFixedIds('), code.indexOf('const resultPath ='));
    assert.ok(
      !/readJson\s*\(\s*ledgerPath/.test(markFixedBranch),
      '--mark-fixed must not read the ledger before acquiring the lock — derive under it instead',
    );
    assert.match(
      markFixedBranch, /writeLedgerAtomically\(ledgerPath,\s*\(byTopic\)\s*=>/,
      'the merge must be a function evaluated against the in-lock read',
    );
  });
});

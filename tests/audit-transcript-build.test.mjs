/**
 * The final-review transcript — the artifact both MANDATORY gates consume.
 *
 * Field report 2026-08-08: `/audit-plan` Step 6 and `/audit-code` Step 7 both
 * ran `gemini-review.mjs review <plan> .audit/$SID-transcript.json` while NO
 * step produced that file. The operator hand-assembled one from a reference
 * doc — so the gate that must not be skipped was blocked on invented state.
 *
 * Two properties this pins, both of which a hand-rolled transcript got wrong:
 *
 *   1. A PLAN transcript carries NO code files. The reviewer's prompt keys
 *      "this is a plan audit" off their absence, so one stray path flips the
 *      gate into judging unbuilt work as missing implementation — the exact
 *      category error `--mode plan` exists to prevent.
 *   2. Round results are never silently dropped. A transcript missing a round
 *      looks complete and is not.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  AUDIT_MODES, buildAuditTranscript, discoverRoundResults, inferAuditMode,
  ledgerResolutions, readRoundResult,
} from '../scripts/lib/audit/transcript.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO_ROOT, 'scripts', 'build-audit-transcript.mjs');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-test-'));
}

function writeResult(dir, sid, round, extra = {}) {
  const p = path.join(dir, `${sid}-r${round}-result.json`);
  fs.writeFileSync(p, JSON.stringify({
    findings: [{ id: `H${round}`, severity: 'HIGH', detail: `finding from round ${round}` }],
    verdict: 'SIGNIFICANT_ISSUES',
    ...extra,
  }, null, 2));
  return p;
}

describe('buildAuditTranscript', () => {
  it('forces code_files/changed_files empty in plan mode', () => {
    // Even when the caller hands over code paths — a plan audit has no code
    // under review and the reviewer's plan/code discriminator is their absence.
    const t = buildAuditTranscript({
      rounds: [{ round: 1, findings: [], code_files: ['src/a.mjs'] }],
      auditMode: 'plan',
      changedFiles: ['src/a.mjs'],
    });
    assert.equal(t.audit_mode, 'plan');
    assert.deepEqual(t.code_files, []);
    assert.deepEqual(t.changed_files, []);
  });

  it('unions code_files across rounds in code mode', () => {
    const t = buildAuditTranscript({
      rounds: [
        { round: 1, findings: [], code_files: ['src/a.mjs', 'src/b.mjs'] },
        { round: 2, findings: [], code_files: ['src/b.mjs', 'src/c.mjs'] },
      ],
      auditMode: 'code',
      changedFiles: ['src/a.mjs', 'src/a.mjs', ''],
    });
    assert.deepEqual(t.code_files.sort(), ['src/a.mjs', 'src/b.mjs', 'src/c.mjs']);
    assert.deepEqual(t.changed_files, ['src/a.mjs']); // deduped, blanks dropped
  });

  it('rejects an empty round set and an unknown mode', () => {
    assert.throws(() => buildAuditTranscript({ rounds: [], auditMode: 'code' }), /at least one round/);
    assert.throws(
      () => buildAuditTranscript({ rounds: [{ findings: [] }], auditMode: 'sideways' }),
      /auditMode must be one of/,
    );
    assert.deepEqual([...AUDIT_MODES], ['plan', 'code']);
  });
});

describe('ledgerResolutions', () => {
  it('renders adjudicated entries and skips un-ruled ones', () => {
    const lines = ledgerResolutions({
      entries: [
        {
          topicId: 'abc123', severity: 'HIGH', adjudicationOutcome: 'accepted',
          remediationState: 'fixed', ruling: 'sustain', rulingRationale: 'folded into §4',
          resolvedRound: 2,
        },
        { topicId: 'def456', severity: 'LOW', adjudicationOutcome: 'pending' },
        { topicId: 'ghi789', severity: 'MEDIUM' },
      ],
    });
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^R2 abc123 \[HIGH\] accepted\/fixed \(sustain\) — folded into §4$/);
  });

  it('accepts a bare array ledger and a null ledger', () => {
    assert.deepEqual(ledgerResolutions(null), []);
    assert.equal(ledgerResolutions([{ topicId: 'x', adjudicationOutcome: 'dismissed' }]).length, 1);
  });
});

describe('inferAuditMode', () => {
  it('reads the mode off the documented session-id prefixes, else null', () => {
    assert.equal(inferAuditMode('audit-plan-1784025192'), 'plan');
    assert.equal(inferAuditMode('audit-code-1784025192'), 'code');
    // Never guess: an unrecognised sid must force an explicit --mode rather
    // than default a plan audit into code mode.
    assert.equal(inferAuditMode('my-session'), null);
    assert.equal(inferAuditMode(undefined), null);
  });
});

describe('discoverRoundResults', () => {
  it('finds a session\'s rounds in ascending order and ignores other sessions', () => {
    const dir = tmpdir();
    writeResult(dir, 'audit-code-2', 2);
    writeResult(dir, 'audit-code-2', 10);
    writeResult(dir, 'audit-code-2', 1);
    writeResult(dir, 'audit-code-9', 1);           // different session
    fs.writeFileSync(path.join(dir, 'audit-code-2-ledger.json'), '{}');  // not a result
    const found = discoverRoundResults({ sid: 'audit-code-2', dir });
    assert.deepEqual(found.map(f => f.round), [1, 2, 10]);
  });

  it('returns empty for a missing directory rather than throwing', () => {
    assert.deepEqual(discoverRoundResults({ sid: 'x', dir: path.join(tmpdir(), 'nope') }), []);
  });
});

describe('readRoundResult', () => {
  it('stamps the round parsed from the filename', () => {
    const dir = tmpdir();
    const p = writeResult(dir, 'audit-plan-7', 3);
    assert.equal(readRoundResult(p).round, 3);
  });

  it('throws on a file that is not an audit result', () => {
    const dir = tmpdir();
    const p = path.join(dir, 'audit-code-1-r1-result.json');
    fs.writeFileSync(p, '{"nope": true}');
    assert.throws(() => readRoundResult(p), /no "findings" array/);
  });
});

describe('build-audit-transcript CLI', () => {
  const run = (args, opts = {}) => execFileSync(process.execPath, [CLI, ...args], {
    encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], ...opts,
  });

  it('builds a plan transcript from --sid alone, picking up the ledger', () => {
    const dir = tmpdir();
    writeResult(dir, 'audit-plan-42', 1);
    writeResult(dir, 'audit-plan-42', 2);
    fs.writeFileSync(path.join(dir, 'audit-plan-42-ledger.json'), JSON.stringify({
      version: 1,
      entries: [{ topicId: 't1', severity: 'HIGH', adjudicationOutcome: 'accepted', remediationState: 'fixed', resolvedRound: 1 }],
    }));
    const out = JSON.parse(run(['--sid', 'audit-plan-42', '--dir', dir, '--json']));
    assert.equal(out.mode, 'plan');
    assert.equal(out.rounds, 2);
    assert.equal(out.resolutions, 1);
    const t = JSON.parse(fs.readFileSync(path.join(dir, 'audit-plan-42-transcript.json'), 'utf-8'));
    assert.deepEqual(t.code_files, []);
    assert.deepEqual(t.rounds.map(r => r.round), [1, 2]);
  });

  it('exits non-zero when the session has no round results', () => {
    const dir = tmpdir();
    assert.throws(
      () => run(['--sid', 'audit-code-none', '--dir', dir]),
      (err) => err.status === 1 && /no round results/.test(String(err.stderr)),
    );
  });

  it('refuses to guess the mode for an unrecognised session id', () => {
    const dir = tmpdir();
    const p = writeResult(dir, 'freeform', 1);
    assert.throws(
      () => run(['--result', p, '--out', path.join(dir, 't.json')]),
      (err) => err.status === 2 && /could not infer --mode/.test(String(err.stderr)),
    );
  });

  it('rejects an unknown flag instead of ignoring it', () => {
    assert.throws(
      () => run(['--sid', 'x', '--nope']),
      (err) => err.status === 2 && /unknown flag/.test(String(err.stderr)),
    );
  });
});

describe('the transcript cannot silently lose its scope or mix two sessions', () => {
  const run = (args) => execFileSync(process.execPath, [CLI, ...args], {
    encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
  });

  it('refuses --sid together with --result rather than letting one win', () => {
    // Round-1 audit M5/M9: explicit results silently REPLACED sid discovery, so
    // a transcript could carry rounds belonging to a different audit.
    const dir = tmpdir();
    const p = writeResult(dir, 'audit-code-5', 1);
    assert.throws(
      () => run(['--sid', 'audit-code-5', '--dir', dir, '--result', p]),
      (err) => err.status === 2 && /mutually exclusive/.test(String(err.stderr)),
    );
  });

  it('refuses a code-mode transcript with no --changed', () => {
    // M8: an empty changed_files makes the reviewer's scope filter a no-op, and
    // the advertised one-flag form reached that state by construction.
    const dir = tmpdir();
    writeResult(dir, 'audit-code-6', 1);
    assert.throws(
      () => run(['--sid', 'audit-code-6', '--dir', dir]),
      (err) => err.status === 2 && /--changed is required in code mode/.test(String(err.stderr)),
    );
  });

  it('allows the unscoped review only when asked for explicitly', () => {
    const dir = tmpdir();
    writeResult(dir, 'audit-code-7', 1);
    const out = JSON.parse(run(['--sid', 'audit-code-7', '--dir', dir, '--no-scope-filter', '--json']));
    assert.equal(out.changedFiles, 0);
  });

  it('plan mode is exempt — its changed_files is empty by contract', () => {
    // Vacuous-pass guard: if the new refusal fired on plan mode too, the plan
    // gate would be unrunnable while the code tests above still passed.
    const dir = tmpdir();
    writeResult(dir, 'audit-plan-8', 1);
    const out = JSON.parse(run(['--sid', 'audit-plan-8', '--dir', dir, '--json']));
    assert.equal(out.mode, 'plan');
    assert.equal(out.changedFiles, 0);
  });
});

describe('readRoundResult round precedence', () => {
  // Round-2 audit M2/M5: the resolved round was computed and then immediately
  // clobbered by the spread that followed it, so a payload carrying an explicit
  // `round: undefined` lost the filename-derived value the docblock promises.
  it('falls back to the filename when the payload carries round: undefined', () => {
    const dir = tmpdir();
    const p = path.join(dir, 'audit-code-3-r7-result.json');
    fs.writeFileSync(p, JSON.stringify({ round: undefined, findings: [] }));
    // JSON drops an undefined value, so also cover the explicit-null payload.
    assert.equal(readRoundResult(p).round, 7);

    const q = path.join(dir, 'audit-code-3-r8-result.json');
    fs.writeFileSync(q, JSON.stringify({ round: null, findings: [] }));
    assert.equal(readRoundResult(q).round, 8, 'a null payload round must not beat the filename');
  });

  it('still lets an explicit payload round win when it is real', () => {
    // Vacuous-pass guard: a fix that always preferred the filename would pass
    // the test above while discarding a genuine payload round.
    const dir = tmpdir();
    const p = path.join(dir, 'audit-code-4-r1-result.json');
    fs.writeFileSync(p, JSON.stringify({ round: 5, findings: [] }));
    assert.equal(readRoundResult(p).round, 5);
  });
});

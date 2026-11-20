/**
 * docs/plans/solo-control-hardening.md — one red-then-green test per fix, each with a negative control (the guard
 * stays quiet on the healthy input). Pure guards are tested directly; the subcommand-level behaviour (policy refusal,
 * flag validation, the score pairing refusal) runs the real CLI in a TEMP cwd so no real artifact is touched.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

import { parseCsv, csvField, csvLine } from '../scripts/lib/solo-control/csv.mjs';
import {
  positiveInt, nonNegativeNumber, budgetVerdict, sheetPairingProblems, validateGradings, findingsDigest,
  geminiFindingsOrMiss, assertResumableProvenance, coldPassOutcome, judgeResumeIdentity,
} from '../scripts/lib/solo-control/hardening-guards.mjs';
import { _internals as soloCtl } from '../scripts/solo-control-audit.mjs';
import { claimConflictBucket, resolveRedoRows } from '../scripts/lib/campaign/redo.mjs';
import { othersFor } from '../scripts/lib/fleet/facts.mjs';
import { decideClaim } from '../scripts/lib/fleet/overlap.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

// ── CSV (H8) ────────────────────────────────────────────────────────────────
describe('csv: RFC 4180 round trip', () => {
  const rows = [['F001', 'abc12345', 'HIGH', 'k', 'f.mjs', 'it said "x", then\nbroke'], ['F002', 'abc12345', 'LOW', 'k', 'g', '']];
  test('quotes, commas and line breaks survive write → read (the old parser dropped every quote and tore the record)', () => {
    assert.deepEqual(parseCsv(rows.map(csvLine).join('\n') + '\n'), rows);
  });
  test('negative control: a plain field is written bare and read back unchanged', () => {
    assert.equal(csvField('plain'), 'plain');
    assert.deepEqual(parseCsv('a,b\r\nc,d\r\n\r\n'), [['a', 'b'], ['c', 'd']]);
  });
  test('an unterminated quote is corrupt, not a guess', () => { assert.throws(() => parseCsv('a,"b\nc'), /unterminated/); });
});

// ── flags (H15/H18) ─────────────────────────────────────────────────────────
describe('numeric flags', () => {
  test('positiveInt refuses 0, negatives, fractions, junk and empty (0 looped the paid judge forever)', () => {
    for (const bad of ['0', '-1', '1.5', 'abc', '', null, '1e3']) assert.throws(() => positiveInt(bad, 'batch-size'), /--batch-size must be a positive integer/);
  });
  test('negative control: a normal value passes', () => { assert.equal(positiveInt('40', 'batch-size'), 40); });
  test('a budget must be finite and >= 0 (NaN never breached); 0 stays legal', () => {
    for (const bad of ['NaN', 'abc', '-5', '', 'Infinity']) assert.throws(() => nonNegativeNumber(bad, 'budget-usd'), /--budget-usd must be a finite number/);
    assert.equal(nonNegativeNumber('0', 'budget-usd'), 0);
    assert.equal(nonNegativeNumber('350', 'budget-usd'), 350);
  });
});

// ── budget (H5/H17) ─────────────────────────────────────────────────────────
describe('budgetVerdict: unpriced means unmeasured, never zero', () => {
  const row = (callId, costUsd, state = 'ok', usage = { input_tokens: 1, output_tokens: 1 }) => ({ callId, costUsd, state, usage });
  test('known spend under the cap + a call that reached the provider unpriced ⇒ stop (the old check passed)', () => {
    const v = budgetVerdict([row('a', 1), row('b', null)], 350);
    assert.equal(v.reason, 'unmeasured');
    assert.equal(v.unmeasured, 1);
  });
  test('negative control: every row priced and under the cap ⇒ no breach', () => { assert.equal(budgetVerdict([row('a', 1), row('b', 2)], 350), null); });
  test('negative control: a provider-error row with NO usage is not an unmeasured spend (it would wedge the run on its own failure)', () => {
    assert.equal(budgetVerdict([row('a', 1), row('b', null, 'provider-error', null)], 350), null);
  });
  test('a provider-error row that DID report usage but no price is unmeasured', () => {
    assert.equal(budgetVerdict([row('b', null, 'provider-error')], 350).reason, 'unmeasured');
  });
  test('the ceiling still wins and reports the floor', () => {
    const v = budgetVerdict([row('a', 400), row('b', null)], 350);
    assert.deepEqual([v.reason, v.complete], ['ceiling', false]);
  });
  test('last row per callId wins: a priced re-run supersedes its unpriced first attempt (the old budget kept the FIRST)', () => {
    assert.equal(budgetVerdict([row('a', null), row('a', 2)], 350), null);
  });
});

// ── sheet/map pairing (H6/H9/H24/H25) ───────────────────────────────────────
describe('sheetPairingProblems', () => {
  const map = { F001: { commit: 'abc12345def', severity: 'HIGH', category: 'k' }, F002: { commit: 'abc12345def', severity: 'LOW', category: 'k' } };
  const sheet = [{ blindId: 'F001', commit: 'abc12345', severity: 'HIGH', category: 'k' }, { blindId: 'F002', commit: 'abc12345', severity: 'LOW', category: 'k' }];
  test('negative control: a matching pair is clean', () => { assert.deepEqual(sheetPairingProblems(map, sheet), []); });
  test('a deleted ungraded row is a problem (it used to vanish from the denominator)', () => {
    assert.match(sheetPairingProblems(map, sheet.slice(0, 1)).join(), /missing from the sheet.*F002/);
  });
  test('an id the map does not know, and a duplicate id', () => {
    assert.match(sheetPairingProblems(map, [...sheet, { ...sheet[0], blindId: 'F009' }]).join(), /not in the map.*F009/);
    assert.match(sheetPairingProblems(map, [...sheet, sheet[0]]).join(), /duplicate blind_id.*F001/);
  });
  test('a NEW sheet beside an OLD map (same ids, different findings) is a problem', () => {
    assert.match(sheetPairingProblems(map, [{ ...sheet[0], severity: 'LOW' }, sheet[1]]).join(), /different merges/);
  });
});

// ── judge (H14/H30) ─────────────────────────────────────────────────────────
describe('judge guards', () => {
  test('validateGradings drops ids outside the batch and repeats; keeps the rest', () => {
    const { valid, rejected } = validateGradings([{ blind_id: 'F001' }, { blind_id: 'F999' }, { blind_id: 'F001' }, { blind_id: 'F002' }], ['F001', 'F002']);
    assert.deepEqual(valid.map((g) => g.blind_id), ['F001', 'F002']);
    assert.deepEqual(rejected, ['F999', 'F001']);
  });
  test('negative control: an exact batch passes untouched', () => {
    assert.equal(validateGradings([{ blind_id: 'F001' }], ['F001']).rejected.length, 0);
  });
  test('judgeResumeIdentity: a changed model or rubric invalidates the prior grades; same / legacy do not', () => {
    const cur = { model: 'gpt-x', knownDefectsSha256: 'h' };
    assert.equal(judgeResumeIdentity({ model: 'gpt-y', knownDefectsSha256: 'h' }, cur).ok, false);
    assert.equal(judgeResumeIdentity({ model: 'gpt-x', knownDefectsSha256: 'z' }, cur).ok, false);
    assert.deepEqual(judgeResumeIdentity({ ...cur }, cur), { ok: true });
    const legacy = judgeResumeIdentity(null, cur);
    assert.equal(legacy.ok, true);
    assert.match(legacy.note, /unverifiable/);
  });
});

// ── resume identity (H11/H20) ───────────────────────────────────────────────
describe('assertResumableProvenance', () => {
  const prior = { provenance: { resolvedModel: 'm1', reasoningEffort: null, repeats: 1, maxChars: 45000 }, perCommit: [{ sha: 'a', state: 'ran' }] };
  const same = { resolvedModel: 'm1', reasoningEffort: null, repeats: 1, maxChars: 45000 };
  test('negative control: the same configuration resumes', () => { assert.doesNotThrow(() => assertResumableProvenance(prior, same, false)); });
  test('a changed model, effort, repeats or chunk size is refused (it spliced two measurements into one arm)', () => {
    for (const [k, v] of [['resolvedModel', 'm2'], ['reasoningEffort', 'xhigh'], ['repeats', 3], ['maxChars', 9000]]) {
      assert.throws(() => assertResumableProvenance(prior, { ...same, [k]: v }, false), new RegExp(`${k}.*--force`, 's'));
    }
  });
  test('--force, no prior, no ran units, or a field the prior never recorded are all fine', () => {
    assert.doesNotThrow(() => assertResumableProvenance(prior, { ...same, resolvedModel: 'm2' }, true));
    assert.doesNotThrow(() => assertResumableProvenance(null, same, false));
    assert.doesNotThrow(() => assertResumableProvenance({ ...prior, perCommit: [{ sha: 'a', state: 'budget-exceeded' }] }, { ...same, repeats: 9 }, false));
    assert.doesNotThrow(() => assertResumableProvenance({ ...prior, provenance: { resolvedModel: 'm1' } }, { ...same, repeats: 9 }, false));
  });
});

// ── pre-gate artifact binding (H21) ─────────────────────────────────────────
test('findingsDigest binds the findings: editing one changes the digest', () => {
  const f = [{ category: 'a', detail: 'x' }];
  assert.equal(findingsDigest(f), findingsDigest([{ category: 'a', detail: 'x' }]));
  assert.notEqual(findingsDigest(f), findingsDigest([{ category: 'a', detail: 'y' }]));
});

// ── provider failure vs conformance miss (H4/H19) ───────────────────────────
describe('cold pass: no reply is a provider error, not "the model found nothing"', () => {
  test('coldPassOutcome truth table', () => {
    assert.equal(coldPassOutcome({ gotReply: false, conformant: false }), 'provider-error');
    assert.equal(coldPassOutcome({ gotReply: true, conformant: false }), 'conformance-miss');
    assert.equal(coldPassOutcome({ gotReply: true, conformant: true }), 'ok');
  });
  const diff = 'diff --git a/x b/x\n+1\n';
  test('runPass: both attempts throw (401/429/5xx) ⇒ providerError, NOT conformanceMiss', async () => {
    const client = { messages: { create: async () => { throw new Error('401 invalid x-api-key'); } } };
    const r = await soloCtl.runPass(client, 'claude-x', 'structure', diff);
    assert.equal(r.providerError, true);
    assert.equal(r.conformanceMiss, undefined);
    assert.deepEqual(r.findings, []);
  });
  test('negative control: a reply that is not JSON is still a conformance miss, billed', async () => {
    const client = { messages: { create: async () => ({ content: [{ type: 'text', text: 'not json' }], usage: { input_tokens: 5, output_tokens: 2 } }) } };
    const r = await soloCtl.runPass(client, 'claude-x', 'structure', diff);
    assert.equal(r.conformanceMiss, true);
    assert.equal(r.providerError, undefined);
    assert.deepEqual(r.usage, { input_tokens: 10, output_tokens: 4 }, 'both attempts billed');
  });
  test('first attempt throws, second replies conformant ⇒ ok (a retry that recovers is not an error)', async () => {
    let n = 0;
    const client = { messages: { create: async () => { if (++n === 1) throw new Error('503'); return { content: [{ type: 'text', text: '{"findings":[],"summary":"clean"}' }], usage: { input_tokens: 1, output_tokens: 1 } }; } } };
    const r = await soloCtl.runPass(client, 'claude-x', 'structure', diff);
    assert.equal(r.providerError, undefined);
    assert.equal(r.conformanceMiss, undefined);
  });
  test('runDeepseekPass has the same split', async () => {
    const client = { chat: { completions: { create: async () => { throw new Error('402 Insufficient Balance'); } } } };
    const r = await soloCtl.runDeepseekPass(client, 'deepseek-flash', 'structure', diff);
    assert.equal(r.providerError, true);
    assert.equal(r.conformanceMiss, undefined);
  });
});

// ── Gemini schema (M2) ──────────────────────────────────────────────────────
describe('geminiFindingsOrMiss', () => {
  const schema = z.object({ findings: z.array(z.object({ a: z.string() })) });
  test('a parseable object WITHOUT findings is a conformance miss, not a clean "found nothing"', () => {
    assert.equal(geminiFindingsOrMiss('{"summary":"x"}', schema).state, 'conformance-miss');
    assert.equal(geminiFindingsOrMiss('not json', schema).state, 'conformance-miss');
    assert.equal(geminiFindingsOrMiss('{"findings":[{"a":1}]}', schema).state, 'conformance-miss');
  });
  test('negative control: a conformant reply (even with zero findings) carries no state', () => {
    assert.deepEqual(geminiFindingsOrMiss('{"findings":[]}', schema), { findings: [] });
    assert.deepEqual(geminiFindingsOrMiss('{"findings":[{"a":"x"}]}', schema).findings, [{ a: 'x' }]);
  });
});

// ── redo (H3/H28) ───────────────────────────────────────────────────────────
describe('campaign redo', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const base = { redo: [id], reason: 'why', candidates: [{ findingId: id, worksheetRowId: 'wr-1' }], blindRows: { rows: [{ worksheet_row_id: 'wr-1' }] } };
  test('an unreadable human-disposition guard that returns an EMPTY id set still refuses (it used to permit the redo)', async () => {
    const r = await resolveRedoRows({ ...base, findingsWithHumanDisposition: async () => ({ ok: false, ids: new Set() }) });
    assert.equal(r.ok, false);
    assert.match(r.error, /could not be read, so every id is refused.*11111111/s);
  });
  test('negative control: a readable guard with no human disposition permits it', async () => {
    const r = await resolveRedoRows({ ...base, findingsWithHumanDisposition: async () => ({ ok: true, ids: new Set() }) });
    assert.equal(r.ok, true);
  });
  test('claimConflictBucket: only an existing claim is a benign skip; a filesystem failure is not', () => {
    assert.equal(claimConflictBucket({ ok: true }), null);
    assert.equal(claimConflictBucket({ ok: false, code: 'claimed' }), 'skipped');
    assert.throws(() => claimConflictBucket({ ok: false, code: 'EACCES' }), /not a benign skip/);
  });
});

// ── recordRuleState race (H2) ───────────────────────────────────────────────
describe('recordRuleState: a concurrent writer is detected, not recorded as clean', () => {
  const rule = { x: 1 };
  test('another runner appended between our read and our write ⇒ ok:false', async () => {
    const { recordRuleState } = await import('../scripts/campaign.mjs');
    const rows = [];
    const listEvents = async () => ({ cloud: true, rows: [...rows] });
    const appendEvent = async (e) => { rows.push(e); rows.push({ kind: 'rule_registered' }); return { ok: true }; }; // we + a racer
    const r = await recordRuleState({ config: { ...rule }, campaignId: 'cid', actor: null }, { listEvents, appendEvent });
    assert.equal(r.ok, false);
    assert.match(r.error, /concurrently/);
  });
  test('negative control: a lone writer is clean', async () => {
    const { recordRuleState } = await import('../scripts/campaign.mjs');
    const rows = [];
    const r = await recordRuleState({ config: {}, campaignId: 'cid', actor: null }, {
      listEvents: async () => ({ cloud: true, rows: [...rows] }), appendEvent: async (e) => { rows.push(e); return { ok: true }; },
    });
    assert.equal(r.ok, true);
    assert.equal(r.kind, 'rule_registered');
  });
});

// ── fleet unknown state (M1) ────────────────────────────────────────────────
describe('fleet: an absent uncommitted entry is unknown, never "no files"', () => {
  const now = new Date('2026-11-20T12:00:00Z');
  const session = { id: 'late', state: 'working', intent: 'other', paths: ['zzz/**'], source: { kind: 'branch', branch: 'late' }, lastSeen: now.toISOString(), leaseExpiresAt: new Date(now.getTime() + 3600e3).toISOString() };
  const facts = (uncommitted) => ({ registry: { sessions: [session] }, branches: { branches: [] }, leaseMs: 4 * 3600e3, uncommitted });
  test('a branch ABSENT from gathered uncommitted facts reads uncommittedUnknown', () => {
    const [o] = othersFor(facts({ other: { queried: true, files: [] } }), 'me', now, [session]);
    assert.match(o.uncommittedUnknown, /not measured/);
    assert.deepEqual(o.uncommittedFiles, []);
  });
  test('negative control: a queried (even empty) entry is known', () => {
    const [o] = othersFor(facts({ late: { queried: true, files: [] } }), 'me', now, [session]);
    assert.equal(o.uncommittedUnknown, undefined);
  });
  test('the unknown reaches decideClaim as a disclosed `uninspected` entry (advisory evidence: disclosed, never a block — pinned by fleet-lifecycle)', () => {
    const claim = { id: 'me', intent: 'mine', paths: ['a/**'], knownOverlaps: [] };
    const [o] = othersFor(facts({ other: { queried: true, files: [] } }), 'me', now, [session]);
    const v = decideClaim({ claim, mode: 'new', others: [{ ...o, live: true }], complete: true });
    assert.equal(v.uninspected?.[0]?.with, 'late', 'the absent entry used to be [] with no disclosure at all');
    assert.equal(v.ok, true);
  });
});

// ── CLI behaviour (real subprocess, temp cwd) ───────────────────────────────
function inTemp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'solo-hardening-'));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
}
/** Inert placeholder keys: a regressed guard turns into a fast 401, never spend. The repo is found via
 * SOLO_CONTROL_REPO_ROOTS while OUT_DIR resolves under the temp cwd, so no real artifact is touched. */
function cli(cwd, args, extraEnv = {}) {
  const env = {
    ...process.env, OPENAI_API_KEY: 'scrubbed', ANTHROPIC_API_KEY: 'scrubbed', GEMINI_API_KEY: 'scrubbed', DEEPSEEK_API_KEY: 'scrubbed',
    OPENROUTER_API_KEY: 'scrubbed', CLAUDE_BACKEND: 'sdk', SOLO_CONTROL_REPO_ROOTS: REPO_ROOT, MODEL_CATALOG_REFRESH: 'skip', ...extraEnv,
  };
  const r = spawnSync('node', [path.join(REPO_ROOT, 'scripts/solo-control-audit.mjs'), ...args], { cwd, encoding: 'utf8', env });
  return { out: `${r.stdout || ''}${r.stderr || ''}`, stdout: r.stdout || '', status: r.status };
}
const HEAD = spawnSync('git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
const refusingPolicy = (dir) => {
  const p = path.join(dir, 'policy.json');
  fs.writeFileSync(p, JSON.stringify({ version: 2, repos: { 'github.com/nobody/else': ['openai', 'gemini', 'openrouter', 'anthropic'] } }));
  return { SOLO_CONTROL_RECIPIENT_POLICY_PATH: p };
};

describe('CLI: flags are validated before any work (exit 2)', () => {
  for (const [args, re] of [
    [['judge-gpt', '--batch-size', '0'], /--batch-size must be a positive integer/],
    [['judge-gpt', '--max-diff-chars', 'abc'], /--max-diff-chars must be a positive integer/],
    [['run', '--commits', HEAD, '--max-chars', '0'], /--max-chars must be a positive integer/],
    [['apparatus', '--commits', HEAD, '--budget-usd', 'NaN'], /--budget-usd must be a finite number/],
    [['apparatus-bc', '--commits', HEAD, '--max-chars', '-3'], /--max-chars must be a positive integer/],
  ]) {
    test(`${args.join(' ')}`, () => inTemp((dir) => {
      const r = cli(dir, args);
      assert.equal(r.status, 2, r.out);
      assert.match(r.out, re);
    }));
  }
});

describe('CLI: every command that sends a diff consults the recipient policy (H1/H16)', () => {
  test('apparatus-bc: a repo the policy does not list is refused, nothing sent, both arms record policy-refused', () => inTemp((dir) => {
    const r = cli(dir, ['apparatus-bc', '--commits', HEAD], refusingPolicy(dir));
    assert.match(r.out, /POLICY REFUSED/, r.out);
    for (const arm of ['B', 'C']) {
      const f = JSON.parse(fs.readFileSync(path.join(dir, `.audit-loop/solo-control/S-findings-${arm}.json`), 'utf8'));
      assert.equal(f.perCommit[0].state, 'policy-refused');
      assert.equal(f.findings.length, 0);
    }
  }));
  test('sonnet-gemini-retro', () => inTemp((dir) => {
    const out = path.join(dir, '.audit-loop/solo-control'); fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'S-findings-S-sonnet.json'), JSON.stringify({ findings: [{ commit: HEAD, severity: 'HIGH', category: 'c', section: 's', detail: 'd' }] }));
    const r = cli(dir, ['sonnet-gemini-retro', '--commits', HEAD], refusingPolicy(dir));
    assert.match(r.out, /POLICY REFUSED/, r.out);
    assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'S-findings-SG-gemini-only.json'), 'utf8')).perCommit[0].state, 'policy-refused');
  }));
  for (const engine of ['gpt', 'gemini']) {
    test(`solo-pass-retro --engine ${engine}`, () => inTemp((dir) => {
      const r = cli(dir, ['solo-pass-retro', '--commits', HEAD, '--engine', engine], refusingPolicy(dir));
      assert.match(r.out, /POLICY REFUSED/, r.out);
    }));
  }
  test('judge-gpt: the commit is refused, its rows stay ungraded, and nothing was sent', () => inTemp((dir) => {
    const out = path.join(dir, '.audit-loop/solo-control'); fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'blind-adjudication.csv'), csvLine(['blind_id', 'commit', 'severity', 'category', 'file', 'detail', 'label', 'proof', 'cluster', 'matches', 'pattern']) + '\n'
      + csvLine(['F001', HEAD.slice(0, 8), 'HIGH', 'k', 'f', 'd', '', '', 'c', '', '']) + '\n');
    const r = cli(dir, ['judge-gpt'], refusingPolicy(dir));
    assert.match(r.out, /POLICY REFUSED/, r.out);
    assert.match(r.out, /0\/1 graded/);
  }));
  test('a missing policy file is fatal for them too (exit 2), never "no restriction"', () => inTemp((dir) => {
    const r = cli(dir, ['apparatus-bc', '--commits', HEAD], { SOLO_CONTROL_RECIPIENT_POLICY_PATH: path.join(dir, 'nope.json') });
    assert.equal(r.status, 2, r.out);
    assert.match(r.out, /recipient policy unavailable/);
  }));
});

describe('CLI score: the sheet and the private map must be a pair (H6/H9/H24/H25) and the CSV must round-trip (H8)', () => {
  const header = ['blind_id', 'commit', 'severity', 'category', 'file', 'detail', 'label', 'proof', 'cluster', 'matches', 'pattern'];
  const mkRow = (id, arm, label) => ({
    csv: csvLine([id, 'abc12345', 'HIGH', 'cat', 'f.mjs', 'detail with "quotes",\nand a break', label, 'f:1', `c-${id}`, '', '']),
    map: { arm, commit: 'abc12345def', severity: 'HIGH', category: 'cat', dup: id, sheetTier: 'auto', inclusionProb: 1 },
  });
  const setup = (dir, rows, mapRows = rows) => {
    const out = path.join(dir, '.audit-loop/solo-control'); fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'blind-adjudication.csv'), `${csvLine(header)}\n${rows.map((r) => r.csv).join('\n')}\n`);
    fs.writeFileSync(path.join(out, '.blind-map.json'), JSON.stringify({ commits: ['abc12345def'], map: Object.fromEntries(mapRows.map((r, i) => [`F00${i + 1}`, r.map])) }));
  };
  const two = [mkRow('F001', 'A', 'proven'), mkRow('F002', 'S-sonnet', '')];
  test('negative control: a complete pair scores; stdout is one complete JSON document; a multi-line quoted detail does not tear the row', () => inTemp((dir) => {
    setup(dir, two);
    const r = cli(dir, ['score']);
    assert.equal(r.status, 0, r.out);
    const rep = JSON.parse(r.stdout);
    assert.equal(rep.labelCoverage, 0.5, 'F002 is genuinely unlabeled; F001 was read as ONE row');
  }));
  test('a deleted ungraded row is refused (exit 4) instead of scoring a finished-looking sheet', () => inTemp((dir) => {
    setup(dir, [two[0]], two);
    const r = cli(dir, ['score']);
    assert.equal(r.status, 4, r.out);
    assert.match(r.out, /missing from the sheet.*F002/s);
  }));
});

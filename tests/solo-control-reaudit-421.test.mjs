/**
 * Re-audit of #421 (docs/plans/solo-control-hardening.md §7): one red-then-green test per confirmed finding, each with a
 * negative control. CLI cases run in a TEMP cwd with inert keys (a regressed guard becomes a fast 401, never spend).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { csvLine, parseCsv } from '../scripts/lib/solo-control/csv.mjs';
import * as guards from '../scripts/lib/solo-control/hardening-guards.mjs'; // namespace: a guard absent from an older tree fails ITS test, not the whole file
const { sheetPairingProblems, decisionArms, protectedOutputProblem, judgeGradeVerdict } = guards;
import { resolveRedoRows } from '../scripts/lib/campaign/redo.mjs';
import { resolveModel } from '../scripts/lib/model-resolver.mjs';
import { _internals as soloCtl } from '../scripts/solo-control-audit.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const HEAD = spawnSync('git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
const HEADER = ['blind_id', 'commit', 'severity', 'category', 'file', 'detail', 'label', 'proof', 'cluster', 'matches', 'pattern'];

function inTemp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'solo-reaudit-'));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
}
function cli(cwd, args, extraEnv = {}) {
  const env = {
    ...process.env, OPENAI_API_KEY: 'scrubbed', ANTHROPIC_API_KEY: 'scrubbed', GEMINI_API_KEY: 'scrubbed', DEEPSEEK_API_KEY: 'scrubbed',
    OPENROUTER_API_KEY: 'scrubbed', CLAUDE_BACKEND: 'sdk', SOLO_CONTROL_REPO_ROOTS: REPO_ROOT, MODEL_CATALOG_REFRESH: 'skip', ...extraEnv,
  };
  const r = spawnSync('node', [path.join(REPO_ROOT, 'scripts/solo-control-audit.mjs'), ...args], { cwd, encoding: 'utf8', env });
  return { out: `${r.stdout || ''}${r.stderr || ''}`, stdout: r.stdout || '', status: r.status };
}
const refusingPolicy = (dir) => {
  const p = path.join(dir, 'policy.json');
  fs.writeFileSync(p, JSON.stringify({ version: 2, repos: { 'github.com/nobody/else': ['openai', 'gemini', 'openrouter', 'anthropic'] } }));
  return { SOLO_CONTROL_RECIPIENT_POLICY_PATH: p };
};
const solo = (dir) => { const d = path.join(dir, '.audit-loop/solo-control'); fs.mkdirSync(d, { recursive: true }); return d; };

describe('judge-gpt: the judge identity rides IN each graded row (no second file to tear)', () => {
  const current = () => `${resolveModel('latest-gpt')}|${createHash('sha256').update('').digest('hex').slice(0, 16)}`;
  const setup = (dir, identity) => {
    const d = solo(dir);
    fs.writeFileSync(path.join(d, 'blind-adjudication.csv'), `${csvLine(HEADER)}\n${csvLine(['F001', HEAD.slice(0, 8), 'HIGH', 'k', 'f', 'd', '', '', 'c1', '', ''])}\n`);
    fs.writeFileSync(path.join(d, 'out.csv'), `${csvLine([...HEADER, 'judge_identity'])}\n${csvLine(['F001', HEAD.slice(0, 8), 'HIGH', 'k', 'f', 'd', 'proven', 'f:1', `${HEAD.slice(0, 8)}:b0:c1`, '', '', identity])}\n`);
    return d;
  };
  test('a grade made under a DIFFERENT judge is discarded and re-graded (here: refused by policy, so ungraded)', () => inTemp((dir) => {
    const d = setup(dir, 'gpt-OLD|0000');
    const r = cli(dir, ['judge-gpt', '--out', 'out.csv'], refusingPolicy(dir));
    assert.match(r.out, /different judge model or known-defect rubric/, r.out);
    const [, row] = parseCsv(fs.readFileSync(path.join(d, 'out.csv'), 'utf8'));
    assert.equal(row[6], '', 'the stale grade is gone');
  }));
  test('negative control: a grade made under THIS judge is kept and the commit is skipped as already graded', () => inTemp((dir) => {
    const d = setup(dir, current());
    const r = cli(dir, ['judge-gpt', '--out', 'out.csv'], refusingPolicy(dir));
    assert.match(r.out, /already graded/, r.out);
    const [header, row] = parseCsv(fs.readFileSync(path.join(d, 'out.csv'), 'utf8'));
    assert.equal(row[6], 'proven');
    assert.equal(row[header.indexOf('judge_identity')], current(), 'identity is written with the grade, in the same file');
    assert.ok(!fs.existsSync(path.join(d, 'out.csv.meta.json')), 'no sidecar');
  }));
  test('a graded row in an identity-bearing file with NO identity is not trusted; a column-less legacy file is kept (flagged)', () => {
    assert.equal(judgeGradeVerdict({ hasColumn: true, rowIdentity: '', current: 'm|h' }), 'discard');
    assert.equal(judgeGradeVerdict({ hasColumn: false, rowIdentity: undefined, current: 'm|h' }), 'legacy');
  });
});

describe('judge-gpt --out may never be a protected sheet', () => {
  test('a COPIED input with --out pointing at the canonical labelled sheet is refused and the canonical is untouched', () => inTemp((dir) => {
    const d = solo(dir);
    const text = `${csvLine(HEADER)}\n${csvLine(['F001', HEAD.slice(0, 8), 'HIGH', 'k', 'f', 'd', 'proven', 'f:1', 'c1', '', ''])}\n`;
    fs.writeFileSync(path.join(d, 'blind-adjudication.csv'), text);
    fs.writeFileSync(path.join(d, 'copy.csv'), text);
    const r = cli(dir, ['judge-gpt', '--csv', path.join(d, 'copy.csv'), '--out', 'blind-adjudication.csv', '--force'], refusingPolicy(dir));
    assert.equal(r.status, 2, r.out);
    assert.match(r.out, /would overwrite it/);
    assert.equal(fs.readFileSync(path.join(d, 'blind-adjudication.csv'), 'utf8'), text);
  }));
  test('unit + negative control', () => {
    assert.ok(protectedOutputProblem('/a/x.csv', ['/a/y.csv', '/a/x.csv'], path.resolve));
    assert.equal(protectedOutputProblem('/a/z.csv', ['/a/y.csv', '/a/x.csv'], path.resolve), null);
  });
});

describe('score --decide cohort covers every arm in the merged sheet', () => {
  test('decisionArms: a completed arm with no included finding is still a cohort member', () => {
    assert.deepEqual(decisionArms({ A: {} }, { A: {}, 'S-empty': {} }).sort(), ['A', 'S-empty']);
    assert.deepEqual(decisionArms({ A: {} }, {}), ['A'], 'negative control');
  });
  test('end to end: the decision ledger lists the arm that found nothing', () => inTemp((dir) => {
    const d = solo(dir);
    fs.writeFileSync(path.join(d, 'blind-adjudication.csv'), `${csvLine(HEADER)}\n${csvLine(['F001', 'abc12345', 'HIGH', 'cat', 'f.mjs', 'detail', 'proven', 'f:1', 'c1', '', ''])}\n`);
    fs.writeFileSync(path.join(d, '.blind-map.json'), JSON.stringify({
      commits: ['abc12345def'], armMeta: { A: {}, 'S-empty': {} },
      map: { F001: { arm: 'A', commit: 'abc12345def', severity: 'HIGH', category: 'cat', dup: 'x', sheetTier: 'auto', inclusionProb: 1 } },
    }));
    const r = cli(dir, ['score', '--decide']);
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(Object.keys(JSON.parse(r.stdout).decision.ledger.costPerDiff).sort(), ['A', 'S-empty']);
  }));
});

describe('apparatus --gate-only: a legacy artifact with NO recorded chunk count is refused', () => {
  const run = (dir, over) => {
    const gateContext = 'diff --git a/x b/x\n+1\n';
    const a = { sha: HEAD, repo: 'r', files: ['x'], findings: [], gateContext, gateContextSha256: createHash('sha256').update(gateContext).digest('hex'), ...over };
    fs.writeFileSync(path.join(solo(dir), `S-pregate-A-${HEAD}.json`), JSON.stringify(a));
    return cli(dir, ['apparatus', '--commits', HEAD, '--gate-only', '--label', 'A-test'], refusingPolicy(dir));
  };
  test('no passChunks and no gateContextScope ⇒ chunk-0-only refusal', () => inTemp((dir) => {
    assert.match(run(dir, {}).out, /holds only chunk 0/);
  }));
  test('negative control: a recorded single chunk is fine and reaches the policy stage', () => inTemp((dir) => {
    const out = run(dir, { passChunks: 1 }).out;
    assert.doesNotMatch(out, /holds only chunk 0/);
    assert.match(out, /POLICY REFUSED/);
  }));
});

describe('redo: an uppercase uuid resolves (it passed validation then missed the lookup)', () => {
  const id = 'aaaaaaaa-1111-4111-8111-bbbbbbbbbbbb';
  const base = { reason: 'why', candidates: [{ findingId: id, worksheetRowId: 'wr-1' }], blindRows: { rows: [{ worksheet_row_id: 'wr-1' }] }, findingsWithHumanDisposition: async () => ({ ok: true, ids: new Set() }) };
  test('uppercase resolves', async () => { assert.equal((await resolveRedoRows({ ...base, redo: [id.toUpperCase()] })).ok, true); });
  test('negative control: a genuinely unknown id is still refused', async () => {
    const r = await resolveRedoRows({ ...base, redo: ['cccccccc-1111-4111-8111-bbbbbbbbbbbb'.toUpperCase()] });
    assert.equal(r.ok, false);
    assert.match(r.error, /not in this cohort/);
  });
});

describe('merge refuses to discard human labels', () => {
  test('an existing sheet with labelled rows ⇒ exit 4 before any work', () => inTemp((dir) => {
    fs.writeFileSync(path.join(solo(dir), 'blind-adjudication.csv'), `${csvLine(HEADER)}\n${csvLine(['F001', 'abc', 'HIGH', 'k', 'f', 'd', 'proven', '', 'c', '', ''])}\n`);
    const r = cli(dir, ['merge']);
    assert.equal(r.status, 4, r.out);
    assert.match(r.out, /already holds 1 labelled row/);
  }));
  test('negative control: an UNLABELLED sheet does not trigger the guard (merge goes on to need S-findings)', () => inTemp((dir) => {
    fs.writeFileSync(path.join(solo(dir), 'blind-adjudication.csv'), `${csvLine(HEADER)}\n${csvLine(['F001', 'abc', 'HIGH', 'k', 'f', 'd', '', '', 'c', '', ''])}\n`);
    const r = cli(dir, ['merge']);
    assert.notEqual(r.status, 4);
    assert.match(r.out, /No S-findings/);
  }));
});

describe('sheet/map pairing binds the merge generation', () => {
  const map = { F001: { commit: 'abc12345def', severity: 'HIGH', category: 'k' } };
  const rows = [{ blindId: 'F001', commit: 'abc12345', severity: 'HIGH', category: 'k', file: 'f', detail: 'd' }];
  test('a sheet from a different merge (same visible findings) is refused; so is a sheet whose merge_id column was dropped', () => {
    assert.match(sheetPairingProblems(map, rows, { mapMergeId: 'M1', sheetMergeIds: ['M2'] }).join(), /different merges/);
    assert.match(sheetPairingProblems(map, rows, { mapMergeId: 'M1', sheetMergeIds: [] }).join(), /different merges/);
  });
  test('negative control: the same merge id, and a legacy map with none, are paired', () => {
    assert.deepEqual(sheetPairingProblems(map, rows, { mapMergeId: 'M1', sheetMergeIds: ['M1', 'M1'] }), []);
    assert.deepEqual(sheetPairingProblems(map, rows, { mapMergeId: null, sheetMergeIds: [] }), []);
  });
});

describe('diff extraction survives non-ASCII file names (git quoted them and the literal pathspec then matched nothing)', () => {
  test('a clean accented file is audited; a sensitive sibling is still excluded', () => inTemp((dir) => {
    const g = (...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
    g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't'); g('config', 'commit.gpgsign', 'false');
    const name = 'café.txt';
    fs.writeFileSync(path.join(dir, name), 'harmless\n');
    fs.writeFileSync(path.join(dir, '.env'), 'SECRET_THING=hunter2hunter2\n');
    g('add', '-A'); g('commit', '-q', '-m', 'x');
    const ext = soloCtl.extractDiff(dir, g('rev-parse', 'HEAD').stdout.trim());
    assert.ok(ext.files.includes(name), `files: ${JSON.stringify(ext.files)}`);
    assert.match(ext.diff, /harmless/, 'the accented file reached the diff');
    assert.ok(!ext.diff.includes('hunter2'));
  }));
});

// ── round 2 of the re-audit ─────────────────────────────────────────────────
const NL = String.fromCharCode(10);
const sheetText = (label = '', proof = '') => csvLine(HEADER) + NL + csvLine(['F001', HEAD.slice(0, 8), 'HIGH', 'k', 'f', 'd', label, proof, 'c1', '', '']) + NL;

describe('pairing edge cases', () => {
  const rows = [{ blindId: 'F001', commit: 'abc12345', severity: 'HIGH', category: 'k', file: 'f', detail: 'd' }];
  const map = { F001: { commit: 'abc12345def', severity: 'HIGH', category: 'k' } };
  test('a zero-finding merge (empty map, header-only sheet, map has a merge id) is a valid pair — not a regression', () => {
    assert.deepEqual(sheetPairingProblems({}, [], { mapMergeId: 'M1', sheetMergeIds: [] }), []);
  });
  test('a NEW sheet (merge_id) beside an OLD map (none) is refused; old + old and no-column sheets are fine', () => {
    assert.match(sheetPairingProblems(map, rows, { mapMergeId: null, sheetMergeIds: ['M2'] }).join(), /map has none/);
    assert.deepEqual(sheetPairingProblems(map, rows, { mapMergeId: null, sheetMergeIds: ['', ''] }), []);
    assert.deepEqual(sheetPairingProblems(map, rows, { mapMergeId: null, sheetMergeIds: [] }), []);
  });
});

describe('judge-gpt: grades keep THEIR identity; --force cannot destroy a graded output; aliases cannot reach a protected sheet', () => {
  const legacyOut = (dir) => { const d = solo(dir); fs.writeFileSync(path.join(d, 'blind-adjudication.csv'), sheetText()); fs.writeFileSync(path.join(d, 'out.csv'), sheetText('proven', 'f:1')); return d; };
  test('a legacy (column-less) grade is re-written as legacy-unverified, NEVER stamped with the current judge', () => inTemp((dir) => {
    const d = legacyOut(dir);
    cli(dir, ['judge-gpt', '--out', 'out.csv'], refusingPolicy(dir));
    const [header, row] = parseCsv(fs.readFileSync(path.join(d, 'out.csv'), 'utf8'));
    assert.equal(row[6], 'proven', 'the legacy grade is kept');
    assert.equal(row[header.indexOf('judge_identity')], 'legacy-unverified');
  }));
  test('--force keeps the previous graded output as <out>.prev before it can be replaced by ungraded rows', () => inTemp((dir) => {
    const d = legacyOut(dir);
    const before = fs.readFileSync(path.join(d, 'out.csv'), 'utf8');
    cli(dir, ['judge-gpt', '--out', 'out.csv', '--force'], refusingPolicy(dir));
    assert.equal(fs.readFileSync(path.join(d, 'out.csv.prev'), 'utf8'), before);
    assert.equal(parseCsv(fs.readFileSync(path.join(d, 'out.csv'), 'utf8'))[1][6], '', 'the re-grade really did replace it (policy-refused)');
  }));
  test('a directory alias for the output dir cannot name the canonical sheet under another string', (t) => inTemp((dir) => {
    const d = solo(dir);
    fs.writeFileSync(path.join(d, 'blind-adjudication.csv'), sheetText('proven', 'f:1'));
    try { fs.symlinkSync(d, path.join(dir, '.audit-loop', 'alias'), 'junction'); } catch { t.skip('cannot create a directory link here'); return; }
    const r = cli(dir, ['judge-gpt', '--out', '../alias/blind-adjudication.csv', '--force'], refusingPolicy(dir));
    assert.equal(r.status, 2, r.out);
    assert.match(r.out, /would overwrite it/);
    assert.equal(parseCsv(fs.readFileSync(path.join(d, 'blind-adjudication.csv'), 'utf8'))[1][6], 'proven');
  }));
});

describe('merge: any human-only cell is work worth protecting', () => {
  test('a sheet with a proof but NO label yet is refused', () => inTemp((dir) => {
    fs.writeFileSync(path.join(solo(dir), 'blind-adjudication.csv'), sheetText('', 'f:12 shows it'));
    const r = cli(dir, ['merge']);
    assert.equal(r.status, 4, r.out);
    assert.match(r.out, /already holds 1/);
  }));
});

describe('re-audit round 3', () => {
  const rows = [{ blindId: 'F001', commit: 'abc12345', severity: 'HIGH', category: 'k', file: 'f', detail: 'd' }, { blindId: 'F002', commit: 'abc12345', severity: 'HIGH', category: 'k', file: 'g', detail: 'e' }];
  const map = { F001: { commit: 'abc12345def', severity: 'HIGH', category: 'k' }, F002: { commit: 'abc12345def', severity: 'HIGH', category: 'k' } };
  test('a row with a BLANK merge_id beside rows carrying the current one is refused (it was filtered away)', () => {
    assert.match(sheetPairingProblems(map, rows, { mapMergeId: 'M1', sheetMergeIds: ['M1', ''] }).join(), /different merges/);
    assert.deepEqual(sheetPairingProblems(map, rows, { mapMergeId: 'M1', sheetMergeIds: ['M1', 'M1'] }), [], 'negative control');
  });
  test('the --force backup path is protected too: a copied input named <out>.prev cannot be overwritten', () => inTemp((dir) => {
    const d = solo(dir);
    fs.writeFileSync(path.join(d, 'blind-adjudication.csv'), sheetText());
    fs.writeFileSync(path.join(d, 'out.csv.prev'), sheetText('proven', 'f:1'));
    const before = fs.readFileSync(path.join(d, 'out.csv.prev'), 'utf8');
    const r = cli(dir, ['judge-gpt', '--csv', path.join(d, 'out.csv.prev'), '--out', 'out.csv', '--force'], refusingPolicy(dir));
    assert.equal(r.status, 2, r.out);
    assert.equal(fs.readFileSync(path.join(d, 'out.csv.prev'), 'utf8'), before);
  }));
  test('on a case-insensitive filesystem an upper-case spelling of the canonical sheet is the same file', (t) => inTemp((dir) => {
    if (process.platform !== 'win32' && process.platform !== 'darwin') { t.skip('case-sensitive filesystem'); return; }
    const d = solo(dir);
    fs.writeFileSync(path.join(d, 'blind-adjudication.csv'), sheetText('proven', 'f:1'));
    const r = cli(dir, ['judge-gpt', '--out', 'BLIND-ADJUDICATION.CSV', '--force'], refusingPolicy(dir));
    assert.equal(r.status, 2, r.out);
    assert.equal(parseCsv(fs.readFileSync(path.join(d, 'blind-adjudication.csv'), 'utf8'))[1][6], 'proven');
  }));
});

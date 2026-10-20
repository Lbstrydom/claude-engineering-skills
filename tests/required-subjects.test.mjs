/**
 * @fileoverview Cluster A of docs/plans/copilot-feedback-item4.md: an operator-declared `--require` list. Each subject
 * ends an audit FULL / PARTIAL / UNREAD / SENSITIVE / N/A, and any subject that is not FULL withholds convergence.
 *
 * Tier 1 (pure modules) + the ledger projection. The Tier-3 egress seam (a required path forced into a prompt) is
 * `tests/required-subjects-egress.test.mjs`. Every assertion has a negative control: the gate must fire in the
 * failing direction AND stay quiet in the passing one, or it cannot be told from an inert one.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  parseRequireArgs, validateRequiredSubjects, requiredSubjectStatus, summariseRequiredSubjects,
  admittedRequiredPaths,
} from '../scripts/lib/audit/required-subjects.mjs';
import { buildCoverageReport, validateCoverage } from '../scripts/lib/audit/file-coverage.mjs';
import { evaluateConvergenceWithDetectors, COVERAGE_CONVERGENCE_REASONS } from '../scripts/lib/audit/convergence.mjs';
import { formatAuditSummaryLine } from '../scripts/lib/audit/findings-pipeline.mjs';

const LOCK = 'tests/fixtures/required-subjects/package-lock.json';
const BIG = 'tests/fixtures/required-subjects/big/package-lock.json';
const SRC = 'tests/fixtures/required-subjects/service.mjs';

const tmpRepo = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'req-subj-')));

/** A recorder holding one completed pass that rendered `stats`. */
const recorderOf = (stats) => ({ passes: new Map([['backend', { completed: true, stats: [{ full: [], headTruncated: [], unreadable: [], budgetOmitted: [], ...stats }] }]]), chunking: new Map() });
const full = (...paths) => recorderOf({ full: paths });
const cut = (p, over = {}) => recorderOf({ headTruncated: [{ path: p, charsOnDisk: 9000, charsRendered: 6000, ranges: [[1, 100]], windowed: false, ...over }] });
const REAL = { existsOnDisk: () => true, readText: () => 'x\n'.repeat(500) };
const subject = (p, extra = {}) => ({ path: p, sensitive: false, ...extra });
const fileOf = (rep, p) => rep.files.find((f) => f.path === p);

describe('parseRequireArgs — the operator input', () => {
  it('collects a comma list and every repeat of the flag, in order, de-slashed', () => {
    const r = parseRequireArgs(['code', 'plan.md', '--require', 'a.json,.\\b\\c.lock', '--require', 'd.txt']);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.paths, ['a.json', 'b/c.lock', 'd.txt']);
  });
  it('@file reads one path per line, ignoring blanks and # comments (the 12-subject list)', () => {
    const readFile = (f) => { assert.equal(f, 'req.txt'); return '# subjects\npackage-lock.json\n\n  src/a.py  \n'; };
    assert.deepEqual(parseRequireArgs(['--require', '@req.txt'], { readFile }).paths, ['package-lock.json', 'src/a.py']);
  });
  it('R1 audit H2/M6/M9: a flag that declares NO path is an error, never "nothing required" (--require=, a bare comma list, an empty @file)', () => {
    const empty = () => '# nothing here\n\n';
    for (const argv of [['--require='], ['--require', ','], ['--require', ',,'], ['--require', '@e.txt']]) {
      const r = parseRequireArgs(argv, { readFile: empty });
      assert.deepEqual(r.paths, [], argv.join(' '));
      assert.match(r.errors.join('\n'), /declares no path/, argv.join(' '));
    }
  });
  it('control: a flag with at least one path next to an empty item is fine', () => {
    assert.deepEqual(parseRequireArgs(['--require', 'a.json,,']), { paths: ['a.json'], errors: [] });
  });
  it('control: no flag declares nothing (the audit is byte-identical to today)', () => {
    assert.deepEqual(parseRequireArgs(['code', 'plan.md', '--round', '2']), { paths: [], errors: [] });
  });
  it('a flag with no value, or an unreadable @file, is an error — never an empty list that reads as "nothing required"', () => {
    assert.match(parseRequireArgs(['--require']).errors[0], /--require needs a value/);
    const bad = parseRequireArgs(['--require', '@nope.txt'], { readFile: () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); } });
    assert.match(bad.errors[0], /nope\.txt/);
  });
});

describe('validateRequiredSubjects — containment, INC-001, exclusion conflicts', () => {
  it('an existing in-repo file is accepted; a missing in-repo file is accepted too (its status is the diff\'s call)', () => {
    const root = tmpRepo();
    fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');
    const r = validateRequiredSubjects(['package-lock.json', 'typo/never.txt'], { repoRoot: root });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.subjects.map((s) => [s.path, s.sensitive, s.onDisk]), [['package-lock.json', false, true], ['typo/never.txt', false, false]]);
  });
  it('a path escaping the repo — relative or absolute — refuses the run, naming the path', () => {
    const root = tmpRepo();
    for (const bad of ['../outside.txt', 'a/../../outside.txt', path.join(os.tmpdir(), 'elsewhere.txt')]) {
      const r = validateRequiredSubjects([bad], { repoRoot: root });
      assert.equal(r.ok, false, bad);
      assert.equal(r.errors[0].path, bad);
      assert.match(r.errors[0].reason, /outside the repository/);
    }
  });
  it('a sensitive path is a SENSITIVE subject (reported, never admitted), not a refusal', () => {
    const root = tmpRepo();
    fs.writeFileSync(path.join(root, '.env'), 'TOKEN=abc');
    const r = validateRequiredSubjects(['.env', 'package-lock.json'], { repoRoot: root });
    assert.equal(r.ok, true);
    assert.equal(r.subjects[0].sensitive, true);
    assert.deepEqual(admittedRequiredPaths(r.subjects), ['package-lock.json'], 'the sensitive path is never in the admitted set');
  });
  it('a path that is both required and excluded is a contradiction: refuse', () => {
    const r = validateRequiredSubjects(['package-lock.json'], { repoRoot: tmpRepo(), isExcluded: (p) => p === 'package-lock.json' });
    assert.equal(r.ok, false);
    assert.match(r.errors[0].reason, /excluded by --exclude-paths\/\.auditignore/);
  });
  it('duplicates by normalised identity are reported, not merged away', () => {
    const r = validateRequiredSubjects(['A.json', 'a.json', './A.json'], { repoRoot: tmpRepo() });
    assert.equal(r.ok, true);
    assert.equal(r.subjects.length, 1);
    assert.equal(r.duplicates.length, 2);
  });
  it('a directory is not a subject', () => {
    const root = tmpRepo();
    fs.mkdirSync(path.join(root, 'src'));
    const r = validateRequiredSubjects(['src'], { repoRoot: root });
    assert.equal(r.ok, false);
    assert.match(r.errors[0].reason, /not a file/);
  });
  it('INC-001: a symlink out of the repo refuses; a symlink to a sensitive in-repo target is SENSITIVE', (t) => {
    const root = tmpRepo();
    const outside = path.join(tmpRepo(), 'secret.txt');
    fs.writeFileSync(outside, 'x');
    fs.writeFileSync(path.join(root, '.env'), 'TOKEN=abc');
    try {
      fs.symlinkSync(outside, path.join(root, 'innocent.json'));
      fs.symlinkSync(path.join(root, '.env'), path.join(root, 'also-innocent.json'));
    } catch (e) { return t.skip(`cannot create symlinks on this host (${e.code}); the Linux CI run exercises this`); }
    const out = validateRequiredSubjects(['innocent.json'], { repoRoot: root });
    assert.equal(out.ok, false);
    assert.match(out.errors[0].reason, /outside the repository/);
    const sens = validateRequiredSubjects(['also-innocent.json'], { repoRoot: root });
    assert.equal(sens.ok, true);
    assert.equal(sens.subjects[0].sensitive, true, 'the visible name is innocent; its target is not');
  });
  it('INC-001: a MISSING path under a symlinked parent that leaves the repo refuses (the parent is realpath-checked)', (t) => {
    const root = tmpRepo();
    const outsideDir = tmpRepo();
    try { fs.symlinkSync(outsideDir, path.join(root, 'linkdir'), 'junction'); }
    catch (e) { return t.skip(`cannot create links on this host (${e.code})`); }
    const r = validateRequiredSubjects(['linkdir/deleted-later.txt'], { repoRoot: root });
    assert.equal(r.ok, false);
    assert.match(r.errors[0].reason, /outside the repository/);
  });
});

describe('requiredSubjectStatus — the one projection of a ledger record', () => {
  const rec = (over) => ({
    path: 'x', required: true, class: 'non-code', outcome: 'audited', reason: null, changeKind: 'modified',
    read: { state: 'full' }, changedLinesUnread: 0, ...over,
  });
  const cases = [
    ['audited, read in full', rec({}), 'FULL'],
    ['changed, windowed with every changed line shown', rec({ read: { state: 'windowed' }, changedLinesUnread: 0 }), 'FULL'],
    ['changed, head-cut with unread changed lines', rec({ read: { state: 'head-cut' }, changedLinesUnread: 12 }), 'PARTIAL'],
    ['changed, head-cut and unmeasurable', rec({ read: { state: 'head-cut' }, changedLinesUnread: null }), 'PARTIAL'],
    ['an UNCHANGED context subject read only in part (0 changed lines unread is vacuous)', rec({ requiredContext: true, read: { state: 'head-cut' }, changedLinesUnread: 0 }), 'PARTIAL'],
    ['an unchanged context subject read in full', rec({ requiredContext: true }), 'FULL'],
    ['not admitted', rec({ outcome: 'not-admitted' }), 'UNREAD'],
    ['unreadable', rec({ outcome: 'unreadable', reason: 'not on disk' }), 'UNREAD'],
    ['budget-omitted', rec({ outcome: 'budget-omitted' }), 'UNREAD'],
    ['excluded as audit infrastructure', rec({ outcome: 'excluded-infra' }), 'UNREAD'],
    ['sensitive', rec({ outcome: 'sensitive' }), 'SENSITIVE'],
    ['deleted in the diff', rec({ outcome: 'deleted', changeKind: 'deleted' }), 'N/A'],
  ];
  for (const [name, r, want] of cases) {
    it(`${name} → ${want}`, () => assert.equal(requiredSubjectStatus(r).status, want));
  }
  it('every non-FULL, non-N/A status carries a reason (never a bare count)', () => {
    for (const [, r, want] of cases) {
      if (want === 'FULL' || want === 'N/A') continue;
      assert.ok(requiredSubjectStatus(r).reason.length > 0, JSON.stringify(r));
    }
  });
});

describe('buildCoverageReport — required subjects join the ledger (P-A1, P-A1n, P-A2b, P-A4b)', () => {
  it('P-A1: a required changed lockfile is ADMITTED and audited, not "not-admitted"; the report names it FULL', () => {
    const rep = buildCoverageReport({ changed: [{ path: LOCK, changeKind: 'modified' }], required: [subject(LOCK)], recorder: full(LOCK), ...REAL });
    assert.equal(fileOf(rep, LOCK).class, 'non-code');
    assert.equal(fileOf(rep, LOCK).outcome, 'audited');
    assert.equal(fileOf(rep, LOCK).required, true);
    assert.deepEqual(rep.invariantViolations, [], 'the non-code-recorded-as-audited invariant is scoped to NON-required files');
    assert.deepEqual(rep.requiredSubjects, {
      declared: 1, full: 1, notApplicable: 0, notFull: [],
      subjects: [{ path: LOCK, status: 'FULL', reason: null }],
    });
    assert.equal(validateCoverage(rep).ok, true, 'the strict schema accepts the new fields');
  });
  it('P-A1n control: the SAME lockfile without --require is still not-admitted, and the report carries no required keys (P-A2b)', () => {
    const rep = buildCoverageReport({ changed: [{ path: LOCK, changeKind: 'modified' }], recorder: full(LOCK), ...REAL });
    assert.equal(fileOf(rep, LOCK).outcome, 'not-admitted');
    assert.equal('requiredSubjects' in rep, false);
    assert.equal('required' in fileOf(rep, LOCK), false, 'a record without the flag is byte-identical to today');
    assert.equal('requiredContext' in fileOf(rep, LOCK), false);
  });
  it('an UNCHANGED required file joins the universe as a context subject', () => {
    const rep = buildCoverageReport({ changed: [{ path: SRC, changeKind: 'modified' }], required: [subject(LOCK)], recorder: full(LOCK, SRC), ...REAL });
    assert.equal(rep.changedTotal, 2);
    assert.equal(fileOf(rep, LOCK).requiredContext, true);
    assert.equal(rep.requiredSubjects.subjects[0].status, 'FULL');
    assert.equal(fileOf(rep, SRC).required, undefined, 'a changed file that was not required is not flagged');
  });
  it('R1 audit H3/M2: a required UNCOVERED (unrecognised type) file that was read raises no invariant violation and does not make the ledger incomplete', () => {
    const rep = buildCoverageReport({ changed: [{ path: 'svc/notes.xyz', changeKind: 'modified' }], required: [subject('svc/notes.xyz')], recorder: full('svc/notes.xyz'), ...REAL });
    assert.equal(fileOf(rep, 'svc/notes.xyz').class, 'uncovered');
    assert.equal(fileOf(rep, 'svc/notes.xyz').outcome, 'audited');
    assert.deepEqual(rep.invariantViolations, []);
    assert.notEqual(rep.status, 'incomplete');
    assert.equal(rep.requiredSubjects.subjects[0].status, 'FULL');
  });
  it('R1 audit H3 control: the SAME uncovered file, not required, is still not-admitted', () => {
    const rep = buildCoverageReport({ changed: [{ path: 'svc/notes.xyz', changeKind: 'modified' }], recorder: full('svc/notes.xyz'), ...REAL });
    assert.equal(fileOf(rep, 'svc/notes.xyz').outcome, 'not-admitted');
  });
  it('a required file read only in part is PARTIAL, named with its read state', () => {
    const rep = buildCoverageReport({ changed: [], required: [subject(BIG)], recorder: cut(BIG), ...REAL });
    const s = rep.requiredSubjects;
    assert.equal(s.full, 0);
    assert.equal(s.notFull[0].path, BIG);
    assert.equal(s.notFull[0].status, 'PARTIAL');
    assert.match(s.notFull[0].reason, /head-cut/);
  });
  it('P-A4b: a required path the diff records deleted is N/A and counts as satisfied', () => {
    const rep = buildCoverageReport({ changed: [{ path: LOCK, changeKind: 'deleted' }], required: [subject(LOCK)], ...REAL });
    assert.equal(rep.requiredSubjects.subjects[0].status, 'N/A');
    assert.equal(rep.requiredSubjects.notFull.length, 0);
    assert.equal(rep.requiredSubjects.notApplicable, 1);
  });
  it('P-A4b control: a typo path absent from disk AND from the diff is UNREAD "not on disk", not N/A', () => {
    const rep = buildCoverageReport({ changed: [], required: [subject('typo/never.txt')], existsOnDisk: () => false, readText: () => null });
    assert.equal(rep.requiredSubjects.subjects[0].status, 'UNREAD');
    assert.match(rep.requiredSubjects.subjects[0].reason, /not on disk/);
  });
  it('a SENSITIVE subject is outcome sensitive and never rendered, even when its visible name is innocent', () => {
    const rep = buildCoverageReport({ changed: [], required: [subject('innocent.json', { sensitive: true })], recorder: full('innocent.json'), ...REAL });
    assert.equal(fileOf(rep, 'innocent.json').outcome, 'sensitive');
    assert.equal(rep.requiredSubjects.subjects[0].status, 'SENSITIVE');
    assert.equal(rep.requiredSubjects.notFull.length, 1);
  });
  it('a required file nothing rendered is UNREAD with the ledger\'s own reason', () => {
    const rep = buildCoverageReport({ changed: [{ path: LOCK, changeKind: 'modified' }], required: [subject(LOCK)], recorder: recorderOf({}), ...REAL });
    assert.equal(rep.requiredSubjects.subjects[0].status, 'UNREAD');
    assert.ok(rep.requiredSubjects.subjects[0].reason);
  });
});

describe('summariseRequiredSubjects', () => {
  it('names every non-FULL subject with its status and reason', () => {
    const files = [
      { path: 'a', required: true, outcome: 'audited', read: { state: 'full' }, changedLinesUnread: 0 },
      { path: 'b', required: true, outcome: 'not-admitted', reason: null, read: { state: 'none' }, changedLinesUnread: null },
    ];
    const s = summariseRequiredSubjects(files);
    assert.equal(s.declared, 2);
    assert.equal(s.full, 1);
    assert.deepEqual(s.notFull.map((n) => [n.path, n.status]), [['b', 'UNREAD']]);
  });
});

describe('convergence + summary line (P-A2)', () => {
  const rs = (n, notFull) => ({ declared: n, full: n - notFull.length, notApplicable: 0, notFull, subjects: [] });
  const cov = (requiredSubjects) => ({ schemaVersion: 1, status: 'complete', gate: 'pass', counts: { required: 1, examined: 1, short: 0, excludedRequired: 0, byClass: {}, byOutcome: {} }, files: [], uncoveredByExtension: {}, requiredSubjects });
  const counts = { high: 0, medium: 0, quickFix: 0 };
  const detectors = { blocked: false, checked: 0 };

  it('11 of 12 FULL withholds convergence with its own reason; 12 of 12 converges', () => {
    const eleven = cov(rs(12, [{ path: 'package-lock.json', status: 'UNREAD', reason: 'not-admitted' }]));
    assert.deepEqual(evaluateConvergenceWithDetectors(counts, detectors, eleven), { converged: false, reason: 'required-subjects-not-full' });
    assert.deepEqual(evaluateConvergenceWithDetectors(counts, detectors, cov(rs(12, []))), { converged: true, reason: 'converged' });
  });
  it('control: a coverage with no --require (no requiredSubjects key) converges as before', () => {
    assert.deepEqual(evaluateConvergenceWithDetectors(counts, detectors, cov(undefined)), { converged: true, reason: 'converged' });
  });
  it('the reason is in the ONE set audit-loop reads, so it refuses without a second edit', () => {
    assert.equal(COVERAGE_CONVERGENCE_REASONS.has('required-subjects-not-full'), true);
  });
  it('the summary line names the subject and its reason — never a bare "11/12" — and says it is not convergence evidence', () => {
    const line = formatAuditSummaryLine({
      verdict: 'PASS', high: 0, medium: 0, low: 0, latencyMs: 1000,
      coverage: cov(rs(12, [{ path: 'package-lock.json', status: 'UNREAD', reason: 'not-admitted' }])),
    });
    assert.match(line, /required: 11\/12 FULL — package-lock\.json UNREAD \(not-admitted\) — not convergence evidence/);
  });
  it('R1 audit L1: every non-FULL subject is named (up to 20), not cut at five', () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ path: `f${i}.lock`, status: 'UNREAD', reason: 'not-admitted' }));
    const line = formatAuditSummaryLine({ verdict: 'PASS', high: 0, medium: 0, low: 0, latencyMs: 1000, coverage: cov(rs(8, many)) });
    for (const m of many) assert.ok(line.includes(m.path), m.path);
    assert.doesNotMatch(line, /\+\d+ more/);
  });
  it('control: 12/12 prints the positive evidence and no "not convergence evidence"', () => {
    const line = formatAuditSummaryLine({ verdict: 'PASS', high: 0, medium: 0, low: 0, latencyMs: 1000, coverage: cov(rs(12, [])) });
    assert.match(line, /required: 12\/12 FULL/);
    assert.doesNotMatch(line, /not convergence evidence/);
  });
});

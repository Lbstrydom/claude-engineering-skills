/**
 * @fileoverview Ship-train train-run thinness (plan ship-trains §2.10a, Cluster D): did the train's combined run fail
 * on a test the branch tier would not have selected for a source's head? Every verdict row, both directions, and the
 * metric's error boundary and budget. The metric is reported by `verify` and never gates.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  failedAttempts, attemptSection, parseSelection, classifyPair, judgeThinness, readExistence, publicationClearance, verifyTrain,
} from '../scripts/lib/ship-train/verify.mjs';
import { gatherThinness, thinnessLine, THINNESS_CHILD_TIMEOUT_MS } from '../scripts/lib/ship-train/commands.mjs';
import { FAILED_FILES_MARKER, parseFailedFilesPayload } from '../scripts/lib/failed-files-marker.mjs';

const oid = (c) => c.repeat(40);
const M = FAILED_FILES_MARKER;
const header = (tier, n) => `--- fleet: tier ${tier} attempt ${n} at 2026-11-13T07:00:00.000Z ---`;
const logOf = (...sections) => sections.map(([tier, n, body]) => `\n${header(tier, n)}\n${body}\n`).join('');
const attemptsOf = (tierResults, log) => failedAttempts({
  tierResults, readLog: () => (typeof log === 'string' ? { ok: true, text: log } : log), parsePayload: parseFailedFilesPayload, marker: M,
});
const HEAVY = 'tests/fleet-archive.test.mjs';
const LIGHT = 'tests/light.test.mjs';

describe('failedAttempts', () => {
  test('no tierResults, an unknown result, dirty and none are unmeasured', () => {
    assert.equal(attemptsOf(undefined, '').ok, false);
    assert.equal(attemptsOf([], '').ok, false);
    assert.match(attemptsOf([{ name: 'default', result: 'purple' }], '').reason, /not one fleet records/);
    assert.match(attemptsOf([{ name: 'default', result: 'dirty' }], '').reason, /not a test verdict/);
    assert.match(attemptsOf([{ name: 'default', result: 'none' }], '').reason, /not a test verdict/);
  });
  test('a first-attempt green reads no log and has no failures', () => {
    let read = 0;
    const r = failedAttempts({ tierResults: [{ name: 'default', result: 'green' }], readLog: () => { read++; return { ok: true, text: '' }; }, parsePayload: parseFailedFilesPayload, marker: M });
    assert.deepEqual(r, { ok: true, failures: [] });
    assert.equal(read, 0);
  });
  test("a green-after-rerun's first attempt counts, and its passing rerun does not", () => {
    const r = attemptsOf([{ name: 'default', result: 'green-after-rerun', reran: true }], logOf(['default', 1, `noise\n${M} ["${HEAVY}"]`], ['default', 2, 'all good']));
    assert.deepEqual(r, { ok: true, failures: [{ tier: 'default', attempt: 1, files: [HEAVY] }] });
  });
  test('a red with a rerun reads both attempts; the LAST marker of a section wins', () => {
    const r = attemptsOf([{ name: 'default', result: 'red', reran: true }],
      logOf(['default', 1, `${M} ["x.test.mjs"]\n${M} ["${HEAVY}"]`], ['default', 2, `${M} ["${LIGHT}"]`]));
    assert.deepEqual(r.failures.map((f) => [f.attempt, f.files]), [[1, [HEAVY]], [2, [LIGHT]]]);
  });
  test('an interrupted tier re-run on resume: the LAST "attempt 1" section is the recorded one', () => {
    const log = logOf(['default', 1, `${M} ["old.test.mjs"]`], ['default', 1, `${M} ["${HEAVY}"]`]);
    assert.deepEqual(attemptsOf([{ name: 'default', result: 'red' }], log).failures[0].files, [HEAVY]);
    assert.equal(attemptSection(log, 'default', 2), null);
  });
  test("an older run's attempt 2 is never read for the resumed run (code R3 M1)", () => {
    const log = logOf(['default', 1, `${M} ["a.test.mjs"]`], ['default', 2, `${M} ["old-2.test.mjs"]`], ['default', 1, `${M} ["${HEAVY}"]`]);
    assert.equal(attemptSection(log, 'default', 2), null);
    assert.match(attemptsOf([{ name: 'default', result: 'red', reran: true }], log).reason, /no section for attempt 2/);
    const resumed = `${log}${logOf(['default', 2, `${M} ["${LIGHT}"]`])}`;
    assert.deepEqual(attemptsOf([{ name: 'default', result: 'red', reran: true }], resumed).failures.map((f) => f.files), [[HEAVY], [LIGHT]]);
  });
  test('unknown, malformed, missing marker, missing section and an unreadable log are unmeasured, never "no failures"', () => {
    const red = [{ name: 'default', result: 'red' }];
    assert.match(attemptsOf(red, logOf(['default', 1, `${M} unknown`])).reason, /unknown/);
    assert.match(attemptsOf(red, logOf(['default', 1, `${M} [1]`])).reason, /malformed/);
    assert.match(attemptsOf(red, logOf(['default', 1, 'killed by timeout'])).reason, /no failed-files line/);
    assert.match(attemptsOf(red, logOf(['other', 1, `${M} ["${HEAVY}"]`])).reason, /no section for attempt 1/);
    assert.match(attemptsOf(red, { ok: false, reason: 'over the bound' }).reason, /over the bound/);
  });
  test('a failed attempt whose marker names no file is unmeasured, red or green-after-rerun (R2 H1)', () => {
    assert.match(attemptsOf([{ name: 'default', result: 'red' }], logOf(['default', 1, `${M} []`])).reason, /names no file/);
    assert.match(attemptsOf([{ name: 'default', result: 'green-after-rerun', reran: true }], logOf(['default', 1, `${M} []`], ['default', 2, ''])).reason, /names no file/);
  });
  test('only post-merge tier records is unmeasured, never a clean run (code R1 M3/M8)', () => {
    assert.match(attemptsOf([{ name: 'later', result: 'green', stage: 'post-merge' }], '').reason, /no pre-land tier/);
  });
  test('post-merge tiers are not the combined run and are ignored', () => {
    assert.deepEqual(attemptsOf([{ name: 'default', result: 'green' }, { name: 'later', result: 'purple', stage: 'post-merge' }], ''), { ok: true, failures: [] });
  });
});

describe('parseSelection', () => {
  const H = oid('9');
  const ok = (over = {}) => ({ status: 0, stdout: JSON.stringify({ measured: true, head: H, skipped: [HEAVY], selector: { a: 'b' }, manifest: 'm', ...over }) });
  test('a measured envelope for this head', () => {
    assert.deepEqual(parseSelection(ok(), H), { measured: true, skipped: [HEAVY], selector: { a: 'b' }, manifest: 'm' });
  });
  test('exit 3 with measured:false carries its reason', () => {
    assert.deepEqual(parseSelection({ status: 3, stdout: JSON.stringify({ measured: false, reason: 'predates the tier' }) }, H), { measured: false, reason: 'predates the tier' });
  });
  test('every other shape is unmeasured: a spawn error, exit 1, garbage, a wrong head, no skipped[], measured on a non-zero exit', () => {
    for (const r of [
      { error: 'timed out after 120s', status: null, stdout: '' },
      { status: 1, stdout: '', stderr: 'test-tier: --base is not an ancestor' },
      { status: 0, stdout: 'not json' },
      ok({ head: oid('8') }),
      ok({ skipped: undefined }),
      ok({ skipped: [3] }),
      { ...ok(), status: 3 },
      { status: 0, stdout: JSON.stringify({ head: H, skipped: [] }) },
    ]) assert.equal(parseSelection(r, H).measured, false, JSON.stringify(r));
  });
});

describe('readExistence (code R1 M2/M5/M7)', () => {
  const F = 'tests/a.test.mjs';
  test('a blob record for exactly the path is present; empty output is absent', () => {
    assert.deepEqual(readExistence({ status: 0, stdout: `100644 blob ${oid('c')}\t${F}\0` }, F), { known: true, exists: true });
    assert.deepEqual(readExistence({ status: 0, stdout: '' }, F), { known: true, exists: false });
  });
  test('a git failure, a tree, another path or an unterminated stream can not say, and is never absent', () => {
    for (const r of [{ status: 128, stdout: '' }, { status: null, stdout: '' }, { status: 0, stdout: `040000 tree ${oid('c')}\t${F}\0` },
      { status: 0, stdout: `100644 blob ${oid('c')}\ttests/b.test.mjs\0` }, { status: 0, stdout: `100644 blob ${oid('c')}\t${F}` }]) {
      assert.equal(readExistence(r, F).known, false, JSON.stringify(r));
    }
  });
});

describe('classifyPair', () => {
  const measured = { measured: true, skipped: [HEAVY] };
  test('skipped, selected, absent', () => {
    assert.equal(classifyPair({ selection: measured, existence: null, file: HEAVY }).class, 'skipped');
    assert.equal(classifyPair({ selection: measured, existence: { known: true, exists: true }, file: LIGHT }).class, 'selected');
    assert.equal(classifyPair({ selection: measured, existence: { known: true, exists: false }, file: LIGHT }).class, 'absent');
  });
  test('absence from skipped[] is never selection without an existence answer (R1 H2)', () => {
    assert.equal(classifyPair({ selection: measured, existence: null, file: LIGHT }).class, 'unmeasured');
    assert.equal(classifyPair({ selection: measured, existence: { known: false, reason: 'git failed' }, file: LIGHT }).class, 'unmeasured');
  });
  test('an unmeasured selection is an unmeasured pair whatever the file', () => {
    assert.deepEqual(classifyPair({ selection: { measured: false, reason: 'r' }, existence: { known: true, exists: true }, file: LIGHT }), { class: 'unmeasured', reason: 'r' });
  });
});

describe('judgeThinness: the ordered verdict table', () => {
  const fails = (...files) => ({ ok: true, failures: [{ tier: 'default', attempt: 1, files }] });
  const pair = (pr, cls, reason) => ({ pr, class: cls, ...(reason ? { reason } : {}) });
  test('row 1: attempts that cannot be named are unmeasured', () => {
    assert.deepEqual(judgeThinness({ attempts: { ok: false, reason: 'no log' }, files: [] }), { verdict: 'unmeasured', reason: 'no log', failures: [] });
  });
  test('row 2: one measured skip is thin, even beside an unmeasured source', () => {
    const t = judgeThinness({ attempts: fails(HEAVY), files: [{ file: HEAVY, pairs: [pair(1, 'skipped'), pair(2, 'unmeasured', 'old selector')] }] });
    assert.equal(t.verdict, 'thin');
    assert.deepEqual(t.failures[0].skippedBy, [1]);
    assert.equal(t.failures[0].skippedByAll, false, 'an unmeasured source blocks the strong signal (R2 M1)');
  });
  test('skippedByAll: complete or false', () => {
    const one = (pairs) => judgeThinness({ attempts: fails(HEAVY), files: [{ file: HEAVY, pairs }] }).failures[0].skippedByAll;
    assert.equal(one([pair(1, 'skipped'), pair(2, 'skipped'), pair(3, 'absent')]), true);
    assert.equal(one([pair(1, 'skipped'), pair(2, 'selected')]), false);
    assert.equal(one([pair(1, 'skipped'), pair(2, 'unmeasured', 'existence check failed')]), false, 'R3 M1');
    assert.equal(one([pair(1, 'absent'), pair(2, 'absent')]), false, 'no applicable source');
  });
  test('row 3: a partial measurement with no skip is unmeasured, never not-thin (R1 H1)', () => {
    const t = judgeThinness({ attempts: fails(LIGHT), files: [{ file: LIGHT, pairs: [pair(1, 'selected'), pair(2, 'unmeasured', 'timed out')] }] });
    assert.equal(t.verdict, 'unmeasured');
    assert.match(t.reason, /#2/);
  });
  test('row 3: a file absent from every source is unmeasured', () => {
    const t = judgeThinness({ attempts: fails(LIGHT), files: [{ file: LIGHT, pairs: [pair(1, 'absent'), pair(2, 'absent')] }] });
    assert.equal(t.verdict, 'unmeasured');
    assert.match(t.reason, /no source's head/);
  });
  test('a failure with no pairs at all is unmeasured, never not-thin', () => {
    assert.equal(judgeThinness({ attempts: fails(LIGHT), files: [] }).verdict, 'unmeasured');
  });
  test('row 4: every pair selected or absent is not-thin; a test one source added is absent for the others (R1 H2)', () => {
    const t = judgeThinness({ attempts: fails(LIGHT), files: [{ file: LIGHT, pairs: [pair(1, 'selected'), pair(2, 'absent')] }] });
    assert.equal(t.verdict, 'not-thin');
    assert.deepEqual([t.failures[0].selectedBy, t.failures[0].absentFrom], [[1], [2]]);
  });
  test('row 5: no failures is its own word, not a zero', () => {
    assert.deepEqual(judgeThinness({ attempts: { ok: true, failures: [] }, files: [] }), { verdict: 'no-failures', reason: null, failures: [] });
  });
});

describe('gatherThinness: the error boundary and the budget (R1 H3, R2 H2)', () => {
  const BASE = oid('b'); const S1 = oid('1'); const S2 = oid('2'); const FORK = oid('f');
  const redTrain = (files) => ({
    baseOid: BASE,
    tierResults: [{ name: 'default', result: 'red', logPath: '/fleet/logs/t.default.log' }],
    sources: [{ id: 's1', oid: S1, prNumber: 11 }, { id: 's2', oid: S2, prNumber: 12 }],
    log: logOf(['default', 1, `${M} ${JSON.stringify(files)}`]),
  });
  const ctxFor = (train, { select, exists = () => 'yes', clock = () => 0, readLog } = {}) => {
    const calls = { select: [], git: [] };
    let reads = 0;
    return {
      calls,
      now: () => new Date(clock(reads++)),
      readLog: readLog ?? (() => ({ ok: true, text: train.log })),
      gitBounded: (args, ms) => {
        calls.git.push({ args, ms });
        if (args[0] === 'merge-base') return { status: 0, stdout: `${FORK}\n`, stderr: '', error: null };
        const [, , , at, , file] = args;
        const e = exists(at, file);
        if (e === 'error') return { status: 128, stdout: '', stderr: 'fatal: not a tree object', error: null };
        return { status: 0, stdout: e === 'yes' ? `100644 blob ${oid('c')}\t${file}\0` : '', stderr: '', error: null };
      },
      selectBranchTier: (a) => { calls.select.push(a); return select(a); },
    };
  };
  const measuredSkipping = (skipped) => ({ head }) => ({ status: 0, stdout: JSON.stringify({ measured: true, head, skipped }), stderr: '', error: null });

  test('a green train asks no selection and reads no log', () => {
    const ctx = ctxFor({}, { select: () => assert.fail('asked'), readLog: () => assert.fail('read') });
    const t = gatherThinness(ctx, { baseOid: BASE, tierResults: [{ name: 'default', result: 'green' }], sources: [{ oid: S1, prNumber: 11 }] });
    assert.equal(t.verdict, 'no-failures');
    assert.equal(ctx.calls.select.length, 0);
  });
  test('thin: skipped for #11, selected for #12; the selection base is the fork point from the train base', () => {
    const train = redTrain([HEAVY]);
    const ctx = ctxFor(train, { select: ({ head }) => measuredSkipping(head === S1 ? [HEAVY] : [])({ head }) });
    const t = gatherThinness(ctx, train);
    assert.equal(t.verdict, 'thin');
    assert.deepEqual([t.failures[0].skippedBy, t.failures[0].selectedBy], [[11], [12]]);
    assert.deepEqual(ctx.calls.select.map((c) => [c.head, c.base]), [[S1, FORK], [S2, FORK]]);
    assert.deepEqual(ctx.calls.git.find((c) => c.args[0] === 'merge-base').args, ['merge-base', BASE, S1]);
    assert.equal(t.counterfactual, true);
  });
  test('negative control: the same train with nothing skipped is not-thin', () => {
    const train = redTrain([HEAVY]);
    assert.equal(gatherThinness(ctxFor(train, { select: measuredSkipping([]) }), train).verdict, 'not-thin');
  });
  test('a test added by #12 is absent at #11 and never selected there', () => {
    const train = redTrain([LIGHT]);
    const ctx = ctxFor(train, { select: measuredSkipping([]), exists: (at) => (at === S1 ? 'no' : 'yes') });
    const t = gatherThinness(ctx, train);
    assert.equal(t.verdict, 'not-thin');
    assert.deepEqual([t.failures[0].selectedBy, t.failures[0].absentFrom], [[12], [11]]);
  });
  test('an existence check git cannot answer is an unmeasured pair', () => {
    const train = redTrain([LIGHT]);
    const t = gatherThinness(ctxFor(train, { select: measuredSkipping([]), exists: () => 'error' }), train);
    assert.equal(t.verdict, 'unmeasured');
  });
  test('a select error or timeout is an unmeasured pair, and the train reads unmeasured, not not-thin', () => {
    const train = redTrain([LIGHT]);
    const ctx = ctxFor(train, { select: ({ head }) => (head === S1 ? { status: null, stdout: '', stderr: '', error: 'timed out after 120s' } : measuredSkipping([])({ head })) });
    const t = gatherThinness(ctx, train);
    assert.equal(t.verdict, 'unmeasured');
    assert.equal(t.selections.find((s) => s.pr === 11).measured, false);
  });
  test('an exhausted budget makes the remaining pairs unmeasured, and each child gets at most the time left', () => {
    const train = redTrain([LIGHT]);
    // Each clock read advances 100 s against a 300 s budget: the second source is reached after it is spent.
    const ctx = ctxFor(train, { select: measuredSkipping([]), clock: (n) => n * 100_000 });
    const t = gatherThinness(ctx, train);
    assert.equal(t.verdict, 'unmeasured');
    assert.ok([...ctx.calls.git, ...ctx.calls.select.map((c) => ({ ms: c.timeoutMs }))].every((c) => c.ms <= THINNESS_CHILD_TIMEOUT_MS && c.ms > 0));
    assert.ok(t.selections.some((s) => s.reason === 'budget exhausted'), JSON.stringify(t.selections));
  });
  test('a throwing context member never escapes: the metric reads unmeasured', () => {
    const train = redTrain([HEAVY]);
    const t = gatherThinness(ctxFor(train, { select: () => { throw new Error('boom'); } }), train);
    assert.equal(t.verdict, 'unmeasured');
    assert.match(t.reason, /boom/);
  });
  test('a context without the members reads unmeasured, never a clean answer', () => {
    assert.equal(gatherThinness({ now: () => new Date() }, redTrain([HEAVY])).verdict, 'unmeasured');
  });
  test('an unreadable or oversized log is unmeasured (R3 H1)', () => {
    const train = redTrain([HEAVY]);
    const t = gatherThinness(ctxFor(train, { select: measuredSkipping([]), readLog: () => ({ ok: false, reason: 'the tier log is over 67108864 bytes; not read' }) }), train);
    assert.equal(t.verdict, 'unmeasured');
    assert.match(t.reason, /not read/);
  });
  test('the metric is not an input to publicationClearance', () => {
    const v = verifyTrain({ sources: [], chain: [] });
    assert.deepEqual(publicationClearance(v), publicationClearance({ ...v, thinness: { verdict: 'thin' } }));
  });
  test('thinnessLine names the verdict, the reason and the skipping sources', () => {
    assert.match(thinnessLine({ verdict: 'unmeasured', reason: 'no log' }), /unmeasured \(no log\)/);
    assert.match(thinnessLine({ verdict: 'thin', failures: [{ file: HEAVY, skippedBy: [11], skippedByAll: true }] }), /fleet-archive.*#11 \[by all\]/);
    assert.match(thinnessLine({ verdict: 'no-failures' }), /no-failures$/);
  });
});

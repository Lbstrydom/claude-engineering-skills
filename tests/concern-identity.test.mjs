/**
 * Concern identity for the hard-suppress ruling counter ("Fix #4").
 *
 * The counter has been found dead twice, both times for the same underlying
 * reason: its key was built from model-written free text, and the test that
 * "proved" each fix used ONE spelling. 2026-08-10: the `[Tag]` prefix was
 * stripped on one side only. 2026-09-22 (consumer field report, six rounds of
 * /audit-code re-adjudicating one concern): exact category equality plus an
 * `affectedFiles[0]` key meant a reworded category, or the same concern
 * attributed to a different first file, never accumulated to three.
 *
 * So the load-bearing tests below dismiss ONE concern three times under THREE
 * DIFFERENT category phrasings with a ROTATING first file, then assert the
 * fourth raise is hard-suppressed. A test that reuses one category string
 * passes against a dead feature — that is exactly how it died last time.
 *
 * Category strings and files are the field report's real ledger rows; the
 * `detail` prose is paraphrased (the report did not include it).
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { suppressReRaises } from '../scripts/lib/ledger.mjs';
import {
  resolveConcernLinks, buildConcernIndex, summariseConcernRound, CONCERN_TELEMETRY_EPOCH,
} from '../scripts/lib/concern-identity.mjs';

const APIM = 'src/services/azure-apim-base-provider.ts';
const EGRESS = 'src/services/dataset-egress-serializer.ts';
const RUNNER = 'src/jobs/source-pipeline-job-runner.ts';

let n = 0;
/** A dismissed+overruled session entry, as write-ledger-entries writes it. */
function dismissed(category, affectedFiles, over = {}) {
  n += 1;
  return {
    topicId: `topic${String(n).padStart(7, '0')}`,
    category,
    section: affectedFiles[0],
    detailSnapshot: `Round ${n} prose: the module inlines numeric limit ${n * 7} rather than reading operational policy.`,
    affectedFiles,
    pass: 'sustainability',
    adjudicationOutcome: 'dismissed',
    remediationState: 'pending',
    ruling: 'overrule',
    source: 'session',
    ...over,
  };
}

/** A fresh raise, as populateFindingMetadata leaves it. */
function raise(category, affectedFiles, over = {}) {
  return {
    category,
    section: affectedFiles.join(', '),
    detail: 'Timeout and retry values are compile-time constants; operators cannot tune them per tenant without a deploy.',
    _primaryFile: affectedFiles[0],
    affectedFiles,
    _pass: 'sustainability',
    ...over,
  };
}

const ledgerOf = (...entries) => ({ version: 1, entries });
const hardSuppressed = (r) => r.suppressed.find((s) => s.matchedSource === 'ruling-count');

let saved;
beforeEach(() => {
  saved = process.env.SUPPRESS_SIMILARITY_THRESHOLD;
  process.env.SUPPRESS_SIMILARITY_THRESHOLD = '0.35';
});
afterEach(() => {
  if (saved === undefined) delete process.env.SUPPRESS_SIMILARITY_THRESHOLD;
  else process.env.SUPPRESS_SIMILARITY_THRESHOLD = saved;
});

describe('hard-suppress — one concern, three phrasings, rotating first file', () => {
  it('hard-suppresses the 4th raise when the adjudicator linked the three dismissals', () => {
    const first = dismissed('[Sustainability] Hardcoded operational policy', [APIM, EGRESS]);
    const second = dismissed('[Sustainability] Hardcoded policy limit', [EGRESS, RUNNER],
      { concernId: first.topicId });
    const third = dismissed('[Sustainability] [SYSTEMIC] Hardcoded protocol and operational policy limits',
      [RUNNER, APIM, EGRESS], { concernId: first.topicId });

    // Fourth raise: an earlier phrasing, a first file that was never any
    // entry's affectedFiles[0] under that phrasing, novel detail prose.
    const r = suppressReRaises(
      [raise('[Sustainability] Hardcoded policy limit', [APIM])],
      ledgerOf(first, second, third),
      { changedFiles: [APIM] },   // a touched scope must not reopen it either
    );
    const hs = hardSuppressed(r);
    assert.ok(hs, `expected a ruling-count suppression, got ${JSON.stringify(r.suppressed.map(s => s.reason))} / kept ${r.kept.length}`);
    assert.equal(hs.matchedTopic, 'hard-suppress', 'matchedTopic stays the literal existing queries key on');
    assert.equal(r.kept.length, 0);
  });

  it('groups by file OVERLAP, not affectedFiles[0] — same category, rotating first file, no link needed', () => {
    const cat = '[Sustainability] [SYSTEMIC] Hardcoded configuration and operational policy';
    const r = suppressReRaises(
      [raise(cat, [EGRESS, APIM])],
      ledgerOf(
        dismissed(cat, [APIM, RUNNER, EGRESS]),
        dismissed(cat, [RUNNER, EGRESS, APIM]),
        dismissed(cat, [EGRESS, APIM, RUNNER]),
      ),
      { changedFiles: [] },
    );
    assert.ok(hardSuppressed(r), 'three dismissals of one category over the same files must count as three');
  });

  it('collapses the field report\'s eight rows once each later row is linked to the first', () => {
    const root = dismissed('[Sustainability] Hardcoded operational policy', [APIM]);
    const linked = (cat, files) => dismissed(cat, files, { concernId: root.topicId });
    const ledger = ledgerOf(
      root,
      linked('[Sustainability] Hardcoded operational policy', [APIM]),
      linked('[Sustainability] Hardcoded operational limits', [APIM]),
      linked('[Sustainability] Hardcoded policy limit', [EGRESS]),
      linked('[Sustainability] Hardcoded operational limit', [EGRESS]),
      linked('[Sustainability] Hardcoded policy value', [EGRESS]),
      linked('[Sustainability] [SYSTEMIC] Hardcoded protocol and operational policy limits', [RUNNER, APIM, EGRESS]),
      linked('[Sustainability] [SYSTEMIC] Hardcoded configuration and operational policy', [RUNNER, APIM, EGRESS]),
    );
    for (const [cat, files] of [
      ['[Sustainability] Hardcoded policy value', [EGRESS]],
      ['[Sustainability] Hardcoded operational limits', [RUNNER]],
      ['[Sustainability] Hardcoded operational policy', [APIM]],
    ]) {
      const r = suppressReRaises([raise(cat, files)], ledger, { changedFiles: files });
      assert.ok(hardSuppressed(r), `${cat} on ${files[0]} should be hard-suppressed`);
    }
  });
});

describe('hard-suppress — what it must NOT swallow', () => {
  const linkedGroup = () => {
    const first = dismissed('[Sustainability] Hardcoded operational policy', [APIM]);
    return [
      first,
      dismissed('[Sustainability] Hardcoded policy limit', [APIM], { concernId: first.topicId }),
      dismissed('[Sustainability] Hardcoded operational limits', [APIM], { concernId: first.topicId }),
    ];
  };

  it('a different concern in the same file is not hard-suppressed', () => {
    const r = suppressReRaises(
      [raise('[Sustainability] Error swallowing', [APIM], { detail: 'The catch block returns null on a 401.' })],
      ledgerOf(...linkedGroup()), { changedFiles: [] },
    );
    assert.equal(hardSuppressed(r), undefined);
  });

  it('the same phrasing on a file outside the concern is not hard-suppressed', () => {
    const r = suppressReRaises(
      [raise('[Sustainability] Hardcoded policy limit', ['src/unrelated/billing.ts'])],
      ledgerOf(...linkedGroup()), { changedFiles: [] },
    );
    assert.equal(hardSuppressed(r), undefined);
  });

  it('three UNLINKED rewordings do not group — category text is never fuzzily merged', () => {
    // Deliberate limit, pinned so nobody "fixes" it with a similarity cut:
    // "Hardcoded timeout value" vs "Hardcoded credential value" scores 0.50,
    // and a permanent suppression must not rest on that. Rewording is bridged
    // by the adjudicator's `sameConcernAs` link, not by the text.
    const r = suppressReRaises(
      [raise('[Sustainability] Hardcoded policy limit', [APIM])],
      ledgerOf(
        dismissed('[Sustainability] Hardcoded operational policy', [APIM]),
        dismissed('[Sustainability] Hardcoded policy value', [APIM]),
        dismissed('[Sustainability] Hardcoded operational limits', [APIM]),
      ),
      { changedFiles: [] },
    );
    assert.equal(hardSuppressed(r), undefined);
  });

  it('stage1-mechanical entries still never count, even when linked', () => {
    const [a, b, c] = linkedGroup().map((e) => ({ ...e, source: 'stage1-mechanical' }));
    const r = suppressReRaises(
      [raise('[Sustainability] Hardcoded policy limit', [APIM])],
      ledgerOf(a, b, c), { changedFiles: [] },
    );
    assert.equal(hardSuppressed(r), undefined);
  });

  it('two linked dismissals stay below the threshold of 3', () => {
    const [a, b] = linkedGroup();
    const r = suppressReRaises(
      [raise('[Sustainability] Hardcoded policy limit', [APIM])],
      ledgerOf(a, b), { changedFiles: [] },
    );
    assert.equal(hardSuppressed(r), undefined);
  });
});

// ── The adjudicator's link: write-ledger-entries --triage sameConcernAs ──────

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'write-ledger-entries.mjs');

/** One round of the field report, as the audit's result JSON carries it. */
function roundFixture(dir, round, findings) {
  const resultPath = path.join(dir, `r${round}-result.json`);
  fs.writeFileSync(resultPath, JSON.stringify({ round, findings }));
  return resultPath;
}
const f = (id, category, section, hash) => ({
  id, severity: 'MEDIUM', category, section, detail: `Prose for ${id}, reworded every round.`,
  principle: 'Configuration over hardcoding', _pass: 'sustainability', _hash: hash,
});
const overrule = (why, extra = {}) => ({ outcome: 'dismissed', state: 'pending', ruling: 'overrule', why, ...extra });

function cli(args) {
  return execFileSync(process.execPath, [CLI, ...args, '--json'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

describe('write-ledger-entries --triage sameConcernAs → hard-suppress end to end', () => {
  it('three rounds, three phrasings, linked by the adjudicator, suppress the 4th raise', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'concern-'));
    const ledgerPath = path.join(dir, 'ledger.json');
    const triage = path.join(dir, 'triage.json');

    // R1: the concern is raised and dismissed.
    const r1 = roundFixture(dir, 1, [f('M1', '[Sustainability] Hardcoded operational policy', `${APIM}: retry limits`, 'h1')]);
    fs.writeFileSync(triage, JSON.stringify({ M1: overrule("limits are the provider's contract") }));
    cli(['--result', r1, '--ledger', ledgerPath, '--triage', triage, '--round', '1']);
    const rootTopic = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8')).entries[0].topicId;

    // R2: reworded, different first file; linked by the 6-char id the rulings block shows.
    const r2 = roundFixture(dir, 2, [f('M1', '[Sustainability] Hardcoded policy limit', `${EGRESS}, ${APIM}`, 'h2')]);
    fs.writeFileSync(triage, JSON.stringify({ M1: overrule('second raising', { sameConcernAs: rootTopic.slice(0, 6) }) }));
    const out2 = JSON.parse(cli(['--result', r2, '--ledger', ledgerPath, '--triage', triage, '--round', '2']));
    assert.equal(out2.linked, 1);

    // R3: [SYSTEMIC], rotated again; linked to the R2 entry — the chain must store the ROOT.
    const r3 = roundFixture(dir, 3, [f('H1', '[Sustainability] [SYSTEMIC] Hardcoded protocol and operational policy limits',
      `${RUNNER}, ${APIM}, ${EGRESS}`, 'h3')]);
    const r2Topic = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8')).entries.find((e) => e.topicId !== rootTopic).topicId;
    fs.writeFileSync(triage, JSON.stringify({ H1: overrule('third raising', { sameConcernAs: r2Topic }) }));
    cli(['--result', r3, '--ledger', ledgerPath, '--triage', triage, '--round', '3']);

    const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8'));
    assert.deepEqual(ledger.entries.map((e) => e.concernId ?? null), [null, rootTopic, rootTopic],
      'links resolve to the root, and the schema must not strip concernId');

    const r = suppressReRaises([raise('[Sustainability] Hardcoded policy limit', [RUNNER])], ledger, { changedFiles: [RUNNER] });
    assert.ok(hardSuppressed(r), 'the 4th raise must be hard-suppressed');
    assert.match(hardSuppressed(r).reason, new RegExp(`concern=${rootTopic}; linked=yes`));
  });

  it('refuses an unresolvable reference and writes nothing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'concern-'));
    const ledgerPath = path.join(dir, 'ledger.json');
    const triage = path.join(dir, 'triage.json');
    const r1 = roundFixture(dir, 1, [f('M1', '[Sustainability] Hardcoded policy value', EGRESS, 'h1')]);
    fs.writeFileSync(triage, JSON.stringify({ M1: overrule('x', { sameConcernAs: 'ffffff' }) }));
    assert.throws(() => cli(['--result', r1, '--ledger', ledgerPath, '--triage', triage]),
      (err) => err.status === 2 && /matches no ledger topicId/.test(err.stderr));
    assert.equal(fs.existsSync(ledgerPath), false, 'a batch applies whole or not at all');
  });
});

describe('resolveConcernLinks — refusals', () => {
  const e = (topicId, id) => ({ topicId, latestFindingId: id });
  const ledger = new Map([['abcdef111111', { topicId: 'abcdef111111' }], ['abcdef222222', { topicId: 'abcdef222222' }]]);

  it('an ambiguous prefix is an error, not a guess', () => {
    const { errors } = resolveConcernLinks([e('t1', 'M1')], new Map([['t1', 'abcdef']]), new Map([['M1', 't1']]), ledger);
    assert.match(errors[0], /ambiguous \(2 topicIds\)/);
  });
  it('a prefix shorter than the rulings-block width is refused', () => {
    const { errors } = resolveConcernLinks([e('t1', 'M1')], new Map([['t1', 'abc']]), new Map([['M1', 't1']]), ledger);
    assert.match(errors[0], /shorter than 6/);
  });
  it('self and cyclic references are refused', () => {
    const self = resolveConcernLinks([e('t1', 'M1')], new Map([['t1', 'M1']]), new Map([['M1', 't1']]), ledger);
    assert.match(self.errors[0], /names the finding itself/);
    const cyc = resolveConcernLinks([e('t1', 'M1'), e('t2', 'M2')],
      new Map([['t1', 'M2'], ['t2', 'M1']]), new Map([['M1', 't1'], ['M2', 't2']]), ledger);
    assert.match(cyc.errors[0], /cycle/);
  });
  it('a same-batch finding id resolves, and an existing link survives a re-ruling', () => {
    const linkedLedger = new Map([['t9', { topicId: 't9', concernId: 'root00000000' }]]);
    const { entries, errors } = resolveConcernLinks([e('t1', 'M1'), e('t2', 'M2'), e('t9', 'M9')],
      new Map([['t2', 'M1']]), new Map([['M1', 't1'], ['M2', 't2'], ['M9', 't9']]), linkedLedger);
    assert.deepEqual(errors, []);
    assert.deepEqual(entries.map((x) => x.concernId ?? null), [null, 't1', 'root00000000']);
  });
});

// ── Telemetry: the missed re-raise must leave a trace ──────────────────────

describe('near-miss telemetry', () => {
  it('records a KEPT finding that shares a file with a prior ruling, with its best score', () => {
    const prior = dismissed('[Sustainability] Hardcoded operational policy', [APIM]);
    const r = suppressReRaises([raise('[Sustainability] Hardcoded retry budget', [APIM])], ledgerOf(prior), { changedFiles: [] });
    assert.equal(r.kept.length, 1);
    assert.equal(r.nearMisses.length, 1);
    assert.equal(r.nearMisses[0].matchedTopic, prior.topicId);
    assert.ok(r.nearMisses[0].matchScore >= 0 && r.nearMisses[0].matchScore <= 0.35);
    assert.match(r.nearMisses[0].reason, /^near-miss; files=1; pass=same; source=session; outcome=dismissed; concern=none$/);
  });

  it('names the concern a kept raise matched below the threshold', () => {
    const a = dismissed('[Sustainability] Hardcoded policy limit', [APIM]);
    const b = dismissed('[Sustainability] Hardcoded policy value', [APIM], { concernId: a.topicId });
    const r = suppressReRaises([raise('[Sustainability] Hardcoded policy value', [APIM])], ledgerOf(a, b), { changedFiles: [] });
    // Either fuzzy-suppressed or kept; if kept, the concern must be named.
    for (const m of r.nearMisses) assert.match(m.reason, new RegExp(`concern=${a.topicId}:2$`));
  });

  it('records nothing for a kept finding with no prior ruling on its files', () => {
    const r = suppressReRaises([raise('[Sustainability] Anything', ['src/elsewhere.ts'])],
      ledgerOf(dismissed('[Sustainability] Hardcoded policy limit', [APIM])), { changedFiles: [] });
    assert.deepEqual(r.nearMisses, []);
  });

  it('stamps the epoch and bands the score distribution per round', () => {
    const s = summariseConcernRound({
      suppressed: [{ matchedSource: 'ruling-count' }, { matchedSource: 'session' }, { matchedSource: 'session', relitigationDeclined: true }],
      nearMisses: [{ matchScore: 0.05, reason: 'x; concern=none' }, { matchScore: 0.31, reason: 'x; concern=abc:2', fileCount: 3 }, { matchScore: 0.5, reason: 'x; concern=none' }],
      index: buildConcernIndex([]),
      reopenTelemetry: { undeclaredOnDismissal: 4 },
    });
    assert.equal(s.epoch, CONCERN_TELEMETRY_EPOCH);
    assert.deepEqual([s.hardSuppressed, s.fuzzySuppressed, s.relitigationDeclined], [1, 1, 1]);
    assert.deepEqual(s.nearMissBands, { lt10: 1, lt20: 0, lt35: 1, gte35: 1 });
    assert.equal(s.nearMissInConcern, 1);
    assert.equal(s.nearMissMultiFile, 1);
    assert.equal(s.reopenUndeclaredOnDismissal, 4);
  });
});

// ── The week-end read-back ─────────────────────────────────────────────────

describe('concern-telemetry-report — aggregation', async () => {
  const { summariseConcernTelemetry, readout } = await import('../scripts/concern-telemetry-report.mjs');
  const stats = (c) => ({ round: 2, concern: { epoch: CONCERN_TELEMETRY_EPOCH, ...c } });

  it('a window with no stamped rounds reads UNMEASURED, and names the stale-bundle rounds', () => {
    const { all } = summariseConcernTelemetry({ unstamped: [{ repo: 'o/consumer', n: 4 }] });
    assert.match(readout(all)[0], /^UNMEASURED .*4 R2\+ round\(s\) with rulings carried no stamp/);
  });

  it('flags a concern at threshold with no hard-suppress as NOT FIRING — the dead-feature signal', () => {
    const { all } = summariseConcernTelemetry({
      runs: [{ id: 'r1', repo: 'o/a', suppression_stats: stats({ concernsAtThreshold: 1, hardSuppressed: 0 }) }],
    });
    assert.match(readout(all)[0], /NOT FIRING/);
  });

  it('counts a prior ruling kept-beside in 2+ rounds as a recurring missed re-raise, per repo', () => {
    const kept = (run, repo, topic, score) => ({ run_id: run, repo, action: 'kept', matched_topic_id: topic, match_score: score, reason: 'near-miss; concern=none' });
    const { all, byRepo } = summariseConcernTelemetry({
      runs: [
        { id: 'r1', repo: 'o/a', suppression_stats: stats({ nearMisses: 2, concernsLinked: 1, nearMissBands: { lt20: 2 } }) },
        { id: 'r2', repo: 'o/a', suppression_stats: stats({ nearMisses: 1, hardSuppressed: 1 }) },
      ],
      events: [
        kept('r1', 'o/a', 'T1', 0.18), kept('r2', 'o/a', 'T1', 0.31), kept('r1', 'o/a', 'T2', 0.05),
        { run_id: 'r2', repo: 'o/a', action: 'suppressed', matched_topic_id: 'hard-suppress', reason: 'Category+file overruled 3 times — hard-suppressed; concern=x; linked=yes' },
      ],
    });
    assert.equal(all.recurringMissedTopics, 1);
    assert.deepEqual(all.topRecurring, [{ topic: 'T1', runs: 2, bestScore: 0.31 }]);
    assert.equal(byRepo['o/a'].recurringMissedTopics, 1);
    assert.equal(all.hardSuppressedLinked, 1);
    assert.equal(all.runsWithLinkedConcern, 1);
    assert.equal(all.nearMissBands.lt20, 2);
    assert.match(readout(all)[0], /FIRING — 1 hard-suppressed \(1 via an adjudicator link\)/);
  });
});

// ── What reaches the store ─────────────────────────────────────────────────

describe('suppression_events rows and suppression_stats — what the week reads back', async () => {
  const { buildSuppressionEventRows } = await import('../scripts/lib/store/runs-findings.mjs');
  const { buildSuppressionStats } = await import('../scripts/lib/audit/run-persistence.mjs');

  // Derived from real suppressReRaises output, never a hand-written row: a
  // factory shaped by what the writer expects would encode the assumption.
  const prior = dismissed('[Sustainability] Hardcoded operational policy', [APIM]);
  const result = suppressReRaises([raise('[Sustainability] Hardcoded retry budget', [APIM])], ledgerOf(prior), { changedFiles: [] });

  it('writes a kept row per near-miss, inside the table\'s CHECK and NUMERIC(4,3)', () => {
    const rows = buildSuppressionEventRows('run-1', { ...result, reopened: result.reopened });
    const kept = rows.filter((r) => r.action === 'kept');
    assert.equal(kept.length, 1);
    assert.ok(['suppressed', 'reopened', 'kept'].includes(kept[0].action));
    assert.equal(kept[0].matched_topic_id, prior.topicId);
    assert.ok(kept[0].match_score >= 0 && kept[0].match_score < 10, 'NUMERIC(4,3) holds 0.000–9.999');
    assert.equal(Math.round(kept[0].match_score * 1000), kept[0].match_score * 1000, 'three decimals at most');
    assert.ok(kept[0].finding_fingerprint, 'finding_fingerprint is NOT NULL');
  });

  it('a result from an older bundle (no nearMisses key) still maps', () => {
    const rows = buildSuppressionEventRows('run-1', { suppressed: [], reopened: [] });
    assert.deepEqual(rows, []);
  });

  it('suppression_stats carries the epoch-stamped counts, never finding bodies', () => {
    const stats = buildSuppressionStats({ round: 2, ledger: { entryCount: 1, adjudicated: 1 }, suppression: {
      keptCount: 1, suppressedCount: 0, reopenedCount: 0,
      nearMisses: result.nearMisses, concernTelemetry: result.concernTelemetry,
    } });
    assert.equal(stats.concern.epoch, CONCERN_TELEMETRY_EPOCH);
    assert.equal(stats.concern.nearMisses, 1);
    assert.equal(JSON.stringify(stats).includes('compile-time constants'), false, 'no finding prose in a run column');
  });
});

describe('the adjudicator sees the prior ruling on the finding itself', () => {
  it('a kept near-miss carries _priorRuling, so linking needs no ledger search', () => {
    const prior = dismissed('[Sustainability] Hardcoded operational policy', [APIM]);
    const r = suppressReRaises([raise('[Sustainability] Hardcoded retry budget', [APIM])], ledgerOf(prior), { changedFiles: [] });
    assert.equal(r.kept[0]._priorRuling.topicId, prior.topicId);
    assert.equal(typeof r.kept[0]._priorRuling.score, 'number');
  });
});

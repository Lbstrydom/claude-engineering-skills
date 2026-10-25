/**
 * Tests for the structural-or-stop card (docs/plans/audit-round-cap-structural-or-stop.md §2.2, §9).
 *
 * Finding fixtures mirror the field shape of real round results (category / section / detail / severity,
 * and for code audits `_primaryFile` + `affectedFiles`) — a plan finding carries a `section` and prose, not a file.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  cardFilesOf, clusterAuditRounds, matchCluster, isCorroborated, verdictFor, assembleCard,
  renderStructuralCard, buildStructuralCard, writeCardFile, readMatchingCard, readAuditRounds, CARD_VERSION,
} from '../scripts/lib/audit/structural-card.mjs';

const CAPS_PLAN = { soft: 3, absolute: 5 };
const f = (over) => ({ id: 'H1', severity: 'HIGH', category: 'Aggregate Isolation Contract', section: '§2.3 Gap 2 — refresh', detail: 'x', ...over });
const code = (category, file, severity = 'HIGH') => ({ severity, category, section: file, _primaryFile: file, affectedFiles: [file], detail: 'd' });

describe('cardFilesOf', () => {
  it('plan findings: the repo paths their prose names, never the section text', () => {
    const files = cardFilesOf(f({ detail: 'see scripts/lib/store/runs-findings.mjs:2301 and tests/a.test.mjs' }), 'plan');
    assert.deepEqual(files, ['scripts/lib/store/runs-findings.mjs', 'tests/a.test.mjs']);
  });
  it('plan finding with no path gets no files (no junk from the section heading)', () => {
    assert.deepEqual(cardFilesOf(f({ detail: 'no paths here' }), 'plan'), []);
  });
  it('code findings: affectedFiles + primary file, deduped, prose rejected', () => {
    assert.deepEqual(cardFilesOf(code('X', 'src/a.js'), 'code'), ['src/a.js']);
    assert.deepEqual(cardFilesOf({ category: 'X', section: 'phase 4 — adjudication and recording' }, 'code'), []);
  });
});

describe('clusterAuditRounds', () => {
  const rounds = [
    { round: 1, findings: [code('Persistence recovery', 'src/a.js'), code('Wire shape', 'src/b.js', 'LOW')], suppressed: 0 },
    { round: 2, findings: [code('Persistence recovery', 'src/a.js'), code('Other', 'src/c.js', 'MEDIUM')], suppressed: 2 },
    { round: 3, findings: [], suppressed: 1 },
    { round: 4, findings: [code('Persistence Recovery', 'src/a.js')], suppressed: 0 },
  ];
  const r = clusterAuditRounds(rounds, 'code');
  it('merges the same category (case-insensitive) on a shared file across rounds, counting distinct rounds', () => {
    const a = r.clusters.find((c) => c.files.includes('src/a.js'));
    assert.equal(a.recurrence, 3);
    assert.deepEqual(a.rounds, [1, 2, 4]);
    assert.equal(a.findingCount, 3);
    assert.equal(r.clusters[0], a, 'most recurrent first');
  });
  it('a different category on another file is its own cluster', () => {
    assert.equal(r.clusters.filter((c) => c.recurrence === 1).length, 2);
  });
  it('clean-round rate counts empty rounds; suppressed re-raises are totalled, not clustered', () => {
    assert.equal(r.cleanRate, 0.25);
    assert.equal(r.suppressedTotal, 3);
  });
  it('files raised in 3+ rounds are reported even under reworded categories', () => {
    const reworded = clusterAuditRounds([
      { round: 1, findings: [code('Persistence recovery', 'src/a.js')] },
      { round: 2, findings: [code('Journal state integrity', 'src/a.js')] },
      { round: 3, findings: [code('Output validation', 'src/a.js')] },
    ], 'code');
    assert.equal(reworded.clusters.length, 3, 'category rewording defeats the cluster key');
    assert.deepEqual(reworded.hotFiles, [{ file: 'src/a.js', rounds: [1, 2, 3] }]);
  });
  it('plan audits also link on the cited plan section', () => {
    const p = clusterAuditRounds([
      { round: 1, findings: [f({ category: 'A', section: '§2.3 Gap 2' })] },
      { round: 2, findings: [f({ category: 'B', section: '§2.3 something else' })] },
      { round: 3, findings: [f({ category: 'C', section: '§2.4' })] },
    ], 'plan');
    assert.equal(p.clusters.length, 2);
    assert.equal(p.clusters[0].recurrence, 2);
  });
});

describe('verdictFor — ordered, total, first-match', () => {
  const C = (recurrence, sev) => ({ recurrence, severities: { HIGH: 0, MEDIUM: 0, LOW: 0, ...sev } });
  const ALL = { debt: 'measured', arch: 'measured' };
  const PART = { debt: 'measured', arch: 'failed' };
  const NQ = { debt: 'measured', arch: 'not-queried' };
  const fileEv = [{ kind: 'file' }];
  const catEv = [{ kind: 'category' }];
  const precEv = [{ kind: 'precedent' }];

  for (const [name, cluster, ev, cov, want, rule] of [
    ['one round, corroborated: still polish (rule 1)', C(1, { HIGH: 1 }), fileEv, ALL, 'polish', 1],
    ['recurrent all-LOW, corroborated: polish (rule 2)', C(3, { LOW: 3 }), fileEv, ALL, 'polish', 2],
    ['recurrent HIGH + file match: structural (rule 3)', C(2, { HIGH: 1 }), fileEv, ALL, 'structural', 3],
    ['corroborated despite a failed source: structural (positive evidence)', C(2, { MEDIUM: 1 }), fileEv, PART, 'structural', 3],
    ['arch precedent corroborates', C(2, { HIGH: 1 }), precEv, ALL, 'structural', 3],
    ['category-only does NOT corroborate: full coverage ⇒ local (rule 5)', C(2, { HIGH: 1 }), catEv, ALL, 'local', 5],
    ['uncorroborated + failed source: local-or-structural (rule 4)', C(2, { HIGH: 1 }), [], PART, 'local-or-structural', 4],
    ['uncorroborated + not-queried arch: local-or-structural (rule 4)', C(2, { MEDIUM: 2 }), [], NQ, 'local-or-structural', 4],
    ['uncorroborated + full coverage: local (rule 5)', C(2, { HIGH: 1 }), [], ALL, 'local', 5],
  ]) {
    it(name, () => {
      const v = verdictFor(cluster, ev, cov);
      assert.equal(v.verdict, want);
      assert.equal(v.rule, rule);
    });
  }
  it('isCorroborated: file and precedent only', () => {
    assert.equal(isCorroborated(fileEv), true);
    assert.equal(isCorroborated(precEv), true);
    assert.equal(isCorroborated(catEv), false);
    assert.equal(isCorroborated([{ kind: 'text' }]), false);
  });
});

describe('matchCluster', () => {
  const cluster = { files: ['src/import/ingest.js'], categoryKeys: ['identity gap'] };
  it('records file, category and text matches with their `via`, from measured sources only', () => {
    const ev = matchCluster(cluster, {
      debt: { status: 'measured', items: [{ id: 'd1', label: 'dedupe', files: ['SRC/import/ingest.js'] }] },
      upstream: { status: 'measured', items: [{ id: 'u1', label: 'x', category: 'Identity Gap', files: [] }] },
      proposals: { status: 'measured', items: [{ id: 'p1', label: 'prim', text: 'where: src/import/ingest.js shared primitive', files: [] }] },
      triage: { status: 'failed', items: [{ id: 't1', label: 'ignored', files: ['src/import/ingest.js'] }] },
    });
    assert.deepEqual(ev.map((e) => `${e.source}:${e.kind}`).sort(), ['debt:file', 'proposals:text', 'upstream:category']);
    assert.ok(ev.every((e) => e.via));
  });
  it('works for 1 to 4 clusters alike: no hub filter erases a genuine shared file', () => {
    for (let n = 1; n <= 4; n++) {
      const clusters = Array.from({ length: n }, (_, i) => ({ files: [`src/f${i}.js`, 'src/shared.js'], categoryKeys: [] }));
      const src = { debt: { status: 'measured', items: [{ id: 'd', label: 'x', files: ['src/shared.js'] }] } };
      for (const c of clusters) assert.equal(isCorroborated(matchCluster(c, src)), true, `n=${n}`);
    }
  });
});

describe('assembleCard coverage', () => {
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ round: 1, findings: [] })).length;
  const rounds = [1, 2].map((round) => ({
    round,
    findings: [1, 2, 3, 4].map((i) => code(`Cat${i}`, `src/f${i}.js`)),
  }));
  const audit = clusterAuditRounds(rounds, 'code');
  const okSrc = { status: 'measured', items: [] };
  const sources = { debt: okSrc, recurring: okSrc, triage: okSrc, upstream: okSrc, q2: okSrc, proposals: okSrc, arch: okSrc };
  it('four recurrent clusters, arch answering for only the top three: the fourth is never LOCAL', () => {
    assert.equal(mk(1), 1);
    const archByCluster = Object.fromEntries(audit.clusters.slice(0, 3).map((c) => [c.id, { status: 'measured', items: [] }]));
    const card = assembleCard({ sid: 's', mode: 'code', round: 7, caps: { soft: 6, absolute: 8 }, audit, sources, archByCluster });
    const verdicts = card.clusters.map((c) => c.verdict);
    assert.deepEqual(verdicts.slice(0, 3), ['local', 'local', 'local']);
    assert.equal(verdicts[3], 'local-or-structural');
    assert.equal(card.clusters[3].coverage.arch, 'not-queried');
    assert.deepEqual(card.clusters[3].unmeasured, ['arch']);
  });
  it('a failed arch read marks that cluster unclassifiable and is named in the card', () => {
    const archByCluster = { c1: { status: 'failed', detail: 'store-off', items: [] } };
    const card = assembleCard({ sid: 's', mode: 'code', round: 7, caps: { soft: 6, absolute: 8 }, audit, sources: { ...sources, arch: { status: 'failed', detail: 'store-off', items: [] } }, archByCluster });
    assert.equal(card.clusters[0].verdict, 'local-or-structural');
    assert.ok(card.unmeasuredSources.some((u) => u.source === 'arch'));
  });
  it('shared-primitive check is promoted at 3+ recurrent clusters', () => {
    const card = assembleCard({ sid: 's', mode: 'code', round: 7, caps: null, audit, sources, archByCluster: {} });
    assert.equal(card.sharedPrimitiveCheck.recurrent, 4);
    assert.equal(card.sharedPrimitiveCheck.promoted, true);
  });
});

describe('renderStructuralCard — honest output', () => {
  const rounds = [1, 2, 3].map((round) => ({ round, findings: [code('Lock ordering', 'src/db/lots.js')] }));
  const audit = clusterAuditRounds(rounds, 'code');
  const okSrc = { status: 'measured', items: [] };
  const base = { debt: okSrc, recurring: okSrc, triage: { status: 'failed', detail: 'store-unreachable', items: [] }, upstream: okSrc, q2: okSrc, proposals: okSrc };
  const card = assembleCard({ sid: 's', mode: 'plan', round: 4, caps: CAPS_PLAN, audit, sources: { ...base, arch: okSrc }, archByCluster: { c1: { status: 'measured', items: [] } } });
  const text = renderStructuralCard(card);

  it('names an unreadable source and its reason; no cluster reads LOCAL while it is down', () => {
    assert.match(text, /triage unreadable \(store-unreachable\)/);
    assert.match(text, /UNMEASURED: triage \(store-unreachable\)/);
    assert.match(text, /LOCAL\?/);
    assert.doesNotMatch(text, /\bLOCAL\s+\[/);
  });
  it('never claims there is no structural pattern; zero structural is stated with counts', () => {
    assert.doesNotMatch(text, /no structural pattern/i);
    assert.match(text, /0 structural · 0 local · 1 unclassifiable/);
  });
  it('ends in a human call with the three choices, CONTINUE naming --past-cap', () => {
    assert.match(text, /STOP .*debt-auto-capture/);
    assert.match(text, /STRUCTURAL .*\/plan/);
    assert.match(text, /CONTINUE .*--past-cap/);
  });
  it('past the absolute cap, CONTINUE is not available', () => {
    const t = renderStructuralCard({ ...card, round: 6 });
    assert.match(t, /CONTINUE\s+not available \(absolute cap 5\)/);
  });
  it('an unreadable audit history is UNMEASURED, not "no clusters"', () => {
    const c = assembleCard({ sid: null, mode: 'plan', round: 4, caps: CAPS_PLAN, audit: null, auditUnmeasured: 'no session id', sources: { ...base, arch: okSrc } });
    const t = renderStructuralCard(c);
    assert.match(t, /This audit: UNMEASURED \(no session id\)/);
    assert.match(t, /not computed/);
    assert.doesNotMatch(t, /no structural pattern/i);
  });
});

describe('buildStructuralCard (IO shell, injected deps)', () => {
  const okSrc = { status: 'measured', items: [] };
  const deps = (over = {}) => ({
    readRounds: () => ({ rounds: [1, 2].map((round) => ({ round, findings: [code('A', 'src/a.js')] })), unmeasured: null }),
    readStore: async () => ({ debt: okSrc, recurring: okSrc, triage: okSrc }),
    readProposals: async () => okSrc,
    gatherBacklog: async () => ({ upstream: okSrc, q2: okSrc }),
    runArch: async () => okSrc,
    ...over,
  });
  it('a throwing reader is named as failed, never read as empty', async () => {
    const { card } = await buildStructuralCard({ sid: 's', mode: 'code', round: 7, caps: { soft: 6, absolute: 8 }, env: {}, deps: deps({ readStore: async () => { throw new Error('boom'); } }) });
    assert.equal(card.sources.debt.status, 'failed');
    assert.match(card.sources.debt.detail, /boom/);
    assert.equal(card.clusters[0].verdict, 'local-or-structural');
  });
  it('air-gapped (empty AUDIT_DB_URL): arch is never queried and is reported not-queried', async () => {
    let called = 0;
    const { card, text } = await buildStructuralCard({ sid: 's', mode: 'code', round: 7, env: { AUDIT_DB_URL: '' }, deps: deps({ runArch: async () => { called++; return okSrc; } }) });
    assert.equal(called, 0);
    assert.equal(card.sources.arch.status, 'failed');
    assert.match(text, /arch unreadable \(not queried/);
  });
  it('AUDIT_CARD_NO_ARCH=1 also skips arch', async () => {
    let called = 0;
    await buildStructuralCard({ sid: 's', mode: 'code', round: 7, env: { AUDIT_CARD_NO_ARCH: '1' }, deps: deps({ runArch: async () => { called++; return okSrc; } }) });
    assert.equal(called, 0);
  });
  it('arch is queried for at most three recurrent clusters', async () => {
    let called = 0;
    const rounds = [1, 2].map((round) => ({ round, findings: [1, 2, 3, 4, 5].map((i) => code(`C${i}`, `src/f${i}.js`)) }));
    await buildStructuralCard({ sid: 's', mode: 'code', round: 7, env: {}, deps: deps({ readRounds: () => ({ rounds, unmeasured: null }), runArch: async () => { called++; return okSrc; } }) });
    assert.equal(called, 3);
  });
  it('no round results ⇒ UNMEASURED audit history, card still built', async () => {
    const { card } = await buildStructuralCard({ sid: 's', mode: 'code', round: 7, env: {}, deps: deps({ readRounds: () => ({ rounds: null, unmeasured: 'no files' }) }) });
    assert.equal(card.audit, null);
    assert.equal(card.auditUnmeasured, 'no files');
  });
});

describe('readAuditRounds against real files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'card-rounds-'));
  fs.writeFileSync(path.join(dir, 'audit-plan-1-2-r1-result.json'), JSON.stringify({ findings: [f({})], _suppression: { kept: 1, suppressed: 2, reopened: 0 } }));
  fs.writeFileSync(path.join(dir, 'audit-plan-1-2-r2-result.json'), JSON.stringify({ findings: [], _suppression: { kept: 0, suppressed: 1, reopened: 0 } }));
  it('reads each round and its suppressed count (the result stores a count, not the findings)', () => {
    const r = readAuditRounds({ sid: 'audit-plan-1-2', auditDir: dir });
    assert.equal(r.unmeasured, null);
    assert.deepEqual(r.rounds.map((x) => [x.round, x.findings.length, x.suppressed]), [[1, 1, 2], [2, 0, 1]]);
  });
  it('no session id, or no files, is unmeasured with a reason', () => {
    assert.match(readAuditRounds({ sid: null, auditDir: dir }).unmeasured, /no session id/);
    assert.match(readAuditRounds({ sid: 'other', auditDir: dir }).unmeasured, /no other-r<N>-result\.json/);
  });
  it('a malformed round file is unmeasured, never skipped', () => {
    fs.writeFileSync(path.join(dir, 'audit-plan-9-9-r1-result.json'), '{not json');
    assert.match(readAuditRounds({ sid: 'audit-plan-9-9', auditDir: dir }).unmeasured, /unreadable round result/);
  });
});

describe('card file round trip', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'card-file-'));
  it('writes and reads back for the same round, refuses a different round or a missing file', () => {
    const card = { version: CARD_VERSION, round: 4 };
    writeCardFile(dir, 'x-r4-structural-card.json', card);
    assert.equal(readMatchingCard(dir, 'x-r4-structural-card.json', { round: 4 }).ok, true);
    assert.equal(readMatchingCard(dir, 'x-r4-structural-card.json', { round: 5 }).ok, false);
    assert.match(readMatchingCard(dir, 'nope.json', { round: 4 }).reason, /no card on disk/);
  });
});

describe('plan findings that name a file by bare name', () => {
  const index = new Map([['runs-findings.mjs', ['scripts/lib/store/runs-findings.mjs']], ['config.mjs', ['a/config.mjs', 'b/config.mjs']]]);
  it('resolves a unique basename and drops an ambiguous one (never guesses)', () => {
    const files = cardFilesOf(f({ detail: 'runs-findings.mjs and config.mjs and nothing.mjs' }), 'plan', index);
    assert.deepEqual(files, ['scripts/lib/store/runs-findings.mjs']);
  });
  it('without an index, bare names are not guessed', () => {
    assert.deepEqual(cardFilesOf(f({ detail: 'runs-findings.mjs' }), 'plan'), []);
  });
  it('code mode never resolves bare names from prose', () => {
    assert.deepEqual(cardFilesOf({ category: 'X', section: 'runs-findings.mjs', detail: 'runs-findings.mjs' }, 'code', index), ['runs-findings.mjs']);
  });
  it('a failing file index is a note on the card, not a crash', async () => {
    const okSrc = { status: 'measured', items: [] };
    const { card } = await buildStructuralCard({
      sid: 's', mode: 'plan', round: 4, env: { AUDIT_CARD_NO_ARCH: '1' },
      deps: {
        readRounds: () => ({ rounds: [{ round: 1, findings: [f({})] }], unmeasured: null }),
        fileIndex: () => { throw new Error('not a git repo'); },
        readStore: async () => ({ debt: okSrc, recurring: okSrc, triage: okSrc }),
        readProposals: async () => okSrc, gatherBacklog: async () => ({ upstream: okSrc, q2: okSrc }),
      },
    });
    assert.match(card.notes[0], /bare file names were not resolved/);
  });
});

describe('code-audit round 1 fixes', () => {
  const okSrc = { status: 'measured', items: [] };
  const baseDeps = (over = {}) => ({
    readRounds: () => ({ rounds: [1, 2].map((round) => ({ round, findings: [code('A', 'src/a.js')] })), unmeasured: null }),
    readStore: async () => ({ debt: okSrc, recurring: okSrc, triage: okSrc }),
    readProposals: async () => okSrc, gatherBacklog: async () => ({ upstream: okSrc, q2: okSrc }), runArch: async () => okSrc, ...over,
  });

  it('nested plan sections stay distinct: §2.3.1 and §2.3.2 are not one cluster', () => {
    const r = clusterAuditRounds([
      { round: 1, findings: [f({ category: 'A', section: '§2.3.1 first' })] },
      { round: 2, findings: [f({ category: 'B', section: '§2.3.2 second' })] },
    ], 'plan');
    assert.equal(r.clusters.length, 2);
    const same = clusterAuditRounds([
      { round: 1, findings: [f({ category: 'A', section: '§2.3.1 first' })] },
      { round: 2, findings: [f({ category: 'B', section: '§2.3.1 again' })] },
    ], 'plan');
    assert.equal(same.clusters.length, 1);
  });

  it('a PARTIAL source still contributes positive matches but cannot support a LOCAL verdict', () => {
    const rounds = [1, 2].map((round) => ({ round, findings: [code('Lock ordering', 'src/db/lots.js')] }));
    const audit = clusterAuditRounds(rounds, 'code');
    const ok = { status: 'measured', items: [] };
    const sources = { debt: ok, recurring: ok, triage: ok, upstream: ok, q2: ok, proposals: { status: 'partial', detail: 'truncated read', items: [] }, arch: ok };
    const noEvidence = assembleCard({ sid: 's', mode: 'code', round: 7, caps: null, audit, sources, archByCluster: { c1: ok } });
    assert.equal(noEvidence.clusters[0].verdict, 'local-or-structural', 'incomplete read ⇒ never LOCAL');
    assert.ok(noEvidence.clusters[0].unmeasured.includes('proposals'));
    const withHit = { ...sources, proposals: { status: 'partial', detail: 'truncated read', items: [{ id: 'p', label: 'x', files: ['src/db/lots.js'] }] } };
    assert.equal(assembleCard({ sid: 's', mode: 'code', round: 7, caps: null, audit, sources: withHit, archByCluster: { c1: ok } }).clusters[0].verdict, 'structural');
    assert.match(renderStructuralCard(noEvidence), /proposals PARTIAL\(0; truncated read\)/);
  });

  it('a hung store read is bounded as a whole, repo resolution included', async () => {
    const t0 = Date.now();
    // Same module-level deadline constant the card uses; the injected reader never settles.
    const { card } = await buildStructuralCard({
      sid: 's', mode: 'code', round: 7, env: { AUDIT_CARD_NO_ARCH: '1' },
      deps: baseDeps({ readStore: () => new Promise(() => {}) }),
      timeoutMs: 50,
    });
    assert.ok(Date.now() - t0 < 5000);
    assert.equal(card.sources.debt.status, 'failed');
    assert.match(card.sources.debt.detail, /timed out/);
  });

  it('default audit dir follows the supplied cwd, not the process cwd', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'card-cwd-'));
    fs.mkdirSync(path.join(dir, '.audit'));
    fs.writeFileSync(path.join(dir, '.audit', 'audit-plan-9-9-r1-result.json'), JSON.stringify({ findings: [f({})] }));
    let seen = null;
    await buildStructuralCard({
      sid: 'audit-plan-9-9', mode: 'plan', round: 4, cwd: dir, env: { AUDIT_CARD_NO_ARCH: '1' },
      deps: baseDeps({ readRounds: ({ auditDir }) => { seen = auditDir; return { rounds: null, unmeasured: 'x' }; } }),
    });
    assert.equal(path.resolve(seen), path.resolve(dir, '.audit'));
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('a card is bound to its mode and plan: the same session and round for another audit does not authorise an override', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'card-prov-'));
    writeCardFile(dir, 'x-r4-structural-card.json', { version: CARD_VERSION, round: 4, mode: 'plan', planFile: 'docs/plans/a.md' });
    assert.equal(readMatchingCard(dir, 'x-r4-structural-card.json', { round: 4, mode: 'plan', planFile: 'docs/plans/a.md' }).ok, true);
    assert.match(readMatchingCard(dir, 'x-r4-structural-card.json', { round: 4, mode: 'code', planFile: 'docs/plans/a.md' }).reason, /plan audit, not code/);
    assert.match(readMatchingCard(dir, 'x-r4-structural-card.json', { round: 4, mode: 'plan', planFile: 'docs/plans/b.md' }).reason, /card is for plan/);
    for (const [label, planFile] of [['null', null], ['empty', ''], ['missing', undefined]]) {
      const body = { version: CARD_VERSION, round: 4, mode: 'plan' };
      if (planFile !== undefined) body.planFile = planFile;
      writeCardFile(dir, 'y-r4-structural-card.json', body);
      assert.match(readMatchingCard(dir, 'y-r4-structural-card.json', { round: 4, mode: 'plan', planFile: 'docs/plans/a.md' }).reason, /none recorded/, `${label} planFile must not authorise`);
    }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
});

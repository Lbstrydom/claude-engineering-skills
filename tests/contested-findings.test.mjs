import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  selectContested, validateVerdict, buildEvidencePack, VerifyItemSchema, VerifyArtifactSchema, MIN_QUOTE_CHARS, PACK_CAP_CHARS,
} from '../scripts/lib/audit/contested-findings.mjs';
import { redactSecrets } from '../scripts/lib/sensitive-egress-gate.mjs';
import { makeVerifyRepo, finding } from './helpers/verify-repo.mjs';

const require = createRequire(import.meta.url);
const REAL = require('./fixtures/verify/pr395-rows.json');
const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';

describe('selectContested over real PR #395 rows (fixture: ' + REAL.source.sid + ')', () => {
  const disputed = REAL.ledger.entries.filter((e) => e.adjudicationOutcome === 'dismissed');
  it('the fixture is the trimmed real rows, not a hand-written factory', () => {
    assert.match(REAL.source.files, /PR #395/);
    assert.equal(REAL.rounds.length, 3);
    assert.ok(REAL.rounds[0].findings.length >= 30);
    assert.equal(disputed.length, 4);
  });
  for (const round of [1, 2, 3]) {
    it(`round ${round}: the findings the author disputed are the contested set, as author-dispute`, () => {
      const ids = disputed.filter((e) => e.resolvedRound === round).map((e) => e.latestFindingId);
      const triage = Object.fromEntries(ids.map((id) => [id, { validity: 'uncertain' }]));
      const results = REAL.rounds.filter((r) => r.round <= round).map((r) => ({ round: r.round, result: { findings: structuredClone(r.findings) } }));
      const out = selectContested({ results, ledger: { entries: [] }, triage, max: 10 });
      assert.deepEqual(out.selected.map((s) => s.source.findingId).sort(), [...ids].sort());
      assert.ok(out.selected.every((s) => s.contestKind === 'author-dispute'));
      assert.equal(out.overCap.length, 0);
    });
  }
  it('without a triage dispute, a ledger dismissal or a claimable flip nothing is contested', () => {
    const results = REAL.rounds.map((r) => ({ round: r.round, result: { findings: structuredClone(r.findings) } }));
    assert.deepEqual(selectContested({ results, ledger: { entries: [] }, triage: {} }).selected, []);
  });
});

describe('selectContested kinds, ordering and the cap', () => {
  const round = (n, findings) => ({ round: n, result: { findings } });
  it('a triage rebut or an uncertain validity is an author dispute; LOW is not selectable', () => {
    const fs_ = [finding('H1'), finding('M1', { severity: 'MEDIUM', _hash: 'x2' }), finding('L1', { severity: 'LOW', _hash: 'x3' })];
    const out = selectContested({ results: [round(1, fs_)], triage: { H1: { action: 'rebut' }, M1: { validity: 'uncertain' }, L1: { action: 'rebut' } } });
    assert.deepEqual(out.selected.map((s) => s.source.findingId), ['H1', 'M1']);
    assert.deepEqual(out.notSelected.map((n) => n.reason), ['low-severity']);
  });
  it('two findings that share a topicId are each triaged by their own id', () => {
    const out = selectContested({ results: [round(1, [finding('H1'), finding('H2')])], triage: { H1: { action: 'rebut' }, H2: { action: 'rebut' } } });
    assert.deepEqual(out.selected.map((s) => s.source.findingId).sort(), ['H1', 'H2']);
  });
  it('an auditor dispute is a re-raised finding that matches a dismissed ledger entry', () => {
    const f = finding('H1');
    const probe = selectContested({ results: [round(2, [structuredClone(f)])], triage: { H1: { action: 'rebut' } } });
    const topicId = probe.selected[0].source.topicId;
    const out = selectContested({ results: [round(2, [structuredClone(f)])], ledger: { entries: [{ topicId, adjudicationOutcome: 'dismissed' }] } });
    assert.deepEqual(out.selected.map((s) => [s.source.findingId, s.contestKind]), [['H1', 'auditor-dispute']]);
    const accepted = selectContested({ results: [round(2, [structuredClone(f)])], ledger: { entries: [{ topicId, adjudicationOutcome: 'accepted' }] } });
    assert.deepEqual(accepted.selected, []);
  });
  it('12 contested findings with max 10: HIGH first then earliest round, 2 over-cap with ranks, none dropped', () => {
    const mk = (i, sev) => finding(`F${i}`, { severity: sev, _hash: `hh${i}`, section: `src/f${i}.js — x`, _primaryFile: `src/f${i}.js`, affectedFiles: [`src/f${i}.js`] });
    const all = [...Array.from({ length: 4 }, (_, i) => mk(i, 'MEDIUM')), ...Array.from({ length: 8 }, (_, i) => mk(i + 4, 'HIGH'))];
    const triage = Object.fromEntries(all.map((f) => [f.id, { action: 'rebut' }]));
    const out = selectContested({ results: [round(1, all)], triage, max: 10 });
    assert.equal(out.selected.length, 10);
    assert.deepEqual(out.overCap.map((o) => o.rank), [1, 2]);
    assert.ok(out.overCap.every((o) => o.severity === 'MEDIUM'), 'the MEDIUM findings are the ones over the cap');
    assert.ok(out.selected.slice(0, 8).every((s) => s.severity === 'HIGH'));
  });
  describe('flips', () => {
    const f = () => finding('H1');
    const rounds = [round(1, [f()]), round(2, []), round(3, [f()])];
    const shas = { 1: 'a', 2: 'b', 3: 'c' };
    it('present, absent, present with no change to its files is a flip', () => {
      const out = selectContested({ results: rounds, shaByRound: shas, changedFiles: () => ['other.js'] });
      assert.deepEqual(out.selected.map((s) => [s.source.findingId, s.contestKind]), [['H1', 'flip']]);
    });
    it('a change to its file voids the flip (control)', () => {
      assert.deepEqual(selectContested({ results: rounds, shaByRound: shas, changedFiles: () => ['src/a.js'] }).selected, []);
    });
    it('with no shas a flip is not claimed', () => {
      assert.deepEqual(selectContested({ results: rounds }).selected, []);
    });
    it('a flip whose latest appearance precedes round N is listed in notSelected, not selected', () => {
      const out = selectContested({ results: [...rounds, round(4, [])], shaByRound: { ...shas, 4: 'd' }, changedFiles: () => [] });
      assert.deepEqual(out.selected, []);
      assert.deepEqual(out.notSelected.map((n) => n.reason), ['flip-not-present-in-latest-round']);
    });
  });
});

describe('validateVerdict: eligibility, not truth', () => {
  const quote = 'export function verifyRollupProvenance(rollup)';
  const pack = [
    { tag: 'E0', provenance: { source: 'finding', rev: 'finding' }, text: 'detail: the verifier accepts any outcome with status landed', eligible: false },
    { tag: 'E1', provenance: { source: 'code', path: 'a.js', range: [1, 3], rev: 'audited-tree' }, text: `// a.js:1-3\n${quote} {\n  return true;\n}`, eligible: true },
    { tag: 'E2', provenance: { source: 'code', path: '.env', range: [1, 3], rev: 'audited-tree' }, text: '[withheld: sensitive path deadbeef]', eligible: false },
    { tag: 'E3', provenance: { source: 'test', path: 't.test.mjs', rev: 'audited-tree', run: 'node --test' }, text: '# fail 1\nnot ok 1 - the verifier rejects landed', eligible: false },
  ];
  const v = (over) => validateVerdict({ verdict: 'refuted', evidenceRefs: ['E1'], quote, ...over }, pack);
  it('negative control: a quote present in an eligible cited item stays refuted and is only evidence-backed', () => {
    assert.deepEqual(v({}), { verdict: 'refuted', backed: true });
  });
  it('inconclusive passes through untouched', () => {
    assert.deepEqual(v({ verdict: 'inconclusive', quote: '' }), { verdict: 'inconclusive', backed: false });
  });
  for (const [name, over, rule] of [
    ['a quote absent from the pack', { quote: 'if (outcome.status === "landed") return false;' }, 'quote-not-in-evidence'],
    ['an empty quote', { quote: '' }, 'quote-too-short'],
    ['a quote under the minimum', { quote: 'x'.repeat(MIN_QUOTE_CHARS - 1) }, 'quote-too-short'],
    ['a quote that occurs only in E0', { quote: 'accepts any outcome with status landed' }, 'quote-only-in-finding'],
    ['a citation of a withheld item', { evidenceRefs: ['E2'], quote: '[withheld: sensitive path deadbeef]' }, 'ineligible-ref'],
    ['an unknown ref', { evidenceRefs: ['E9'] }, 'unknown-ref'],
    ['a quote whose only source is a test item', { evidenceRefs: ['E3'], quote: 'not ok 1 - the verifier rejects landed' }, 'test-only-quote'],
    ['no refs at all', { evidenceRefs: [] }, 'no-ref'],
  ]) {
    it(`demotes ${name}`, () => {
      const r = v(over);
      assert.equal(r.verdict, 'inconclusive');
      assert.equal(r.backed, false);
      assert.equal(r.demotedFrom, 'refuted');
      assert.equal(r.demotionRule, rule);
    });
  }
  it('the synthetic code header is not provable text', () => {
    assert.equal(v({ quote: '// a.js:1-3 export' }).backed, false);
    assert.equal(v({ quote: '// a.js:1-3\nexport function verifyRollupProvenance(rollup)' }).backed, false);
  });
  it('the git-grep path:line: prefix of a grep hit is not provable text', () => {
    const g = [...pack, { tag: 'E4', provenance: { source: 'grep', query: 'verifyRollupProvenance', rev: 'audited-tree' }, text: 'src/x.js:12:  call(verifyRollupProvenance)', eligible: true }];
    const ok = validateVerdict({ verdict: 'refuted', evidenceRefs: ['E4'], quote: 'call(verifyRollupProvenance)' }, g);
    assert.equal(ok.backed, true);
    const bad = validateVerdict({ verdict: 'refuted', evidenceRefs: ['E4'], quote: 'src/x.js:12:  call(verifyRollupProvenance)' }, g);
    assert.equal(bad.backed, false);
  });
  it('is whitespace-normalised on both sides', () => {
    assert.equal(v({ quote: 'export   function\n verifyRollupProvenance(rollup)' }).backed, true);
  });
});

describe('the per-state artifact schema is strict', () => {
  const src = { kind: 'round-finding', findingId: 'H1', topicId: 'abc' };
  const pack = [{ tag: 'E0', provenance: { source: 'finding', rev: 'finding' }, text: 't', eligible: false }];
  const fam = { verifier: 'gpt', finder: 'gpt', selfFamily: true };
  const base = { source: src, contestKind: 'author-dispute' };
  const examples = {
    verified: { ...base, state: 'verified', verdict: 'refuted', label: 'evidence-backed', evidence: { refs: ['E1'], quote: 'a long enough quote', pack, packHash: 'h' }, reason: 'r', severityIfConfirmed: 'HIGH', model: 'gpt-x', family: fam },
    inconclusive: { ...base, state: 'inconclusive', verdict: 'inconclusive', evidence: { pack, packHash: 'h' }, reason: 'r', model: 'gpt-x', family: fam, demotedFrom: 'refuted', demotionRule: 'unknown-ref' },
    'over-cap': { ...base, state: 'over-cap', rank: 1 },
    failed: { ...base, state: 'failed', failure: { stage: 'call', category: 'http-429' } },
  };
  for (const [state, ex] of Object.entries(examples)) {
    it(`${state} round-trips`, () => assert.ok(VerifyItemSchema.safeParse(ex).success, JSON.stringify(VerifyItemSchema.safeParse(ex).error?.issues)));
  }
  for (const [state, extra] of [['verified', { demotedFrom: 'refuted' }], ['verified', { failure: { stage: 'call', category: 'x' } }], ['over-cap', { verdict: 'refuted' }], ['over-cap', { evidence: { pack, packHash: 'h' } }], ['failed', { verdict: 'confirmed' }], ['failed', { quote: 'q' }], ['inconclusive', { failure: { stage: 'call', category: 'x' } }]]) {
    it(`a forbidden field on ${state} is rejected: ${Object.keys(extra)[0]}`, () => assert.equal(VerifyItemSchema.safeParse({ ...examples[state], ...extra }).success, false));
  }
  it('an unknown artifact key is rejected', () => {
    const art = { schemaVersion: 1, sid: 's', round: 1, resultSha256: 'x', auditedTree: 't', evidenceTree: 't', headSha: 'h', complete: true, counts: { verified: 0, inconclusive: 0, overCap: 0, failed: 0 }, items: [], notSelected: [] };
    assert.ok(VerifyArtifactSchema.safeParse(art).success);
    assert.equal(VerifyArtifactSchema.safeParse({ ...art, allow: true }).success, false);
  });
});

describe('egress: one acquisition boundary (Tier 3, same commit)', () => {
  let repo; let outside;
  before(() => {
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-outside-'));
    fs.writeFileSync(path.join(outside, 'id_rsa'), `-----BEGIN KEY-----\n${TOKEN}\n`);
    repo = makeVerifyRepo({
      'src/a.js': 'export function fooBar() {\n  return 1;\n}\n',
      '.env': `fooBar=${TOKEN}\n`,
      'config/.env': `fooBar=${TOKEN}\n`,
    });
    repo.write('src/a.js', `export function fooBar() {\n  const k = "${TOKEN}";\n  return 1;\n}\n`);
    repo.git('commit', '-q', '-am', 'add secret');
    repo.write('src/a.js', 'export function fooBar() {\n  return 1;\n}\n');
    repo.git('commit', '-q', '-am', 'remove secret');
    try { fs.symlinkSync(path.join(outside, 'id_rsa'), path.join(repo.root, 'src', 'link.txt')); } catch { /* no symlink privilege */ }
  });
  after(() => { repo.cleanup(); fs.rmSync(outside, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });
  const head = () => repo.git('rev-parse', 'HEAD').trim();
  const pack = (over) => buildEvidencePack({ finding: finding('H1', over), repoRoot: repo.root, headSha: head() }).pack;
  const everything = (p) => JSON.stringify(p);

  it('positive control: the token really is a secret the redactor changes', () => assert.notEqual(redactSecrets(`k=${TOKEN}`), `k=${TOKEN}`));
  it('a cited .env is withheld, marked ineligible, and its bytes never appear', () => {
    const p = pack({ section: '.env — fooBar', _primaryFile: '.env', affectedFiles: ['.env'] });
    assert.ok(p.some((i) => /\[withheld: sensitive path [0-9a-f]+\]/.test(i.text) && i.eligible === false));
    assert.ok(!everything(p).includes(TOKEN));
    const held = p.filter((i) => !i.eligible && /\[withheld:/.test(i.text));
    assert.ok(held.every((i) => !JSON.stringify(i).includes('.env')), 'the withheld item names a hash, never the file');
  });
  it('a symlink into an outside secret store is withheld', (t) => {
    if (!fs.existsSync(path.join(repo.root, 'src', 'link.txt'))) return t.skip('symlinks unavailable');
    const p = pack({ section: 'src/link.txt — fooBar', _primaryFile: 'src/link.txt', affectedFiles: ['src/link.txt'] });
    assert.ok(!everything(p).includes(TOKEN));
    assert.ok(p.some((i) => /\[withheld:/.test(i.text)));
  });
  it('a grep hit in a sensitive path outside the cited file is dropped and counted, never shown', () => {
    const p = pack({});
    const grep = p.find((i) => i.provenance.source === 'grep');
    assert.ok(grep.dropped >= 1);
    assert.ok(!grep.text.includes('.env') && !grep.text.includes(TOKEN));
  });
  it('a secret that exists only in a historical blob is redacted in the history item', () => {
    const p = pack({});
    const hist = p.find((i) => i.provenance.source === 'history');
    assert.ok(hist.text.length > 0);
    assert.ok(!hist.text.includes(TOKEN), 'git log -L reaches the removed secret; the boundary redacts it');
    assert.equal(hist.provenance.rev, head(), 'history is pinned to the sha HEAD resolved to');
  });
  it('the whole pack stays inside the per-finding cap', () => {
    const total = pack({}).reduce((n, i) => n + i.text.length, 0);
    assert.ok(total <= PACK_CAP_CHARS, String(total));
  });
});

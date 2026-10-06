/**
 * @fileoverview The Home tab's schema, section and wiring (docs/plans/dashboard-home-summary.md
 * §9, §10): the strict `HomeSchema` accepts exactly what `collectHome` emits and rejects
 * extra keys; the section draws what the model decided and never contradicts it; hostile
 * strings are escaped in EVERY field; the panel stays under its byte budget for maximal,
 * escape-heavy input; one degraded card leaves the other three intact; and the build's
 * exit rule is unchanged by a missing-optional Home.
 *
 * Negative controls (each seen to FAIL against a deliberately wrong implementation, then
 * restored): data-state="ok" for an unmeasured chip; "Nothing needs you" printed when the
 * model's headline is null; a field that skips bound()/escapeHtml; a schema that is not
 * `.strict()`. See the report that accompanied this file for the mutation record.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { git } from './helpers/git.mjs';
import { collectHome } from '../scripts/lib/dashboard/collect-home.mjs';
import { collectReference } from '../scripts/lib/dashboard/collect-reference.mjs';
import { renderDocument } from '../scripts/lib/dashboard/render.mjs';
import { buildUi } from '../scripts/lib/dashboard/helpers.mjs';
import sectionHome from '../scripts/lib/dashboard/sections/home.mjs';
import { HomeSchema, ReferenceDataSchema, SourceStatusSchema, HOME_CAPS } from '../scripts/lib/dashboard/schema.mjs';
import { makeMeasurement, MAX_NEEDS_ROWS, NOTHING_NEEDS_YOU } from '../scripts/lib/dashboard/home-model.mjs';

const ASSETS = { css: '/* css */', js: '/* js */' };
const ui = buildUi();

// ── Fixtures ─────────────────────────────────────────────────────────────

const dirs = [];
function tmp() {
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'home-section-')));
  dirs.push(d);
  return d;
}
after(() => { for (const d of dirs.splice(0)) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best effort */ } } });

const OK_ENV = {
  q1: { ok: true, cloud: true, measured: true, byMode: { total: 3, code: 2, plan: 1 }, agedOut: 0 },
  q2: { ok: true, cloud: true, measured: true, total: 4, byMode: { total: 4, code: 3, plan: 1 }, byDisposition: { acceptedPermanent: 1 } },
  q3: { state: 'ready', cloud: true, counts: { totalActionable: 5 } },
  upstream: { ok: true, cloud: true, rows: [], total: 0 },
  debt: { ok: true, verdict: 'measured', cloudTotal: 6, localTotal: 7, undrainedSpills: 0 },
};
const readerOf = ({ script, args }) => (path.basename(script) === 'debt-reconcile.mjs' ? 'debt'
  : args[0] === 'list-unlocked-fixes' ? 'q1' : args[0] === 'list-unremediated-acceptances' ? 'q2'
    : args[0] === 'final-review-pending' ? 'q3' : 'upstream');
const okRun = async (a) => ({ exitCode: 0, stdout: JSON.stringify(OK_ENV[readerOf(a)]), aborted: false });
/** Every reader exits 1 with a store-unreachable envelope: the shape the captured fixture records. */
const unreachableRun = async () => ({ exitCode: 1, stdout: JSON.stringify({ ok: false, cloud: true, error: { code: 'CLOUD_UNREACHABLE', message: 'x' } }), aborted: false });

/** A throwaway SOURCE-shaped repo with a status.md, so every card has something real to measure. */
function mkRepo() {
  const repo = tmp();
  git(['init', '-q', '-b', 'main'], repo);
  for (const [k, v] of Object.entries({ 'user.email': 't@example.com', 'user.name': 'T', 'commit.gpgsign': 'false', 'core.autocrlf': 'false' })) git(['config', k, v], repo);
  const write = (rel, body) => { const f = path.join(repo, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };
  write('AGENTS.md', '# AGENTS\nshort\n');
  write('status.md', '## 2026-10-06 — shipped a thing (docs/plans/some-plan.md)\n\n## 2026-10-05 — an earlier thing\n\nBacklog 2026-10-05T10:00Z: Q1 2c/1p (+0 aged) · Q2 3c/1p (1 perm) · Q3 5 · debt 6 cloud/7 local (0 spilled) · upstream 0\n');
  write('.sync-receipt.json', JSON.stringify({ version: 2, olderSyncsDropped: 0, recentSyncs: [{ syncedAt: '2026-10-05T08:00:00Z', source: { repo: 'o/s', branch: 'main', commitSha: 'c'.repeat(40), sourceDirty: false } }] }));
  write('.audit-loop/last-maintenance.json', JSON.stringify({ lastRunAt: '2026-10-05T12:00:00Z', results: [] }));
  git(['add', '.'], repo);
  git(['commit', '-q', '-m', 'init'], repo);
  return repo;
}
const HOME_OPTS = (extra = {}) => ({
  run: okRun, repo: 'owner/repo', plans: { active: [], completed: [] }, skills: new Array(17).fill({}), isSource: false, now: new Date('2026-10-06T12:00:00Z'), ...extra,
});

/** A reference-data object that renders (the shape tests/dashboard.test.mjs uses), with `home` and `sources.home`. */
function refData(home, sourceHome = { status: 'ok', detail: '' }) {
  return {
    kind: 'reference',
    provenance: { baseSha: 'abc1234', dirty: false, sourceHash: 'deadbeef' },
    sources: {
      skills: { status: 'ok', detail: '' }, plans: { status: 'ok', detail: '' }, architecture: { status: 'ok', detail: '' },
      flows: { status: 'ok', detail: '' }, cli: { status: 'ok', detail: '' }, home: sourceHome,
    },
    skills: [{ name: 'plan', oneLiner: 'Plan things.', triggers: ['plan it'], usage: ['/plan x'], disableModelInvocation: false, path: 'skills/plan/SKILL.md' }],
    plans: { active: [], completed: [] },
    architecture: {
      domains: [], deps: {}, mergedDeps: {},
      depsSource: { observedAvailable: false, observedRejectedReason: 'absent', observedRefreshId: null, observedGeneratedAt: null, manualKeyCount: 0, edgeCounts: { observed: 0, manual: 0, both: 0 } },
      mapPath: null,
    },
    flows: { nodes: [{ id: 'plan', skill: 'plan', label: 'Plan' }], edges: [] },
    cli: [],
    ...(home ? { home } : {}),
  };
}

const panelOf = (html, id) => {
  const start = html.indexOf(`<div role="tabpanel" id="panel-${id}"`);
  assert.ok(start >= 0, `panel-${id} present`);
  const next = html.indexOf('<div role="tabpanel" id="panel-', start + 10);
  return html.slice(start, next === -1 ? html.length : next);
};
const chipsOf = (html) => [...html.matchAll(/<li class="home-chip" data-testid="home-chip"[\s\S]*?<\/li>/g)].map((m) => m[0]);
const strip = (s) => s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

/**
 * A schema-valid synthetic home whose every string comes from `S(name)` and whose every
 * list is at its cap (10 shipped, 10 merges, 15 in flight, 8 needs, 10 chips). Constrained
 * fields (plan path, sha) keep their legal shape: the schema would refuse anything else.
 */
function makeHome(S = (n) => n, { states = ['ok', 'warn', 'bad', 'neutral', 'unmeasured'] } = {}) {
  const ms = (card, id, extra = {}) => ({
    id, label: S(`${id}.label`), card, value: null, status: 'ok', asOf: '2026-10-06T12:00:00.000Z', source: S(`${id}.source`), detail: S(`${id}.detail`), ...extra,
  });
  const chips = Array.from({ length: 10 }, (_, i) => {
    const state = states[i % states.length];
    return {
      id: `chip-${i}`, label: S(`chip${i}.label`), tab: i === 6 ? 'plans' : null, command: S(`chip${i}.command`), state, value: S(`chip${i}.value`),
      detail: S(`chip${i}.detail`), measured: state !== 'unmeasured', source: S(`chip${i}.source`), asOf: '2026-10-06T12:00:00.000Z',
    };
  });
  const rows = Array.from({ length: MAX_NEEDS_ROWS }, (_, i) => ({
    ruleId: `N${String(i + 1).padStart(2, '0')}`, severity: 1 + (i % 3), command: S(`need${i}.command`), tab: i === 0 ? 'plans' : null, commandNote: null, text: S(`need${i}.text`), anchor: null,
  }));
  const card = (id, measurements, warning = null) => ({ id, label: S(`card.${id}`), measurements, status: 'ok', warning });
  return {
    builtAt: '2026-10-06T12:00:00.000Z',
    cards: {
      queues: card('queues', [ms('queues', 'queue-q1')]),
      vitals: card('vitals', [ms('vitals', 'agents-size')]),
      consumers: card('consumers', [ms('consumers', 'consumers')]),
      shipped: card('shipped', [
        ms('shipped', 'shipped-log', { value: {
          entries: Array.from({ length: HOME_CAPS.shipped }, (_, i) => ({ date: '2026-10-0' + (i % 9 + 1), title: S(`log${i}.title`), planPath: i % 2 ? `docs/plans/${'a'.repeat(100)}-${i}.md` : null })),
          skippedHeadings: 3, partial: true,
        } }),
        ms('shipped', 'shipped-merges', { value: {
          branch: S('merges.branch'),
          subjects: Array.from({ length: HOME_CAPS.merges }, (_, i) => ({ sha7: `abcdef${i}`, subject: S(`merge${i}.subject`) })),
        } }),
      ]),
      inflight: card('inflight', [ms('inflight', 'inflight', { value: {
        baseBranch: S('inflight.base'),
        rows: Array.from({ length: HOME_CAPS.inflight }, (_, i) => ({ id: S(`fl${i}.id`), kind: S(`fl${i}.kind`), label: S(`fl${i}.label`), ahead: 2, behind: 1, state: S(`fl${i}.state`), overlaps: 1 })),
        more: 5, total: 20, notAnalysed: { count: 4 }, prs: S('inflight.prs'),
      } })]),
    },
    health: chips,
    needs: { rows, total: 11, more: 3, unmeasured: 2, headline: null },
    durations: { queues: 5 },
  };
}

// ONE double quote: an odd count means a stray unescaped quote shows up as odd parity (an even count would hide a pair).
const HOSTILE = '"><img src=x onerror=alert(1)>\'&</script><script>alert(1)</script>&<>\'';
const maximal = (n) => `${n}|${HOSTILE.repeat(20)}`.slice(0, 400);

// ── Schema ───────────────────────────────────────────────────────────────

describe('HomeSchema — the contract between collectHome and the section', () => {
  test('a REAL collectHome result validates (store reachable)', async () => {
    const { home } = await collectHome(mkRepo(), HOME_OPTS());
    const r = HomeSchema.safeParse(home);
    assert.ok(r.success, r.success ? '' : JSON.stringify(r.error.issues.slice(0, 5)));
  });

  test('a REAL collectHome result validates (store unreachable, every queue unmeasured)', async () => {
    const { home } = await collectHome(mkRepo(), HOME_OPTS({ run: unreachableRun }));
    assert.ok(home.health.some((c) => c.state === 'unmeasured'), 'precondition: the degraded shape was exercised');
    const r = HomeSchema.safeParse(home);
    assert.ok(r.success, r.success ? '' : JSON.stringify(r.error.issues.slice(0, 5)));
  });

  test('a REAL collectHome result validates (a thrown collector: placeholders, a card warning)', async () => {
    const { home } = await collectHome(mkRepo(), HOME_OPTS({ collectors: { inflight: async () => { throw new Error('boom'); } } }));
    assert.ok(home.cards.inflight.warning, 'precondition: a warning was exercised');
    assert.ok(HomeSchema.safeParse(home).success);
  });

  test('STRICT: an extra key is REJECTED at every level (negative control: a non-strict schema would drop it silently)', async () => {
    const { home } = await collectHome(mkRepo(), HOME_OPTS());
    const mutate = (fn) => { const h = structuredClone(home); fn(h); return HomeSchema.safeParse(h); };
    for (const [name, fn] of Object.entries({
      'top level': (h) => { h.extra = 1; },
      'a card': (h) => { h.cards.queues.extra = 1; },
      'a card set': (h) => { h.cards.extra = h.cards.queues; },
      'a measurement': (h) => { h.cards.queues.measurements[0].extra = 1; },
      'a chip': (h) => { h.health[0].extra = 1; },
      'needs': (h) => { h.needs.extra = 1; },
      'a needs row': (h) => { h.needs.rows[0].extra = 1; },
      'a rendered measurement value': (h) => { h.cards.inflight.measurements[0].value.extra = 1; },
    })) {
      assert.equal(mutate(fn).success, false, `an extra key on ${name} must be rejected`);
    }
  });

  test('a schema-valid Home survives ReferenceDataSchema (the key is DECLARED, not stripped)', async () => {
    const { home } = await collectHome(mkRepo(), HOME_OPTS());
    const parsed = ReferenceDataSchema.parse(refData(home));
    assert.equal(parsed.home.builtAt, home.builtAt, 'home must survive parsing: an undeclared key is DELETED, not passed through');
    assert.doesNotThrow(() => ReferenceDataSchema.parse(refData(null)), 'a pre-Home snapshot still parses');
  });

  test('H1: a measurement id is looked up in a Map: constructor / toString / __proto__ resolve nothing, and unknown ids are REFUSED', () => {
    for (const id of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf', 'nope', 'consumer:bad name', 'consumer:']) {
      const h = makeHome();
      h.cards.queues.measurements[0] = { ...h.cards.queues.measurements[0], id };
      const r = HomeSchema.safeParse(h);
      assert.equal(r.success, false, `id ${JSON.stringify(id)} must be refused`);
      assert.match(JSON.stringify(r.error.issues), /unknown measurement id/);
    }
    // __proto__ as an OWN key (what JSON.parse produces) is just as dead.
    const h = makeHome();
    h.cards.queues.measurements[0] = { ...JSON.parse('{"id":"__proto__","label":"l","card":"queues","value":null,"status":"ok","asOf":null,"source":"s","detail":""}') };
    assert.equal(HomeSchema.safeParse(h).success, false);
    // The registered ids and per-consumer rows stay legal.
    for (const id of ['queue-q1', 'shipped-log', 'inflight', 'consumer:some-app', 'consumer:(invalid-name)']) {
      const ok = makeHome();
      ok.cards.queues.measurements[0] = { ...ok.cards.queues.measurements[0], id, status: 'missing-optional', value: null };
      assert.equal(HomeSchema.safeParse(ok).success, true, id);
    }
    // An inherited-property id can never select a value schema.
    const sneaky = makeHome();
    sneaky.cards.queues.measurements[0] = { ...sneaky.cards.queues.measurements[0], id: 'constructor', value: { entries: 'garbage' } };
    assert.equal(HomeSchema.safeParse(sneaky).success, false);
  });

  test('state and measured cannot disagree (an unmeasured source must never grade)', () => {
    const h = makeHome();
    h.health[0] = { ...h.health[0], state: 'ok', measured: false };
    assert.equal(HomeSchema.safeParse(h).success, false);
    const h2 = makeHome();
    h2.health[0] = { ...h2.health[0], state: 'unmeasured', measured: true };
    assert.equal(HomeSchema.safeParse(h2).success, false);
  });

  test('"Nothing needs you" is only legal when nothing fired and nothing is unmeasured', () => {
    const h = makeHome();
    h.needs = { rows: [], total: 0, more: 0, unmeasured: 1, headline: NOTHING_NEEDS_YOU };
    assert.equal(HomeSchema.safeParse(h).success, false);
    h.needs = { rows: [], total: 0, more: 0, unmeasured: 0, headline: NOTHING_NEEDS_YOU };
    assert.equal(HomeSchema.safeParse(h).success, true);
  });

  test('"+N more" must be the true overflow, and list caps are enforced', () => {
    const h = makeHome();
    h.needs.more = 99;
    assert.equal(HomeSchema.safeParse(h).success, false, 'more must equal total - rows.length');
    const h2 = makeHome();
    h2.cards.shipped.measurements[1].value.subjects.push({ sha7: 'abcdef0', subject: 'x' });
    assert.equal(HomeSchema.safeParse(h2).success, false, `more than ${HOME_CAPS.merges} merges is refused`);
  });

  test('drift guard: home-model accepts EXACTLY the statuses SourceStatusSchema names', () => {
    const options = SourceStatusSchema.shape.status.options;
    for (const status of options) {
      assert.doesNotThrow(() => makeMeasurement({ id: 'x', label: 'x', card: 'x', status, source: 's' }), `${status} must be accepted`);
    }
    for (const bogus of ['degraded', 'OK', 'ok ', '', 'missing_optional', 'error', null, undefined]) {
      assert.throws(() => makeMeasurement({ id: 'x', label: 'x', card: 'x', status: bogus, source: 's' }), `${JSON.stringify(bogus)} must be refused`);
    }
  });
});

// ── Registry / tablist semantics ─────────────────────────────────────────

describe('tab registration', () => {
  test('Home is the FIRST tab, selected, with tablist semantics; Start Here is second in the same group', () => {
    const html = renderDocument(refData(makeHome()), 'reference', ASSETS);
    const tabs = [...html.matchAll(/<button role="tab" id="tab-([A-Za-z]+)" aria-controls="panel-([A-Za-z]+)" aria-selected="(true|false)" tabindex="(0|-1)">([^<]*)<\/button>/g)];
    assert.deepEqual(tabs.slice(0, 2).map((m) => m[1]), ['home', 'startHere']);
    assert.deepEqual([tabs[0][2], tabs[0][3], tabs[0][4], tabs[0][5]], ['home', 'true', '0', 'Home']);
    assert.equal(tabs[1][3], 'false');
    assert.equal(tabs.filter((m) => m[3] === 'true').length, 1, 'exactly one selected tab');
    assert.ok(html.includes('<div role="tabpanel" id="panel-home" aria-labelledby="tab-home">'), 'panel-home is visible (no hidden attribute)');
    assert.ok(html.includes('role="tablist"'));
    const group = html.slice(html.indexOf('<div class="tabgroup">'), html.indexOf('</div>', html.indexOf('<div class="tabgroup">')));
    assert.ok(group.includes('Orientation') && group.includes('tab-home') && group.includes('tab-startHere'), 'both live in the Orientation group');
  });

  test('M1: an ABSENT sources.home is never read as success: the slicer says missing-optional and the panel says unmeasured', () => {
    for (const sources of [undefined, { status: 'ok', detail: '' }]) {
      const data = refData(null);
      if (sources === undefined) delete data.sources.home; else data.sources.home = sources;
      const p = panelOf(renderDocument(data, 'reference', ASSETS), 'home');
      assert.match(p, /Home is unmeasured/);
      assert.doesNotMatch(p, /Nothing needs you|data-state="ok"|data-testid="home-chip"/);
    }
    const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'scripts', 'lib', 'dashboard', 'render.mjs'), 'utf8');
    assert.match(src, /d\.sources\.home \|\| \{ status: 'missing-optional', detail: '[^']+' \}/, 'the slicer default is missing-optional WITH a detail');
  });

  test('without a collected Home the tab still exists and says so (never an empty tab)', () => {
    const html = renderDocument(refData(null, { status: 'missing-optional', detail: 'not collected here' }), 'reference', ASSETS);
    assert.match(panelOf(html, 'home'), /not collected here/);
  });

  test('Start Here points at Home with the cross-tab handler', () => {
    const html = renderDocument(refData(makeHome()), 'reference', ASSETS);
    assert.match(panelOf(html, 'startHere'), /<a data-cross-tab href="#panel-home">Home<\/a>/);
  });
});

// ── The section draws what the model decided ─────────────────────────────

describe('chips', () => {
  const render = (home, src = { status: 'ok', detail: '' }) => sectionHome({ src, home }, ui);

  test('every chip carries visible TEXT naming its state, a glyph, and data-state / data-measured', () => {
    const html = render(makeHome());
    const chips = chipsOf(html);
    assert.equal(chips.length, 10);
    const label = { ok: 'OK', warn: 'WARN', bad: 'BAD', neutral: 'NEUTRAL', unmeasured: 'unmeasured' };
    for (const c of chips) {
      const state = /data-state="([a-z]+)"/.exec(c)[1];
      assert.match(c, /data-measured="(true|false)"/);
      assert.ok(strip(c).includes(label[state]), `chip text names its state (${state}): ${strip(c).slice(0, 80)}`);
      assert.match(c, /<span class="chip-glyph" aria-hidden="true">\S<\/span>/, 'a glyph, so colour is never the only channel');
    }
    assert.deepEqual([...new Set(chips.map((c) => /data-state="([a-z]+)"/.exec(c)[1]))].sort(), ['bad', 'neutral', 'ok', 'unmeasured', 'warn']);
  });

  test('NEGATIVE CONTROL: a chip whose model says measured=false is NEVER drawn ok', () => {
    const home = makeHome();
    // An inconsistent model object (the schema refuses it; the renderer must not trust it either).
    home.health[0] = { ...home.health[0], state: 'ok', measured: false };
    const c = chipsOf(render(home))[0];
    assert.match(c, /data-state="unmeasured"/);
    assert.match(c, /data-measured="false"/);
    assert.doesNotMatch(c, /data-state="ok"/);
    assert.ok(strip(c).includes('unmeasured'));
    // And no chip anywhere pairs ok with measured=false.
    assert.doesNotMatch(render(home), /data-state="ok"[^>]*data-measured="false"/);
  });

  test('a chip whose state is not a graded one is drawn unmeasured, with data-measured false (coherent by construction)', () => {
    const home = makeHome();
    home.health[1] = { ...home.health[1], state: 'excellent', measured: true };
    const c = chipsOf(render(home))[1];
    assert.match(c, /data-state="unmeasured"[^>]*data-measured="false"/);
  });

  test('a real unmeasured queue chip says "unmeasured" and links its tab/command as text, never as a link or script', async () => {
    const { home } = await collectHome(mkRepo(), HOME_OPTS({ run: unreachableRun }));
    const html = render(home);
    const q = chipsOf(html).filter((c) => /data-chip="queue-/.test(c));
    assert.equal(q.length, 5);
    for (const c of q) {
      assert.match(c, /data-state="unmeasured"[^>]*data-measured="false"/);
      assert.ok(strip(c).includes('unmeasured'));
      assert.doesNotMatch(c, /<a [^>]*href="(?!#panel-)/, 'a chip never links to a command or an external URL');
    }
  });
});

describe('Health: a shared cause is shown once (P2)', () => {
  const render = (home) => sectionHome({ src: { status: 'ok', detail: '' }, home }, ui);
  const QIDS = ['queue-q1', 'queue-q2', 'queue-q3', 'queue-debt', 'queue-upstream'];

  test('chips of a fully-failed card do not repeat the card warning; their state text and contracts remain', () => {
    const home = makeHome((n) => `v-${n}`);
    const cause = 'store not configured (cloud off)';
    home.cards.queues = { ...home.cards.queues, status: 'missing-optional', warning: { status: 'missing-optional', detail: cause },
      measurements: QIDS.map((id) => ({ ...home.cards.queues.measurements[0], id, status: 'missing-optional', value: null, detail: cause })) };
    home.health = home.health.map((c, i) => (i < 5 ? { ...c, id: QIDS[i], state: 'unmeasured', measured: false, value: '—', detail: cause } : c));
    const html = render(home);
    assert.equal((html.match(/store not configured \(cloud off\)/g) || []).length, 1, 'the cause appears exactly once on the Health card');
    const q = chipsOf(html).filter((c) => /data-chip="queue-/.test(c));
    assert.equal(q.length, 5);
    for (const c of q) {
      assert.match(c, /data-state="unmeasured"[^>]*data-measured="false"/);
      assert.ok(strip(c).includes('unmeasured'), 'still text + glyph');
      assert.match(c, /chip-glyph/);
      assert.doesNotMatch(c, /chip-detail/);
    }
  });

  test('a chip with ITS OWN cause still shows it (only an identical shared cause is folded)', () => {
    const home = makeHome((n) => `v-${n}`);
    home.cards.queues = { ...home.cards.queues, status: 'missing-optional', warning: { status: 'missing-optional', detail: 'store not configured' } };
    home.health[0] = { ...home.health[0], id: 'queue-q1', state: 'unmeasured', measured: false, detail: 'a different reason' };
    assert.match(chipsOf(render(home))[0], /a different reason/);
  });

  test('chips lay out in a grid: 1 column below 640 px, 2+ from 640 px (CSS contract)', () => {
    const css = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'scripts', 'lib', 'dashboard', 'assets', 'dashboard.css'), 'utf8');
    assert.match(css, /\.home-chips \{[^}]*grid-template-columns: minmax\(0, 1fr\)/);
    assert.match(css, /@media \(min-width: 640px\) \{\s*\.home-chips \{ grid-template-columns: repeat\(auto-fill, minmax\(240px, 1fr\)\); \}/);
  });
});

describe('Needs you', () => {
  const render = (home) => sectionHome({ src: { status: 'ok', detail: '' }, home }, ui);

  test('"Nothing needs you" comes ONLY from the model headline (negative control: null headline must not print it)', () => {
    const home = makeHome();
    home.needs = { rows: [{ ruleId: 'N01', severity: 3, command: 'node scripts/x.mjs', tab: null, commandNote: null, text: 'Q1 unmeasured', anchor: null }], total: 1, more: 0, unmeasured: 1, headline: null };
    assert.doesNotMatch(render(home), /Nothing needs you/);
    assert.doesNotMatch(render(home), /home-nothing/);
    // An empty list with a null headline must not read as all-clear either.
    home.needs = { rows: [], total: 0, more: 0, unmeasured: 0, headline: null };
    assert.doesNotMatch(render(home), /Nothing needs you/);
    // And the sentence IS shown when the model says so.
    home.needs = { rows: [], total: 0, more: 0, unmeasured: 0, headline: NOTHING_NEEDS_YOU };
    assert.match(render(home), /data-testid="home-nothing">Nothing needs you</);
  });

  test('<= 8 ranked rows with the exact command as selectable TEXT in <code>, never a link; "+N more" is the true count', () => {
    const home = makeHome((n) => `v-${n}`);
    home.needs.rows[3].command = 'npm run sync -- --target some-consumer';
    const html = render(home);
    const rows = [...html.matchAll(/<li class="home-need" data-testid="home-need"[\s\S]*?<\/li>/g)].map((m) => m[0]);
    assert.equal(rows.length, 8);
    assert.match(rows[3], /<code class="home-cmd">npm run sync -- --target some-consumer<\/code>/);
    assert.ok(rows.every((r) => !/<a [^>]*href="(?!#panel-)/.test(r)), 'a command is text, not a link');
    assert.match(html, /data-testid="home-needs-more">\+3 more</);
  });

  test('a row with a tab becomes a cross-tab link; one with a commandNote says so', () => {
    const home = makeHome();
    home.needs.rows[1] = { ...home.needs.rows[1], command: null, commandNote: 'command unavailable' };
    const html = render(home);
    assert.match(html, /<a class="home-link" data-cross-tab href="#panel-plans">/);
    assert.match(html, /command unavailable/);
  });
});

describe('Recently shipped and In flight', () => {
  const render = (home) => sectionHome({ src: { status: 'ok', detail: '' }, home }, ui);

  test('two SEPARATE lists, each <= 10; partial and unparsed lines are shown', () => {
    const html = render(makeHome((n) => `v-${n}`));
    const log = /data-testid="home-shipped-log">([\s\S]*?)<\/ul>/.exec(html)[1];
    const merges = /data-testid="home-shipped-merges">([\s\S]*?)<\/ul>/.exec(html)[1];
    assert.equal((log.match(/<li/g) || []).length, HOME_CAPS.shipped);
    assert.equal((merges.match(/<li/g) || []).length, HOME_CAPS.merges);
    assert.ok(!log.includes('merge0'), 'the lists do not bleed into each other');
    assert.match(html, /partial: only the first 256 KB/);
    assert.match(html, /3 heading\(s\) unparsed/);
    assert.match(log, /<a class="home-link" data-cross-tab href="#panel-plans">plan<\/a>/, 'a named plan links to the Plans tab');
  });

  test('In flight: rows capped at 15, "+N more" is the true count, an unqueried PR source says so', () => {
    const html = render(makeHome((n) => `v-${n}`));
    assert.equal((/data-testid="home-inflight">([\s\S]*?)<\/ul>/.exec(html)[1].match(/<li/g) || []).length, HOME_CAPS.inflight);
    assert.match(html, /data-testid="home-inflight-more">\+5 more</);
    assert.match(html, /\+4 branch\(es\) not analysed/);
    assert.match(html, /data-testid="home-prs-note">v-inflight\.prs</);
  });

  test('an unqueried measurement says "not queried (reason)", never an empty list', () => {
    const home = makeHome();
    home.cards.shipped.measurements[0] = { ...home.cards.shipped.measurements[0], status: 'missing-optional', value: null, detail: 'No status.md — nothing to list' };
    home.cards.inflight.measurements[0] = { ...home.cards.inflight.measurements[0], status: 'missing-optional', value: null, detail: 'not a git repository' };
    const html = render(home);
    assert.match(html, /Status log: not queried \(No status\.md — nothing to list\)/);
    assert.match(html, /In-flight facts: not queried \(not a git repository\)/);
    assert.doesNotMatch(html, /data-testid="home-shipped-log"|data-testid="home-inflight">/);
  });
});

describe('freshness hook and frame', () => {
  test('the panel carries data-built-at and a HIDDEN stale banner for dashboard.js to reveal', () => {
    const html = sectionHome({ src: { status: 'ok', detail: '' }, home: makeHome() }, ui);
    assert.match(html, /<div class="home" data-testid="home-root" data-built-at="2026-10-06T12:00:00.000Z">/);
    assert.match(html, /<p class="home-stale" data-testid="home-stale-banner" role="status" hidden>/);
    assert.match(html, /npm run dashboard:build/);
  });
});

// ── Degraded cards ───────────────────────────────────────────────────────

describe('one degraded card leaves the other three intact', () => {
  test('inflight collector throws: its card shows its own warning WITH its detail; the rest render normally', async () => {
    const { home, sources } = await collectHome(mkRepo(), HOME_OPTS({ collectors: { inflight: async () => { throw new Error('inflight exploded'); } } }));
    const html = renderDocument(refData(home, sources.home), 'reference', ASSETS);
    const p = panelOf(html, 'home');
    const card = (id) => new RegExp(`<section class="home-card" data-testid="home-card-${id}"[\\s\\S]*?</section>`).exec(p)[0];
    assert.match(card('inflight'), /data-testid="home-card-warning"/);
    assert.match(card('inflight'), /inflight exploded/);
    assert.match(card('inflight'), /unavailable \(unexpected-error\)/);
    assert.doesNotMatch(card('inflight'), /home-inflight"/, 'no list is drawn for the failed card');
    for (const id of ['health', 'needs', 'shipped']) assert.doesNotMatch(card(id), /data-testid="home-card-warning"/, `${id} is not degraded`);
    assert.equal(chipsOf(card('health')).length, 10);
    assert.match(card('shipped'), /data-testid="home-shipped-log"/);
    assert.match(card('needs'), /data-testid="home-need"/, 'the failed card is itself a Needs-you row (N01)');
    assert.match(p, /data-testid="home-source-note"/);
  });

  test('store unreachable: every queue chip unmeasured, no all-clear, and the page still builds', async () => {
    const { home, sources } = await collectHome(mkRepo(), HOME_OPTS({ run: unreachableRun }));
    const p = panelOf(renderDocument(refData(home, sources.home), 'reference', ASSETS), 'home');
    assert.doesNotMatch(p, /Nothing needs you/);
    assert.equal(chipsOf(p).filter((c) => /data-state="unmeasured"/.test(c)).length >= 5, true);
    assert.equal(chipsOf(p).filter((c) => /data-state="ok"[^>]*data-measured="false"/.test(c)).length, 0);
  });
});

// ── Build exit semantics ─────────────────────────────────────────────────

describe('build exit semantics are unchanged by Home', () => {
  // The build's own predicate (scripts/build-dashboard.mjs `isDegraded`), mirrored — and pinned to the source.
  const degraded = (sources) => Object.values(sources).some((s) => s.status === 'invalid' || s.status === 'unexpected-error');

  test('the rule this suite mirrors is really the one in build-dashboard.mjs', () => {
    const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'scripts', 'build-dashboard.mjs'), 'utf8');
    assert.match(src, /s\.status === 'invalid' \|\| s\.status === 'unexpected-error'/);
  });

  test('a missing-optional Home (store unreachable) does NOT degrade the page; a broken card DOES', async () => {
    const off = await collectHome(mkRepo(), HOME_OPTS({ run: unreachableRun }));
    assert.equal(off.sources.home.status, 'missing-optional');
    assert.equal(degraded(refData(off.home, off.sources.home).sources), false);
    const broken = await collectHome(mkRepo(), HOME_OPTS({ collectors: { vitals: async () => { throw new Error('x'); } } }));
    assert.equal(broken.sources.home.status, 'unexpected-error');
    assert.equal(degraded(refData(broken.home, broken.sources.home).sources), true);
  });

  test('a collector that threw outright (no home payload): the page still renders, naming the failure; an INVALID home fails loudly', () => {
    const html = renderDocument(refData(null, { status: 'unexpected-error', detail: 'collectHome failed: boom' }), 'reference', ASSETS);
    assert.match(panelOf(html, 'home'), /Source "home" is unexpected-error/);
    assert.match(panelOf(html, 'home'), /collectHome failed: boom/);
    const bad = makeHome();
    bad.surprise = true;
    assert.throws(() => renderDocument(refData(bad), 'reference', ASSETS), 'a malformed Home is a loud build failure, never a silent drop');
  });
});

// ── Escaping and the byte budget ─────────────────────────────────────────

/** Every string leaf of `value`, as `[path, parent, key]`. */
function* stringLeaves(value, trail = []) {
  if (typeof value === 'string') return;
  if (Array.isArray(value)) { for (let i = 0; i < value.length; i += 1) yield* walk(value, i, trail); return; }
  if (value && typeof value === 'object') for (const k of Object.keys(value)) yield* walk(value, k, trail);
}
function* walk(parent, key, trail) {
  const v = parent[key];
  if (typeof v === 'string') yield [[...trail, key].join('.'), parent, key];
  else yield* stringLeaves(v, [...trail, key]);
}

describe('hostile strings are escaped in EVERY field', () => {
  const sweepHome = () => makeHome((n) => `ok-${n}`);
  const slice = () => ({ src: { status: 'missing-optional', detail: 'src-detail' }, home: sweepHome() });

  test('one field at a time: no raw markup, balanced quotes, no apostrophes — for every string in the slice', () => {
    const base = slice();
    const leaves = [...stringLeaves(base)].map(([p]) => p);
    assert.ok(leaves.length > 150, `the sweep must be wide (${leaves.length} string fields)`);
    let displayed = 0;
    for (const target of leaves) {
      const s = slice();
      const [, parent, key] = [...stringLeaves(s)].find(([p]) => p === target);
      parent[key] = HOSTILE;
      const html = sectionHome(s, ui);
      assert.ok(!html.includes('<img'), `${target}: a raw <img> reached the markup`);
      assert.ok(!html.includes('</script'), `${target}: a raw </script> reached the markup`);
      assert.ok(!html.includes("'"), `${target}: a raw apostrophe reached the markup`);
      assert.equal((html.match(/"/g) || []).length % 2, 0, `${target}: an unescaped quote broke an attribute`);
      if (html.includes('&lt;img')) displayed += 1;
    }
    // Vacuous-pass guard: the sweep is only evidence if most fields are actually drawn.
    assert.ok(displayed > 60, `only ${displayed} fields were displayed: the sweep may be passing by drawing nothing`);
  });

  test('NEGATIVE CONTROL (in-test): a renderer that skips escaping IS caught by the same assertions', () => {
    const leaky = (s) => sectionHome(s, { ...ui, escapeHtml: (v) => String(v ?? '') });
    const s = slice();
    s.home.health[0].detail = HOSTILE;
    const html = leaky(s);
    assert.ok(html.includes('<img'), 'the leaky renderer lets the payload through…');
    assert.notEqual((html.match(/"/g) || []).length % 2, 0, '…and the quote-balance assertion sees it');
  });
});

describe('the panel stays under 100,000 BYTES for maximal, escape-heavy input', () => {
  test('every field maximal and escape-heavy, every list at its cap, through the real renderer (schema included)', () => {
    const home = makeHome(maximal);
    const html = renderDocument(refData(home), 'reference', ASSETS);
    const panel = panelOf(html, 'home');
    const bytes = Buffer.byteLength(panel);
    process.stderr.write(`  [measured] worst-case Home panel: ${bytes} bytes\n`);
    assert.ok(bytes < 100_000, `panel is ${bytes} bytes`);
    assert.ok(panel.includes('&lt;img'), 'the hostile content really was drawn');
    assert.equal(chipsOf(panel).length, 10);
    assert.equal((panel.match(/data-testid="home-need"/g) || []).length, 8);
    assert.equal((panel.match(/data-testid="home-inflight-row"/g) || []).length, HOME_CAPS.inflight);
    assert.ok(!panel.includes('<img') && !panel.includes('</script'));
  });

  test('truncated values keep their full text only in a title attribute capped at 400, and titles never exceed the panel budget', () => {
    const panel = panelOf(renderDocument(refData(makeHome(maximal)), 'reference', ASSETS), 'home');
    const titles = [...panel.matchAll(/ title="([^"]*)"/g)].map((m) => m[1]).filter((t) => t.length > 40);
    assert.ok(titles.length > 0, 'some truncated value kept its full text');
    const decoded = (t) => t.replace(/&amp;|&lt;|&gt;|&quot;|&#39;/g, '.');
    assert.ok(titles.every((t) => decoded(t).length <= 400), 'a title attribute is capped at 400 characters');
    assert.ok(Buffer.byteLength(titles.join('')) <= 30000, 'titles share one byte budget');
    assert.ok(panel.includes('…'), 'a truncated value shows an ellipsis even once its title budget is spent');
  });
});

// ── Integration: the real reference collector, store air-gapped ──────────

describe('collectReference wires Home end to end', () => {
  test('real collectReference (air-gapped store): sources.home set, home validates, Home is the first tab, nothing unmeasured is green', async () => {
    const prev = process.env.AUDIT_DB_URL;
    process.env.AUDIT_DB_URL = ''; // the air-gap signal: no store read, no fall-through to ~/.audit-loop.env
    let data;
    try { data = await collectReference({ git: { baseSha: 'abc1234', dirty: false } }); } finally {
      if (prev === undefined) delete process.env.AUDIT_DB_URL; else process.env.AUDIT_DB_URL = prev;
    }
    assert.ok(data.sources.home, 'collectReference must set sources.home');
    assert.ok(['ok', 'missing-optional', 'invalid', 'unexpected-error'].includes(data.sources.home.status));
    assert.ok(data.home, `home must be collected: ${data.sources.home.detail}`);
    assert.ok(HomeSchema.safeParse(data.home).success, 'the strict schema accepts what the real collector emits');
    assert.match(data.provenance.sourceHash, /^[0-9a-f]{8}$/);

    const html = renderDocument(data, 'reference', ASSETS);
    assert.match(html, /<button role="tab" id="tab-home" aria-controls="panel-home" aria-selected="true"/);
    const p = panelOf(html, 'home');
    assert.equal(chipsOf(p).length, 10);
    assert.doesNotMatch(p, /data-state="ok"[^>]*data-measured="false"/);
    assert.ok(chipsOf(p).filter((c) => /data-chip="queue-/.test(c)).every((c) => /data-state="unmeasured"/.test(c)), 'with the store air-gapped every queue chip is unmeasured');
    assert.doesNotMatch(p, /Nothing needs you/);
  });
});

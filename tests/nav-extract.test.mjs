/**
 * Cluster A — extraction + normalization (plan §2.2, §4a.B/F).
 * Tier-1 deterministic seam: per-adapter fixtures + normalization edge cases.
 */
import fs from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractEdges, readSources } from '../scripts/lib/nav/extract.mjs';
import { normalizeDestination } from '../scripts/lib/nav/normalize.mjs';
import { activeAdapters } from '../scripts/lib/nav/adapters/index.mjs';

describe('normalizeDestination', () => {
  it('collapses dynamic segments to :param', () => {
    assert.equal(normalizeDestination('/projects/[id]').ids[0], '/projects/:param');
    assert.equal(normalizeDestination('/projects/:id').ids[0], '/projects/:param');
  });
  it('strips query/hash and trailing slash', () => {
    assert.equal(normalizeDestination('/wines/?sort=year#top').ids[0], '/wines');
  });
  it('extracts the SPA view-routing param to match the live normalizer (field-test #2)', () => {
    // `?view=X` (and tab/page/screen) IS the destination — must NOT collapse to `/`,
    // else `?view=settings` links are false "surprising-mappings" and all views pile
    // into "static-only" vs live.
    assert.equal(normalizeDestination('/?view=settings').ids[0], 'settings');
    assert.equal(normalizeDestination('/?view=today').ids[0], 'today');
    assert.equal(normalizeDestination('/wines?view=grid').ids[0], 'grid'); // view param wins over path (mirrors live)
    assert.equal(normalizeDestination('/?tab=pairing').ids[0], 'pairing');
    // a NON-view query param is still stripped (sort is not a routing key)
    assert.equal(normalizeDestination('/wines?sort=year').ids[0], '/wines');
  });
  it('removes Next route groups', () => {
    assert.equal(normalizeDestination('/(marketing)/about').ids[0], '/about');
  });
  it('maps catch-all to :rest', () => {
    assert.equal(normalizeDestination('/docs/[...slug]').ids[0], '/docs/:rest');
  });
  it('emits both variants for an optional segment', () => {
    const { ids } = normalizeDestination('/users/:id?');
    assert.ok(ids.includes('/users/:param'));
    assert.ok(ids.includes('/users'));
  });
  it('passes view symbols through untouched', () => {
    assert.equal(normalizeDestination('drink-soon').ids[0], 'drink-soon');
  });
  it('marks a fully computed target opaque', () => {
    assert.equal(normalizeDestination('${base}').ids[0], '<dynamic>');
    assert.equal(normalizeDestination('${base}').confidence, 'low');
  });
});

describe('adapter detection', () => {
  it('detects react-router', () => {
    const sources = [{ path: 'App.tsx', content: `import { Route } from 'react-router-dom'; <Route path="/wines" />` }];
    const names = activeAdapters('.', sources).map((a) => a.name);
    assert.ok(names.includes('react-router'));
  });
  it('detects vanilla switchView', () => {
    const sources = [{ path: 'app.js', content: `const VIEWS = { WINES: 'wines' }; switchView(VIEWS.WINES);` }];
    const names = activeAdapters('.', sources).map((a) => a.name);
    assert.ok(names.includes('vanilla-switchview'));
  });
  it('detects next file routing', () => {
    const sources = [{ path: 'pages/wines.tsx', content: 'export default function W(){}' }];
    const names = activeAdapters('.', sources).map((a) => a.name);
    assert.ok(names.includes('next-file'));
  });
});

describe('extractEdges — react-router', () => {
  it('extracts a <Link to> affordance with label + destination', () => {
    const sources = [{
      path: 'Sidebar.tsx',
      content: `import {Link} from 'react-router-dom';
export function PrimarySidebar() {
  return <Link to="/wines">My Wines</Link>;
}`,
    }];
    const { edges } = extractEdges(sources, { root: '.' });
    const e = edges.find((x) => x.destination === '/wines');
    assert.ok(e, 'expected an edge to /wines');
    assert.equal(e.affordanceType, 'link');
    assert.equal(e.label, 'My Wines');
    assert.equal(e.entryPoint, 'PrimarySidebar');
    assert.equal(e.anchor, null); // attributed later by the model
  });
});

describe('extractEdges — vanilla switchView', () => {
  it('extracts a switchView navigate-call', () => {
    const sources = [{
      path: 'app.js',
      content: `const VIEWS = { WINES: 'wines', DRINK_SOON: 'drink-soon' };
function initStatButtons() { switchView(VIEWS.DRINK_SOON); }`,
    }];
    const { edges, recall } = extractEdges(sources, { root: '.' });
    const e = edges.find((x) => x.affordanceType === 'navigate-call');
    assert.ok(e);
    assert.equal(e.destination, 'drink-soon');
    assert.ok(recall.extracted >= 1);
  });
});

describe('extractEdges — VIEWS map resolution (audit H4)', () => {
  it('resolves VIEWS.X to the real map value, not a guessed slug', () => {
    const sources = [{
      path: 'app.js',
      content: `const VIEWS = { HOME: 'dashboard' };
function go(){ switchView(VIEWS.HOME); }`,
    }];
    const { edges } = extractEdges(sources, { root: '.' });
    const e = edges.find((x) => x.affordanceType === 'navigate-call');
    assert.equal(e.destination, 'dashboard'); // not 'home'
  });
});

describe('extractEdges — unquoted href fallback (audit H5/H11)', () => {
  it('extracts a plain <a href> when no framework adapter is active', () => {
    const sources = [{ path: 'index.js', content: `function Nav(){ return '<a href="/wines">Wines</a>'; }` }];
    const { edges } = extractEdges(sources, { root: '.' });
    const e = edges.find((x) => x.affordanceType === 'link');
    assert.ok(e);
    assert.equal(e.destination, '/wines'); // not <dynamic>
  });
});

describe('extractEdges — Next/NavLink variants (audit R2-H8)', () => {
  it('extracts Next.js <Link href> and <NavLink to>', () => {
    const sources = [{
      path: 'Nav.tsx',
      content: `function Nav(){ return <><Link href="/dashboard">Dash</Link><NavLink to="/wines">Wines</NavLink></>; }`,
    }];
    const { edges } = extractEdges(sources, { root: '.' });
    assert.ok(edges.some((e) => e.destination === '/dashboard'));
    assert.ok(edges.some((e) => e.destination === '/wines'));
  });
});

describe('extractEdges — modal namespace (audit M19)', () => {
  it('namespaces modal pseudo-destinations', () => {
    const sources = [{ path: 'x.js', content: `function f(){ openModal('settings'); }` }];
    const { edges } = extractEdges(sources, { root: '.' });
    assert.ok(edges.some((e) => e.destination === 'modal:settings'));
  });
});

describe('AST robustness — the cases regex missed (Gemini-2-H)', () => {
  it('discovers a Route with a nested-JSX element prop before path', () => {
    const sources = [{ path: 'App.tsx', content: `import {Route} from 'react-router-dom';
function App(){ return <Route element={<Foo bar={x > 1} />} path="/foo" />; }` }];
    const { destinations } = extractEdges(sources, { root: '.' });
    assert.ok(destinations.some((d) => d.id === '/foo'), 'should discover /foo despite nested >');
  });

  it('extracts an <a> with an onClick arrow before href', () => {
    const sources = [{ path: 'C.tsx', content: `function C(){ return <a onClick={(e) => { go(e); }} href="/bar">Bar</a>; }` }];
    const { edges } = extractEdges(sources, { root: '.' });
    assert.ok(edges.some((e) => e.destination === '/bar'), 'should extract /bar despite => in onClick');
  });
});

describe('Nested route composition (debt-2)', () => {
  it('composes child Route paths under the parent (JSX)', () => {
    const sources = [{ path: 'Routes.tsx', content: `import {Route} from 'react-router-dom';
function R(){ return <Route path="/app"><Route path="settings" element={<S/>} /></Route>; }` }];
    const { destinations } = extractEdges(sources, { root: '.' });
    const ids = destinations.map((d) => d.id);
    assert.ok(ids.includes('/app/settings'), `expected /app/settings, got ${ids.join(', ')}`);
  });

  it('distinguishes a pathless layout route from a dynamic path (Gemini debt-1)', () => {
    const sources = [{ path: 'R.tsx', content: `import {Route} from 'react-router-dom';
function R(){ return <Route path="/app"><Route element={<L/>}><Route path={ID} element={<D/>} /></Route></Route>; }` }];
    const { destinations } = extractEdges(sources, { root: '.' });
    const ids = destinations.map((d) => d.id);
    // layout route (no path) inherits /app; dynamic path={ID} becomes /app/:param (NOT silently /app)
    assert.ok(ids.includes('/app/:param'), `expected /app/:param, got ${ids.join(', ')}`);
  });

  it('composes route-object children arrays', () => {
    const sources = [{ path: 'router.ts', content: `import {createBrowserRouter} from 'react-router-dom';
const r = createBrowserRouter([{ path: '/app', element: home, children: [{ path: 'users', element: u }] }]);` }];
    const { destinations } = extractEdges(sources, { root: '.' });
    assert.ok(destinations.some((d) => d.id === '/app/users'), 'expected composed /app/users');
  });
});

describe('Monorepo app-root namespacing (debt-2)', () => {
  it('namespaces destinations + edges by declared app root', () => {
    const sources = [
      { path: 'apps/web/Nav.tsx', content: `import {Link} from 'react-router-dom'; function N(){ return <Link to="/settings">S</Link>; }` },
      { path: 'apps/admin/Nav.tsx', content: `import {Link} from 'react-router-dom'; function N(){ return <Link to="/settings">S</Link>; }` },
    ];
    const { edges } = extractEdges(sources, { root: '.', appRoots: ['apps/web', 'apps/admin'] });
    assert.ok(edges.some((e) => e.destination === 'apps/web#/settings'));
    assert.ok(edges.some((e) => e.destination === 'apps/admin#/settings'));
  });
});

describe('vanilla feedback fixes', () => {
  it('reads VIEWS = Object.freeze({...}) by VALUE, not the kebab\'d enum KEY (feedback #3)', () => {
    const sources = [{
      path: 'app.js',
      content: `const VIEWS = Object.freeze({ DRINK_SOON: 'drinksoon' });
function go(){ switchView(VIEWS.DRINK_SOON); }`,
    }];
    const { edges, destinations } = extractEdges(sources, { root: '.' });
    assert.ok(edges.some((e) => e.destination === 'drinksoon'), 'edge should resolve to drinksoon (value), not drink-soon (key)');
    assert.ok(destinations.some((d) => d.id === 'drinksoon'));
    assert.ok(!edges.some((e) => e.destination === 'drink-soon'), 'must NOT produce the kebab key');
  });

  it('harvests data-view nav + attributes it to the enclosing DOM container (feedback #1/#2)', () => {
    const sources = [{
      path: 'nav.js',
      content: 'function navHtml(){ return `<nav id="bottom-nav"><button data-view="wines">Cellar</button><button data-view="today">Today</button></nav>`; }',
    }];
    const { edges } = extractEdges(sources, { root: '.' });
    const wines = edges.find((e) => e.destination === 'wines');
    assert.ok(wines, 'should harvest data-view="wines"');
    assert.equal(wines.anchor, '#bottom-nav', 'should attribute to the enclosing DOM container');
    assert.ok(edges.some((e) => e.destination === 'today'));
  });

  it('excludes test/fixture files from extraction (feedback #4)', () => {
    const { sources } = readSources('.', ['tests/fixture-nav.test.jsx', 'src/App.tsx'].filter(() => true));
    // tests/*.test.jsx must be dropped; only non-test files survive (none here on disk, but the filter is what we assert)
    assert.ok(!sources.some((s) => /tests\//.test(s.path)));
  });
});

describe('extractEdges — recall reporting', () => {
  it('counts opaque/low-confidence edges, never silently drops', () => {
    const sources = [{
      path: 'x.tsx',
      content: `function Foo(){ navigate(\`/user/\${id}\`); navigate(someVar); }`,
    }];
    const { recall } = extractEdges(sources, { root: '.' });
    assert.ok(recall.extracted >= 2);
    assert.ok(recall.lowConfidence >= 1);
  });
});

describe('extractEdges — map-callback enumeration (storyline nav-bar report)', () => {
  const FIXTURE = fs.readFileSync(new URL('./fixtures/nav-static/map-callback-nav-bar.jsx', import.meta.url), 'utf-8');
  const destsOf = (edges) => edges.map((e) => e.destination).sort();

  it('enumerates a local closure .map()-ed over a same-file array of object literals', () => {
    const { edges, adapters, recall } = extractEdges([{ path: 'src/AppNav.jsx', content: FIXTURE }], { root: '.' });
    assert.ok(adapters.includes('react-router'), 'fixture must exercise the react-router adapter (the phantom path)');
    assert.deepEqual(destsOf(edges), ['library', 'settings', 'workflow']);
    for (const e of edges) {
      assert.equal(e.entryPoint, 'renderDestination');
      assert.equal(e.confidence, 'medium');
    }
    assert.equal(recall.opaque, 0);
  });

  it('enumerates an inline callback with a destructured parameter into <Link to>', () => {
    const content = `import {Link} from 'react-router-dom';
const ITEMS = Object.freeze([{ path: '/a' }, { path: '/b', label: 'B' }]);
export function Menu(){ return ITEMS.map(({ path: to }) => <Link to={to}>x</Link>); }`;
    const { edges } = extractEdges([{ path: 'Menu.jsx', content }], { root: '.' });
    assert.deepEqual(destsOf(edges), ['/a', '/b']);
  });

  it('enumerates an array of string literals read as the whole element', () => {
    const content = `const TABS = ['today', 'wines'] as const;
function Tabs(){ TABS.forEach((t) => switchView(t)); }`;
    const { edges } = extractEdges([{ path: 'tabs.ts', content }], { root: '.' });
    assert.deepEqual(destsOf(edges), ['today', 'wines']);
  });

  it('unions the values when one closure is mapped over two arrays', () => {
    const content = `const PRIMARY = [{ screen: 'home' }];
const SECONDARY = [{ screen: 'help' }];
function Nav(){ const render = (d) => navigate(d.screen); return [PRIMARY.map(render), SECONDARY.map(render)]; }`;
    const { edges } = extractEdges([{ path: 'nav.js', content }], { root: '.' });
    assert.deepEqual(destsOf(edges), ['help', 'home']);
  });

  it('reports a partially-known array as partial: known ids plus <dynamic>, low confidence', () => {
    const content = `const D = [{ screen: 'home' }, { screen: pick() }, { divider: true }];
function Nav(){ return D.map((d) => navigate(d.screen)); }`;
    const { edges } = extractEdges([{ path: 'nav.js', content }], { root: '.' });
    assert.deepEqual(destsOf(edges), ['<dynamic>', 'home']);
    assert.ok(edges.every((e) => e.confidence === 'low'));
  });

  it('drops external values from an enumeration instead of emitting edges for them', () => {
    const content = `const LINKS = [{ href: 'https://x.test' }, { href: 'mailto:a@b.c' }];
function Footer(){ return LINKS.map((l) => <a href={l.href}>x</a>); }`;
    const { edges } = extractEdges([{ path: 'Footer.jsx', content }], { root: '.' });
    assert.equal(edges.length, 0);
  });

  // Negative controls — each must stay opaque, never resolve to a guess.
  it('does NOT enumerate an imported array (not same-file)', () => {
    const content = `import { DESTINATIONS } from './dests';
function Nav(){ return DESTINATIONS.map((d) => navigate(d.screen)); }`;
    const { edges } = extractEdges([{ path: 'nav.js', content }], { root: '.' });
    assert.deepEqual(destsOf(edges), ['<dynamic>']);
  });

  it('does NOT enumerate a name declared twice in the file', () => {
    const content = `const D = [{ screen: 'a' }];
function other(){ const D = [{ screen: 'z' }]; return D; }
function Nav(){ return D.map((d) => navigate(d.screen)); }`;
    const { edges } = extractEdges([{ path: 'nav.js', content }], { root: '.' });
    assert.deepEqual(destsOf(edges), ['<dynamic>']);
  });

  it('does NOT resolve a read shadowed by a nested function parameter', () => {
    const content = `const D = [{ screen: 'a' }];
function Nav(){ return D.map((d) => (rows) => rows.forEach((d) => navigate(d.screen))); }`;
    const { edges } = extractEdges([{ path: 'nav.js', content }], { root: '.' });
    assert.deepEqual(destsOf(edges), ['<dynamic>']);
  });

  it('never mints a phantom destination from a member target under react-router', () => {
    // `item` comes from props — genuinely unknown. Before the fix the react-router
    // adapter normalised the spelling into a destination literally named `item.path`.
    const content = `import { useNavigate } from 'react-router-dom';
function Row({ item }){ const navigate = useNavigate(); return <b onClick={() => navigate(item.path)}/>; }`;
    const { edges } = extractEdges([{ path: 'Row.jsx', content }], { root: '.' });
    assert.deepEqual(destsOf(edges), ['<dynamic>']);
    assert.equal(edges[0].confidence, 'low');
  });
});

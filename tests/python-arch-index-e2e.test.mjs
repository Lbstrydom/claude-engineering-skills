/**
 * End-to-end: a fixture Python repo through the REAL extract CLI (the entry
 * `arch:refresh` spawns), then the REAL neighbourhood orchestrator.
 *
 * What "done" means for docs/plans/python-arch-memory-indexing.md: a Python
 * consumer's refresh indexes its .py symbols and import graph, every egress
 * protection holds (sensitive path, symlink, secret scrub), a missing
 * interpreter is UNPARSEABLE never indexed, and `get-neighbourhood` returns a
 * real Python neighbour. Requires Python >= 3.9 — fails (never skips) without
 * it, so a clean checkout cannot go green having checked nothing.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { probePythonParser, PYTHON_ENV_VAR } from '../scripts/lib/symbol-index/python-extract.mjs';
import { SymbolKindEnum, NeighbourhoodResultSchema } from '../scripts/lib/symbol-index-contracts.mjs';
import { writeFilesManifest, removeFilesManifest } from '../scripts/lib/symbol-index/files-manifest.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXTRACT = path.join(HERE, '..', 'scripts', 'symbol-index', 'extract.mjs');
const CHILD = path.join(HERE, 'helpers', 'python-neighbourhood-child.mjs');
const NO_NET = path.join(HERE, 'fixtures', 'no-network-preload.mjs');
// Runtime-built, one per position, so each redaction is proven independently
// (and no literal secret sits in the repo).
const KEY_SIG = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');
const KEY_DOC = ['AKIA', 'J3Q7XKZP2WLMN4RT'].join('');
const KEY_BODY = ['ghp_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'].join('');
const KEYS = [KEY_SIG, KEY_DOC, KEY_BODY];
const SUBPROCESS_TIMEOUT_MS = 120_000;

const FILES = {
  'pyproject.toml': '[project]\nname = "shop"\n',
  'src/shop/__init__.py': '',
  'src/shop/orders/__init__.py': '',
  'src/shop/orders/pricing.py': [
    'def total_price(items, tax_rate=0.2):',
    '    """Sum item prices and apply sales tax to an order total."""',
    '    return sum(i.price for i in items) * (1 + tax_rate)',
    '',
  ].join('\n'),
  'src/shop/orders/service.py': [
    '"""Order placement."""',
    'from .pricing import total_price',
    'import requests',
    '',
    'class OrderService:',
    '    """Places customer orders."""',
    '    def place_order(self, items):',
    '        """Validate items and place the order."""',
    '        return total_price(items)',
    '',
    '    def _audit(self):',
    '        pass',
    '',
  ].join('\n'),
  'src/shop/aws.py': [
    `def by_signature(key="${KEY_SIG}"):`,
    '    return key',
    '',
    'def by_docstring():',
    `    """Connects with ${KEY_DOC}."""`,
    '    return 1',
    '',
    'def by_body():',
    `    return "${KEY_BODY}"`,
    '',
  ].join('\n'),
  // A U+2028 inside a string literal (str.splitlines would split there; Python
  // does not), and an __all__ inside a function (a different variable).
  'src/shop/odd.py': [
    'SEP = "a b"',
    '__all__ = ["visible"]',
    'def visible():',
    '    """Shown."""',
    '    return SEP',
    '',
    'def hidden():',
    '    __all__ = ["hidden"]',
    '    return __all__',
    '',
  ].join('\n'),
  'src/shop/trusted.py': '__all__ = ["listed"]\ndef listed():\n    return 1\ndef unlisted():\n    return 2\n',
  // exec() can mutate __all__ from inside a string: opaque, so not trusted.
  'src/shop/dynamic.py': '__all__ = ["shown"]\nexec("__all__.append(\'later\')")\ndef shown():\n    return 1\ndef later():\n    return 2\n',
  // Loop-scoped module defs, and an __all__ that is only conditionally bound
  // (so it is undecidable, and the underscore convention applies).
  'src/shop/blocks.py': [
    'import sys',
    'for _flavour in ("a",):',
    '    def in_for():',
    '        return 1',
    'while False:',
    '    def in_while():',
    '        return 2',
    'if sys.platform:',
    '    __all__ = ["in_for"]',
    '',
  ].join('\n'),
  'src/shop/compat.py': [
    '__all__ = ["fast_path"]',
    '__all__ += ["slow_path"]',
    'try:',
    '    import ujson',
    'except ImportError:',
    '    def slow_path(data):',
    '        """Fallback JSON path."""',
    '        return data',
    'if True:',
    '    def fast_path(data):',
    '        return data',
    '',
    '@register',
    '@cache(size=1)',
    'class Codec:',
    '    if True:',
    '        def encode(self, x):',
    '            return x',
    '',
  ].join('\n'),
  'src/shop/broken.py': 'def oops(:\n    pass\n',
  'tools/cli.py': 'from shop.orders.service import OrderService\nfrom shop.missing import nope\nfrom shop.broken import oops\n',
  'secrets/creds.py': 'TOKEN = "x"\ndef leaked():\n    return TOKEN\n',
};

let root;
let outside;
let symlinked = false;

function requirePython() {
  const probe = probePythonParser();
  if (!probe.available) {
    throw new Error(`Python >= 3.9 is required for this suite (install it on PATH, or set ${PYTHON_ENV_VAR}): ${probe.reason}`);
  }
}

function runExtract(args = [], env = {}) {
  const r = spawnSync(process.execPath, [EXTRACT, '--root', root, ...args], {
    encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024, timeout: SUBPROCESS_TIMEOUT_MS,
  });
  assert.equal(r.error?.code, undefined, `extract did not finish: ${r.error?.code}`);
  assert.equal(r.status, 0, `extract failed: ${r.stderr}`);
  return { records: r.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)), stdout: r.stdout, stderr: r.stderr };
}
const ofType = (recs, t) => recs.filter((r) => r.type === t);
const coverageOf = (recs) => ofType(recs, 'coverage')[0]?.extraction;

before(() => {
  requirePython();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'py-arch-e2e-'));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'py-arch-e2e-out-'));
  for (const [rel, text] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  // A latin-1 file with a PEP 263 cookie — valid Python, invalid UTF-8.
  fs.writeFileSync(path.join(root, 'src/shop/legacy.py'),
    Buffer.from('# -*- coding: latin-1 -*-\ndef greet():\n    """Caf\xe9 greeting."""\n    return 1\n', 'latin1'));
  // An innocent-named .py symlinked OUTSIDE the repo.
  fs.writeFileSync(path.join(outside, 'stolen.py'), 'def stolen():\n    return 1\n');
  try { fs.symlinkSync(path.join(outside, 'stolen.py'), path.join(root, 'src/shop/util.py')); symlinked = true; } catch { /* EPERM on unprivileged Windows */ }
  execFileSync('git', ['init', '--quiet', root]);
});
after(() => {
  for (const d of [root, outside]) if (d) fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe('Python fixture repo — full extract through the real CLI', () => {
  let recs;
  before(() => { ({ records: recs } = runExtract()); });

  it('indexes module functions, classes and methods with signatures', () => {
    const got = ofType(recs, 'symbol').map((s) => `${s.filePath}::${s.symbolName}::${s.kind}::${s.signature}`).sort();
    assert.deepEqual(got.filter((g) => !/aws\.py|compat\.py|odd\.py|blocks\.py|trusted\.py|dynamic\.py/.test(g)), [
      'src/shop/legacy.py::greet::function::def greet()',
      'src/shop/orders/pricing.py::total_price::function::def total_price(items, tax_rate=0.2)',
      'src/shop/orders/service.py::OrderService._audit::method::def _audit(self)',
      'src/shop/orders/service.py::OrderService.place_order::method::def place_order(self, items)',
      'src/shop/orders/service.py::OrderService::class::class OrderService',
    ].sort());
  });

  it('carries the docstring inside bodyText (decoded per the PEP 263 cookie)', () => {
    const tp = ofType(recs, 'symbol').find((s) => s.symbolName === 'total_price');
    assert.match(tp.bodyText, /apply sales tax/);
    assert.match(ofType(recs, 'symbol').find((s) => s.symbolName === 'greet').bodyText, /Café greeting/);
  });

  it('every symbol record satisfies the fields and types refresh/summarise/embed consume', () => {
    for (const s of ofType(recs, 'symbol')) {
      assert.equal(typeof s.filePath, 'string');
      assert.ok(Number.isInteger(s.startLine) && Number.isInteger(s.endLine) && s.endLine >= s.startLine);
      assert.ok(SymbolKindEnum.safeParse(s.kind).success, s.kind);
      assert.ok(typeof s.signatureHash === 'string' && s.signatureHash.length > 0);
      assert.equal(typeof s.redacted, 'boolean');
      assert.equal(typeof s.isExported, 'boolean');
      assert.equal(s.embedding, null);
    }
    assert.equal(ofType(recs, 'symbol').find((s) => s.symbolName === 'OrderService._audit').isExported, false);
  });

  it('a secret in a default arg, a docstring or a body — each alone — never leaves in ANY field', () => {
    const aws = ofType(recs, 'symbol').filter((s) => s.filePath === 'src/shop/aws.py');
    assert.deepEqual(aws.map((s) => s.symbolName).sort(), ['by_body', 'by_docstring', 'by_signature']);
    for (const s of aws) {
      assert.equal(s.redacted, true, `${s.symbolName} must be redacted`);
      assert.equal(s.bodyText, '');
    }
    const all = JSON.stringify(recs);
    for (const k of KEYS) assert.equal(all.includes(k), false, `a key leaked: ${k.slice(0, 4)}…`);
  });

  it('finds definitions under if/try/with, includes decorators, treats a mutated __all__ as undecidable', () => {
    const c = Object.fromEntries(ofType(recs, 'symbol')
      .filter((s) => s.filePath === 'src/shop/compat.py').map((s) => [s.symbolName, s]));
    assert.deepEqual(Object.keys(c).sort(), ['Codec', 'Codec.encode', 'fast_path', 'slow_path']);
    assert.equal(c.Codec.startLine, 13, 'span starts at the first decorator');
    assert.match(c.Codec.bodyText, /^@register\n@cache\(size=1\)\nclass Codec:/);
    // `__all__ += [...]` makes the final list undecidable: both fall back to the underscore convention.
    assert.equal(c.slow_path.isExported, true);
    assert.equal(c.fast_path.isExported, true);
  });

  it('slices on Python\'s own line boundaries; any second mention of __all__ makes it undecidable', () => {
    const o = Object.fromEntries(ofType(recs, 'symbol')
      .filter((s) => s.filePath === 'src/shop/odd.py').map((s) => [s.symbolName, s]));
    assert.equal(o.visible.startLine, 3);
    assert.match(o.visible.bodyText, /^def visible\(\):\n {4}"""Shown\."""\n {4}return SEP$/,
      'a U+2028 in an earlier string must not shift the slice');
    // hidden() mentions __all__ again (a local one), so the module's literal is
    // not trusted and both public names follow the underscore convention.
    assert.equal(o.visible.isExported, true);
    assert.equal(o.hidden.isExported, true);
  });

  it('a single unconditional literal __all__ IS trusted (negative control for the fallbacks)', () => {
    const p = ofType(recs, 'symbol').filter((s) => s.filePath === 'src/shop/trusted.py');
    assert.deepEqual(p.map((s) => `${s.symbolName}:${s.isExported}`).sort(), ['listed:true', 'unlisted:false']);
    const d = ofType(recs, 'symbol').filter((s) => s.filePath === 'src/shop/dynamic.py');
    assert.deepEqual(d.map((s) => `${s.symbolName}:${s.isExported}`).sort(), ['later:true', 'shown:true'],
      'an exec string mentioning __all__ makes the literal untrusted');
  });

  it('finds defs inside for/while blocks; a conditionally-bound __all__ is undecidable', () => {
    const b = Object.fromEntries(ofType(recs, 'symbol')
      .filter((s) => s.filePath === 'src/shop/blocks.py').map((s) => [s.symbolName, s]));
    assert.deepEqual(Object.keys(b).sort(), ['in_for', 'in_while']);
    assert.equal(b.in_while.isExported, true, 'not trusting a conditional __all__ = ["in_for"]');
  });

  it('a sensitive-path .py and an escaping symlink are never read, named or indexed', () => {
    const all = JSON.stringify(recs);
    assert.equal(all.includes('secrets/creds.py'), false);
    assert.equal(all.includes('leaked'), false);
    if (symlinked) {
      assert.equal(all.includes('stolen'), false);
      assert.equal(all.includes('src/shop/util.py'), false);
    }
  });

  it('builds the import graph against the package root (src layout, relative + absolute)', () => {
    const edges = ofType(recs, 'import').map((e) => `${e.importer}->${e.imported}`).sort();
    assert.deepEqual(edges, [
      'src/shop/orders/service.py->src/shop/orders/pricing.py',
      'tools/cli.py->src/shop/broken.py',
      'tools/cli.py->src/shop/orders/service.py',
    ], 'an import of a file that failed to parse is still a LOCAL edge');
    const cov = coverageOf(recs);
    assert.equal(cov.edges.persisted, 3);
    assert.equal(cov.edges.external, 3, 'requests, ujson, sys');
    assert.equal(cov.edges.unresolved, 1, 'shop.missing — a known local package');
  });

  it('coverage measures Python (no empty_universe) and counts the dropped file', () => {
    const cov = coverageOf(recs);
    assert.equal(cov.outcome, 'ok');
    assert.equal(cov.parser.unparseable, 0);
    // 14 regular .py (+ the symlink when the OS allowed one); the sensitive file
    // and the escaping symlink are refused by the gate, so they are not in the
    // universe at all (never read, never named): 13 either way.
    assert.equal(cov.eligible, 13);
    assert.equal(cov.cruised, cov.eligible - 1, 'only broken.py (syntax error) is uncruised');
    assert.deepEqual(cov.samples.uncruised, ['src/shop/broken.py']);
    const summary = ofType(recs, 'summary')[0].counts;
    assert.ok(summary.parseFailures >= 1, 'broken.py counted');
    assert.equal(summary.skippedNoParser, 0);
  });

  it('processed covers parsed symbol-scope files, zero-symbol ones included, never a failed one', () => {
    const processed = new Set(ofType(recs, 'processed').map((p) => p.file));
    assert.ok(processed.has('src/shop/__init__.py'), 'zero-symbol file is reached');
    assert.ok(processed.has('tools/cli.py'));
    assert.equal(processed.has('src/shop/broken.py'), false);
  });

  it('no progress record names an unadmitted path', () => {
    for (const p of ofType(recs, 'progress')) {
      if (p.file) assert.ok(!p.file.startsWith('secrets/') && p.file !== 'src/shop/util.py', p.file);
    }
  });
});

describe('Python fixture repo — incremental extract', () => {
  it('symbols come only from the changed file, while imports and coverage stay whole-repo', () => {
    const manifest = writeFilesManifest(['src/shop/orders/pricing.py'], 'py-e2e-');
    try {
      const { records } = runExtract(['--mode', 'incremental', '--files-from', manifest]);
      assert.deepEqual([...new Set(ofType(records, 'symbol').map((s) => s.filePath))], ['src/shop/orders/pricing.py']);
      assert.deepEqual(ofType(records, 'processed').map((p) => p.file), ['src/shop/orders/pricing.py'],
        'import-only universe files are not "processed"');
      assert.equal(ofType(records, 'import').length, 3, 'the whole import graph is still published');
      assert.equal(coverageOf(records).parser.unparseable, 0);
    } finally { removeFilesManifest(manifest); }
  });
});

describe('Python fixture repo — no interpreter', () => {
  it('reports .py as UNPARSEABLE, never indexed, and names the remedy', () => {
    const { records, stderr } = runExtract([], { [PYTHON_ENV_VAR]: path.join(outside, 'no-such-python') });
    assert.equal(ofType(records, 'symbol').length, 0);
    assert.equal(ofType(records, 'import').length, 0);
    const cov = coverageOf(records);
    assert.ok(cov.parser.unparseable >= 9, JSON.stringify(cov.parser));
    assert.equal(cov.parser.byExtension['.py'], cov.parser.unparseable);
    assert.ok(cov.parser.unavailableExtensions.includes('.py'));
    assert.equal(cov.cruised, 0);
    assert.ok(ofType(records, 'summary')[0].counts.skippedNoParser > 0);
    assert.match(stderr, /ARCH_INDEX_PYTHON/);
  });
});

describe('get-neighbourhood returns a real Python neighbour', () => {
  it('ranks the extracted Python function first for a matching intent', () => {
    const { stdout } = runExtract();
    const env = { ...process.env, LEARNING_DISABLE: '1', AUDIT_DB_URL: '', NO_NET_LOG: path.join(outside, 'net.log') };
    const r = spawnSync(process.execPath, ['--import', pathToFileURL(NO_NET).href, CHILD, root,
      'compute the order total price including sales tax'], { input: stdout, encoding: 'utf8', env, timeout: SUBPROCESS_TIMEOUT_MS });
    assert.equal(r.error?.code, undefined, `neighbourhood child did not finish: ${r.error?.code}`);
    assert.equal(r.status, 0, r.stderr);
    const result = NeighbourhoodResultSchema.parse(JSON.parse(r.stdout.trim().split('\n').pop()));
    assert.ok(result.records.length > 0);
    assert.equal(result.records[0].symbolName, 'total_price');
    assert.equal(result.records[0].filePath, 'src/shop/orders/pricing.py');
    assert.ok(result.records.every((x) => x.filePath.endsWith('.py')));
    const net = fs.existsSync(env.NO_NET_LOG) ? fs.readFileSync(env.NO_NET_LOG, 'utf8') : '';
    assert.equal(net, '', `the orchestrator made a network attempt: ${net}`);
  });
});

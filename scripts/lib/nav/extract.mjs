/**
 * @fileoverview The universal nav-affordance detector (plan §2.2, §4a.B).
 *
 * AST-based (debt-1 upgrade): parses each source with `@babel/parser` and walks
 * the tree, so nested `>`/`{}` in JSX (`<Route element={<Foo/>} path>`,
 * `<a onClick={…} href>`) no longer break detection. Affordances are recognised
 * by BEHAVIOUR, not framework; framework knowledge stays in the adapters, which
 * only resolve a raw target to a canonical destination id and discover the route
 * inventory.
 *
 * Output edges are HYPOTHESES: each carries a confidence; unresolved/opaque
 * targets are low-confidence and never hard-gate. Anchor attribution is deferred
 * to model.mjs (plan §2.3).
 *
 * @module scripts/lib/nav/extract
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveAndClassify } from '../sensitive-paths.mjs';
import { activeAdapters, resolveWithAdapters } from './adapters/index.mjs';
import { normalizeDestination, namespaceId } from './normalize.mjs';
import { parseSource, walk, classifyTarget, jsxLabel, jsxAttr, jsxTagName, calleeName, unwrapObjectExpression, unwrapArrayExpression } from './ast.mjs';
import { appRootForPath } from './approot.mjs';

const LINK_TAGS = new Set(['a', 'Link', 'NavLink']);
const NAV_CALLS = new Set(['navigate', 'router.push', 'router.replace', 'history.push', 'history.replace', 'switchView', 'setView']);
const MODAL_CALLS = new Set(['openModal', 'showModal', 'openOverlay']);
const MODAL_PREFIX = 'modal:';
const EXTERNAL_RE = /^(?:https?:|mailto:|tel:|#|javascript:)/i;

/** Non-app source that injects phantom destinations (feedback #4): tests,
 *  fixtures, e2e, build output, and sibling/tooling dirs. */
const DEFAULT_EXCLUDE = [
  /(^|\/)(tests?|__tests__|__mocks__|e2e|fixtures?|stories|coverage)(\/|$)/i,
  /\.(test|spec|stories|e2e)\.[jt]sx?$/i,
  /(^|\/)(dist|build|out|\.next|\.nuxt|node_modules|vendor)(\/|$)/i,
  /(^|\/)playwright[^/]*\.[jt]s$/i,
];

/**
 * Read candidate source files from disk, skipping sensitive/binary/escaping AND
 * non-app paths (tests/fixtures/build — feedback #4). Extra `exclude` globs come
 * from the contract.
 * @param {string} root
 * @param {string[]} relFiles
 * @param {object} [opts]
 * @param {string[]} [opts.exclude] - additional repo-relative substring/glob excludes
 * @returns {{sources, skipped, unreadable, excluded}}
 */
export function readSources(root, relFiles, { exclude = [] } = {}) {
  const out = [];
  let skipped = 0;
  let unreadable = 0;
  let excluded = 0;
  const extra = exclude.map((g) => globToRe(g));
  for (const rel of relFiles) {
    if (!/\.[jt]sx?$/.test(rel)) continue;
    const norm = rel.replace(/\\/g, '/');
    if (DEFAULT_EXCLUDE.some((re) => re.test(norm)) || extra.some((re) => re.test(norm))) { excluded++; continue; }
    const cls = resolveAndClassify(rel, { repoRoot: root });
    if (cls.category === 'sensitive' || cls.category === 'generatedNoise' || cls.escapedRepo) { skipped++; continue; }
    try {
      const content = fs.readFileSync(path.join(root, rel), 'utf-8');
      out.push({ path: norm, content });
    } catch { unreadable++; }
  }
  return { sources: out, skipped, unreadable, excluded };
}

/** Tiny glob → RegExp (supports `**`, `*`, and plain substrings). */
function globToRe(g) {
  if (typeof g !== 'string' || !g) return /$^/;
  if (!/[*?]/.test(g)) return new RegExp(g.replace(/[.+^${}()|[\]\\]/g, '\\$&'));
  const re = g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\x00').replace(/\*/g, '[^/]*').replace(/\x00/g, '.*');
  return new RegExp(re);
}

/**
 * Extract nav edges from a set of in-memory sources.
 * @param {Array<{path: string, content: string}>} sources
 * @param {object} [opts]
 * @param {string} [opts.root='.']
 * @param {string[]} [opts.appRoots=[]] - declared monorepo app roots (namespacing)
 * @returns {{edges, adapters, recall, destinations, warnings}}
 */
export function extractEdges(sources, { root = '.', appRoots = [] } = {}) {
  const warnings = [];

  // Parse once; reuse the AST for adapters + the affordance walk.
  const parsed = sources.map((s) => {
    const { ast, error } = parseSource(s.content);
    if (error) warnings.push(`parse failed (${s.path}): ${error}`);
    return { ...s, ast };
  });
  const parseable = parsed.filter((s) => s.ast);

  const adapters = activeAdapters(root, parseable);
  const ctx = { viewsMap: buildViewsMap(parseable) };

  const rawDestinations = adapters.flatMap((a) => {
    try { return a.discoverDestinations(parseable); }
    catch (err) { warnings.push(`adapter ${a.name} discovery failed: ${err.message}`); return []; }
  });
  // Namespace discovered destinations by app root (monorepo).
  const destinations = rawDestinations.map((d) => ({ ...d, id: namespaceId(d.id, appRootForPath(d.sourceLoc, appRoots)) }));

  const edges = [];
  let lowConfidence = 0;
  let opaque = 0;

  for (const s of parseable) {
    const ns = appRootForPath(s.path, appRoots);
    const enumerated = enumerateIterationTargets(s.ast);
    walk(s.ast, (node, c) => {
      for (const aff of affordancesOf(node, enumerated)) {
        const resolved = resolveTarget(adapters, aff.target, ctx, aff.type);
        for (const id0 of resolved.ids) {
          const id = aff.type === 'modal-trigger' ? id0 : namespaceId(id0, ns);
          if (id === '<dynamic>' || id0 === '<dynamic>') opaque++;
          if (resolved.confidence === 'low') lowConfidence++;
          edges.push({
            entryPoint: c.enclosing ?? basename(s.path),
            layer: 'content',
            // DOM-container anchor (vanilla/template apps) pre-attributed here;
            // React-component anchors are attributed by the model via containment.
            anchor: aff.domAnchor ?? null,
            affordanceType: aff.type,
            label: aff.label,
            destination: id,
            confidence: resolved.confidence,
            sourceLoc: `${s.path}:${c.line}`,
          });
        }
      }
    });
  }

  return {
    edges,
    adapters: adapters.map((a) => a.name),
    recall: { extracted: edges.length, lowConfidence, opaque, parsed: parseable.length, unparsed: parsed.length - parseable.length },
    destinations,
    warnings,
  };
}

/** All nav affordances a node introduces. JSX + calls yield ≤1; string/template
 *  literals can yield many (vanilla apps build HTML — including `<a href>` and
 *  inline `switchView(...)` — inside template strings, which the AST sees as
 *  opaque literals; we scan their text to recover those links). */
function affordancesOf(node, enumerated) {
  if (node.type === 'JSXElement') {
    const a = jsxAffordance(node, enumerated);
    return a ? [a] : [];
  }
  if (node.type === 'CallExpression') {
    const a = callAffordance(node, enumerated);
    return a ? [a] : [];
  }
  if (node.type === 'StringLiteral') return embeddedAffordances(node.value);
  if (node.type === 'TemplateLiteral') return embeddedAffordances(templateText(node));
  return [];
}

function jsxAffordance(node, enumerated) {
  const tag = jsxTagName(node.openingElement);
  if (LINK_TAGS.has(tag)) {
    const target = targetOf(jsxAttr(node.openingElement, ['href', 'to']), enumerated);
    if (isSkippable(target)) return null;
    return { type: 'link', target, label: jsxLabel(node) };
  }
  if (tag === 'Navigate') {
    const target = targetOf(jsxAttr(node.openingElement, ['to', 'href']), enumerated);
    if (isSkippable(target)) return null;
    return { type: 'redirect', target, label: null };
  }
  return null;
}

function callAffordance(node, enumerated) {
  const name = calleeName(node);
  if (!name) return null;
  if (NAV_CALLS.has(name)) {
    const target = targetOf(node.arguments?.[0], enumerated);
    if (isSkippable(target)) return null;
    return { type: 'navigate-call', target, label: null };
  }
  if (MODAL_CALLS.has(name)) {
    const target = targetOf(node.arguments?.[0], enumerated);
    return { type: 'modal-trigger', target, label: null };
  }
  return null;
}

const EMBED_A_RE = /<a\b[^>]*?\bhref\s*=\s*["']([^"'#][^"']*)["'][^>]*>([^<]*)/gi;
const EMBED_NAV_RE = /\b(?:switchView|setView)\s*\(\s*((?:VIEWS|viewRegistry)\.[A-Za-z0-9_]+|['"][^'"]+['"])/g;
// data-attribute nav (feedback #2): `<button data-view="wines">` etc. — the
// dominant nav of vanilla/server-rendered apps.
const EMBED_DATA_RE = /\bdata-(?:view|target|nav|tab)\s*=\s*["']([^"'${][^"']*)["']/gi;

/** Recover affordances embedded in a string/template-literal value (vanilla HTML),
 *  each attributed to its nearest enclosing DOM container (feedback #1/#2). */
function embeddedAffordances(text) {
  if (typeof text !== 'string' || (!/href|switchView|setView|data-(?:view|target|nav|tab)/.test(text))) return [];
  const out = [];
  let m;
  EMBED_A_RE.lastIndex = 0;
  while ((m = EMBED_A_RE.exec(text)) !== null) {
    const value = m[1];
    if (EXTERNAL_RE.test(value)) continue;
    if (/^\$[\d&]/.test(value)) continue; // regex-replacement artifact, not a link
    const target = value.includes('${') || value.includes('"+') ? { type: 'template', value: value.replace(/\$\{[^}]*\}/g, '${x}') } : { type: 'literal', value };
    const label = (m[2] || '').replace(/\$\{[^}]*\}/g, '').trim() || null;
    out.push({ type: 'link', target, label, domAnchor: findDomAnchor(text, m.index) });
  }
  EMBED_NAV_RE.lastIndex = 0;
  while ((m = EMBED_NAV_RE.exec(text)) !== null) {
    const arg = m[1];
    const target = /^(?:VIEWS|viewRegistry)\./.test(arg) ? { type: 'member', value: arg } : { type: 'literal', value: arg.replace(/^['"]|['"]$/g, '') };
    out.push({ type: 'navigate-call', target, label: null, domAnchor: findDomAnchor(text, m.index) });
  }
  EMBED_DATA_RE.lastIndex = 0;
  while ((m = EMBED_DATA_RE.exec(text)) !== null) {
    out.push({ type: 'navigate-call', target: { type: 'literal', value: m[1] }, label: null, domAnchor: findDomAnchor(text, m.index) });
  }
  return out;
}

/** Nearest enclosing DOM container for an affordance at `index`: the closest
 *  preceding `id="…"`, else a nav-ish `class="…"`. Heuristic (no full HTML parse)
 *  but enough to attribute vanilla nav to a container (feedback #1). */
function findDomAnchor(text, index) {
  const before = text.slice(0, index);
  const ids = [...before.matchAll(/\bid\s*=\s*["']([^"'${]+)["']/gi)];
  if (ids.length) return `#${ids[ids.length - 1][1]}`;
  const cls = [...before.matchAll(/\bclass\s*=\s*["']([^"']*\b(?:nav|tabs?|menu|sidebar|bottom-?nav|toolbar)\b[^"']*)["']/gi)];
  if (cls.length) {
    const navClass = cls[cls.length - 1][1].split(/\s+/).find((c) => /nav|tabs?|menu|sidebar|toolbar/i.test(c));
    if (navClass) return `.${navClass}`;
  }
  return null;
}

/** Reconstruct a template literal's text with `${…}` placeholders. */
function templateText(node) {
  let out = '';
  (node.quasis || []).forEach((q, i) => {
    out += q.value.cooked ?? q.value.raw ?? '';
    if (i < (node.expressions || []).length) out += '${x}';
  });
  return out;
}

/** Classify a target expression, preferring a statically-enumerated binding
 *  (see `enumerateIterationTargets`). External values are dropped from an
 *  enumeration the same way an external literal is skipped; an enumeration left
 *  with nothing known and nothing opaque is skippable. */
function targetOf(node, enumerated) {
  const expr = node?.type === 'JSXExpressionContainer' ? node.expression : node;
  const hit = expr && enumerated?.get(expr);
  if (!hit) return classifyTarget(node);
  const values = hit.values.filter((v) => v !== '' && !EXTERNAL_RE.test(v));
  if (!values.length && !hit.dynamic) return null;
  return { ...hit, values };
}

const ITERATION_METHODS = new Set(['map', 'flatMap', 'forEach']);
const FUNCTION_TYPES = new Set(['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration']);

/**
 * Statically enumerate nav targets inside an array-iteration callback.
 *
 * The persistent-nav-bar shape —
 *   `const DESTINATIONS = [{screen: 'workflow'}, …]`
 *   `const renderItem = (d) => <button onClick={() => navigate(d.screen)}/>`
 *   `DESTINATIONS.map(renderItem)`
 * — reads a literal property off a parameter bound to a same-file array of
 * object literals, so every value it can take is known. This is NOT the
 * runtime-computed nav (`el.dataset.view`, a server-driven registry) that
 * correctly degrades to `<dynamic>`.
 *
 * Covered: `ARR.map|flatMap|forEach(cb)` where `ARR` is declared once in the
 * file as an array literal (`as const` / `Object.freeze` unwrapped) and `cb` is
 * an inline function or a function declared once in the file; the target reads
 * `param.prop`, `param['prop']`, a destructured `{prop}` / `{prop: alias}`, or
 * the element itself (an array of string literals). Deliberately NOT covered —
 * each stays opaque: imported arrays, chained calls (`ARR.filter(…).map(cb)`),
 * a callback passed through props, and nested property paths (`d.meta.screen`).
 * A name declared more than once in the file, or shadowed by a nested
 * function's parameter, is never resolved.
 *
 * @param {object} ast
 * @returns {WeakMap<object, {type: 'enumerated', values: string[], dynamic: boolean}>}
 *   keyed by the target expression node
 */
function enumerateIterationTargets(ast) {
  const out = new WeakMap();
  const declCount = new Map();
  const arrays = new Map();
  const fns = new Map();
  const declare = (name) => declCount.set(name, (declCount.get(name) ?? 0) + 1);

  walk(ast, (node) => {
    if (node.type === 'VariableDeclarator') {
      for (const n of patternNames(node.id)) declare(n);
      if (node.id?.type !== 'Identifier') return;
      const arr = unwrapArrayExpression(node.init);
      if (arr) arrays.set(node.id.name, arr);
      if (node.init && FUNCTION_TYPES.has(node.init.type)) fns.set(node.id.name, node.init);
    } else if ((node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') && node.id) {
      declare(node.id.name);
      if (node.type === 'FunctionDeclaration') fns.set(node.id.name, node);
    }
    if (FUNCTION_TYPES.has(node.type)) for (const p of node.params || []) for (const n of patternNames(p)) declare(n);
  });
  const unique = (map, name) => (declCount.get(name) === 1 ? map.get(name) : undefined);

  walk(ast, (node) => {
    if (node.type !== 'CallExpression') return;
    const callee = node.callee;
    if (callee?.type !== 'MemberExpression' || callee.computed || callee.object?.type !== 'Identifier') return;
    if (!ITERATION_METHODS.has(callee.property?.name)) return;
    const arr = unique(arrays, callee.object.name);
    if (!arr) return;
    const arg = node.arguments?.[0];
    const cb = arg?.type === 'Identifier' ? unique(fns, arg.name) : (FUNCTION_TYPES.has(arg?.type) ? arg : undefined);
    const bindings = paramBindings(cb?.params?.[0]);
    if (!bindings) return;
    markReads(cb.body, bindings, (prop) => enumerateProperty(arr.elements, prop), out);
  });
  return out;
}

/** Local names bound by the element parameter → the property each one reads
 *  (`null` = the whole element). Null when the parameter is not a supported shape. */
function paramBindings(param) {
  if (param?.type === 'Identifier') return new Map([[param.name, null]]);
  if (param?.type !== 'ObjectPattern') return null;
  const m = new Map();
  for (const p of param.properties) {
    if (p.type !== 'ObjectProperty' || p.computed || p.value?.type !== 'Identifier') continue;
    const key = propKeyName(p.key);
    if (key) m.set(p.value.name, key);
  }
  return m.size ? m : null;
}

/** Record every read of a bound name inside `body` (a whole-element Identifier,
 *  or `elem.prop` / `elem['prop']`), skipping any nested function that re-binds
 *  one of the names. Hand-rolled rather than `walk` because `walk` cannot prune a
 *  subtree, and a shadowed name must not resolve. */
function markReads(node, bindings, enumerate, out) {
  if (!node || typeof node.type !== 'string') return;
  if (FUNCTION_TYPES.has(node.type) && node.params.some((p) => patternNames(p).some((n) => bindings.has(n)))) return;
  if (node.type === 'MemberExpression' && node.object?.type === 'Identifier' && bindings.get(node.object.name) === null) {
    const prop = node.computed ? (node.property?.type === 'StringLiteral' ? node.property.value : null) : node.property?.name;
    if (prop) record(out, node, enumerate(prop));
  } else if (node.type === 'Identifier' && bindings.has(node.name)) {
    record(out, node, enumerate(bindings.get(node.name)));
  }
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key.endsWith('Comments')) continue;
    const child = node[key];
    if (Array.isArray(child)) for (const c of child) markReads(c, bindings, enumerate, out);
    else if (child && typeof child.type === 'string') markReads(child, bindings, enumerate, out);
  }
}

/** A callback shared by several arrays (`PRIMARY.map(render)` +
 *  `SECONDARY.map(render)`) reaches the same read once per array — union them. */
function record(out, node, e) {
  const prev = out.get(node);
  out.set(node, prev ? { ...e, values: [...new Set([...prev.values, ...e.values])], dynamic: prev.dynamic || e.dynamic } : e);
}

/** Every static string value `prop` takes across the array's elements (`prop`
 *  null = the element itself). `dynamic` marks an element whose value is present
 *  but not a literal — the enumeration is then partial, and says so. An object
 *  element that simply lacks the property (a divider entry) contributes nothing. */
function enumerateProperty(elements, prop) {
  const values = [];
  let dynamic = false;
  for (const el of elements || []) {
    if (prop === null) {
      const v = staticString(el);
      if (v === null) dynamic = true; else values.push(v);
      continue;
    }
    if (el?.type !== 'ObjectExpression') { dynamic = true; continue; }
    const p = el.properties.find((pr) => pr.type === 'ObjectProperty' && !pr.computed && propKeyName(pr.key) === prop);
    if (!p) {
      if (el.properties.some((pr) => pr.type === 'SpreadElement')) dynamic = true;
      continue;
    }
    const v = staticString(p.value);
    if (v === null) dynamic = true; else values.push(v);
  }
  return { type: 'enumerated', values: [...new Set(values)], dynamic };
}

function staticString(node) {
  if (node?.type === 'StringLiteral') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0]?.value.cooked ?? null;
  return null;
}

function propKeyName(key) {
  if (key?.type === 'Identifier') return key.name;
  if (key?.type === 'StringLiteral') return key.value;
  return null;
}

/** Every local name a binding pattern introduces. */
function patternNames(p) {
  if (!p) return [];
  switch (p.type) {
    case 'Identifier': return [p.name];
    case 'AssignmentPattern': return patternNames(p.left);
    case 'RestElement': return patternNames(p.argument);
    case 'ArrayPattern': return p.elements.flatMap(patternNames);
    case 'ObjectPattern': return p.properties.flatMap((pr) => patternNames(pr.type === 'RestElement' ? pr : pr.value));
    case 'TSParameterProperty': return patternNames(p.parameter);
    default: return [];
  }
}

function isSkippable(target) {
  if (!target) return true;
  if (target.type === 'literal' && (target.value === '' || EXTERNAL_RE.test(target.value))) return true;
  return false;
}

/** Resolve a structured target to canonical id(s) + confidence. */
function resolveTarget(adapters, target, ctx, affordanceType) {
  if (target?.type === 'enumerated') {
    // Each statically-known value resolves exactly as the literal it is. Capped
    // at medium: every value is certain, but nothing proved every element renders
    // (a conditional inside the callback can still hide one). A non-literal
    // element keeps an explicit opaque id beside the known ones — partial
    // knowledge is reported as partial, never rounded up to complete.
    const ids = [];
    let confidence = target.dynamic ? 'low' : 'medium';
    for (const value of target.values) {
      const r = resolveTarget(adapters, { type: 'literal', value }, ctx, affordanceType);
      ids.push(...r.ids);
      if (r.confidence === 'low') confidence = 'low';
    }
    if (target.dynamic) ids.push(affordanceType === 'modal-trigger' ? `${MODAL_PREFIX}<dynamic>` : '<dynamic>');
    return { ids: [...new Set(ids)], confidence };
  }
  if (affordanceType === 'modal-trigger') {
    const key = target.type === 'literal' ? target.value : '';
    return { ids: [`${MODAL_PREFIX}${key || '<dynamic>'}`], confidence: key ? 'high' : 'low' };
  }
  if (!target || target.type === 'unknown') return { ids: ['<dynamic>'], confidence: 'low' };

  if (target.type === 'member') {
    // `targetType` lets a path-shaped adapter decline a JS reference: `item.view`
    // is a computed value, not a path, and must stay <dynamic> rather than become
    // a phantom destination literally named `item.view`.
    const id = resolveWithAdapters(adapters, target.value, { ...ctx, targetType: 'member' });
    return { ids: [id || '<dynamic>'], confidence: id ? 'medium' : 'low' };
  }
  if (target.type === 'template') {
    const { ids, confidence } = normalizeDestination(target.value);
    return { ids: ids.length ? ids : ['<dynamic>'], confidence: confidence === 'high' ? 'low' : confidence };
  }
  // literal
  const adapterId = resolveWithAdapters(adapters, target.value, ctx);
  if (adapterId) return { ids: [adapterId], confidence: adapterId === '<dynamic>' ? 'low' : 'high' };
  const { ids, confidence } = normalizeDestination(target.value);
  return { ids: ids.length ? ids : ['<dynamic>'], confidence };
}

/** Parse all `VIEWS`/`viewRegistry` object literals (AST) so the vanilla adapter
 *  can resolve `VIEWS.X` to its real value (not a guessed slug). */
function buildViewsMap(parsed) {
  const map = new Map();
  for (const s of parsed) {
    walk(s.ast, (node) => {
      const obj = viewsObjectOf(node);
      if (!obj) return;
      for (const prop of obj.properties || []) {
        if (prop.type === 'ObjectProperty' && prop.key && prop.value?.type === 'StringLiteral') {
          const key = prop.key.name ?? prop.key.value;
          if (key) map.set(String(key), prop.value.value);
        }
      }
    });
  }
  return map;
}

/** Return the ObjectExpression assigned to a VIEWS/viewRegistry binding (unwrapping
 *  Object.freeze(...) etc.), or null. */
function viewsObjectOf(node) {
  const NAMES = new Set(['VIEWS', 'viewRegistry']);
  if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && NAMES.has(node.id.name)) {
    return unwrapObjectExpression(node.init);
  }
  if (node.type === 'AssignmentExpression' && node.left?.type === 'Identifier' && NAMES.has(node.left.name)) {
    return unwrapObjectExpression(node.right);
  }
  return null;
}

function basename(p) {
  return p.split('/').pop().replace(/\.[jt]sx?$/, '');
}

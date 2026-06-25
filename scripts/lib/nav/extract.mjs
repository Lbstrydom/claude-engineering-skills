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
import { parseSource, walk, classifyTarget, jsxLabel, jsxAttr, jsxTagName, calleeName } from './ast.mjs';
import { appRootForPath } from './approot.mjs';

const LINK_TAGS = new Set(['a', 'Link', 'NavLink']);
const NAV_CALLS = new Set(['navigate', 'router.push', 'router.replace', 'history.push', 'history.replace', 'switchView', 'setView']);
const MODAL_CALLS = new Set(['openModal', 'showModal', 'openOverlay']);
const MODAL_PREFIX = 'modal:';
const EXTERNAL_RE = /^(?:https?:|mailto:|tel:|#|javascript:)/i;

/**
 * Read candidate source files from disk, skipping sensitive/binary/escaping paths.
 * @param {string} root
 * @param {string[]} relFiles
 * @returns {{sources: Array<{path: string, content: string}>, skipped: number, unreadable: number}}
 */
export function readSources(root, relFiles) {
  const out = [];
  let skipped = 0;
  let unreadable = 0;
  for (const rel of relFiles) {
    if (!/\.[jt]sx?$/.test(rel)) continue;
    const cls = resolveAndClassify(rel, { repoRoot: root });
    if (cls.category === 'sensitive' || cls.category === 'generatedNoise' || cls.escapedRepo) { skipped++; continue; }
    try {
      const content = fs.readFileSync(path.join(root, rel), 'utf-8');
      out.push({ path: rel.replace(/\\/g, '/'), content });
    } catch { unreadable++; }
  }
  return { sources: out, skipped, unreadable };
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
    walk(s.ast, (node, c) => {
      for (const aff of affordancesOf(node)) {
        const resolved = resolveTarget(adapters, aff.target, ctx, aff.type);
        for (const id0 of resolved.ids) {
          const id = aff.type === 'modal-trigger' ? id0 : namespaceId(id0, ns);
          if (id === '<dynamic>' || id0 === '<dynamic>') opaque++;
          if (resolved.confidence === 'low') lowConfidence++;
          edges.push({
            entryPoint: c.enclosing ?? basename(s.path),
            layer: 'content',
            anchor: null,
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
function affordancesOf(node) {
  if (node.type === 'JSXElement') {
    const a = jsxAffordance(node);
    return a ? [a] : [];
  }
  if (node.type === 'CallExpression') {
    const a = callAffordance(node);
    return a ? [a] : [];
  }
  if (node.type === 'StringLiteral') return embeddedAffordances(node.value);
  if (node.type === 'TemplateLiteral') return embeddedAffordances(templateText(node));
  return [];
}

function jsxAffordance(node) {
  const tag = jsxTagName(node.openingElement);
  if (LINK_TAGS.has(tag)) {
    const target = classifyTarget(jsxAttr(node.openingElement, ['href', 'to']));
    if (isSkippable(target)) return null;
    return { type: 'link', target, label: jsxLabel(node) };
  }
  if (tag === 'Navigate') {
    const target = classifyTarget(jsxAttr(node.openingElement, ['to', 'href']));
    if (isSkippable(target)) return null;
    return { type: 'redirect', target, label: null };
  }
  return null;
}

function callAffordance(node) {
  const name = calleeName(node);
  if (!name) return null;
  if (NAV_CALLS.has(name)) {
    const target = classifyTarget(node.arguments?.[0]);
    if (isSkippable(target)) return null;
    return { type: 'navigate-call', target, label: null };
  }
  if (MODAL_CALLS.has(name)) {
    const target = classifyTarget(node.arguments?.[0]);
    return { type: 'modal-trigger', target, label: null };
  }
  return null;
}

const EMBED_A_RE = /<a\b[^>]*?\bhref\s*=\s*["']([^"'#][^"']*)["'][^>]*>([^<]*)/gi;
const EMBED_NAV_RE = /\b(?:switchView|setView)\s*\(\s*((?:VIEWS|viewRegistry)\.[A-Za-z0-9_]+|['"][^'"]+['"])/g;

/** Recover affordances embedded in a string/template-literal value (vanilla HTML). */
function embeddedAffordances(text) {
  if (typeof text !== 'string' || (!text.includes('href') && !/switchView|setView/.test(text))) return [];
  const out = [];
  let m;
  EMBED_A_RE.lastIndex = 0;
  while ((m = EMBED_A_RE.exec(text)) !== null) {
    const value = m[1];
    if (EXTERNAL_RE.test(value)) continue;
    // Skip regex-replacement artifacts ($1, $2, $&) — these are markdown/HTML
    // render templates (`<a href="$2">$1</a>`), not real links.
    if (/^\$[\d&]/.test(value)) continue;
    const target = value.includes('${') || value.includes('"+') ? { type: 'template', value: value.replace(/\$\{[^}]*\}/g, '${x}') } : { type: 'literal', value };
    const label = (m[2] || '').replace(/\$\{[^}]*\}/g, '').trim() || null;
    out.push({ type: 'link', target, label });
  }
  EMBED_NAV_RE.lastIndex = 0;
  while ((m = EMBED_NAV_RE.exec(text)) !== null) {
    const arg = m[1];
    const target = /^(?:VIEWS|viewRegistry)\./.test(arg) ? { type: 'member', value: arg } : { type: 'literal', value: arg.replace(/^['"]|['"]$/g, '') };
    out.push({ type: 'navigate-call', target, label: null });
  }
  return out;
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

function isSkippable(target) {
  if (!target) return true;
  if (target.type === 'literal' && (target.value === '' || EXTERNAL_RE.test(target.value))) return true;
  return false;
}

/** Resolve a structured target to canonical id(s) + confidence. */
function resolveTarget(adapters, target, ctx, affordanceType) {
  if (affordanceType === 'modal-trigger') {
    const key = target.type === 'literal' ? target.value : '';
    return { ids: [`${MODAL_PREFIX}${key || '<dynamic>'}`], confidence: key ? 'high' : 'low' };
  }
  if (!target || target.type === 'unknown') return { ids: ['<dynamic>'], confidence: 'low' };

  if (target.type === 'member') {
    const id = resolveWithAdapters(adapters, target.value, ctx);
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

/** Return the ObjectExpression assigned to a VIEWS/viewRegistry binding, or null. */
function viewsObjectOf(node) {
  const NAMES = new Set(['VIEWS', 'viewRegistry']);
  if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && NAMES.has(node.id.name) && node.init?.type === 'ObjectExpression') {
    return node.init;
  }
  if (node.type === 'AssignmentExpression' && node.left?.type === 'Identifier' && NAMES.has(node.left.name) && node.right?.type === 'ObjectExpression') {
    return node.right;
  }
  return null;
}

function basename(p) {
  return p.split('/').pop().replace(/\.[jt]sx?$/, '');
}

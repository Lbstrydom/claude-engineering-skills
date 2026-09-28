/**
 * @fileoverview Adapter: React Router. AST-based discovery (plan §4a.B) with
 * NESTED-ROUTE COMPOSITION (debt-2): a child `<Route path="settings">` under a
 * parent `<Route path="/app">` composes to `/app/settings`, and the same for
 * route-object arrays with `children`. Relative child paths join the parent;
 * absolute child paths (`/x`) stand alone; index routes resolve to the parent.
 *
 * @module scripts/lib/nav/adapters/react-router
 */
import { walk, jsxTagName, jsxAttr, classifyTarget } from '../ast.mjs';
import { normalizeDestination } from '../normalize.mjs';

export const name = 'react-router';

const ROUTING_SIBLINGS = new Set(['element', 'Component', 'component', 'loader', 'action', 'children', 'handle', 'lazy', 'index']);

export function detect(root, parsed) {
  return parsed.some((s) => /react-router(-dom)?/.test(s.content) || /<Route\b/.test(s.content));
}

export function discoverDestinations(parsed) {
  const out = [];
  for (const s of parsed) {
    if (!s.ast) continue;
    collectJsxRoutes(s.ast, null, s.path, out);
    walk(s.ast, (node) => {
      // Top-level route-object arrays / createBrowserRouter([...]) — start a
      // composition from any ObjectExpression that looks like a route AND is not
      // itself nested inside another route's `children` (those are handled by the
      // recursive descent from their parent). We approximate by composing every
      // route object from a null parent; nested children get their parent prefix
      // via collectObjectRoutes, and duplicates are deduped by the model.
      if (node.type === 'ArrayExpression') {
        for (const el of node.elements || []) collectObjectRoute(el, null, s.path, out, /*topLevel*/ true);
      }
    });
  }
  return dedupe(out);
}

/** Recursive descent over JSX <Route> trees, composing parent→child paths. */
function collectJsxRoutes(node, parentPath, file, out) {
  if (!node || typeof node.type !== 'string') return;
  if (node.type === 'JSXElement' && jsxTagName(node.openingElement) === 'Route') {
    const pathAttr = jsxAttr(node.openingElement, 'path');
    // No `path` attr → a pathless layout route (inherits parent). A present-but-
    // dynamic path (`path={VAR}`) is a dynamic SEGMENT (`:param`), NOT a layout.
    const seg = pathAttr == null ? null : segOf(classifyTarget(pathAttr)) ?? ':param';
    const isIndex = !!jsxAttr(node.openingElement, 'index') || seg === '';
    const full = seg == null ? parentPath : joinRoutePath(parentPath, seg);
    const emitPath = isIndex ? (parentPath ?? '/') : full;
    if (emitPath != null && (seg != null || isIndex)) {
      for (const id of normalizeDestination(emitPath).ids) out.push({ id, sourceLoc: file, raw: emitPath });
    }
    for (const child of node.children || []) collectJsxRoutes(child, full ?? parentPath, file, out);
    return;
  }
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end') continue;
    const child = node[key];
    if (Array.isArray(child)) for (const c of child) collectJsxRoutes(c, parentPath, file, out);
    else if (child && typeof child.type === 'string') collectJsxRoutes(child, parentPath, file, out);
  }
}

/** Compose a single route-object literal (and its children array). */
function collectObjectRoute(node, parentPath, file, out, topLevel) {
  if (!node || node.type !== 'ObjectExpression') return;
  const props = new Map();
  for (const p of node.properties || []) {
    if (p.type === 'ObjectProperty' && (p.key?.name || p.key?.value)) props.set(p.key.name ?? p.key.value, p.value);
  }
  // Only treat as a route if it has a routing sibling (avoid arbitrary {path:…} config).
  const isRoute = [...props.keys()].some((k) => ROUTING_SIBLINGS.has(k)) || props.has('path');
  if (!isRoute) return;
  // present-but-dynamic path → dynamic segment (`:param`); absent → layout (null).
  const seg = !props.has('path') ? null
    : (props.get('path')?.type === 'StringLiteral' ? props.get('path').value : ':param');
  const isIndex = props.has('index');
  const full = seg == null ? parentPath : joinRoutePath(parentPath, seg);
  const emitPath = isIndex ? (parentPath ?? '/') : full;
  if (emitPath != null && (seg != null || isIndex) && (topLevel || parentPath != null || seg != null)) {
    for (const id of normalizeDestination(emitPath).ids) out.push({ id, sourceLoc: file, raw: emitPath });
  }
  const children = props.get('children');
  if (children?.type === 'ArrayExpression') {
    for (const el of children.elements || []) collectObjectRoute(el, full ?? parentPath, file, out, false);
  }
}

function segOf(target) {
  if (!target) return null;
  if (target.type === 'literal') return target.value;
  if (target.type === 'template') return target.value;
  return null;
}

/** Join a parent route path with a child segment (React Router v6 semantics). */
function joinRoutePath(parent, seg) {
  if (seg == null) return parent;
  if (seg.startsWith('/')) return seg;                 // absolute child
  if (!parent || parent === '/') return '/' + seg.replace(/^\/+/, '');
  return parent.replace(/\/+$/, '') + '/' + seg.replace(/^\/+/, '');
}

function dedupe(arr) {
  const seen = new Set();
  const out = [];
  for (const d of arr) {
    const k = `${d.id}\x00${d.sourceLoc}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(d);
  }
  return out;
}

export function resolveDestination(raw, ctx = {}) {
  if (typeof raw !== 'string') return null;
  // A member-expression target (`item.path`) is a JS reference, not a path —
  // normalising its spelling would mint a phantom destination named `item.path`.
  // Declining leaves it <dynamic>, the vanilla adapter's policy for `item.view`.
  if (ctx.targetType === 'member') return null;
  const strLit = raw.trim().match(/^['"`]([^'"`]*)['"`]$/);
  const value = strLit ? strLit[1] : raw.trim();
  if (!value) return null;
  return normalizeDestination(value).ids[0] ?? null;
}

/**
 * @fileoverview Adapter: vanilla view-switch apps (e.g. wine-cellar-app's
 * `switchView(VIEWS.X)` + a `VIEWS`/`viewRegistry` map). Discovery-only,
 * AST-based (plan §4a.B).
 *
 * @module scripts/lib/nav/adapters/vanilla-switchview
 */
import { walk } from '../ast.mjs';
import { normalizeDestination } from '../normalize.mjs';

export const name = 'vanilla-switchview';

const VIEW_NAMES = new Set(['VIEWS', 'viewRegistry']);

export function detect(root, parsed) {
  // Require an actual view-switch call (a bare VIEWS map is too weak a signal).
  return parsed.some((s) => /\b(?:switchView|setView)\s*\(/.test(s.content));
}

export function discoverDestinations(parsed) {
  const out = [];
  for (const s of parsed) {
    if (!s.ast) continue;
    walk(s.ast, (node) => {
      const obj = viewsObjectOf(node);
      if (!obj) return;
      for (const prop of obj.properties || []) {
        if (prop.type === 'ObjectProperty' && prop.value?.type === 'StringLiteral') {
          for (const id of normalizeDestination(prop.value.value).ids) {
            out.push({ id, sourceLoc: s.path, raw: prop.value.value });
          }
        }
      }
    });
  }
  return out;
}

function viewsObjectOf(node) {
  if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && VIEW_NAMES.has(node.id.name) && node.init?.type === 'ObjectExpression') return node.init;
  if (node.type === 'AssignmentExpression' && node.left?.type === 'Identifier' && VIEW_NAMES.has(node.left.name) && node.right?.type === 'ObjectExpression') return node.right;
  return null;
}

/** Resolve a navigate-call argument (`VIEWS.WINES`, `'drink-soon'`) to a canonical
 *  id, using the parsed VIEWS map value where available. */
export function resolveDestination(raw, ctx = {}) {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  const viewsMember = v.match(/^(?:VIEWS|viewRegistry)\.([A-Za-z0-9_]+)$/);
  if (viewsMember) {
    const mapped = ctx.viewsMap instanceof Map ? ctx.viewsMap.get(viewsMember[1]) : undefined;
    if (mapped) return normalizeDestination(mapped).ids[0] ?? null;
    return viewsMember[1].toLowerCase().replace(/_/g, '-');
  }
  const strLit = v.match(/^['"]([^'"]+)['"]$/);
  if (strLit) return normalizeDestination(strLit[1]).ids[0] ?? null;
  // A bare value resolves only if it's a plain slug or path — NOT a dotted member
  // access like `item.view` (a computed view, which must stay <dynamic>).
  if (/^[A-Za-z0-9_-]+$/.test(v) || v.startsWith('/')) return normalizeDestination(v).ids[0] ?? null;
  return null;
}

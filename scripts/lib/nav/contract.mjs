/**
 * @fileoverview The two-artifact split's two readers (plan §2.1, §4a.A/G):
 *   - readContract()  — the committed central `nav-contract.json` (product intent)
 *   - parseNavMeta()  — colocated route-owned facts (`export const navMeta`, `@nav` docblock)
 *   - bootstrapContract() — first-run review-queue skeleton (source:inferred)
 *
 * Route-owned facts live in code (cannot drift from the route); product intent
 * lives in the tiny central file. The observed graph is tool-generated elsewhere.
 *
 * Extraction is regex-based, consistent with the repo's other static passes
 * (code-analysis.mjs, quickfix-patterns.mjs, symbol-index) — `@babel/parser` is
 * not a repo dependency and the bundle deliberately avoids heavy parser deps
 * (cf. the mermaid-linter decision in AGENTS.md). Confidence labelling carries
 * the ~80%-recall, hypotheses-not-truth contract (plan §2.5).
 *
 * @module scripts/lib/nav/contract
 */
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from '../file-io.mjs';
import { NavContractSchema, CONTRACT_FILE } from './schema.mjs';
import { normalizeDestination } from './normalize.mjs';
import { lineOf } from './ast-lite.mjs';

/** Known utility/deep-link route shapes auto-classified by bootstrap (plan §2.5).
 *  Matched against the canonical destination id. */
const UTILITY_PATTERNS = [
  /(^|\/)oauth(\/|$)/i,
  /(^|\/)auth(\/|$)/i,
  /(^|\/)callback(\/|$)/i,
  /(^|\/)login(\/|$)/i,
  /(^|\/)logout(\/|$)/i,
  /(^|\/)signin(\/|$)/i,
  /(^|\/)signout(\/|$)/i,
  /(^|\/)reset-password(\/|$)/i,
  /(^|\/)verify-email(\/|$)/i,
  /(^|\/)404(\/|$)/,
  /(^|\/)500(\/|$)/,
  /(^|\/)not-found(\/|$)/i,
];

/** Allowed navMeta fields + their value coercion. Unknown keys are ignored with
 *  a low-confidence note (forward-compatible — plan §4a.A). */
const NAV_META_FIELDS = {
  deepLinkOnly: 'bool',
  utility: 'bool',
  terminal: 'bool',
  navClass: 'string',
  anchor: 'string',
  abVariant: 'string',
  roleGated: 'list',
};

/**
 * Read + validate the committed nav-contract.json.
 * @param {string} root
 * @returns {{contract: object|null, present: boolean, error: string|null}}
 */
export function readContract(root) {
  const file = path.join(root, CONTRACT_FILE);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') return { contract: null, present: false, error: null };
    return { contract: null, present: false, error: `contract unreadable: ${err.message}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { contract: null, present: true, error: `contract malformed JSON: ${err.message}` };
  }
  const result = NavContractSchema.safeParse(parsed);
  if (!result.success) {
    return { contract: null, present: true, error: `contract failed schema: ${result.error.issues[0]?.message ?? 'invalid'}` };
  }
  // Canonicalize human-authored intent destinations to the SAME id space the
  // extractor produces (audit M15) — so a contract `/projects/[id]` matches an
  // observed `/projects/:param`. Anchors are identity strings, left untouched.
  for (const p of result.data.personas) {
    for (const i of p.intents) i.destination = normalizeDestination(i.destination).ids[0] ?? i.destination;
  }
  return { contract: result.data, present: true, error: null };
}

/**
 * Is a destination id one of the known utility/deep-link shapes?
 * @param {string} destinationId
 * @returns {boolean}
 */
export function isUtilityRoute(destinationId) {
  if (typeof destinationId !== 'string') return false;
  return UTILITY_PATTERNS.some((re) => re.test(destinationId));
}

/**
 * Extract colocated nav metadata claims from a source string. Two forms:
 *   1. `export const navMeta = { … }`            → module-scope claim
 *   2. `/** @nav deepLinkOnly navClass=primary *\/` → docblock claim
 *
 * Binding (plan §4a.G) is resolved by the model, not here — we return claims with
 * their scope so the model can attach/disambiguate against discovered destinations.
 *
 * @param {string} source
 * @param {string} filePath - for sourceLoc
 * @returns {Array<{fields: object, unknownKeys: string[], scope: 'module'|'docblock', sourceLoc: string}>}
 */
export function parseNavMeta(source, filePath) {
  if (typeof source !== 'string' || !source.includes('navMeta') && !/@nav\b/.test(source)) return [];
  const claims = [];

  // Form 1 — export const navMeta[: Type] = { ... }  (optional TS type annotation, audit M9)
  const objRe = /export\s+const\s+navMeta\s*(?::\s*[A-Za-z0-9_.<>[\] |]+)?\s*=\s*\{([\s\S]*?)\}/g;
  let m;
  while ((m = objRe.exec(source)) !== null) {
    const line = lineOf(source, m.index);
    const { fields, unknownKeys } = parseObjectBody(m[1]);
    claims.push({ fields, unknownKeys, scope: 'module', sourceLoc: `${filePath}:${line}` });
  }

  // Form 2 — /** @nav key[=value] key2 ... */
  const docRe = /@nav\b([^\n*]*)/g;
  while ((m = docRe.exec(source)) !== null) {
    const line = lineOf(source, m.index);
    const { fields, unknownKeys } = parseDocblockTokens(m[1]);
    claims.push({ fields, unknownKeys, scope: 'docblock', sourceLoc: `${filePath}:${line}` });
  }
  return claims;
}

/** Parse the body of a `navMeta = { ... }` literal — a constrained key:value scan
 *  (no JS eval, no parser dep). Handles booleans, single/double-quoted strings,
 *  and string-array literals. */
function parseObjectBody(body) {
  const fields = {};
  const unknownKeys = [];
  // key: <value> pairs, value ends at comma/newline/closing
  const pairRe = /([A-Za-z_$][\w$]*)\s*:\s*(\[[^\]]*\]|true|false|'[^']*'|"[^"]*")/g;
  let p;
  while ((p = pairRe.exec(body)) !== null) {
    const key = p[1];
    const rawVal = p[2].trim();
    if (!(key in NAV_META_FIELDS)) { unknownKeys.push(key); continue; }
    fields[key] = coerce(NAV_META_FIELDS[key], rawVal);
  }
  return { fields, unknownKeys };
}

/** Parse docblock tokens: `deepLinkOnly navClass=primary roleGated=admin,owner` */
function parseDocblockTokens(text) {
  const fields = {};
  const unknownKeys = [];
  for (const tok of text.trim().split(/\s+/).filter(Boolean)) {
    const [key, val] = tok.split('=');
    if (!(key in NAV_META_FIELDS)) { unknownKeys.push(key); continue; }
    const type = NAV_META_FIELDS[key];
    if (type === 'bool') fields[key] = val === undefined ? true : val === 'true';
    else if (type === 'list') fields[key] = (val ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else fields[key] = val ?? '';
  }
  return { fields, unknownKeys };
}

function coerce(type, rawVal) {
  if (type === 'bool') return rawVal === 'true';
  if (type === 'list') {
    return rawVal
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
  }
  // string
  return rawVal.replace(/^['"]|['"]$/g, '');
}

/**
 * Build a first-run review-queue contract skeleton (plan §2.5). Every inferred
 * entry is marked `source:inferred` so CI gives it lower authority until a human
 * confirms — never a trusted baseline.
 *
 * @param {object} args
 * @param {string[]} [args.destinations] - discovered destination ids (for utility hints)
 * @param {Array<{personaId: string, intentId: string, destination: string}>} [args.personaIntents]
 *        - optional seeds from the persona registry
 * @param {string[]} [args.appRoots]
 * @returns {object} a NavContract (all intents source:inferred)
 */
export function bootstrapContract({ destinations = [], personaIntents = [], appRoots = [] } = {}) {
  const personas = new Map();
  for (const seed of personaIntents) {
    if (!personas.has(seed.personaId)) personas.set(seed.personaId, { id: seed.personaId, intents: [] });
    personas.get(seed.personaId).intents.push({
      id: seed.intentId,
      destination: seed.destination,
      approvedAnchors: [],
      requiredInLayer: null,
      frequency: 'normal',
      source: 'inferred',
    });
  }
  const contract = {
    version: 1,
    ...(appRoots.length ? { appRoots } : {}),
    navLayers: {},
    personas: [...personas.values()],
  };
  // Attach an inferred-utility hint list as a side artifact for the human review
  // queue (NOT part of the validated contract — these belong in code navMeta).
  const inferredUtility = destinations.filter(isUtilityRoute);
  return { contract, inferredUtility };
}

/**
 * Persist a bootstrap skeleton for human review.
 * @param {string} root
 * @param {object} contract
 * @returns {string} path written
 */
export function writeContract(root, contract) {
  const result = NavContractSchema.safeParse(contract);
  if (!result.success) {
    throw new Error(`refusing to write invalid nav-contract: ${result.error.issues[0]?.message ?? 'invalid'}`);
  }
  const file = path.join(root, CONTRACT_FILE);
  atomicWriteFileSync(file, JSON.stringify(result.data, null, 2));
  return file;
}

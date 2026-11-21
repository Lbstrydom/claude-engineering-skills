/**
 * @fileoverview Pure classifier: how did a PR change the files that DEFINE the gates which judge it?
 * (the verification-lessons plan, section 2.2, "Classifier precedence".) No I/O - callers inject readers over a base and a head.
 *
 * Verdicts, worst first: `loosening > unknown > tightening > unchanged`. A file verdict is the worst of its per-entry
 * verdicts, the PR verdict is the worst over files. `unknown` is TREATED AS loosening by every consumer (the owner rule):
 * a change the classifier cannot read is not a change it may wave through.
 *
 * @module scripts/lib/gate-provenance/classify
 */
import { canonicalizeEol } from '../file-io.mjs';
import { REGISTRY_PATH, matchEntry, parseRegistry } from './registry.mjs';

/** Bump when a rule below changes meaning; stamped on every report so a verdict names the rules that produced it. */
export const GATE_DIFF_CONTRACT_VERSION = 1;

/** Ascending severity. */
export const VERDICT_ORDER = Object.freeze(['unchanged', 'tightening', 'unknown', 'loosening']);
export const worstOf = (a, b) => (VERDICT_ORDER.indexOf(a) >= VERDICT_ORDER.indexOf(b) ? a : b);
/** A verdict a PR may not carry without the loosening authorization. */
export const needsAuthorization = (v) => v === 'loosening' || v === 'unknown';

/** Contract fields whose change (on an existing gate) is a weakening. */
const CONTRACT_WEAKENING_FIELDS = ['expectExit', 'oracle', 'implementation', 'poisonPill', 'stated'];

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Accumulates the worst verdict and the reasons that produced anything other than `unchanged`. */
function tally() {
  let verdict = 'unchanged';
  const reasons = [];
  return {
    add(v, why) { verdict = worstOf(verdict, v); reasons.push(`${v}: ${why}`); },
    get verdict() { return verdict; },
    reasons,
  };
}

/**
 * Flatten JSON into `Map<key, {num: boolean, value}>`. Objects recurse by path; every array ELEMENT is its own entry keyed by
 * its JSON identity (an array is a set of entries, so adding or dropping one is visible and reordering is not). Top-level
 * documentation fields (`_description`, `$comment`, ...) are skipped: rewording prose is not a gate change.
 */
function flatten(doc) {
  const out = new Map();
  const walk = (v, prefix, depth) => {
    if (Array.isArray(v)) {
      for (const el of v) out.set(`${prefix}[]=${JSON.stringify(el)}`, { num: false, value: true });
    } else if (isObj(v)) {
      for (const [k, x] of Object.entries(v)) {
        if (depth === 0 && (k.startsWith('_') || k.startsWith('$'))) continue;
        walk(x, `${prefix}/${k}`, depth + 1);
      }
    } else out.set(prefix || '/', { num: typeof v === 'number', value: v });
  };
  walk(doc, '', 0);
  return out;
}

function diffEntries(base, head, t, { removed, added, changed, removedFor = () => removed }) {
  const b = flatten(base);
  const h = flatten(head);
  for (const [k, bv] of b) {
    const hv = h.get(k);
    if (!hv) { t.add(removedFor(k), `entry removed: ${k}`); continue; }
    if (bv.num && hv.num) {
      if (hv.value > bv.value) t.add('loosening', `cap raised ${bv.value} -> ${hv.value}: ${k}`);
      else if (hv.value < bv.value) t.add('tightening', `cap lowered ${bv.value} -> ${hv.value}: ${k}`);
    } else if (!same(bv.value, hv.value)) {
      t.add(changed, `value changed: ${k}`);
    }
  }
  for (const k of h.keys()) if (!b.has(k)) t.add(added, `entry added: ${k}`);
}

/**
 * `numeric-cap`: a raised cap and an added entry (a new allowance) loosen. A removed entry under one of the entry's
 * `allowanceKeys` is a per-site exception going away, so the default cap applies again: tightening. Any other removed
 * entry loosens (an uncapped value is a raised cap).
 */
const classifyNumericCap = (base, head, t, entry = {}) => {
  const allow = (entry.allowanceKeys || []).map((k) => `/${k}`);
  const isAllowance = (k) => allow.some((p) => k === p || k.startsWith(`${p}/`) || k.startsWith(`${p}[]=`));
  diffEntries(base, head, t, { removed: 'loosening', added: 'loosening', changed: 'unknown', removedFor: (k) => (isAllowance(k) ? 'tightening' : 'loosening') });
};

/** `set-of-allowances`: removing an allowance tightens, adding one loosens; numeric leaves inside it are still caps. */
const classifyAllowances = (base, head, t) => diffEntries(base, head, t, { removed: 'tightening', added: 'loosening', changed: 'loosening' });

function classifyContractSet(base, head, t) {
  if (!isObj(base) || !isObj(head) || !Array.isArray(base.gates) || !Array.isArray(head.gates)) {
    t.add('unknown', 'not a contract-set document (no gates array)');
    return;
  }
  for (const k of new Set([...Object.keys(base), ...Object.keys(head)])) {
    if (k !== 'gates' && !same(base[k], head[k])) t.add('unknown', `top-level field changed: ${k}`);
  }
  const keyed = (doc) => new Map(doc.gates.map((g, i) => [isObj(g) && typeof g.id === 'string' ? g.id : `#${i}`, g]));
  const bg = keyed(base);
  const hg = keyed(head);
  for (const [id, b] of bg) {
    const h = hg.get(id);
    if (!h) { t.add('loosening', `gate removed: ${id}`); continue; }
    for (const f of new Set([...Object.keys(b), ...Object.keys(h)])) {
      if (same(b[f], h[f])) continue;
      if (f === 'tests') {
        const bt = new Set(Array.isArray(b.tests) ? b.tests : []);
        const ht = new Set(Array.isArray(h.tests) ? h.tests : []);
        for (const x of bt) if (!ht.has(x)) t.add('loosening', `gate ${id}: test dropped: ${x}`);
        for (const x of ht) if (!bt.has(x)) t.add('tightening', `gate ${id}: test added: ${x}`);
      } else if (CONTRACT_WEAKENING_FIELDS.includes(f)) t.add('loosening', `gate ${id}: ${f} changed`);
      else t.add('unknown', `gate ${id}: field changed: ${f}`);
    }
  }
  for (const id of hg.keys()) if (!bg.has(id)) t.add('tightening', `gate added: ${id}`);
}

/** A change to `.gate-files.json` itself: the registry defines what is judged, so shrinking it is the loosest move there is. */
function classifyRegistryChange(baseText, headText, t) {
  const b = parseRegistry(baseText);
  const h = parseRegistry(headText);
  if (!b.ok || !h.ok) {
    t.add('unknown', `registry fails to parse (base: ${b.ok ? 'ok' : b.error}; head: ${h.ok ? 'ok' : h.error})`);
    return;
  }
  const files = (r) => new Map(r.registry.files.map((e) => [e.path, e]));
  const bf = files(b);
  const hf = files(h);
  for (const [p, e] of bf) {
    const x = hf.get(p);
    if (!x) t.add('loosening', `registry entry removed: ${p}`);
    else if (x.kind !== e.kind) t.add('loosening', `registry classifier changed: ${p} ${e.kind} -> ${x.kind}`);
    else {
      // Every behavior-affecting field: the WHOLE entry minus the free-text note, so a field added later is never ignored.
      const strip = (v) => ({ ...v, note: undefined });
      if (!same(strip(x), strip(e))) {
        const keys = new Set([...Object.keys(x), ...Object.keys(e)].filter((k) => k !== 'note' && k !== 'kind' && !same(x[k], e[k])));
        const known = [...keys].every((k) => k === 'knownFields' || k === 'allowanceKeys');
        t.add(known ? 'loosening' : 'unknown', `registry entry changed (${[...keys].join(', ')}): ${p}`);
      }
    }
  }
  for (const p of hf.keys()) if (!bf.has(p)) t.add('tightening', `registry entry added: ${p}`);
  const gates = (r) => new Map(r.registry.gates.map((g) => [g.id, g]));
  const bg = gates(b);
  const hg = gates(h);
  for (const [id, g] of bg) {
    const x = hg.get(id);
    if (!x) t.add('loosening', `registry gate removed: ${id}`);
    else if (!same(x.argv, g.argv)) t.add('loosening', `registry gate argv changed: ${id}`);
  }
  for (const id of hg.keys()) if (!bg.has(id)) t.add('tightening', `registry gate added: ${id}`);
}

function parseJson(text) {
  try { return { ok: true, doc: JSON.parse(text) }; } catch (e) { return { ok: false, error: e.message }; }
}

const norm = (s) => (s == null ? null : canonicalizeEol(Buffer.from(s)).toString());

/**
 * Classify one path. `entry` is the registry entry that governs it.
 * @returns {{verdict: string, reasons: string[]}}
 */
export function classifyFile({ path, entry, baseText, headText }) {
  const t = tally();
  const out = () => ({ verdict: t.verdict, reasons: [...new Set(t.reasons)] });
  const b = norm(baseText);
  const h = norm(headText);
  if (b === h) return { verdict: 'unchanged', reasons: [] };
  if (path === REGISTRY_PATH) { classifyRegistryChange(b, h, t); return out(); }
  // Fixed rows, before any kind-specific rule.
  if (h === null) { t.add('loosening', 'file deleted'); return out(); }
  if (b === null) {
    if (entry.kind === 'contract-set') {
      const p = parseJson(h);
      if (p.ok) t.add('tightening', 'new contract file');
      else t.add('unknown', `new contract file fails to parse: ${p.error}`);
    } else t.add('unknown', `file added to a registered path (${entry.kind})`);
    return out();
  }
  if (entry.kind === 'opaque') { t.add('unknown', 'opaque file changed'); return out(); }
  const pb = parseJson(b);
  const ph = parseJson(h);
  if (!pb.ok || !ph.ok) {
    t.add('unknown', `fails to parse (base: ${pb.ok ? 'ok' : pb.error}; head: ${ph.ok ? 'ok' : ph.error})`);
    return out();
  }
  if (entry.knownFields) {
    const known = new Set(entry.knownFields);
    for (const doc of [pb.doc, ph.doc]) {
      if (!isObj(doc)) continue;
      for (const k of Object.keys(doc)) if (!known.has(k)) t.add('unknown', `unknown top-level field: ${k}`);
    }
    if (t.verdict === 'unknown') return out();
  }
  const rules = { 'numeric-cap': classifyNumericCap, 'set-of-allowances': classifyAllowances, 'contract-set': classifyContractSet };
  rules[entry.kind](pb.doc, ph.doc, t, entry);
  return out();
}

/**
 * Classify a base -> head change over every registered path.
 *
 * Which paths count is decided by the BASE registry first (a PR cannot shrink the registry to escape it) and the head
 * registry for paths only the head registers (an added entry).
 *
 * @param {object} args
 * @param {object|null} args.baseRegistry parsed registry at the base (null = absent or unparseable)
 * @param {object|null} args.headRegistry parsed registry at the head
 * @param {Iterable<string>} args.baseFiles tracked paths at the base
 * @param {Iterable<string>} args.headFiles tracked paths at the head
 * @param {(p: string) => string|null} args.readBase content at the base, null when absent
 * @param {(p: string) => string|null} args.readHead content at the head, null when absent
 * @param {Set<string>} [args.protectedPaths] the shared protected set (registry + closure + spawned helpers)
 */
export function classifyGateDiff({ baseRegistry, headRegistry, baseFiles, headFiles, readBase, readHead, protectedPaths = new Set() }) {
  const files = [];
  let verdict = 'unchanged';
  const universe = new Set([...baseFiles, ...headFiles, REGISTRY_PATH]);
  for (const path of [...universe].sort()) {
    // An UNREGISTERED module the gates import or spawn is still code the verdict rests on: opaque, so unknown, so loosening.
    const entry = matchEntry(baseRegistry, path) ?? matchEntry(headRegistry, path) ?? (protectedPaths.has(path) ? { path, kind: "opaque" } : null);
    if (!entry && path !== REGISTRY_PATH) continue;
    const r = classifyFile({ path, entry, baseText: readBase(path), headText: readHead(path) });
    if (r.verdict === 'unchanged') continue;
    files.push({ path, kind: entry?.kind ?? 'registry', verdict: r.verdict, reasons: r.reasons });
    verdict = worstOf(verdict, r.verdict);
  }
  return { contractVersion: GATE_DIFF_CONTRACT_VERSION, verdict, files };
}

/**
 * @fileoverview The population line: what a cross-store verdict was measured FROM,
 * and what it was not.
 *
 * A verdict computed from N stores reads as a verdict about everyone. Some consumers
 * are not measured here and never can be (their store is private by policy), and some
 * report a figure by hand. This module is the ONE producer of the line that says so:
 *
 *   Population: measured from 2 stores — d5a9d07b (ces, wine), 3f2a91c0 (sto). Not measured: orgx
 *   (unreachable-by-policy); aio (store-unreachable). Consumer-reported, unverified (not pooled):
 *   orgx — "dispute rate 0.6%" (2026-11-20, by-hand).
 *
 * The canonical form is the versioned object (`population/v1`); the line is its
 * rendering, and `parsePopulationLine` is the inverse, so the grammar has one
 * definition that the writers, the tests and the research-doc check all share.
 *
 * Labels are registry ALIASES and 8-hex store fingerprint prefixes — never repo names
 * or hostnames: the line is pasted into public `docs/research/`.
 *
 * Pooling is forbidden by construction: the object has no field that sums across
 * `measured` and `consumerReported`, and the renderer never adds a reported claim to a
 * store count. Every field is validated and REFUSED when out of bounds, never truncated
 * or escaped into ambiguity.
 *
 * Pure. Must not import lib/db or lib/store (this is shared-lib); discovery is injected.
 *
 * @module scripts/lib/population
 */
import path from 'node:path';
import { scanForLeaks } from './telemetry-export/redact.mjs';

export const POPULATION_SCHEMA = 'population/v1';

export const NOT_MEASURED_REASONS = Object.freeze([
  'unreachable-by-policy', 'policy-undeterminable', 'shared-with-policy-consumer',
  'store-unreachable', 'no-store', 'not-in-scope',
]);
const VIA = Object.freeze(['by-hand', 'telemetry-export']);
const SCOPES = Object.freeze(['store', 'repo']);

const ALIAS_RE = /^[a-z0-9-]{1,32}$/;
const FULL_FINGERPRINT_RE = /^[0-9a-f]{16}$/;
const STORE_RE = /^[0-9a-f]{8}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const MAX_CLAIM = 200;
const MAX_LIST = 64;
const MAX_REPORTED = 32;

/**
 * CLIs that print a cross-store verdict and therefore MUST print the population line
 * (and carry `population` in their JSON). `tests/population-writers.test.mjs` iterates
 * this registry; its census reads the filesystem for a writer no list mentions.
 */
export const STORE_VERDICT_WRITERS = Object.freeze([
  { file: 'scripts/tiered-shadow-report.mjs', reason: 'shadow-window verdict over cloud observations filtered to repo ids' },
  { file: 'scripts/bakeoff-collect.mjs', reason: 'final-review shadow bake-off window progress' },
  { file: 'scripts/model-eval-adjudicator.mjs', reason: 'model-swap verdict scored against the store ground truth for one repo' },
  { file: 'scripts/own-model-coverage.mjs', reason: 'coverage floors measured over a store-wide window' },
  { file: 'scripts/upstream-queues.mjs', reason: 'open upstream reports fanned out over every reachable store' },
  { file: 'scripts/store-drift.mjs', reason: 'migration drift fanned out over every reachable store' },
]);

/**
 * Store-reading CLIs the census flags that do not print a cross-store population verdict, each with the reason.
 * A single-store report gets the line when it starts making cross-store claims (plan policy-private-consumer-stores §8).
 */
export const EXEMPT_STORE_CLIS = Object.freeze([
  { file: 'scripts/model-eval-auditor.mjs', reason: 'writes eval-run rows but scores a committed corpus, not a store population' },
  { file: 'scripts/audit-convergence.mjs', reason: 'single-store report of review rounds per repo; no cross-store claim (deferred, plan section 8)' },
  { file: 'scripts/cache-hitrate-check.mjs', reason: 'single-store cache-hit cohort check for this repo; no cross-store claim (deferred, plan section 8)' },
  { file: 'scripts/campaign.mjs', reason: 'campaign verdict over one cohort row-set in the ambient store, adjudicated by the operator; not a consumer population' },
  { file: 'scripts/check-setup.mjs', reason: 'setup health check of this machine and its own store; reports readiness, not a population verdict' },
  { file: 'scripts/check-sync.mjs', reason: 'reports whether this repo syncs to its own store; a connection status, not a population verdict' },
  { file: 'scripts/check-windowed-views.mjs', reason: 'static gate over view declarations in the source tree; reads no consumer population' },
  { file: 'scripts/gemini-review.mjs', reason: 'verdict on a code diff by a reviewer model; the store is only written to, never a measured population' },
  { file: 'scripts/memory-health.mjs', reason: 'single-store weekly gate over this repo store RPC; consumer-side, no cross-store claim (deferred, plan section 8)' },
  { file: 'scripts/memory-pgvector-prototype.mjs', reason: 'prototype report over this repo open findings in one store; no cross-store claim' },
  { file: 'scripts/meta-assess.mjs', reason: 'per-repo meta-assessment of audit runs in one store; no cross-store claim (deferred, plan section 8)' },
  { file: 'scripts/remediation-reconcile.mjs', reason: 'out-of-band writer that reconciles remediation state; its "verdict" is a finding verdict, not a population statement' },
  { file: 'scripts/semantic-suppress.mjs', reason: 'retrospective reconciler that writes suppression rows for this repo; reports a coverage window of its own run, not a population' },
  { file: 'scripts/capture-completeness.mjs', reason: 'capture completeness over this store (the ambient one) for one window; reconciles lifecycle starts against completions and reports no cross-store claim' },
  { file: 'scripts/ship-commit.mjs', reason: 'commit provenance gate; "verdict" is the gate outcome for one commit, store used only for schema realization' },
  { file: 'scripts/ship-train.mjs', reason: 'ship-train base-pinning verdict for a set of PRs; no store population is measured' },
  { file: 'scripts/slice-recurrence-check.mjs', reason: 'one-shot recurrence check over this repo rows for one file; no cross-store claim' },
  { file: 'scripts/step-back-replay.mjs', reason: 'single-store research harness over this repo own audit rows (a read-only export); its verdict is published in docs/research with its population line, no cross-store claim' },
]);

function fail(msg) { throw new TypeError(`population: ${msg}`); }

function checkAlias(a, what) {
  if (typeof a !== 'string' || !ALIAS_RE.test(a)) fail(`${what} must match [a-z0-9-]{1,32}`);
  return a;
}

function checkList(v, what, max) {
  if (!Array.isArray(v)) fail(`${what} must be an array`);
  if (v.length > max) fail(`${what} has more than ${max} entries`);
  return v;
}

function checkClaim(claim) {
  if (typeof claim !== 'string' || claim.length === 0) fail('claim must be a non-empty string');
  if (claim.length > MAX_CLAIM) fail(`claim is longer than ${MAX_CLAIM} characters`);
  if (claim !== claim.trim()) fail('claim must not have leading or trailing whitespace');
  if (CONTROL.test(claim)) fail('claim contains control characters');
  if (claim.includes(';') || claim.includes('"')) fail('claim must not contain ";" or \'"\' (the line\'s delimiters)');
  const leak = scanForLeaks(claim, { prose: true });
  if (!leak.clean) fail(`claim matched the leak scan (${leak.categories.join(', ')})`);
  return claim;
}

function checkDate(d) {
  if (typeof d !== 'string' || !DATE_RE.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`))
    || new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) !== d) fail('receivedAt must be an ISO date (YYYY-MM-DD)');
  return d;
}

/**
 * Validate and freeze a `population/v1` object. Refuses, never repairs.
 *
 * @param {object} input
 * @param {Array<{store: string, scope: 'store'|'repo', consumers?: string[]}>} [input.measured]
 * @param {Array<{alias: string, reason: string}>} [input.notMeasured]
 * @param {boolean} [input.unknownBeyond] true when the population outside `measured` is not known here
 * @param {Array<{alias: string, claim: string, receivedAt: string, via: string}>} [input.consumerReported]
 * @returns {Readonly<{schema: string, measured: object[], notMeasured: object[], unknownBeyond: boolean, consumerReported: object[]}>}
 */
export function buildPopulation({ measured = [], notMeasured = [], unknownBeyond = false, consumerReported = [] } = {}) {
  if (typeof unknownBeyond !== 'boolean') fail('unknownBeyond must be a boolean');
  const measuredAliases = new Set();
  const m = checkList(measured, 'measured', MAX_LIST).map((e, i) => {
    if (!e || typeof e !== 'object') fail(`measured[${i}] must be an object`);
    if (typeof e.store !== 'string' || !STORE_RE.test(e.store)) fail(`measured[${i}].store must be 8 lowercase hex characters`);
    if (!SCOPES.includes(e.scope)) fail(`measured[${i}].scope must be one of ${SCOPES.join(', ')}`);
    // The 8-hex id is a DISPLAY id: two distinct stores may share it, and are never merged here.
    const consumers = checkList(e.consumers ?? [], `measured[${i}].consumers`, MAX_LIST).map((a) => checkAlias(a, `measured[${i}].consumers[]`));
    if (new Set(consumers).size !== consumers.length) fail(`measured[${i}].consumers has a duplicate alias`);
    for (const a of consumers) measuredAliases.add(a);
    return Object.freeze({ store: e.store, scope: e.scope, consumers: Object.freeze(consumers) });
  });
  const seenNm = new Set();
  const nm = checkList(notMeasured, 'notMeasured', MAX_LIST).map((e, i) => {
    checkAlias(e?.alias, `notMeasured[${i}].alias`);
    if (!NOT_MEASURED_REASONS.includes(e.reason)) fail(`notMeasured[${i}].reason must be one of ${NOT_MEASURED_REASONS.join(', ')}`);
    if (seenNm.has(e.alias)) fail(`notMeasured lists "${e.alias}" twice`);
    if (measuredAliases.has(e.alias)) fail(`"${e.alias}" is both measured and not measured`);
    seenNm.add(e.alias);
    return Object.freeze({ alias: e.alias, reason: e.reason });
  });
  // The same alias MAY appear here and in `measured` (two independent pieces of evidence); they are never summed.
  const cr = checkList(consumerReported, 'consumerReported', MAX_REPORTED).map((e, i) => {
    checkAlias(e?.alias, `consumerReported[${i}].alias`);
    if (!VIA.includes(e.via)) fail(`consumerReported[${i}].via must be one of ${VIA.join(', ')}`);
    return Object.freeze({ alias: e.alias, claim: checkClaim(e.claim), receivedAt: checkDate(e.receivedAt), via: e.via });
  });
  return Object.freeze({
    schema: POPULATION_SCHEMA,
    measured: Object.freeze(m),
    notMeasured: Object.freeze(nm),
    unknownBeyond,
    consumerReported: Object.freeze(cr),
  });
}

const NOT_KNOWN = 'consumers not known here';
/** Scope label for a read of THIS repo's own rows, whose registry alias is not a claim anyone else can check. */
const SELF_ALIAS = 'self';
/** The name discovery gives this repo (it has no registry alias). */
const SELF_REPO_NAME = 'this repo';

function renderMeasuredItem(e) {
  const who = e.consumers.length > 0 ? e.consumers.join(', ') : NOT_KNOWN;
  return e.scope === 'repo' ? `${e.store} repo-scoped (${who})` : `${e.store} (${who})`;
}

/**
 * Render the line. PURE; the inverse of `parsePopulationLine`.
 *
 * @param {ReturnType<typeof buildPopulation>} pop
 * @returns {string}
 */
export function renderPopulationLine(pop) {
  const n = pop.measured.length;
  let line = `Population: measured from ${n} store${n === 1 ? '' : 's'}`;
  if (n > 0) line += ` — ${pop.measured.map(renderMeasuredItem).join(', ')}`;
  if (pop.notMeasured.length > 0) line += `. Not measured: ${pop.notMeasured.map((e) => `${e.alias} (${e.reason})`).join('; ')}`;
  if (pop.unknownBeyond) line += '. other consumers: not known here';
  if (pop.consumerReported.length > 0) {
    line += `. Consumer-reported, unverified (not pooled): ${pop.consumerReported
      .map((e) => `${e.alias} — "${e.claim}" (${e.receivedAt}, ${e.via})`).join('; ')}`;
  }
  return `${line}.`;
}

const MEASURED_ITEM = /([0-9a-f]{8}) (repo-scoped )?\((consumers not known here|[a-z0-9-]{1,32}(?:, [a-z0-9-]{1,32})*)\)/y;
const NM_ITEM = /([a-z0-9-]{1,32}) \(([a-z-]+)\)/y;
const CR_ITEM = /([a-z0-9-]{1,32}) — "([^";]{1,200})" \((\d{4}-\d{2}-\d{2}), ([a-z-]+)\)/y;

function sticky(re, text, pos) {
  re.lastIndex = pos;
  const m = re.exec(text);
  return m && m.index === pos ? m : null;
}

/**
 * Read a population line back to its object. `null` when the text is not a population
 * line (or does not validate). Searches the text line by line, so a document may embed it, but a candidate
 * line must be consumed ENTIRELY (surrounding whitespace aside): trailing or leading content gives null.
 *
 * @param {string} text
 * @returns {ReturnType<typeof buildPopulation>|null}
 */
export function parsePopulationLine(text) {
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    // The WHOLE line must be the population line: only surrounding whitespace (an indent) is tolerated, so
    // text before or after it is refused rather than half-read.
    const line = raw.trim();
    if (!line.startsWith('Population: measured from ')) continue;
    const pop = parseOne(line);
    if (pop) return pop;
  }
  return null;
}

function parseOne(line) {
  const head = /^Population: measured from (\d+) stores?/.exec(line);
  if (!head) return null;
  let pos = head[0].length;
  const count = Number(head[1]);
  const eat = (s) => { if (line.startsWith(s, pos)) { pos += s.length; return true; } return false; };
  const measured = [];
  if (count > 0) {
    if (!eat(' — ')) return null;
    for (let i = 0; i < count; i += 1) {
      if (i > 0 && !eat(', ')) return null;
      const m = sticky(MEASURED_ITEM, line, pos);
      if (!m) return null;
      pos += m[0].length;
      measured.push({
        store: m[1], scope: m[2] ? 'repo' : 'store',
        consumers: m[3] === NOT_KNOWN ? [] : m[3].split(', '),
      });
    }
  }
  const notMeasured = [];
  if (eat('. Not measured: ')) {
    for (let first = true; ; first = false) {
      if (!first && !eat('; ')) break;
      const m = sticky(NM_ITEM, line, pos);
      if (!m) return null;
      pos += m[0].length;
      notMeasured.push({ alias: m[1], reason: m[2] });
    }
  }
  const unknownBeyond = eat('. other consumers: not known here');
  const consumerReported = [];
  if (eat('. Consumer-reported, unverified (not pooled): ')) {
    for (let first = true; ; first = false) {
      if (!first && !eat('; ')) break;
      const m = sticky(CR_ITEM, line, pos);
      if (!m) return null;
      pos += m[0].length;
      consumerReported.push({ alias: m[1], claim: m[2], receivedAt: m[3], via: m[4] });
    }
  }
  if (!eat('.') || pos !== line.length) return null;
  try {
    return buildPopulation({ measured, notMeasured, unknownBeyond, consumerReported });
  } catch {
    return null;
  }
}

/**
 * Build the population for a verdict from what the writer actually READ.
 *
 * `fingerprint` and `scope` are provenance from the query, not from the render:
 *  - `'store'`           the query had no repo predicate: every consumer on that store is in the population;
 *  - `{repo: '<alias>'}` it filtered to one consumer's repo; store-mates are listed `not-in-scope`, never claimed;
 *  - `{repo: null}`      it filtered to repo(s) whose consumer identity is not known: nothing is claimed.
 *
 * `registry` + `discover` are injected so this stays pure. Where the registry is unavailable (a
 * consumer: its private half is absent) `notMeasured` is empty and `unknownBeyond` is true.
 *
 * @param {object} input
 * @param {string|null} input.fingerprint the store read (any length >= 8; only the first 8 hex are kept), or null
 * @param {'store'|{repo: string|null}} [input.scope]
 * @param {ReadonlyArray<object>|null} [input.registry]
 * @param {((registry: ReadonlyArray<object>) => {stores: Array<{fingerprint: string, aliases?: string[]}>,
 *   unresolved: Array<{repo: string}>, policyUnreachable: Array<{alias: string|null, repo: string, reason: string}>})|null} [input.discover]
 * @param {Array<object>} [input.consumerReported]
 * @returns {ReturnType<typeof buildPopulation>}
 */
export function resolvePopulation({ fingerprint, scope = 'store', registry = null, discover = null, consumerReported = [], answered = true, warn = defaultWarn }) {
  // Matching is on the FULL fingerprint; only the display field `store` is shortened to 8 hex.
  // ONLY the exact format `storeFingerprint` produces (16 lowercase hex) is a store; anything else is an unknown store.
  const full = typeof fingerprint === 'string' && FULL_FINGERPRINT_RE.test(fingerprint) ? fingerprint : null;
  const fp = full ? full.slice(0, 8) : null;
  const repoScoped = scope !== 'store';
  // `{repo: alias}` is one registry consumer; `{repos: [labels]}` is a set of repos whose consumer identity is not a
  // registry claim (labels are not aliases); both are repo-scoped.
  const scopedAliases = repoScoped ? (Array.isArray(scope?.repos) ? scope.repos : (scope?.repo ? [scope.repo] : [])) : [];
  const scopedAlias = scopedAliases.length === 1 && !Array.isArray(scope?.repos) ? scopedAliases[0] : null;
  const scopeKind = repoScoped ? 'repo' : 'store';
  // This repo's own rows (`self`) or an unknown identity: no registry claim can be made about store-mates.
  const identityKnown = !repoScoped || (scopedAlias !== null && scopedAlias !== SELF_ALIAS);
  const scopeConsumers = scopedAliases;
  const unanswered = () => [{ alias: fp, reason: 'store-unreachable' }];
  const withoutRegistry = () => buildPopulation({
    measured: fp && answered ? [{ store: fp, scope: scopeKind, consumers: scopeConsumers }] : [],
    // A store that did not answer is named by its fingerprint label (a valid alias token) when no consumer is known.
    notMeasured: fp && !answered ? unanswered() : [],
    unknownBeyond: true, consumerReported,
  });
  // No store was read (a local log, cloud off): there is nothing to place the registry's consumers against.
  if (!fp || !registry || typeof discover !== 'function' || !identityKnown) return withoutRegistry();

  let found;
  try { found = discover(registry); } catch (err) { warnRegistryFailure(err, warn); return withoutRegistry(); }
  const stores = found?.stores ?? [];
  const here = stores.find((s) => String(s.fingerprint).toLowerCase() === full) ?? null;
  const hereAliases = (here?.aliases ?? []).filter((a) => ALIAS_RE.test(a));
  const consumers = repoScoped ? scopeConsumers : hereAliases;
  const measuredSet = new Set(answered ? consumers : []);

  const nm = [];
  const note = (alias, reason) => {
    if (typeof alias === 'string' && ALIAS_RE.test(alias) && !measuredSet.has(alias) && !nm.some((x) => x.alias === alias)) nm.push({ alias, reason });
  };
  if (!answered) for (const a of consumers.length > 0 ? consumers : [fp]) note(a, 'store-unreachable');
  for (const p of found?.policyUnreachable ?? []) note(aliasOfEntry(registry, p), p.reason);
  for (const u of found?.unresolved ?? []) note(aliasOfEntry(registry, u), 'no-store');
  // A repo-scoped read does not claim its store-mates; every other reachable store is out of this read's scope.
  for (const s of stores) {
    const sameStore = s === here;
    for (const a of s.aliases ?? []) if (!sameStore || repoScoped) note(a, 'not-in-scope');
  }
  return buildPopulation({
    measured: answered ? [{ store: fp, scope: scopeKind, consumers }] : [],
    notMeasured: nm, unknownBeyond: false, consumerReported,
  });
}

function aliasForName(registry, name) {
  return registry.find((r) => r.name === name)?.alias ?? null;
}

/** The label for a discovery entry: its registry alias, or `self` for this repo (the one entry with no alias). */
function aliasOfEntry(registry, entry) {
  return entry.alias ?? aliasForName(registry, entry.repo) ?? (entry.repo === SELF_REPO_NAME ? SELF_ALIAS : null);
}

const defaultWarn = (line) => process.stderr.write(`${line}\n`);

/**
 * A missing registry (a consumer, where its private half is absent) is the ordinary fallback and silent — but ONLY
 * when the `ERR_MODULE_NOT_FOUND` names one of the registry modules ITSELF (its `url` equals a given registry URL).
 * A missing TRANSITIVE import (or any other failure) still falls back to `unknownBeyond: true`, but says so once, by
 * code or name only — an error MESSAGE can carry a path.
 *
 * @param {unknown} err
 * @param {(line: string) => void} warn
 * @param {ReadonlyArray<string>} [registryUrls] file URLs of the registry modules; none given = nothing is "absent"
 */
export function warnRegistryFailure(err, warn = defaultWarn, registryUrls = []) {
  const missing = typeof err?.url === 'string' ? err.url.toLowerCase() : null;
  if (err?.code === 'ERR_MODULE_NOT_FOUND' && missing && registryUrls.some((u) => String(u).toLowerCase() === missing)) return;
  const what = String(err?.code || err?.name || 'error').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40) || 'error';
  warn(`population: registry/discovery failed (${what}) — other consumers reported as not known here`);
}

/**
 * Resolve the identities of this checkout plus each sibling for `repoScopeLabels`. THIS CHECKOUT ALWAYS TAKES
 * SLOT 0: if resolving it throws, a placeholder (`uuid: null`) is put there, so the first sibling can never be
 * mistaken for it and labelled `self`. A sibling that fails is skipped and reported in `failures`.
 *
 * @param {string[]} paths this checkout FIRST, then each --repos sibling
 * @param {(p: string) => {repoUuid: string, name?: string|null}} resolve
 * @returns {{identities: Array<{uuid: string|null, name: string|null, path: string}>, failures: Array<{path: string, error: unknown}>}}
 */
export function collectScopeIdentities(paths, resolve) {
  const identities = [];
  const failures = [];
  paths.forEach((p, i) => {
    try {
      const { repoUuid, name } = resolve(p);
      identities.push({ uuid: repoUuid, name: name ?? null, path: p });
    } catch (error) {
      failures.push({ path: p, error });
      if (i === 0) identities.push({ uuid: null, name: null, path: p });
    }
  });
  return { identities, failures };
}

/**
 * The consumer labels of a repo-scoped read over this checkout plus sibling repos: `self` (only if this checkout was resolved), then each sibling as its
 * REGISTRY ALIAS when its resolved PATH equals a registry entry's path (never by name: two different checkouts can share one), otherwise `sibling-<n>` (1-based). A sibling's repo
 * name is NEVER printed: the line is pasted into public docs and a private consumer's repo name is what its
 * organisation would not publish. A sibling resolving to a repo already counted (e.g. `--repos .`) is not repeated.
 *
 * @param {Array<{uuid: string, path?: string|null}>} identities this checkout FIRST, then each --repos sibling
 * @param {ReadonlyArray<{alias: string, path?: string}>} [registry] no registry = no match
 * @returns {string[]}
 */
export function repoScopeLabels(identities, registry = []) {
  // Only a RESOLVED checkout (a real uuid, i.e. one whose rows were actually queried) is `self`; a placeholder still
  // holds slot 0 so no sibling can take the label, but it is not part of the rendered scope.
  const labels = identities[0]?.uuid ? [SELF_ALIAS] : [];
  const seen = new Set(identities.length > 0 ? [identities[0].uuid] : []);
  const norm = (p) => (p ? (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p)) : null);
  let anonymous = 0;
  for (const { uuid, path: where } of identities.slice(1)) {
    if (seen.has(uuid)) continue;
    seen.add(uuid);
    const hit = registry.find((r) => ALIAS_RE.test(r?.alias ?? '') && norm(where) && norm(r.path) === norm(where));
    anonymous += hit ? 0 : 1;
    const label = hit ? hit.alias : `sibling-${anonymous}`;
    if (!labels.includes(label)) labels.push(label);
  }
  return labels;
}

/**
 * The population of a fan-out reader (`upstream-queues`, `store-drift`): the stores that
 * ANSWERED are measured (scope `store`: no repo predicate); everything else is listed not
 * measured with its reason. Unqueried stores are `store-unreachable`; a consumer that was
 * never asked keeps its policy reason. PURE.
 *
 * @param {object} input
 * @param {Array<{fingerprint: string, aliases?: string[]}>} [input.queried]
 * @param {Array<{aliases?: string[]}>} [input.unqueried]
 * @param {Array<{repo: string}>} [input.unresolved]
 * @param {Array<{alias: string|null, reason: string}>} [input.policyUnreachable]
 * @param {ReadonlyArray<{name: string, alias: string}>} [input.registry] resolves an unresolved consumer's repo name to its alias
 * @returns {ReturnType<typeof buildPopulation>}
 */
export function populationFromFanout({ queried = [], unqueried = [], unresolved = [], policyUnreachable = [], registry = [] }) {
  // One entry per queried store, even if two 8-hex display ids collide: distinct stores are never merged.
  const measured = queried.map((q) => ({
    store: String(q.fingerprint).slice(0, 8).toLowerCase(), scope: 'store', consumers: (q.aliases ?? []).filter((a) => ALIAS_RE.test(a)),
  }));
  const taken = new Set(measured.flatMap((m) => m.consumers));
  const notMeasured = [];
  const note = (alias, reason) => {
    if (typeof alias === 'string' && ALIAS_RE.test(alias) && !taken.has(alias)) { taken.add(alias); notMeasured.push({ alias, reason }); }
  };
  for (const p of policyUnreachable) note(aliasOfEntry(registry, p), p.reason);
  // An unqueried store with no known alias can only be this repo's own: name it `self` rather than dropping it.
  for (const u of unqueried) for (const a of (u.aliases?.length ? u.aliases : [SELF_ALIAS])) note(a, 'store-unreachable');
  for (const u of unresolved) note(aliasOfEntry(registry, u), 'no-store');
  return buildPopulation({ measured, notMeasured, unknownBeyond: false });
}

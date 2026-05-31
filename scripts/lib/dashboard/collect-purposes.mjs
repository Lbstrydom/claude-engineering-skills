/**
 * @fileoverview Purpose-view collector — joins the curated purpose taxonomy
 * (`.audit-loop/domain-map.json` `purposes`/`domainPurposes`), the skill-chain
 * flow manifest, the architecture-map domains, and the typed requirements
 * ledger into ONE discriminated output object for the dashboard Purpose tab.
 *
 * Plan: docs/plans/dashboard-purpose-view.md. Pure + deterministic (no cloud,
 * no Date/random) — the normalized output is folded into the reference page's
 * content `sourceHash`, so identical committed inputs ⇒ identical page.
 *
 * Output contract (PurposesSchema in schema.mjs) — the single shape the
 * collector, the schema, and sections/purpose.mjs all share:
 *   { status, detail, ledgerPresent, nodes[], hygiene{} }
 *
 * @module scripts/lib/dashboard/collect-purposes
 */
import fs from 'node:fs';
import path from 'node:path';
import { PurposeConfigSchema } from './schema.mjs';
import { computeTargetDomains } from '../symbol-index/domain-tagger.mjs';
import { archDomainElementId } from './anchors.mjs';

/** Stable empty result (used for missing-optional / invalid / error states). */
function emptyResult(status, detail, ledgerPresent) {
  return {
    status,
    detail,
    ledgerPresent: !!ledgerPresent,
    nodes: [],
    hygiene: {
      unmappedDomains: [],
      unattachedRequirements: [],
      skippedRequirements: 0,
      unknownDomains: [],
      domainsMissingArchitecture: [],
    },
  };
}

/**
 * @param {string} root repo root
 * @param {{
 *   architectureDomains?: Array<{name:string, anchor?:string|null}>,
 *   flows?: {nodes: Array<{id:string}>} | null,
 *   rules?: Array<{pattern:string, domain:string}>,
 *   requirements?: Array<object>,
 *   ledgerPresent?: boolean,
 * }} ctx
 * @returns {object} a PurposesSchema-shaped object
 */
export function collectPurposes(root, ctx = {}) {
  const {
    architectureDomains = [],
    flows = null,
    rules = [],
    requirements = [],
    ledgerPresent = false,
  } = ctx;

  // 1. Read the raw {purposes, domainPurposes} blocks from the domain map.
  let rawMap;
  try {
    rawMap = JSON.parse(fs.readFileSync(path.join(root, '.audit-loop', 'domain-map.json'), 'utf-8'));
  } catch (err) {
    if (err.code === 'ENOENT') return emptyResult('missing-optional', 'no .audit-loop/domain-map.json', ledgerPresent);
    return emptyResult('invalid', `domain-map.json unreadable: ${err.message}`, ledgerPresent);
  }
  if (rawMap == null || rawMap.purposes == null) {
    return emptyResult('missing-optional', 'no `purposes` block in .audit-loop/domain-map.json — add one to enable the Purpose tab', ledgerPresent);
  }

  // 2. Validate the config at the boundary (H1).
  const parsed = PurposeConfigSchema.safeParse({
    purposes: rawMap.purposes,
    domainPurposes: rawMap.domainPurposes || {},
  });
  if (!parsed.success) {
    return emptyResult('invalid', `purpose config invalid: ${parsed.error.issues[0]?.message || 'schema error'}`, ledgerPresent);
  }
  const cfg = parsed.data;

  // 3. flowNodes cross-check — only when the flow manifest is present
  //    (ReferenceDataSchema types flows as nullable; a missing manifest must
  //    NOT crash, it just leaves skill-chain badges unverified — Gemini3-M).
  if (flows && Array.isArray(flows.nodes)) {
    const flowIds = new Set(flows.nodes.map((n) => n.id));
    for (const p of cfg.purposes) {
      for (const fn of p.flowNodes) {
        if (!flowIds.has(fn)) {
          return emptyResult('invalid', `purpose "${p.id}" references unknown flow node "${fn}"`, ledgerPresent);
        }
      }
    }
  }

  // 4. Domain universe = architecture-map domains ∪ rule target-domains (M2).
  const archDomainSet = new Set(architectureDomains.map((d) => d.name));
  const ruleDomainSet = new Set(rules.map((r) => r.domain));
  const knownDomains = new Set([...archDomainSet, ...ruleDomainSet]);

  // 5. domain → purpose edges. Track per-domain purpose membership for the
  //    "also serves N" badge, and hygiene buckets.
  const purposeOrder = cfg.purposes.map((p) => p.id);
  const purposeById = new Map(cfg.purposes.map((p) => [p.id, p]));
  const purposeDomains = new Map(purposeOrder.map((id) => [id, new Set()]));
  const domainPurposeCount = new Map();         // domain → # purposes it serves
  const unknownDomains = new Set();
  const domainsMissingArchitecture = new Set();
  const mappedDomains = new Set();               // domains that appear in a valid edge

  for (const [domain, plist] of Object.entries(cfg.domainPurposes)) {
    if (!knownDomains.has(domain)) { unknownDomains.add(domain); continue; }
    mappedDomains.add(domain);
    if (!archDomainSet.has(domain)) domainsMissingArchitecture.add(domain);
    const uniqPurposes = [...new Set(plist)];
    domainPurposeCount.set(domain, uniqPurposes.length);
    for (const pid of uniqPurposes) purposeDomains.get(pid)?.add(domain);
  }

  // 6. requirement → domain (derived) → purpose (transitive). Dedup per purpose.
  const purposeReqs = new Map(purposeOrder.map((id) => [id, new Map()])); // pid → (reqId → req)
  const unattachedRequirements = [];
  let skippedRequirements = 0;

  for (const r of requirements) {
    const id = r?.id;
    const assertion = r?.assertion;
    if (!id || !assertion) { skippedRequirements += 1; continue; }
    const appliesTo = Array.isArray(r.appliesTo) ? r.appliesTo : [];
    const kind = String(r.kind || 'unknown');
    const derived = appliesTo.length ? computeTargetDomains(appliesTo, rules).domains : [];
    const hitPurposes = new Set();
    for (const d of derived) {
      if (!mappedDomains.has(d)) continue;
      for (const pid of (cfg.domainPurposes[d] || [])) {
        if (purposeById.has(pid)) hitPurposes.add(pid);
      }
    }
    if (hitPurposes.size === 0) { unattachedRequirements.push(id); continue; }
    for (const pid of hitPurposes) {
      purposeReqs.get(pid).set(id, { id, kind, assertion });
    }
  }

  // 7. unmapped domains = known domains with no domainPurposes entry.
  const unmappedDomains = [...knownDomains].filter((d) => !mappedDomains.has(d)).sort();

  // 8. Build nodes in declaration order, with stable internal ordering.
  const nodes = cfg.purposes.map((p) => {
    const domains = [...purposeDomains.get(p.id)].sort().map((dId) => ({
      id: dId,
      // Cross-link target = the dashboard box id from the SHARED canonical
      // helper (anchors.mjs), the same id sections/architecture.mjs stamps —
      // so writer + reader can't drift. NOT architectureDomains[].anchor: that
      // is the docs/architecture-map.md HEADING anchor, not a panel element id.
      // arch-map PRESENCE gates link-vs-null (no arch entry → null → link-less).
      anchor: archDomainSet.has(dId) ? archDomainElementId(dId) : null,
      alsoServes: Math.max(0, (domainPurposeCount.get(dId) || 1) - 1),
    }));
    const requirementsForNode = [...purposeReqs.get(p.id).values()].sort(
      (a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    );
    return {
      id: p.id,
      label: p.label,
      kind: p.kind,
      summary: p.summary,
      flowNodes: p.flowNodes,
      domains,
      requirements: requirementsForNode,
    };
  });

  return {
    status: 'ok',
    detail: '',
    ledgerPresent: !!ledgerPresent,
    nodes,
    hygiene: {
      unmappedDomains,
      unattachedRequirements: unattachedRequirements.sort(),
      skippedRequirements,
      unknownDomains: [...unknownDomains].sort(),
      domainsMissingArchitecture: [...domainsMissingArchitecture].sort(),
    },
  };
}

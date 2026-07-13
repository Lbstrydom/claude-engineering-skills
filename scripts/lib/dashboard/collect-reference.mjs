/**
 * @fileoverview Reference-data collector for the dashboard. Gathers skills,
 * plans, the architecture-map domains, and the skill-chain flow into one
 * object plus a per-source status map (docs/plans/local-dashboard.md §2.5).
 *
 * Every source is classified `ok` / `missing-optional` / `invalid` /
 * `unexpected-error` — expected absence and corruption are never conflated.
 *
 * @module scripts/lib/dashboard/collect-reference
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha } from '../cli-io.mjs';
import { loadAllSkills } from '../../skills-help.mjs';
import { collectCli } from './collect-cli.mjs';
import { collectNav } from './collect-nav.mjs';
import { collectVisual } from './collect-visual.mjs';
import { FlowManifestSchema } from './schema.mjs';
import {
  OBSERVED_FILE,
  ObservedDepsSchema,
  computeDomainMapDigest,
  mergeDomainDeps,
  flattenMergedDeps,
} from '../observed-deps.mjs';
import { loadDomainRules } from '../symbol-index/domain-tagger.mjs';
import { collectPurposes } from './collect-purposes.mjs';

const FLOWS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'flows.json');

/** `*-audit-summary*.md` and the like are NOT plans. */
const AUDIT_SUMMARY_RE = /-audit-summary/i;
/** The FIRST H1 heading in a document (`# …`, not `##`). */
const FIRST_H1_RE = /^#\s+(.+)$/m;
/** Plan identity: that first H1 must itself be `Plan: …`. */
const PLAN_TITLE_RE = /^Plan:\s*(.+)$/;

/**
 * Discover plan documents under `docs/plans/` (active) and `docs/completed/`
 * (completed). Inclusion: first `#` heading matches `# Plan:`. Exclusion:
 * `*-audit-summary*.md`. See docs/plans/local-dashboard.md §7.2.
 *
 * @param {string} [root] repo root
 * @returns {{active: object[], completed: object[], anyMalformed: boolean, readErrors: string[]}}
 */
export function discoverPlans(root = process.cwd()) {
  const buckets = { active: 'docs/plans', completed: 'docs/completed' };
  const out = { active: [], completed: [], anyMalformed: false, readErrors: [] };

  for (const [bucket, rel] of Object.entries(buckets)) {
    const dir = path.join(root, rel);
    let entries;
    try { entries = fs.readdirSync(dir); }
    catch (err) {
      // ENOENT = the bucket dir is simply absent (expected). Any other
      // fault (EACCES, …) is a real read error — record it, do not
      // silently lose a whole plan group.
      if (err.code !== 'ENOENT') out.readErrors.push(`${rel}: ${err.code || err.message}`);
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith('.md')) continue;
      if (AUDIT_SUMMARY_RE.test(name)) continue;
      let raw;
      try { raw = fs.readFileSync(path.join(dir, name), 'utf-8').replace(/\r\n/g, '\n'); }
      catch (err) {
        // ENOENT here = a file vanished between readdir and read (race) —
        // skip it. Any other fault is surfaced rather than swallowed.
        if (err.code !== 'ENOENT') out.readErrors.push(`${rel}/${name}: ${err.code || err.message}`);
        continue;
      }
      // Inclusion is decided by the FIRST H1 only — a `# Plan:` heading
      // appearing lower in a non-plan document must not qualify it.
      const firstH1 = raw.match(FIRST_H1_RE);
      if (!firstH1) continue;
      const heading = firstH1[1].match(PLAN_TITLE_RE);
      if (!heading) continue; // first heading is not `Plan: …` → not a plan
      // Metadata is front-matter — only the header (before the first H2)
      // is scanned, so a `Date:`-shaped line in the plan body is not
      // mistaken for metadata.
      const header = raw.split(/\n##\s/)[0];
      const dateM = header.match(/^-?\s*\*\*?Date\*\*?:\s*(.+)$/m) || header.match(/^Date:\s*(.+)$/m);
      const statusM = header.match(/^-?\s*\*\*?Status\*\*?:\s*(.+)$/m) || header.match(/^Status:\s*(.+)$/m);
      const date = dateM ? dateM[1].trim() : null;
      // A plan is malformed if Date/Status is missing OR the date value is
      // present but unparseable (documented + tested contract, §9).
      const dateParseable = date != null && !Number.isNaN(Date.parse(date));
      const malformed = !dateM || !statusM || !dateParseable;
      if (malformed) out.anyMalformed = true;
      out[bucket].push({
        title: heading[1].trim(),
        path: `${rel}/${name}`,
        status: statusM ? statusM[1].trim() : null,
        date,
        malformed,
        // Full body for inline render in the dashboard's Plans tab.
        // Lets us bypass VS Code's flaky Mermaid preview entirely —
        // the dashboard loads mermaid via CDN and renders cleanly.
        body: raw,
      });
    }
  }
  // Sort by parsed timestamp (newest first), NOT by raw date string.
  // String sort of mixed formats ("2026-05-22" vs "May 22, 2026") breaks
  // chronological order. Unparseable dates sink to the bottom; path used
  // as the tiebreaker for stable ordering across equivalent timestamps.
  //
  // Use comparison operators rather than subtraction — `tsOf` returns
  // -Infinity for unparseable dates, and `-Infinity - (-Infinity)` is
  // NaN, which would violate the Array.sort comparator contract when
  // two unparseable plans collide (Gemini-R1-G1).
  const tsOf = (s) => {
    const t = Date.parse(String(s || ''));
    return Number.isNaN(t) ? -Infinity : t;
  };
  const byDateDesc = (a, b) => {
    const tA = tsOf(a.date);
    const tB = tsOf(b.date);
    if (tA !== tB) return tB > tA ? 1 : -1;
    return a.path.localeCompare(b.path);
  };
  out.active.sort(byDateDesc);
  out.completed.sort(byDateDesc);
  return out;
}

/**
 * Read the observed-deps envelope from `.audit-loop/domain-deps-observed.json`.
 * Validates via Zod and freshness-gates against the current domain-map rules.
 * Plan: docs/plans/observed-domain-deps.md §6.
 *
 * @param {string} root
 * @returns {{envelope: object|null, rejectedReason: string|null}}
 *   rejectedReason values: 'absent' | 'unreadable' | 'schema-invalid' | 'stale-rules' | null
 */
function readObservedEnvelope(root) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(root, OBSERVED_FILE), 'utf-8');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      process.stderr.write(`  [dashboard] ${OBSERVED_FILE}: unreadable — ${err.message}; falling back to manual allowedDeps\n`);
      return { envelope: null, rejectedReason: 'unreadable' };
    }
    return { envelope: null, rejectedReason: 'absent' };
  }
  let parsed;
  try {
    parsed = ObservedDepsSchema.safeParse(JSON.parse(raw));
  } catch (err) {
    process.stderr.write(`  [dashboard] ${OBSERVED_FILE}: JSON parse failed — ${err.message}; falling back to manual allowedDeps\n`);
    return { envelope: null, rejectedReason: 'unreadable' };
  }
  if (!parsed.success) {
    process.stderr.write(`  [dashboard] ${OBSERVED_FILE}: schema validation failed — ${parsed.error.issues[0]?.message || 'invalid'}; falling back to manual allowedDeps\n`);
    return { envelope: null, rejectedReason: 'schema-invalid' };
  }
  const rules = loadDomainRules(root);
  const currentDigest = computeDomainMapDigest(rules);
  if (parsed.data.domainMapDigest !== currentDigest) {
    process.stderr.write(`  [dashboard] ${OBSERVED_FILE}: stale (rule digest mismatch — observed=${parsed.data.domainMapDigest.slice(0, 8)} current=${currentDigest.slice(0, 8)}); run npm run arch:render to refresh. Falling back to manual allowedDeps\n`);
    return { envelope: null, rejectedReason: 'stale-rules' };
  }
  return { envelope: parsed.data, rejectedReason: null };
}

/**
 * Read the manual `allowedDeps` (intent layer) from `.audit-loop/domain-map.json`.
 *
 * Distinguishes "no file" (ENOENT — common, silent return) from "file
 * present but unparseable" (logged, returns {}) per R1-H2/R1-M11. We
 * intentionally do NOT Zod-schema the manual file: it's hand-edited and
 * may carry adjacent fields the loader has no opinion on; the spec is
 * "allowedDeps is `{string: string[]}` if present, else nothing".
 *
 * @param {string} root
 * @returns {Object<string, string[]>}
 */
function readManualAllowedDeps(root) {
  const filePath = path.join(root, '.audit-loop', 'domain-map.json');
  let rawText;
  try {
    rawText = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      process.stderr.write(`  [dashboard] ${filePath}: unreadable — ${err.message}; manual allowedDeps treated as empty\n`);
    }
    return {};
  }
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    process.stderr.write(`  [dashboard] ${filePath}: JSON parse failed — ${err.message}; manual allowedDeps treated as empty\n`);
    return {};
  }
  const deps = parsed?.allowedDeps;
  if (deps == null) return {};
  if (typeof deps !== 'object' || Array.isArray(deps)) {
    process.stderr.write(`  [dashboard] ${filePath}: allowedDeps is not an object; manual layer treated as empty\n`);
    return {};
  }
  return deps;
}

/**
 * Read both layers (observed evidence + manual intent) and merge into the
 * shape the dashboard renderer needs. Exported for testing (Group E).
 *
 * @param {string} root
 * @returns {{
 *   deps: Object<string, string[]>,
 *   mergedDeps: Object<string, Array<{to: string, source: string}>>,
 *   depsSource: {
 *     observedAvailable: boolean,
 *     observedRejectedReason: string|null,
 *     observedRefreshId: string|null,
 *     observedGeneratedAt: string|null,
 *     manualKeyCount: number,
 *     edgeCounts: {observed: number, manual: number, both: number},
 *   },
 * }}
 */
export function readDomainDeps(root) {
  const { envelope, rejectedReason } = readObservedEnvelope(root);
  const manual = readManualAllowedDeps(root);
  const observed = envelope?.deps || {};
  const merged = mergeDomainDeps(observed, manual);
  const flat = flattenMergedDeps(merged);

  const edgeCounts = { observed: 0, manual: 0, both: 0 };
  for (const list of Object.values(merged)) {
    for (const e of list) edgeCounts[e.source]++;
  }
  const depsSource = {
    observedAvailable: !!envelope,
    observedRejectedReason: rejectedReason,
    observedRefreshId: envelope?.refreshId || null,
    observedGeneratedAt: envelope?.generatedAt || null,
    manualKeyCount: Object.keys(manual).length,
    edgeCounts,
  };
  return { deps: flat, mergedDeps: merged, depsSource };
}

/**
 * Read the committed requirements ledger (`.requirements/ledger.json`) for the
 * Purpose tab. Mirrors `collect-telemetry.mjs::collectRequirements`'s plain
 * file read. Returns the requirements array AND whether the file was present
 * (the renderer distinguishes "ledger absent" from "purpose has no invariants"
 * via `ledgerPresent` — docs/completed/dashboard-purpose-view.md Gemini2-M).
 *
 * @param {string} root
 * @returns {{requirements: object[], ledgerPresent: boolean, note: string|null}}
 */
function readRequirementsLedger(root) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(root, '.requirements', 'ledger.json'), 'utf-8');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      return { requirements: [], ledgerPresent: false, note: `requirements ledger unreadable: ${err.message}` };
    }
    return { requirements: [], ledgerPresent: false, note: null };
  }
  try {
    const ledger = JSON.parse(raw);
    const reqs = Array.isArray(ledger.requirements) ? ledger.requirements : [];
    return { requirements: reqs, ledgerPresent: true, note: null };
  } catch (err) {
    // Present but malformed — treat as empty so the join still runs, but flag it.
    return { requirements: [], ledgerPresent: true, note: `requirements ledger malformed: ${err.message}` };
  }
}

/**
 * Parse ONLY the stable `## Contents` block of `docs/architecture-map.md`
 * — domain name + symbol count + the per-domain `>` summary blurb. Mermaid
 * blocks and symbol tables are deliberately NOT scraped (Gemini-G2): a
 * Contents-parse failure degrades to `missing-optional`, never `invalid`.
 *
 * @param {string} root
 * @returns {{domains: object[], mapPath: string|null, status: object}}
 */
export function collectArchitecture(root) {
  const rel = 'docs/architecture-map.md';
  const file = path.join(root, rel);
  let raw;
  try { raw = fs.readFileSync(file, 'utf-8').replace(/\r\n/g, '\n'); }
  catch (err) {
    // ENOENT = the optional file is simply absent. Any OTHER read fault
    // (EACCES, EISDIR, …) is a real I/O failure, not "missing-optional".
    if (err.code === 'ENOENT') {
      return { domains: [], mapPath: null, status: { status: 'missing-optional', detail: `${rel} not found — run npm run arch:render` } };
    }
    return { domains: [], mapPath: rel, status: { status: 'unexpected-error', detail: `${rel} unreadable: ${err.message}` } };
  }
  try {
    // The Contents block runs from the `## Contents` heading to the next
    // `## ` heading, a `---` rule, or end-of-string. NO `/m` flag — under
    // `/m` the `$` alternative matches every line-end and the non-greedy
    // capture would stop after the first list line (only 1 domain).
    const contents = raw.match(/\n## Contents\n([\s\S]*?)(?:\n## |\n---|$)/);
    if (!contents) {
      return { domains: [], mapPath: rel, status: { status: 'missing-optional', detail: 'no ## Contents block — see the raw map' } };
    }
    const domains = [];
    const lineRe = /^- \[([^\]]+)\]\(#([^)]+)\)(?:\s*[—-]\s*(\d+)\s*symbols)?/gm;
    let m;
    while ((m = lineRe.exec(contents[1])) !== null) {
      const name = m[1];
      // Per-domain summary: the `>` blockquote right after `## <name>`.
      const secRe = new RegExp(`^## ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n+> ([^\\n]+)`, 'm');
      const sm = raw.match(secRe);
      domains.push({
        name,
        anchor: m[2],
        symbolCount: m[3] ? Number(m[3]) : null,
        summary: sm ? sm[1].trim() : '',
      });
    }
    return { domains, mapPath: rel, status: { status: 'ok', detail: '' } };
  } catch (err) {
    return { domains: [], mapPath: rel, status: { status: 'missing-optional', detail: `architecture-map parse failed: ${err.message}` } };
  }
}

/**
 * Load + validate the committed flow manifest. Shape + structural
 * invariants (unique node ids, edge endpoints resolve) are enforced by
 * `FlowManifestSchema`. Skill references are cross-validated against the
 * live skill set — but ONLY when that set is trustworthy: if the skills
 * source itself failed, the cross-check is skipped (it would otherwise
 * report a misleading second failure — every node would look "unknown").
 *
 * @param {Set<string>} skillNames
 * @param {boolean} skillsOk — whether the skills source collected cleanly
 */
function collectFlows(skillNames, skillsOk) {
  let raw;
  try { raw = fs.readFileSync(FLOWS_PATH, 'utf-8'); }
  catch (err) {
    // ENOENT = manifest absent; any other read fault is a real I/O error.
    if (err.code === 'ENOENT') {
      return { flows: null, status: { status: 'missing-optional', detail: 'flows.json not found' } };
    }
    return { flows: null, status: { status: 'unexpected-error', detail: `flows.json unreadable: ${err.message}` } };
  }
  let parsed;
  try { parsed = FlowManifestSchema.parse(JSON.parse(raw)); }
  catch (err) {
    return { flows: null, status: { status: 'invalid', detail: `flows.json malformed: ${err.message}` } };
  }
  // Skill cross-validation is meaningful only when the skill set is real.
  if (!skillsOk) {
    return {
      flows: parsed,
      status: { status: 'missing-optional', detail: 'skills source failed — flow skill references not cross-checked' },
    };
  }
  const badSkill = parsed.nodes.find((n) => !skillNames.has(n.skill));
  if (badSkill) {
    return { flows: null, status: { status: 'invalid', detail: `flow node "${badSkill.id}" references unknown skill "${badSkill.skill}"` } };
  }
  return { flows: parsed, status: { status: 'ok', detail: '' } };
}

/**
 * Collect the full reference-data object.
 * @param {{git?: {baseSha: string, dirty: boolean}}} [opts]
 * @returns {Promise<object>} a ReferenceData object (validate via schema before render)
 */
export async function collectReference(opts = {}) {
  const root = process.cwd();
  const git = opts.git || { baseSha: 'unknown', dirty: false };
  const sources = {};

  // Skills
  let skills = [];
  try {
    skills = loadAllSkills().map((s) => ({
      name: s.name, oneLiner: s.oneLiner, triggers: s.triggers,
      usage: s.usage, disableModelInvocation: s.disableModelInvocation, path: s.path,
    }));
    sources.skills = { status: skills.length ? 'ok' : 'missing-optional', detail: skills.length ? '' : 'no skills found' };
  } catch (err) {
    sources.skills = { status: 'unexpected-error', detail: `loadAllSkills failed: ${err.message}` };
  }

  // Plans — discovery succeeding is `ok`; an individual plan with a loose
  // metadata header is flagged per-row (`malformed`) and rendered minimally,
  // but does NOT degrade the build (a months-old archived plan's header
  // variance is cosmetic, not a source failure). Only a thrown discovery
  // error is `unexpected-error`.
  let plans = { active: [], completed: [] };
  try {
    const d = discoverPlans(root);
    plans = { active: d.active, completed: d.completed };
    if (d.readErrors.length) {
      // A real I/O fault reading a plan dir/file — not the same as a loose
      // header. Surface it as a degrading error.
      sources.plans = { status: 'unexpected-error', detail: `plan read error(s): ${d.readErrors.join('; ')}` };
    } else {
      sources.plans = { status: 'ok', detail: d.anyMalformed ? 'some plans have a loose metadata header (shown as minimal rows)' : '' };
    }
  } catch (err) {
    sources.plans = { status: 'unexpected-error', detail: `plan discovery failed: ${err.message}` };
  }

  // Architecture
  const arch = collectArchitecture(root);
  sources.architecture = arch.status;

  // Flows — skill cross-validation is gated on the skills source being ok.
  const flowRes = collectFlows(new Set(skills.map((s) => s.name)), sources.skills.status === 'ok');
  sources.flows = flowRes.status;

  // CLI catalog — never fatal; cli source-status carries uncatalogued count.
  let cli = [];
  try {
    const cliRes = collectCli(root);
    cli = cliRes.entries;
    sources.cli = cliRes.status;
  } catch (err) {
    sources.cli = { status: 'unexpected-error', detail: `collectCli failed: ${err.message}` };
  }

  // Nav-audit section (REGISTRY.reference) — Per-Persona Reachability Scorecard
  // + Nav Drift. Degrades to an empty panel with a logged cause (cloud-off /
  // not-yet-run), mirroring collectArchitecture's status contract.
  let navAudit = { scorecard: [], drift: [], status: { status: 'missing-optional', detail: '' } };
  try {
    navAudit = (await collectNav(root)).navAudit;
  } catch (err) {
    navAudit = { scorecard: [], drift: [], status: { status: 'unexpected-error', detail: `collectNav failed: ${err.message}` } };
  }
  sources.navAudit = navAudit.status;

  // Visual-audit section (REGISTRY.reference) — Contracted-Surface Scorecard +
  // Visual Findings. Same degradation contract as collectNav.
  let visualAudit = { scorecard: [], findings: [], diagnostics: [], status: { status: 'missing-optional', detail: '' } };
  try {
    visualAudit = collectVisual(root).visualAudit;
  } catch (err) {
    visualAudit = { scorecard: [], findings: [], diagnostics: [], status: { status: 'unexpected-error', detail: `collectVisual failed: ${err.message}` } };
  }
  sources.visualAudit = visualAudit.status;

  // Purpose tab — join curated taxonomy + flows + architecture domains +
  // requirements ledger. Deterministic; sources.purposes mirrors its status.
  const ledger = readRequirementsLedger(root);
  const purposesFull = collectPurposes(root, {
    architectureDomains: arch.domains,
    flows: flowRes.flows,
    rules: loadDomainRules(root),
    requirements: ledger.requirements,
    ledgerPresent: ledger.ledgerPresent,
  });
  // Relocate the inverse edge onto the architecture slice (the Architecture
  // section's slicer can only reach `d.architecture`) — v2 Part 2. `purposes`
  // keeps nodes/coverage/hygiene.
  const { domainPurposeIndex, ...purposes } = purposesFull;
  sources.purposes = {
    status: purposes.status,
    detail: ledger.note ? `${purposes.detail}${purposes.detail ? '; ' : ''}${ledger.note}` : purposes.detail,
  };

  const data = {
    kind: 'reference',
    provenance: { baseSha: git.baseSha, dirty: git.dirty, sourceHash: '' },
    sources,
    skills,
    plans,
    architecture: (() => {
      const dd = readDomainDeps(root);
      return {
        domains: arch.domains,
        deps: dd.deps,
        mergedDeps: dd.mergedDeps,
        depsSource: dd.depsSource,
        mapPath: arch.mapPath,
        domainPurposes: domainPurposeIndex,   // v2 Part 2 — Architecture→Purpose
      };
    })(),
    flows: flowRes.flows,
    cli,
    purposes,
    navAudit,
    visualAudit,
  };
  // sourceHash over content (everything but provenance) — committed-page
  // determinism (no timestamp; plan §8 / M3). `purposes` is a pure function of
  // committed files, so folding it in keeps the page byte-reproducible.
  data.provenance.sourceHash = sha(JSON.stringify({
    skills, plans, architecture: data.architecture, flows: data.flows, cli, sources, purposes, navAudit, visualAudit,
  }), 8);
  return data;
}

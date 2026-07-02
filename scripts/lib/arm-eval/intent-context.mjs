/**
 * @fileoverview Repo-intent context pack for the blinded judge (D8 / §10.4).
 *
 * Plan: docs/plans/arm-eval-framework.md D8. Assembles a bounded, token-capped
 * pack of the repo's OWN intent artifacts so the judge scores "architectural
 * coherence" + "repo-intent fidelity" against the ACTUAL intent, not vibes:
 *   - docs/architecture-map.md          — the symbol index (what exists)
 *   - .audit-loop/domain-map.json       — allowedDeps (domain relationships) AND
 *                                         the `rules` glob array (Gemini-R2 fix:
 *                                         needed to classify a plan's NEW paths
 *                                         into domains before judging violations)
 *   - .requirements/ledger.json         — active de-facto invariants
 *
 * Degrades HONESTLY: if NONE of the artifacts are present, returns
 * `{ present:false, pack:null }` and the judge marks the two intent dimensions
 * `unscored` (never a fabricated score — D8 / §4). Partial presence is fine (the
 * pack notes which sources were included).
 *
 * File reads are injectable (`deps`) so tests run without touching disk.
 *
 * @module scripts/lib/arm-eval/intent-context
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const DEFAULT_MAX_CHARS = 12000;

function defaultDeps() {
  return {
    readFile: (p) => readFileSync(p, 'utf8'),
    exists: (p) => existsSync(p),
  };
}

/** Read a file if present; null on any error (graceful — never throws). */
function tryRead(deps, p) {
  try { return deps.exists(p) ? deps.readFile(p) : null; } catch { return null; }
}

/** Truncate with an explicit marker so the judge knows the pack was capped. */
function cap(text, max) {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n… [truncated at ${max} chars]`;
}

/**
 * Build the intent context pack.
 * @param {{ repoRoot?: string, maxChars?: number, deps?: object }} [opts]
 * @returns {{ present:boolean, pack:string|null, sources:string[], intentScorable:boolean }}
 */
export function buildIntentContext({ repoRoot = process.cwd(), maxChars = DEFAULT_MAX_CHARS, deps = {} } = {}) {
  const d = { ...defaultDeps(), ...deps };
  const sources = [];
  const sections = [];

  // 1. Architecture map (symbol index) — the biggest, so give it the lion's share.
  const archPath = path.join(repoRoot, 'docs', 'architecture-map.md');
  const arch = tryRead(d, archPath);
  if (arch && arch.trim()) {
    sources.push('architecture-map');
    sections.push(`## Architecture map (symbol index)\n${cap(arch, Math.floor(maxChars * 0.6))}`);
  }

  // 2. Domain map — allowedDeps (relationships) + rules (glob→domain), BOTH.
  const domainPath = path.join(repoRoot, '.audit-loop', 'domain-map.json');
  const domainRaw = tryRead(d, domainPath);
  if (domainRaw) {
    try {
      const dm = JSON.parse(domainRaw);
      const picked = {};
      if (dm.allowedDeps) picked.allowedDeps = dm.allowedDeps;
      if (dm.rules) picked.rules = dm.rules;               // Gemini-R2 fix: classify NEW paths
      if (Object.keys(picked).length) {
        // Bound the SIZE by trimming the rules array (keeps VALID JSON — Gemini
        // gate fix: a blunt string cap on JSON.stringify would truncate
        // mid-structure into malformed JSON). Note truncation explicitly.
        const RULE_CAP = 60;
        let note = '';
        if (Array.isArray(picked.rules) && picked.rules.length > RULE_CAP) {
          note = `\n(rules truncated: showing ${RULE_CAP} of ${picked.rules.length})`;
          picked.rules = picked.rules.slice(0, RULE_CAP);
        }
        sources.push('domain-map');
        sections.push(`## Domain map — architectural intent (allowedDeps) + path rules${note}\n\`\`\`json\n${JSON.stringify(picked, null, 2)}\n\`\`\``);
      }
    } catch { /* malformed domain-map → skip, not fatal */ }
  }

  // 3. Requirements ledger — active de-facto invariants.
  const reqPath = path.join(repoRoot, '.requirements', 'ledger.json');
  const reqRaw = tryRead(d, reqPath);
  if (reqRaw) {
    try {
      const led = JSON.parse(reqRaw);
      const entries = Array.isArray(led) ? led : (led.requirements || led.entries || []);
      const active = entries.filter((e) => (e.status ?? 'active') === 'active')
        .map((e) => `- [${e.id ?? '?'}] ${e.statement ?? e.text ?? e.description ?? ''}`.trim());
      if (active.length) {
        sources.push('requirements');
        sections.push(`## De-facto invariants (requirements ledger — active)\n${cap(active.join('\n'), Math.floor(maxChars * 0.2))}`);
      }
    } catch { /* malformed ledger → skip */ }
  }

  const present = sections.length > 0;
  return {
    present,
    intentScorable: present,       // the judge scores the intent dims only when present
    sources,
    pack: present ? sections.join('\n\n') : null,
  };
}

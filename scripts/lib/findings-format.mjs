/**
 * @fileoverview Finding display formatting — pure renderer, no state or I/O.
 * Split from findings.mjs (Wave 2, Phase 3) for Single Responsibility.
 * @module scripts/lib/findings-format
 */

/**
 * Format findings as readable markdown, grouped by severity.
 * @param {object[]} findings
 * @returns {string}
 */
import { isInDiff, isPreExisting } from './finding-scope.mjs';

export function formatFindings(findings) {
  // Pre-existing findings (outside the change; finding-scope.mjs) get their own heading and never sit among the author's own.
  const preExisting = findings.filter(isPreExisting);
  if (preExisting.length > 0) {
    const own = formatFindings(findings.filter(isInDiff));
    const rest = formatFindingsGrouped(preExisting);
    return `${own}
### Pre-existing (not counted: about code this change did not touch)
${rest}`;
  }
  return formatFindingsGrouped(findings);
}

function formatFindingsGrouped(findings) {
  const groups = { HIGH: [], MEDIUM: [], LOW: [] };
  for (const f of findings) (groups[f.severity] ?? groups.LOW).push(f);

  let output = '';
  for (const [sev, items] of Object.entries(groups)) {
    if (!items.length) continue;
    output += `\n### ${sev} Severity\n\n`;
    for (const f of items) {
      output += `#### [${f.id}] ${f.category}: ${f.section}\n`;
      output += `- **Detail**: ${f.detail}\n`;
      if (sev !== 'LOW') {
        output += `- **Risk**: ${f.risk}\n`;
        output += `- **Principle**: ${f.principle}\n`;
      }
      output += `- **Recommendation**: ${f.recommendation}\n`;
      if (f.is_quick_fix) output += `- **WARNING**: Quick fix — needs proper sustainable solution\n`;
      output += '\n';
    }
  }
  return output;
}

/**
 * @fileoverview Parses `docs/architecture-intent.md` — the human-narrative
 * companion to `.audit-loop/domain-map.json`. Extracts the first Mermaid
 * block + section narratives. Best-effort, never throws on malformed input.
 *
 * The intent doc is HUMAN-ONLY — not machine-enforced. This parser is for
 * passing the doc content to the LLM-bouncer; it does NOT validate Mermaid
 * → allowedDeps equivalence.
 *
 * @module scripts/lib/arch-intent/intent-doc-parser
 */

import fs from 'node:fs';

/**
 * Parse the intent doc.
 *
 * @param {string} docPath - absolute path to docs/architecture-intent.md
 * @returns {{
 *   mermaid: string|null,
 *   narratives: Object<string, string>,  // header → text
 *   version: string|null,
 *   _warnings: string[],
 *   _present: boolean,
 * }}
 */
export function parseIntentDoc(docPath) {
  const result = {
    mermaid: null,
    narratives: {},
    version: null,
    _warnings: [],
    _present: false,
  };

  if (!docPath || !fs.existsSync(docPath)) return result;
  result._present = true;

  let content;
  try {
    content = fs.readFileSync(docPath, 'utf-8');
  } catch (err) {
    result._warnings.push(`Failed to read ${docPath}: ${err.message}`);
    return result;
  }

  // Extract the FIRST ```mermaid block
  const mermaidMatch = content.match(/```mermaid\s*\n([\s\S]*?)\n```/);
  if (mermaidMatch) {
    result.mermaid = mermaidMatch[1].trim();
  } else {
    result._warnings.push('No mermaid code block found in intent doc');
  }

  // Extract version (look for "- **Version**: X" or similar in header)
  const versionMatch = content.match(/[-*]\s*\*\*Version\*\*[:\s]+([^\n]+)/i);
  if (versionMatch) {
    result.version = versionMatch[1].trim();
  }

  // Extract section narratives — split on H2/H3 headers, capture body
  // Best-effort, won't throw on weird input
  try {
    const sectionRe = /^(##+)\s+(.+?)\s*$([\s\S]*?)(?=^##+\s|$(?![\s\S]))/gm;
    let m;
    while ((m = sectionRe.exec(content)) !== null) {
      const header = m[2].trim();
      const body = m[3].trim();
      if (body.length > 0) {
        result.narratives[header] = body;
      }
    }
  } catch (err) {
    result._warnings.push(`Section extraction failed: ${err.message}`);
  }

  return result;
}

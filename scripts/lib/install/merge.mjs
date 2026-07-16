/**
 * @fileoverview Block-marker merge for .github/copilot-instructions.md.
 * Preserves operator-authored content, replaces only managed block.
 */

const START_MARKER = '<!-- audit-loop-bundle:start -->';
const END_MARKER = '<!-- audit-loop-bundle:end -->';

/**
 * Default block content for copilot-instructions.
 */
export const COPILOT_BLOCK = `${START_MARKER}
## Engineering Skills Bundle

This repo uses \`claude-engineering-skills\`. Skills available:

- \`/plan\` -- unified architecture + UX planner (auto-detects backend/frontend/full-stack)
- \`/audit-plan\` -- iterative plan audit with GPT + Gemini final gate
- \`/audit-code\` -- multi-pass code audit against a plan with GPT + Gemini final gate
- \`/cycle\` -- end-to-end orchestrator: plan -> audit-plan -> audit-code -> persona-test -> ux-lock -> ship
- \`/ux-lock\` -- generate/verify Playwright e2e specs (lock a fix or verify a plan was built)
- \`/click-test\` -- structural DOM audit of a live app
- \`/persona-test\` -- persona-driven exploratory browser testing against a live URL
- \`/nav-audit\` -- static navigation / information-architecture audit
- \`/visual-audit\` -- deterministic visual/paint contract audit (tokens, theme parity, layout)
- \`/ship\` -- sync docs, commit, and push
- \`/brainstorm\` -- multi-LLM concept-level brainstorming
- \`/explain\` -- explain why code is structured the way it is
- \`/security-strategy\` -- maintain the per-repo security incident memory
- \`/ai-context-management\` -- keep AGENTS.md/CLAUDE.md aligned across agents
- \`/skills\` -- quick reference for every available skill in this repo

Source: https://github.com/Lbstrydom/claude-engineering-skills

## Keeping Skills Current
- Check for updates: \`node .audit-loop/bootstrap.mjs check\`
- Install latest: \`node .audit-loop/bootstrap.mjs install --surface both\`
${END_MARKER}`;

/**
 * Merge the managed block into copilot-instructions content.
 * @param {string|null} existing - Current file content (null if file doesn't exist)
 * @param {string} [block=COPILOT_BLOCK] - Block content to merge
 * @returns {string} Merged content
 */
export function mergeBlock(existing, block = COPILOT_BLOCK) {
  if (!existing) {
    // File absent — create with just our block
    return block + '\n';
  }

  const startIdx = existing.indexOf(START_MARKER);
  const endIdx = existing.indexOf(END_MARKER);

  if (startIdx === -1 || endIdx === -1) {
    // File present, no markers — append our block at end
    const trimmed = existing.trimEnd();
    return trimmed + '\n\n' + block + '\n';
  }

  // File present, markers found — replace only content between markers
  const before = existing.slice(0, startIdx);
  const after = existing.slice(endIdx + END_MARKER.length);
  return before + block + after;
}

/**
 * Extract just the managed block from content (for SHA comparison).
 * Searches for END_MARKER strictly after START_MARKER so a stray END_MARKER
 * earlier in the file cannot produce a negative-length window.
 * @param {string} content
 * @returns {string|null}
 */
export function extractBlock(content) {
  const startIdx = content.indexOf(START_MARKER);
  if (startIdx === -1) return null;
  const endIdx = content.indexOf(END_MARKER, startIdx + START_MARKER.length);
  if (endIdx === -1) return null;
  return content.slice(startIdx, endIdx + END_MARKER.length);
}

export { START_MARKER, END_MARKER };

/**
 * @fileoverview Generate `.github/prompts/<skill>.prompt.md` shims for
 * GitHub Copilot in VS Code. Each shim wraps the same CLI that Claude
 * skills orchestrate, giving Copilot teammates parity slash commands.
 *
 * Source of truth: each skill's `SKILL.md` frontmatter (description). The
 * SKILL_ENTRY_SCRIPTS registry maps skill name → underlying CLI entry.
 *
 * Generated files carry a managed-block header so re-installs replace the
 * managed content idempotently while leaving any operator additions alone
 * (currently we own the whole file; the marker reserves the door for
 * mixed-content support later).
 *
 * @module scripts/lib/install/copilot-prompts
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const START_MARKER = '<!-- audit-loop-bundle:prompt:start -->';
const END_MARKER = '<!-- audit-loop-bundle:prompt:end -->';

/**
 * Skill name → entry-script and args registry. Update when a skill's
 * underlying CLI changes. Only skills listed here get prompt-file shims;
 * skills without a registered CLI entry skip silently.
 *
 * `args` uses VS Code Copilot's prompt-file `${input:N}` placeholder so
 * the user is prompted at invocation time. Multiple inputs allowed.
 */
export const SKILL_ENTRY_SCRIPTS = Object.freeze({
  'audit-plan': {
    script: 'openai-audit.mjs',
    cli: 'node scripts/openai-audit.mjs plan ${input:plan_path} --mode plan',
    summary: 'Iteratively audit a plan file with GPT + Gemini final gate (max 3 rounds).',
  },
  'audit-code': {
    script: 'openai-audit.mjs',
    cli: 'node scripts/openai-audit.mjs code ${input:plan_path} --scope diff',
    summary: 'Multi-pass code audit against a plan with R2+ ledger suppression and debt capture.',
  },
  'cycle': {
    script: 'cycle.mjs',
    cli: 'node scripts/cycle.mjs ${input:task_or_plan}',
    summary: 'End-to-end feature cycle: plan → audit-plan → impl gate → audit-code → persona-test → ux-lock → ship.',
  },
  'nav-audit': {
    script: 'nav-audit.mjs',
    cli: 'node scripts/nav-audit.mjs --scope diff',
    summary: 'Static navigation / IA audit — the system-level lens; offered-vs-needed, drift-only CI gate.',
  },
  'visual-audit': {
    script: 'visual-audit.mjs',
    cli: 'node scripts/visual-audit.mjs --verify ${input:url}',
    summary: 'Math-first visual/paint audit — the paint-level lens; token/theme/layout/signifier tiers, drift-only CI gate.',
  },
  'explain': {
    script: 'explain.mjs',
    cli: 'node scripts/explain.mjs ${input:target}',
    summary: 'Explain WHY code is structured this way — synthesises arch-memory, git history, principles, and plan citations.',
  },
  'plan': {
    script: 'plan.mjs',
    cli: 'node scripts/plan.mjs ${input:task}',
    summary: 'Unified planner — auto-detects backend/frontend/full-stack scope; one consolidated plan output.',
  },
  'persona-test': {
    script: 'persona-test.mjs',
    cli: 'node scripts/persona-test.mjs ${input:persona} ${input:url}',
    summary: 'Drive a browser as a persona against a live URL; report UX findings.',
  },
  'ux-lock': {
    script: 'ux-lock.mjs',
    cli: 'node scripts/ux-lock.mjs ${input:mode_and_args}',
    summary: 'Generate Playwright e2e specs that lock fixed behaviour or grade a plan.',
  },
  'click-test': {
    script: 'click-test.mjs',
    cli: 'node scripts/click-test.mjs ${input:url} ${input:flags}',
    summary: 'Structural DOM audit — walk every interactive element and assert semantic-HTML contracts. Complement to /persona-test.',
  },
  'brainstorm': {
    script: 'brainstorm-round.mjs',
    cli: 'node scripts/brainstorm-round.mjs --topic-stdin ${input:flags}',
    summary: 'Concept-level multi-LLM brainstorming — calls OpenAI (and optionally Gemini) for independent perspectives; user-driven manual convergence.',
  },
  'ship': {
    script: 'ship.mjs',
    cli: 'node scripts/ship.mjs ${input:args}',
    summary: 'Commit, push, and gate against UX P0 warnings from persona-test.',
  },
  'ai-context-management': {
    script: 'check-context-drift.mjs',
    cli: 'node scripts/check-context-drift.mjs',
    summary: 'Manage AGENTS.md / CLAUDE.md alignment; generate Copilot prompt shims.',
  },
  'security-strategy': {
    script: 'security-memory/refresh-incidents.mjs',
    cli: 'node scripts/security-memory/refresh-incidents.mjs',
    summary: 'Refresh security_incidents from docs/security-strategy.md (interview/edit modes are skill-driven; CLI runs the refresh).',
  },
  'skills': {
    script: 'skills-help.mjs',
    cli: 'node scripts/skills-help.mjs ${input:skill_or_blank}',
    summary: 'Quick reference for every available skill — name, one-liner, triggers, usage. Reads SKILL.md frontmatter directly so it cannot drift.',
  },
});

/**
 * Quote a string as a YAML double-quoted scalar. Escapes internal double
 * quotes and backslashes so values containing `:`, `#`, or other YAML
 * tokens cannot produce malformed frontmatter.
 */
function yamlQuote(s) {
  return `"${String(s).replaceAll(/\\/g, '\\\\').replaceAll(/"/g, '\\"')}"`;
}

// ── Frontmatter parsing ─────────────────────────────────────────────────────

/**
 * Extract the YAML frontmatter and the first sentence of the description.
 * Tolerates both inline and block YAML scalars. Returns null on missing or
 * malformed frontmatter — caller decides whether to skip.
 */
export function parseSkillFrontmatter(content) {
  // Normalize line endings first. On a Windows checkout (core.autocrlf=true,
  // no .gitattributes pin) SKILL.md arrives CRLF; the block-scalar regex below
  // anchors on \n and its `.` won't cross \r, so a CRLF file truncates a
  // `description: |` block to its first line. Normalizing here makes the parser
  // correct regardless of the contributor's git config.
  content = content.replace(/\r\n/g, '\n');
  if (!content.startsWith('---')) return null;
  const endIdx = content.indexOf('\n---', 3);
  if (endIdx < 0) return null;
  const yaml = content.slice(3, endIdx).trim();
  const out = {};
  // name: foo
  const nameMatch = /^name:\s*(.+)$/m.exec(yaml);
  if (nameMatch) out.name = nameMatch[1].trim();
  // description: ... (single-line or block-scalar form)
  // Block-scalar form: consecutive indented lines after `description: |`.
  const descBlockMatch = /^description:\s*\|[+-]?\s*\n((?:^[ \t]+.*\n?)+)/m.exec(yaml);
  if (descBlockMatch) {
    out.description = descBlockMatch[1]
      .split('\n')
      .map(l => l.replace(/^[ \t]+/, '').trim())
      .filter(Boolean)
      .join(' ');
  } else {
    const descInlineMatch = /^description:\s*(.+)$/m.exec(yaml);
    if (descInlineMatch) out.description = descInlineMatch[1].trim();
  }
  return out;
}

// ── Prompt-file synthesis ───────────────────────────────────────────────────

/**
 * Build the `.prompt.md` file content for a single skill.
 *
 * @param {string} skillName
 * @param {object} frontmatter - Parsed SKILL.md frontmatter ({name, description})
 * @returns {string|null} File content, or null if skill is not in registry
 */
export function generatePromptFile(skillName, frontmatter) {
  const entry = SKILL_ENTRY_SCRIPTS[skillName];
  if (!entry) return null;

  // First sentence of the SKILL description, if available — keeps the prompt
  // file's purpose section close to the canonical skill doc without copying
  // the full multi-paragraph description.
  const firstSentence = (frontmatter?.description || entry.summary)
    .replaceAll(/\s+/g, ' ')
    .trim()
    .split(/(?<=\.)\s/)[0]
    .slice(0, 240);

  const body = [
    '---',
    `description: ${yamlQuote(firstSentence)}`,
    'mode: agent',
    '---',
    `# /${skillName}`,
    '',
    `${entry.summary}`,
    '',
    '## Run',
    '',
    'Invoke the engineering skills CLI:',
    '',
    '```bash',
    entry.cli,
    '```',
    '',
    `Underlying script: \`scripts/${entry.script}\` — same code path that Claude skills orchestrate, so output is consistent across both surfaces.`,
    '',
    `## Notes for Copilot users`,
    '',
    `For the full skill flow (progressive disclosure, multi-pass orchestration, conversational fix-iterate loops), use Claude Code with \`/${skillName}\`. This prompt file provides CLI parity for VS Code Copilot users — output is structured JSON / log lines, not the conversational UX Claude offers.`,
  ].join('\n');

  return `${START_MARKER}\n${body}\n${END_MARKER}\n`;
}

/**
 * Generate prompt files for every registered skill found under `skillsDir`.
 * Skills not in SKILL_ENTRY_SCRIPTS are silently skipped (with a warning).
 * Returns the set of generated `{ relPath, content }` entries — caller
 * decides whether to write them to disk.
 *
 * @param {string} skillsDir - Path to the `skills/` source directory
 * @returns {Array<{relPath: string, content: string, skillName: string}>}
 */
export function generateAllPromptFiles(skillsDir) {
  if (!fs.existsSync(skillsDir)) return [];
  // Sort for deterministic output across runs / OSes.
  const entries = fs.readdirSync(skillsDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort();

  const out = [];
  for (const skillName of entries) {
    const skillPath = path.join(skillsDir, skillName, 'SKILL.md');
    if (!fs.existsSync(skillPath)) continue;
    const content = fs.readFileSync(skillPath, 'utf-8');
    const frontmatter = parseSkillFrontmatter(content);
    const promptContent = generatePromptFile(skillName, frontmatter);
    if (!promptContent) {
      // Skill not in registry — warn so registry omissions don't fail closed.
      // To enable Copilot parity for this skill, add it to SKILL_ENTRY_SCRIPTS.
      process.stderr.write(
        `[copilot-prompts] WARN: skill "${skillName}" has SKILL.md but is not in ` +
        `SKILL_ENTRY_SCRIPTS — skipping prompt generation.\n`
      );
      continue;
    }
    out.push({
      relPath: path.posix.join('.github', 'prompts', `${skillName}.prompt.md`),
      content: promptContent,
      skillName,
    });
  }
  return out;
}

// ── Idempotency helpers ─────────────────────────────────────────────────────

/**
 * SHA-256 of the managed block within an existing prompt file.
 * Searches for END_MARKER strictly AFTER START_MARKER so stray marker text
 * elsewhere in the file cannot widen the hash window.
 * Used to detect whether a re-install would change the file.
 */
export function shaOfManagedBlock(content) {
  if (!content) return null;
  const startIdx = content.indexOf(START_MARKER);
  if (startIdx === -1) return null;
  const endIdx = content.indexOf(END_MARKER, startIdx + START_MARKER.length);
  if (endIdx === -1) return null;
  const block = content.slice(startIdx, endIdx + END_MARKER.length);
  return crypto.createHash('sha256').update(block).digest('hex').slice(0, 16);
}

export { START_MARKER, END_MARKER };

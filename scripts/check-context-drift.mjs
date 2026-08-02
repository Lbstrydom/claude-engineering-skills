#!/usr/bin/env node
/**
 * @fileoverview Drift detector for AGENTS.md ↔ CLAUDE.md alignment.
 *
 * Enforces the canonical relationship: AGENTS.md is shared project context;
 * CLAUDE.md is a slim addendum that imports AGENTS.md and contains only
 * Claude-specific notes (allowlisted h2 headings).
 *
 * Rules:
 *   ctx/missing-import          HIGH    CLAUDE.md doesn't @import AGENTS.md
 *   ctx/non-allowlist-heading   HIGH    CLAUDE.md h2 not in allowlist
 *   ctx/shared-section-drift    HIGH    Same h2 in both files, bodies differ
 *   ctx/oversized-claude-md     MEDIUM  CLAUDE.md exceeds maxClaudeMdLines
 *   ctx/oversized-agents-md     MEDIUM  AGENTS.md exceeds maxAgentsMdChars (sprawl
 *                                       cap — condense to stubs + docs/<topic>.md)
 *   ctx/agents-md-headroom      ADVISORY AGENTS.md is within 10% of the cap. Names
 *                                       the sections cheapest to condense. NEVER
 *                                       affects the exit code, --strict included.
 *
 * Exit codes:
 *   0  No findings
 *   1  HIGH findings (or any findings under --strict)
 *   2  MEDIUM findings only (without --strict)
 *
 * Config: optional `.claude-context-allowlist.json` at repo root:
 *   { "allowlist": [...], "maxClaudeMdLines": 100, "maxAgentsMdChars": 92000 }
 *
 * @module scripts/check-context-drift
 */

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';

import { scanInstructionFiles } from './lib/claudemd/file-scanner.mjs';
import { toSarif } from './lib/claudemd/sarif-formatter.mjs';
import { makeFenceTracker } from './lib/markdown-fence-tracker.mjs';

// ── Config schema ───────────────────────────────────────────────────────────

const ConfigSchema = z.object({
  allowlist: z.array(z.string().min(1)).optional(),
  maxClaudeMdLines: z.number().int().positive().optional(),
  maxAgentsMdChars: z.number().int().positive().optional(),
  // Retired 2026-08-01 in favour of maxAgentsMdChars. Kept in the schema ONLY
  // so a config still carrying it gets a rename message instead of `.strict()`'s
  // generic "unrecognized key" — a silently-ignored cap is worse than no cap.
  maxAgentsMdLines: z.number().int().positive().optional(),
}).strict();

// ── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_ALLOWLIST = [
  'Claude Code-only Notes',
  'Claude-only Notes',
  'Slash Commands',
  'Hooks',
  'Local Overrides',
  'Memory',
  'Memory & the `#`-key',
];

const DEFAULT_MAX_CLAUDE_MD_LINES = 80;

// AGENTS.md is loaded into EVERY session of every agent that reads it — size
// is a per-session cost, and long dossier-grade files degrade LLM recall of
// the load-bearing invariants buried in them. The file's own preamble sets the
// policy (invariants + what-it-is/when/pointer stubs; operational depth in
// docs/); this cap is the enforcement the policy previously lacked (sections
// silently sprawled past 1400 lines before 2026-07-13). Generous by design: it
// catches sprawl-by-accretion, not normal growth.
//
// Measured in CHARACTERS, not lines — switched 2026-08-01.
//
// Lines are a broken proxy for the thing this cap protects. The two largest
// per-session costs in this repo's own AGENTS.md (the nav-audit and
// visual-audit bullets, ~2.5K chars each) were ONE line apiece: condensing
// them by ~45% moved the line count by zero, while a 15-line table of
// one-word rows would have counted 15x more. The cap was blind to its own
// worst case.
//
// The number preserves the previous strictness rather than inventing a new
// budget: AGENTS.md sitting exactly AT the old 1200-line cap measured 91,201
// characters, so ~92K is the same policy expressed in the unit that actually
// costs something. Raise it only for a deliberate, justified exception — the
// intended remedy is still "move a dossier to docs/<topic>.md".
const DEFAULT_MAX_AGENTS_MD_CHARS = 92000;

// ── Config loader ───────────────────────────────────────────────────────────

/**
 * Load + validate the optional `.claude-context-allowlist.json` config.
 * In strict mode, throws on validation errors so CI fails fast. In non-strict
 * mode, warns and falls back to defaults so local exploration is forgiving.
 */
function loadConfig(repoRoot, { strict = false } = {}) {
  const defaults = {
    allowlist: DEFAULT_ALLOWLIST,
    maxClaudeMdLines: DEFAULT_MAX_CLAUDE_MD_LINES,
    maxAgentsMdChars: DEFAULT_MAX_AGENTS_MD_CHARS,
  };
  const cfgPath = path.join(repoRoot, '.claude-context-allowlist.json');
  if (!fs.existsSync(cfgPath)) return defaults;

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
  } catch (err) {
    const msg = `Failed to parse ${cfgPath}: ${err.message}`;
    if (strict) throw new Error(msg);
    process.stderr.write(`[check-context-drift] WARN: ${msg} — using defaults\n`);
    return defaults;
  }

  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(i => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    const msg = `Invalid config at ${cfgPath}:\n${issues}`;
    if (strict) throw new Error(msg);
    process.stderr.write(`[check-context-drift] WARN: ${msg}\n  using defaults\n`);
    return defaults;
  }

  if (parsed.data.maxAgentsMdLines !== undefined) {
    // Loud, not ignored. Honouring it is impossible (the cap is no longer a
    // line count) and dropping it silently would leave an operator believing
    // they had configured a limit that does nothing.
    const msg = `${cfgPath}: "maxAgentsMdLines" was retired 2026-08-01 — the AGENTS.md cap is now `
      + `measured in characters. Use "maxAgentsMdChars" (the old 1200-line cap was ~92000 chars).`;
    if (strict) throw new Error(msg);
    process.stderr.write(`[check-context-drift] WARN: ${msg}\n`);
  }

  return {
    allowlist: parsed.data.allowlist ?? DEFAULT_ALLOWLIST,
    maxClaudeMdLines: parsed.data.maxClaudeMdLines ?? DEFAULT_MAX_CLAUDE_MD_LINES,
    maxAgentsMdChars: parsed.data.maxAgentsMdChars ?? DEFAULT_MAX_AGENTS_MD_CHARS,
  };
}

// ── Markdown parsing ────────────────────────────────────────────────────────

/**
 * Track whether the current line is inside a fenced code block, following
 * CommonMark rules: opening fence is N>=3 backticks or tildes; closing
 * fence must use the SAME character AND have length >= the opening fence.
 * This means a block opened with ```` (4 backticks) is not closed by ```
 * (3 backticks) — the latter is treated as content inside the block.
 *
 * Returns an updater that takes a line and returns whether that line is
 * either inside a fence or is a fence delimiter (i.e. not a heading).
 */

/**
 * Extract h2 sections from markdown content. Fence-aware: skips heading
 * detection inside fenced code blocks (``` or ~~~) so that markdown
 * containing example headings doesn't confuse the parser.
 * @param {string} content
 * @returns {Array<{heading: string, body: string[], line: number}>}
 */
export function extractH2Sections(content) {
  const lines = content.split('\n');
  const sections = [];
  const isFenced = makeFenceTracker();
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isFenced(line)) {
      if (current) current.body.push(line);
      continue;
    }
    const m = /^## (.+?)\s*$/.exec(line);
    if (m) {
      if (current) sections.push(current);
      current = { heading: m[1].trim(), body: [], line: i + 1 };
    } else if (current) {
      current.body.push(line);
    }
  }
  if (current) sections.push(current);
  return sections;
}

/**
 * Whitespace-tolerant body comparison: collapses runs of whitespace and
 * drops empty lines before comparing.
 */
export function bodiesEqual(a, b) {
  const norm = lines => lines.map(l => l.replaceAll(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
  return norm(a) === norm(b);
}

/**
 * Check if CLAUDE.md imports AGENTS.md within the first 30 lines (covers
 * comment-led intros). Accepts `@./AGENTS.md`, `@AGENTS.md`, `@/AGENTS.md`.
 */
export function hasAgentsImport(content) {
  const lines = content.split('\n').slice(0, 30);
  return lines.some(line => /^\s*@\.?\/?AGENTS\.md\b/.test(line));
}

// ── Check rules ─────────────────────────────────────────────────────────────

function checkPair(agentsPath, claudePath, agentsContent, claudeContent, config) {
  const findings = [];
  const claudeLines = claudeContent.split('\n');

  // Check 1: import
  if (!hasAgentsImport(claudeContent)) {
    findings.push({
      ruleId: 'ctx/missing-import',
      severity: 'error',
      file: claudePath,
      line: 1,
      message: 'CLAUDE.md must contain @./AGENTS.md (or @AGENTS.md) within the first 30 lines. ' +
               'Without the import, Claude reads only the slim addendum and misses shared context.',
      semanticId: hashId(claudePath, 'missing-import'),
    });
  }

  // Check 2: allowlist
  const claudeSections = extractH2Sections(claudeContent);
  for (const section of claudeSections) {
    if (!config.allowlist.includes(section.heading)) {
      findings.push({
        ruleId: 'ctx/non-allowlist-heading',
        severity: 'error',
        file: claudePath,
        line: section.line,
        message: `CLAUDE.md has h2 heading "${section.heading}" which is not in the Claude-only allowlist. ` +
                 'Move shared content to AGENTS.md, or add this heading to .claude-context-allowlist.json.',
        semanticId: hashId(claudePath, `non-allowlist:${section.heading}`),
      });
    }
  }

  // Check 3: size
  if (claudeLines.length > config.maxClaudeMdLines) {
    findings.push({
      ruleId: 'ctx/oversized-claude-md',
      severity: 'warn',
      file: claudePath,
      line: claudeLines.length,
      message: `CLAUDE.md is ${claudeLines.length} lines, exceeding the ${config.maxClaudeMdLines}-line cap for Claude-only addenda. ` +
               'Move shared content to AGENTS.md.',
      semanticId: hashId(claudePath, 'oversized'),
    });
  }

  // Check 4: shared-section drift
  const agentsSections = extractH2Sections(agentsContent);
  const agentsByHeading = new Map(agentsSections.map(s => [s.heading, s]));
  for (const claudeSection of claudeSections) {
    const agentsSection = agentsByHeading.get(claudeSection.heading);
    if (agentsSection && !bodiesEqual(claudeSection.body, agentsSection.body)) {
      findings.push({
        ruleId: 'ctx/shared-section-drift',
        severity: 'error',
        file: claudePath,
        line: claudeSection.line,
        message: `CLAUDE.md and AGENTS.md both contain "## ${claudeSection.heading}" but bodies differ. ` +
                 'Pick a canonical home (AGENTS.md preferred for shared content) and remove the duplicate.',
        semanticId: hashId(claudePath, `drift:${claudeSection.heading}`),
      });
    }
  }

  return findings;
}

/**
 * Check 5: AGENTS.md size — the canonical shared file is loaded every session
 * by every agent that reads it; sprawl is a per-session cost and long
 * dossier-grade files degrade LLM recall of the invariants buried in them.
 * Runs for ANY AGENTS.md (paired with a CLAUDE.md or standalone) — a repo
 * without the thin-addendum split still pays the sprawl cost. The remedy is
 * the progressive-disclosure pattern AGENTS.md's own preamble mandates: keep
 * the invariant + a what/when/pointer stub, move operational depth to
 * docs/<topic>.md.
 */
function checkAgentsSize(agentsPath, agentsContent, config) {
  const agentsLines = agentsContent.split('\n');
  // The measured quantity is characters; the line number is carried only so the
  // finding can anchor to the end of the file in an editor.
  const total = agentsContent.length;
  const lineCount = agentsLines.length;
  const cap = config.maxAgentsMdChars;

  if (total > cap) {
    return [{
      ruleId: 'ctx/oversized-agents-md',
      severity: 'warn',
      file: agentsPath,
      line: lineCount,
      message: `AGENTS.md is ${total} characters (${lineCount} lines), exceeding the ${cap}-character sprawl cap. ` +
               'Condense dossier-grade sections to what-it-is/when-you-need-it/pointer stubs and move the operational depth to docs/<topic>.md ' +
               '(the progressive-disclosure pattern in AGENTS.md\'s own preamble). Raise maxAgentsMdChars in .claude-context-allowlist.json only for a deliberate, justified exception.' +
               formatCandidates(agentsLines),
      semanticId: hashId(agentsPath, 'oversized-agents'),
    }];
  }

  // Approaching the cap. Advisory ONLY — never affects the exit code, in either
  // mode. Fires here rather than at the cap because at the cap the cheap move is
  // to shave words off whatever you are adding, which keeps the file at its
  // limit forever; naming the condensable sections while there is still headroom
  // is what makes "move a dossier to docs/" the easier option.
  if (total >= Math.floor(cap * AGENTS_MD_ADVISORY_RATIO)) {
    const candidates = formatCandidates(agentsLines);
    if (!candidates) return [];
    return [{
      ruleId: 'ctx/agents-md-headroom',
      severity: 'info',
      file: agentsPath,
      line: lineCount,
      message: `AGENTS.md is ${total}/${cap} characters (${cap - total} left). Not a failure — but the next invariant ` +
               'will not fit, and shaving words to squeeze under the cap is how a file stays permanently full.' + candidates,
      semanticId: hashId(agentsPath, 'agents-headroom'),
    }];
  }
  return [];
}

/** A section is condensable when it is large AND its depth already has a home. */
const AGENTS_MD_ADVISORY_RATIO = 0.9;
// A section worth suggesting. Scaled from the previous 30-line floor at this
// file's measured ~76 chars/line, so the same sections qualify — the change is
// the unit, not the policy.
const CONDENSE_MIN_CHARS = 2300;
const DOCS_POINTER = /docs\/[A-Za-z0-9._/-]+\.md/;

/**
 * Rank H2 sections by "cheapest to condense with least loss": big, and already
 * carrying a docs/ pointer, so the depth is duplicated rather than resident.
 * A section with no pointer may still be condensable, but moving it means
 * WRITING the doc — a different-sized job, so it is not suggested here.
 *
 * @param {string[]} lines - AGENTS.md split by newline
 * @returns {string} formatted suffix (empty when nothing qualifies)
 */
function formatCandidates(lines) {
  const sections = [];
  let current = null;
  for (const line of lines) {
    if (line.startsWith('## ')) {
      if (current) sections.push(current);
      current = { title: line.slice(3).trim(), chars: 0, hasPointer: false };
    }
    if (!current) continue;
    // +1 for the newline the split removed, so section sizes sum to the file
    // size the cap is measured against.
    current.chars += line.length + 1;
    if (DOCS_POINTER.test(line)) current.hasPointer = true;
  }
  if (current) sections.push(current);

  const condensable = sections.filter(s => s.chars >= CONDENSE_MIN_CHARS && s.hasPointer);
  const ranked = [...condensable].sort((a, b) => b.chars - a.chars).slice(0, 5);
  if (ranked.length === 0) return '';

  const reclaimable = condensable.reduce((n, s) => n + s.chars, 0);

  return `\n  Condense first — large AND already pointing at docs/ (so the depth is duplicated, not resident); ` +
         `${reclaimable} chars sit in sections of this shape:\n` +
         ranked.map(s => `    ${String(s.chars).padStart(6)} chars  ## ${s.title}`).join('\n');
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function hashId(file, key) {
  return crypto.createHash('sha256').update(`${file}|${key}`).digest('hex').slice(0, 16);
}

/**
 * Group instruction files by directory and pair AGENTS.md ↔ CLAUDE.md
 * within the same directory.
 */
export function findPairs(files) {
  const byDir = new Map();
  for (const f of files) {
    const baseName = path.basename(f.path);
    if (baseName !== 'AGENTS.md' && baseName !== 'CLAUDE.md') continue;
    const dir = path.dirname(f.path) || '.';
    if (!byDir.has(dir)) byDir.set(dir, {});
    byDir.get(dir)[baseName] = f;
  }
  const pairs = [];
  for (const [dir, entry] of byDir.entries()) {
    pairs.push({
      dir,
      agents: entry['AGENTS.md'] || null,
      claude: entry['CLAUDE.md'] || null,
    });
  }
  return pairs;
}

/**
 * Run all drift checks. Exposed for testing.
 * @param {string} repoRoot
 * @param {{strict?: boolean}} [opts] - In strict mode, config validation
 *   errors throw rather than warn.
 * @returns {{findings: Array}} report
 */
export function runDriftCheck(repoRoot, opts = {}) {
  const config = loadConfig(repoRoot, { strict: !!opts.strict });
  const { files } = scanInstructionFiles(repoRoot);
  const pairs = findPairs(files);

  const findings = [];
  for (const pair of pairs) {
    if (pair.agents && pair.claude) {
      findings.push(...checkPair(
        pair.agents.path, pair.claude.path,
        pair.agents.content, pair.claude.content,
        config,
      ));
    }
    // AGENTS.md size sprawl is checked whether or not a CLAUDE.md pair
    // exists — a single-file repo pays the same per-session context cost.
    if (pair.agents) {
      findings.push(...checkAgentsSize(pair.agents.path, pair.agents.content, config));
    }
    // A CLAUDE.md alone has no drift to detect — single-file repo is fine.
  }
  return { findings };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { format: 'text', strict: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') args.repo = argv[++i];
    else if (a === '--format') args.format = argv[++i];
    else if (a === '--strict') args.strict = true;
    else if (a === '--help' || a === '-h') { showHelp(); process.exit(0); }
    else { process.stderr.write(`Unknown arg: ${a}\n`); process.exit(2); }
  }
  if (!['text', 'json', 'sarif'].includes(args.format)) {
    process.stderr.write(`Invalid --format: ${args.format} (expected text|json|sarif)\n`);
    process.exit(2);
  }
  return args;
}

function showHelp() {
  process.stdout.write(`Usage: node scripts/check-context-drift.mjs [options]

Detects drift between AGENTS.md and CLAUDE.md within a repo. Enforces:
  - CLAUDE.md imports AGENTS.md (@./AGENTS.md)
  - CLAUDE.md h2 headings only from Claude-only allowlist
  - CLAUDE.md size cap (default 80 lines)
  - Shared section bodies match between AGENTS.md and CLAUDE.md
  - AGENTS.md sprawl cap (default 92000 chars) — condense dossier sections
    to stubs + docs/<topic>.md per the progressive-disclosure pattern

Options:
  --repo <path>      Repo root (default: cwd)
  --format <fmt>     text (default) | json | sarif
  --strict           Exit non-zero on MEDIUM findings too
  -h, --help         Show this help

Config: .claude-context-allowlist.json (optional) at repo root:
  { "allowlist": ["Custom Heading", ...], "maxClaudeMdLines": 100, "maxAgentsMdChars": 92000 }
`);
}

function emitOutput(findings, format) {
  if (format === 'json') {
    process.stdout.write(JSON.stringify({ findings }, null, 2) + '\n');
    return;
  }
  if (format === 'sarif') {
    process.stdout.write(JSON.stringify(toSarif({ findings }), null, 2) + '\n');
    return;
  }
  if (findings.length === 0) {
    process.stdout.write('OK  No context drift detected.\n');
    return;
  }
  const high = findings.filter(f => f.severity === 'error');
  const med = findings.filter(f => f.severity === 'warn');
  const info = findings.filter(f => f.severity === 'info');
  // An info-only run is a clean run that has something to say. Say it without
  // dressing it as a report, or the next reader learns to ignore the header.
  if (high.length === 0 && med.length === 0) {
    process.stdout.write('OK  No context drift detected.\n');
  } else {
    process.stdout.write('Context drift report\n');
    process.stdout.write('====================\n');
    process.stdout.write(`HIGH: ${high.length}  MEDIUM: ${med.length}\n\n`);
  }
  for (const f of findings) {
    if (f.severity === 'info') continue;
    const sev = f.severity === 'error' ? 'HIGH' : 'MEDIUM';
    process.stdout.write(`[${sev}] ${f.ruleId} — ${f.file}:${f.line ?? '?'}\n`);
    process.stdout.write(`  ${f.message}\n\n`);
  }
  for (const f of info) {
    process.stdout.write(`[ADVISORY] ${f.ruleId} — ${f.file}:${f.line ?? '?'}\n`);
    process.stdout.write(`  ${f.message}\n\n`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(args.repo || '.');
  const report = runDriftCheck(repoRoot, { strict: args.strict });
  emitOutput(report.findings, args.format);

  const high = report.findings.filter(f => f.severity === 'error').length;
  const med = report.findings.filter(f => f.severity === 'warn').length;
  if (high > 0) process.exit(1);
  if (med > 0) process.exit(args.strict ? 1 : 2);
  process.exit(0);
}

// Run only when invoked as a script (Windows-safe — match by basename).
const invokedDirectly = (() => {
  try {
    const metaPath = new URL(import.meta.url).pathname.toLowerCase();
    const argvPath = process.argv[1] ? new URL(`file://${process.argv[1].replaceAll(/\\/g, '/')}`).pathname.toLowerCase() : '';
    return metaPath.endsWith('/check-context-drift.mjs') && argvPath.endsWith('/check-context-drift.mjs');
  } catch { return false; }
})();

if (invokedDirectly) {
  main().catch(err => {
    process.stderr.write(`Error: ${err.message}\n${err.stack}\n`);
    process.exit(99);
  });
}

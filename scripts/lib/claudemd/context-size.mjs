/**
 * @fileoverview The AGENTS.md size oracle, shared: the unit of measure (characters of
 * the decoded text), the default cap, the config schema that can override it, and the
 * cap resolution. `check-context-drift.mjs` (the gate) and the dashboard Home health
 * chip both import it, so they cannot grade the same file differently.
 *
 * Extracted from `check-context-drift.mjs` with behaviour unchanged. Plan:
 * docs/plans/dashboard-home-summary.md §2 (Health strip, AGENTS.md size).
 *
 * @module scripts/lib/claudemd/context-size
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/** The optional `.claude-context-allowlist.json` shape (strict: an unknown key is an error). */
export const ConfigSchema = z.object({
  allowlist: z.array(z.string().min(1)).optional(),
  maxClaudeMdLines: z.number().int().positive().optional(),
  maxAgentsMdChars: z.number().int().positive().optional(),
  // Retired 2026-08-01 in favour of maxAgentsMdChars. Kept in the schema ONLY
  // so a config still carrying it gets a rename message instead of `.strict()`'s
  // generic "unrecognized key" — a silently-ignored cap is worse than no cap.
  maxAgentsMdLines: z.number().int().positive().optional(),
}).strict();

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
export const DEFAULT_MAX_AGENTS_MD_CHARS = 92000;

/**
 * AGENTS.md size in CHARACTERS of the decoded text — never bytes (`statSync` would
 * grade non-ASCII differently from the gate).
 * @param {string} text
 * @returns {number}
 */
export function agentsMdCharCount(text) {
  return text.length;
}

/**
 * Read + validate the optional `.claude-context-allowlist.json`. The one reader: the gate and the
 * dashboard both use it, and the problem TEXT is the gate's own.
 *
 * `problem.kind`: `parse` (unreadable / not JSON), `invalid` (fails the strict schema — `data` is
 * null), `retired` (valid, but carries the retired `maxAgentsMdLines` — `data` is kept).
 *
 * @param {string} root
 * @returns {{present: boolean, data: object|null, problem: null | {kind: 'parse'|'invalid'|'retired', message: string}}}
 */
export function readContextConfig(root) {
  const cfgPath = path.join(root, '.claude-context-allowlist.json');
  if (!fs.existsSync(cfgPath)) return { present: false, data: null, problem: null };
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
  } catch (err) {
    return { present: true, data: null, problem: { kind: 'parse', message: `Failed to parse ${cfgPath}: ${err.message}` } };
  }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    return { present: true, data: null, problem: { kind: 'invalid', message: `Invalid config at ${cfgPath}:\n${issues}` } };
  }
  if (parsed.data.maxAgentsMdLines !== undefined) {
    // Loud, not ignored: honouring it is impossible (the cap is no longer a line count) and dropping it
    // silently would leave an operator believing they had configured a limit that does nothing.
    return { present: true, data: parsed.data, problem: { kind: 'retired', message: `${cfgPath}: "maxAgentsMdLines" was retired 2026-08-01 — the AGENTS.md cap is now `
      + 'measured in characters. Use "maxAgentsMdChars" (the old 1200-line cap was ~92000 chars).' } };
  }
  return { present: true, data: parsed.data, problem: null };
}

/**
 * The cap in force for `root`, and where it came from. A config problem is REPORTED, never
 * silently replaced by the default: callers that grade against the cap must surface `problem`.
 *
 * @param {string} root
 * @returns {{cap: number, source: 'config'|'default', problem: string|null}}
 */
export function resolveMaxAgentsMdChars(root) {
  const c = readContextConfig(root);
  const configured = c.data?.maxAgentsMdChars;
  return {
    cap: configured ?? DEFAULT_MAX_AGENTS_MD_CHARS,
    source: configured === undefined ? 'default' : 'config',
    problem: c.problem?.message ?? null,
  };
}

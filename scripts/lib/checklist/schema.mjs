/**
 * @fileoverview The diff-triggered checklist's entry schema and file loader
 * (verification-lessons plan, section 2.5). Zod 4, strict at every level.
 *
 * An entry is a tripwire an agent would not know to look for: a trigger (paths, symbols, patterns), the check to follow,
 * the incident that earned it, and a POSITIVE CONTROL (a path plus a synthetic diff line that must fire it) so a trigger
 * that silently stopped matching fails a test instead of reading as "nothing to check".
 *
 * `.audit-loop/checklist.json` is CONSUMER-OWNED. This repo ships the tool and never its own rules: an absent file is an
 * empty checklist (`absent: true`), which is the state every consumer starts in.
 *
 * @module scripts/lib/checklist/schema
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

export const CHECKLIST_PATH = '.audit-loop/checklist.json';
export const FIRE_PURPOSES = Object.freeze(['operational', 'control', 'replay', 'test']);

const nonEmpty = z.string().min(1);

const Trigger = z.object({
  paths: z.array(nonEmpty).min(1).optional(),
  symbols: z.array(z.string().regex(/^[A-Za-z_$][\w$]*$/, 'a symbol is an identifier')).min(1).optional(),
  patterns: z.array(nonEmpty).min(1).optional(),
  /** Where `patterns` count. Absent = every changed file, which is rarely what a pattern means (a markdown plan quoting `process.exit(` is not a call). */
  patternPaths: z.array(nonEmpty).min(1).optional(),
}).strict().superRefine((t, ctx) => {
  if (t.patternPaths && !t.patterns) {
    ctx.addIssue({ code: 'custom', path: ['patternPaths'], message: 'patternPaths scopes patterns; it needs `patterns`' });
  }
  if (!t.paths && !t.symbols && !t.patterns) {
    ctx.addIssue({ code: 'custom', message: 'a trigger needs at least one of paths, symbols, patterns' });
  }
  for (const [i, p] of (t.patterns ?? []).entries()) {
    try { new RegExp(p); } catch (e) {
      ctx.addIssue({ code: 'custom', path: ['patterns', i], message: `not a valid regular expression: ${e.message}` });
    }
  }
});

const Control = z.object({
  /** Where the synthetic change lands; must fire the entry. */
  path: nonEmpty,
  /** The synthetic added line. */
  text: nonEmpty,
  /** A path that, carrying a neutral line, must NOT fire the entry. */
  negativePath: nonEmpty.optional(),
}).strict();

export const ChecklistEntrySchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'id is a kebab-case identifier'),
  trigger: Trigger,
  check: nonEmpty,
  incident: nonEmpty,
  control: Control,
  gateContract: z.string().regex(/^[^#\s]+\.json#[^#\s]+$/, "gateContract is '<file>#<gateId>'").optional(),
  stated: nonEmpty.optional(),
}).strict().superRefine((e, ctx) => {
  // The contract quotes `stated`; the entry's `check` is what the gate-honesty check reads it from.
  if (e.stated && !e.check.includes(e.stated)) {
    ctx.addIssue({ code: 'custom', path: ['stated'], message: '`stated` must occur verbatim in `check`' });
  }
  if (e.stated && !e.gateContract) {
    ctx.addIssue({ code: 'custom', path: ['gateContract'], message: '`stated` without `gateContract` binds nothing' });
  }
});

export const ChecklistFileSchema = z.object({
  version: z.literal(1),
  entries: z.array(ChecklistEntrySchema),
}).strict().superRefine((f, ctx) => {
  const seen = new Set();
  for (const [i, e] of f.entries.entries()) {
    if (seen.has(e.id)) ctx.addIssue({ code: 'custom', path: ['entries', i, 'id'], message: `duplicate id ${e.id}` });
    seen.add(e.id);
  }
});

/**
 * Read and validate a checklist. Absent file is the supported empty state; a present-but-broken file is an error the caller
 * must surface, never an empty result (an unasked question must not render as "nothing matched").
 *
 * @param {{repoRoot?: string, file?: string}} [opts]
 * @returns {{ok: true, entries: object[], absent: boolean} | {ok: false, error: string}}
 */
export function loadChecklist({ repoRoot = process.cwd(), file = CHECKLIST_PATH } = {}) {
  const abs = path.resolve(repoRoot, file);
  let raw;
  try {
    raw = fs.readFileSync(abs, 'utf-8');
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: true, entries: [], absent: true };
    return { ok: false, error: `${file} unreadable: ${e.message}` };
  }
  let json;
  try { json = JSON.parse(raw); } catch (e) { return { ok: false, error: `${file} is not valid JSON: ${e.message}` }; }
  const parsed = ChecklistFileSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, error: `${file} invalid: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}` };
  }
  return { ok: true, entries: parsed.data.entries, absent: false };
}

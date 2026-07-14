/**
 * @fileoverview Pure logic for the AI-* commit provenance trailers
 * (plan: docs/plans/provenance-trailers-and-gate-honesty.md §F1).
 *
 * No I/O beyond an injectable fs for evidence reads — the CLI seam
 * (scripts/ship-commit.mjs) owns process concerns (git, exit codes).
 *
 * Trailer schema (v1): AI-Skill, AI-Models, AI-Gate, conditional AI-Run-ID.
 * The AI-* namespace is RESERVED: agent-supplied AI-* trailers in a commit
 * message are rejected, never merged — the helper is the only writer.
 *
 * @module scripts/lib/commit-trailers
 */

import fs from 'node:fs';
import path from 'node:path';
import { resolveAndClassify } from './sensitive-paths.mjs';

export const GATE_VALUES = Object.freeze(['passed', 'waived', 'not-run']);
export const MODEL_TOKEN_RE = /^[a-z][a-z0-9.-]*$/;
export const RUN_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
export const SKILL_NAME_RE = /^[a-z][a-z0-9-]*$/;
export const RESERVED_TRAILER_RE = /^AI-[A-Za-z0-9-]*\s*:/i;

const MESSAGE_FILE_EXAMPLE = '--message-file .claude/tmp/ship-commit-msg-1784022000000.txt';

/**
 * Canonicalise a --models value: split CSV, trim, lowercase, dedupe, sort.
 * @param {string} raw
 * @returns {{ok: true, models: string[]} | {ok: false, bad: string}}
 */
export function canonicaliseModels(raw) {
  const tokens = String(raw ?? '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (tokens.length === 0) return { ok: false, bad: String(raw ?? '') };
  for (const t of tokens) {
    if (!MODEL_TOKEN_RE.test(t)) return { ok: false, bad: raw };
  }
  return { ok: true, models: [...new Set(tokens)].sort() };
}

/**
 * Locate the trailer block of a commit message per git semantics: the LAST
 * paragraph, and only if every line in it parses as `Key: value` (with
 * whitespace-led continuation lines folding into the previous trailer).
 *
 * @param {string} text
 * @returns {{isTrailerBlock: boolean, trailers: Array<{key: string, value: string, line: number}>}}
 */
export function parseMessageTrailers(text) {
  const normalised = String(text ?? '').replace(/\r\n/g, '\n');
  const lines = normalised.split('\n');
  // Trim trailing blank lines to find the real last paragraph.
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === '') end--;
  if (end === 0) return { isTrailerBlock: false, trailers: [] };
  let start = end - 1;
  while (start > 0 && lines[start - 1].trim() !== '') start--;
  // A trailer block cannot be the whole message (the subject is not a trailer).
  if (start === 0) return { isTrailerBlock: false, trailers: [] };

  const trailers = [];
  for (let i = start; i < end; i++) {
    const line = lines[i];
    if (/^\s+\S/.test(line) && trailers.length > 0) {
      trailers[trailers.length - 1].value += ` ${line.trim()}`;
      continue;
    }
    const m = /^([A-Za-z][A-Za-z0-9-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) return { isTrailerBlock: false, trailers: [] };
    trailers.push({ key: m[1], value: m[2].trim(), line: i + 1 });
  }
  return { isTrailerBlock: true, trailers };
}

/**
 * Find reserved AI-* trailers in the message's trailer block.
 * @param {string} text
 * @returns {Array<{key: string, value: string, line: number}>}
 */
export function findReservedTrailers(text) {
  const { isTrailerBlock, trailers } = parseMessageTrailers(text);
  if (!isTrailerBlock) return [];
  return trailers.filter((t) => RESERVED_TRAILER_RE.test(`${t.key}:`));
}

/**
 * Resolve audit evidence per the §F1.3b table.
 *
 * @param {object} opts
 * @param {string} opts.auditRunPath — absolute path to .audit/last-audit-run.json
 * @param {number} opts.headCommitTs — HEAD committer time, epoch SECONDS (0 for unborn HEAD)
 * @param {boolean} [opts.noRunId] — explicit --no-run-id opt-out
 * @param {typeof fs} [opts.fsMod] — injectable for tests
 * @returns {{state: 'fresh'|'absent'|'stale'|'malformed'|'opted-out', runId: string|null, ts: string|null}}
 */
export function resolveEvidence({ auditRunPath, headCommitTs, noRunId = false, fsMod = fs }) {
  if (noRunId) return { state: 'opted-out', runId: null, ts: null };
  let raw;
  try {
    raw = fsMod.readFileSync(auditRunPath, 'utf-8');
  } catch {
    return { state: 'absent', runId: null, ts: null };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: 'malformed', runId: null, ts: null };
  }
  const runId = typeof parsed?.runId === 'string' ? parsed.runId : null;
  const ts = typeof parsed?.ts === 'string' ? parsed.ts : null;
  const evidenceMs = ts ? Date.parse(ts) : NaN;
  if (!runId || !RUN_ID_RE.test(runId) || Number.isNaN(evidenceMs)) {
    return { state: 'malformed', runId: null, ts };
  }
  const fresh = evidenceMs > headCommitTs * 1000;
  return { state: fresh ? 'fresh' : 'stale', runId, ts };
}

/**
 * Message-file safety (Gemini G1): must resolve inside repoRoot and must not
 * classify as sensitive. Delegates to the canonical classifier (fail-closed).
 *
 * @param {string} messageFile — as supplied on the CLI
 * @param {{repoRoot: string, fsMod?: typeof fs}} opts
 * @returns {null | {reason: 'escapes-repo'|'sensitive'|'unresolvable'}}
 */
export function checkMessageFileSafety(messageFile, { repoRoot, fsMod }) {
  const verdict = resolveAndClassify(messageFile, { repoRoot, ...(fsMod ? { fs: fsMod } : {}) });
  if (verdict.escapedRepo) return { reason: 'escapes-repo' };
  if (verdict.resolutionFailed) return { reason: 'unresolvable' };
  if (verdict.category === 'sensitive') return { reason: 'sensitive' };
  // Extra belt: an absolute input outside the repo that somehow classified
  // clean is still rejected by containment on the raw resolve.
  const abs = path.isAbsolute(messageFile) ? messageFile : path.resolve(repoRoot, messageFile);
  const rel = path.relative(path.resolve(repoRoot), abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return { reason: 'escapes-repo' };
  return null;
}

/**
 * Validate the full trailer input. Pure — evidence is passed in, not read.
 *
 * @param {object} input — { skill, modelsRaw, gate, messageText|null, evidence }
 * @param {{skillNames: string[]}} ctx
 * @returns {{ok: boolean, errors: Array<{field: string, custom?: string, expected?: string, got?: string, example?: string}>, values: {skill?: string, models?: string[], gate?: string, runId?: string|null}}}
 */
export function validateTrailerInput(input, { skillNames }) {
  const errors = [];
  const values = {};
  const sortedSkills = [...skillNames].sort();

  // --skill
  const skill = String(input.skill ?? '').trim().toLowerCase();
  if (!SKILL_NAME_RE.test(skill) || !skillNames.includes(skill)) {
    errors.push({
      field: '--skill',
      expected: `one of [${sortedSkills.join('|')}] (skills/ directory names)`,
      got: String(input.skill ?? ''),
      example: '--skill ship',
    });
  } else {
    values.skill = skill;
  }

  // --models
  const models = canonicaliseModels(input.modelsRaw);
  if (!models.ok) {
    errors.push({
      field: '--models',
      expected: 'comma-separated tokens matching ^[a-z][a-z0-9.-]*$',
      got: String(input.modelsRaw ?? ''),
      example: '--models claude,gpt',
    });
  } else {
    values.models = models.models;
  }

  // --gate
  const gate = String(input.gate ?? '').trim().toLowerCase();
  if (!GATE_VALUES.includes(gate)) {
    errors.push({
      field: '--gate',
      expected: 'one of passed|waived|not-run',
      got: String(input.gate ?? ''),
      example: '--gate passed',
    });
  } else {
    values.gate = gate;
  }

  // reserved trailers in the message (only when we have message text)
  if (typeof input.messageText === 'string') {
    for (const t of findReservedTrailers(input.messageText)) {
      errors.push({
        field: 'reserved-trailer',
        custom: `AGENT FIX: reserved-trailer: expected no AI-* trailers in the message (the helper is the only writer); got "${t.key}: ${t.value}" at message line ${t.line}. Example: remove the line and pass --skill ship`,
      });
    }
  }

  // gate ↔ evidence consistency (§F1.3b)
  const ev = input.evidence;
  if (ev && GATE_VALUES.includes(gate)) {
    if (ev.state === 'fresh' && gate === 'not-run') {
      errors.push({
        field: 'gate-evidence',
        custom: `AGENT FIX: gate-evidence: an audit ran after HEAD (.audit/last-audit-run.json ts ${ev.ts}) but --gate is "not-run"; pass --gate passed|waived, or --no-run-id --gate not-run if that audit was unrelated. Example: --gate passed`,
      });
    } else if (ev.state !== 'fresh' && gate !== 'not-run') {
      errors.push({
        field: 'gate-evidence',
        custom: `AGENT FIX: gate-evidence: no fresh audit evidence exists but --gate is "${gate}"; only not-run is legal without evidence. Example: --gate not-run`,
      });
    }
  }
  values.runId = ev && ev.state === 'fresh' ? ev.runId : null;

  return { ok: errors.length === 0, errors, values };
}

/**
 * Render the pinned AGENT FIX stderr lines (§F1.5 — byte format is an API).
 * @param {Array<{field: string, custom?: string, expected?: string, got?: string, example?: string}>} errors
 * @returns {string[]}
 */
export function renderAgentFixLines(errors) {
  return errors.map((e) => e.custom
    ?? `AGENT FIX: ${e.field}: expected ${e.expected}; got "${e.got}". Example: ${e.example}`);
}

/**
 * Render the message-file rejection line (taxonomy rows 6/6b — pinned).
 * @param {'missing'|'escapes-repo'|'sensitive'|'unresolvable'} kind
 * @param {string} suppliedPath
 * @returns {{field: string, custom: string}}
 */
export function messageFileError(kind, suppliedPath) {
  if (kind === 'missing') {
    return {
      field: '--message-file',
      custom: `AGENT FIX: --message-file: expected a readable non-empty file; got "${suppliedPath}" (ENOENT). Example: ${MESSAGE_FILE_EXAMPLE}`,
    };
  }
  if (kind === 'empty') {
    return {
      field: '--message-file',
      custom: `AGENT FIX: --message-file: expected a readable non-empty file; got "${suppliedPath}" (empty or whitespace-only). Example: ${MESSAGE_FILE_EXAMPLE}`,
    };
  }
  return {
    field: '--message-file',
    custom: `AGENT FIX: --message-file: must resolve inside the repo and not be a sensitive path; got "${suppliedPath}" (${kind}). Example: ${MESSAGE_FILE_EXAMPLE}`,
  };
}

/**
 * Format the canonical AI-* trailer block lines (fixed key order).
 * @param {{skill: string, models: string[], gate: string, runId?: string|null}} v
 * @returns {string[]}
 */
export function formatTrailerBlock(v) {
  const lines = [
    `AI-Skill: ${v.skill}`,
    `AI-Models: ${v.models.join(',')}`,
    `AI-Gate: ${v.gate}`,
  ];
  if (v.runId) lines.push(`AI-Run-ID: ${v.runId}`);
  return lines;
}

/**
 * Compose the final commit message (§F1.3a rendering invariants):
 * CRLF→LF, trailing blank lines trimmed, the AI-* block joins an existing
 * trailer block or is appended after exactly one blank line, final newline
 * ensured. The input text is NEVER mutated on disk (Gemini G2) — callers
 * write the return value to a helper-owned temp file.
 *
 * @param {string} messageText
 * @param {{skill: string, models: string[], gate: string, runId?: string|null}} values
 * @returns {string}
 */
export function composeFinalMessage(messageText, values) {
  const normalised = String(messageText).replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '');
  const body = normalised.replace(/\n+$/, '');
  const block = formatTrailerBlock(values).join('\n');
  const { isTrailerBlock } = parseMessageTrailers(body);
  const sep = isTrailerBlock ? '\n' : '\n\n';
  return `${body}${sep}${block}\n`;
}

export const _internals = { MESSAGE_FILE_EXAMPLE };

/**
 * @fileoverview The coordinator-context file: a standard part of a handover (docs/plans/fleet-handover-winddown.md §2.3).
 *
 * Chat-only coordination context (open decisions, rulings, peer handovers, paths that must not be lost) dies with the
 * account. On 2026-10-21 it was written by hand; this makes it a templated file the departing coordinator fills in,
 * prepare embeds in the handover, and receive prints FIRST.
 *
 * One file per repo, in fleet's own directory in the git common dir (on disk, so it survives the account; never
 * tracked). A section is judged `filled` only when it has a substantive body (an explicit `none` counts): the
 * skeleton is all `placeholder`, and deleting the markers without writing anything is all `empty`.
 *
 * One context per SWITCH: a context already handed over and received, and unchanged since, is `stale` for the next
 * switch. The cycle boundary is a fact the tooling already observes, the receive of a handover, recorded as a
 * `handover-<id>.received.json` marker beside the manifest it received.
 *
 * @module scripts/lib/fleet/handover-context
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { samePath } from '../harness-paths.mjs';
import { fleetDir } from './registry.mjs';

export const CONTEXT_SECTIONS = Object.freeze([
  'Peer handovers',
  'Waiting on the user',
  'Decided this stint (do not re-ask)',
  'In flight (repo state)',
  'CI state at the switch',
  'Leftovers on disk (do not lose)',
  'In-session timers',
  'Pending cards filed as proposals',
  'Working-style notes',
]);
export const CONTEXT_PLACEHOLDER = '<!-- winddown: fill this in -->';
// Stands in for the placeholder comment while every other comment is removed; not text a coordinator would write.
const SENTINEL = '@@winddown-placeholder@@';
export const CONTEXT_MAX_BYTES = 64 * 1024;
export const CONTEXT_FILE = 'context.md';

/** Where a repo's context lives, or null when its fleet directory cannot be resolved. */
export function contextPath(repo) {
  try { return path.join(fleetDir(repo), 'handover', CONTEXT_FILE); } catch { return null; }
}

/** The templated file: every required heading with one placeholder. */
export function contextSkeleton(repo) {
  return [`# Coordinator context: ${path.basename(path.resolve(repo))}`, '',
    'Names only, never key values. `none` is a valid body. Replace each placeholder; delete nothing else.', '',
    ...CONTEXT_SECTIONS.flatMap((name) => [`## ${name}`, '', CONTEXT_PLACEHOLDER, ''])].join('\n');
}

/**
 * Judge each required section of `text`: `missing` (no heading), `placeholder` (the marker is still there), `empty` (nothing left once
 * comments and whitespace go), or `filled`.
 *
 * Headings and bodies are read from the EFFECTIVE document: HTML comments are removed from the whole text FIRST (the placeholder marker
 * alone is kept, as a sentinel, so an untouched skeleton still reads as one), and a heading inside a fenced code block is not a
 * heading. A required heading that only exists inside a comment is therefore `missing`, not a populated section.
 * @returns {Record<string, 'missing'|'placeholder'|'empty'|'filled'>}
 */
export function judgeSections(text) {
  const effective = String(text).split(CONTEXT_PLACEHOLDER).join(SENTINEL).replace(/<!--[\s\S]*?-->/g, '');
  const bodies = new Map();
  let current = null;
  let fence = null; // the OPENING delimiter: a fence closes only on the same character, at least as long
  for (const line of effective.split(/\r?\n/)) {
    const m = /^\s*(`{3,}|~{3,})/.exec(line);
    if (m && fence === null) fence = m[1];
    else if (m && fence !== null && m[1][0] === fence[0] && m[1].length >= fence.length && /^\s*[`~]+\s*$/.test(line)) fence = null;
    const h = fence !== null ? null : /^##\s+(.+?)\s*$/.exec(line);
    if (h) { current = h[1]; if (!bodies.has(current)) bodies.set(current, []); continue; }
    if (current !== null) bodies.get(current).push(line);
  }
  const out = {};
  for (const name of CONTEXT_SECTIONS) {
    if (!bodies.has(name)) { out[name] = 'missing'; continue; }
    const body = bodies.get(name).join('\n');
    out[name] = body.includes(SENTINEL) ? 'placeholder' : body.trim() ? 'filled' : 'empty';
  }
  return out;
}

/**
 * Read a repo's context. `absent` / `unreadable` / `too-large` are states of their own, never an empty context.
 * @returns {{state: 'absent'|'unreadable'|'too-large'|'ok', path: string|null, reason?: string, bytes?: number, sha256?: string, text?: string, sections?: object}}
 */
export function readContext(repo) {
  const file = contextPath(repo);
  if (!file) return { state: 'unreadable', path: null, reason: 'the fleet directory could not be resolved' };
  let buf;
  try { buf = fs.readFileSync(file); } catch (e) { return e.code === 'ENOENT' ? { state: 'absent', path: file } : { state: 'unreadable', path: file, reason: e.code ?? e.message }; }
  if (buf.length > CONTEXT_MAX_BYTES) return { state: 'too-large', path: file, bytes: buf.length };
  const text = buf.toString('utf8');
  return { state: 'ok', path: file, bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex'), text, sections: judgeSections(text) };
}

/** Create the skeleton where none exists. Exclusive: an existing file is never touched. @returns {'created'|'exists'|string} */
export function ensureSkeleton(repo) {
  const file = contextPath(repo);
  if (!file) return 'the fleet directory could not be resolved';
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contextSkeleton(repo), { flag: 'wx' });
    return 'created';
  } catch (e) { return e.code === 'EEXIST' ? 'exists' : `could not create ${file} (${e.code ?? e.message})`; }
}

/** Why a context is not ready for THIS switch, as reasons (empty = ready). `stale` is the caller's measurement. */
export function contextReasons(ctx, stale = null) {
  if (ctx.state === 'absent') return ['coordinator context missing'];
  if (ctx.state === 'unreadable') return [`coordinator context unreadable (${ctx.reason})`];
  if (ctx.state === 'too-large') return [`coordinator context is ${ctx.bytes} bytes, over the ${CONTEXT_MAX_BYTES} limit`];
  const bad = Object.entries(ctx.sections).filter(([, s]) => s !== 'filled').map(([n, s]) => `${n} (${s})`);
  const out = bad.length ? [`coordinator context incomplete: ${bad.join(', ')}`] : [];
  if (stale) out.push(`coordinator context is identical to the one handed over in ${stale}: update it for this switch`);
  return out;
}

// ── one context per switch ──────────────────────────────────────────────────

const RECEIVED_RE = /^handover-(.+)\.received\.json$/;

/** Record that the manifest at `manifestDir` was received. Exclusive create; a failure is returned, never thrown. */
export function writeReceivedMarker(manifestDir, id, info) {
  try {
    fs.writeFileSync(path.join(manifestDir, `handover-${id}.received.json`), `${JSON.stringify({ receivedAt: new Date().toISOString(), ...info })}\n`, { flag: 'wx' });
    return null;
  } catch (e) { return e.code === 'EEXIST' ? null : `${e.code ?? e.message}`; }
}

/**
 * Is `sha256` (the context of `repo`) byte-identical to one embedded in a handover that was RECEIVED? Looks in every
 * given handover directory. A manifest that cannot be read is skipped: staleness only ever refuses on evidence.
 * @returns {string|null} the id of the received handover, or null
 */
export function contextHandedOver(repo, sha256, handoverDirs) {
  for (const dir of handoverDirs) {
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      const id = RECEIVED_RE.exec(n)?.[1];
      if (!id) continue;
      try {
        const m = JSON.parse(fs.readFileSync(path.join(dir, `handover-${id}.json`), 'utf8'));
        if ((m.scope?.repos ?? []).some((r) => r.context?.sha256 === sha256 && r.path && samePath(r.path, repo))) return id;
      } catch { /* an unreadable manifest is not evidence */ }
    }
  }
  return null;
}

/** The manifest's per-repo context entry (optional there: a manifest written before this change has none). */
export const ContextEntrySchema = z.object({
  state: z.enum(['absent', 'unreadable', 'too-large', 'ok']), path: z.string().nullable().optional(), reason: z.string().optional(), bytes: z.number().optional(),
  sha256: z.string().optional(), text: z.string().optional(), sections: z.record(z.string(), z.string()).optional(),
}).strict();

/** The handover directories of the given repos: where manifests and their received markers live. */
export function handoverDirsOf(repos) {
  return repos.flatMap((r) => { try { return [path.join(fleetDir(r), 'handover')]; } catch { return []; } });
}

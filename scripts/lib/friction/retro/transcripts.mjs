/**
 * @fileoverview Enumerate and stream Claude Code session transcripts — LOCAL DISK
 * ONLY (plan docs/plans/harness-retro.md §2 component 1).
 *
 * Transcripts are `<configDir>/projects/<slug>/<sessionId>.jsonl` plus subagent
 * files under `<slug>/<sessionId>/subagents/agent-*.jsonl`. A worktree session
 * gets its OWN slug dir (`C--GIT-<repo>--claude-worktrees-<name>`), so "this
 * repo's sessions" is not one slug dir: a session's repo is derived from the
 * first `cwd` its records carry (`repo-resolve.mjs`).
 *
 * This module reads; it never writes, copies or uploads a transcript. Raw records
 * are handed to a callback and dropped — only what `signals.mjs` derives survives.
 * Lines are streamed (`readline`): the corpus measured 1.9 GB / week on one
 * machine (2026-11-16), so slurping is not an option.
 *
 * @module scripts/lib/friction/retro/transcripts
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

/**
 * Directory entries, distinguishing ABSENCE (ENOENT/ENOTDIR → empty) from a
 * FAILURE to read (anything else → counted in `errors`). An unreadable dir must
 * never look like an empty one (cluster-A audit H17).
 */
function dirEntries(d, errors) {
  try { return fs.readdirSync(d, { withFileTypes: true }); } catch (err) {
    if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') errors.push({ path: d, code: err?.code ?? 'EREAD' });
    return [];
  }
}

/**
 * Every transcript file, main and subagent, with its mtime. NOT filtered by
 * time here: a session is SELECTED by any constituent file's mtime and then
 * ASSEMBLED from all of its files (`scan.mjs`), so a rescan that sees only one
 * changed file still reads the whole session (plan R3-H1).
 * @param {{configDir: string}} opts
 * @returns {{projectsDir: string, projectsDirExists: boolean, enumerationErrors: Array<{path: string, code: string}>,
 *            files: Array<{path: string, slug: string, subagent: boolean, mtimeMs: number}>}}
 */
export function listTranscriptFiles({ configDir }) {
  const projectsDir = path.join(configDir, 'projects');
  const errors = [];
  const top = dirEntries(projectsDir, errors);
  const projectsDirExists = top.length > 0 || fs.existsSync(projectsDir);
  const files = [];
  const statOrError = (p) => { try { return fs.statSync(p).mtimeMs; } catch (err) { errors.push({ path: p, code: err?.code ?? 'ESTAT' }); return null; } };
  for (const slugEnt of top) {
    if (!slugEnt.isDirectory()) continue;
    const slugDir = path.join(projectsDir, slugEnt.name);
    for (const ent of dirEntries(slugDir, errors)) {
      const p = path.join(slugDir, ent.name);
      if (ent.isFile() && ent.name.endsWith('.jsonl')) {
        const mtimeMs = statOrError(p);
        if (mtimeMs !== null) files.push({ path: p, slug: slugEnt.name, subagent: false, mtimeMs });
      } else if (ent.isDirectory() && ent.name !== 'memory') {
        const subDir = path.join(p, 'subagents');
        for (const sub of dirEntries(subDir, errors)) {
          if (!sub.isFile() || !sub.name.endsWith('.jsonl')) continue;
          const sp = path.join(subDir, sub.name);
          const mtimeMs = statOrError(sp);
          if (mtimeMs !== null) files.push({ path: sp, slug: slugEnt.name, subagent: true, mtimeMs });
        }
      }
    }
  }
  files.sort((x, y) => x.path.localeCompare(y.path));
  return { projectsDir, projectsDirExists, enumerationErrors: errors, files };
}


/**
 * Stream one transcript, calling `onRecord(record)` for each parsed line.
 * Unparseable lines are COUNTED, never thrown on (a truncated last line is the
 * normal state of a live session's file — the scan marks such a session
 * incomplete so it is reported but not persisted).
 * @param {string} filePath
 * @param {(record: object) => void} onRecord
 * @returns {Promise<{lines: number, parsed: number, unparseable: number, readError: string|null}>}
 */
export async function streamTranscript(filePath, onRecord) {
  const stats = { lines: 0, parsed: 0, unparseable: 0, readError: null };
  let stream;
  try {
    stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      stats.lines++;
      let rec;
      try { rec = JSON.parse(line); } catch { stats.unparseable++; continue; }
      if (rec && typeof rec === 'object') { stats.parsed++; onRecord(rec); } else stats.unparseable++;
    }
  } catch (err) {
    stats.readError = err?.code || err?.message || String(err);
  } finally {
    stream?.destroy();
  }
  return stats;
}

/** True when a record is a turn a HUMAN typed (not a tool result, not meta). */
export function isHumanTurn(rec) {
  if (rec?.type === 'user' && rec.origin?.kind === 'human' && !rec.isMeta) {
    const c = rec.message?.content;
    if (typeof c === 'string') return true;
    if (Array.isArray(c)) return c.some((b) => b?.type === 'text') && !c.some((b) => b?.type === 'tool_result');
  }
  return false;
}

/**
 * @fileoverview `fleet handover`: scheduled tasks exported in full (fleet p-20261014064525-f69b).
 *
 * The scheduler's registration lives with the account, so a switch used to carry only each task's id and description,
 * and the operator rebuilt the rest from memory. Now `prepare` copies every task's `SKILL.md` into the private handover
 * directory (inside `<git-common-dir>`, never a repo tree) with the sha256 of the bytes WRITTEN, and joins the cron,
 * `fireAt`, `enabled` and `lastRunAt` from a snapshot the operator saved from `list_scheduled_tasks` (the CLI cannot read
 * the scheduler). `receive` re-hashes the copies.
 *
 * **Publication contract.** Validate the snapshot first (a malformed file, a duplicate id, or an id with no task on disk is
 * an error, never a silent skip); stage every copy in a sibling staging directory; hash what was written; rename the
 * staging directory into place; only then may the caller publish the manifest. Any failure removes the staged copies and
 * is reported, so a handover never lists an export that is not there.
 *
 * Plan: docs/plans/fleet-chips-and-merge-friction.md section 2.4 items 1 and 6.
 *
 * @module scripts/lib/fleet/handover-tasks
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { scheduledTasksDir } from '../harness-paths.mjs';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const SCHEDULE_KEYS = Object.freeze(['cronExpression', 'fireAt', 'enabled', 'lastRunAt']);
const NO_SNAPSHOT = 'unknown (no --scheduler-snapshot)';

/**
 * Validate the operator's `list_scheduled_tasks` snapshot against the tasks on disk.
 * @param {string} text the file's content
 * @param {string[]} taskIds the ids found on disk
 * @returns {{ok: true, byId: Map<string, object>} | {ok: false, reason: string}}
 */
export function parseSchedulerSnapshot(text, taskIds) {
  let v;
  try { v = JSON.parse(text); } catch (e) { return { ok: false, reason: `the scheduler snapshot is not JSON (${e.message})` }; }
  // `list_scheduled_tasks` answers either a bare array or an object holding one; anything else is not a snapshot.
  const list = Array.isArray(v) ? v : Array.isArray(v?.tasks) ? v.tasks : null;
  if (!list) return { ok: false, reason: 'the scheduler snapshot is not a JSON array of tasks (or an object with a "tasks" array)' };
  const onDisk = new Set(taskIds);
  const byId = new Map();
  for (const [i, t] of list.entries()) {
    const id = t?.id ?? t?.taskId;
    if (typeof id !== 'string' || !id) return { ok: false, reason: `snapshot entry ${i} has no string "id"` };
    if (byId.has(id)) return { ok: false, reason: `snapshot names task "${id}" twice` };
    if (!onDisk.has(id)) return { ok: false, reason: `snapshot names task "${id}", which has no SKILL.md under this config root` };
    const schedule = {};
    for (const k of SCHEDULE_KEYS) if (t[k] !== undefined) schedule[k] = t[k];
    if (schedule.enabled !== undefined && typeof schedule.enabled !== 'boolean') return { ok: false, reason: `snapshot task "${id}": "enabled" is not a boolean` };
    for (const k of ['cronExpression', 'fireAt', 'lastRunAt']) {
      if (schedule[k] !== undefined && schedule[k] !== null && typeof schedule[k] !== 'string') return { ok: false, reason: `snapshot task "${id}": "${k}" is not a string` };
    }
    byId.set(id, schedule);
  }
  return { ok: true, byId };
}

/**
 * Copy every task's SKILL.md into `destDir/<id>/SKILL.md`, all or nothing.
 * @param {object} a
 * @param {string} a.configDir
 * @param {string[]} a.ids
 * @param {string} a.destDir `<handover dir>/handover-<id>-tasks`
 * @param {{readFile?: Function, writeFile?: Function, rename?: Function, rm?: Function}} [a.io] injectable for fault tests
 * @returns {{ok: true, exports: Map<string, {path: string, sha256: string, bytes: number}>} | {ok: false, reason: string}}
 */
export function stageTaskExports({ configDir, ids, destDir, io = {} }) {
  const readFile = io.readFile ?? fs.readFileSync;
  const writeFile = io.writeFile ?? fs.writeFileSync;
  const rename = io.rename ?? fs.renameSync;
  const rm = io.rm ?? ((p) => fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
  const staging = `${destDir}.staging-${process.pid}`;
  // A rollback that could not remove its copies says so: "nothing was published" must never hide leftovers.
  const cleanup = () => { try { rm(staging); return null; } catch (e) { return `the staging directory ${staging} could not be removed (${e.code ?? e.message})`; } };
  const exports = new Map();
  try {
    fs.mkdirSync(staging, { recursive: true });
    for (const id of ids) {
      const src = path.join(scheduledTasksDir(configDir), id, 'SKILL.md');
      let body;
      try { body = readFile(src); } catch (e) { throw new Error(`cannot read task ${id} (${e.code ?? e.message})`); }
      const out = path.join(staging, id, 'SKILL.md');
      fs.mkdirSync(path.dirname(out), { recursive: true });
      try { writeFile(out, body); } catch (e) { throw new Error(`cannot copy task ${id} (${e.code ?? e.message})`); }
      // Read back what is ON DISK and compare it with the source: a short or corrupted write is a copy failure, never
      // an export whose hash would certify the damage. The recorded hash is of the verified bytes.
      const written = fs.readFileSync(out);
      if (sha256(written) !== sha256(body)) throw new Error(`the copy of task ${id} does not match its source (${written.length} of ${body.length} bytes)`);
      exports.set(id, { path: path.join(destDir, id, 'SKILL.md'), sha256: sha256(written), bytes: written.length });
    }
    try { rename(staging, destDir); } catch (e) { throw new Error(`cannot publish the task copies (${e.code ?? e.message})`); }
  } catch (e) {
    const left = cleanup();
    return { ok: false, reason: left ? `${e.message}; ${left}` : e.message, leftover: left ? [staging] : [] };
  }
  return { ok: true, exports };
}

/**
 * The manifest's task entries: id, description, the export (when staged) and the schedule (from the snapshot, or
 * `scheduleUnknown` naming why not).
 */
export function joinTaskRecords(tasks, exports, byId) {
  return tasks.map((t) => ({
    ...t,
    ...(exports?.has(t.id) ? { export: exports.get(t.id) } : {}),
    ...(byId ? (byId.has(t.id) ? { schedule: byId.get(t.id) } : { scheduleUnknown: 'not in the scheduler snapshot (not registered?)' }) : { scheduleUnknown: NO_SNAPSHOT }),
  }));
}

/** receive: re-hash each exported copy against the manifest. */
export function verifyTaskExports(tasks) {
  return tasks.map((t) => {
    if (!t.export) return { id: t.id, export: 'none' };
    let buf;
    try { buf = fs.readFileSync(t.export.path); } catch (e) { return { id: t.id, export: 'missing', reason: e.code ?? e.message }; }
    return { id: t.id, export: sha256(buf) === t.export.sha256 ? 'ok' : 'mismatch' };
  });
}

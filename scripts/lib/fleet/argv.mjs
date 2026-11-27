/**
 * @fileoverview /fleet argv parsing — per-verb flag tables, value/arity checks,
 * and the one verb (`start`) whose flags REPEAT and BIND to each other.
 *
 * Unknown flags are rejected by `cli-io.mjs:assertKnownFlags`, called from
 * `scripts/fleet.mjs` with `knownFlagsFor(verb)` (the repo's guard against a
 * silently ignored flag on a mutating command); this module adds what that
 * helper deliberately does not: value presence, arity, and
 * `start`'s `--paths` → preceding `--task` binding.
 *
 * @module scripts/lib/fleet/argv
 */
import { ArgvError } from '../cli-io.mjs';

/** Per-verb flag tables. `bool` takes no value, `value` takes one, `repeat` may recur. */
export const VERBS = Object.freeze({
  status: { bool: ['--json', '--all', '--fetch'], value: [], repeat: [], positionals: [0, 0] },
  add: { bool: ['--json', '--all'], value: ['--id'], repeat: [], positionals: [0, 1] },
  claim: { bool: ['--json', '--override', '--clear-waiting'], value: ['--id', '--intent', '--paths', '--host-session', '--worktree', '--base'], repeat: ['--waiting-on'], positionals: [0, 0] },
  ready: { bool: ['--json', '--clear-waiting'], value: ['--id'], repeat: ['--waiting-on'], positionals: [0, 0] },
  touch: { bool: ['--json', '--clear-waiting'], value: ['--id'], repeat: ['--waiting-on', '--unwait'], positionals: [0, 0] },
  hold: { bool: ['--json', '--notify'], value: ['--reason', '--note', '--id'], repeat: [], positionals: [1, 1] },
  start: { bool: ['--json'], value: [], repeat: ['--task', '--paths'], positionals: [0, 0] },
  repair: { bool: ['--json'], value: ['--quarantine'], repeat: [], positionals: [0, 0] },
  release: { bool: ['--json', '--abandoned', '--stale-ready', '--apply'], value: ['--id', '--days'], repeat: [], positionals: [0, 0] },
  'archive-check': { bool: ['--json'], value: ['--id', '--min-kb'], repeat: [], positionals: [0, 1] },
  prune: { bool: ['--json', '--apply', '--remote', '--include-fresh'], value: [], repeat: [], positionals: [0, 0] },
  archive: { bool: ['--json', '--apply', '--discard-ignored', '--include-fresh'], value: [], repeat: [], positionals: [1, 1] },
  handover: { bool: ['--json', '--dry-run', '--allow-older', '--scheduler-checked'], value: ['--from', '--scheduler-snapshot', '--winddown-waived'], repeat: ['--repo'], positionals: [1, 1] },
  next: { bool: ['--json'], value: ['--id'], repeat: [], positionals: [0, 0] },
  restack: { bool: ['--json', '--replace'], value: ['--onto', '--from'], repeat: [], positionals: [0, 1] },
  directive: {
    bool: ['--json', '--list', '--all'],
    value: ['--to', '--kind', '--reason', '--ref', '--note', '--expires-hours', '--ack', '--outcome', '--id'], repeat: [], positionals: [0, 0],
  },
  decision: { bool: ['--json'], value: ['--scope', '--words-file', '--expires', '--id', '--host-session', '--to', '--train'], repeat: [], positionals: [1, 2] },
  propose: { bool: ['--json'], value: ['--what', '--where', '--why', '--evidence', '--theme', '--blocked-by', '--id'], repeat: [], positionals: [0, 0] },
  proposal: { bool: ['--json'], value: ['--folded', '--queued', '--declined', '--done', '--id'], repeat: [], positionals: [1, 1] },
  proposals: { bool: ['--json', '--all'], value: [], repeat: [], positionals: [0, 0] },
  lease: {
    bool: ['--json', '--force', '--clear', '--cancel', '--over-held', '--over-turn', '--end-turn'],
    value: ['--kind', '--for', '--pid', '--token', '--note', '--id', '--reason', '--from', '--until', '--hours', '--clear-window', '--limit', '--window', '--to', '--minutes', '--wait', '--timeout', '--priority'], repeat: [], positionals: [1, 256],
  },
  land: {
    bool: ['--json', '--dry-run', '--accept-rerun', '--serial', '--include-stale', '--ship-batch', '--rollup'],
    value: ['--select', '--tier', '--approve', '--confirm', '--reconcile', '--resume', '--abandon', '--hold', '--accept-guard'], repeat: [], positionals: [0, 0],
  },
});

/** Every flag a verb accepts — the list the CLI hands to `assertKnownFlags`. */
export const knownFlagsFor = (verb) => { const spec = VERBS[verb]; return [...spec.bool, ...spec.value, ...spec.repeat]; };

/** Split `--name=value` into [name, value|undefined]. */
function splitFlag(tok) {
  const eq = tok.indexOf('=');
  return eq === -1 ? [tok, undefined] : [tok.slice(0, eq), tok.slice(eq + 1)];
}

/**
 * Parse one verb's arguments (everything after the verb).
 * @param {string} verb
 * @param {string[]} rest
 * @returns {{flags: Record<string, any>, positionals: string[], tasks?: Array<{task: string, paths: string[]|null}>}}
 * @throws {ArgvError}
 */
export function parseVerbArgs(verb, rest) {
  const spec = VERBS[verb];
  const flags = {}; const positionals = []; const tasks = [];
  let afterDashes = false; // POSIX `--`: everything after it is positional, never a flag
  for (let i = 0; i < rest.length; i += 1) {
    const tok = rest[i];
    if (afterDashes || !tok.startsWith('--')) { positionals.push(tok); continue; }
    if (tok === '--') { afterDashes = true; continue; }
    const [name, inline] = splitFlag(tok);
    if (spec.bool.includes(name)) {
      // A boolean takes no value: `--accept-rerun=false` must never be read as true (or as false).
      if (inline !== undefined) throw new ArgvError(`fleet ${verb}: ${name} takes no value (got ${JSON.stringify(inline)}); pass the bare flag or omit it`);
      flags[name] = true; continue;
    }
    const takesValue = spec.value.includes(name) || spec.repeat.includes(name);
    if (!takesValue) continue; // assertKnownFlags already refused anything unknown
    let val = inline;
    if (val === undefined) {
      const next = rest[i + 1];
      if (next === undefined || next.startsWith('--')) throw new ArgvError(`fleet ${verb}: ${name} requires a value`);
      val = next; i += 1;
    }
    if (verb === 'start') {
      if (name === '--task') {
        if (val.trim() === '') throw new ArgvError('fleet start: --task must not be empty');
        tasks.push({ task: val, paths: null });
      } else {
        const last = tasks[tasks.length - 1];
        if (!last) throw new ArgvError('fleet start: --paths must follow the --task it belongs to');
        if (last.paths !== null) throw new ArgvError(`fleet start: --paths given twice for task ${JSON.stringify(last.task)}`);
        last.paths = val.split(',').map((s) => s.trim()).filter(Boolean);
      }
    } else if (spec.repeat.includes(name)) (flags[name] ??= []).push(val);
    else flags[name] = val;
  }
  const [min, max] = spec.positionals;
  if (positionals.length < min || positionals.length > max) {
    throw new ArgvError(`fleet ${verb}: expected ${min === max ? min : `${min}-${max}`} positional argument(s), got ${positionals.length}`);
  }
  if (verb === 'start') {
    if (!tasks.length) throw new ArgvError('fleet start: at least one --task is required');
    return { flags, positionals, tasks: tasks.map((t) => ({ task: t.task, paths: t.paths ?? [] })) };
  }
  return { flags, positionals };
}

/** Split a `--paths a,b` value into patterns. */
export const splitPaths = (v) => String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

/**
 * Parse `--waiting-on kind:ref[:note]` — split on the FIRST TWO colons only, so
 * the note may contain colons (a `ref` therefore cannot).
 * @returns {{kind: string, ref: string, note: string|null}}
 * @throws {ArgvError}
 */
export function parseWaitingOn(spec) {
  const a = spec.indexOf(':');
  if (a < 1) throw new ArgvError(`--waiting-on ${JSON.stringify(spec)}: expected kind:ref[:note]`);
  const b = spec.indexOf(':', a + 1);
  const kind = spec.slice(0, a);
  const ref = b === -1 ? spec.slice(a + 1) : spec.slice(a + 1, b);
  const note = b === -1 ? null : spec.slice(b + 1);
  if (!ref) throw new ArgvError(`--waiting-on ${JSON.stringify(spec)}: ref is empty`);
  return { kind, ref, note };
}

/** One line per verb for `fleet <verb> --help` (the full contract is in skills/fleet/SKILL.md and its references). */
export const VERB_SUMMARY = Object.freeze({
  status: 'every session, branch and worktree, with overlaps and landing order (read-only)',
  add: 'adopt existing work (a branch, #PR, or --all) as a session',
  claim: 'register this session: its intent and the paths it will touch; BLOCKED (exit 3) on overlapping live work',
  ready: 'mark this session ready to land at its current head',
  touch: 'renew this session\'s lease; record or clear what it waits on',
  hold: 'pause (on) or resume (off) heavy runs for every session',
  start: 'create worktrees and claims for a batch of tasks',
  repair: 'quarantine an invalid registry record',
  release: 'retire this session\'s claim (done, or --abandoned); --stale-ready finds dead ready marks in bulk',
  'archive-check': 'is a worktree safe to remove? (read-only)',
  prune: 'list (or --apply) removable merged/abandoned branches and worktrees',
  archive: 'snapshot a worktree to a tag, then remove it (dry run unless --apply)',
  handover: 'move the fleet to another account (prepare / receive)',
  next: 'this session\'s obligations at a checkpoint, plus FYI lines and the note stamp',
  restack: 'rebase a branch onto base, verifying the result',
  directive: 'post, list or ack a coordinator directive',
  decision: 'record, revoke or list a user decision in their exact words (record | revoke <id> | list); grants only its scope, never a merge',
  propose: 'record a finding for the coordinator (durable)',
  proposal: 'fold, queue or decline one recorded finding',
  proposals: 'list recorded findings',
  lease: 'the machine-wide heavy slot: acquire, run, release, status, announce, peak, wait, log, grant, turn',
  land: 'build a combined test train of ready sessions; --approve lands it (exit 4 = it ran red)',
});

/**
 * `fleet <verb> --help`: the verb's line and every flag it accepts, from the SAME spec the parser enforces (so the help cannot
 * advertise a flag the CLI would refuse). `extra` lists sub-commands (lease).
 */
export function verbHelp(verb, { extra = null, only = null, sub = null } = {}) {
  const spec = VERBS[verb];
  if (!spec) return null;
  const [min, max] = spec.positionals ?? [0, 0];
  const pos = sub ? ` ${sub}` : max === 0 ? '' : min === 0 ? ' [arg]' : ' <arg>';
  // `only` (a sub-command's accepted flags) narrows the list, so `lease run --help` never advertises a flag `run` refuses.
  const keep = (f) => !only || only.includes(f);
  const flags = [
    ...spec.bool.filter(keep).map((f) => `  ${f}`),
    ...spec.value.filter(keep).map((f) => `  ${f} <value>`),
    ...spec.repeat.filter(keep).map((f) => `  ${f} <value>   (repeatable)`),
  ];
  return [`usage: fleet ${verb}${pos} [flags]`, `  ${VERB_SUMMARY[verb] ?? ''}`, ...(extra ? [extra] : []), 'flags:', ...flags, ''].join('\n');
}

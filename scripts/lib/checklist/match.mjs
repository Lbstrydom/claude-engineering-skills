/**
 * @fileoverview The diff-triggered checklist matcher (verification-lessons plan, section 2.5): ONE matcher shared by the
 * CLI (`scripts/checklist.mjs`) and the `/audit-code` pipeline, so the two can never disagree about what a change fires.
 *
 * Two acquisition modes, because the two moments an agent can be told something differ in what exists:
 *  - PRE-EDIT (`files`): the paths the agent intends to touch. Matches `paths`, and `symbols` against the CURRENT on-disk
 *    content of those files (a file that does not exist yet matches paths only). `patterns` are NEVER used: there is no diff.
 *  - POST-EDIT (`diffPath` = a unified-diff file, or `base` = `git diff <base>` of staged + unstaged work PLUS untracked
 *    files read whole, with `--find-renames`): both ends of a rename match `paths`, a deleted file matches `paths`, and
 *    `patterns` (and `symbols`, word-bounded) run over added AND removed lines.
 * `trigger.patternPaths` scopes where `patterns` count (absent = every changed file). Symbols are matched only in code files (a doc that names a symbol is a mention, not a use). Trigger kinds are ORed: an entry fires when any declared kind matches.
 *
 * Honesty: an unresolvable base or unreadable diff is a structured failure (`ok:false`), never "no matches". Every
 * evaluation, zero-match ones included, is appended to a gitignored log by `recordFires`, because a checklist whose firing
 * is never measured cannot be tuned or pruned.
 *
 * @module scripts/lib/checklist/match
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { globMatch } from '../glob-match.mjs';
import { resolvePushRange } from '../push-range.mjs';
import { sanitizeGitEnv } from '../git-env-sanitize.mjs';
import { FIRE_PURPOSES } from './schema.mjs';

export const FIRES_LOG = path.join('.audit', 'checklist-fires.jsonl');
const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_EVIDENCE = 3;

const norm = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '');

/**
 * Parse a unified diff into per-file records. Headers are only read before the first hunk: inside a hunk a content line
 * may itself begin `+++ ` or `diff --git`-looking text.
 *
 * @param {string} text
 * @returns {Array<{path: string, oldPath: string|null, status: 'added'|'deleted'|'renamed'|'modified', added: string[], removed: string[]}>}
 */
export function parseUnifiedDiff(text) {
  const files = [];
  let cur = null;
  let inHunk = false;
  for (const raw of String(text).split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.startsWith('diff --git ')) {
      const rest = line.slice('diff --git '.length);
      let a = null;
      let b = null;
      for (let i = rest.indexOf(' b/'); i !== -1; i = rest.indexOf(' b/', i + 1)) {
        if (rest.slice(2, i) === rest.slice(i + 3)) { a = rest.slice(2, i); b = a; break; }
      }
      if (a === null) {
        const m = /^a\/(.+) b\/(.+)$/.exec(rest);
        if (m) { a = m[1]; b = m[2]; }
      }
      cur = { path: norm(b ?? rest), oldPath: a !== null && a !== b ? norm(a) : null, status: 'modified', added: [], removed: [] };
      files.push(cur);
      inHunk = false;
      continue;
    }
    if (!cur) continue;
    if (!inHunk) {
      if (line.startsWith('new file mode')) cur.status = 'added';
      else if (line.startsWith('deleted file mode')) cur.status = 'deleted';
      else if (line.startsWith('rename from ')) { cur.oldPath = norm(line.slice('rename from '.length)); cur.status = 'renamed'; }
      else if (line.startsWith('rename to ')) cur.path = norm(line.slice('rename to '.length));
      else if (line.startsWith('@@')) inHunk = true;
      continue;
    }
    if (line.startsWith('@@')) continue;
    if (line.startsWith('+')) cur.added.push(line.slice(1));
    else if (line.startsWith('-')) cur.removed.push(line.slice(1));
  }
  return files;
}

function gitRunner(cwd) {
  return (args) => {
    try {
      return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: sanitizeGitEnv(cwd) }).trim() || null;
    } catch { return null; }
  };
}

function readContained(cwd, rel) {
  try {
    const abs = path.resolve(cwd, rel);
    const relBack = path.relative(cwd, abs);
    if (relBack.startsWith('..') || path.isAbsolute(relBack)) return null;
    const st = fs.statSync(abs);
    if (!st.isFile() || st.size > MAX_READ_BYTES) return null;
    return fs.readFileSync(abs, 'utf-8');
  } catch { return null; }
}

/**
 * The working-tree change against `base`: `git diff <base>` (staged + unstaged, renames detected) plus every untracked,
 * non-ignored file read whole as an all-added file.
 *
 * @returns {{ok: true, files: object[], base: string} | {ok: false, code: 'UNRESOLVABLE_BASE'|'DIFF_FAILED', message: string}}
 */
export function collectGitDiff({ base, cwd = process.cwd(), run = gitRunner(cwd) } = {}) {
  const range = resolvePushRange({ env: { AUDIT_PUSH_RANGE_BASE: String(base ?? ''), AUDIT_PUSH_RANGE_HEAD: 'HEAD' }, requireExplicit: true, run });
  if (!range.ok) return { ok: false, code: 'UNRESOLVABLE_BASE', message: range.message };
  let text;
  try {
    text = execFileSync('git', ['-c', 'core.quotepath=false', 'diff', '--find-renames', '--no-ext-diff', '--no-textconv', '--unified=0', range.base], {
      cwd, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], env: sanitizeGitEnv(cwd),
    });
  } catch (e) {
    return { ok: false, code: 'DIFF_FAILED', message: `git diff ${range.base} failed: ${String(e.message).split('\n')[0]}` };
  }
  const files = parseUnifiedDiff(text);
  let untracked = '';
  try {
    untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd, encoding: 'utf-8', env: sanitizeGitEnv(cwd), stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    return { ok: false, code: 'DIFF_FAILED', message: `git ls-files --others failed: ${String(e.message).split('\n')[0]}` };
  }
  for (const rel of untracked.split('\0').filter(Boolean)) {
    const body = readContained(cwd, rel);
    files.push({ path: norm(rel), oldPath: null, status: 'added', added: body !== null && !body.includes('\0') ? body.split('\n') : [], removed: [] });
  }
  return { ok: true, files, base: range.base };
}

/** A symbol is only a USE in code: a markdown or JSON file that merely names `createAnthropicClient` is a mention, and would fire every entry on every doc edit. */
const CODE_FILE = /\.(mjs|cjs|js|jsx|ts|tsx|mts|cts|vue|sql|py)$/i;

const symbolRe = (name) => new RegExp(`(?<![\\w$])${name.replace(/[$]/g, '\\$')}(?![\\w$])`);

/**
 * PURE matching.
 *
 * @param {object} args
 * @param {object[]} args.entries
 * @param {'files'|'diff'} args.mode
 * @param {string[]} [args.files] - files mode: the paths the agent will touch
 * @param {object[]} [args.diffFiles] - diff mode: parseUnifiedDiff records (+ untracked)
 * @param {(rel: string) => string|null} [args.readFile] - files mode: current on-disk content, null when absent
 * @returns {Array<{id: string, via: Array<'path'|'symbol'|'pattern'>, evidence: string[]}>}
 */
export function matchEntries({ entries, mode, files = [], diffFiles = [], readFile = () => null }) {
  const fired = [];
  const candidatePaths = mode === 'files'
    ? files.map(norm)
    : diffFiles.flatMap((f) => (f.oldPath && f.oldPath !== f.path ? [f.path, f.oldPath] : [f.path]));
  for (const entry of entries) {
    const via = new Set();
    const evidence = [];
    const note = (kind, text) => { via.add(kind); if (evidence.length < MAX_EVIDENCE) evidence.push(text); };
    const { paths = [], symbols = [], patterns = [] } = entry.trigger;

    for (const p of candidatePaths) {
      if (paths.some((g) => globMatch(norm(g), p))) note('path', p);
    }
    if (symbols.length) {
      const res = symbols.map(symbolRe);
      if (mode === 'files') {
        for (const f of files.map(norm).filter((p) => CODE_FILE.test(p))) {
          const body = readFile(f);
          if (body === null) continue;
          if (res.some((re) => re.test(body))) note('symbol', f);
        }
      } else {
        for (const f of diffFiles.filter((d) => CODE_FILE.test(d.path))) {
          if ([...f.added, ...f.removed].some((l) => res.some((re) => re.test(l)))) note('symbol', f.path);
        }
      }
    }
    if (mode === 'diff' && patterns.length) {
      const res = patterns.map((p) => new RegExp(p));
      const scope = entry.trigger.patternPaths;
      const inScope = (f) => !scope || [f.path, f.oldPath].some((p) => p && scope.some((g) => globMatch(norm(g), p)));
      for (const f of diffFiles.filter(inScope)) {
        const hit = [...f.added, ...f.removed].find((l) => res.some((re) => re.test(l)));
        if (hit !== undefined) note('pattern', `${f.path}: ${hit.trim().slice(0, 80)}`);
      }
    }
    if (via.size) fired.push({ id: entry.id, via: [...via], evidence });
  }
  return fired;
}

/**
 * Append one evaluation to the fires log. The ONE recording boundary: never throws (a telemetry failure must not fail a
 * run), and says so through `recorded:false` rather than pretending.
 *
 * @returns {{recorded: boolean, error?: string}}
 */
export function recordFires({ logPath, runId, sha = null, purpose, entriesEvaluated, fired, mode = null, now = () => new Date() }) {
  if (!FIRE_PURPOSES.includes(purpose)) return { recorded: false, error: `purpose must be one of ${FIRE_PURPOSES.join('|')}, got ${JSON.stringify(purpose)}` };
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const row = { runId, sha, purpose, entriesEvaluated, fired: fired.map((f) => f.id ?? f), mode, at: now().toISOString() };
    fs.appendFileSync(logPath, `${JSON.stringify(row)}\n`);
    return { recorded: true };
  } catch (e) {
    return { recorded: false, error: String(e?.message ?? e) };
  }
}

/**
 * Match a checklist against a change and record the evaluation.
 *
 * @param {object} args
 * @param {object[]} args.entries
 * @param {string[]} [args.files] - pre-edit mode (ignored when `diffPath`/`base` is given)
 * @param {string} [args.diffPath] - post-edit: a unified-diff FILE (the audit's `--diff`)
 * @param {string} [args.base] - post-edit: `git diff <base>` + untracked files; resolved through push-range
 * @param {'operational'|'control'|'replay'|'test'} args.purpose
 * @param {string} [args.cwd]
 * @param {string} [args.logPath]
 * @param {string} [args.runId]
 * @param {boolean} [args.record=true]
 * @returns {{ok: true, mode: string, fired: object[], evaluated: number, inputFiles: number, recorded: boolean, runId: string, patternsSkipped: boolean}
 *          | {ok: false, code: string, message: string}}
 */
export function matchChecklist({ entries, files, diffPath, base, purpose, cwd = process.cwd(), logPath, runId = randomUUID(), record = true }) {
  if (!FIRE_PURPOSES.includes(purpose)) return { ok: false, code: 'BAD_PURPOSE', message: `purpose must be one of ${FIRE_PURPOSES.join('|')}, got ${JSON.stringify(purpose)}` };
  let mode;
  let fired;
  let inputFiles;
  if (diffPath || base) {
    mode = 'diff';
    let diffFiles;
    if (diffPath) {
      let text;
      try { text = fs.readFileSync(path.resolve(cwd, diffPath), 'utf-8'); } catch (e) {
        return { ok: false, code: 'DIFF_UNREADABLE', message: `--diff ${diffPath} is not a readable file (${e.code ?? e.message})` };
      }
      diffFiles = parseUnifiedDiff(text);
    } else {
      const got = collectGitDiff({ base, cwd });
      if (!got.ok) return got;
      diffFiles = got.files;
    }
    inputFiles = diffFiles.length;
    fired = matchEntries({ entries, mode, diffFiles });
  } else {
    mode = 'files';
    const list = (files ?? []).filter(Boolean);
    inputFiles = list.length;
    fired = matchEntries({ entries, mode, files: list, readFile: (rel) => readContained(cwd, rel) });
  }
  let recorded = false;
  if (record) {
    const run = gitRunner(cwd);
    const sha = run(['rev-parse', '--verify', '--quiet', 'HEAD']);
    const rec = recordFires({ logPath: logPath ?? path.join(cwd, FIRES_LOG), runId, sha, purpose, entriesEvaluated: entries.length, fired, mode });
    recorded = rec.recorded;
    if (!rec.recorded) process.stderr.write(`  [checklist] fires log not written (non-blocking): ${rec.error}\n`);
  }
  return { ok: true, mode, fired, evaluated: entries.length, inputFiles, recorded, runId, patternsSkipped: mode === 'files' };
}

/** The `<checklist>` block `/audit-code` injects (mirrors `<requirements_rubric>`); '' when nothing fired. */
export function renderChecklistBlock(fired, entries) {
  if (!fired.length) return '';
  const byId = new Map(entries.map((e) => [e.id, e]));
  const lines = fired.map((f) => {
    const e = byId.get(f.id);
    return `- [${f.id}] ${e.check}\n  (incident: ${e.incident}; fired by ${f.via.join('+')}: ${f.evidence.join(' | ')})`;
  });
  return `<checklist>\nThese repo tripwires are triggered by this change. Verify the diff does not repeat the incident each one records.\n\n${lines.join('\n')}\n</checklist>`;
}

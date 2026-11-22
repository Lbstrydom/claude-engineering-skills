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
import { SOURCE_CODE_EXTENSION_ALTERNATION } from '../file-taxonomy.mjs';

export const FIRES_LOG = path.join('.audit', 'checklist-fires.jsonl');
const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_EVIDENCE = 3;

const norm = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '');

const C_ESCAPES = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '\\': 92, '"': 34 };

/**
 * Decode one git C-quoted path (`"a\tb"`, `"caf\303\251"`): C-style escapes, with octal escapes read as BYTES and the whole
 * thing decoded as UTF-8. Input includes the surrounding quotes.
 */
export function unquoteGitPath(token) {
  // By CODE POINT, never by UTF-16 unit: a supplementary character (an emoji) is two units, and encoding each lone surrogate
  // separately would corrupt it.
  const cps = Array.from(token.slice(1, -1));
  const bytes = [];
  for (let i = 0; i < cps.length; i++) {
    const ch = cps[i];
    if (ch !== '\\') { bytes.push(...Buffer.from(ch, 'utf8')); continue; }
    const next = cps[i + 1];
    if (/[0-7]/.test(next ?? '')) {
      const oct = /^[0-7]{1,3}/.exec(cps.slice(i + 1, i + 4).join(''))[0];
      bytes.push(parseInt(oct, 8) & 0xff);
      i += oct.length;
    } else if (next in C_ESCAPES) { bytes.push(C_ESCAPES[next]); i += 1; } else { bytes.push(92); }
  }
  return Buffer.from(bytes).toString('utf8');
}

/** A `rename from` / `rename to` value: quoted exactly like a header path, so it is decoded exactly like one. */
function plainOrQuoted(raw) {
  const t = raw.trimEnd();
  return norm(t.startsWith('"') ? unquoteGitPath(t) : t);
}

/** Read one possibly-quoted token off the front of `s`: `[decoded, rest]`. */
function readPathToken(s) {
  if (s[0] !== '"') return [s, ''];
  let i = 1;
  while (i < s.length && s[i] !== '"') i += s[i] === '\\' ? 2 : 1;
  return [unquoteGitPath(s.slice(0, i + 1)), s.slice(i + 1).trimStart()];
}

/** A header path: quoted or plain, minus git's `a/` / `b/` prefix, `/dev/null` and a trailing timestamp tab. */
function headerPath(raw) {
  const t = raw.trimEnd();
  if (t === '/dev/null') return null;
  const [p] = t.startsWith('"') ? readPathToken(t) : [t.split('\t')[0]];
  return norm(p.replace(/^[ab]\//, ''));
}

function parseGitHeader(rest) {
  let a;
  let b;
  if (rest.startsWith('"')) {
    let after;
    [a, after] = readPathToken(rest);
    [b] = readPathToken(after);
  } else if (rest.includes(' "b/')) {
    const i = rest.indexOf(' "b/');
    a = rest.slice(0, i);
    [b] = readPathToken(rest.slice(i + 1));
  } else {
    for (let i = rest.indexOf(' b/'); i !== -1; i = rest.indexOf(' b/', i + 1)) {
      if (rest.slice(2, i) === rest.slice(i + 3)) { a = rest.slice(0, i); b = rest.slice(i + 1); break; }
    }
    if (a === undefined) { const m = /^(a\/.+) (b\/.+)$/.exec(rest); [a, b] = m ? [m[1], m[2]] : [rest, rest]; }
  }
  // Only the `a/` `b/` prefixes are understood. A diff written with `diff.noprefix` or `diff.mnemonicPrefix` (`c/` `w/` ...) would
  // otherwise be mis-parsed silently, so it is refused.
  if (!a.startsWith('a/') || !b.startsWith('b/')) throw new DiffParseError(`unsupported diff path prefixes in header: ${JSON.stringify(rest.slice(0, 60))} (only a/ and b/ are understood)`);
  return [norm(a.slice(2)), norm(b.slice(2))];
}

/** A patch whose hunk bodies do not match their `@@` counts (truncated, or mangled): refused, never read as fewer lines. */
export class DiffParseError extends Error {}

/**
 * Parse a unified diff into per-file records. Both `git diff` output and a plain `---`/`+++` unified diff are accepted.
 * Hunk bodies are read by the line counts in each `@@` header, so a content line that looks like a header is never taken
 * for one. Git-quoted paths are decoded.
 *
 * @param {string} text
 * @returns {Array<{path: string, oldPath: string|null, status: 'added'|'deleted'|'renamed'|'modified', added: string[], removed: string[]}>}
 */
export function parseUnifiedDiff(text) {
  const files = [];
  const lines = String(text).split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  if (lines.at(-1) === '') lines.pop(); // the split artefact of a final newline is not a context line
  let cur = null;
  let remOld = 0;
  let remNew = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (remOld > 0 || remNew > 0) {
      if (line.startsWith('+')) { cur.added.push(line.slice(1)); remNew--; } else if (line.startsWith('-')) { cur.removed.push(line.slice(1)); remOld--; } else if (line.startsWith(' ') || line === '') { remOld--; remNew--; } else if (!line.startsWith('\\')) {
        throw new DiffParseError(`hunk body does not match its @@ counts near ${JSON.stringify(line.slice(0, 40))}`);
      }
      if (remOld < 0 || remNew < 0) throw new DiffParseError('hunk body has more lines than its @@ counts');
      continue;
    }
    if (line.startsWith('diff --git ')) {
      const [a, b] = parseGitHeader(line.slice('diff --git '.length));
      cur = { path: b, oldPath: a !== b ? a : null, status: 'modified', added: [], removed: [], fromGit: true, sawHeaders: false };
      files.push(cur);
    } else if (line.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')) {
      const oldP = headerPath(line.slice(4));
      const newP = headerPath(lines[i + 1].slice(4));
      if (cur?.fromGit && !cur.sawHeaders) {
        cur.sawHeaders = true; // git's own headers: the `diff --git` line already named the paths
        if (oldP === null) cur.status = 'added'; else if (newP === null) { cur.status = 'deleted'; cur.path = oldP; }
      } else {
        cur = { path: newP ?? oldP, oldPath: oldP && newP && oldP !== newP ? oldP : null, status: oldP === null ? 'added' : newP === null ? 'deleted' : 'modified', added: [], removed: [], fromGit: false, sawHeaders: true };
        files.push(cur);
      }
      i += 1;
    } else if (cur && line.startsWith('new file mode')) cur.status = 'added';
    else if (cur && line.startsWith('deleted file mode')) cur.status = 'deleted';
    else if (cur && line.startsWith('rename from ')) { cur.oldPath = plainOrQuoted(line.slice('rename from '.length)); cur.status = 'renamed'; } else if (cur && line.startsWith('rename to ')) cur.path = plainOrQuoted(line.slice('rename to '.length));
    else if (cur && /^[+ -]/.test(line)) throw new DiffParseError(`diff body line outside any hunk (extra lines past the @@ counts?): ${JSON.stringify(line.slice(0, 40))}`);
    else if (line.startsWith('@@')) {
      const m = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
      if (!m || !cur) throw new DiffParseError(`malformed hunk header: ${JSON.stringify(line.slice(0, 60))}`); // counts are never defaulted
      remOld = Number(m[1] ?? 1);
      remNew = Number(m[2] ?? 1);
    } else if (cur && (line.startsWith('Binary files ') || line === 'GIT binary patch')) cur.binary = true;
  }
  if (remOld > 0 || remNew > 0) throw new DiffParseError('truncated patch: a hunk ends before its @@ counts are met');
  for (const f of files) { delete f.fromGit; delete f.sawHeaders; }
  return files;
}

function gitRunner(cwd) {
  return (args) => {
    try {
      return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: sanitizeGitEnv(cwd) }).trim() || null;
    } catch { return null; }
  };
}

/**
 * Read a repo file for matching. Containment is checked on the REALPATH: a symlink that resolves outside the repo is
 * excluded and never read. `{skip:'absent'}` is the only skip that is not a problem (the file does not exist yet).
 *
 * @returns {{body: string} | {skip: 'absent'|'outside-repo'|'oversize'|'unreadable'}}
 */
export function readContained(cwd, rel) {
  const abs = path.resolve(cwd, rel);
  try {
    fs.lstatSync(abs);
  } catch (e) {
    return { skip: e.code === 'ENOENT' ? 'absent' : 'unreadable' };
  }
  try {
    const real = fs.realpathSync(abs);
    const back = path.relative(fs.realpathSync(cwd), real);
    // `..` as a WHOLE path segment only: a file named `..config.mjs` is inside the repo.
    if (back === '..' || back.startsWith(`..${path.sep}`) || path.isAbsolute(back)) return { skip: 'outside-repo' };
    const st = fs.statSync(real);
    if (!st.isFile()) return { skip: 'unreadable' };
    if (st.size > MAX_READ_BYTES) return { skip: 'oversize' };
    return { body: fs.readFileSync(real, 'utf-8') };
  } catch { return { skip: 'unreadable' }; }
}

/**
 * The working-tree change against `base`: `git diff <base>` (staged + unstaged, renames detected) plus every untracked,
 * non-ignored file read whole as an all-added file.
 *
 * An untracked file this module cannot read whole (oversize, unreadable) is listed in `incomplete`; one that resolves outside the
 * repo is listed in `excluded` and never read. Changed files are judged by git's own diff text, which is not size-limited.
 *
 * @returns {{ok: true, files: object[], base: string, incomplete: object[], excluded: object[]} | {ok: false, code: 'UNRESOLVABLE_BASE'|'DIFF_FAILED'|'DIFF_UNPARSEABLE', message: string}}
 */
export function collectGitDiff({ base, cwd = process.cwd(), run = gitRunner(cwd) } = {}) {
  const range = resolvePushRange({ env: { AUDIT_PUSH_RANGE_BASE: String(base ?? ''), AUDIT_PUSH_RANGE_HEAD: 'HEAD' }, requireExplicit: true, run });
  if (!range.ok) return { ok: false, code: 'UNRESOLVABLE_BASE', message: range.message };
  let text;
  try {
    // Pinned so a developer's ~/.gitconfig (diff.noprefix, diff.mnemonicPrefix) cannot change the header shape the parser reads.
    text = execFileSync('git', ['-c', 'core.quotepath=false', '-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false', 'diff', '--find-renames', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', '--unified=0', range.base], {
      cwd, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], env: sanitizeGitEnv(cwd),
    });
  } catch (e) {
    return { ok: false, code: 'DIFF_FAILED', message: `git diff ${range.base} failed: ${String(e.message).split('\n')[0]}` };
  }
  let files;
  try { files = parseUnifiedDiff(text); } catch (e) {
    if (e instanceof DiffParseError) return { ok: false, code: 'DIFF_UNPARSEABLE', message: `git diff output is not well-formed: ${e.message}` };
    throw e;
  }
  if (text.trim() && files.length === 0) return { ok: false, code: 'DIFF_UNPARSEABLE', message: 'git diff produced output that parsed to zero file records' };
  const incomplete = [];
  const excluded = [];
  let untracked = '';
  try {
    untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd, encoding: 'utf-8', env: sanitizeGitEnv(cwd), stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    return { ok: false, code: 'DIFF_FAILED', message: `git ls-files --others failed: ${String(e.message).split('\n')[0]}` };
  }
  for (const rel of untracked.split('\0').filter(Boolean)) {
    const got = readContained(cwd, rel);
    if (got.skip === 'outside-repo') excluded.push({ path: norm(rel), reason: got.skip });
    else if (got.skip) incomplete.push({ path: norm(rel), reason: got.skip });
    const binary = got.body !== undefined && got.body.includes('\0');
    if (binary) incomplete.push({ path: norm(rel), reason: 'binary' }); // patterns cannot see a NUL-bearing file's lines
    files.push({ path: norm(rel), oldPath: null, status: 'added', added: got.body !== undefined && !binary ? got.body.split('\n') : [], removed: [] });
  }
  for (const f of files.filter((x) => x.binary)) incomplete.push({ path: f.path, reason: 'binary' });
  return { ok: true, files, base: range.base, incomplete, excluded };
}

/** A symbol is only a USE in code: a markdown or JSON file that merely names `createAnthropicClient` is a mention, and would fire every entry on every doc edit. */
const CODE_FILE = new RegExp(`\\.(${SOURCE_CODE_EXTENSION_ALTERNATION})$`, 'i');

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
        // Added lines belong to the file as it is NOW, removed lines to the file as it WAS: each is judged by its own path's kind,
        // and the evidence names that path (a code file renamed to a doc, or the reverse, is still seen on the code side).
        const hits = (lines) => lines.some((l) => res.some((re) => re.test(l)));
        for (const f of diffFiles) {
          if (CODE_FILE.test(f.path) && hits(f.added)) note('symbol', f.path);
          const was = f.oldPath ?? f.path;
          if (CODE_FILE.test(was) && hits(f.removed)) note('symbol', was);
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
export function recordFires({ logPath, runId, sha = null, purpose, entriesEvaluated, fired, mode = null, incomplete = 0, now = () => new Date() }) {
  if (!FIRE_PURPOSES.includes(purpose)) return { recorded: false, error: `purpose must be one of ${FIRE_PURPOSES.join('|')}, got ${JSON.stringify(purpose)}` };
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const row = { runId, sha, purpose, entriesEvaluated, fired: fired.map((f) => f.id ?? f), mode, incomplete, at: now().toISOString() };
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
  const incomplete = [];
  const excluded = [];
  if (diffPath || base) {
    mode = 'diff';
    let diffFiles;
    if (diffPath) {
      let text;
      try { text = fs.readFileSync(path.resolve(cwd, diffPath), 'utf-8'); } catch (e) {
        return { ok: false, code: 'DIFF_UNREADABLE', message: `--diff ${diffPath} is not a readable file (${e.code ?? e.message})` };
      }
      try { diffFiles = parseUnifiedDiff(text); } catch (e) {
        if (e instanceof DiffParseError) return { ok: false, code: 'DIFF_UNPARSEABLE', message: `--diff ${diffPath} is not a well-formed unified diff: ${e.message}` };
        throw e;
      }
      if (text.trim() && diffFiles.length === 0) return { ok: false, code: 'DIFF_UNPARSEABLE', message: `--diff ${diffPath} parsed to zero file records: not a unified diff` };
      for (const f of diffFiles.filter((x) => x.binary)) incomplete.push({ path: f.path, reason: 'binary' });
    } else {
      const got = collectGitDiff({ base, cwd });
      if (!got.ok) return got;
      diffFiles = got.files;
      incomplete.push(...got.incomplete);
      excluded.push(...got.excluded);
    }
    inputFiles = diffFiles.length;
    fired = matchEntries({ entries, mode, diffFiles });
  } else {
    mode = 'files';
    const list = (files ?? []).filter(Boolean).map(norm);
    inputFiles = list.length;
    const contents = new Map();
    if (entries.some((e) => e.trigger.symbols?.length)) {
      for (const rel of list.filter((p) => CODE_FILE.test(p))) {
        const got = readContained(cwd, rel);
        if (got.body !== undefined) contents.set(rel, got.body);
        else if (got.skip === 'outside-repo') excluded.push({ path: rel, reason: got.skip });
        else if (got.skip !== 'absent') incomplete.push({ path: rel, reason: got.skip });
      }
    }
    fired = matchEntries({ entries, mode, files: list, readFile: (rel) => contents.get(rel) ?? null });
  }
  let recorded = false;
  if (record) {
    const run = gitRunner(cwd);
    const sha = run(['rev-parse', '--verify', '--quiet', 'HEAD']);
    const rec = recordFires({ logPath: logPath ?? path.join(cwd, FIRES_LOG), runId, sha, purpose, entriesEvaluated: entries.length, fired, mode, incomplete: incomplete.length });
    recorded = rec.recorded;
    if (!rec.recorded) process.stderr.write(`  [checklist] fires log not written (non-blocking): ${rec.error}\n`);
  }
  if (incomplete.length) {
    return {
      ok: false, code: 'INCOMPLETE', incomplete, excluded, fired, mode, recorded,
      message: `evaluation incomplete: could not read ${incomplete.map((i) => `${i.path} (${i.reason})`).join(', ')}`,
    };
  }
  return { ok: true, mode, fired, evaluated: entries.length, inputFiles, recorded, runId, patternsSkipped: mode === 'files', excluded };
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

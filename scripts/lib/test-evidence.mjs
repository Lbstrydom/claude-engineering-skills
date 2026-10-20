/**
 * @fileoverview Hash-bound test evidence (docs/plans/copilot-feedback-item4.md, Cluster C). `record` runs a command
 * between two content-identity captures and stores what happened; `check` recomputes the identity and answers exactly
 * one of `reusable` / `invalidated` / `unknown`. NOTHING here skips a test: `unknown` means rerun, and only an exact
 * match against a stable, green, non-vacuous record is `reusable`.
 *
 * Two identities, deliberately separate:
 *  - the INVOCATION identity is the record's key (argv, repo-relative cwd, ignore globs, probes, platform, arch), so
 *    another command, directory or machine can never reuse a record; it reads `unknown` (no record), not `invalidated`.
 *  - the CONTENT identity is stored in the record: git's NORMALISED content of the worktree (the same technique as
 *    `AI-Audited-Tree`: a throwaway index, `add -A`, `write-tree`), a `filteredTree` with the operator's ignore globs
 *    removed (reuse is decided on it), probe digests and the line-ending settings. It is NOT a byte hash: a path with a
 *    clean/smudge filter makes the answer `unknown`, and a gitignored input is invisible (the documented limit).
 *
 * The identity is captured before AND after the run; only the reuse identity decides `stable`.
 *
 * @module scripts/lib/test-evidence
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { z } from 'zod';
import { atomicWriteFileSync, canonicalizeEol } from './file-io.mjs';
import { fmtMs, toShellExitCode } from './cli-io.mjs';
import { gitWorktreeTree } from './vcs.mjs';
import { describeSpawnFailure, resolveSpawnTarget } from './spawn-target.mjs';

export const TEST_EVIDENCE_SCHEMA = 'test-evidence/v1';

/** Filesystem timestamps can lag the wall clock by one tick; a report written right at the spawn must not be refused for it. */
const MTIME_SLACK_MS = 20;
const PROBE_TIMEOUT_MS = 60_000;
const SAFE = Number.MAX_SAFE_INTEGER;

/** Stated in every output: the one thing a content hash cannot see. */
export const KNOWN_LIMIT = 'limit: gitignored inputs (.env, a venv, generated config) are not part of the tested content, so a change to one is '
  + 'invisible here. Bind what matters with --toolchain "<probe command>" (for example "pip freeze").';

// ── Schema ───────────────────────────────────────────────────────────────────

const Sha = z.string().regex(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/);
const Count = z.number().int().nonnegative().max(SAFE);
const CountsSchema = z.strictObject({ tests: Count, failures: Count, errors: Count, skipped: Count, passed: Count });
const OutcomeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('exited'), code: z.number().int() }),
  z.strictObject({ kind: z.literal('signal'), signal: z.string().min(1) }),
  z.strictObject({ kind: z.literal('spawn-error'), code: z.string().nullable() }),
]);
const IdentitySchema = z.strictObject({
  fullTree: Sha,
  filteredTree: Sha,
  toolchain: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)),
  lineEndings: z.strictObject({ autocrlf: z.string().nullable(), eol: z.string().nullable() }),
});
export const RecordSchema = z.strictObject({
  schema: z.literal(TEST_EVIDENCE_SCHEMA),
  key: z.string().regex(/^[0-9a-f]{64}$/),
  command: z.array(z.string()).min(1),
  cwd: z.string(),
  platform: z.string().min(1),
  arch: z.string().min(1),
  ignore: z.array(z.string()),
  toolchainProbes: z.array(z.string()),
  identity: IdentitySchema,
  outcome: OutcomeSchema,
  stable: z.boolean(),
  unstableReason: z.string().nullable(),
  unstablePaths: z.array(z.string()),
  wallMs: z.number().int().nonnegative(),
  finishedAt: z.string().refine((s) => Number.isFinite(Date.parse(s)), 'an ISO timestamp'),
  counts: CountsSchema.nullable(),
  countsDiagnostic: z.string().nullable(),
});

// ── Invocation identity ──────────────────────────────────────────────────────

/** The record key: sha256 of the canonical invocation. Ignore globs and probes are sorted (order is not identity). */
export function recordKey({ argv, cwdRel, ignore = [], toolchain = [], platform, arch }) {
  const canonical = JSON.stringify({
    v: 1, argv, cwd: cwdRel, ignore: [...ignore].sort(), toolchain: [...toolchain].sort(), platform, arch,
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

export function recordPathFor(commonDir, key) {
  return path.join(commonDir, 'test-evidence', `${key}.json`);
}

/** A probe is an argv, never a shell line: whitespace-split, single and double quotes group, backslash is literal (Windows paths). */
export function splitCommand(line) {
  const out = [];
  let cur = '';
  let quote = null;
  let started = false;
  for (const ch of String(line)) {
    if (quote) {
      if (ch === quote) quote = null; else cur += ch;
    } else if (ch === '"' || ch === "'") { quote = ch; started = true; }
    else if (/\s/.test(ch)) {
      if (started || cur) { out.push(cur); cur = ''; started = false; }
    } else cur += ch;
  }
  if (quote) throw new Error(`unterminated ${quote} quote in command: ${line}`);
  if (started || cur) out.push(cur);
  if (out.length === 0) throw new Error('empty command');
  return out;
}

// ── Content identity ─────────────────────────────────────────────────────────

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function git(cwd, env, args, input) {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], windowsHide: true }).replace(/\r?\n$/, '');
}

function gitConfigValue(cwd, env, key) {
  try { return git(cwd, env, ['config', '--get', key]); } catch { return null; } // exit 1 = unset
}

/** An ignore glob becomes a glob-magic pathspec. Magic of the operator's own (`:(top)`, `:!`) is refused: a glob is a glob. */
function toPathspec(glob) {
  if (typeof glob !== 'string' || !glob.trim() || glob.includes('\0')) throw new Error('--ignore needs a non-empty glob');
  if (/^[:!]/.test(glob) || path.isAbsolute(glob) || glob.split(/[\\/]/).includes('..')) {
    throw new Error(`--ignore ${JSON.stringify(glob)}: use a repo-relative glob (no leading ":" or "!", no absolute path, no "..")`);
  }
  return `:(glob)${glob.replace(/\\/g, '/')}`;
}

function defaultRunProbe(argv, { cwd, env }) {
  const target = resolveSpawnTarget({ cmd: argv[0], args: argv.slice(1) });
  const r = spawnSync(target.cmd, target.args, { cwd, env, shell: false, windowsHide: true, timeout: PROBE_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) return { ok: false, reason: describeSpawnFailure({ cmd: argv[0], spawnError: r.error.message, target, cwd }) };
  if (r.status !== 0) return { ok: false, reason: `exited ${r.status ?? `by signal ${r.signal}`}` };
  return { ok: true, stdout: r.stdout };
}

/**
 * The current content identity of the worktree `cwd` is in.
 *
 * @param {{cwd: string, ignore?: string[], toolchain?: string[], env?: NodeJS.ProcessEnv,
 *          runProbe?: (argv: string[], ctx: {cwd: string, env: NodeJS.ProcessEnv}) => {ok: boolean, stdout?: Buffer, reason?: string}}} p
 * @returns {{ok: true, identity: object, filterPaths: string[], empty: boolean, cwdRel: string, repoRoot: string, commonDir: string}
 *         | {ok: false, reason: string}}
 */
export function captureIdentity({ cwd, ignore = [], toolchain = [], env = process.env, runProbe = defaultRunProbe }) {
  let repoRoot; let cwdRel; let commonDir;
  try {
    repoRoot = git(cwd, env, ['rev-parse', '--show-toplevel']);
    cwdRel = git(cwd, env, ['rev-parse', '--show-prefix']).replace(/\/$/, '');
    commonDir = path.normalize(git(cwd, env, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  } catch (err) {
    return { ok: false, reason: `not inside a git work tree (${firstLine(err)})` };
  }
  let pathspecs;
  try { pathspecs = ignore.map(toPathspec); } catch (err) { return { ok: false, reason: err.message }; }

  const probes = {};
  for (const probe of toolchain) {
    let argv;
    try { argv = splitCommand(probe); } catch (err) { return { ok: false, reason: `toolchain probe ${JSON.stringify(probe)} is not a command: ${err.message}` }; }
    const r = runProbe(argv, { cwd, env });
    if (!r.ok) return { ok: false, reason: `toolchain probe ${JSON.stringify(probe)} could not run: ${r.reason}` };
    probes[probe] = sha256(canonicalizeEol(Buffer.from(r.stdout ?? '')));
  }

  const tree = gitWorktreeTree(repoRoot, { env, excludePathspecs: pathspecs, checkFilterAttrs: true });
  if (!tree.ok) return { ok: false, reason: `worktree content could not be hashed: ${tree.error.message}` };
  let emptyTree;
  try { emptyTree = git(repoRoot, env, ['hash-object', '-t', 'tree', '--stdin'], ''); } catch (err) { return { ok: false, reason: `empty tree id unavailable: ${firstLine(err)}` }; }
  const filteredTree = tree.filteredTree ?? tree.tree;
  return {
    ok: true,
    identity: {
      fullTree: tree.tree,
      filteredTree,
      toolchain: probes,
      lineEndings: { autocrlf: gitConfigValue(repoRoot, env, 'core.autocrlf'), eol: gitConfigValue(repoRoot, env, 'core.eol') },
    },
    filterPaths: tree.filterAttrPaths ?? [],
    empty: filteredTree === emptyTree,
    cwdRel,
    repoRoot,
    commonDir,
  };
}

function firstLine(err) {
  return String(err?.stderr || err?.message || err).split(/\r?\n/).find(Boolean) ?? 'unknown error';
}

/** Paths that differ between two tree ids, or null when either object is gone (git pruned it). */
export function treeChangedPaths(cwd, env, a, b) {
  if (a === b) return [];
  try {
    return git(cwd, env, ['diff-tree', '-r', '--name-only', '-z', a, b]).split('\0').filter(Boolean).sort();
  } catch {
    return null;
  }
}

// ── JUnit counts ─────────────────────────────────────────────────────────────

function attrsOf(raw) {
  const out = {};
  for (const m of raw.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[m[1]] = m[2] ?? m[3];
  return out;
}

/** One non-negative safe integer or a reason. */
function readCount(attrs, name, { required }) {
  const raw = attrs[name];
  if (raw === undefined) return required ? { error: `missing ${name}` } : { value: 0 };
  if (!/^\d+$/.test(raw.trim())) return { error: `${name}="${raw}" is not a non-negative integer` };
  const n = Number(raw.trim());
  return Number.isSafeInteger(n) ? { value: n } : { error: `${name}="${raw}" is outside the safe integer range` };
}

function readCounts(attrs) {
  const out = {};
  for (const [name, required] of [['tests', true], ['failures', false], ['errors', false], ['skipped', false]]) {
    const r = readCount(attrs, name, { required });
    if (r.error) return r;
    out[name] = r.value;
  }
  return { value: out };
}

/** The ONE validation both the root-aggregate and the leaf-sum paths pass through; `passed` is derived only after it. */
function finishCounts({ tests, failures, errors, skipped }) {
  for (const [name, v] of Object.entries({ tests, failures, errors, skipped })) {
    if (!Number.isSafeInteger(v) || v < 0) return { counts: null, diagnostic: `${name} total ${v} is not a non-negative safe integer` };
  }
  const bad = failures + errors + skipped;
  if (!Number.isSafeInteger(bad) || bad > tests) {
    return { counts: null, diagnostic: `inconsistent counts: failures ${failures} + errors ${errors} + skipped ${skipped} exceeds tests ${tests}` };
  }
  return { counts: { tests, failures, errors, skipped, passed: tests - bad }, diagnostic: null };
}

/**
 * Counts from a JUnit XML report. A root `<testsuites>` with all four aggregate attributes is used as is; otherwise the
 * LEAF `<testsuite>` elements (those with no nested suite) are summed, so a nested aggregate is never double-counted.
 * Anything that does not validate is `counts: null` with a diagnostic, never a partial or zero count.
 *
 * @param {string} xml
 * @returns {{counts: {tests: number, failures: number, errors: number, skipped: number, passed: number}|null, diagnostic: string|null}}
 */
export function parseJunitCounts(xml) {
  if (typeof xml !== 'string' || !xml.trim()) return { counts: null, diagnostic: 'report is empty' };
  const text = xml.replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  const tag = /<(\/?)(testsuites|testsuite|testcase)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  const stack = [];
  const leaves = [];
  let root = null;
  let sawSuite = false;
  let orphanCases = 0; // <testcase> elements with no enclosing <testsuite>
  for (const m of text.matchAll(tag)) {
    const [, closing, name, rest] = m;
    const selfClosing = rest.trimEnd().endsWith('/');
    if (closing) {
      const top = stack.pop();
      if (!top || top.name !== name) return { counts: null, diagnostic: `malformed report: unbalanced </${name}>` };
      if (name === 'testsuite' && !top.hasChild) leaves.push(top.attrs);
      continue;
    }
    if (name === 'testcase') {
      if (!stack.some((n) => n.name === 'testsuite')) orphanCases += 1;
      if (!selfClosing) stack.push({ name, attrs: {}, hasChild: false });
      continue;
    }
    sawSuite = true;
    const node = { name, attrs: attrsOf(rest), hasChild: false };
    if (name === 'testsuites' && stack.length === 0 && !root) root = node;
    if (name === 'testsuite' && stack.length) stack[stack.length - 1].hasChild = true;
    if (selfClosing) {
      if (name === 'testsuite') leaves.push(node.attrs);
    } else stack.push(node);
  }
  if (!sawSuite) return { counts: null, diagnostic: 'no <testsuite> element found in the report' };
  if (stack.length) return { counts: null, diagnostic: 'malformed report: an unclosed <testsuite>' };

  if (root && ['tests', 'failures', 'errors', 'skipped'].every((k) => root.attrs[k] !== undefined)) {
    const r = readCounts(root.attrs);
    return r.error ? { counts: null, diagnostic: `root <testsuites>: ${r.error}` } : finishCounts(r.value);
  }
  // `node --test` reports a top-level test as a bare <testcase>. Summing only the suites would silently UNDER-count a
  // report that mixes the two, so any such case makes the whole report uncountable, never partly counted.
  if (orphanCases > 0) {
    return { counts: null, diagnostic: `${orphanCases} <testcase> element(s) sit outside any <testsuite> (node --test reports top-level tests this way), so the report cannot be counted: wrap them in describe() or use a reporter with suite totals` };
  }
  if (leaves.length === 0) return { counts: null, diagnostic: 'no leaf <testsuite> element found in the report' };
  const total = { tests: 0, failures: 0, errors: 0, skipped: 0 };
  for (const attrs of leaves) {
    const r = readCounts(attrs);
    if (r.error) return { counts: null, diagnostic: `<testsuite name="${attrs.name ?? ''}">: ${r.error}` };
    const check = finishCounts(r.value);
    if (!check.counts) return { counts: null, diagnostic: `<testsuite name="${attrs.name ?? ''}">: ${check.diagnostic}` };
    for (const k of Object.keys(total)) {
      total[k] += r.value[k];
      if (!Number.isSafeInteger(total[k])) return { counts: null, diagnostic: `${k} total is outside the safe integer range` };
    }
  }
  return finishCounts(total);
}

function describeCounts(counts) {
  return counts
    ? `${counts.tests} tests (${counts.passed} passed, ${counts.failures} failed, ${counts.errors} errors, ${counts.skipped} skipped)`
    : 'counts unmeasured';
}

// ── The validator ────────────────────────────────────────────────────────────

/**
 * The three answers. Pure: git is reached only through `helpers.changedPaths`.
 *
 * @param {object|null} record a validated record, or null
 * @param {{ok: boolean, reason?: string, identity?: object, filterPaths?: string[], empty?: boolean}} current
 * @param {{changedPaths?: (a: string, b: string) => string[]|null}} [helpers]
 * @param {string} [absentReason] why there is no record
 * @returns {{answer: 'reusable'|'invalidated'|'unknown', reasons: string[], changedPaths?: string[]|null, moved?: string[],
 *           ignoredChanges?: string[]|null, recorded?: object}}
 */
export function decideReuse(record, current, helpers = {}, absentReason = 'no record for this invocation') {
  const unknown = (reason) => ({ answer: 'unknown', reasons: [reason] });
  if (!current?.ok) return unknown(`current content identity could not be computed: ${current?.reason ?? 'unknown'}`);
  if (current.filterPaths?.length) {
    const shown = current.filterPaths.slice(0, 5).join(', ');
    return unknown(`clean/smudge filter configured: content identity is not byte-bound (${shown}${current.filterPaths.length > 5 ? ', …' : ''})`);
  }
  if (current.empty) return unknown('the tested content is empty (every file is ignored or there are none): nothing was bound');
  if (!record) return unknown(absentReason);
  const { outcome } = record;
  if (outcome.kind !== 'exited' || outcome.code !== 0) {
    const what = outcome.kind === 'exited' ? `exited ${outcome.code}` : outcome.kind === 'signal' ? `was killed by ${outcome.signal}` : `could not start (${outcome.code ?? 'spawn error'})`;
    return unknown(`the recorded run ${what}: there is no green run to reuse`);
  }
  if (!record.stable) return unknown(`the recorded run is unstable (${record.unstableReason ?? 'input-changed-during-run'}): the tested bytes are not the recorded bytes`);
  const { counts } = record;
  if (counts && counts.tests === 0) return unknown('the recorded run executed zero tests (a vacuous pass is not evidence)');
  if (counts && counts.failures + counts.errors > 0) return unknown(`the recorded run exited 0 but its report shows ${counts.failures} failed and ${counts.errors} errored tests`);

  const recorded = { finishedAt: record.finishedAt, wallMs: record.wallMs, counts, outcome };
  const changedPaths = helpers.changedPaths ?? (() => null);
  const a = record.identity; const b = current.identity;
  const moved = [];
  for (const probe of new Set([...Object.keys(a.toolchain), ...Object.keys(b.toolchain)])) {
    if (a.toolchain[probe] !== b.toolchain[probe]) moved.push(`toolchain probe: ${probe}`);
  }
  for (const key of ['autocrlf', 'eol']) {
    if (a.lineEndings[key] !== b.lineEndings[key]) {
      moved.push(`core.${key}: ${JSON.stringify(b.lineEndings[key] ?? 'unset')} now, ${JSON.stringify(a.lineEndings[key] ?? 'unset')} recorded`);
    }
  }
  if (a.filteredTree !== b.filteredTree) {
    const paths = changedPaths(a.filteredTree, b.filteredTree);
    return {
      answer: 'invalidated', recorded, moved, changedPaths: paths,
      reasons: [paths ? `${paths.length} tested path(s) changed since the recorded run` : 'tested content changed since the recorded run (paths unavailable: the recorded tree has been pruned)', ...moved],
    };
  }
  if (moved.length) return { answer: 'invalidated', recorded, moved, changedPaths: [], reasons: moved };
  const result = { answer: 'reusable', recorded, reasons: [] };
  if (a.fullTree !== b.fullTree) {
    // The reuse trees are equal, so every difference in the full tree lies under an ignore glob.
    result.ignoredChanges = changedPaths(a.fullTree, b.fullTree);
    if (result.ignoredChanges === null) result.reasons.push('ignored changes unavailable: the recorded tree has been pruned');
  }
  return result;
}

// ── Records on disk ──────────────────────────────────────────────────────────

/** Validate and write one record. Throws on an invalid record or an I/O failure. */
export function writeRecord(commonDir, record) {
  const valid = RecordSchema.parse(record);
  const file = recordPathFor(commonDir, valid.key);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteFileSync(file, `${JSON.stringify(valid, null, 2)}\n`);
  return file;
}

/** @returns {{ok: true, record: object} | {ok: false, reason: string}} */
export function readRecord(commonDir, key) {
  const file = recordPathFor(commonDir, key);
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (err) {
    return { ok: false, reason: err.code === 'ENOENT' ? 'no record for this invocation' : `record unreadable (${err.code ?? err.message})` };
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return { ok: false, reason: 'record unreadable: not valid JSON' }; }
  if (parsed && typeof parsed === 'object' && parsed.schema !== TEST_EVIDENCE_SCHEMA) {
    return { ok: false, reason: `record has schema ${JSON.stringify(parsed.schema)}, not ${TEST_EVIDENCE_SCHEMA}` };
  }
  const valid = RecordSchema.safeParse(parsed);
  if (!valid.success) return { ok: false, reason: `record malformed: ${valid.error.issues[0]?.path.join('.') || 'root'}: ${valid.error.issues[0]?.message}` };
  if (valid.data.key !== key) return { ok: false, reason: 'record malformed: its key does not match its file name' };
  return { ok: true, record: valid.data };
}

// ── record ───────────────────────────────────────────────────────────────────

/** Spawn `argv` verbatim (no shell). Child output goes to the wrapper's stderr so stdout stays one JSON envelope. */
function runChildProcess(argv, { cwd, env, stdio }) {
  return new Promise((resolve) => {
    const target = resolveSpawnTarget({ cmd: argv[0], args: argv.slice(1) });
    const fail = (e) => resolve({ outcome: { kind: 'spawn-error', code: e?.code ?? null }, message: describeSpawnFailure({ cmd: argv[0], spawnError: e?.message ?? String(e), target, cwd }) });
    let child;
    try {
      child = spawn(target.cmd, target.args, { cwd, env, shell: false, windowsHide: true, stdio: stdio ?? ['inherit', process.stderr.fd, process.stderr.fd] });
    } catch (e) { fail(e); return; }
    child.once('error', fail);
    child.once('close', (code, signal) => resolve({ outcome: signal ? { kind: 'signal', signal } : { kind: 'exited', code: code ?? 1 } }));
  });
}

function requireArgv(argv) {
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((a) => typeof a !== 'string') || !argv[0]) {
    throw new Error('a command is required after "--" (test-evidence record -- <command…>)');
  }
}

function fileDigest(file) {
  try { return sha256(fs.readFileSync(file)); } catch { return null; }
}

/** Counts, but only from a report THIS invocation produced. */
function countsFromReport(report, before, spawnStart) {
  let stat;
  try { stat = fs.statSync(report); } catch { return { counts: null, diagnostic: 'report not produced by this run: file missing after the run' }; }
  const fresh = stat.mtimeMs >= spawnStart - MTIME_SLACK_MS;
  const changed = before === null || fileDigest(report) !== before;
  if (!fresh || !changed) return { counts: null, diagnostic: 'report not produced by this run' };
  let xml;
  try { xml = fs.readFileSync(report, 'utf8'); } catch (err) { return { counts: null, diagnostic: `report unreadable (${err.code ?? err.message})` }; }
  return parseJunitCounts(xml);
}

/**
 * Run `argv`, bracketed by two identity captures, and write the record.
 *
 * @param {{argv: string[], cwd?: string, ignore?: string[], toolchain?: string[], junit?: string|null, env?: NodeJS.ProcessEnv}} opts
 * @param {{runChild?: Function, runProbe?: Function, writeRecord?: Function, platform?: string, arch?: string, childStdio?: unknown, now?: () => Date}} [deps] test seams
 * @returns {Promise<{exitCode: number, envelope: object}>}
 */
export async function recordRun(opts, deps = {}) {
  const { argv, cwd = process.cwd(), ignore = [], toolchain = [], junit = null, env = process.env } = opts;
  requireArgv(argv);
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  const capture = () => captureIdentity({ cwd, ignore, toolchain, env, runProbe: deps.runProbe });

  const before = capture();
  if (!before.ok) {
    const message = `identity could not be computed before the run; nothing was run or recorded: ${before.reason}. Run the command directly if the result is all you want.`;
    return { exitCode: 3, envelope: { ok: false, verb: 'record', message, summary: `test-evidence: not measured — ${message}`, limit: KNOWN_LIMIT } };
  }
  const key = recordKey({ argv, cwdRel: before.cwdRel, ignore, toolchain, platform, arch });
  const report = junit ? path.resolve(cwd, junit) : null;
  const reportBefore = report ? fileDigest(report) : null;

  const spawnStart = Date.now();
  const clock = performance.now();
  const run = await (deps.runChild ?? runChildProcess)(argv, { cwd, env, stdio: deps.childStdio });
  const wallMs = Math.round(performance.now() - clock);
  const { outcome } = run;

  // Stability compares only the REUSE identity; fullTree is diagnostic and never decides it.
  const after = capture();
  let stable = true; let unstableReason = null; let unstablePaths = [];
  if (!after.ok) {
    stable = false; unstableReason = `identity-unavailable-after-run: ${after.reason}`;
  } else {
    const a = before.identity; const b = after.identity;
    const treeMoved = a.filteredTree !== b.filteredTree;
    const otherMoved = JSON.stringify([a.toolchain, a.lineEndings]) !== JSON.stringify([b.toolchain, b.lineEndings]);
    if (treeMoved || otherMoved) {
      stable = false; unstableReason = 'input-changed-during-run';
      unstablePaths = treeMoved ? (treeChangedPaths(before.repoRoot, env, a.filteredTree, b.filteredTree) ?? []) : [];
    }
  }

  let counts = null; let countsDiagnostic = null;
  if (report && outcome.kind !== 'spawn-error') ({ counts, diagnostic: countsDiagnostic } = countsFromReport(report, reportBefore, spawnStart));

  const record = {
    schema: TEST_EVIDENCE_SCHEMA, key, command: argv, cwd: before.cwdRel, platform, arch,
    ignore: [...ignore].sort(), toolchainProbes: [...toolchain].sort(),
    identity: before.identity, outcome, stable, unstableReason, unstablePaths, wallMs,
    finishedAt: (deps.now?.() ?? new Date()).toISOString(), counts, countsDiagnostic,
  };
  let recordPath = recordPathFor(before.commonDir, key);
  let writeError = null;
  try { recordPath = (deps.writeRecord ?? writeRecord)(before.commonDir, record); } catch (err) { writeError = err.code ?? err.message; }

  const childCode = outcome.kind === 'exited' ? toShellExitCode(outcome.code) : outcome.kind === 'signal' ? 1 : 2;
  const exitCode = writeError && childCode === 0 ? 3 : childCode;
  const ran = outcome.kind === 'exited' ? `exited ${outcome.code}` : outcome.kind === 'signal' ? `killed by ${outcome.signal}` : 'could not start';
  const messages = [];
  if (run.message) messages.push(run.message);
  if (writeError) messages.push(`ran ${childCode === 0 ? 'green' : ran}, recorded nothing (${writeError})`);
  if (!stable) messages.push(`unstable: ${unstableReason}${unstablePaths.length ? ` (${unstablePaths.slice(0, 5).join(', ')})` : ''}; check will answer unknown`);
  if (countsDiagnostic) messages.push(`counts: ${countsDiagnostic}`);
  const summary = `test-evidence: ${ran} in ${fmtMs(wallMs)}; ${describeCounts(counts)}; ${stable ? 'stable' : 'UNSTABLE'}${writeError ? '; NOT recorded' : ''}`;
  return {
    exitCode,
    envelope: {
      ok: exitCode === 0, verb: 'record', key, recordPath, outcome, stable, unstableReason, unstablePaths, wallMs,
      counts, countsDiagnostic, ...(messages.length ? { message: messages.join('; ') } : {}), summary, limit: KNOWN_LIMIT,
    },
  };
}

// ── check ────────────────────────────────────────────────────────────────────

const CHECK_EXIT = Object.freeze({ reusable: 0, invalidated: 1, unknown: 3 });

/**
 * @param {{argv: string[], cwd?: string, ignore?: string[], toolchain?: string[], env?: NodeJS.ProcessEnv}} opts
 * @param {{runProbe?: Function, platform?: string, arch?: string}} [deps]
 * @returns {Promise<{exitCode: number, envelope: object}>}
 */
export async function checkRun(opts, deps = {}) {
  const { argv, cwd = process.cwd(), ignore = [], toolchain = [], env = process.env } = opts;
  requireArgv(argv);
  const current = captureIdentity({ cwd, ignore, toolchain, env, runProbe: deps.runProbe });
  let record = null; let absentReason; let key = null; let recordPath = null;
  if (current.ok) {
    key = recordKey({ argv, cwdRel: current.cwdRel, ignore, toolchain, platform: deps.platform ?? process.platform, arch: deps.arch ?? process.arch });
    recordPath = recordPathFor(current.commonDir, key);
    const read = readRecord(current.commonDir, key);
    if (read.ok) record = read.record; else absentReason = read.reason;
  }
  const decision = decideReuse(record, current, {
    changedPaths: (a, b) => treeChangedPaths(current.repoRoot, env, a, b),
  }, absentReason);
  const { answer } = decision;
  const rec = decision.recorded;
  const lead = {
    reusable: `reusable — the recorded green run still applies (rerun would cost ~${rec ? fmtMs(rec.wallMs) : '?'}); ${describeCounts(rec?.counts ?? null)}`,
    invalidated: `invalidated — ${decision.reasons[0]}; rerun`,
    unknown: `unknown — ${decision.reasons[0]}; rerun`,
  }[answer];
  const summary = `test-evidence: ${lead}`;
  return {
    exitCode: CHECK_EXIT[answer],
    envelope: { ok: answer === 'reusable', verb: 'check', ...decision, key, recordPath, summary, limit: KNOWN_LIMIT },
  };
}

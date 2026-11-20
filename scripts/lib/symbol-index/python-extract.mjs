/**
 * @fileoverview The Python parser stage of the symbol extractor.
 *
 * `extract.mjs` admits every file through ONE gate (`admitFile`: lexical skip,
 * canonical/symlink re-classification, escape check, extension, size cap) and
 * hands the admitted `.py` files here instead of to ts-morph. This module:
 *
 *   1. asks whether a Python parser exists at all (`probePythonParser`) — the
 *      interpreter's own answer, never an assumption (AGENTS.md: ask the parser);
 *   2. reads each admitted file ITSELF, bound to the admission identity
 *      (`readAdmittedSource`), and sends the bytes — never a path — to a stdlib
 *      `ast` helper (`python-ast-helper.py`), which opens no files at all;
 *   3. drives that helper over a versioned, id-correlated, deadline-bounded line
 *      protocol in which every candidate ends in exactly one terminal outcome;
 *   4. maps helper symbols through an explicit field allowlist into the SAME
 *      `redactAndEmit` the JS path uses, and resolves imports with the existing
 *      arch-intent resolver into the SAME edge buckets dep-cruiser's edges use.
 *
 * Plan: docs/plans/python-arch-memory-indexing.md (§2.2–2.10).
 *
 * @module scripts/lib/symbol-index/python-extract
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PYTHON_EXT_ALLOWLIST, isPythonIndexPath } from '../sensitive-egress-gate.mjs';
import { shouldSkipForIndexing, resolveAndClassify } from '../sensitive-paths.mjs';
import { COVERAGE_DEFAULTS } from './graph-verdict.mjs';
import {
  discoverPythonRoots, buildPythonModuleIndex, resolvePythonImport,
} from '../arch-intent/adapters/python.mjs';

export const PROTOCOL_VERSION = 1;
export const PYTHON_MIN_VERSION = Object.freeze([3, 9]);
export const PYTHON_PROBE_TIMEOUT_MS = 10_000;
export const PYTHON_HELLO_TIMEOUT_MS = 10_000;
export const PYTHON_FILE_TIMEOUT_MS = 30_000;
export const PYTHON_HEARTBEAT_MS = 5_000;
export const PYTHON_MAX_RESTARTS = 3;
export const PYTHON_MAX_LINE_BYTES = 4 * 1024 * 1024;
/** Env override: the ONLY interpreter tried when set — an explicit choice is never silently replaced. */
export const PYTHON_ENV_VAR = 'ARCH_INDEX_PYTHON';

// Every stage deadline must sit strictly below the supervisor's idle timeout,
// or a deadline could never fire before the parent killed the child (§2.9).
for (const [name, ms] of Object.entries({ PYTHON_HELLO_TIMEOUT_MS, PYTHON_FILE_TIMEOUT_MS, PYTHON_HEARTBEAT_MS })) {
  if (!(ms < COVERAGE_DEFAULTS.hardTimeoutMs)) {
    throw new Error(`python-extract: ${name} (${ms}ms) must be below COVERAGE_DEFAULTS.hardTimeoutMs (${COVERAGE_DEFAULTS.hardTimeoutMs}ms)`);
  }
}

/** Next to this module in BOTH layouts (source tree and `scripts/.claude-skills/`). */
export const DEFAULT_HELPER_PATH = fileURLToPath(new URL('./python-ast-helper.py', import.meta.url));

/** Terminal outcomes — every candidate ends in exactly one. */
export const OUTCOME = Object.freeze({
  PARSED: 'parsed',
  SYNTAX_ERROR: 'syntax-error',
  DECODE_ERROR: 'decode-error',
  TIMEOUT: 'timeout',
  HELPER_DIED: 'helper-died',
  IDENTITY_CHANGED: 'identity-changed',
  SIZE_CAP: 'size-cap',
  READ_ERROR: 'read-error',
});

const VERSION_CHECK = 'import sys,ast;print("%d.%d.%d" % sys.version_info[:3])';

function candidateInterpreters(env, platform) {
  const explicit = env[PYTHON_ENV_VAR];
  if (explicit) return [{ command: explicit, prefix: [] }];
  return platform === 'win32'
    ? [{ command: 'py', prefix: ['-3'] }, { command: 'python', prefix: [] }, { command: 'python3', prefix: [] }]
    : [{ command: 'python3', prefix: [] }, { command: 'python', prefix: [] }];
}

function versionAtLeast(v, min) {
  for (let i = 0; i < min.length; i++) {
    if ((v[i] ?? 0) !== min[i]) return (v[i] ?? 0) > min[i];
  }
  return true;
}

/**
 * Is there a usable Python parser here? `{available:false}` carries a reason;
 * it is reported as UNPARSEABLE coverage, never as indexed.
 *
 * @param {{env?: object, platform?: string, helperPath?: string,
 *          run?: (cmd: string, args: string[]) => {status: number|null, stdout?: string, error?: Error}}} [opts]
 * @returns {{available: boolean, interpreter: {command: string, prefix: string[]}|null,
 *            version: string|null, helperPath: string, reason: string|null}}
 */
export function probePythonParser({
  env = process.env, platform = process.platform, helperPath = DEFAULT_HELPER_PATH,
  run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', timeout: PYTHON_PROBE_TIMEOUT_MS, windowsHide: true }),
} = {}) {
  if (!fs.existsSync(helperPath)) {
    return { available: false, interpreter: null, version: null, helperPath, reason: 'helper-missing' };
  }
  const tried = [];
  for (const cand of candidateInterpreters(env, platform)) {
    let r;
    try { r = run(cand.command, [...cand.prefix, '-I', '-c', VERSION_CHECK]); } catch (err) { r = { status: null, error: err }; }
    const out = String(r?.stdout ?? '').trim();
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(out);
    if (r?.status === 0 && m) {
      const v = [Number(m[1]), Number(m[2]), Number(m[3])];
      if (versionAtLeast(v, PYTHON_MIN_VERSION)) {
        return { available: true, interpreter: cand, version: out, helperPath, reason: null };
      }
      tried.push(`${cand.command}=${out} (< ${PYTHON_MIN_VERSION.join('.')})`);
      continue;
    }
    tried.push(`${cand.command}: ${r?.error?.code || (r?.status == null ? 'no-exit' : `exit ${r.status}`)}`);
  }
  const reason = env[PYTHON_ENV_VAR]
    ? `${PYTHON_ENV_VAR} interpreter unusable (${tried.join('; ')})`
    : `no Python >= ${PYTHON_MIN_VERSION.join('.')} interpreter found (${tried.join('; ')})`;
  return { available: false, interpreter: null, version: null, helperPath, reason };
}

/**
 * Read an ADMITTED file, bound to the admission identity (§2.6): re-stat, open,
 * fstat and compare dev+ino+size, confirm the canonical path still resolves to
 * itself, read at most `maxBytes + 1` from the fd, then fstat again.
 *
 * @param {{canonicalPath: string}} admission - from extract.mjs `admitFile`
 * @param {{maxBytes: number, beforeRead?: () => void}} opts - `beforeRead` is a test seam
 * @returns {{ok: true, bytes: Buffer} | {ok: false, outcome: string, detail: string}}
 */
export function readAdmittedSource(admission, { maxBytes, beforeRead } = {}) {
  const canonical = admission.canonicalPath;
  let fd = null;
  try {
    const st0 = fs.statSync(canonical, { bigint: true });
    if (typeof beforeRead === 'function') beforeRead();
    fd = fs.openSync(canonical, 'r');
    const st1 = fs.fstatSync(fd, { bigint: true });
    if (st1.dev !== st0.dev || st1.ino !== st0.ino || st1.size !== st0.size) {
      return { ok: false, outcome: OUTCOME.IDENTITY_CHANGED, detail: 'file changed between admission and open' };
    }
    if (fs.realpathSync(canonical) !== canonical) {
      return { ok: false, outcome: OUTCOME.IDENTITY_CHANGED, detail: 'canonical path no longer resolves to itself' };
    }
    if (st1.size > BigInt(maxBytes)) {
      return { ok: false, outcome: OUTCOME.SIZE_CAP, detail: `size ${st1.size} > ${maxBytes}` };
    }
    const buf = Buffer.alloc(maxBytes + 1);
    let total = 0;
    while (total < buf.length) {
      const n = fs.readSync(fd, buf, total, buf.length - total, total);
      if (n === 0) break;
      total += n;
    }
    if (total > maxBytes) return { ok: false, outcome: OUTCOME.SIZE_CAP, detail: 'file grew past the cap during read' };
    const st2 = fs.fstatSync(fd, { bigint: true });
    if (st2.size !== st1.size || st2.mtimeNs !== st1.mtimeNs || BigInt(total) !== st1.size) {
      return { ok: false, outcome: OUTCOME.IDENTITY_CHANGED, detail: 'file changed during read' };
    }
    return { ok: true, bytes: buf.subarray(0, total) };
  } catch (err) {
    return { ok: false, outcome: OUTCOME.READ_ERROR, detail: err.code || err.message };
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* already closed */ } }
  }
}

/**
 * The helper-to-candidate mapping is an explicit ALLOWLIST (§2.2): unknown keys
 * are dropped; a missing or ill-typed key fails the whole file closed.
 *
 * @param {unknown} symbols
 * @returns {{ok: true, candidates: object[]} | {ok: false, reason: string}}
 */
export function toSymbolCandidates(symbols) {
  if (!Array.isArray(symbols)) return { ok: false, reason: 'symbols is not an array' };
  const KINDS = new Set(['function', 'class', 'method']);
  const candidates = [];
  for (const s of symbols) {
    if (!s || typeof s !== 'object') return { ok: false, reason: 'symbol is not an object' };
    const { symbolName, kind, startLine, endLine, signature, bodyText, isExported } = s;
    if (typeof symbolName !== 'string' || symbolName === '' || !KINDS.has(kind)
      || !Number.isInteger(startLine) || !Number.isInteger(endLine) || endLine < startLine
      || typeof signature !== 'string' || typeof bodyText !== 'string' || typeof isExported !== 'boolean') {
      return { ok: false, reason: `malformed symbol ${JSON.stringify(String(symbolName ?? '')).slice(0, 80)}` };
    }
    candidates.push({ symbolName, kind, startLine, endLine, signature, bodyText, isExported });
  }
  return { ok: true, candidates };
}

/** Line splitter with a hard per-line cap; returns `false` once the cap is breached. */
function makeLineReader(onLine, maxBytes) {
  let buf = '';
  return (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.length > maxBytes) return false;
      if (line.trim()) onLine(line);
    }
    return buf.length <= maxBytes;
  };
}

/**
 * Drive the helper over the queue. Single process, one request in flight; any
 * process failure restarts it (at most `maxRestarts`), and once restarts are
 * exhausted EVERY remaining candidate — queued or in flight — ends `helper-died`.
 *
 * @param {Array<{id: number, rel: string, bytes: Buffer, wantSymbols: boolean}>} requests
 * @param {{command: string, args: string[], onBeat?: () => void, fileTimeoutMs?: number,
 *          helloTimeoutMs?: number, heartbeatMs?: number, maxRestarts?: number,
 *          spawnFn?: typeof spawn, maxLineBytes?: number}} opts
 * @returns {Promise<{results: Map<number, {outcome: string, response?: object, detail?: string}>,
 *                    protocolErrors: number, restarts: number}>}
 */
export async function runPythonHelper(requests, {
  command, args, onBeat = () => {}, fileTimeoutMs = PYTHON_FILE_TIMEOUT_MS,
  helloTimeoutMs = PYTHON_HELLO_TIMEOUT_MS, heartbeatMs = PYTHON_HEARTBEAT_MS,
  maxRestarts = PYTHON_MAX_RESTARTS, spawnFn = spawn, maxLineBytes = PYTHON_MAX_LINE_BYTES,
}) {
  const results = new Map();
  let protocolErrors = 0;
  let restarts = 0;
  let next = 0; // index of the next queued request
  const heartbeat = setInterval(() => onBeat(), heartbeatMs);
  heartbeat.unref?.();

  try {
    while (next < requests.length) {
      if (restarts > maxRestarts) break;
      const proc = startProcess();
      const hello = await proc.await((m) => m.hello === true, helloTimeoutMs);
      if (!hello.ok) { proc.kill(); restarts++; continue; }
      let failed = false;
      while (next < requests.length) {
        const req = requests[next];
        proc.send({ v: PROTOCOL_VERSION, id: req.id, rel: req.rel, b64: req.bytes.toString('base64'), wantSymbols: req.wantSymbols });
        const res = await proc.await((m) => m.id === req.id, fileTimeoutMs);
        onBeat();
        if (res.ok) {
          results.set(req.id, classifyResponse(res.message));
          next++;
          continue;
        }
        results.set(req.id, { outcome: res.reason === 'timeout' ? OUTCOME.TIMEOUT : OUTCOME.HELPER_DIED, detail: res.reason });
        next++;
        failed = true;
        break;
      }
      proc.kill();
      if (failed) restarts++;
    }
  } finally {
    clearInterval(heartbeat);
  }
  // Restarts exhausted: every candidate not yet terminal — never-sent ones included.
  for (const req of requests) {
    if (!results.has(req.id)) results.set(req.id, { outcome: OUTCOME.HELPER_DIED, detail: 'helper restarts exhausted' });
  }
  return { results, protocolErrors, restarts };

  function startProcess() {
    let child;
    let dead = false;
    let deathReason = null;
    const inbox = [];
    let waiter = null;
    const settle = (value) => { if (waiter) { const w = waiter; waiter = null; clearTimeout(w.timer); w.resolve(value); } };
    const deliver = () => {
      if (!waiter) return;
      const idx = inbox.findIndex((m) => waiter.match(m));
      if (idx !== -1) { const [m] = inbox.splice(idx, 1); settle({ ok: true, message: m }); }
      else if (dead) settle({ ok: false, reason: deathReason || 'exited' });
    };
    const seenIds = new Set();
    const onLine = (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { protocolErrors++; return; }
      if (!msg || typeof msg !== 'object' || msg.v !== PROTOCOL_VERSION) { protocolErrors++; return; }
      if (msg.hello !== true) {
        // Unknown or duplicate ids are counted and dropped — never attributed to another file.
        const known = requests.some((r) => r.id === msg.id);
        if (!known || seenIds.has(msg.id)) { protocolErrors++; return; }
        seenIds.add(msg.id);
      }
      inbox.push(msg);
      deliver();
    };
    const die = (reason) => { if (!dead) { dead = true; deathReason = reason; } deliver(); };
    try {
      child = spawnFn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      dead = true; deathReason = `spawn-failed: ${err.code || err.message}`;
    }
    if (child) {
      const read = makeLineReader(onLine, maxLineBytes);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { if (!read(chunk)) { protocolErrors++; die('line-too-long'); try { child.kill(); } catch { /* gone */ } } });
      child.stderr.on('data', () => { /* diagnostics only; never parsed */ });
      child.on('error', (err) => die(`spawn-failed: ${err.code || err.message}`));
      child.on('close', (code, signal) => die(signal ? `signal ${signal}` : `exit ${code}`));
      child.stdin.on('error', () => die('stdin-closed'));
      child.stdin.write(`${JSON.stringify({ v: PROTOCOL_VERSION, hello: true })}\n`);
    }
    return {
      send(obj) { if (!dead && child) { try { child.stdin.write(`${JSON.stringify(obj)}\n`); } catch { die('stdin-closed'); } } },
      await(match, timeoutMs) {
        return new Promise((resolve) => {
          const timer = setTimeout(() => { if (waiter && waiter.resolve === resolve) { waiter = null; resolve({ ok: false, reason: 'timeout' }); } }, timeoutMs);
          waiter = { match, resolve, timer };
          deliver();
        });
      },
      kill() { dead = true; if (child) { try { child.stdin.end(); } catch { /* gone */ } try { child.kill(); } catch { /* gone */ } } },
    };
  }
}

function classifyResponse(msg) {
  if (msg.ok === true) return { outcome: OUTCOME.PARSED, response: msg };
  const kind = msg.error?.kind;
  const detail = String(msg.error?.message ?? '').slice(0, 200);
  if (kind === 'syntax') return { outcome: OUTCOME.SYNTAX_ERROR, detail };
  if (kind === 'decode') return { outcome: OUTCOME.DECODE_ERROR, detail };
  return { outcome: OUTCOME.HELPER_DIED, detail: detail || 'internal helper error' };
}

/**
 * Bucket every offered Python import edge (§2.3). Each deduplicated
 * `(importer, target-key)` lands in exactly one bucket, so the extraction
 * exhaustivity assertion still holds.
 *
 * @param {{importsByFile: Map<string, object[]>, indexFiles: string[], repoRoot: string,
 *          disowned?: Set<string>|null, readMeta?: (rel: string) => string|null}} input
 * @returns {{edges: Array<{importer: string, imported: string}>,
 *            buckets: {external: number, selfEdge: number, escaping: number, unresolved: number, disowned: number, persisted: number},
 *            offered: number}}
 */
export function bucketPythonImports({ importsByFile, indexFiles, repoRoot, disowned = null, readMeta }) {
  const mapped = new Map(indexFiles.map((f) => [f, '_python']));
  const roots = discoverPythonRoots(repoRoot, mapped, readMeta ? { readMeta } : undefined);
  const index = buildPythonModuleIndex(mapped, roots);
  const localTopLevel = new Set([...index.moduleToFile.keys()].map((k) => k.split('.')[0]));
  const buckets = { external: 0, selfEdge: 0, escaping: 0, unresolved: 0, disowned: 0, persisted: 0 };
  const edges = [];
  const seen = new Set();
  const offer = (key) => { if (seen.has(key)) return false; seen.add(key); return true; };

  for (const [importer, refs] of importsByFile) {
    for (const ref of refs) {
      const res = resolvePythonImport(ref, importer, index);
      if (res.state === 'resolved-local') {
        const targets = new Set([res.targetFile, ...(res.submodules || [])].filter(Boolean));
        for (const imported of targets) {
          if (!offer(`${importer}\0${imported}`)) continue;
          if (imported === importer) buckets.selfEdge++;
          else if (disowned && (disowned.has(importer) || disowned.has(imported))) buckets.disowned++;
          else { buckets.persisted++; edges.push({ importer, imported }); }
        }
        continue;
      }
      const dotted = `${'.'.repeat(ref.dotCount || 0)}${ref.module || ''}`;
      if (res.state === 'proven-external') {
        if (offer(`${importer}\0ext:${dotted}`)) buckets.external++;
        continue;
      }
      // unresolved: relative, or absolute under a KNOWN local top-level package,
      // is a real resolution failure; any other absolute name is third-party.
      const top = String(ref.module || '').split('.')[0];
      const isUnresolved = ref.isRelative || localTopLevel.has(top);
      if (!offer(`${importer}\0${isUnresolved ? 'unres' : 'ext'}:${dotted}`)) continue;
      if (isUnresolved) buckets.unresolved++; else buckets.external++;
    }
  }
  const offered = Object.values(buckets).reduce((a, b) => a + b, 0);
  return { edges, buckets, offered };
}

/**
 * A `readMeta` for `discoverPythonRoots` guarded by the sensitive-path gate:
 * a metadata file that is sensitive, generated noise, escapes the repo, cannot
 * be resolved, or is oversize is never opened (§2.3).
 */
export function guardedMetaReader(repoRoot, maxBytes) {
  return (rel) => {
    if (shouldSkipForIndexing(rel, ['sensitive', 'generatedNoise']).skip) return null;
    const abs = path.join(repoRoot, rel);
    if (!fs.existsSync(abs)) return null;
    const cls = resolveAndClassify(rel, { repoRoot });
    if (cls.resolutionFailed || cls.escapedRepo || cls.category === 'sensitive') return null;
    const read = readAdmittedSource({ canonicalPath: cls.canonical }, { maxBytes });
    return read.ok ? read.bytes.toString('utf8') : '';
  };
}

/**
 * The whole stage. Called by `extract.mjs::main` after the ts-morph loop.
 *
 * @param {object} ctx
 * @param {string} ctx.repoRoot
 * @param {Array<object>} ctx.symbolAdmissions - admitted `.py` from the extraction scope (already announced)
 * @param {string[]} ctx.universeFiles - absolute owned files of the coverage universe
 * @param {(abs: string, ctx: object) => object} ctx.admit - extract.mjs `admitFile`
 * @param {(candidates: object[], ctx: object) => void} ctx.redactAndEmit
 * @param {(record: object) => void} ctx.emit
 * @param {(msg: string) => void} ctx.log
 * @param {object} ctx.stats - extract.mjs stats, mutated
 * @param {boolean} [ctx.includeDelegates]
 * @param {Set<string>|null} [ctx.disowned]
 * @param {number} ctx.maxBytes
 * @param {object} [ctx.probe] - injectable probe result
 * @param {object} [ctx.helperCommand] - injectable `{command, args}` (tests: a fake helper)
 * @returns {Promise<{available: boolean, cruisedSources: string[], buckets: object, offered: number,
 *                    importCount: number, availableExtensions: string[], probe: object}>}
 */
export async function runPythonStage(ctx) {
  const {
    repoRoot, symbolAdmissions, universeFiles, admit, redactAndEmit, emit, log, stats,
    includeDelegates = false, disowned = null, maxBytes,
  } = ctx;
  const empty = { external: 0, selfEdge: 0, escaping: 0, unresolved: 0, disowned: 0, persisted: 0 };
  const toRel = (abs) => path.relative(repoRoot, abs).replace(/\\/g, '/');
  stats.pythonParsed = 0;
  stats.pythonFailed = 0;
  stats.skippedNoParser = 0;

  const universePy = universeFiles.filter((f) => isPythonIndexPath(f));
  if (symbolAdmissions.length === 0 && universePy.length === 0) {
    return { available: false, cruisedSources: [], buckets: empty, offered: 0, importCount: 0, availableExtensions: [], probe: null };
  }

  const probe = ctx.probe ?? probePythonParser();
  if (!probe.available) {
    stats.skippedNoParser += symbolAdmissions.length;
    log(`python: parser unavailable — ${probe.reason}. ${symbolAdmissions.length} admitted .py file(s) NOT indexed; `
      + 'coverage reports them as unparseable.');
    return { available: false, cruisedSources: [], buckets: empty, offered: 0, importCount: 0, availableExtensions: [], probe };
  }

  // Build the queue: symbol-scope files first (already admitted + announced),
  // then import-only universe files, each announced unnamed and admitted here.
  const candidates = [];
  const symbolRel = new Set();
  for (const a of symbolAdmissions) { symbolRel.add(a.rel); candidates.push({ admission: a, wantSymbols: true }); }
  for (const abs of universePy) {
    const rel = toRel(abs);
    if (symbolRel.has(rel)) continue;
    emit({ type: 'progress' });
    const a = admit(abs, { repoRoot });
    if (a.admitted) candidates.push({ admission: a, wantSymbols: false });
  }

  const outcomes = new Map(); // rel -> outcome
  const requests = [];
  candidates.forEach((c, i) => {
    const read = readAdmittedSource(c.admission, { maxBytes });
    if (!read.ok) { outcomes.set(c.admission.rel, read.outcome); return; }
    requests.push({ id: i + 1, rel: c.admission.rel, bytes: read.bytes, wantSymbols: c.wantSymbols, cand: c });
  });

  const spec = ctx.helperCommand ?? {
    command: probe.interpreter.command, args: [...probe.interpreter.prefix, '-I', '-B', probe.helperPath],
  };
  const { results, protocolErrors, restarts } = await runPythonHelper(requests, {
    ...spec, onBeat: () => emit({ type: 'progress' }),
  });
  if (protocolErrors > 0 || restarts > 0) {
    log(`python: helper protocol errors=${protocolErrors} restarts=${restarts}`);
  }

  const importsByFile = new Map();
  const cruisedSources = [];
  for (const req of requests) {
    const r = results.get(req.id);
    let outcome = r.outcome;
    if (outcome === OUTCOME.PARSED) {
      const mapped = req.wantSymbols ? toSymbolCandidates(r.response.symbols) : { ok: true, candidates: [] };
      if (!mapped.ok || !Array.isArray(r.response.imports)) {
        outcome = OUTCOME.HELPER_DIED;
        log(`python: malformed helper response for ${req.rel} — ${mapped.reason || 'imports is not an array'}`);
      } else {
        if (req.wantSymbols) {
          redactAndEmit(mapped.candidates, { rel: req.rel, includeDelegates, stats });
          // `processed` = admitted, parsed, classified — zero-symbol files included (§2.10).
          emit({ type: 'processed', file: req.rel });
        }
        importsByFile.set(req.rel, r.response.imports);
        cruisedSources.push(path.join(repoRoot, req.rel));
      }
    } else if (r.detail) {
      log(`python: ${outcome}: ${req.rel} — ${r.detail}`);
    }
    outcomes.set(req.rel, outcome);
  }
  for (const [rel, outcome] of outcomes) {
    if (outcome === OUTCOME.PARSED) { stats.pythonParsed++; continue; }
    stats.pythonFailed++;
    if (symbolRel.has(rel)) stats.parseFailures++;
  }

  const indexFiles = [...importsByFile.keys()];
  const { edges, buckets, offered } = bucketPythonImports({
    importsByFile, indexFiles, repoRoot, disowned, readMeta: guardedMetaReader(repoRoot, maxBytes),
  });
  for (const e of edges) emit({ type: 'import', importer: e.importer, imported: e.imported });

  return {
    available: true, cruisedSources, buckets, offered, importCount: edges.length,
    availableExtensions: [...PYTHON_EXT_ALLOWLIST], probe,
  };
}

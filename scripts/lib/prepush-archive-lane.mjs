/**
 * @fileoverview The pre-push "archive lane": what `.githooks/pre-push` does for a
 * push whose every ref update lands under `refs/heads/archive/` or
 * `refs/tags/archive/`.
 *
 * A backup branch is a snapshot of work in flight, so the main-line gates in
 * `npm run check` (docs-ref drift, generated-artifact freshness, the suite) fail
 * on it for reasons that say nothing about publishing it — and the pusher then
 * reaches for `--no-verify`, which disarms everything. This lane replaces that
 * habit with the one check that DOES matter when commits become public: a scan of
 * exactly what the push publishes, for secret-shaped content and sensitive paths.
 *
 * `check` has no such scan (measured; see the plan), so the lane adds it rather
 * than keeping it. Plan: docs/plans/prepush-archive-lane.md — read §1 (the
 * evidence) and §2 (the design) before changing a decision here.
 *
 * THE FOUR OUTCOMES (the hook acts on a token, never on exit status — `node`
 * exits 1 on a syntax error before any catch can run):
 *   not-applicable  not an archive-only push; the hook runs the full gate
 *   clean           nothing found (or found and acknowledged exactly); skip it
 *   findings        something was found; block
 *   error           an eligible push could not be scanned completely; block
 * An incomplete scan is NEVER clean: every limit below ends in `error`, except an
 * oversized object, which is a finding the pusher can acknowledge.
 *
 * Pure where possible; git and the clock are injected so the limits are testable.
 *
 * @module scripts/lib/prepush-archive-lane
 */
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

import { redactSecrets, scanForSecrets } from './secret-patterns.mjs';
import { classifyPath } from './sensitive-paths.mjs';

// ── Protocol and limits ─────────────────────────────────────────────────────

export const LANE_PROTOCOL = 'archive-lane/v1';
export const OUTCOMES = Object.freeze(['not-applicable', 'clean', 'findings', 'error']);
export const ZERO_SHA = '0'.repeat(40);

/** Every limit ends in `error` except `maxObjectBytes`, which is a finding. */
export const LIMITS = Object.freeze({
  /** An object over this, of ANY type, is an `unscanned` finding. */
  maxObjectBytes: 8 * 1024 * 1024,
  /** Bodies are read in batches of at most this, so one object never exceeds it. */
  batchBytes: 64 * 1024 * 1024,
  maxObjects: 200_000,
  budgetMs: 120_000,
  /** Output buffer for `rev-list` / `log` / `cat-file`. */
  maxBuffer: 256 * 1024 * 1024,
  lsRemoteTimeoutMs: 60_000,
});

/** What the lane can actually run. A class-P `check` step must name one. */
export const LANE_SCANNERS = Object.freeze(['secret-scan', 'sensitive-path-scan']);

// ── Classification of `check` (plan §3) ─────────────────────────────────────
//
// P publication-safety · S snapshot-drift · E environment · T the test suite.
// `probe` is the per-step result on archive/queue-burndown-2026-10-02 (3c0afc4e),
// measured 2026-10-11 by running each step separately in a clean worktree.

const S = (reason, probe = 'pass') => ({ cls: 'S', reason, probe });
const E = (reason, probe = 'pass') => ({ cls: 'E', reason, probe });

export const ARCHIVE_LANE_CHECK_CLASSIFICATION = Object.freeze({
  'context:check': S('AGENTS.md / CLAUDE.md alignment and size cap'),
  'docs:check': S('docs placement discipline'),
  'docs:refs:gate': S('cited repo paths must resolve against a baseline', 'FAIL'),
  'docs:synced-links:gate': S('relative links in synced markdown'),
  'docs:architecture-intent:check': S('domain roster vs domain-map.json'),
  'plans:status': S('plan Status line conformity'),
  'plans:index:check': S('generated plans index byte-freshness'),
  'requirements:map:check': S('generated requirements map byte-freshness'),
  'bundle:deps:check': S('generated bundle deps byte-freshness'),
  'skills:check': S('.claude/skills regeneration freshness'),
  'skills:consumer-refs:gate': S('pointers inside synced skills'),
  'plans:lint': S('Mermaid renderer-compat lint'),
  'parity:check-coupling': S('schema-coupling baseline'),
  'efficacy:check': S('opt-in efficacy lints'),
  'on-conflict:check': S('store write-path lint'),
  'arch:coverage-gate': E('needs the observed-graph envelope, DB-derived at main HEAD, not the commit'),
  'db:check-rls:gate': S('migration RLS check'),
  'cli:flags:gate': S('drift-only ratchet'),
  'emit:exit:gate': S('drift-only ratchet'),
  'stdout:flush:gate': S('drift-only ratchet'),
  'knip:gate': S('drift-only ratchet'),
  'size:ratchet:gate': S('drift-only ratchet'),
  'skills:size:gate': S('drift-only ratchet'),
  'gitignore:policy:gate': S('.gitignore category declarations'),
  'status:integrity:gate': S('session-log conservation against a base'),
  'npm-args:gate': S('the -- separator in documented npm commands'),
  'mcp:parity:gate': S('two MCP configs equivalent'),
  'visual-contract-doc:gate': S('doc example vs schema'),
  'worktree:preflight:gate': S('skill preflight marker'),
  'db:enrolment:gate': S('DB suites enrolled in runners'),
  'db:suites:gate': E('runs the DB suites in a container'),
  'gates:poison': E('proves every gate can fail (~70 s)'),
  'upstream:coverage:gate': E('live-store upstream dispositions'),
  'upstream:reconcile:gate': E('live-store upstream queue', 'FAIL'),
  'npm test': { cls: 'T', reason: 'the ~9 min suite', probe: 'not run' },
});

/** The steps of a `check` script string, as `npm run` names (plus `npm test`). */
export function checkStepNames(checkScript) {
  return String(checkScript ?? '')
    .split('&&')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/^npm run /, ''));
}

/**
 * Problems with a classification table against the real `check` steps.
 *
 * Executable, not descriptive: a class-P step must name a scanner the lane really
 * has, so a future publication-safety gate cannot be added by editing the table
 * alone while the lane keeps skipping it. What no test can establish is that an
 * `S` entry should have been `P`; that judgment belongs to the PR that changes
 * `check`, which is why the message states the question.
 *
 * @param {Record<string, {cls: string, reason?: string, laneScanner?: string}>} table
 * @param {string[]} steps
 * @returns {string[]}
 */
export function validateClassification(table, steps) {
  const problems = [];
  const stepSet = new Set(steps);
  for (const step of steps) {
    if (!Object.hasOwn(table, step)) {
      problems.push(`check step "${step}" has no entry in ARCHIVE_LANE_CHECK_CLASSIFICATION. `
        + 'Decide: does it protect against harm from the commits becoming public? If yes it is class P '
        + 'and needs a laneScanner; if it guards what main or consumers receive, class S/E/T.');
    }
  }
  for (const [name, entry] of Object.entries(table)) {
    if (!stepSet.has(name)) problems.push(`classification names "${name}", which is not a step of check`);
    if (!['P', 'S', 'E', 'T'].includes(entry?.cls)) problems.push(`"${name}": class must be P, S, E or T`);
    if (!entry?.reason || !String(entry.reason).trim()) problems.push(`"${name}": reason is empty`);
    if (entry?.cls === 'P' && !LANE_SCANNERS.includes(entry.laneScanner)) {
      problems.push(`"${name}" is class P (publication-safety) but names no lane scanner `
        + `(${LANE_SCANNERS.join(', ')}); the lane would skip it`);
    }
  }
  return problems;
}

// ── Reading the push ────────────────────────────────────────────────────────

const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
// ASCII space and tab are the ONLY separators git writes between fields. A ref NAME may
// hold other whitespace (U+00A0 and friends are legal in refnames), and the LOCAL field is
// a revision expression that may hold ordinary spaces (`HEAD@{2 minutes ago}`), so
// neither JS `\s` nor bash/awk word-splitting may be used to find the fields.
const ARCHIVE_REF_RE = /^refs\/(?:heads|tags)\/archive\/[^ \t]+$/;

export function isArchiveRef(ref) {
  return typeof ref === 'string' && ARCHIVE_REF_RE.test(ref);
}

/**
 * Parse the pre-push stdin: `<local ref> <local sha> <remote ref> <remote sha>`.
 *
 * Fields are found FROM THE RIGHT: the last three are `sha ref sha` and everything
 * before them is the local ref. A push of `HEAD@{2 minutes ago}:refs/heads/archive/x`
 * writes a local ref with spaces in it; a left-to-right split on whitespace counted
 * five fields, called the line malformed, and (the adversarial review's HIGH) sent an
 * archive push with a secret down the full gate, which does not scan.
 *
 * @param {string} text
 * @returns {{entries: Array<{localRef: string, localSha: string, remoteRef: string, remoteSha: string}>, malformed: number, malformedArchive: number}}
 */
const SHA = '[0-9a-f]{40}(?:[0-9a-f]{24})?';
const PUSH_LINE_RE = new RegExp(`^(.+)[ \\t]+(${SHA})[ \\t]+([^ \\t]+)[ \\t]+(${SHA})$`);

export function parsePushLines(text) {
  const entries = [];
  let malformed = 0;
  let malformedArchive = 0;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.replace(/^[ \t]+|[ \t]+$/g, '');
    if (!line) continue;
    const m = PUSH_LINE_RE.exec(line);
    if (!m) {
      malformed++;
      if (line.includes('archive/')) malformedArchive++;
      continue;
    }
    entries.push({ localRef: m[1], localSha: m[2], remoteRef: m[3], remoteSha: m[4] });
  }
  return { entries, malformed, malformedArchive };
}

/**
 * The single oracle for "does this push take the lane" (plan D2). Keyed on the
 * DESTINATION ref: `main:refs/heads/archive/x` is the lane; the reverse is not.
 * A deletion of a non-archive ref makes the push mixed, so it gets the full gate;
 * a delete-only push never reaches here (hook section 0.5 exits first).
 *
 * @param {Pick<ReturnType<typeof parsePushLines>, 'entries' | 'malformed'> & {malformedArchive?: number}} parsed
 */
export function decidePushLane(parsed) {
  const { entries, malformed, malformedArchive = 0 } = parsed;
  // A line this parser cannot read but that MENTIONS archive/ is not "not applicable": the
  // full gate does not scan, so answering that would publish it unscanned. Refuse it.
  if (malformedArchive > 0) return { lane: 'refuse', reason: 'a push line mentioning archive/ could not be parsed' };
  if (malformed > 0) return { lane: 'full', reason: 'a push line could not be parsed' };
  if (entries.length === 0) return { lane: 'full', reason: 'no ref updates on stdin' };
  const outside = entries.find((e) => !isArchiveRef(e.remoteRef));
  if (outside) return { lane: 'full', reason: `ref outside archive/: ${outside.remoteRef}` };
  // A deletion's LOCAL sha is all zeros: it is never a tip (git: fatal bad object).
  const tips = entries.filter((e) => e.localSha !== ZERO_SHA).map((e) => ({ ref: e.remoteRef, sha: e.localSha }));
  if (tips.length === 0) return { lane: 'full', reason: 'delete-only push' };
  const remoteShas = entries.map((e) => e.remoteSha).filter((s) => s !== ZERO_SHA);
  return { lane: 'archive', tips, remoteShas };
}

// ── Display: nothing sensitive reaches stdout or stderr ─────────────────────

const hash8 = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex').slice(0, 8);

/** Control characters become visible escapes, so a path cannot forge output lines. */
function visible(text) {
  return String(text).replace(/[\u0000-\u001f\u007f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

/**
 * The ONE path formatter for every finding kind and every diagnostic. A path that
 * classifies `sensitive` prints as `[redacted:<hash8>].<ext>` (the formatSkipLog
 * convention: this output lands in agent transcripts); any other path prints in
 * full. A pathless commit/tag finding prints no path at all.
 */
export function displayPath(p) {
  if (!p) return '';
  if (classifyPath(p) === 'sensitive') {
    const ext = /\.[A-Za-z0-9]{1,8}$/.exec(p)?.[0] ?? '';
    return `[redacted:${hash8(p)}]${ext}`;
  }
  // A non-sensitive path can still carry a token in its NAME (`ghp_….txt`), so the
  // same secret redactor that guards the diagnostics' other fields applies here.
  return visible(redactSecrets(p).text);
}

/**
 * A push URL can carry credentials in userinfo or a query. Strip both; show a
 * local path as given.
 */
export function displayDestination(destination) {
  const d = String(destination ?? '');
  if (!d) return '(none)';
  let out;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(d)) {
    try {
      const u = new URL(d);
      out = `${u.protocol}//${u.host}${u.pathname}${u.search ? '?…' : ''}`;
    } catch { return '[destination]'; }
  } else {
    out = d.replace(/^[^@/\\\s]+@/, ''); // scp-like user@host:path
  }
  return visible(redactSecrets(out).text);
}

// ── Findings ────────────────────────────────────────────────────────────────

/** @typedef {{kind: 'path'|'secret'|'unscanned', objType: string, oid: string, path: string, detail: string}} Finding */

/** One canonical identity: dedup key and fingerprint input. Raw path, pre-redaction. */
export function canonicalIdentity(f) {
  return [f.kind, f.objType, f.oid, f.path ?? '', f.detail].join('\u0000');
}

export function dedupeFindings(findings) {
  const seen = new Map();
  for (const f of findings) seen.set(canonicalIdentity(f), f);
  return [...seen.values()].sort((a, b) => canonicalIdentity(a).localeCompare(canonicalIdentity(b)));
}

/** First 12 hex of SHA-256 over the sorted identities; order-independent. */
export function fingerprintFindings(findings) {
  const ids = dedupeFindings(findings).map(canonicalIdentity);
  return crypto.createHash('sha256').update(ids.join('\n'), 'utf8').digest('hex').slice(0, 12);
}

// ── Errors: structured, never a raw exception message ───────────────────────

const ERROR_TEXT = Object.freeze({
  'ls-remote-failed': 'could not list the refs the destination already holds. Check the network and credentials; the push itself would fail too',
  'tip-not-commit': 'a pushed ref does not resolve to a commit (a tag of a tree or blob)',
  'git-failed': 'a git command needed for the scan failed',
  'buffer': 'git produced more output than the scan buffer allows',
  'timeout': 'a git command timed out',
  'object-cap': `more than ${LIMITS.maxObjects} objects would be published; the scan will not run unbounded`,
  'time-budget': `the scan exceeded its ${LIMITS.budgetMs / 1000}s budget`,
  'accounting': 'git returned fewer or different objects than were listed, so the scan cannot be called complete',
  'parse': 'git output was not in the expected shape',
  'internal': 'the archive lane hit an internal error',
});

export class LaneError extends Error {
  /** @param {keyof typeof ERROR_TEXT} code */
  constructor(code) {
    super(code); // the message IS the code: argv and exception text never travel
    this.name = 'LaneError';
    this.code = code;
  }
}

// ── Git boundary ────────────────────────────────────────────────────────────

/**
 * A git runner. Returns `{ok, stdout, code}` and never throws; `code` is a stable
 * label, not an exception message (argv can hold a credential-bearing URL).
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} [env]
 */
export function makeGit(cwd, env = process.env) {
  return (args, { input, timeout } = {}) => {
    const r = spawnSync('git', args, {
      cwd,
      env: {
        ...env,
        GIT_TERMINAL_PROMPT: '0',
        // The scan must read the objects the push will SEND. `git replace` refs make
        // rev-list and cat-file answer with substitutes, while pack-objects ignores
        // replacements and publishes the originals: a replacement could hide a
        // secret from the scan and still ship it. A partial clone must not fetch a
        // missing object mid-scan either; absent means unscanned, which is an error.
        GIT_NO_REPLACE_OBJECTS: '1',
        GIT_NO_LAZY_FETCH: '1',
      },
      input,
      timeout,
      maxBuffer: LIMITS.maxBuffer,
      windowsHide: true,
    });
    if (r.error) {
      const code = r.error.code === 'ENOBUFS' ? 'buffer' : r.error.code === 'ETIMEDOUT' ? 'timeout' : 'git-failed';
      return { ok: false, code, stdout: Buffer.alloc(0) };
    }
    return { ok: r.status === 0, code: r.status === 0 ? null : 'git-failed', stdout: r.stdout ?? Buffer.alloc(0) };
  };
}

function must(result) {
  if (!result.ok) throw new LaneError(result.code || 'git-failed');
  return result.stdout.toString('utf8');
}

/**
 * Resolve each id to its peeled commit with one `cat-file --batch-check`.
 * Returns an array parallel to `ids`: the commit id, or null when the id is
 * absent locally or does not peel to a commit.
 */
export function peelToCommits(git, ids) {
  if (ids.length === 0) return [];
  const out = must(git(['cat-file', '--batch-check'], { input: `${ids.map((i) => `${i}^{commit}`).join('\n')}\n` }));
  const lines = out.split('\n').filter((l, i, a) => l !== '' || i < a.length - 1);
  if (lines.length !== ids.length) throw new LaneError('accounting');
  return lines.map((l) => {
    const m = /^([0-9a-f]{40,64}) commit \d+$/.exec(l);
    return m ? m[1] : null;
  });
}

/**
 * What the destination already holds, as exclusion roots (plan D4): the remote
 * shas git put on stdin plus whatever `ls-remote` says the push URL advertises,
 * kept only when present locally. The ADVERTISED id is the root, not its peeled
 * commit, so an advertised annotated tag prunes the tag object too.
 */
export function establishRoots(git, destination, remoteShas) {
  const ls = git(['ls-remote', '--refs', '--', destination], { timeout: LIMITS.lsRemoteTimeoutMs });
  if (!ls.ok) throw new LaneError('ls-remote-failed');
  const advertised = [];
  for (const line of ls.stdout.toString('utf8').split('\n')) {
    const m = /^([0-9a-f]{40,64})\t\S/.exec(line);
    if (m) advertised.push(m[1]);
  }
  const candidates = [...new Set([...remoteShas, ...advertised])];
  const peeled = peelToCommits(git, candidates);
  return candidates.filter((_, i) => peeled[i] !== null);
}

// ── Enumeration ─────────────────────────────────────────────────────────────

/** `rev-list --objects` lines: `<oid>` or `<oid> <path>`; a stray line continues the last path. */
export function parseObjectList(text) {
  const objects = [];
  for (const line of String(text).split('\n')) {
    if (line === '') continue;
    const m = /^([0-9a-f]{40}(?:[0-9a-f]{24})?)(?: (.*))?$/s.exec(line);
    if (m) objects.push({ oid: m[1], path: m[2] ?? '' });
    else if (objects.length) objects[objects.length - 1].path += `\n${line}`;
    else throw new LaneError('parse');
  }
  return objects;
}

/**
 * Parse `git log --root --raw -z --format=%H` into the path/blob pairs each
 * published commit adds or changes. Token stream: a commit id, then for each
 * entry a `:<modes> <shas> <status>` token and its path token. The first entry of
 * each commit is preceded by a newline.
 */
export function parseRawLog(buffer) {
  const tokens = buffer.toString('utf8').split('\u0000');
  const entries = [];
  const META = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])\d*$/;
  for (let i = 0; i < tokens.length; i++) {
    // git puts a newline between a commit header and its first raw entry (measured
    // with od -c): NUL, newline, then the colon token. Entries after the first have
    // no newline, so strip leading newlines before matching.
    const token = tokens[i].replace(/^\n+/, '');
    const m = META.exec(token);
    // A colon-led token that is not the shape this parser reads (a combined-diff
    // `::` record, a future format) must not be skipped like a commit header: a
    // skipped record is a path that was never classified, and a scan that cannot
    // read its input is not a clean one.
    if (!m && token.startsWith(':')) throw new LaneError('parse');
    if (!m) continue; // a commit header, or the empty token between records
    const p = tokens[i + 1];
    if (p === undefined || p === '') throw new LaneError('parse');
    i++;
    if (m[5] === 'D') continue; // a deletion publishes nothing at that path
    entries.push({ mode: m[2], oid: m[4], status: m[5], path: p });
  }
  return entries;
}

/** Group object ids into batches whose summed size stays within `batchBytes`. */
export function batchBySize(items, batchBytes) {
  const batches = [];
  let cur = [];
  let bytes = 0;
  for (const it of items) {
    if (cur.length && bytes + it.size > batchBytes) { batches.push(cur); cur = []; bytes = 0; }
    cur.push(it);
    bytes += it.size;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

/** Read bodies for one batch; verifies header, size and framing of every object. */
function readBodies(git, batch) {
  const r = git(['cat-file', '--batch'], { input: `${batch.map((o) => o.oid).join('\n')}\n` });
  if (!r.ok) throw new LaneError(r.code || 'git-failed');
  const buf = r.stdout;
  let off = 0;
  const bodies = [];
  for (const o of batch) {
    const nl = buf.indexOf(0x0a, off);
    if (nl < 0) throw new LaneError('accounting');
    const m = /^([0-9a-f]+) (\w+) (\d+)$/.exec(buf.subarray(off, nl).toString('utf8'));
    if (!m || m[1] !== o.oid || Number(m[3]) !== o.size) throw new LaneError('accounting');
    const end = nl + 1 + o.size;
    if (end + 1 > buf.length || buf[end] !== 0x0a) throw new LaneError('accounting');
    bodies.push(buf.subarray(nl + 1, end));
    off = end + 1;
  }
  if (off !== buf.length) throw new LaneError('accounting');
  return bodies;
}

// ── Scanning a body: the bytes as written, and the ways a secret hides in them ─────

/**
 * Bodies above this are scanned as written only. The extra variants below each re-run
 * every pattern (the PEM pattern alone costs ~2 s per MB), and a scan that cannot be
 * interrupted must not be multiplied by four on the biggest files. A secret in a
 * config file or a credential store is small.
 */
export const VARIANT_MAX_BYTES = 1024 * 1024;

/**
 * The text variants worth scanning besides the raw one, each only when its precondition
 * is cheaply visible. Found missing by the adversarial review (2026-10-12), each in a real
 * push the lane called clean:
 *   · UTF-16 (PowerShell `>` writes it): NULs between the characters break every pattern;
 *   · a PEM key inside JSON (a GCP service-account file): the newlines are the two
 *     characters \\ and n, and the PEM pattern's body charset excludes a backslash;
 *   · a PEM key in a comment block (`# `, `// `, ` * ` on each line): the markers are not in
 *     the PEM body charset either.
 * @param {string} text latin1-decoded body
 * @returns {string[]} variants other than `text` itself
 */
export function scanVariants(text) {
  const out = [];
  if (text.includes('\u0000')) out.push(text.replace(/\u0000/g, ''));
  if (text.includes('\\n') || text.includes('\\r')) out.push(text.replace(/\\r/g, '').replace(/\\n/g, '\n'));
  if (/^[ \t]*(?:#|\/\/|\*|;|--)/m.test(text)) out.push(text.replace(/^[ \t]*(?:#|\/\/|\*|;|--)+[ \t]?/gm, ''));
  return out;
}

/** Pattern names found in a body, across the raw text and, for small bodies, its variants. */
export function scanBodyPatterns(text, size) {
  const found = new Set(scanForSecrets(text).patterns);
  if (size <= VARIANT_MAX_BYTES) {
    for (const v of scanVariants(text)) for (const p of scanForSecrets(v).patterns) found.add(p);
  }
  return [...found].sort();
}

// ── The scan ────────────────────────────────────────────────────────────────

/**
 * Scan what the push publishes. Throws LaneError for anything that makes the scan
 * incomplete; returns findings and counts otherwise.
 *
 * @param {object} p
 * @param {(args: string[], o?: object) => {ok: boolean, code: string|null, stdout: Buffer}} p.git
 * @param {{tips: Array<{ref: string, sha: string}>, remoteShas: string[]}} p.decision
 * @param {string} p.destination
 * @param {() => number} [p.now]
 * @param {typeof LIMITS} [p.limits] injectable so the limits are testable without 8 MiB fixtures
 */
export function scanPublished({ git: rawGit, decision, destination, now = Date.now, limits = LIMITS }) {
  const t0 = now();
  const checkBudget = () => { if (now() - t0 > limits.budgetMs) throw new LaneError('time-budget'); };
  // ONE deadline for the whole scan: every git call is checked against it first and
  // is handed what REMAINS as its own timeout, so a stalled subprocess is killed
  // (code `timeout`) instead of outliving the budget that was only ever read
  // between calls.
  const git = (args, o = {}) => {
    checkBudget();
    const left = Math.max(1, limits.budgetMs - (now() - t0));
    return rawGit(args, { ...o, timeout: Math.min(o.timeout ?? left, left) });
  };

  const tipShas = [...new Set(decision.tips.map((t) => t.sha))];
  const peeled = peelToCommits(git, tipShas);
  if (peeled.some((c) => c === null)) throw new LaneError('tip-not-commit');
  const commits = [...new Set(peeled)];

  const roots = establishRoots(git, destination, decision.remoteShas);
  checkBudget();
  const negatives = roots.map((r) => `^${r}`);

  // Content: from the TIPS, so a newly published annotated-tag object is listed.
  const listed = parseObjectList(must(git(['rev-list', '--objects', '--stdin'], {
    input: `${[...tipShas, ...negatives].join('\n')}\n`,
  })));
  if (listed.length > limits.maxObjects) throw new LaneError('object-cap');
  checkBudget();

  // Paths: from the PEELED COMMITS. --root is explicit: log.showRoot=false in the
  // pusher's config would otherwise hide a root commit's paths, and a safety scan
  // whose answer varies by machine is not one.
  const rawLog = git([
    'log', '--root', '--raw', '-z', '--no-abbrev', '--no-renames', '-m', '--no-show-signature',
    '--format=%H', '--stdin',
  ], { input: `${[...commits, ...negatives].join('\n')}\n` });
  if (!rawLog.ok) throw new LaneError(rawLog.code || 'git-failed');
  const pathEntries = parseRawLog(rawLog.stdout);
  checkBudget();

  /** @type {Finding[]} */
  const findings = [];

  let pathsClassified = 0;
  const seenPaths = new Set();
  for (const e of pathEntries) {
    const key = `${e.oid}\u0000${e.path}`;
    if (seenPaths.has(key)) continue;
    seenPaths.add(key);
    pathsClassified++;
    if (classifyPath(e.path) === 'sensitive') {
      findings.push({ kind: 'path', objType: e.mode === '160000' ? 'gitlink' : 'blob', oid: e.oid, path: e.path, detail: 'sensitive-path' });
    }
  }

  // Metadata: one line per listed object, or the scan is not complete.
  let objectCount = listed.length;
  let scanned = 0;
  let excluded = 0;
  let unscanned = 0;
  if (listed.length > 0) {
    const meta = must(git(['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], {
      input: `${listed.map((o) => o.oid).join('\n')}\n`,
    })).split('\n').filter((l, i, a) => l !== '' || i < a.length - 1);
    if (meta.length !== listed.length) throw new LaneError('accounting');

    const toRead = [];
    meta.forEach((line, i) => {
      const m = /^([0-9a-f]+) (blob|tree|commit|tag) (\d+)$/.exec(line);
      if (!m || m[1] !== listed[i].oid) throw new LaneError('accounting');
      const size = Number(m[3]);
      if (m[2] === 'tree') { excluded++; return; }
      if (size > limits.maxObjectBytes) {
        unscanned++;
        findings.push({ kind: 'unscanned', objType: m[2], oid: m[1], path: listed[i].path, detail: `over-${limits.maxObjectBytes}-bytes` });
        return;
      }
      toRead.push({ oid: m[1], size, objType: m[2], path: listed[i].path });
    });

    for (const batch of batchBySize(toRead, limits.batchBytes)) {
      checkBudget();
      const bodies = readBodies(git, batch);
      batch.forEach((o, i) => {
        scanned++;
        for (const pattern of scanBodyPatterns(bodies[i].toString('latin1'), o.size)) {
          findings.push({ kind: 'secret', objType: o.objType, oid: o.oid, path: o.path, detail: pattern });
        }
      });
    }
    if (scanned + excluded + unscanned !== objectCount) throw new LaneError('accounting');
  }
  // The last batch can overrun the budget with nothing after it to notice.
  checkBudget();

  return {
    findings: dedupeFindings(findings),
    stats: { objects: objectCount, scanned, excluded, unscanned, paths: pathsClassified, roots: roots.length, tips: tipShas.length },
  };
}

// ── Reporting ───────────────────────────────────────────────────────────────

/**
 * An acknowledgement is offered only for a set small enough to be shown IN FULL.
 * It covers exactly the findings printed above it (plan D6): a fingerprint over 780
 * findings next to a list of 40 would approve 740 nobody saw. Above this, no
 * acknowledgement is offered (and none is accepted): split the push instead.
 */
export const ACK_MAX_FINDINGS = 200;

/** Findings → human lines. Matched text is never printed. */
export function formatFindings(findings, { limit = ACK_MAX_FINDINGS } = {}) {
  const lines = findings.slice(0, limit).map((f) => {
    const where = f.path ? displayPath(f.path) : `(${f.objType} object)`;
    return `   ${f.kind.padEnd(9)} ${f.objType.padEnd(7)} ${f.oid.slice(0, 8)}  ${where}  [${f.detail}]`;
  });
  if (findings.length > limit) lines.push(`   … and ${findings.length - limit} more not shown`);
  return lines;
}

function ackLines(fp) {
  return [
    '   To publish exactly this set, re-run the same push with the acknowledgement:',
    `     PowerShell:  $env:AUDIT_ARCHIVE_LANE_ACK = '${fp}'`,
    `     bash:        AUDIT_ARCHIVE_LANE_ACK=${fp} git push ...`,
  ];
}

/**
 * The full lane: decide, scan, judge. Never throws; every failure is `error`.
 *
 * @returns {{outcome: 'not-applicable'|'clean'|'findings'|'error', lines: string[], fingerprint?: string, findings?: Finding[], stats?: object}}
 */
export function runArchiveLane({ stdinText, destination, git, ack, now = Date.now, limits = LIMITS }) {
  let decision;
  try {
    decision = decidePushLane(parsePushLines(stdinText));
  } catch {
    return { outcome: 'not-applicable', lines: [], reason: 'push lines unreadable' };
  }
  if (decision.lane === 'refuse') {
    return {
      outcome: 'error',
      lines: [
        '✗ archive lane: a push line that mentions archive/ could not be read — push blocked.',
        '   Not treated as "not applicable": the full gate does not scan published content.',
        '   To force the full gate on purpose: AUDIT_PREPUSH_ARCHIVE_LANE=0',
      ],
      reason: decision.reason,
    };
  }
  if (decision.lane !== 'archive') {
    // Silent on purpose: this is the answer for EVERY ordinary push, and prose here
    // would print on all of them. The reason is on the result for tests and debugging.
    return { outcome: 'not-applicable', lines: [], reason: decision.reason };
  }

  let result;
  try {
    result = scanPublished({ git, decision, destination, now, limits });
  } catch (err) {
    const code = err instanceof LaneError ? err.code : 'internal';
    const lines = [
      `✗ archive lane: cannot complete the scan (${code}) — push blocked.`,
      `   ${ERROR_TEXT[code] ?? ERROR_TEXT.internal}.`,
    ];
    if (code === 'ls-remote-failed') lines.push(`   Destination: ${displayDestination(destination)}`);
    if (code === 'internal') lines.push(`   (${err?.constructor?.name ?? 'Error'})`);
    lines.push('   An incomplete scan is never treated as clean. To skip the lane entirely (the full gate then runs and does NOT scan published content): AUDIT_PREPUSH_ARCHIVE_LANE=0');
    return { outcome: 'error', lines };
  }

  const { findings, stats } = result;
  const summary = `→ archive lane: ${stats.objects} object(s) to publish (${stats.scanned} bodies scanned, ${stats.excluded} trees excluded, ${stats.unscanned} unscanned), ${stats.paths} path(s) classified, ${findings.length} finding(s).`;
  if (findings.length === 0) {
    const note = stats.objects === 0 ? ['   The destination already holds everything this push sends; nothing to scan.'] : [];
    return { outcome: 'clean', lines: [summary, ...note], findings, stats };
  }

  const fingerprint = fingerprintFindings(findings);
  // An acknowledgement covers only what was SHOWN, so above the cap none is accepted.
  const acknowledgeable = findings.length <= ACK_MAX_FINDINGS;
  if (acknowledgeable && ack && ack === fingerprint) {
    return { outcome: 'clean', lines: [summary, `⚠ archive lane: ${findings.length} finding(s) acknowledged by AUDIT_ARCHIVE_LANE_ACK (${fingerprint}).`], fingerprint, findings, stats };
  }
  const lines = [
    summary,
    `✗ archive lane: ${findings.length} finding(s) in what this push publishes — push blocked.`,
    ...formatFindings(findings),
    '   Matched text is never printed.',
  ];
  const redacted = findings.find((f) => f.path && classifyPath(f.path) === 'sensitive');
  if (redacted) lines.push(`   To locate a redacted path: git log --find-object=${redacted.oid} --name-only -n 1`);
  if (!acknowledgeable) {
    lines.push(`   Too many findings to acknowledge (${findings.length} > ${ACK_MAX_FINDINGS}): an acknowledgement covers only what was shown, and the list above is cut off.`,
      '   Split the push into smaller ones, or push only what the destination does not yet hold in pieces.');
  } else {
    if (ack) lines.push(`   AUDIT_ARCHIVE_LANE_ACK does not match this finding set (it is ${fingerprint}).`);
    lines.push(...ackLines(fingerprint));
  }
  return { outcome: 'findings', lines, fingerprint, findings, stats };
}

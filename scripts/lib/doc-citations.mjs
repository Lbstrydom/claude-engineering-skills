/**
 * @fileoverview Re-resolve pinned `path:line (sha)` citations and report decay.
 *
 * The failure this exists to catch is NOT a dead link. It is a line number that
 * still resolves, to different content, so the reader stops checking. Measured:
 * of nine bad claims in one verified document, five were correct when written
 * and decayed afterwards.
 *
 * Deliberately a sibling of `check-docs-refs.mjs`, not an extension of it. That
 * scanner's own doctrine is *"it checks whether a cited path RESOLVES, not
 * whether the citation is apt"*, and its drift baseline is keyed
 * `<file>→<target>` — line-independent by construction. Folding content
 * re-resolution in would either break that key or silently widen a gate already
 * load-bearing in `npm run check`.
 *
 * Contract: `docs/audit/shared-references/verification-discipline.md` §1.
 *
 * @module scripts/lib/doc-citations
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** Bounds. A breach returns `unresolvable/<reason>`, never a silent skip. */
export const LIMITS = Object.freeze({
  documentBytes: 2 * 1024 * 1024,
  citationsPerDocument: 500,
  blobBytes: 2 * 1024 * 1024,
  gitCallMs: 10_000,
  documentsPerRun: 200,
  gitCallsPerRun: 1000,
  runMs: 120_000,
});

/**
 * Stage 1 — recognise citation-SHAPED candidates.
 *
 * Deliberately loose, and with NO path rule: a candidate is a shape, not a
 * validity claim. Requiring a slash here silently excluded every root-level
 * file (`AGENTS.md:105 (b08b9a84)`), which is the fail-open this two-stage
 * split exists to prevent.
 */
const CANDIDATE_RE = /(?<![A-Za-z0-9._/-])((?:[\w.-]+\/)*[\w.-]+\.[A-Za-z0-9]+):(\d+)(?:-(\d+))?(?:\s*\(([^)\s]+)\))?/g;

/** A pinned sha: 7-40 lowercase hex, and nothing else. */
const SHA_RE = /^[0-9a-f]{7,40}$/;

/**
 * Normalisation, narrow on purpose: CRLF -> LF and trailing whitespace only.
 *
 * `\r+$`, not `\r$`: a file that git already checked out as CRLF and that a
 * tool then converted again carries `\r\r\n`, and stripping one CR leaves the
 * line unequal to its own committed form. Found by the CRLF test against a
 * fixture that had been through a real `git checkout`.
 */
export function normaliseLine(s) {
  return s.replace(/\r+$/, '').replace(/[ \t]+$/, '');
}

function splitLines(buf) {
  return buf.toString('utf8').split('\n').map(normaliseLine);
}

/** Line ranges of fenced code blocks, which are examples rather than claims. */
function fencedRanges(text) {
  const out = [];
  let open = null;
  text.split('\n').forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) {
      if (open === null) open = i; else { out.push([open, i]); open = null; }
    }
  });
  if (open !== null) out.push([open, Number.MAX_SAFE_INTEGER]);
  return out;
}

/**
 * Stage 1 + Stage 2. Every candidate lands in exactly one bucket —
 * `pinned`, `unpinned` or `malformed`. A malformed pin is REPORTED, never
 * dropped: silently ignoring it is the fail-open case this closes.
 *
 * @param {string} text
 * @returns {Array<{raw:string,path:string,line:number,endLine?:number,sha?:string,kind:string,reason?:string,docLine:number}>}
 */
export function extractCitations(text) {
  const fences = fencedRanges(text);
  const inFence = (i) => fences.some(([a, b]) => i >= a && i <= b);
  const out = [];

  text.split('\n').forEach((lineText, idx) => {
    if (inFence(idx)) return;
    for (const m of lineText.matchAll(CANDIDATE_RE)) {
      const [raw, p, lineStr, endStr, suffix] = m;
      const base = { raw, path: p, line: Number(lineStr), docLine: idx + 1 };
      if (endStr !== undefined) base.endLine = Number(endStr);

      if (suffix === undefined) {
        // Unpinned: with no sha there is nothing to separate `foo.md:12` from
        // prose, so THIS is the only place a `/` is required.
        if (!p.includes('/')) continue;
        out.push({ ...base, kind: 'unpinned' });
        continue;
      }
      if (!SHA_RE.test(suffix)) {
        out.push({ ...base, sha: suffix, kind: 'malformed', reason: 'bad-revision' });
        continue;
      }
      if (base.endLine !== undefined && base.endLine < base.line) {
        out.push({ ...base, sha: suffix, kind: 'malformed', reason: 'bad-range' });
        continue;
      }
      out.push({ ...base, sha: suffix, kind: 'pinned' });
    }
  });
  return out;
}

/**
 * A run-scoped query planner, not a per-citation subprocess wrapper.
 *
 * Resolving one citation needs a revision resolution, an ancestry check and two
 * reads; at the per-document bound that is thousands of sequential `git`
 * processes — an N+1 with a subprocess as the N. So every distinct sha is
 * resolved once, ancestry is memoised, and each `(rev, path)` blob is shared by
 * every citation that reads it.
 *
 * `repoRoot` is INJECTED rather than inferred from `process.cwd()`: that is what
 * makes the resolver testable against a temp repo, and what keeps it correct
 * once this file is synced into a consumer's `scripts/.claude-skills/`.
 */
export function createGitReader({ repoRoot, limits = LIMITS, now = () => Date.now() }) {
  const startedAt = now();
  const shaCache = new Map();
  const ancestorCache = new Map();
  const blobCache = new Map();
  const treeCache = new Map();
  let gitCalls = 0;

  const budget = () => {
    if (gitCalls >= limits.gitCallsPerRun) return 'git-call-budget';
    if (now() - startedAt > limits.runMs) return 'run-time-budget';
    return null;
  };

  const git = (args) => {
    gitCalls++;
    return execFileSync(
      'git',
      // An argument ARRAY, never a shell string; pager and textconv off so no
      // repo config can inject behaviour into a read.
      ['-c', 'core.pager=cat', ...args],
      {
        cwd: repoRoot,
        timeout: limits.gitCallMs,
        maxBuffer: limits.blobBytes,
        encoding: 'buffer',
        // Swallow git's own stderr: a bad sha in a document is an ordinary
        // finding, and letting `fatal: Needed a single revision` through makes
        // a working scan read like a crashing one.
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
  };

  return {
    get gitCalls() { return gitCalls; },
    budget,

    /** Full 40-hex, or resolve an abbreviation to its canonical id. */
    resolveSha(sha) {
      if (!SHA_RE.test(sha)) return { ok: false, reason: 'bad-revision' };
      if (shaCache.has(sha)) return shaCache.get(sha);
      let r;
      try {
        r = { ok: true, full: git(['rev-parse', '--verify', `${sha}^{commit}`]).toString('utf8').trim() };
      } catch {
        r = { ok: false, reason: 'bad-revision' };
      }
      shaCache.set(sha, r);
      return r;
    },

    /**
     * An object can exist locally while not being an ancestor of HEAD — that is
     * a different fact from an unknown sha, and the contract says so.
     */
    isAncestor(full) {
      if (ancestorCache.has(full)) return ancestorCache.get(full);
      let ok;
      try { git(['merge-base', '--is-ancestor', full, 'HEAD']); ok = true; }
      catch { ok = false; }
      ancestorCache.set(full, ok);
      return ok;
    },

    readBlobLines(rev, relPath) {
      const key = `${rev}:${relPath}`;
      if (blobCache.has(key)) return blobCache.get(key);
      let r;
      try { r = { ok: true, lines: splitLines(git(['show', `${rev}:${relPath}`])) }; }
      catch { r = { ok: false, reason: 'path-missing' }; }
      blobCache.set(key, r);
      return r;
    },

    /**
     * The CURRENT file as a reader would open it — working tree first, HEAD
     * only when the path is absent from the tree. Comparing against HEAD alone
     * would mean an author cannot verify a citation fix without committing.
     */
    readCurrentLines(relPath) {
      if (treeCache.has(relPath)) return treeCache.get(relPath);
      const abs = path.join(repoRoot, relPath);
      let r;
      if (fs.existsSync(abs)) {
        const st = fs.statSync(abs);
        r = st.size > limits.blobBytes
          ? { ok: false, reason: 'blob-too-large' }
          : { ok: true, lines: splitLines(fs.readFileSync(abs)) };
      } else {
        r = this.readBlobLines('HEAD', relPath);
      }
      treeCache.set(relPath, r);
      return r;
    },
  };
}

/** Repo-relative, no traversal, no NUL, no whitespace — checked before git sees it. */
function badPath(p) {
  if (!p || p.includes('\0') || /\s/.test(p)) return true;
  if (path.isAbsolute(p) || /^[A-Za-z]:/.test(p)) return true;
  return p.split(/[\\/]/).includes('..');
}

const unresolvable = (reason) => ({ verdict: 'unresolvable', reason });

/**
 * Resolve ONE pinned citation.
 *
 * Fail-closed throughout: an `ok` verdict must mean "I read both sides and they
 * match", never anything weaker.
 */
export function resolveCitation(reader, cite) {
  if (cite.kind === 'malformed') return unresolvable(cite.reason ?? 'bad-revision');
  if (cite.kind !== 'pinned') return { verdict: 'skipped' };

  const overBudget = reader.budget();
  if (overBudget) return unresolvable(overBudget);
  if (badPath(cite.path)) return unresolvable('bad-path');

  const resolved = reader.resolveSha(cite.sha);
  if (!resolved.ok) return unresolvable(resolved.reason);
  if (!reader.isAncestor(resolved.full)) return unresolvable('not-ancestor');

  const pinned = reader.readBlobLines(resolved.full, cite.path);
  if (!pinned.ok) return unresolvable(pinned.reason);

  const from = cite.line - 1;
  const to = (cite.endLine ?? cite.line) - 1;
  if (from < 0 || to >= pinned.lines.length) return unresolvable('line-out-of-range');
  const excerpt = pinned.lines.slice(from, to + 1);

  const current = reader.readCurrentLines(cite.path);
  if (!current.ok) return unresolvable(current.reason);

  const at = current.lines.slice(from, to + 1);
  if (at.length === excerpt.length && at.every((l, i) => l === excerpt[i])) {
    return { verdict: 'ok' };
  }

  // `moved` only when the excerpt occurs EXACTLY once elsewhere. Non-unique is
  // ambiguous, and an ambiguous re-pin is not a mechanical fix.
  const hits = [];
  for (let i = 0; i + excerpt.length <= current.lines.length; i++) {
    if (excerpt.every((l, j) => current.lines[i + j] === l)) hits.push(i + 1);
  }
  if (hits.length === 1 && hits[0] !== cite.line) return { verdict: 'moved', movedTo: hits[0] };
  return { verdict: 'drifted' };
}

/**
 * Scan documents and summarise.
 *
 * `citationsParsed` is reported so a run that parsed NOTHING cannot read as
 * clean — an all-`ok` summary over zero citations is the vacuous pass this
 * whole instrument is about.
 */
export function scanDocuments(docPaths, { repoRoot, limits = LIMITS } = {}) {
  const reader = createGitReader({ repoRoot, limits });
  const summary = {
    documentsScanned: 0, citationsParsed: 0, citationsUnpinned: 0,
    ok: 0, moved: 0, drifted: 0, unresolvable: 0,
  };
  const findings = [];

  for (const doc of docPaths.slice(0, limits.documentsPerRun)) {
    const st = fs.statSync(doc);
    if (st.size > limits.documentBytes) {
      findings.push({ document: doc, verdict: 'unresolvable', reason: 'document-too-large' });
      summary.unresolvable++;
      continue;
    }
    summary.documentsScanned++;
    const cites = extractCitations(fs.readFileSync(doc, 'utf8'));
    if (cites.length > limits.citationsPerDocument) {
      findings.push({ document: doc, verdict: 'unresolvable', reason: 'citation-budget' });
      summary.unresolvable++;
    }
    for (const c of cites.slice(0, limits.citationsPerDocument)) {
      if (c.kind === 'unpinned') { summary.citationsUnpinned++; continue; }
      summary.citationsParsed++;
      const r = resolveCitation(reader, c);
      summary[r.verdict]++;
      if (r.verdict !== 'ok') {
        findings.push({ document: doc, docLine: c.docLine, ref: c.raw, ...r });
      }
    }
  }
  return { summary, findings };
}

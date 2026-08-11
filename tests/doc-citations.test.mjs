/**
 * Tier-1 coverage for the citation re-resolver.
 *
 * The fixture is a temp git repo built INSIDE the test lifecycle — never this
 * repo's own history. Depending on a real commit is brittle under history
 * rewrite, shallow clone and object pruning, and a test cannot safely
 * manufacture historical states in the live checkout. That constraint is also
 * what forces the resolver to take an injected repo root rather than assuming
 * `process.cwd()`, which is the property the relocation contract needs anyway.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  extractCitations,
  createGitReader,
  resolveCitation,
  scanDocuments,
} from '../scripts/lib/doc-citations.mjs';

let REPO;
let SHA_A;

/** Deterministic git identity + dates so nothing depends on the ambient env. */
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
};

const git = (...args) =>
  execFileSync('git', args, { cwd: REPO, encoding: 'utf8', env: GIT_ENV }).trim();

before(() => {
  REPO = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-cite-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');

  // Commit A — the state citations are pinned at.
  fs.mkdirSync(path.join(REPO, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(REPO, 'src', 'thing.js'),
    ['const STABLE = 1;',      // :1  unchanged at HEAD      -> ok
     'const MOVES = 2;',       // :2  shifted down by insert -> moved
     'const CHANGES = 3;',     // :3  rewritten             -> drifted
     'const TWIN = 4;',        // :4  duplicated at HEAD    -> drifted (non-unique)
    ].join('\n') + '\n',
  );
  fs.writeFileSync(path.join(REPO, 'ROOTFILE.md'), 'root level line one\n');
  git('add', '.');
  git('commit', '-q', '-m', 'A');
  SHA_A = git('rev-parse', 'HEAD');

  // Commit B — HEAD. Insert above MOVES, rewrite CHANGES, duplicate TWIN.
  fs.writeFileSync(
    path.join(REPO, 'src', 'thing.js'),
    ['const STABLE = 1;',
     '// an inserted line, which shifts everything below it',
     'const MOVES = 2;',
     'const CHANGES = 99;',
     'const TWIN = 4;',
     'const TWIN = 4;',
    ].join('\n') + '\n',
  );
  git('add', '.');
  git('commit', '-q', '-m', 'B');

  // A commit that EXISTS but is not an ancestor of HEAD — distinct from an
  // unknown sha, and the case the contract calls out but the first draft of
  // this suite did not cover.
  git('checkout', '-q', '-b', 'divergent', SHA_A);
  fs.writeFileSync(path.join(REPO, 'src', 'thing.js'), 'const ORPHAN = 1;\n');
  git('add', '.');
  git('commit', '-q', '-m', 'divergent');
  global.__SHA_DIVERGENT = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'main');
});

after(() => {
  if (REPO) fs.rmSync(REPO, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

// ── Stage 1 + 2: extraction ────────────────────────────────────────────────

describe('extractCitations — two-stage, because one stage fails open', () => {
  it('extracts a pinned citation', () => {
    const c = extractCitations('see src/thing.js:2 (abc1234) for the shape');
    assert.equal(c.length, 1);
    assert.equal(c[0].kind, 'pinned');
    assert.equal(c[0].path, 'src/thing.js');
    assert.equal(c[0].line, 2);
    assert.equal(c[0].sha, 'abc1234');
  });

  it('accepts a BARE FILENAME when pinned — a root-level file is a real citation', () => {
    // The extension plus a valid hex sha already identifies it unambiguously.
    const c = extractCitations('AGENTS.md:105 (b08b9a84) says so');
    assert.equal(c.length, 1);
    assert.equal(c[0].kind, 'pinned');
    assert.equal(c[0].path, 'AGENTS.md');
  });

  it('requires a slash for an UNPINNED candidate — nothing else separates it from prose', () => {
    assert.equal(extractCitations('see foo.md:12 somewhere').length, 0);
    const c = extractCitations('see docs/foo.md:12 somewhere');
    assert.equal(c.length, 1);
    assert.equal(c[0].kind, 'unpinned');
  });

  it('classifies a malformed pin as MALFORMED, never as silence', () => {
    // The fail-open case: a citation-shaped token with a bad suffix must not
    // fall through as ordinary prose.
    for (const [text, reason] of [
      ['docs/x.md:12 (HEAD~3)', 'bad-revision'],
      ['docs/x.md:12 (ABC1234)', 'bad-revision'],   // uppercase is not our grammar
      ['docs/x.md:12 (zzzzzzz)', 'bad-revision'],   // not hex
      ['docs/x.md:20-10 (abc1234)', 'bad-range'],   // inverted
    ]) {
      const c = extractCitations(text);
      assert.equal(c.length, 1, `expected one candidate for ${text}`);
      assert.equal(c[0].kind, 'malformed', `expected malformed for ${text}`);
      assert.equal(c[0].reason, reason, `expected ${reason} for ${text}`);
    }
  });

  it('parses an inclusive range', () => {
    const c = extractCitations('src/thing.js:1-3 (abc1234)');
    assert.equal(c[0].line, 1);
    assert.equal(c[0].endLine, 3);
  });

  it('ignores citations inside a fenced code block', () => {
    const text = ['before docs/a.md:1 (abc1234)',
      '```', 'docs/b.md:2 (abc1234)', '```',
      'after docs/c.md:3 (abc1234)'].join('\n');
    const paths = extractCitations(text).map(c => c.path);
    assert.deepEqual(paths, ['docs/a.md', 'docs/c.md']);
  });

  it('finds multiple citations on one line', () => {
    assert.equal(extractCitations('a/b.js:1 (abc1234) and c/d.js:2 (def5678)').length, 2);
  });
});

// ── Verdicts ───────────────────────────────────────────────────────────────

describe('resolveCitation — four verdicts against a real git fixture', () => {
  const reader = () => createGitReader({ repoRoot: REPO });
  const cite = (over) => ({ path: 'src/thing.js', sha: SHA_A, kind: 'pinned', ...over });

  it('ok — content identical at the cited location', () => {
    assert.equal(resolveCitation(reader(), cite({ line: 1 })).verdict, 'ok');
  });

  it('moved — shifted by an insertion above, found exactly once elsewhere', () => {
    const r = resolveCitation(reader(), cite({ line: 2 }));
    assert.equal(r.verdict, 'moved');
    assert.equal(r.movedTo, 3, 'the report names the new line so the re-pin is mechanical');
  });

  it('drifted — content rewritten and absent elsewhere', () => {
    assert.equal(resolveCitation(reader(), cite({ line: 3 })).verdict, 'drifted');
  });

  it('drifted, NOT moved — the excerpt appears twice at HEAD, so it is ambiguous', () => {
    const r = resolveCitation(reader(), cite({ line: 4 }));
    assert.equal(r.verdict, 'drifted');
    assert.equal(r.movedTo, undefined);
  });
});

// ── Fail-closed ────────────────────────────────────────────────────────────

describe('fail-closed — never `ok` when it could not read both sides', () => {
  const reader = () => createGitReader({ repoRoot: REPO });

  it('unknown sha', () => {
    const r = resolveCitation(reader(), {
      path: 'src/thing.js', line: 1, sha: 'dead000', kind: 'pinned',
    });
    assert.equal(r.verdict, 'unresolvable');
    assert.equal(r.reason, 'bad-revision');
  });

  it('a sha that EXISTS but is not an ancestor of HEAD — not the same as unknown', () => {
    const r = resolveCitation(reader(), {
      path: 'src/thing.js', line: 1, sha: global.__SHA_DIVERGENT, kind: 'pinned',
    });
    assert.equal(r.verdict, 'unresolvable');
    assert.equal(r.reason, 'not-ancestor');
  });

  it('path absent at the pinned sha', () => {
    const r = resolveCitation(reader(), {
      path: 'src/added-later.js', line: 1, sha: SHA_A, kind: 'pinned',
    });
    assert.equal(r.verdict, 'unresolvable');
    assert.equal(r.reason, 'path-missing');
  });

  it('line beyond EOF', () => {
    const r = resolveCitation(reader(), { path: 'src/thing.js', line: 9999, sha: SHA_A, kind: 'pinned' });
    assert.equal(r.verdict, 'unresolvable');
    assert.equal(r.reason, 'line-out-of-range');
  });

  it('rejects revision syntax that is not a plain object id', () => {
    for (const sha of ['HEAD~3', '@{u}', ':/msg', 'main^{/re}']) {
      const r = resolveCitation(reader(), { path: 'src/thing.js', line: 1, sha, kind: 'pinned' });
      assert.equal(r.verdict, 'unresolvable', `expected unresolvable for ${sha}`);
      assert.equal(r.reason, 'bad-revision');
    }
  });

  it('rejects path shapes that could escape the repo', () => {
    for (const p of ['/etc/passwd', '../outside.js', 'src/\u0000evil.js']) {
      const r = resolveCitation(reader(), { path: p, line: 1, sha: SHA_A, kind: 'pinned' });
      assert.equal(r.verdict, 'unresolvable', `expected unresolvable for ${p}`);
      assert.equal(r.reason, 'bad-path');
    }
  });
});

// ── Normalisation ──────────────────────────────────────────────────────────

describe('normalisation is narrow on purpose', () => {
  it('CRLF equals LF, but a real content change still reports', () => {
    const target = path.join(REPO, 'src', 'thing.js');
    const lf = fs.readFileSync(target, 'utf8');
    fs.writeFileSync(target, lf.replace(/\n/g, '\r\n'));
    try {
      const r = resolveCitation(createGitReader({ repoRoot: REPO }), {
        path: 'src/thing.js', line: 1, sha: SHA_A, kind: 'pinned',
      });
      assert.equal(r.verdict, 'ok', 'CRLF in the working tree must not read as drift');
    } finally {
      fs.writeFileSync(target, lf);
    }
  });
});

// ── Document scan + the vacuous-pass guard ─────────────────────────────────

describe('scanDocuments', () => {
  it('counts what it parsed, and the probe finds a citation it MUST find', () => {
    const doc = path.join(REPO, 'NOTES.md');
    fs.writeFileSync(doc,
      `pinned ok: src/thing.js:1 (${SHA_A})\n`
      + `pinned moved: src/thing.js:2 (${SHA_A})\n`
      + 'unpinned: docs/whatever.md:9\n');
    const r = scanDocuments([doc], { repoRoot: REPO });

    // Vacuous-pass guard: without this, an always-empty extractor passes every
    // "expect no drift" assertion in this file.
    assert.ok(r.summary.citationsParsed >= 2, 'the extractor found nothing — the probe is broken');
    assert.equal(r.summary.citationsUnpinned, 1);
    assert.equal(r.summary.ok, 1);
    assert.equal(r.summary.moved, 1);
    assert.equal(r.summary.documentsScanned, 1);
  });

  it('a malformed pin is reported, not silently dropped', () => {
    const doc = path.join(REPO, 'BAD.md');
    fs.writeFileSync(doc, 'src/thing.js:1 (HEAD~3)\n');
    const r = scanDocuments([doc], { repoRoot: REPO });
    assert.equal(r.summary.unresolvable, 1);
    assert.equal(r.findings[0].reason, 'bad-revision');
  });
});

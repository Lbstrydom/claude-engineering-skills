import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  REFS_GRAMMAR_VERSION,
  extractRefs,
  classifyRef,
  isLiveSurface,
  scanPolicy,
  isExcluded,
  EXCLUSIONS,
  BASELINE,
  lintFile,
  runCheck,
  gitIndexFiles,
} from '../scripts/check-docs-refs.mjs';

// ── extractRefs — the grammar contract (table-driven) ─────────────────────
//
// Contract: docs/reference/reference-integrity.md §1. Every row here is a
// clause of that document. Negative rows matter as much as positive ones —
// the round-3 draft of this grammar was self-contradictory and its round-4
// boundary rule silently dropped every prose citation ending a sentence.

describe('check-docs-refs / extractRefs — grammar', () => {
  const CASES = [
    // ── concrete, positive ────────────────────────────────────────────────
    ['bare token', 'docs/plans/a.md', [{ target: 'docs/plans/a.md', kind: 'concrete' }]],
    ['in prose', 'See docs/plans/a.md for detail', [{ target: 'docs/plans/a.md', kind: 'concrete' }]],
    ['nested segments', 'docs/completed/x/y.md', [{ target: 'docs/completed/x/y.md', kind: 'concrete' }]],
    ['backticked', 'the `docs/plans/a.md` file', [{ target: 'docs/plans/a.md', kind: 'concrete' }]],

    // ── G1: trailing punctuation must NOT be swallowed ───────────────────
    ['sentence-ending period', 'See docs/plans/a.md.', [{ target: 'docs/plans/a.md', kind: 'concrete' }]],
    ['trailing comma', 'docs/plans/a.md, and more', [{ target: 'docs/plans/a.md', kind: 'concrete' }]],
    ['trailing paren', '(docs/plans/a.md)', [{ target: 'docs/plans/a.md', kind: 'concrete' }]],
    ['trailing colon', 'docs/plans/a.md:', [{ target: 'docs/plans/a.md', kind: 'concrete' }]],

    // ── trailing lookahead: .mdx is NOT .md ──────────────────────────────
    ['mdx is not md', 'docs/plans/a.mdx', []],
    ['stem continues', 'docs/plans/a.mdfoo', []],

    // ── R2-H4: a `.md` that is the PREFIX of a longer token must not extract.
    // The real token is `.md.bak` (a backup file) or `.md/obsolete` (a path
    // INTO the file) — neither is a `.md` citation, so extracting `real.md`
    // would mis-resolve. The guard must NOT fire on a sentence period, though.
    ['md.bak is not a citation', 'docs/plans/real.md.bak', []],
    ['md/obsolete is not a citation', '[p](docs/plans/real.md/obsolete)', []],
    ['sentence period still terminates', 'See docs/plans/real.md. Next.', [{ target: 'docs/plans/real.md', kind: 'concrete' }]],
    // R3-M3: the continuation guard's char class must equal SEG/STEM — those
    // permit `.` and `-`, so these are continuations too, not terminations.
    ['dot-dash continuation', 'docs/plans/a.md.-foo', []],
    ['double-dot continuation', 'docs/plans/a.md..x', []],
    ['a genuinely longer .md file still matches whole', 'docs/plans/a.md.v2.md', [{ target: 'docs/plans/a.md.v2.md', kind: 'concrete' }]],

    // ── R2-H3: a CommonMark angle-bracket link destination is a real citation.
    ['angle-bracket link destination', '[missing](<docs/plans/missing.md>)', [{ target: 'docs/plans/missing.md', kind: 'concrete' }]],

    // ── leading lookbehind: cross-repo is structurally invisible ─────────
    ['cross-repo prefix', 'Plan: wine-cellar-app/docs/plans/a.md', []],
    ['path-prefixed', 'some/docs/plans/a.md', []],
    ['mid-word (worddocs)', 'worddocs/plans/a.md', []],

    // ── G1: a bold-wrapped citation must be VISIBLE (was a false negative —
    // the leading lookbehind excluded `*`). Also the common `**path**` — one
    // side markered, the other prose.
    ['bold-wrapped', '**docs/plans/a.md**', [{ target: 'docs/plans/a.md', kind: 'concrete' }]],
    ['bold in prose', 'See **docs/plans/a.md** now', [{ target: 'docs/plans/a.md', kind: 'concrete' }]],
    // Italic's LEADING `_` is now allowed too; a trailing `_` immediately after
    // `.md` stays ambiguous with a filename char (`real.md_v2`) and does not
    // terminate — a documented limitation (italic wrapping a path is rare; bold
    // is the common form and fully works).
    ['italic leading, spaced close', '_ docs/plans/a.md _', [{ target: 'docs/plans/a.md', kind: 'concrete' }]],

    // ── placeholders ─────────────────────────────────────────────────────
    ['bracketed stem', 'docs/plans/<name>.md', [{ target: 'docs/plans/<name>.md', kind: 'placeholder' }]],
    ['glob stem', 'docs/plans/*.md', [{ target: 'docs/plans/*.md', kind: 'placeholder' }]],
    ['glob partial stem', 'docs/completed/phase-*-audit.md', [{ target: 'docs/completed/phase-*-audit.md', kind: 'placeholder' }]],

    // ── markdown links ───────────────────────────────────────────────────
    ['inline link', '[x](docs/plans/a.md)', [{ target: 'docs/plans/a.md', kind: 'concrete' }]],
    ['link with fragment', '[x](docs/plans/a.md#heading)', [{ target: 'docs/plans/a.md', kind: 'concrete' }]],
    ['reference definition', '[id]: docs/plans/a.md', [{ target: 'docs/plans/a.md', kind: 'concrete' }]],
    // No per-context special case: a token is a citation wherever it appears,
    // including a link LABEL — a label naming a path is a claim about that path.
    // Two sites is correct here; both resolve identically, one edit fixes both.
    ['label AND destination', '[docs/plans/a.md](docs/plans/a.md)', [
      { target: 'docs/plans/a.md', kind: 'concrete' },
      { target: 'docs/plans/a.md', kind: 'concrete' },
    ]],
    ['label only (external dest)', '[docs/plans/a.md](https://x.com)', [{ target: 'docs/plans/a.md', kind: 'concrete' }]],

    // ── multiple sites per line ──────────────────────────────────────────
    ['two on one line', 'docs/plans/a.md and docs/plans/b.md', [
      { target: 'docs/plans/a.md', kind: 'concrete' },
      { target: 'docs/plans/b.md', kind: 'concrete' },
    ]],

    // ── not citations at all ─────────────────────────────────────────────
    ['bare dir', 'docs/plans/', []],
    ['no docs prefix', 'scripts/lib/a.md', []],
    ['space inside', 'docs/plans/my plan.md', []],
  ];

  for (const [name, input, expected] of CASES) {
    it(`${name}: ${JSON.stringify(input)}`, () => {
      const got = extractRefs(input).map(r => ({ target: r.target, kind: r.kind }));
      assert.deepEqual(got, expected);
    });
  }

  it('traversal is extracted but flagged, never resolved', () => {
    const got = extractRefs('docs/plans/../../etc/passwd.md');
    assert.equal(got.length, 1);
    assert.equal(got[0].traversal, true);
  });

  it('every site carries a string offset so suppression is traceable', () => {
    // offset is a JS string index (UTF-16 code units, from String#match),
    // used only to locate the token within its line — not a byte offset.
    const got = extractRefs('xx docs/plans/a.md');
    assert.equal(got[0].offset, 3);
  });

  it('exports a versioned grammar', () => {
    assert.equal(typeof REFS_GRAMMAR_VERSION, 'number');
  });
});

// ── the (planned) marker ──────────────────────────────────────────────────

describe('check-docs-refs / (planned) marker', () => {
  it('binds when immediately following', () => {
    assert.equal(extractRefs('docs/plans/a.md (planned)')[0].planned, true);
  });

  it('binds through a closing backtick', () => {
    assert.equal(extractRefs('`docs/plans/a.md` (planned)')[0].planned, true);
  });

  it('does NOT bind from elsewhere in the sentence', () => {
    assert.equal(extractRefs('docs/plans/a.md is (planned) eventually')[0].planned, false);
  });

  // The separator is a LITERAL space, never `\s`. `\s` matches tab/CR/LF, which
  // let a marker on the FOLLOWING LINE bind to this token and silently suppress
  // a real GONE finding. Both of these bound wrongly before the fix.
  it('does NOT bind across a tab', () => {
    assert.equal(extractRefs('docs/plans/a.md\t(planned)')[0].planned, false);
  });

  it('does NOT bind across a newline — a marker on the next line is not this token\'s', () => {
    assert.equal(extractRefs('docs/plans/a.md\n(planned)')[0].planned, false);
  });

  it('does NOT bind across a CR (CRLF files)', () => {
    assert.equal(extractRefs('docs/plans/a.md\r\n(planned)')[0].planned, false);
  });

  it('does NOT bind across two spaces', () => {
    assert.equal(extractRefs('docs/plans/a.md  (planned)')[0].planned, false);
  });

  // R4-M2: a closing `)`/backtick REQUIRES its following space. Without it, a
  // link's close paren abutting the marker (`...missing.md)(planned)`) would
  // bind and suppress a real GONE — the gate's cardinal sin.
  it('does NOT bind when a closing paren abuts the marker (no space)', () => {
    assert.equal(extractRefs('[x](docs/plans/missing.md)(planned)')[0].planned, false);
  });

  it('DOES bind with a closing paren THEN one space', () => {
    assert.equal(extractRefs('[x](docs/plans/a.md) (planned)')[0].planned, true);
  });

  it('DOES bind with a closing backtick THEN one space', () => {
    assert.equal(extractRefs('`docs/plans/a.md` (planned)')[0].planned, true);
  });

  // Gemini G1: REF_RE stops at .md, so a URL fragment/query lands in the tail
  // the marker check sees. The marker must survive it, or a legitimate planned
  // ref with a fragment gets wrongly flagged GONE (a false positive).
  it('binds across a URL fragment (markdown link + #anchor)', () => {
    assert.equal(extractRefs('[x](docs/plans/a.md#phase-1) (planned)')[0].planned, true);
  });

  it('binds across a query string', () => {
    assert.equal(extractRefs('docs/plans/a.md?v=2 (planned)')[0].planned, true);
  });

  it('binds across a Markdown link title (G2)', () => {
    assert.equal(extractRefs('[Plan](docs/plans/a.md "Title") (planned)')[0].planned, true);
  });

  it('a fragment without a marker still does NOT bind', () => {
    assert.equal(extractRefs('[x](docs/plans/a.md#phase-1) and more')[0].planned, false);
  });

  // Gemini round-2 G1: a self-linking label with a marker. Both the label site
  // and the destination site must bind, or the label alone throws an
  // un-suppressible GONE — contradicting the "both resolve identically" contract.
  it('binds on BOTH sites of a self-linking label with a marker', () => {
    const got = extractRefs('[docs/plans/a.md](docs/plans/a.md) (planned)');
    assert.equal(got.length, 2);
    assert.equal(got[0].planned, true, 'label site must bind through the ](dest)');
    assert.equal(got[1].planned, true, 'destination site must bind');
  });

  it('binds to its OWN token only', () => {
    const got = extractRefs('docs/plans/a.md and docs/plans/b.md (planned)');
    assert.equal(got[0].planned, false, 'first token must not inherit the marker');
    assert.equal(got[1].planned, true);
  });
});

// ── classifyRef ───────────────────────────────────────────────────────────

describe('check-docs-refs / classifyRef', () => {
  const index = new Set(['docs/plans/real.md', 'docs/completed/old.md']);

  it('RESOLVES when the target is in the git index', () => {
    assert.equal(classifyRef(extractRefs('docs/plans/real.md')[0], index).class, 'RESOLVES');
  });

  it('GONE when it is not', () => {
    assert.equal(classifyRef(extractRefs('docs/plans/ghost.md')[0], index).class, 'GONE');
  });

  it('PLACEHOLDER is never resolved', () => {
    const r = classifyRef(extractRefs('docs/plans/<name>.md')[0], index);
    assert.equal(r.class, 'PLACEHOLDER');
    assert.equal(r.resolved, undefined);
  });

  it('a (planned) marker suppresses GONE', () => {
    assert.equal(classifyRef(extractRefs('docs/plans/ghost.md (planned)')[0], index).class, 'PLANNED');
  });

  it('a (planned) marker on a resolving target is itself a finding', () => {
    assert.equal(
      classifyRef(extractRefs('docs/plans/real.md (planned)')[0], index).class,
      'stale-planned-marker',
    );
  });

  it('traversal is a finding, never resolved', () => {
    assert.equal(classifyRef(extractRefs('docs/plans/../x.md')[0], index).class, 'traversal');
  });

  it('resolution is case-EXACT (git index, not the Windows filesystem)', () => {
    // R13: fs.existsSync would say "yes" on Windows and "no" on Linux CI.
    assert.equal(classifyRef(extractRefs('docs/plans/Real.md')[0], index).class, 'GONE');
  });

  it('MOVED is NOT in the classifier vocabulary (R2-H2)', () => {
    // MOVED is migration-time-only and needs a relocation manifest this gate
    // does not have. If it ever reappears here, someone reintroduced a
    // history-dependent heuristic.
    const classes = new Set();
    for (const s of ['docs/plans/real.md', 'docs/plans/ghost.md', 'docs/plans/<n>.md', 'docs/plans/../x.md']) {
      classes.add(classifyRef(extractRefs(s)[0], index).class);
    }
    assert.equal(classes.has('MOVED'), false);
  });
});

// ── scanPolicy ────────────────────────────────────────────────────────────

describe('check-docs-refs / scanPolicy', () => {
  it('classifies known text extensions', () => {
    for (const p of ['a.md', 'a.mjs', 'a.js', 'a.json', 'a.sql', 'a.sh', 'a.yml']) {
      assert.equal(scanPolicy(p), 'text', p);
    }
  });

  it('classifies extensionless basenames that carry real citations', () => {
    // Measured from the tracked inventory — both carry citations today.
    assert.equal(scanPolicy('.gitignore'), 'text');
    assert.equal(scanPolicy('.githooks/pre-push'), 'text');
  });

  it('classifies binaries', () => {
    for (const p of ['a.png', 'a.svg', 'a.woff2', 'a.ico']) {
      assert.equal(scanPolicy(p), 'binary', p);
    }
  });

  it('an unknown kind is unclassified — NOT silently skipped', () => {
    assert.equal(scanPolicy('a.rs'), 'unclassified');
  });

  it('classifies EVERY file in the repo\'s real tracked inventory', () => {
    // Derived from the live inventory, not a hardcoded list — a hardcoded list
    // would rot exactly like the citations this gate exists to catch. If
    // someone adds a tracked .rs file, this test fails and forces an explicit
    // policy decision instead of letting the file vanish from coverage.
    let files;
    try {
      files = gitIndexFiles(path.resolve(import.meta.dirname, '..'));
    } catch {
      return; // not a git checkout (e.g. a tarball install) — nothing to derive
    }
    const unclassified = files.filter(f => scanPolicy(f) === 'unclassified');
    assert.deepEqual(
      unclassified, [],
      `unclassified tracked files — add each to TEXT_EXT/BINARY_EXT/TEXT_BASENAMES ` +
      `in scanPolicy() with an explicit decision:\n  ${unclassified.join('\n  ')}`,
    );
  });
});

// ── exclusions ────────────────────────────────────────────────────────────

describe('check-docs-refs / exclusions', () => {
  it('excludes the FROZEN sha256-pinned migrations', () => {
    // The expensive one: editing a comment in an applied migration changes its
    // file hash and breaks the migration ledger for every consumer repo.
    assert.equal(isExcluded('supabase/migrations/20260101000000_x.sql')?.id, 'FROZEN');
  });

  it('excludes the research CORPUS', () => {
    assert.equal(
      isExcluded('docs/experiments/audit-effectiveness/known-defects.candidates.json')?.id,
      'CORPUS',
    );
  });

  it('excludes the VENDORED kit', () => {
    assert.equal(isExcluded('docs/plans/security/files/scripts/x.mjs')?.id, 'VENDORED');
  });

  it('excludes the append-only session log', () => {
    assert.equal(isExcluded('status.md')?.id, 'HISTORICAL');
  });

  it('excludes the test surface (FIXTURE) — tests construct synthetic doc paths as data', () => {
    assert.equal(isExcluded('tests/arch-memory-followups.test.mjs')?.id, 'FIXTURE');
    assert.equal(isExcluded('tests/claudemd/fixtures/clean/CLAUDE.md')?.id, 'FIXTURE');
    // but the gate's OWN test stays under SPEC (more specific intent), not FIXTURE
    assert.equal(isExcluded('tests/check-docs-refs.test.mjs')?.id, 'SPEC');
  });

  it('excludes tool-owned runtime archives (TOOL_OWNED)', () => {
    assert.equal(isExcluded('docs/arm-eval/sessions/20260704-x.md')?.id, 'TOOL_OWNED');
    assert.equal(isExcluded('docs/arm-eval/worksheets/queue.md')?.id, 'TOOL_OWNED');
  });

  it('excludes the grammar\'s own SPEC (use vs mention)', () => {
    // A doc that defines the notation must show the notation; those tokens are
    // mentions, not claims. Same class as egress-path-scan.mjs's own security
    // patterns self-tripping its own gate — which names "their tests" too, and
    // a grammar's fixtures are necessarily made of the tokens it parses.
    assert.equal(isExcluded('docs/reference/reference-integrity.md')?.id, 'SPEC');
    assert.equal(isExcluded('docs/plans/reference-integrity-gate.md')?.id, 'SPEC');
    assert.equal(isExcluded('scripts/check-docs-refs.mjs')?.id, 'SPEC');
    assert.equal(isExcluded('tests/check-docs-refs.test.mjs')?.id, 'SPEC');
  });

  it('the SPEC exclusion is a 4-file allowlist, NOT a directory glob', () => {
    // Any wider and it starts hiding real breakage — other plans and other
    // reference docs make real claims and must stay checked.
    assert.equal(isExcluded('docs/reference/model-resolution.md'), null);
    assert.equal(isExcluded('docs/plans/some-other-plan.md'), null);
  });

  it('does not exclude ordinary source', () => {
    assert.equal(isExcluded('scripts/lib/audit/tiered-pipeline.mjs'), null);
  });

  it('every exclusion declares a reason in source', () => {
    for (const e of EXCLUSIONS) {
      assert.ok(e.id, 'exclusion needs an id');
      assert.ok(e.reason && e.reason.length > 20, `${e.id} needs a substantive reason`);
    }
  });
});

// ── scanner safety (INC-001 class) + the success-path holes ───────────────

describe('check-docs-refs / runCheck — scanner safety', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refs-')); });
  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* ignore */ }
  });

  it('refuses a symlink outright — never follows it', () => {
    const target = path.join(dir, 'secret.txt');
    fs.writeFileSync(target, 'docs/plans/a.md');
    const link = path.join(dir, 'innocent.md');
    try { fs.symlinkSync(target, link); } catch { return; } // needs privilege on Windows
    const r = runCheck({ repoRoot: dir, files: ['innocent.md'], index: new Set() });
    assert.equal(r.ok, false);
    assert.ok(r.failures.some(f => f.rule === 'scanner/symlink-refused'));
    assert.equal(r.sites.length, 0, 'a refused symlink must never be read');
  });

  it('an unreadable file is a non-zero failure, never a silent skip', () => {
    const r = runCheck({ repoRoot: dir, files: ['does-not-exist.md'], index: new Set() });
    assert.equal(r.ok, false);
    assert.ok(r.failures.length > 0);
  });

  it('an unclassified tracked file cannot produce an unqualified green', () => {
    fs.writeFileSync(path.join(dir, 'weird.rs'), 'docs/plans/a.md');
    const r = runCheck({ repoRoot: dir, files: ['weird.rs'], index: new Set() });
    assert.equal(r.ok, false, 'unclassified input must make the run non-zero');
    assert.ok(r.failures.some(f => f.rule === 'scan/unclassified-input'));
  });

  it('an EMPTY scan set is not a green — it means nothing was checked', () => {
    // "Audit your success paths": can this return 0 findings without having
    // checked anything? It must not.
    const r = runCheck({ repoRoot: dir, files: [], index: new Set() });
    assert.equal(r.ok, false);
    assert.ok(r.failures.some(f => f.rule === 'scan/empty-scan-set'));
  });

  it('a clean file with a resolving ref IS a green', () => {
    fs.writeFileSync(path.join(dir, 'ok.md'), 'See docs/plans/a.md.');
    const r = runCheck({ repoRoot: dir, files: ['ok.md'], index: new Set(['docs/plans/a.md']) });
    assert.equal(r.ok, true);
    assert.equal(r.findings.length, 0);
    assert.equal(r.sites.length, 1);
  });
});

// ── drift-gate (the durable design from the 2026-07-18 multi-LLM review) ────

describe('check-docs-refs / drift-gate', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refs-drift-')); });
  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* ignore */ }
  });

  it('under --gating, a BASELINED GONE does NOT fail — only net-new drift does', () => {
    fs.writeFileSync(path.join(dir, 'note.md'), 'See docs/plans/ghost.md');
    const baseline = new Set(['note.md→docs/plans/ghost.md']);
    const r = runCheck({ repoRoot: dir, files: ['note.md'], index: new Set(), gating: true, baseline });
    assert.equal(r.ok, true, 'a baselined GONE must not fail the drift-gate');
    assert.equal(r.findings.length, 1);
    assert.equal(r.drift.length, 0);
    assert.equal(r.baselined, 1);
  });

  it('under --gating, a NET-NEW GONE (not in baseline) FAILS', () => {
    fs.writeFileSync(path.join(dir, 'note.md'), 'See docs/plans/newlybroken.md');
    const r = runCheck({ repoRoot: dir, files: ['note.md'], index: new Set(), gating: true, baseline: new Set() });
    assert.equal(r.ok, false);
    assert.equal(r.drift.length, 1);
  });

  it('the real BASELINE is a set of `<file>→<target>` keys, each a target the grammar can actually emit', () => {
    assert.ok(BASELINE.size > 0);
    // Widened 2026-07-31 with the code-path grammar: a baseline target is now
    // either a `docs/**.md` ref or a repo code path. Deliberately still a
    // WHITELIST of the two shapes the extractors can produce, not `.+` — the
    // point of this guard is that a typo'd or hand-invented key can never sit in
    // the baseline silently suppressing nothing (it would look like coverage
    // while matching no finding the gate can raise).
    const DOCS = /→docs\/.+\.md$/;
    const CODE = /→(?:scripts|tests|supabase|defaults|dashboard|\.github|\.githooks)\/.+\.(?:mjs|cjs|js|ts|json|sql|sh|ya?ml)$/;
    for (const key of BASELINE) {
      assert.ok(
        DOCS.test(key) || CODE.test(key),
        `baseline key must end in a docs/**.md ref or a repo code path: ${key}`,
      );
    }
  });

  it('the code-path grammar only applies to LIVE surfaces, never to point-in-time records', () => {
    // The scoping is the design, so it gets a test: a plan citing a since-deleted
    // module is accurate history, and making it a finding would corrupt the
    // record (and bury the live-surface findings under ~400 historical ones).
    for (const live of ['AGENTS.md', 'CLAUDE.md', 'README.md',
      'skills/ship/SKILL.md', '.claude/skills/ship/SKILL.md',
      'docs/reference/skill-surface-ownership.md', 'docs/runbooks/consumer-adoption.md']) {
      assert.equal(isLiveSurface(live), true, `${live} must be a live surface`);
    }
    for (const historical of ['docs/plans/some-plan.md', 'docs/research/experiment-4.md',
      'docs/arm-eval/sessions/x.md', 'status.md', 'docs/experiments/y.md']) {
      assert.equal(isLiveSurface(historical), false, `${historical} must NOT be a live surface`);
    }
  });

  it('code-path refs are extracted only when asked, and consumer-layout paths resolve', () => {
    const text = 'see scripts/lib/foo.mjs and scripts/.claude-skills/bar.mjs';
    assert.equal(extractRefs(text).length, 0, 'off by default — docs-only grammar');
    const refs = extractRefs(text, { codePaths: true });
    assert.deepEqual(refs.map((r) => r.target),
      ['scripts/lib/foo.mjs', 'scripts/.claude-skills/bar.mjs']);
    // The consumer-layout path is absent from this repo BY DESIGN, so it must
    // classify as resolved rather than as rot.
    const cls = classifyRef(refs[1], new Set());
    assert.equal(cls.class, 'RESOLVES');
    assert.equal(classifyRef(refs[0], new Set()).class, 'GONE');
  });

  it('a STALE baseline entry (its target now resolves) is drift — the baseline self-cleans (M3)', () => {
    fs.writeFileSync(path.join(dir, 'note.md'), 'See docs/plans/real.md');
    const baseline = new Set(['note.md→docs/plans/real.md']);
    // real.md now EXISTS in the index → the baseline entry is stale.
    const r = runCheck({ repoRoot: dir, files: ['note.md'], index: new Set(['docs/plans/real.md']), gating: true, baseline });
    assert.equal(r.ok, false, 'a stale baseline entry must fail the gate');
    assert.deepEqual(r.staleBaseline, ['note.md→docs/plans/real.md']);
  });
});

// ── lintFile ──────────────────────────────────────────────────────────────

describe('check-docs-refs / lintFile', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refs-lf-')); });
  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* ignore */ }
  });

  it('reports line numbers for each site', () => {
    fs.writeFileSync(path.join(dir, 'a.md'), 'line one\nsee docs/plans/ghost.md\n');
    const r = lintFile(path.join(dir, 'a.md'), { repoRoot: dir, index: new Set() });
    assert.equal(r.sites.length, 1);
    assert.equal(r.sites[0].line, 2);
  });

  it('an excluded file is not scanned', () => {
    const p = path.join(dir, 'status.md');
    fs.writeFileSync(p, 'docs/plans/ghost.md');
    const r = lintFile(p, { repoRoot: dir, index: new Set(), rel: 'status.md' });
    assert.equal(r.excluded?.id, 'HISTORICAL');
    assert.equal(r.sites.length, 0);
  });
});

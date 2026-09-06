/**
 * @fileoverview Guards a twice-recurring class: a skill instructing an agent to
 * `git add` a path that is gitignored.
 *
 * WHY MECHANICAL, NOT PROSE. This happened twice. First `dashboard/index.html`
 * (reclassified B → A in 2026-06); the fix was a prose "do NOT stage" note in
 * `/ship`. Then `docs/architecture-map.md` (reclassified B → A on 2026-07-20)
 * kept its `git add` line for six days, sitting TWO STEPS ABOVE that very note,
 * and an agent followed it on 2026-07-26. Prose next to the mistake did not stop
 * the mistake.
 *
 * The failure is silent by construction: `git add` on a gitignored path exits
 * non-zero, and the offending line paired it with `2>/dev/null || true`, so the
 * agent saw nothing and could reasonably believe the artifact had shipped.
 *
 * SCOPE — deliberately narrow. This checks only literal, non-placeholder paths in
 * `git add` commands inside the authoritative `skills/**` markdown. Placeholders
 * (`<list of changed source files>`, `$ARGUMENTS`, globs) are unresolvable at lint
 * time and are skipped rather than guessed at. That keeps the check deterministic:
 * every flagged line is unambiguously wrong.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const SKILLS_DIR = 'skills';

/** Recursively collect every markdown file under the authoritative skills tree. */
function markdownFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...markdownFiles(full));
    else if (entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

/**
 * A token is lint-resolvable only if it looks like a concrete repo path.
 * Anything templated, globbed, or flag-like is skipped — see the SCOPE note.
 */
function isResolvablePath(token) {
  if (!token) return false;
  if (/[<>*?$`{}|]/.test(token)) return false;      // placeholder / glob / interpolation
  if (token.startsWith('-')) return false;           // a flag, e.g. -A
  if (token === '.' || token === '..') return false; // bulk add — a separate rule
  return token.includes('/') || token.includes('.'); // path-ish
}

/**
 * Extract staged paths from the EXECUTABLE lines of a skill document.
 *
 * Only lines inside a shell fence count. A skill's prose routinely discusses
 * `git add` in backticks — including this very rule's own rationale, and the
 * "do NOT stage X" notes — and treating that as an instruction produces exactly
 * the false positive that would get this guard disabled. The distinction is
 * real, not a convenience: a fenced shell line is what an agent runs; prose is
 * what it reads.
 *
 * Within a fence, a `#`-comment line is still documentation, not a command.
 */
function stagedPathsIn(content) {
  const found = [];
  let inShellFence = false;
  content.split('\n').forEach((line, i) => {
    const fence = line.trim().match(/^```+\s*(\w+)?/);
    if (fence) {
      // Closing fence has no language; opening fence may name one.
      inShellFence = inShellFence ? false : ['bash', 'sh', 'shell', 'console'].includes(fence[1] ?? '');
      return;
    }
    if (!inShellFence) return;
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) return;
    const m = trimmed.match(/git add\s+([^\n#]*)/);
    if (!m) return;
    for (const p of m[1].split(/\s+/).filter(isResolvablePath)) {
      found.push({ path: p, line: i + 1 });
    }
  });
  return found;
}

/** True when git would refuse to stage this path without -f. */
function isGitIgnored(p) {
  try {
    execFileSync('git', ['check-ignore', '-q', '--', p], { stdio: 'pipe' });
    return true;   // exit 0 = ignored
  } catch {
    return false;  // exit 1 = not ignored (or not matched)
  }
}

describe('no skill instructs an agent to stage a gitignored path', () => {
  const files = markdownFiles(SKILLS_DIR);

  test('precondition: the authoritative skills tree has markdown to scan', () => {
    assert.ok(files.length > 5, `expected many skill markdown files, found ${files.length}`);
  });

  test('precondition: the scanner actually finds real `git add` instructions', () => {
    // Without this, a regex regression would silently make every assertion below
    // vacuous — the same empty-loop failure mode that made an egress test pass
    // while checking nothing (2026-07-26).
    const total = files.reduce((n, f) => n + stagedPathsIn(fs.readFileSync(f, 'utf8')).length, 0);
    assert.ok(total > 0, 'the scanner found zero stageable paths — the matcher has regressed');
  });

  test('every literal path a skill tells you to `git add` is trackable', () => {
    const offenders = [];
    for (const file of files) {
      for (const hit of stagedPathsIn(fs.readFileSync(file, 'utf8'))) {
        if (isGitIgnored(hit.path)) offenders.push(`${file}:${hit.line} → git add ${hit.path}`);
      }
    }
    assert.deepEqual(
      offenders, [],
      'A skill tells an agent to stage a gitignored (Category A) path. `git add` will FAIL there, '
      + 'and if the instruction swallows stderr the agent is told nothing while believing the artifact '
      + 'shipped. Either drop the instruction (the artifact is correctly Category A) or reclassify the '
      + 'artifact to Category B with a freshness check. Offenders:\n  ' + offenders.join('\n  '),
    );
  });
});

/**
 * A SECOND prose→behaviour class, same shape as the one above: a skill that
 * ADVERTISES a selectable option and then hardcodes one value at the site that
 * would have used it.
 *
 * `/audit-code`'s frontmatter offers `--scope diff|plan|full` and its own table
 * tells the agent when to pick each; Step 2's Round-1 block passed the literal
 * `--scope diff`. An explicitly requested `--scope full` therefore ran as a diff
 * audit and reported a clean result over a fraction of what was asked for —
 * with real provider spend, and nothing in the output saying the scope had been
 * dropped. Prose cannot catch this either: the advertisement and the invocation
 * are 130 lines apart and each is locally correct.
 */
describe('a skill must not hardcode a scope it advertises as selectable', () => {
  const SKILL = path.join(SKILLS_DIR, 'audit-code', 'SKILL.md');
  // A line-continuation backslash, built rather than escaped: it is the only
  // thing separating an INVOCATION from the prose table that legitimately
  // names `--scope diff` as the default.
  const CONT = String.fromCharCode(92);

  test('the Round 1 invocation passes the SELECTED scope, not a literal', () => {
    const src = fs.readFileSync(SKILL, 'utf-8');
    // Vacuous-pass guard: the invocation this asserts about must still exist.
    assert.ok(src.includes('node scripts/openai-audit.mjs code <plan-file>'),
      'the Round 1 invocation is gone — re-point this guard rather than deleting it');
    assert.ok(src.includes('--scope "$SCOPE"'),
      'Round 1 must pass the resolved scope');
    assert.ok(!src.includes(`--scope diff ${CONT}`),
      'a literal --scope diff in an invocation discards an explicit --scope full/plan');
  });
});

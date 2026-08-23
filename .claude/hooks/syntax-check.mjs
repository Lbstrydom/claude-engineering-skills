#!/usr/bin/env node
/**
 * @fileoverview PostToolUse hook — parse-checks an edited `.mjs` file.
 *
 * Closes the edit→push feedback gap for the ONE defect class the regex
 * quick-fix scanner provably cannot see: a file that does not parse. Before
 * this hook the only deterministic check on a written `.mjs` was the pre-push
 * gate, so a syntax error survived from the moment it was written until push.
 *
 * Reads PostToolUse JSON from stdin. The file is already on disk with the
 * edit applied, so the check runs against the real bytes — not the diff
 * snippet — via `node --check <file>` in a subprocess.
 *
 * NEVER emits continue:false — nudge, not gate. Every uncertainty (spawn
 * failure, timeout, missing file, oversized output) fails OPEN and exits
 * silently. A parse error is never a false positive; anything else is not
 * reported at all.
 *
 * ## Scope contract — `.mjs` ONLY. Do not widen without a new decision.
 *
 * Measured 2026-08-20 on Node v22.23.2, not assumed:
 *   - `.js` containing JSX          → `node --check` exits 1. React consumers
 *                                     would get a false positive on every
 *                                     valid component. DISQUALIFYING.
 *   - `.ts` / `.tsx`                → exits 1 on valid type annotations.
 *   - `.js` with ESM syntax and no  → exits 0 (Node 22 module-syntax
 *     `"type":"module"`               detection), so module-type ambiguity is
 *                                     NOT the risk; JSX is.
 *   - `.mjs`                        → parses as ESM unconditionally; JSX in a
 *                                     `.mjs` could not be executed by node
 *                                     either, so a hit is always a true defect.
 *
 * This hook is a SYNTAX check. It is not a linter and must not grow into one:
 * the narrowness is what keeps it free of false positives and therefore worth
 * obeying. Adding a style/quality rule here is a new decision, not an
 * increment.
 *
 * Claude-Code-only acceleration, per the repo's standing rule that hooks are
 * never cross-agent enforcement — other hosts get nothing from this file.
 *
 * Disable: SYNTAX_CHECK_HOOK_DISABLE=1
 *
 * @module .claude/hooks/syntax-check
 */
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HOOK_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HOOK_DIR, '..', '..');

// `.claude/hooks/` stays at its canonical path in BOTH layouts (see
// sync-path-map.mjs STAYS_AT_CANONICAL_PATH_PREFIXES), so this file cannot
// derive the tooling root from its own position — it must try both. In the
// source repo the library is `scripts/lib/`; in a consumer the synced tree is
// isolated under `scripts/.claude-skills/lib/`.
//
// This is not hypothetical. Measured 2026-08-20: the sibling hook
// `quickfix-scan.mjs` hardcodes `scripts/lib/`, so under a consumer layout it
// throws Cannot-find-module on every Edit/Write and exits 0 — silently inert
// for the whole life of the isolation layout. The sync content-rewriter only
// rewrites `node scripts/X.mjs` command strings, never a JS path expression.
const LIB_CANDIDATES = Object.freeze([
  path.join(REPO_ROOT, 'scripts', 'lib', 'sensitive-paths.mjs'),
  path.join(REPO_ROOT, 'scripts', '.claude-skills', 'lib', 'sensitive-paths.mjs'),
]);

/**
 * @returns {Promise<object|null>} the sensitive-paths module, or null if no
 *   layout resolved. Null means "cannot prove this file is safe to read", and
 *   the caller must then check NOTHING.
 */
async function loadSensitivePaths() {
  for (const candidate of LIB_CANDIDATES) {
    if (!fs.existsSync(candidate)) continue;
    try {
      return await import(pathToFileURL(candidate).href);
    } catch { /* try the next layout */ }
  }
  return null;
}

/** Only this extension. See the scope contract above. */
const CHECKED_EXTENSION = '.mjs';
/** A parse error is a few lines; anything larger is pathological — fail open. */
const MAX_OUTPUT_BYTES = 256 * 1024;
const TIMEOUT_MS = 5000;

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf-8');
}

async function main() {
  if (process.env.SYNTAX_CHECK_HOOK_DISABLE === '1') process.exit(0);

  let payload;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    // Malformed stdin — never fail the tool call.
    process.stderr.write('  [syntax-check] WARN: malformed stdin — skipping\n');
    process.exit(0);
  }

  const toolName = payload?.tool_name || '';
  if (toolName !== 'Edit' && toolName !== 'Write') process.exit(0);

  const toolInput = payload?.tool_input || {};
  const filePath = toolInput.file_path || toolInput.filePath || '';
  if (!filePath) process.exit(0);

  if (path.extname(filePath).toLowerCase() !== CHECKED_EXTENSION) process.exit(0);

  // Resolve against Claude Code's cwd at tool-invocation time (the file_path
  // may be bare), then hand the ABSOLUTE path to the classifier so it does not
  // re-resolve against a different root.
  const absoluteFilePath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(process.cwd(), filePath);

  // Sensitive-path short-circuit. `node --check` PRINTS THE OFFENDING SOURCE
  // LINE, so a parse error in a sensitive file would echo its contents into
  // the transcript. resolveAndClassify is the fail-closed variant: it
  // re-checks the realpath, so a benign-looking symlink resolving into
  // ~/.ssh/ is caught, and a resolution error or repo-escaping symlink
  // classifies as sensitive rather than falling through.
  //
  // Note the two senses of "fail" here, which point the same way: if the
  // classifier cannot be loaded or throws, we perform NO check. That fails
  // OPEN on the feature (no advisory) and CLOSED on safety (never read a file
  // we could not prove non-sensitive).
  const sensitiveMod = await loadSensitivePaths();
  if (!sensitiveMod?.resolveAndClassify) process.exit(0);
  let verdict;
  try {
    verdict = sensitiveMod.resolveAndClassify(absoluteFilePath, { repoRoot: REPO_ROOT });
  } catch {
    process.exit(0);
  }
  if (verdict.category === 'sensitive') process.exit(0);

  // Read from the canonical path the classifier cleared, not the raw input.
  const targetPath = verdict.canonical || absoluteFilePath;
  if (!fs.existsSync(targetPath)) process.exit(0); // deleted/moved since the edit

  const res = spawnSync(process.execPath, ['--check', targetPath], {
    encoding: 'utf-8',
    timeout: TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
    windowsHide: true,
  });

  // Fail open on anything that is not a clean verdict: spawn failure, timeout,
  // signal, or output past maxBuffer (res.error is set for all of these).
  if (res.error || res.signal) process.exit(0);
  if (res.status === 0) process.exit(0); // parses fine — silence

  const repoRelative = path.relative(REPO_ROOT, targetPath) || path.basename(targetPath);
  // Node prints the absolute path in its first line; rewrite it to
  // repo-relative so the message does not carry the checkout's ancestry.
  // Keep the caret diagnostic and the SyntaxError line; drop node's internal
  // stack frames and version footer — they are constant noise that would
  // dominate the transcript on every hit.
  const detail = String(res.stderr || '')
    .split(targetPath).join(repoRelative)
    .split(/\r?\n/)
    .filter(line => !/^\s+at\s/.test(line) && !/^Node\.js v/.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 800);

  const systemMessage = [
    `⚠ Syntax error — ${repoRelative} does not parse (\`node --check\`):`,
    detail,
    '(Fix before continuing. Disable for this session: SYNTAX_CHECK_HOOK_DISABLE=1)',
  ].join('\n');

  // Use the write-callback: process.exit(0) can terminate before piped stdio
  // flushes.
  process.stdout.write(JSON.stringify({ systemMessage }) + '\n', () => process.exit(0));
}

main().catch(err => {
  // Last-resort: never fail the tool call because of a hook bug.
  process.stderr.write(`  [syntax-check] FATAL: ${err.message}\n`);
  process.exit(0);
});

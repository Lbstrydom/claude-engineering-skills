#!/usr/bin/env node
/**
 * @fileoverview PostToolUse hook — scans Edit/Write diffs for shortcut patterns.
 * Plan: docs/plans/brainstorm-quickfix-v1.md §B1, §11.D, §13.A, §15.A, §16.D.
 *
 * Reads PostToolUse JSON from stdin. Extracts file_path + new content.
 * Skips sensitive paths (.env, secrets/, .pem, etc.). Calls matchPatterns()
 * — already redacts before truncating. On hits, emits {systemMessage:"..."}
 * to stdout AND appends a redacted record to .audit/quickfix-hits.jsonl.
 *
 * NEVER emits continue:false — nudge, not gate.
 *
 * Disable: QUICKFIX_HOOK_DISABLE=1 env or per-line `// quickfix-hook:ignore`.
 *
 * @module .claude/hooks/quickfix-scan
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Resolve scripts/lib relative to this hook file (works regardless of cwd).
// Audit R1-M6: use fileURLToPath to handle Windows drive-letter and URL
// encoding correctly — manual `.pathname` slicing was brittle.
const HOOK_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HOOK_DIR, '..', '..');
const PATTERNS_MOD_URL = pathToFileURL(path.join(REPO_ROOT, 'scripts', 'lib', 'quickfix-patterns.mjs')).href;

// Overridable so the hook's OWN integration tests (which spawn this file as a
// subprocess against the real repo root) write to a throwaway path instead of
// the live telemetry log. Without this the suite appends a hit per test run per
// fixture: 4,386 of the first 4,548 recorded hits (96%) were three fixture
// paths, which would have resolved to fabricated `accept/file-deleted`
// outcomes and poisoned the quickfix pattern posteriors.
const TELEMETRY_PATH = process.env.QUICKFIX_TELEMETRY_PATH
  || path.join(REPO_ROOT, '.audit', 'quickfix-hits.jsonl');
const SKIP_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.svg', '.pdf', '.zip', '.tar', '.gz', '.lock', '.bin']);

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf-8');
}

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); }
  catch (err) { if (err.code !== 'EEXIST') throw err; }
}

async function main() {
  // Disable env — exit silently
  if (process.env.QUICKFIX_HOOK_DISABLE === '1') {
    process.exit(0);
  }

  let payload;
  try {
    const raw = await readStdin();
    payload = JSON.parse(raw);
  } catch {
    // Malformed stdin — log + exit. Don't fail the tool call.
    process.stderr.write('  [quickfix-hook] WARN: malformed stdin — skipping scan\n');
    process.exit(0);
  }

  // Extract file_path + new content
  const toolName = payload?.tool_name || '';
  const toolInput = payload?.tool_input || {};
  let filePath = toolInput.file_path || toolInput.filePath || '';
  let diffText = '';

  if (toolName === 'Edit') {
    diffText = toolInput.new_string || '';
  } else if (toolName === 'Write') {
    diffText = toolInput.content || '';
  } else {
    // Not an Edit or Write — silently exit
    process.exit(0);
  }

  if (!filePath || !diffText) {
    process.exit(0);
  }

  // Skip binary / lock-file extensions
  const ext = path.extname(filePath).toLowerCase();
  if (SKIP_EXTENSIONS.has(ext)) {
    process.exit(0);
  }

  // Audit Gemini-G2-H2: canonicalize the path BEFORE the sensitive-path
  // check. If the user runs claude from `secrets/` and edits
  // `api-keys.json`, the raw `filePath` is just `api-keys.json` (no
  // `secrets/` prefix). Without canonicalisation, isSensitivePath sees
  // the bare basename and lets the scan proceed.
  // Audit Gemini-G-M3: resolve relative paths against process.cwd()
  // (Claude Code's cwd at tool-invocation time), not REPO_ROOT.
  const absoluteFilePath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  const repoRelative = path.relative(REPO_ROOT, absoluteFilePath);

  // Lazy-load patterns module so the hook itself stays minimal
  const { matchPatterns, isSensitivePath, loadSkippedPatternSet } = await import(PATTERNS_MOD_URL);

  // Sensitive-path short-circuit — never scan, never log.
  // Check BOTH the canonicalized absolute path AND the repo-relative
  // path so secrets/ matches whether user is in repo root or in a subdir.
  if (isSensitivePath(absoluteFilePath) || isSensitivePath(repoRelative)) {
    process.exit(0);
  }

  // Phase 2 — adaptive-learning skip set.  Loaded once per hook invocation
  // (which IS once per Edit/Write — single fs.readFileSync, no network).
  // Empty Set when LEARNING_DISABLE=1, LEARNING_QUICKFIX=off, or cache absent.
  const skipPatterns = loadSkippedPatternSet({ cachePath: path.join(REPO_ROOT, '.audit', 'quickfix-pattern-stats.json') });

  // Best-effort full-file read for `nearby`-bearing patterns (code-audit
  // Gemini gate G1, round 2) — this is a PostToolUse hook, so the file is
  // already on disk with the edit applied. An Edit call's diffText is just
  // `new_string` (the isolated snippet), which usually lacks the 200 chars
  // of surrounding context `nearby` needs (e.g. a `.transaction(` wrapper
  // the edit itself didn't touch). Never fail the hook on a read error —
  // matchPatterns falls back to the diffText-only window when absent.
  let fullFileText;
  try { fullFileText = fs.readFileSync(absoluteFilePath, 'utf-8'); } catch { /* fall back silently */ }

  // Pass canonicalized repo-relative path into matchPatterns too — the
  // langGuard checks file extensions which work with either form, but
  // using the canonical form keeps the contract clean.
  const matches = matchPatterns(diffText, { filePath: repoRelative, skipPatterns, fullFileText });
  if (matches.length === 0) {
    process.exit(0);
  }

  // Compose system message — sorted by severity (high first)
  const sevOrder = { high: 0, medium: 1, low: 2 };
  matches.sort((a, b) => (sevOrder[a.severity] ?? 9) - (sevOrder[b.severity] ?? 9));
  const lines = [`⚠ Quick-fix patterns matched in ${repoRelative}:`];
  for (const m of matches) {
    lines.push(`  • [${m.severity}] ${m.name}`);
    lines.push(`    Snippet: ${JSON.stringify(m.snippet)}`);
    lines.push(`    Suggest: ${m.suggestion}`);
  }
  lines.push(`(Disable for this line: append // quickfix-hook:ignore | session: QUICKFIX_HOOK_DISABLE=1)`);
  const systemMessage = lines.join('\n');

  // Telemetry — append redacted record to .audit/quickfix-hits.jsonl.
  // Phase 2: each match gets a stable `hit_id` (uuid) so the out-of-band
  // backfill-outcomes reconciler can dedupe + drain JSONL into the
  // `learning_decisions` cloud table without losing identity.
  // (matches already redacted by matchPatterns per §15.A — defence in depth via JSON serialisation)
  try {
    ensureDir(path.dirname(TELEMETRY_PATH));
    const ts = new Date().toISOString();
    const record = {
      ts,
      tool: toolName,
      file: repoRelative,
      matches: matches.map(m => ({
        name: m.name,
        severity: m.severity,
        snippet: m.snippet,
        hit_id: crypto.randomUUID(),
      })),
    };
    fs.appendFileSync(TELEMETRY_PATH, JSON.stringify(record) + '\n');
  } catch (err) {
    process.stderr.write(`  [quickfix-hook] WARN: telemetry write failed — ${err.code || err.message}\n`);
  }

  // Emit hook output — Claude Code reads this from stdout.
  // Audit R2-M7: process.exit(0) can terminate before piped stdio fully
  // flushes. Use the write-callback to ensure the byte stream completes
  // before we exit.
  process.stdout.write(JSON.stringify({ systemMessage }) + '\n', () => process.exit(0));
}

main().catch(err => {
  // Last-resort: never fail the tool call due to a hook bug
  process.stderr.write(`  [quickfix-hook] FATAL: ${err.message}\n`);
  process.exit(0);
});

/**
 * @fileoverview Local-only regression lock for upstream report 52126241
 * (storyline, 2026-09-09): "Copilot Windows skills contain Bash-only
 * executable contracts". A Copilot session on Windows/PowerShell parsed
 * every ```bash fence under skills/** with
 * `System.Management.Automation.Language.Parser` and found 112 fences, 47
 * (42.0%) failing PowerShell syntax — 8 in audit-code, 6 in audit-plan —
 * because Copilot's only terminal on Windows is PowerShell and it follows
 * these fences literally.
 *
 * Fixed mechanically at 534d7550 (46/47) and here (the remaining 5, found by
 * re-running the same measurement rather than trusting the fix count):
 * backslash line-continuation (PowerShell uses backtick, not `\`),
 * `<placeholder>` tokens (PowerShell reserves `<`), and a bash `< file`
 * stdin redirect (PowerShell has no `<` input redirection at all — rewritten
 * as `cat file | cmd`, which both shells support). One block remains
 * genuinely POSIX (`[ -n ... ]` test syntax in a `BASE=$(...)` recipe,
 * cycle/SKILL.md) and stays that way deliberately — the fix here is that it
 * is now LABELED "POSIX shell only", so a Copilot agent following it knows
 * to switch shells instead of silently mistranslating it (the report's
 * actual "Impact" concern) or failing mid-audit.
 *
 * This test is the report's own suggested "gate that parses ... command
 * fixtures under the supported Windows shell", scoped down to what a
 * cross-platform CI runner (this repo's own is `ubuntu-latest` — no Windows
 * job exists) can honestly run: LOCAL-ONLY, via `pwsh` when present, skipped
 * (never failed) when it is not. Skipping must never render as a pass with
 * nothing checked — see the `todo`/console warning below — the same
 * sandbox-honesty rule this repo applies to every other host-gated read.
 *
 * The allowlist is not a list of specific commands (fragile to reformatting)
 * — it is the LABEL convention itself: a failing fence is accepted only when
 * the surrounding prose says "POSIX shell only" within a few lines above it.
 * That keeps the invariant this test enforces identical to the one a human
 * author is supposed to honour: label it, or fix it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS_DIR = path.join(REPO, 'skills');
const LABEL_RE = /POSIX shell only/i;
const LABEL_LOOKBACK_CHARS = 400; // a few lines of prose immediately above the fence

function walkMarkdown(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkMarkdown(p, out);
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

function pwshAvailable() {
  try {
    execFileSync('pwsh', ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse every fence file in ONE pwsh invocation rather than one per fence —
 * pwsh's own startup cost (~300ms) times ~130 fences would otherwise make
 * this test cost the better part of a minute on every local Windows run.
 * Returns the set of basenames (e.g. "fence-3.ps1") that failed to parse.
 */
function parseAllUnderPowerShell(tmpDir, filenames) {
  const script = `
    $dir = '${tmpDir.replace(/\\/g, '\\\\')}'
    $failed = @()
    foreach ($name in @(${filenames.map((f) => `'${f}'`).join(',')})) {
      $tokens = $null; $errors = $null
      [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $dir $name), [ref]$tokens, [ref]$errors) | Out-Null
      if ($errors.Count -gt 0) { $failed += $name }
    }
    $failed | ConvertTo-Json -Compress
  `;
  const out = execFileSync('pwsh', ['-NoProfile', '-Command', script], { encoding: 'utf-8' }).trim();
  if (!out) return new Set();
  const parsed = JSON.parse(out);
  return new Set(Array.isArray(parsed) ? parsed : [parsed]);
}

test('every ```bash fence in skills/** parses under PowerShell, or is labeled POSIX-only', (t) => {
  if (!pwshAvailable()) {
    // Never a silent pass: this repo's CI is ubuntu-latest only, so this is
    // the expected path everywhere except a Windows dev machine — report it
    // as skipped, not green, per this repo's own sandbox-honesty rule.
    t.skip('pwsh not available on this host — this check only runs where PowerShell can adjudicate itself');
    return;
  }

  const FENCE_RE = /```bash\n([\s\S]*?)```/g;
  const fences = []; // {rel, filename, firstLine, precedingLabeled}
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-fence-check-'));
  let unlabeledFailures;

  try {
    for (const file of walkMarkdown(SKILLS_DIR)) {
      const text = fs.readFileSync(file, 'utf-8');
      const rel = path.relative(REPO, file).split(path.sep).join('/');
      let m;
      FENCE_RE.lastIndex = 0;
      let n = 0;
      while ((m = FENCE_RE.exec(text)) !== null) {
        n++;
        const code = m[1];
        const filename = `${rel.replace(/[\\/]/g, '_')}-${n}.ps1`;
        fs.writeFileSync(path.join(tmpDir, filename), code, 'utf-8');
        const precedingStart = Math.max(0, m.index - LABEL_LOOKBACK_CHARS);
        fences.push({
          rel, filename,
          firstLine: code.split('\n')[0].trim(),
          precedingLabeled: LABEL_RE.test(text.slice(precedingStart, m.index)),
        });
      }
    }

    assert.ok(fences.length > 0, 'no ```bash fences were found under skills/** — the walk or the fence regex is broken');

    const failedFilenames = parseAllUnderPowerShell(tmpDir, fences.map((f) => f.filename));
    unlabeledFailures = fences
      .filter((f) => failedFilenames.has(f.filename) && !f.precedingLabeled)
      .map((f) => ({ file: f.rel, firstLine: f.firstLine }));
  } finally {
    // maxRetries/retryDelay: Windows holds EPERM/EBUSY briefly after a write
    // (rmsync-retry-guard.test.mjs pins this shape repo-wide).
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }

  assert.deepEqual(
    unlabeledFailures, [],
    `${unlabeledFailures.length} bash fence(s) fail PowerShell parsing with no "POSIX shell only" label ` +
    `nearby (Copilot's only Windows terminal is PowerShell — see upstream report 52126241):\n` +
    unlabeledFailures.map((f) => `  ${f.file}: ${f.firstLine}`).join('\n'),
  );
});

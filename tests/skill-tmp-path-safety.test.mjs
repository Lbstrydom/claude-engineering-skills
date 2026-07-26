/**
 * @fileoverview Guards a Windows-specific path-ambiguity class found live
 * 2026-07-26 while chasing why a consumer repo's 101 real `/audit-code` runs,
 * over 30 days, all had a genuine Gemini final-review verdict computed (visible
 * in that session's own logs) but NONE of it ever reached `audit_runs` —
 * `gemini_verdict`/`final_review_model` were NULL on every single one.
 *
 * ROOT CAUSE, reproduced directly on this machine: `skills/audit-code/SKILL.md`
 * Step 7 extracted `_cloudRunId` with
 * `node -e "process.stdout.write(require('/tmp/'+process.env.SID+'-result.json')._cloudRunId||'')"`.
 * Bash's `/tmp/` and Node's OWN resolution of the SAME literal string land in
 * TWO DIFFERENT, unrelated directories on Windows (Bash: AppData/Local/Temp;
 * Node: `C:\tmp`). `require()` therefore threw `MODULE_NOT_FOUND` on a file
 * that genuinely existed — inside a `$(...)` command substitution, which
 * discards the failure and silently leaves `RUN_ID` empty, with no visible
 * error to whoever is following the skill. `--run-id` then silently never
 * reaches `gemini-review.mjs`, and every review's persistence vanishes.
 *
 * See also (2026-07-26, this session): `feedback_tmp_path_ambiguity_windows`
 * memory note recorded the general gotcha independently, before this specific
 * instance of it was traced.
 *
 * The fix: pass the path as `process.argv[1]` (a genuine CLI argument the
 * SAME shell resolves consistently for both the writer and the reader), never
 * embed it as a string literal inside the `-e` source for Node to re-resolve
 * itself. This guards that fix from regressing.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SKILLS_DIR = 'skills';

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
 * The dangerous shape: a call to `require(`/`readFileSync(`/`existsSync(`
 * whose argument is a STRING LITERAL beginning with an absolute POSIX path
 * (`/something/...`) — i.e. hardcoded for Node to resolve itself, rather than
 * threaded through as `process.argv[N]` (which the invoking SHELL resolves
 * once, consistently, for every reader/writer of that same path).
 *
 * Scoped to these three functions because they are the file-access calls that
 * actually appeared in this skill's `node -e` snippets; a bare mention of
 * `/tmp/` in prose (not inside one of these calls) is not the danger — only
 * Node independently re-resolving the string is.
 */
const DANGEROUS_PATTERN = /\b(?:require|readFileSync|existsSync)\(\s*['"`]\/[^'"` )]*/;

describe('no skill embeds a hardcoded absolute-path literal for Node to re-resolve', () => {
  const files = markdownFiles(SKILLS_DIR);

  test('precondition: the authoritative skills tree has markdown to scan', () => {
    assert.ok(files.length > 5, `expected many skill markdown files, found ${files.length}`);
  });

  test('every require/readFileSync/existsSync call in skill markdown takes an argv-sourced path, never a hardcoded absolute literal', () => {
    const offenders = [];
    for (const file of files) {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        const m = line.match(DANGEROUS_PATTERN);
        if (m) offenders.push(`${file}:${i + 1} — ${m[0]}...`);
      });
    }
    assert.deepEqual(
      offenders, [],
      'A skill hardcodes an absolute path literal inside require()/readFileSync()/existsSync() rather than '
      + 'passing it as process.argv[N]. On Windows, Bash and Node can resolve the SAME literal string to TWO '
      + 'DIFFERENT directories (confirmed: Bash /tmp -> AppData/Local/Temp, Node /tmp -> C:\\tmp), so Node '
      + 'throws on a file that genuinely exists — and inside a `$(...)` command substitution, that failure is '
      + 'silently swallowed, leaving the captured variable empty with no visible error. This exact bug lost '
      + '101 real audit runs\' final-review persistence over 30 days before anyone noticed. Pass the path as '
      + 'an argument instead: `node -e "...fs.readFileSync(process.argv[1],\'utf8\')..." "$THE_PATH"`. '
      + `Offenders:\n  ${offenders.join('\n  ')}`,
    );
  });

  // A guard that can never fail is worthless — confirm this one actually
  // caught the real, original bug shape before it was fixed.
  test('the guard fires on the exact original broken snippet', () => {
    const broken = 'RUN_ID=$(node -e "process.stdout.write(require(\'/tmp/\'+process.env.SID+\'-result.json\')._cloudRunId||\'\')")';
    assert.match(broken, DANGEROUS_PATTERN, 'precondition: the pattern must match the historical bug verbatim');
  });

  test('the guard does NOT fire on the fixed, argv-based snippet', () => {
    const fixed = 'RUN_ID=$(node -e "const fs=require(\'fs\'); try { process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],\'utf8\'))._cloudRunId||\'\'); } catch { process.stdout.write(\'\'); }" "/tmp/$SID-r<N>-result.json")';
    assert.doesNotMatch(
      fixed, DANGEROUS_PATTERN,
      'require(\'fs\') is a legitimate module-name require (not a path); readFileSync(process.argv[1],...) '
      + 'takes an argv-sourced path, not a hardcoded literal — neither should trip the guard',
    );
  });
});

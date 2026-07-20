#!/usr/bin/env node
/**
 * @fileoverview Thin argv → executor adapter for the shared-cloud-config
 * feature. ALL logic lives in scripts/lib/shared-cloud-config.mjs per the
 * lib/CLI separation (plan: docs/plans/shared-cloud-config.md R2/R3-audit).
 *
 * This file owns:
 *   - argv parsing
 *   - default readline-based prompt
 *   - process.exit per outcome
 *
 * Usage:
 *   npm run setup:cloud                     # interactive
 *   npm run setup:cloud -- --yes            # CI / non-interactive
 *   npm run setup:cloud -- --dry-run        # preview, no write
 *   npm run setup:cloud -- --format json    # machine-readable
 *   npm run setup:cloud -- --source-repo <path>   # explicit source override
 *
 * Exit codes (from OUTCOMES + EXIT_CODE_FOR):
 *   0 — created / updated / already_current / user_skipped
 *   1 — fatal (unexpected error)
 *   2 — bad argv (--format value)
 *   4 — misconfigured (no source repo / no .env / missing required vars)
 *
 * @module scripts/setup-cloud
 */
import readline from 'node:readline';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertRepoRoot } from './lib/assert-repo-root.mjs';
import { runSetupCloud, OUTCOMES, EXIT_CODE_FOR } from './lib/shared-cloud-config.mjs';
import { assertKnownFlags, ArgvError } from './lib/cli-io.mjs';

/**
 * Every accepted flag. `--format` and `--source-repo` take a value; the short
 * alias `-y` is not `--`-prefixed so the guard leaves it alone.
 */
const KNOWN_FLAGS = ['--yes', '--dry-run', '--format', '--source-repo'];

// R1-audit M3/M13: tightened acceptance — only empty (default Y) or
// explicit `y`/`yes` confirms. Typos, pasted junk, arbitrary text → reject.
// Empty (just-Enter) still confirms because the prompt is "(Y/n)" — the
// capitalised Y signals the default. Anything else → safer to reject.
function defaultPrompt(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      resolve(a === '' || a === 'y' || a === 'yes');
    });
  });
}

async function main() {
  assertKnownFlags(process.argv, KNOWN_FLAGS, { cli: 'setup-cloud' });

  const argv = process.argv.slice(2);

  // R1-audit H6: assertRepoRoot used to run before the try/catch wrapping
  // main(), so an early throw would bypass our error path and crash with a
  // raw stack. Moved inside the function so the top-level catch covers it.
  // Skipped when --source-repo is set (consumer-repo operators can still
  // invoke setup:cloud explicitly).
  if (!argv.includes('--source-repo')) {
    assertRepoRoot(import.meta.url);
  }

  let explicitFlag = null, format = 'human';
  const autoYes = argv.includes('--yes') || argv.includes('-y');
  const dryRun  = argv.includes('--dry-run');
  // R1-audit M6/M12 + R2-audit M5: validate flag-with-value argv. Reject
  // when the next token is missing, starts with `--`, OR is a short flag
  // like `-y` (a common typo / misordered argv where the operator wrote
  // `--source-repo -y /path` and the parser would otherwise silently
  // capture `-y` as the source path).
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--source-repo' || argv[i] === '--format') {
      const flag = argv[i];
      const val = argv[++i];
      if (val === undefined || val.startsWith('--') || /^-[a-zA-Z]/.test(val)) {
        process.stderr.write(`error: ${flag} requires a value (got: ${val ?? '<missing>'})\n`);
        process.exit(2);
      }
      if (flag === '--source-repo') explicitFlag = val;
      else                          format       = val;
    }
  }
  if (format !== 'human' && format !== 'json') {
    process.stderr.write(`error: --format must be 'human' or 'json' (got: ${format})\n`);
    process.exit(2);
  }

  // R1-audit M4: TTY check before invoking interactive prompt. CI / piped
  // runs need --yes; without it, the readline would block forever on stdin.
  if (!autoYes && !process.stdin.isTTY) {
    process.stderr.write(
      `error: setup:cloud requires --yes when stdin is not a TTY (CI / piped invocation)\n`
    );
    process.exit(2);
  }

  const result = await runSetupCloud({
    prompt: defaultPrompt,
    autoYes, dryRun, format, explicitFlag,
  });
  process.exit(result.exitCode);
}

// R1-audit H6: catch unhandled rejections from main() and convert to a
// stable exit code. Also R1-audit M14: compare canonical paths (resolved
// + URL-decoded) instead of basenames so unrelated scripts with the same
// filename don't accidentally trigger `main()`.
const invokedAsScript = (() => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
  } catch {
    return false;
  }
})();
if (invokedAsScript) {
  main().catch((err) => {
    // A usage mistake is not a fatal crash: print the diagnostic only, exit 2
    // (the existing bad-argv exit code).
    if (err instanceof ArgvError || err?.code === 'ARGV_ERROR') {
      process.stderr.write(`${err.message}\n`);
      process.exit(2);
    }
    process.stderr.write(`setup-cloud: fatal: ${err.stack || err.message}\n`);
    process.exit(EXIT_CODE_FOR[OUTCOMES.FATAL]);
  });
}

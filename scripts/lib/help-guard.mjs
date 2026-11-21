/**
 * @fileoverview `--help` is a pure read: print the CLI's own documented usage and
 * exit 0 BEFORE any side effect.
 *
 * **Why (2026-11-21).** A CLI that does not recognise `--help` simply RUNS —
 * `arch-intent-bootstrap.mjs --help` ran the bootstrap, and the census this
 * guard closes found `prepush-check --help` creating a git worktree and
 * `openai-audit` / `anthropic-ping` reaching a paid provider. `assertKnownFlags`
 * refuses unknown flags; this is the other half, for the flag every operator
 * types first.
 *
 * Usage, as the FIRST import of a CLI, on the same line as its existing first
 * import so line counts stay stable for the size ratchet:
 *
 *     import './lib/help-guard-run.mjs'; import ...
 *
 * Fires only on an argv before a POSIX `--` terminator (what follows is
 * positional, e.g. a wrapped command).
 * The usage text is the file's own header comment, so there is no second copy
 * to drift: the `Usage:` block when it has one, else the `@fileoverview`.
 *
 * @module scripts/lib/help-guard
 */
import fs from 'node:fs';
import path from 'node:path';

/** True when `--help` appears before any `--` terminator. */
export function wantsHelp(argv) {
  const end = argv.indexOf('--');
  return (end === -1 ? argv : argv.slice(0, end)).includes('--help');
}

/**
 * Extract the usage text from a CLI's source: its header `Usage:` block, else
 * the first paragraph of the header comment.
 * @param {string} source
 * @param {string} name script basename
 * @returns {string}
 */
export function usageFromSource(source, name) {
  const m = /\/\*\*([\s\S]*?)\*\//.exec(source);
  const lines = (m ? m[1] : '').split('\n').map((l) => l.replace(/^\s*\* ?/, ''));
  const at = lines.findIndex((l) => /^\s*Usage:/i.test(l));
  let block;
  if (at !== -1) {
    block = [];
    for (let i = at; i < lines.length; i++) {
      if (i > at && lines[i].trim() === '' && block.some((b) => b.trim())) {
        // a blank line ends the block only once a command line has been seen
        if (block.length > 1) break;
      }
      if (/^\s*(Exit codes?|@module|@param|@returns)/i.test(lines[i])) break;
      block.push(lines[i]);
    }
  } else {
    // No `Usage:` block: the whole header up to its first @tag (a one-paragraph
    // cut dropped documented flags and examples), capped so a long header stays a screenful.
    const body = [];
    for (const raw of lines) {
      // `@fileoverview <text>` carries the first line of prose: keep the text, drop the tag.
      const l = raw.replace(/^@fileoverview\s*/, '');
      if (l.startsWith('@')) { if (body.some((b) => b.trim())) break; continue; }
      body.push(l);
    }
    block = body.slice(0, 40);
  }
  const text = block.join('\n').trimEnd();
  return `${text || `${name}: see the header of scripts/${name}`}\n\n(--help is read-only: nothing was run.)\n`;
}

/**
 * Entry-based: decides from `process.argv[1]` alone, so it can run as a
 * SIDE-EFFECT import evaluated FIRST (`import './lib/help-guard-run.mjs'`).
 * A function called after the imports is too late: `openai-audit`, `gemini-review`
 * and others refresh a model catalog over the network while their imports load.
 *
 * @param {{argv?: string[], exit?: (code:number)=>void, out?: (s:string)=>void}} [io] injected for tests
 * @returns {boolean} true when help was printed (only observable under an injected `exit`)
 */
export function helpGuardEntry(io = {}) {
  const argv = io.argv ?? process.argv;
  if (!wantsHelp(argv.slice(2))) return false;
  let entry;
  try { entry = fs.realpathSync(path.resolve(argv[1] ?? '')); } catch { return false; }
  let source;
  try { source = fs.readFileSync(entry, 'utf-8'); } catch { return false; }
  // Fire only when the ENTRY itself opted in. A guarded LIBRARY (learning-store is
  // imported by 36 scripts) must never swallow `--help` for an entry that has its
  // own help handling, or an app importing it would be terminated by a CLI contract.
  // An actual `import '…/help-guard-run.mjs'` statement, not the name in a comment or string.
  if (!/(?:^|;)\s*import\s+['"][^'"]*help-guard-run\.mjs['"]/m.test(source.replace(/\/\*[\s\S]*?\*\//g, ''))) return false;
  const text = usageFromSource(source, path.basename(entry));
  const exit = io.exit ?? ((c) => process.exit(c));
  if (io.out) { io.out(text); exit(0); return true; }
  // SYNCHRONOUS write + exit: an async `process.stdout.write(text, cb)` returns at
  // once and the remaining imports (the very side effects this guard precedes)
  // keep evaluating until the callback fires. The text is small, so a blocking
  // write to fd 1 cannot meaningfully stall.
  try {
    // writeSync may write fewer bytes than asked: loop until the buffer is out.
    const buf = Buffer.from(text, 'utf-8');
    let off = 0;
    while (off < buf.length) off += fs.writeSync(1, buf, off, buf.length - off);
  } catch { /* a closed stdout still must not run the CLI */ }
  exit(0);
  return true;
}

/**
 * @fileoverview What a RED tier said, in `fleet land`'s own output (consumer report 2026-11-15: a red train printed only
 * "tier X: red (exit 1) log <path>", so every reader had to open the log to learn what failed, and its exit code — 3, the
 * same as "blocked/refused" — could not tell "ran and red" from "never ran").
 *
 * The summary is the test runner's own: pytest's `short test summary info` block when present; else the last FAILED / ERROR /
 * `not ok` lines; else the log's last lines. Read from the tail of the tier log only (bounded), never the whole file.
 *
 * @module scripts/lib/fleet/tier-failure
 */
import fs from 'node:fs';

export const TAIL_BYTES = 256 * 1024;
export const MAX_LINES = 20;

const FAIL_LINE = /^(?:FAILED|ERROR|FAIL)\b|^\s*not ok \d+|^\s*[✖✗×]\s|\bAssertionError\b/;
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

/**
 * The failure summary of a log's text. Pure.
 * @param {string} text
 * @returns {{kind: 'pytest'|'fail-lines'|'tail'|'empty', lines: string[]}}
 */
export function failureSummary(text, { max = MAX_LINES } = {}) {
  const lines = String(text ?? '').replace(ANSI, '').split(/\r?\n/);
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) if (/^=+ short test summary info =+$/.test(lines[i].trim())) { start = i; break; }
  if (start !== -1) {
    const block = [];
    for (let i = start + 1; i < lines.length && !/^=+.*=+$/.test(lines[i].trim()); i += 1) if (lines[i].trim()) block.push(lines[i]);
    if (block.length) return { kind: 'pytest', lines: cap(block, max) };
  }
  const fails = lines.filter((l) => FAIL_LINE.test(l));
  if (fails.length) return { kind: 'fail-lines', lines: fails.slice(-max) };
  const tail = lines.filter((l) => l.trim()).slice(-Math.min(max, 15));
  return tail.length ? { kind: 'tail', lines: tail } : { kind: 'empty', lines: [] };
}

const cap = (xs, max) => (xs.length > max ? [...xs.slice(0, max), `… ${xs.length - max} more`] : xs);

/** The last `bytes` of a file as text, or null when it cannot be read. Never throws. */
export function readTail(file, bytes = TAIL_BYTES) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } catch { return null; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* closing a read fd */ } }
}

/** Lines `fleet land` prints for each red tier of a train: its summary, or why there is none. */
export function redTierLines(train, { read = readTail } = {}) {
  const out = [];
  for (const t of train?.tierResults ?? []) {
    if (t.result !== 'red') continue;
    const text = t.logPath ? read(t.logPath) : null;
    if (text === null) { out.push(`  tier ${t.name} failed — no log to summarise${t.logPath ? ` (${t.logPath} unreadable)` : ''}`); continue; }
    const s = failureSummary(text);
    const label = { pytest: 'pytest short test summary', 'fail-lines': 'failing lines', tail: 'last lines of the log', empty: 'the log is empty' }[s.kind];
    out.push(`  tier ${t.name} failed — ${label}:`, ...s.lines.map((l) => `    ${l.trimEnd()}`));
  }
  return out;
}

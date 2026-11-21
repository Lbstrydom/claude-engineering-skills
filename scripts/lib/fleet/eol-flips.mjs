/**
 * @fileoverview Line-ending churn that passes unnoticed (fleet feedback #7): a file whose CRLF/LF endings flipped shows as
 * a whole-file rewrite in review, hides the real change, and reaches a train as noise. A cheap check at `ready`: two
 * `git diff --numstat` reads of the SAME range, one raw and one with `--ignore-cr-at-eol`. A file whose ignoring-CR diff is
 * EMPTY but whose raw diff is not is a PURE flip; a file where line-ending noise dominates (at least `PARTIAL_MIN` lines and
 * at least twice the real change) is a PARTIAL one. Disclosure only - it never blocks - and a read that could not be made is
 * said, never read as "no flips".
 *
 * Detection is mechanical and says nothing about intent: a deliberate `.gitattributes` EOL change is also a flip, and the
 * line tells the author so. The fix it points to is the one the repo already has (`canonicalizeEol` in `file-io.mjs` for
 * generated hashes; for source, restore the file's original endings).
 *
 * @module scripts/lib/fleet/eol-flips
 */
import { runGit } from './git-facts.mjs';

/** A partial flip needs this many extra raw-diff lines over the real change, and at least twice it, to be worth a line. */
export const PARTIAL_MIN = 20;
/** Cap on files named in one line; the count is always exact. */
export const NAME_CAP = 8;

/**
 * `{file -> {added, deleted}}` from `git diff --no-renames --numstat -z`. With `--no-renames` there is one record per path in
 * both reads (a rename is a delete plus an add, identically in each), `-z` carries a path with a space, tab or newline
 * untouched (the path is everything after the second tab), and a binary file (`-`) is skipped. A path present in the raw read
 * and absent from the ignoring-CR read is a file whose ONLY change was line endings.
 */
function numstat(cwd, range, extra) {
  const r = runGit(['diff', '--no-renames', '--numstat', '-z', ...extra, ...range, '--'], cwd);
  if (!r.ok) return { ok: false, reason: r.reason };
  const out = new Map();
  for (const rec of r.stdout.split('\0')) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(rec);
    if (!m || m[1] === '-' || m[2] === '-') continue;
    out.set(m[3], { added: Number(m[1]), deleted: Number(m[2]) });
  }
  return { ok: true, files: out };
}

/**
 * @param {string} cwd
 * @param {string|null} baseOid the range start (the measured base); null → not measured
 * @param {string} oid the range end (the head being marked)
 * @returns {{ok: true, flips: Array<{file: string, kind: 'pure'|'partial', raw: number, real: number}>}|{ok: false, reason: string}}
 */
export function eolFlips(cwd, baseOid, oid) {
  if (!baseOid) return { ok: false, reason: 'base not measured' };
  const range = [baseOid, oid];
  const raw = numstat(cwd, range, []);
  if (!raw.ok) return { ok: false, reason: raw.reason };
  const real = numstat(cwd, range, ['--ignore-cr-at-eol']);
  if (!real.ok) return { ok: false, reason: real.reason };
  const flips = [];
  for (const [file, r] of raw.files) {
    const rawN = r.added + r.deleted;
    if (rawN === 0) continue;
    const g = real.files.get(file);
    const realN = g ? g.added + g.deleted : 0;
    if (realN === 0) flips.push({ file, kind: 'pure', raw: rawN, real: 0 });
    else if (rawN - realN >= PARTIAL_MIN && rawN >= 2 * realN) flips.push({ file, kind: 'partial', raw: rawN, real: realN });
  }
  return { ok: true, flips: flips.sort((a, b) => (a.file < b.file ? -1 : 1)) };
}

/** The JSON shape `ready` carries: `checked` is explicit, so "not checked" is never read as "checked, none". */
export const eolJson = (res) => (res.ok ? { checked: true, flips: res.flips } : { checked: false, reason: res.reason, flips: [] });

/** A git path rendered for a terminal: control characters (newline, CR, ESC) become visible `\xNN`, never raw. */
export const printable = (p) => String(p).replace(/[\u0000-\u001f\u007f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);

/** The lines a `ready` prints about it (empty when nothing flipped). */
export function eolFlipLines(res) {
  if (!res) return [];
  if (!res.ok) return [`note: line-ending churn was not checked (${res.reason})`];
  if (!res.flips.length) return [];
  const pure = res.flips.filter((f) => f.kind === 'pure');
  const partial = res.flips.filter((f) => f.kind === 'partial');
  const names = (l) => `${l.slice(0, NAME_CAP).map((f) => printable(f.file)).join(', ')}${l.length > NAME_CAP ? `, … ${l.length - NAME_CAP} more` : ''}`;
  const L = [];
  if (pure.length) L.push(`warning: ${pure.length} file(s) changed ONLY in line endings (CRLF/LF): ${names(pure)} — restore their original endings unless the change is deliberate`);
  if (partial.length) L.push(`warning: line endings dominate the diff of ${partial.length} file(s): ${names(partial)} — the real change is buried; check the endings were not rewritten`);
  return L;
}

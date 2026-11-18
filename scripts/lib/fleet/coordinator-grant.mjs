/**
 * @fileoverview The standing grant that lets a coordinator land a batch of pre-authorised chips (`fleet land --ship-batch`),
 * and the reader that checks it (docs/plans/coordinator-aggregate-ship.md section 2.1).
 *
 * **A declaration check, not verified authority.** Louis writes the grant into his own `~/.claude/CLAUDE.md`; no session edits
 * that file. Code cannot prove who wrote a line, so this proves only that the CURRENT canonical text is in the file the harness
 * hands every session as the user's own instructions. What actually gates each chip is still Louis's click on its launch card;
 * this only lets the coordinator include the PRE-AUTHORISED SHIP block by default and land the result.
 *
 * **A stale marker can never outlive its text.** The section from its heading to its marker must equal {@link CANONICAL_GRANT}
 * (line endings folded, the `Since <date>:` value ignored, nothing else). So narrowing or revoking the grant is an edit to that
 * section, and any edit refuses with `grant-mismatch`; a changed grant is a NEW canonical version (a `v2` marker, shipped in a
 * reviewed PR). A marker inside a code fence, or a second one anywhere in the file, refuses.
 *
 * Pure parse + one tiny I/O function. Fleet-domain: imports nothing but node built-ins.
 *
 * @module scripts/lib/fleet/coordinator-grant
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const GRANT_VERSION = 'v1';
export const GRANT_HEADING = '## Coordinators may ship batches of pre-authorised chips';
export const GRANT_MARKER = `<!-- grant: coordinator-ship-batch ${GRANT_VERSION} -->`;

/** The canonical grant, exactly as the plan's section 2.1 shows it for Louis to paste (a test compares the two). */
export const CANONICAL_GRANT = [
  GRANT_HEADING,
  '',
  'Since <DATE>: every repo coordinator session (titled `CES: Coordinator`, `WCA: Coordinator`, `STO: Coordinator`,',
  '`AIO: Coordinator`) may include the PRE-AUTHORISED SHIP block in every chip launch prompt by default, and may land a',
  'batch with `fleet land --ship-batch`. My click on a chip card that carries the block is my approval of that chip\'s',
  'ship. Standing rules still apply:',
  '',
  '- a chip ships itself only through `ship-commit.mjs --preauthorised`; if any condition refuses, that chip waits for',
  '  me to type /ship in its session, and the rest of the batch still lands;',
  '- the coordinator merges only members `ship-commit.mjs --check-shipped-head` reports ship-ok, squash, pinned with',
  '  `--match-head-commit`, never `--auto`; the squash message is the member\'s ship commit message, verbatim;',
  '- never `--no-verify` in wine-cellar-app;',
  '- still mine: secrets and Railway or other deploy-environment writes, database migrations, sensitive paths,',
  '  repository-policy files (.github/, CODEOWNERS, .test-tiers.json), plan decisions, deletions, GitHub settings and',
  '  rulesets, raising caps or baselines.',
  '',
  GRANT_MARKER,
].join('\n');

/** Only a real date (or the placeholder) may differ: anything else between `Since ` and the colon is text, and text is compared. */
const SINCE_RE = /^Since (?:\d{4}-\d{2}-\d{2}|<DATE>):/m;
const MARKER_PREFIX = '<!-- grant: coordinator-ship-batch';
const fold = (s) => String(s).replace(/\r\n/g, '\n').replace(SINCE_RE, 'Since <DATE>:').replace(/[ \t]+$/gm, '');

/**
 * Is line `i` inside a fenced code block? CommonMark rules: a fence opens with 3+ backticks or tildes (up to 3 spaces of indent),
 * and closes only with the SAME character, at least as many of them, and nothing after. A different character or a shorter
 * run inside an open fence is text, so `` ``` `` ... `~~~` ... marker is still fenced.
 */
function fencedAt(lines, upTo) {
  let open = null;
  for (let i = 0; i < upTo; i++) {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[i]);
    if (!m) continue;
    if (!open) open = { ch: m[1][0], len: m[1].length };
    else if (m[1][0] === open.ch && m[1].length >= open.len && m[2].trim() === '') open = null;
  }
  return open !== null;
}

/**
 * Judge the file's text. Pure.
 * @param {string|null} text the file's contents, or null when it could not be read
 * @returns {{ok: true, version: string} | {ok: false, code: 'grant-absent'|'grant-mismatch', reason: string}}
 */
export function parseShipBatchGrant(text) {
  if (typeof text !== 'string') return { ok: false, code: 'grant-absent', reason: 'the grant file could not be read' };
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const exact = lines.map((l, i) => (l.trim() === GRANT_MARKER ? i : -1)).filter((i) => i >= 0);
  const stray = lines.filter((l) => l.includes(MARKER_PREFIX) && l.trim() !== GRANT_MARKER);
  if (exact.length === 0 && stray.length === 0) return { ok: false, code: 'grant-absent', reason: 'no coordinator-ship-batch grant marker is in the file' };
  if (exact.length === 0) {
    const first = stray[0].trim();
    return { ok: false, code: 'grant-mismatch', reason: `the marker line is ${JSON.stringify(first.slice(0, 80))}, this fleet understands exactly ${JSON.stringify(GRANT_MARKER)} on a line of its own: a changed grant is a new canonical version` };
  }
  if (exact.length + stray.length > 1) return { ok: false, code: 'grant-mismatch', reason: `the grant marker appears ${exact.length + stray.length} times: refusing an ambiguous grant` };
  const mi = exact[0];
  // A fence still open at the marker (by the CommonMark rules above) makes it an EXAMPLE, not a grant.
  if (fencedAt(lines, mi)) return { ok: false, code: 'grant-mismatch', reason: 'the grant marker sits inside a code fence: an example, not a grant' };
  const hi = lines.lastIndexOf(GRANT_HEADING, mi);
  if (hi < 0) return { ok: false, code: 'grant-mismatch', reason: `the section heading ${JSON.stringify(GRANT_HEADING)} is not above the marker` };
  // The grant is the WHOLE section: nothing but blank lines may follow the marker before the next heading (a restriction added
  // there would otherwise be silently ignored).
  const next = lines.findIndex((l, i) => i > mi && /^#{1,6} /.test(l));
  const tail = lines.slice(mi + 1, next < 0 ? lines.length : next);
  if (tail.some((l) => l.trim() !== '')) return { ok: false, code: 'grant-mismatch', reason: 'text follows the marker inside the grant section: the whole section must be the canonical grant, so a restriction added there is refused, never ignored' };
  const section = lines.slice(hi, mi + 1).join('\n');
  if (fold(section) !== fold(CANONICAL_GRANT)) return { ok: false, code: 'grant-mismatch', reason: 'the grant section differs from the canonical text (narrowed, extended or reworded): revoke by deleting it, change it by a new canonical version' };
  return { ok: true, version: GRANT_VERSION };
}

/**
 * The path Louis's instructions live at. NOT overridable from the environment, deliberately: a session that can set an env var
 * (`HOME` on POSIX, `USERPROFILE` on Windows, which is what `os.homedir()` reads first) could point the check at a file it wrote
 * itself, and the whole check is that the text sits where only Louis writes. The account database answers instead
 * (`os.userInfo().homedir`); `os.homedir()` is only the fallback for a platform that cannot answer.
 * Tests and in-process callers pass `file` explicitly.
 */
export function defaultGrantFile() {
  let home;
  try { home = os.userInfo().homedir; } catch { home = null; }
  return path.join(home || os.homedir(), '.claude', 'CLAUDE.md');
}

/**
 * Read the grant from `file`. Never throws: an unreadable file is `grant-absent` with its reason.
 * @param {{file?: string, fsMod?: {readFileSync: Function}}} [o]
 */
export function readShipBatchGrant({ file = defaultGrantFile(), fsMod = fs } = {}) {
  let text = null;
  try { text = fsMod.readFileSync(file, 'utf-8'); } catch (e) { return { ok: false, code: 'grant-absent', reason: `the grant file ${file} could not be read (${e?.code ?? e?.message ?? 'error'})` }; }
  return parseShipBatchGrant(text);
}

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

const SINCE_RE = /^Since [^\n:]*:/m;
const fold = (s) => String(s).replace(/\r\n/g, '\n').replace(SINCE_RE, 'Since <DATE>:').replace(/[ \t]+$/gm, '');

/**
 * The path Louis's instructions live at. NOT overridable from the environment, deliberately: a session that can set an env var
 * could point the check at a file it wrote itself, and the whole check is that the text sits where only Louis writes. Tests
 * and in-process callers pass `file` explicitly.
 */
export function defaultGrantFile() {
  return path.join(os.homedir(), '.claude', 'CLAUDE.md');
}

/**
 * Judge the file's text. Pure.
 * @param {string|null} text the file's contents, or null when it could not be read
 * @returns {{ok: true, version: string} | {ok: false, code: 'grant-absent'|'grant-mismatch', reason: string}}
 */
export function parseShipBatchGrant(text) {
  if (typeof text !== 'string') return { ok: false, code: 'grant-absent', reason: 'the grant file could not be read' };
  const t = String(text).replace(/\r\n/g, '\n');
  const markers = t.split('\n').filter((l) => l.trim().startsWith('<!-- grant: coordinator-ship-batch')).length;
  if (!t.includes('<!-- grant: coordinator-ship-batch')) return { ok: false, code: 'grant-absent', reason: 'no coordinator-ship-batch grant marker is in the file' };
  if (markers > 1) return { ok: false, code: 'grant-mismatch', reason: `the grant marker appears ${markers} times: refusing an ambiguous grant` };
  const lines = t.split('\n');
  const mi = lines.findIndex((l) => l.trim().startsWith('<!-- grant: coordinator-ship-batch'));
  const marker = lines[mi].trim();
  if (marker !== GRANT_MARKER) return { ok: false, code: 'grant-mismatch', reason: `the marker is ${JSON.stringify(marker)}, this fleet understands ${JSON.stringify(GRANT_MARKER)}: a changed grant is a new canonical version` };
  // A fence between the heading and the marker (or an unclosed one before it) makes the marker an EXAMPLE, not a grant.
  let fenced = false;
  for (let i = 0; i < mi; i++) if (/^\s*(```|~~~)/.test(lines[i])) fenced = !fenced;
  if (fenced) return { ok: false, code: 'grant-mismatch', reason: 'the grant marker sits inside a code fence: an example, not a grant' };
  const hi = lines.lastIndexOf(GRANT_HEADING, mi);
  if (hi < 0) return { ok: false, code: 'grant-mismatch', reason: `the section heading ${JSON.stringify(GRANT_HEADING)} is not above the marker` };
  const section = lines.slice(hi, mi + 1).join('\n');
  if (fold(section) !== fold(CANONICAL_GRANT)) return { ok: false, code: 'grant-mismatch', reason: 'the grant section differs from the canonical text (narrowed, extended or reworded): revoke by deleting it, change it by a new canonical version' };
  return { ok: true, version: GRANT_VERSION };
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

/**
 * @fileoverview The standing-grant reader (scripts/lib/fleet/coordinator-grant.mjs): only the CANONICAL section passes.
 * Plan: docs/plans/coordinator-aggregate-ship.md section 2.1.
 *
 * The refusals are the point: a marker with its text removed or narrowed, an example in a fence, a second marker, an unreadable
 * file, and CRLF (which must still pass, so the check is not a Windows-only refusal). One test pins the prose-to-code seam: the
 * text the plan tells Louis to paste IS the text the reader accepts, because a prompt that names a contract is a claim.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CANONICAL_GRANT, GRANT_MARKER, GRANT_HEADING, parseShipBatchGrant, readShipBatchGrant, defaultGrantFile,
} from '../scripts/lib/fleet/coordinator-grant.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wrap = (grant) => `# Louis's standing instructions\n\nsome earlier rule\n\n${grant}\n\n## A later section\n\nmore text\n`;
const dated = CANONICAL_GRANT.replace('Since <DATE>:', 'Since 2026-11-18:');

describe('parseShipBatchGrant: the canonical section passes', () => {
  it('the canonical text as pasted (with the date filled in) is a grant', () => {
    const r = parseShipBatchGrant(wrap(dated));
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.version, 'v1');
  });
  it('any date value is accepted: the date is the one thing Louis fills in', () => {
    assert.equal(parseShipBatchGrant(wrap(CANONICAL_GRANT.replace('Since <DATE>:', 'Since 1999-01-01:'))).ok, true);
    assert.equal(parseShipBatchGrant(wrap(CANONICAL_GRANT)).ok, true);
  });
  it('CRLF line endings (a Windows editor) still pass', () => {
    assert.equal(parseShipBatchGrant(wrap(dated).replace(/\n/g, '\r\n')).ok, true);
  });
  it('trailing whitespace on a line does not matter', () => {
    assert.equal(parseShipBatchGrant(wrap(dated.replace('ship. Standing rules still apply:', 'ship. Standing rules still apply:   '))).ok, true);
  });
});

describe('parseShipBatchGrant: everything else refuses, with its own code', () => {
  it('no marker at all: grant-absent', () => {
    const r = parseShipBatchGrant('# only some other rules\n');
    assert.deepEqual([r.ok, r.code], [false, 'grant-absent']);
  });
  it('an unreadable file (null text): grant-absent', () => {
    assert.equal(parseShipBatchGrant(null).code, 'grant-absent');
  });
  it('the marker survives but the section text was DELETED: refuses (a stale marker never outlives its text)', () => {
    const r = parseShipBatchGrant(`${GRANT_HEADING}\n\n${GRANT_MARKER}\n`);
    assert.deepEqual([r.ok, r.code], [false, 'grant-mismatch']);
  });
  it('the grant NARROWED (a bullet removed): refuses', () => {
    const r = parseShipBatchGrant(wrap(dated.replace('- never `--no-verify` in wine-cellar-app;\n', '')));
    assert.deepEqual([r.ok, r.code], [false, 'grant-mismatch']);
  });
  it('the grant EXTENDED (a bullet added): refuses', () => {
    const r = parseShipBatchGrant(wrap(dated.replace('- never `--no-verify`', '- also merge anything labelled safe;\n- never `--no-verify`')));
    assert.equal(r.code, 'grant-mismatch');
  });
  it('a carve-out added to the prose: refuses', () => {
    assert.equal(parseShipBatchGrant(wrap(dated.replace('Standing rules still apply:', 'Standing rules still apply, except on Fridays:'))).code, 'grant-mismatch');
  });
  it('a marker of another version: refuses naming the version', () => {
    const r = parseShipBatchGrant(wrap(dated.replace('ship-batch v1', 'ship-batch v2')));
    assert.equal(r.code, 'grant-mismatch');
    assert.match(r.reason, /new canonical version/);
  });
  it('the marker inside a code fence is an EXAMPLE, not a grant', () => {
    const r = parseShipBatchGrant(`# notes\n\n\`\`\`markdown\n${dated}\n\`\`\`\n`);
    assert.deepEqual([r.ok, r.code], [false, 'grant-mismatch']);
    assert.match(r.reason, /code fence/);
  });
  it('two markers anywhere in the file: refuses as ambiguous', () => {
    const r = parseShipBatchGrant(`${wrap(dated)}\n${GRANT_MARKER}\n`);
    assert.equal(r.code, 'grant-mismatch');
    assert.match(r.reason, /appears 2 times/);
  });
  it('a restriction appended AFTER the marker, inside the section: refused, never ignored', () => {
    const r = parseShipBatchGrant(`${wrap(dated).replace(`${GRANT_MARKER}\n`, `${GRANT_MARKER}\n\nExcept that nothing lands on Fridays.\n`)}`);
    assert.equal(r.code, 'grant-mismatch');
    assert.match(r.reason, /text follows the marker/);
  });
  it('text after the marker BEYOND the next heading is another section and does not matter', () => {
    assert.equal(parseShipBatchGrant(wrap(dated)).ok, true);
  });
  it('a backtick fence whose INFO STRING holds a backtick is not an opener (CommonMark), so it cannot hide a real grant', () => {
    assert.equal(parseShipBatchGrant(`\`\`\`js \`x\`\nnot a fence\n\n${dated}\n`).ok, true);
  });
  it('a ### heading AFTER the marker is still INSIDE the level-2 grant section: its text is refused, not skipped', () => {
    const r = parseShipBatchGrant(wrap(dated).replace(`${GRANT_MARKER}\n`, `${GRANT_MARKER}\n\n### Exception\n\nNothing lands on Fridays.\n`));
    assert.equal(r.code, 'grant-mismatch');
    assert.match(r.reason, /text follows the marker/);
  });
  it('a marker in the middle of a line is not a marker line: refused, and never throws', () => {
    const r = parseShipBatchGrant(`# x\n\nnote: ${GRANT_MARKER} (inline)\n`);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'grant-mismatch');
    assert.match(r.reason, /line of its own/);
  });
  it('a fence is closed only by the SAME character and at least as many: a ~~~ line inside a ``` fence does not close it', () => {
    const r = parseShipBatchGrant(`\`\`\`\n~~~\n${dated}\n`);
    assert.deepEqual([r.ok, r.code], [false, 'grant-mismatch']);
    assert.match(r.reason, /code fence/);
  });
  it('a shorter fence inside a longer one does not close it either', () => {
    assert.equal(parseShipBatchGrant(`\`\`\`\`\n\`\`\`\n${dated}\n`).code, 'grant-mismatch');
  });
  it('a properly CLOSED fence earlier in the file does not hide a real grant after it', () => {
    assert.equal(parseShipBatchGrant(`\`\`\`js\ncode\n\`\`\`\n\n${dated}\n`).ok, true);
  });
  it('"Since <anything>:" is NOT free text: only a date (or the placeholder) is ignored', () => {
    const r = parseShipBatchGrant(wrap(dated.replace('Since 2026-11-18:', 'Since forever, except on Fridays:')));
    assert.equal(r.code, 'grant-mismatch');
  });
  it('an HTML comment opened BEFORE the section and closed by the marker\'s own --> hides the grant: refused', () => {
    const r = parseShipBatchGrant(`<!-- an old note\n${dated}\n`);
    assert.deepEqual([r.ok, r.code], [false, 'grant-mismatch']);
    assert.match(r.reason, /HTML comment/);
  });
  it('a CLOSED comment earlier in the file does not hide a real grant (the control)', () => {
    assert.equal(parseShipBatchGrant(`<!-- an old note -->\n\n${dated}\n`).ok, true);
  });
  it('the heading missing above the marker: refuses', () => {
    assert.equal(parseShipBatchGrant(wrap(dated.replace(GRANT_HEADING, '## Something else'))).code, 'grant-mismatch');
  });
});

describe('readShipBatchGrant: the file', () => {
  it('reads a real file', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'grant-'));
    try {
      const f = path.join(d, 'CLAUDE.md');
      fs.writeFileSync(f, wrap(dated));
      assert.equal(readShipBatchGrant({ file: f }).ok, true);
    } finally { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });
  it('a missing file is grant-absent with the path in the reason, never a throw', () => {
    const r = readShipBatchGrant({ file: path.join(os.tmpdir(), 'no-such-dir-xyz', 'CLAUDE.md') });
    assert.equal(r.code, 'grant-absent');
    assert.match(r.reason, /could not be read/);
  });
  it('FAILS CLOSED when the account database cannot answer: no home, no grant location, grant-absent (never os.homedir())', async () => {
    const os2 = await import('node:os');
    const real = os2.default.userInfo;
    os2.default.userInfo = () => { throw new Error('no passwd entry'); };
    try {
      assert.equal(defaultGrantFile(), null);
      const r = readShipBatchGrant();
      assert.deepEqual([r.ok, r.code], [false, 'grant-absent']);
      assert.match(r.reason, /no trusted home/);
    } finally { os2.default.userInfo = real; }
  });
  it('the default location is the ACCOUNT\'s home, and neither an env var nor HOME/USERPROFILE can redirect it', () => {
    const keys = ['FLEET_GRANT_FILE', 'HOME', 'USERPROFILE'];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    const expected = path.join(os.userInfo().homedir, '.claude', 'CLAUDE.md');
    try {
      for (const k of keys) process.env[k] = path.join(os.tmpdir(), 'attacker-written');
      assert.equal(defaultGrantFile(), expected);
    } finally { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
  });
});

describe('the prose-to-code seam: the text the plan tells Louis to paste is the text the reader accepts', () => {
  it('the fenced block in docs/plans/coordinator-aggregate-ship.md section 2.1 equals CANONICAL_GRANT', () => {
    const plan = fs.readFileSync(path.join(ROOT, 'docs', 'plans', 'coordinator-aggregate-ship.md'), 'utf8').replace(/\r\n/g, '\n');
    const at = plan.indexOf('Draft text to paste');
    assert.ok(at > 0, 'the plan must still carry the draft grant text');
    const open = plan.indexOf('```markdown\n', at);
    const close = plan.indexOf('\n```', open + 12);
    assert.ok(open > 0 && close > open, 'the draft must be in a fenced markdown block');
    const block = plan.slice(open + '```markdown\n'.length, close);
    assert.equal(block, CANONICAL_GRANT, 'the plan text and the canonical constant have drifted: Louis would paste a grant the code refuses');
    assert.equal(parseShipBatchGrant(block).ok, true);
  });
});

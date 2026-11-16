/**
 * Harness retro — normalisation + fingerprint contract (plan docs/plans/harness-retro.md §2 c5).
 * Equivalence: variants of ONE failure collapse. Collision: DISTINCT failures stay apart.
 * Egress: the label never carries a path, id, email or planted secret.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  FINGERPRINT_VERSION, LABEL_MAX, fingerprintOf, meaningfulLine, normaliseSignalText, safeLabel,
} from '../scripts/lib/friction/retro/fingerprint.mjs';

describe('normaliseSignalText', () => {
  it('replaces absolute Windows, POSIX and home paths', () => {
    assert.equal(normaliseSignalText('cannot open C:\\Users\\bob\\x.txt now'), 'cannot open <path> now');
    assert.equal(normaliseSignalText('cannot open /c/GIT/repo/x.mjs now'), 'cannot open <path> now');
    assert.equal(normaliseSignalText('see ~/.claude/projects/x'), 'see <path>');
  });

  it('keeps repo-relative paths (informative, not private)', () => {
    assert.equal(normaliseSignalText('bash: .claude/hooks/a.sh: No such file'), 'bash: .claude/hooks/a.sh: No such file');
  });

  it('replaces ids, uuids, mixed-hex shas, emails, urls and numbers', () => {
    const out = normaliseSignalText(
      'toolu_01ABCdef123 local_3c5f89d0-bc1c-42dd-9e77-0fb2aa409b87 at 88bf43ee by a@b.co https://x.y/z line 42',
    );
    assert.equal(out, '<id> <id> at <sha> by <email> <url> line N');
  });

  it('a path with spaces is normalised whole — no tail left behind', () => {
    assert.equal(normaliseSignalText('cannot open C:\\Users\\bob\\My Client Docs\\plan.txt now'), 'cannot open <path> now');
    assert.equal(normaliseSignalText('cannot open /srv/client acme/config.json now'), 'cannot open <path> now');
    assert.equal(normaliseSignalText('cannot open /home/alice/clients/Alice Smith.txt now'), 'cannot open <path> now');
    assert.equal(normaliseSignalText('cannot open C:\\Users\\bob\\Alice Smith.docx now'), 'cannot open <path> now');
  });

  it('a single-component absolute path is normalised too', () => {
    assert.equal(normaliseSignalText('cannot read /customer-secret now'), 'cannot read <path> now');
  });

  it('keeps a status code (401 ≠ 404) while other numbers collapse', () => {
    assert.equal(normaliseSignalText('API error 401 after 3 retries'), 'API error 401 after N retries');
    assert.notEqual(normaliseSignalText('HTTP 404'), normaliseSignalText('HTTP 401'));
    assert.equal(normaliseSignalText('status: 500 at line 12'), 'status: 500 at line N');
  });

  it('does not treat an all-letter hex-looking word as a sha', () => {
    assert.equal(normaliseSignalText('faceade defaced'), 'faceade defaced');
  });
});

describe('meaningfulLine', () => {
  it('skips noise and picks the first informative line', () => {
    const t = 'Failed with non-blocking status code: node:internal/modules/cjs/loader:1433\n  throw err;\n\nError: Cannot find module X';
    assert.equal(meaningfulLine(t), 'Error: Cannot find module X');
  });
  it('falls back to the first non-noise line', () => {
    assert.equal(meaningfulLine('Exit code 2\nsomething odd'), 'something odd');
  });
});

describe('fingerprintOf', () => {
  it('equivalence: path, sha and count variants of one failure share a fingerprint', () => {
    const a = fingerprintOf({ kind: 'tool_error', tool: 'Bash', text: "Exit code 1\nls: cannot access 'C:/a/b': No such file or directory" });
    const b = fingerprintOf({ kind: 'tool_error', tool: 'Bash', text: "Exit code 2\nls: cannot access '/tmp/zz/q': No such file or directory" });
    assert.equal(a.fingerprint, b.fingerprint);
  });

  it('collision: distinct failures, kinds or tools stay distinct', () => {
    const base = { kind: 'tool_error', tool: 'Bash', text: 'Error: Cannot find module X' };
    const fps = new Set([
      fingerprintOf(base).fingerprint,
      fingerprintOf({ ...base, text: 'Error: ENOENT: no such file or directory' }).fingerprint,
      fingerprintOf({ ...base, kind: 'refusal' }).fingerprint,
      fingerprintOf({ ...base, tool: 'Edit' }).fingerprint,
    ]);
    assert.equal(fps.size, 4);
  });

  it('MCP server uuids in tool names do not split one failure', () => {
    const a = fingerprintOf({ kind: 'denial', tool: 'mcp__0d5e74ba-de54-486f-a3bb-0a0223e0da9d__execute_sql', text: 'denied' });
    const b = fingerprintOf({ kind: 'denial', tool: 'mcp__11111111-2222-4333-8444-555555555555__execute_sql', text: 'denied' });
    assert.equal(a.fingerprint, b.fingerprint);
    assert.equal(a.tool, 'mcp__X__execute_sql');
  });

  it('folds the version into the hash (a bump re-baselines every fingerprint)', () => {
    assert.equal(FINGERPRINT_VERSION, 1);
    const fp = fingerprintOf({ kind: 'k', text: 't' }).fingerprint;
    assert.match(fp, /^[0-9a-f]{16}$/);
  });
});

describe('safeLabel — the only transcript text that leaves the reader', () => {
  it('redacts a planted secret shape', () => {
    const planted = 'auth failed for key sk-ant-api03-' + 'A'.repeat(40);
    const label = fingerprintOf({ kind: 'tool_error', text: planted }).label;
    assert.ok(!label.includes('A'.repeat(40)), label);
  });
  it('redacts a digit-bearing secret BEFORE normalisation can break its shape', () => {
    const key = 'ghp_' + '1a2b3c4d5e'.repeat(4);
    const out = fingerprintOf({ kind: 'tool_error', tool: `tool-${key}`, text: `Error: bad token ${key}` });
    assert.ok(!out.label.includes('1a2b3c4d5e'), out.label);
    assert.ok(!out.tool.includes('1a2b3c4d5e'), out.tool);
    assert.ok(!/ghp_N|ghp_[a-z]/.test(out.label), out.label);
  });
  it('caps the label length', () => {
    assert.ok(safeLabel('x '.repeat(500)).length <= LABEL_MAX);
  });
  it('never carries an absolute path or email', () => {
    const label = fingerprintOf({ kind: 'tool_error', text: 'Error: bob@corp.com cannot write C:\\Users\\bob\\secret.txt' }).label;
    assert.ok(!/bob|Users|corp\.com/.test(label), label);
  });
});

/**
 * @fileoverview `scanForLeaks` — the exporter's leak oracle applied to free text.
 * Tier 3 (sensitive-path egress): a miss here ships an organisation detail to a public
 * repo, so each shape is asserted refused WITH its category, and the one exemption
 * (a pathed source file) is asserted both ways.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { scanForLeaks, assertExportClean, ExportRefusedError } from '../scripts/lib/telemetry-export/redact.mjs';

const BS = String.fromCharCode(92);

describe('scanForLeaks (prose) — refused shapes carry their category', () => {
  const cases = [
    ['hostname', 'we connect to db.corp-internal.example.com daily', 'hostname'],
    ['DSN', 'postgres://svc:hunter2@db.example.invalid:5432/audit', 'dsn-userinfo'],
    ['IPv4', 'the tunnel ends at 10.20.30.40 today', 'ipv4-address'],
    ['email', 'ask someone@example.org about it', 'email'],
    ['Windows path', `see C:${BS}Users${BS}someone${BS}repo`, 'windows-path'],
    ['host-shaped file with no path context', 'it ran db.internal.mjs', 'hostname'],
    ['a host followed by a path (extension is not enough)', 'curl db.corp.py/internal', 'hostname'],
    ['a source-looking token used as a directory', 'GET db.internal.mjs/health', 'hostname'],
    ['a scheme-relative authority with a port', 'dial //db.corp.py:5432 now', 'hostname'],
    ['a scheme-relative authority', 'dial //db.internal.mjs now', 'hostname'],
    ['a bare source-looking host with a port', 'dial db.internal.mjs:5432', 'hostname'],
    ['a home path in parentheses', 'see (/home/alice/project)', 'home-path'],
    ['a home path after a bracket, comma or equals', 'see [/Users/bob/x] and a,~/y or p=/home/carol', 'home-path'],
    ['a pathed three-label host with a port', 'dial bastion/db.corp.py:5432 now', 'hostname'],
    ['a rooted three-label host with a port', 'dial /db.corp.py:5432 now', 'hostname'],
    ['a home path after a colon', 'path:/home/alice/project', 'home-path'],
    ['a home path in backticks', 'see `/home/alice/x` please', 'home-path'],
    ['IPv6 link-local', 'the peer was fe80::1 then', 'ipv6-address'],
    ['IPv6 compressed', 'at 2001:db8::8a2e:370:7334 today', 'ipv6-address'],
    ['IPv6 full form', 'at 2001:0db8:85a3:0000:0000:8a2e:0370:7334 today', 'ipv6-address'],
    ['IPv6 loopback', 'bound to ::1 only', 'ipv6-address'],
    ['a bare script name', 'run build.sh first', 'hostname'],
    ['a sensitive path token', 'copy the .env file', 'sensitive-path'],
  ];
  for (const [name, text, category] of cases) {
    it(`${name} is refused as ${category}`, () => {
      const r = scanForLeaks(text, { prose: true });
      assert.equal(r.clean, false, name);
      assert.ok(r.categories.includes(category), `${name}: ${r.categories}`);
    });
  }

  it('never echoes the matched text', () => {
    const r = scanForLeaks('db.corp-internal.example.com', { prose: true });
    assert.equal(JSON.stringify(r).includes('corp-internal'), false);
  });
});

describe('scanForLeaks (prose) — what passes', () => {
  it('a pathed source file passes, however deep', () => {
    for (const t of ['scripts/.claude-skills/lib/foo.mjs', 'lib/foo.mjs:12', 'see /x/y.mjs:7', 'see scripts/.claude-skills/x.mjs:120 for it', 'see lib/foo.mjs.', 'edit (lib/foo.mjs) then', 'scripts/lib/a.ts and tests/b.py']) {
      assert.deepEqual(scanForLeaks(t, { prose: true }), { clean: true, categories: [] }, t);
    }
  });

  it('plain prose passes, including words classifyPath would flag on their own', () => {
    assert.deepEqual(scanForLeaks('the token rotation and password policy were reviewed in 2026', { prose: true }),
      { clean: true, categories: [] });
  });

  it('clock times and ISO timestamps are not IPv6', () => {
    for (const t of ['at 10:00:00 today', '2026-11-21T10:00:00.000Z', 'ratio 1:2:3', 'std::fmt and Cache::add']) {
      assert.equal(scanForLeaks(t, { prose: true }).categories.includes('ipv6-address'), false, t);
      assert.equal(scanForLeaks(t).categories.includes('ipv6-address'), false, t);
    }
  });

  it('negative control: the same pathed file is refused WITHOUT prose mode', () => {
    assert.equal(scanForLeaks('scripts/.claude-skills/lib/foo.mjs').clean, false);
  });

  it('a pathed non-source host is still refused (extension must be a source extension)', () => {
    assert.equal(scanForLeaks('see docs/host.example.com', { prose: true }).clean, false);
  });
});

describe('assertExportClean is unchanged by the refactor', () => {
  it('still throws ExportRefusedError with sorted categories, and passes a clean document', () => {
    assert.doesNotThrow(() => assertExportClean({ a: 1, b: ['x', 'y'], when: '2026-11-21T10:00:00.123Z' }));
    try {
      assertExportClean({ host: 'db.corp.example.com', ip: '10.0.0.1' });
      assert.fail('should refuse');
    } catch (err) {
      assert.ok(err instanceof ExportRefusedError);
      assert.deepEqual(err.categories, ['hostname', 'ipv4-address']);
    }
  });

  it('a document carrying an IPv6 address is refused, and a timestamped document still passes', () => {
    assert.throws(() => assertExportClean({ peer: 'fe80::1' }), /ipv6-address/);
    assert.doesNotThrow(() => assertExportClean({ note: 'at 10:00:00 and 12:30', generatedAt: '2026-11-21T10:00:00.000Z', window: ['2026-11-01', '2026-11-21'], digest: 'd5a9d07b91225a93' }));
  });

  it('a home path in a document is refused after each lead-in, and the old lead-ins still work', () => {
    for (const p of ['path:/home/alice/project', '`/home/alice/x`', '(/home/alice/p)', '[~/x]', '<~/x>', 'a,/Users/bob', 'k=/home/c', ' /home/x', '"/home/x', "'/home/x", '/home/x']) {
      assert.throws(() => assertExportClean({ p }), /home-path/, p);
    }
    assert.doesNotThrow(() => assertExportClean({ p: 'the /homepage and a/home/ish' }));
  });

  it('a pathed source file in a document is still refused (the exemption is prose-only)', () => {
    assert.throws(() => assertExportClean({ p: 'scripts/lib/foo.mjs' }), ExportRefusedError);
  });

  it('a sensitive path key is still refused', () => {
    assert.throws(() => assertExportClean({ '.env': 1 }), /sensitive-path/);
  });
});

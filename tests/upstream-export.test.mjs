/**
 * `upstream report --export` (docs/plans/policy-private-consumer-stores.md §2.4, §9).
 * Tier 3 (sensitive-path egress): a leak here ships a consumer's confidential detail to
 * a PUBLIC repository, so the refusal tests live in the same change as the code.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { atomicWriteFileSync } from '../scripts/lib/file-io.mjs';
import {
  exportReport, identityStrings, substituteIdentity, renderExportMarkdown,
  identityEntries, EXPORT_DIR, PUBLIC_WARNING, SLUG_RE,
} from '../scripts/lib/upstream/export.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'scripts', 'cross-skill.mjs');
const dirs = [];
const rm = (d) => fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
afterEach(() => { while (dirs.length) rm(dirs.pop()); });

function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'upexp-'));
  dirs.push(d);
  return d;
}

const IDS = ['acme-org/orgx', 'acme-org', 'orgx'];
const CLEAN_BODY = 'The sync step in lib/foo.mjs:12 drops a line when orgx runs it. See scripts/.claude-skills/x.mjs.';

function spyIo() {
  const calls = { mkdir: 0, atomic: 0, exclusive: 0 };
  return {
    calls,
    io: {
      mkdirSync: (d) => { calls.mkdir += 1; fs.mkdirSync(d, { recursive: true }); },
      existsSync: (p) => fs.existsSync(p),
      readFileSync: (p) => fs.readFileSync(p, 'utf-8'),
      writeAtomic: (p, data) => { calls.atomic += 1; atomicWriteFileSync(p, data); },
      writeExclusive: (p, data) => { calls.exclusive += 1; atomicWriteFileSync(p, data, { exclusive: true }); },
    },
  };
}

function run(root, over = {}) {
  const spy = spyIo();
  const filed = [];
  const fileFn = over.fileFn ?? (async (a) => { filed.push(a); return { ok: true, cloud: false, spooled: true }; });
  const p = exportReport({
    repoRoot: root, repoUuid: 'uuid-1', title: 'Sync drops a line', body: CLEAN_BODY,
    severity: 'HIGH', affectedPath: 'scripts/lib/foo.mjs', slug: 'consumer-a', identities: IDS,
    now: () => new Date('2026-11-21T00:00:00Z'), io: spy.io, fileFn, ...over,
  });
  return p.then((res) => ({ res, filed, spy }));
}
const files = (root) => {
  const d = path.join(root, EXPORT_DIR);
  return fs.existsSync(d) ? fs.readdirSync(d).sort() : [];
};

describe('export refuses leaks and writes/files nothing', () => {
  const LEAKS = {
    hostname: 'It fails against db.internal.test during the sync.',
    dsn: 'Connection string was postgres://user:pw@db.internal.test:5432/x.',
    ipv4: 'The store at 10.1.2.3 times out.',
    ipv6: 'The store at 2001:db8::1 times out.',
    email: 'Contact someone@corp.example about it.',
    winPath: 'The file is under C:\\Users\\someone\\proj\\x.',
    homePath: 'The file is under /home/someone/proj/x.',
    bareHostExt: 'It fails against db.internal.mjs on startup.',
    hostPort: 'It fails against //db.corp.py:5432 on startup.',
  };
  for (const [name, text] of Object.entries(LEAKS)) {
    it(`refuses ${name}`, async () => {
      const root = tmp();
      const { res, filed, spy } = await run(root, { body: text });
      assert.equal(res.ok, false, name);
      assert.equal(res.step, 'scan');
      assert.equal(res.code, 'EXPORT_REFUSED');
      assert.ok(res.categories.length > 0);
      assert.ok(!JSON.stringify(res).includes('someone'), 'refusal never echoes the matched text');
      assert.deepEqual(filed, []);
      assert.deepEqual(spy.calls, { mkdir: 0, atomic: 0, exclusive: 0 });
      assert.deepEqual(files(root), []);
    });
  }

  it('lets pathed source files and plain prose through', async () => {
    const root = tmp();
    const { res } = await run(root);
    assert.equal(res.ok, true);
    const md = fs.readFileSync(path.join(root, res.exportPath), 'utf-8');
    assert.match(md, /lib\/foo\.mjs:12/);
    assert.match(md, /scripts\/\.claude-skills\/x\.mjs/);
  });

  it('scans the FINAL bytes: a leak in the title is caught too', async () => {
    const root = tmp();
    const { res, filed } = await run(root, { title: 'Fails on 10.9.8.7' });
    assert.equal(res.ok, false);
    assert.equal(res.step, 'scan');
    assert.deepEqual(filed, []);
  });
});

describe('identity substitution', () => {
  it('replaces the standalone identity, not larger identifiers', () => {
    const r = substituteIdentity('orgx runs; orgxtools and lib/orgx-helpers.mjs stay; ORGX. Also acme-org/orgx.', IDS, 'consumer-a');
    assert.equal(r.ok, true);
    assert.equal(r.text, 'consumer-a runs; orgxtools and lib/orgx-helpers.mjs stay; consumer-a. Also consumer-a.');
  });

  it('refuses a short identity that is present, ignores one that is absent', () => {
    const present = substituteIdentity('the abc tool breaks', ['abc'], 's');
    assert.deepEqual(present, { ok: false, code: 'identity-too-short', length: 3 });
    assert.equal(substituteIdentity('abcdef is a word', ['abc'], 's').ok, true);
  });

  it('is applied by the export, with owner/repo before the bare repo name', async () => {
    const root = tmp();
    const { res } = await run(root, { body: 'Cloned acme-org/orgx and ran orgx there.' });
    assert.equal(res.ok, true);
    const md = fs.readFileSync(path.join(root, res.exportPath), 'utf-8');
    assert.match(md, /Cloned consumer-a and ran consumer-a there\./);
    assert.ok(!/orgx/i.test(md.replace(/lib\/orgx/g, '')));
  });

  it('a short identity in the body refuses the export with identity-too-short', async () => {
    const root = tmp();
    const { res, filed } = await run(root, { identities: ['abc'], body: 'abc is broken' });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'identity-too-short');
    assert.deepEqual(filed, []);
    assert.deepEqual(files(root), []);
  });

  it('identityStrings reads the remote, basename and package name', () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@acme-org/pkgname' }));
    const git = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf-8' });
    git('init', '-q');
    git('remote', 'add', 'origin', 'https://github.com/acme-org/orgx.git');
    const ids = identityStrings(root);
    for (const want of ['acme-org/orgx', 'acme-org', 'orgx', 'pkgname', path.basename(root)]) {
      assert.ok(ids.some((i) => i.toLowerCase() === want.toLowerCase()), want);
    }
    assert.equal(ids[0], 'acme-org/orgx');
  });
});

describe('embedded identities, undeterminable identity, verbatim affected path', () => {
  for (const [name, text] of Object.entries({
    word: 'orgxtools breaks on startup.',
    path: 'See lib/orgx-helpers.mjs for the call.',
  })) {
    it(`refuses an identity embedded in a larger token (${name}) naming the class, not the string`, async () => {
      const root = tmp();
      const { res, filed, spy } = await run(root, { body: text });
      assert.equal(res.ok, false);
      assert.equal(res.code, 'identity-embedded');
      assert.equal(res.identityClass, 'repo');
      assert.ok(!JSON.stringify(res).toLowerCase().includes('orgx'));
      assert.deepEqual(filed, []);
      assert.deepEqual(spy.calls, { mkdir: 0, atomic: 0, exclusive: 0 });
      assert.deepEqual(files(root), []);
    });
  }

  it('an embedded identity in the TITLE is refused too, with the owner class', async () => {
    const { res } = await run(tmp(), {
      title: 'acme-orgs tooling breaks',
      identities: [{ value: 'acme-org', kind: 'owner' }, { value: 'orgx', kind: 'repo' }],
    });
    assert.equal(res.code, 'identity-embedded');
    assert.equal(res.identityClass, 'owner');
  });

  it('a RECOGNISED upstream affected path passes verbatim, even with an identity-like segment', async () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(root, 'scripts', '.sync-manifest.json'), JSON.stringify({
      commitSha: 'abcdef0123456789', files: { 'scripts/lib/orgx/helpers.mjs': 'h' },
    }));
    const { res } = await run(root, { affectedPath: 'scripts/lib/orgx/helpers.mjs' });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.ok(fs.readFileSync(path.join(root, res.exportPath), 'utf-8').includes('scripts/lib/orgx/helpers.mjs'));
  });

  it('an UNRECOGNISED affected path containing an identity is refused (no manifest, and a manifest without it)', async () => {
    const a = await run(tmp(), { affectedPath: 'scripts/lib/orgx/helpers.mjs' });
    assert.equal(a.res.code, 'identity-embedded');
    assert.ok(!JSON.stringify(a.res).toLowerCase().includes('orgx'));
    assert.deepEqual(a.filed, []);
    assert.deepEqual(a.spy.calls, { mkdir: 0, atomic: 0, exclusive: 0 });
    const root = tmp();
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(root, 'scripts', '.sync-manifest.json'), JSON.stringify({ files: { 'scripts/other.mjs': 'h' } }));
    const b = await run(root, { affectedPath: 'scripts/lib/orgx/helpers.mjs' });
    assert.equal(b.res.code, 'identity-embedded');
    assert.deepEqual(files(root), []);
  });

  it('short identities are refused when bounded by punctuation, - or _, but not inside a word', async () => {
    for (const body of ['the abc-tools break', 'my_abc fails', 'it said (abc) twice', 'abc']) {
      const { res, filed } = await run(tmp(), { identities: ['abc'], body });
      assert.equal(res.code, 'identity-too-short', body);
      assert.deepEqual(filed, []);
    }
    for (const body of ['a fabric problem', 'abcd is a word', 'the abcdef module']) {
      const { res } = await run(tmp(), { identities: ['abc'], body });
      assert.equal(res.ok, true, body);
    }
  });

  it('a slug that CONTAINS an identity is refused', async () => {
    const { res, filed } = await run(tmp(), { slug: 'my-orgx-team' });
    assert.equal(res.code, 'BAD_INPUT');
    assert.deepEqual(filed, []);
  });

  function gitRepo(remote) {
    const root = tmp();
    const git = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf-8' });
    git('init', '-q');
    if (remote) git('remote', 'add', 'origin', remote);
    return root;
  }

  it('identityEntries covers every namespace component, pair and the full path, with classes', () => {
    const root = gitRepo('https://git.example/grp/sub/proj.git');
    const e = identityEntries(root);
    const get = (v) => e.find((x) => x.value.toLowerCase() === v)?.kind;
    assert.equal(get('grp/sub/proj'), 'repo');
    assert.equal(get('grp/sub'), 'repo');
    assert.equal(get('sub/proj'), 'repo');
    assert.equal(get('grp'), 'owner');
    assert.equal(get('sub'), 'owner');
    assert.equal(get('proj'), 'repo');
    assert.ok(!e.some((x) => x.value.includes('git.example')));
  });

  it('an absent remote and an absent package.json are fine', async () => {
    const root = gitRepo(null);
    const { res } = await run(root, { identities: undefined, slug: 'consumer-a' });
    assert.equal(res.ok, true, JSON.stringify(res));
  });

  it('a malformed package.json refuses with identity-undeterminable and writes nothing', async () => {
    const root = gitRepo(null);
    fs.writeFileSync(path.join(root, 'package.json'), '{ not json');
    const { res, filed } = await run(root, { identities: undefined });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'identity-undeterminable');
    assert.deepEqual(filed, []);
    assert.deepEqual(files(root), []);
  });
});

describe('slug', () => {
  it('validates the charset and refuses an identity string', async () => {
    for (const bad of ['', 'Has Space', 'UPPER', 'a'.repeat(33), 'x_y']) {
      assert.equal(SLUG_RE.test(bad), false, bad);
      const { res } = await run(tmp(), { slug: bad });
      assert.equal(res.ok, false);
      assert.equal(res.code, 'BAD_INPUT');
    }
    const { res, filed } = await run(tmp(), { slug: 'orgx' });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'BAD_INPUT');
    assert.deepEqual(filed, []);
  });
});

describe('render', () => {
  it('carries title, severity, path, short sha and body, and no local detail', () => {
    const md = renderExportMarkdown({
      title: 'T', body: 'B', severity: 'LOW', affectedPath: 'scripts/x.mjs',
      bundleSha: 'abcdef0123456789', slug: 's',
    });
    assert.match(md, /^# T/);
    assert.match(md, /abcdef0/);
    assert.ok(!md.includes('abcdef01'));
  });
});

describe('idempotency, records, concurrency', () => {
  it('a retry after a failed filing completes: one .md, one record, filed set', async () => {
    const root = tmp();
    let n = 0;
    const fileFn = async () => {
      n += 1;
      if (n === 1) throw new Error('store down');
      return { ok: true, cloud: true, id: 'issue-1', spooled: false };
    };
    const first = await run(root, { fileFn });
    assert.equal(first.res.ok, false);
    assert.equal(first.res.step, 'file');
    assert.equal(first.res.exists.record, true);
    assert.ok(first.res.exists.exportPath);
    assert.equal(first.res.exists.filed, false);
    const before = files(root);
    assert.equal(before.length, 2);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, EXPORT_DIR, before.find((f) => f.endsWith('.json'))), 'utf-8')).filed, null);

    const second = await run(root, { fileFn });
    assert.equal(second.res.ok, true);
    assert.deepEqual(files(root), before);
    const rec = JSON.parse(fs.readFileSync(path.join(root, EXPORT_DIR, before.find((f) => f.endsWith('.json'))), 'utf-8'));
    assert.deepEqual(rec.filed, { cloud: true, id: 'issue-1', spooled: false, store: null });
  });

  it('an existing .md with DIFFERENT bytes is never overwritten', async () => {
    const root = tmp();
    const a = await run(root);
    const mdp = path.join(root, a.res.exportPath);
    fs.writeFileSync(mdp, 'edited by hand');
    const b = await run(root);
    assert.equal(b.res.ok, false);
    assert.equal(b.res.step, 'write');
    assert.equal(b.res.code, 'export-file-modified');
    assert.equal(b.res.exists.exportPath, a.res.exportPath);
    assert.equal(fs.readFileSync(mdp, 'utf-8'), 'edited by hand');
  });

  it('a record that already says filed skips filing and returns the recorded state', async () => {
    const root = tmp();
    const fileFn = async () => ({ ok: true, cloud: true, id: 'issue-9', spooled: false });
    const a = await run(root, { fileFn, storeFingerprint: 'store-a' });
    assert.equal(a.res.ok, true);
    const filed = [];
    const b = await run(root, { storeFingerprint: 'store-a', fileFn: async (x) => { filed.push(x); return { ok: true }; } });
    assert.equal(b.res.ok, true);
    assert.deepEqual(filed, []);
    assert.equal(b.res.filing.id, 'issue-9');
    assert.equal(b.res.filing.alreadyFiled, true);

    // Filed against store A; a retry aimed at store B must file again, and then be remembered.
    const c = await run(root, { storeFingerprint: 'store-b', fileFn: async (x) => { filed.push(x); return { ok: true, cloud: true, id: 'issue-10', spooled: false }; } });
    assert.equal(c.res.ok, true);
    assert.equal(filed.length, 1);
    assert.equal(c.res.filing.alreadyFiled, undefined);
    const rec = JSON.parse(fs.readFileSync(path.join(root, c.res.recordPath), 'utf-8'));
    assert.equal(rec.filed.store, 'store-b');
    const d = await run(root, { storeFingerprint: 'store-b', fileFn: async (x) => { filed.push(x); return { ok: true }; } });
    assert.equal(filed.length, 1);
    assert.equal(d.res.filing.alreadyFiled, true);
  });

  it('a changed body under the same title makes a second file and record; the first still matches its hash', async () => {
    const root = tmp();
    const a = await run(root);
    const b = await run(root, { body: `${CLEAN_BODY} More detail follows.` });
    assert.equal(a.res.ok && b.res.ok, true);
    assert.notEqual(a.res.exportPath, b.res.exportPath);
    assert.equal(files(root).length, 4);
    for (const r of [a.res, b.res]) {
      const bytes = fs.readFileSync(path.join(root, r.exportPath), 'utf-8');
      const rec = JSON.parse(fs.readFileSync(path.join(root, r.recordPath), 'utf-8'));
      assert.equal(rec.sha256, (await import('node:crypto')).createHash('sha256').update(bytes, 'utf8').digest('hex'));
      assert.ok(r.exportPath.includes(rec.sha256.slice(0, 16)));
    }
  });

  it('two concurrent exports of different reports both keep their records', async () => {
    const root = tmp();
    const [a, b] = await Promise.all([
      run(root, { title: 'Report one' }),
      run(root, { title: 'Report two', body: 'A different problem in lib/bar.mjs:3.' }),
    ]);
    assert.equal(a.res.ok && b.res.ok, true);
    assert.equal(files(root).filter((f) => f.endsWith('.json')).length, 2);
    assert.notEqual(a.res.recordPath, b.res.recordPath);
  });

  it('the record carries no title or body text and no absolute path', async () => {
    const root = tmp();
    const { res } = await run(root);
    const text = fs.readFileSync(path.join(root, res.recordPath), 'utf-8');
    const rec = JSON.parse(text);
    assert.equal(rec.schema, 'upstream-export/v1');
    assert.deepEqual(Object.keys(rec).sort(), ['exportedAt', 'filed', 'fingerprint', 'path', 'schema', 'sha256', 'slug']);
    assert.ok(!text.includes('Sync drops a line'));
    assert.ok(!text.includes('drops a line when'));
    assert.ok(!path.isAbsolute(rec.path));
    assert.ok(!text.includes(root));
  });

  it('a validation failure writes nothing', async () => {
    const root = tmp();
    const { res, filed, spy } = await run(root, { title: '' });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'BAD_INPUT');
    assert.deepEqual(filed, []);
    assert.equal(spy.calls.mkdir, 0);
  });
});

describe('CLI: stdin only, PUBLIC warning, local record', () => {
  function repo() {
    const root = tmp();
    const git = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf-8' });
    git('init', '-q');
    git('remote', 'add', 'origin', 'https://github.com/acme-org/orgx.git');
    return root;
  }
  const cli = (root, args, input) => spawnSync(process.execPath, [CLI, 'upstream', 'report', ...args], {
    cwd: root, input, encoding: 'utf-8',
    env: { ...process.env, AUDIT_DB_URL: '', LEARNING_DISABLE: '1', MODEL_CATALOG_REFRESH: 'skip' },
  });
  const base = ['--export', '--slug', 'consumer-a', '--title', 'Sync drops a line', '--severity', 'HIGH',
    '--affected-path', 'scripts/lib/foo.mjs'];

  it('--export with --body in argv is a usage error and writes nothing', () => {
    const root = repo();
    const r = cli(root, [...base, '--body', 'x'], '');
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stdout + r.stderr, /stdin/);
    assert.deepEqual(files(root), []);
  });

  it('--slug is required with --export', () => {
    const root = repo();
    const args = base.filter((_, i) => i !== 1 && i !== 2);
    const r = cli(root, args, CLEAN_BODY);
    assert.equal(r.status, 2, r.stderr);
    assert.deepEqual(files(root), []);
  });

  it('a stdin body is accepted: PUBLIC line on stderr, envelope names the file, record exists', () => {
    const root = repo();
    const r = cli(root, base, CLEAN_BODY);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stderr.includes(PUBLIC_WARNING));
    const env = JSON.parse(r.stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop());
    assert.equal(env.public, true);
    assert.ok(env.exportPath.startsWith('.audit/upstream-exports/'));
    assert.equal(files(root).length, 2);
    assert.ok(fs.existsSync(path.join(root, env.exportPath)));
    const md = fs.readFileSync(path.join(root, env.exportPath), 'utf-8');
    assert.ok(!/orgx/i.test(md), 'the remote repo name is replaced by the slug');
    assert.match(md, /consumer-a/);
    assert.equal(env.spooled, true); // cloud off: the usual report path spools to the outbox
  });

  it('a failure AFTER the file exists still prints the PUBLIC line (R3 M2)', () => {
    const root = repo();
    const first = cli(root, base, CLEAN_BODY);
    assert.equal(first.status, 0, first.stderr);
    const env = JSON.parse(first.stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop());
    // The operator edits the exported file; the same export then refuses to overwrite it (step write).
    fs.appendFileSync(path.join(root, env.exportPath), '\nedited by the operator\n');
    const again = cli(root, base, CLEAN_BODY);
    assert.equal(again.status, 1, again.stderr);
    assert.match(again.stdout + again.stderr, /export-file-modified/);
    assert.ok(again.stderr.includes(PUBLIC_WARNING), 'the file exists, so the warning is owed');
  });

  it('a refused export exits non-zero with no record and no PUBLIC line', () => {
    const root = repo();
    const r = cli(root, base, 'It fails against 10.1.2.3 today.');
    assert.equal(r.status, 1, r.stderr);
    assert.deepEqual(files(root), []);
    assert.ok(!r.stderr.includes(PUBLIC_WARNING));
    assert.ok(!(r.stdout + r.stderr).includes('10.1.2.3'));
  });
});

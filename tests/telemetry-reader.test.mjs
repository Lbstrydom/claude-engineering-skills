/**
 * @fileoverview The CES-side reader: five states, and an absent export is NEVER a zero.
 *
 * Every state is driven against a real temporary drop directory populated by the real exporter
 * (`buildExport` + `deliverExport`), so the producer/consumer seam is exercised, not mocked.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildExport } from '../scripts/lib/telemetry-export/build.mjs';
import { deliverExport } from '../scripts/lib/telemetry-export/deliver.mjs';
import { MAX_EXPORT_BYTES } from '../scripts/lib/telemetry-export/schema.mjs';
import {
  scanDrop, pruneDrop, renderTelemetryExports, MAX_FILES_PER_ALIAS, KEEP_VALID, WEEKLY_STALE_DAYS,
} from '../scripts/lib/telemetry-export/reader.mjs';
import { expectedExporters } from '../scripts/lib/consumer-repos.mjs';
import { scanRegistered } from '../scripts/lib/telemetry-export/registered.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAY = 86_400_000;
const NOW = new Date('2026-11-20T12:00:00.000Z');
const roots = [];
afterEach(() => { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tel-reader-')); roots.push(d); return d; };

const goodDeps = (over = {}) => ({
  reachability: async () => ({ configured: true, ok: true }),
  drift: async () => ({ ok: true, drift: { hasDrift: false, drift: { unapplied: [], shaMismatch: [] }, liveConstraints: { measured: true, missing: [], altered: [] } } }),
  readRows: async () => ({ status: 'ok', runs: [{ mode: 'code', gemini_verdict: 'APPROVE', converged: true, n: 4 }], findings: [{ severity: 'HIGH', adjudication_outcome: 'accepted', pass_name: 'backend', n: 2 }], upstream: [{ id: 'a', severity: 'HIGH', created_at: '2026-11-10T10:00:00.000Z' }], totalOpen: 1 }),
  ...over,
});

/** Deliver a REAL export generated `ageDays` before NOW. */
async function put(drop, { alias = 'acme', ageDays = 1, deps = goodDeps(), exportId = crypto.randomUUID() } = {}) {
  const doc = await buildExport({ now: new Date(NOW.getTime() - ageDays * DAY), consumerAlias: alias, storeFingerprint: 'a'.repeat(16), toolBundleSha: null, exportId, deps });
  return deliverExport({ doc, dropDir: drop }).file;
}
/** Symlink creation needs a privilege on some Windows setups: skip EXPLICITLY for that, rethrow anything else. */
function trySymlink(t, target, link, type) {
  try { fs.symlinkSync(target, link, type); return true; } catch (err) {
    if (['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP'].includes(err?.code)) { t.skip(`symlinks unavailable here (${err.code})`); return false; }
    throw err;
  }
}
const expected = (cadence = 'weekly', alias = 'acme') => [{ alias, cadence }];
const scan = (drop, exp = expected()) => scanDrop({ dropDir: drop, expected: exp, now: NOW });
const stateOf = (r, alias = 'acme') => r.aliases.find((a) => a.alias === alias);

describe('the five states', () => {
  it('received: a valid export within policy, with its figures and age', async () => {
    const drop = tmp(); await put(drop, { ageDays: 2 });
    const a = stateOf(scan(drop));
    assert.equal(a.state, 'received');
    assert.equal(a.ageDays, 2);
    assert.equal(a.figures.audit.measured, true);
    assert.equal(a.figures.audit.runs, 4);
    assert.equal(a.figures.upstream.totalOpen, 1);
  });

  it('never-received: a CLEAN scan that found nothing is "unmeasured", with NO counts', () => {
    const drop = tmp();
    const r = scan(drop);
    const a = stateOf(r);
    assert.equal(a.state, 'never-received');
    assert.equal('figures' in a, false);
    const text = renderTelemetryExports(r).join('\n');
    assert.match(text, /unmeasured acme \(weekly\): no export received/);
    assert.match(text, /NOT zero/);
    assert.doesNotMatch(text, /audit runs 0|upstream open 0/);
  });

  it('stale: a weekly alias past 14 days keeps its figures but LABELLED with their age', async () => {
    const drop = tmp(); await put(drop, { ageDays: WEEKLY_STALE_DAYS + 1 });
    const r = scan(drop);
    assert.equal(stateOf(r).state, 'stale');
    const text = renderTelemetryExports(r).join('\n');
    assert.match(text, /STALE acme/);
    assert.match(text, /15d old/);
    assert.match(text, /not current/);
  });

  it('CONTROL — on-demand promised no cadence: the same age is shown, never stale', async () => {
    const drop = tmp(); await put(drop, { ageDays: 40 });
    const a = stateOf(scan(drop, expected('on-demand')));
    assert.equal(a.state, 'received');
    assert.equal(a.ageDays, 40);
  });

  it('staleness is judged on the EXACT elapsed time, not on floored days', async () => {
    const drop = tmp(); await put(drop, { ageDays: WEEKLY_STALE_DAYS });
    assert.equal(stateOf(scan(drop)).state, 'received', 'exactly 14 days is the boundary, not past it');
    const justPast = scanDrop({ dropDir: drop, expected: expected(), now: new Date(NOW.getTime() + 3_600_000) });
    assert.equal(stateOf(justPast).state, 'stale', '14 days and one hour is past the policy');
    assert.equal(stateOf(justPast).ageDays, WEEKLY_STALE_DAYS, 'the DISPLAY still says 14d');
  });

  it('rejected: files arrived and none validated — reasons are shown, never dropped', () => {
    const drop = tmp();
    fs.mkdirSync(path.join(drop, 'acme'));
    fs.writeFileSync(path.join(drop, 'acme', '2026-11-19-0b9c1f3e-6d1a-4b6e-8a53-3f5a2f1c9d77.json'), '{not json');
    const r = scan(drop);
    const a = stateOf(r);
    assert.equal(a.state, 'rejected');
    assert.equal(a.latestRejected.reason, 'not-json');
    assert.match(renderTelemetryExports(r).join('\n'), /rejected acme \(weekly\): 1 file\(s\), none valid — newest: not-json/);
  });

  it('a valid export beside a NEWER rejected file shows both (the honest picture)', async () => {
    const drop = tmp(); await put(drop, { ageDays: 3 });
    fs.writeFileSync(path.join(drop, 'acme', '2026-11-30-0b9c1f3e-6d1a-4b6e-8a53-3f5a2f1c9d77.json'), '[]');
    const a = stateOf(scan(drop));
    assert.equal(a.state, 'received');
    assert.equal(a.latestRejected.reason, 'not-an-export');
    assert.equal(a.latestRejected.newer, true);
    assert.match(renderTelemetryExports(scan(drop)).join('\n'), /newer file rejected: not-an-export/);
  });

  it('an OLDER rejected file is not described as newer', async () => {
    const drop = tmp(); await put(drop, { ageDays: 3 });
    fs.writeFileSync(path.join(drop, 'acme', '2026-01-01-0b9c1f3e-6d1a-4b6e-8a53-3f5a2f1c9d77.json'), '[]');
    const a = stateOf(scan(drop));
    assert.equal(a.latestRejected.newer, false);
    const text = renderTelemetryExports(scan(drop)).join('\n');
    assert.match(text, /another file rejected: not-an-export/);
    assert.doesNotMatch(text, /newer file rejected/);
  });
});

describe('all three drift indicators are shown', () => {
  it('migrations behind, sha-mismatched and broken constraints each appear, so none can hide', async () => {
    const drop = tmp();
    await put(drop, { deps: goodDeps({ drift: async () => ({ ok: true, drift: { hasDrift: true, drift: { unapplied: ['a', 'b'], shaMismatch: ['c'] }, liveConstraints: { measured: true, missing: ['x', 'y', 'z'], altered: [] } } }) }) });
    const text = renderTelemetryExports(scan(drop)).join('\n');
    assert.match(text, /migrations behind 2/);
    assert.match(text, /sha-mismatched 1/);
    assert.match(text, /constraints broken 3/);
  });
});

describe('a genuine zero is a zero; an absent export is not', () => {
  it('a received export with real zeros renders 0 (measured), while a missing one renders unmeasured', async () => {
    const drop = tmp();
    await put(drop, { alias: 'idle', ageDays: 1, deps: goodDeps({ readRows: async () => ({ status: 'ok', runs: [], findings: [], upstream: [], totalOpen: 0 }) }) });
    const r = scan(drop, [...expected('weekly', 'idle'), ...expected('weekly', 'silent')]);
    const text = renderTelemetryExports(r).join('\n');
    assert.match(text, /ok idle \(weekly\).*audit runs 0 · upstream open 0/);
    assert.match(text, /unmeasured silent \(weekly\): no export received/);
    assert.equal(stateOf(r, 'idle').figures.audit.measured, true);
    assert.equal('figures' in stateOf(r, 'silent'), false);
  });

  it('a received export whose store was unreachable shows each group as unmeasured, not 0', async () => {
    const drop = tmp();
    await put(drop, { deps: goodDeps({ reachability: async () => ({ configured: true, ok: false }) }) });
    const text = renderTelemetryExports(scan(drop)).join('\n');
    assert.match(text, /audit runs unmeasured \(store-unreachable\)/);
    assert.match(text, /upstream open unmeasured \(store-unreachable\)/);
    assert.doesNotMatch(text, /audit runs 0/);
  });
});

describe('"we could not look" is not "nothing was there"', () => {
  it('a missing drop directory: scan error, every alias drop-unreadable, NO never-received claim', () => {
    const r = scan(path.join(tmp(), 'nope'), [...expected('weekly', 'a'), ...expected('weekly', 'b')]);
    assert.equal(r.scanError, 'ENOENT');
    assert.deepEqual(r.aliases.map((a) => a.state), ['drop-unreadable', 'drop-unreadable']);
    const text = renderTelemetryExports(r).join('\n');
    assert.match(text, /could not look/);
    assert.doesNotMatch(text, /no export received/);   // the header names the phrase only to say it is NOT claimed
    assert.equal(r.aliases.some((a) => a.state === "never-received"), false);
  });

  it('no drop directory configured at all is the same state', () => {
    const r = scanDrop({ dropDir: null, expected: expected(), now: NOW });
    assert.equal(r.scanError, 'no-drop-dir');
    assert.equal(r.aliases[0].state, 'drop-unreadable');
  });

  it('a drop path that is a FILE is a scan error, not an empty directory', () => {
    const f = path.join(tmp(), 'file'); fs.writeFileSync(f, 'x');
    assert.equal(scan(f).aliases[0].state, 'drop-unreadable');
  });

  it('CONTROL — the same scan over an existing EMPTY directory is a clean never-received', () => {
    assert.equal(stateOf(scan(tmp())).state, 'never-received');
  });
});

describe('scan bounds never produce a clean "never received"', () => {
  it('too many files in one alias: scan incomplete, and an alias that found nothing is NOT claimed absent', () => {
    const drop = tmp();
    fs.mkdirSync(path.join(drop, 'a'));
    for (let i = 0; i < MAX_FILES_PER_ALIAS + 1; i++) {
      const id = crypto.randomUUID();
      fs.writeFileSync(path.join(drop, 'a', `2026-11-${String(1 + (i % 28)).padStart(2, '0')}-${id}.json`), '{}');
    }
    // The empty alias is listed FIRST, so it is judged before the bound is hit: the post-scan pass is what must catch it.
    const r = scan(drop, [...expected('weekly', 'b'), ...expected('weekly', 'a')]);
    assert.equal(r.scanIncomplete, 'files-per-alias');
    assert.equal(stateOf(r, 'b').state, 'scan-incomplete');
    assert.match(renderTelemetryExports(r).join('\n'), /could not establish that none exists/);
  });
});

describe('a partial read is never a definitive state', () => {
  it('an alias cut off by the file bound is scan-incomplete even if it has a valid export in what was read', async () => {
    const drop = tmp(); await put(drop, { ageDays: 1 });
    for (let i = 0; i < MAX_FILES_PER_ALIAS; i++) {
      fs.writeFileSync(path.join(drop, 'acme', `2026-12-${String(1 + (i % 28)).padStart(2, '0')}-${crypto.randomUUID()}.json`), '{}');
    }
    const r = scan(drop);
    const a = stateOf(r);
    assert.equal(a.state, 'scan-incomplete');
    assert.equal('figures' in a, false, 'no figures from a partial read');
    assert.equal(r.scanIncomplete, 'files-per-alias');
  });
});

describe('a symlink at the top of the drop is reported, never followed (final gate G1)', () => {
  it('an unexpected symlink is listed as unattributed/symlink', (t) => {
    const drop = tmp(); const outside = tmp();
    if (!trySymlink(t, outside, path.join(drop, 'stranger'), 'junction')) return;
    const r = scan(drop);
    assert.deepEqual(r.unattributed, [{ dir: 'stranger', reason: 'symlink' }]);
  });
});

describe('scan-incomplete causes do not hide each other', () => {
  it('a count bound hit AFTER an unreadable alias still wins (it is what makes absence unprovable elsewhere)', () => {
    const drop = tmp();
    fs.writeFileSync(path.join(drop, 'broken'), 'not a directory');
    fs.mkdirSync(path.join(drop, 'big'));
    for (let i = 0; i < MAX_FILES_PER_ALIAS + 1; i++) fs.writeFileSync(path.join(drop, 'big', `2026-11-${String(1 + (i % 28)).padStart(2, '0')}-${crypto.randomUUID()}.json`), '{}');
    fs.mkdirSync(path.join(drop, 'empty'));
    const r = scan(drop, [...expected('weekly', 'broken'), ...expected('weekly', 'big'), ...expected('weekly', 'empty')]);
    assert.equal(r.scanIncomplete, 'files-per-alias');
    assert.equal(stateOf(r, 'empty').state, 'scan-incomplete');
  });
});

describe('re-validation: CES does not trust the sender', () => {
  const planted = (drop, name, body) => {
    fs.mkdirSync(path.join(drop, 'acme'), { recursive: true });
    fs.writeFileSync(path.join(drop, 'acme', name), typeof body === 'string' ? body : JSON.stringify(body));
  };
  const NAME = '2026-11-19-0b9c1f3e-6d1a-4b6e-8a53-3f5a2f1c9d77.json';

  it('an unknown version, a foreign JSON, extra keys and a bad name are each their own closed reason', async () => {
    const drop = tmp();
    const good = JSON.parse(fs.readFileSync(await put(drop, { ageDays: 1 }), 'utf8'));
    const cases = [
      ['unsupported-version', { ...good, schema: 'telemetry-export/v2' }],
      ['not-an-export', { hello: 'world' }],
      ['invalid: schema: unrecognized_keys at (root)', { ...good, repoName: 'x' }],
    ];
    for (const [reason, body] of cases) {
      const d = tmp(); planted(d, NAME, body);
      assert.equal(stateOf(scan(d)).latestRejected.reason.startsWith(reason.split(':')[0] === 'invalid' ? 'invalid' : reason), true, reason);
    }
    const d = tmp(); planted(d, 'notes.json', good);
    assert.equal(stateOf(scan(d)).latestRejected.reason, 'bad-name');
  });

  it('a file whose body names a DIFFERENT alias than its directory is rejected', async () => {
    const drop = tmp(); const other = JSON.parse(fs.readFileSync(await put(drop, { alias: 'other', ageDays: 1 }), 'utf8'));
    const d = tmp(); planted(d, NAME, other);
    assert.equal(stateOf(scan(d)).latestRejected.reason, 'alias-mismatch');
  });

  it('a future-dated file (more than a day ahead) is rejected, so a forged date cannot read as freshest', async () => {
    const drop = tmp(); await put(drop, { ageDays: -3 });
    assert.equal(stateOf(scan(drop)).latestRejected.reason, 'future-dated');
    assert.equal(stateOf(scan(drop)).state, 'rejected');
  });

  it('a file exactly at the size cap is read (and rejected as not-json), one byte over is oversize', () => {
    const d1 = tmp(); planted(d1, NAME, 'x'.repeat(MAX_EXPORT_BYTES));
    assert.equal(stateOf(scan(d1)).latestRejected.reason, 'not-json');
    const d2 = tmp(); planted(d2, NAME, 'x'.repeat(MAX_EXPORT_BYTES + 1));
    assert.equal(stateOf(scan(d2)).latestRejected.reason, 'oversize');
  });

  it('an oversize file is refused WITHOUT being parsed', () => {
    const drop = tmp(); planted(drop, NAME, `{"x":"${'a'.repeat(MAX_EXPORT_BYTES + 10)}"}`);
    assert.equal(stateOf(scan(drop)).latestRejected.reason, 'oversize');
  });

  it('a non-regular file with an export-shaped name (a directory) is refused without being opened', () => {
    const drop = tmp();
    fs.mkdirSync(path.join(drop, 'acme', NAME), { recursive: true });
    assert.equal(stateOf(scan(drop)).latestRejected.reason, 'not-a-file');
  });

  it('a symlinked export is refused', async (t) => {
    const drop = tmp(); const real = await put(drop, { ageDays: 1 });
    const link = path.join(drop, 'acme', '2026-11-18-1b9c1f3e-6d1a-4b6e-8a53-3f5a2f1c9d77.json');
    if (!trySymlink(t, real, link, 'file')) return;
    assert.equal(stateOf(scan(drop)).latestRejected.reason, 'symlink');
  });

  it('an alias DIRECTORY that is a symlink/junction is not followed: drop-unreadable, scan untrusted, nothing pruned', async (t) => {
    const drop = tmp(); const outside = tmp();
    await put(outside, { ageDays: 1 });   // a valid export OUTSIDE the drop, under <outside>/acme
    if (!trySymlink(t, path.join(outside, 'acme'), path.join(drop, 'acme'), 'junction')) return;
    const r = scan(drop);
    assert.equal(stateOf(r).state, 'drop-unreadable');
    assert.equal(stateOf(r).reason, 'SYMLINK');
    assert.equal(r.scanIncomplete, 'alias-unreadable');
    let calls = 0;
    pruneDrop(r, { unlink: () => { calls++; } });
    assert.equal(calls, 0);
  });

  it("an unreadable alias does not stop another alias's clean empty directory from being a provable never-received", () => {
    const drop = tmp(); fs.writeFileSync(path.join(drop, 'broken'), 'a file where the alias directory should be');
    fs.mkdirSync(path.join(drop, 'empty'));
    const r = scan(drop, [...expected('weekly', 'broken'), ...expected('weekly', 'empty')]);
    assert.equal(stateOf(r, 'broken').state, 'drop-unreadable');
    assert.equal(stateOf(r, 'empty').state, 'never-received');
    assert.equal(r.scanIncomplete, 'alias-unreadable');
  });

  it('a directory that is not an expected exporter is listed as unattributed and never read', async () => {
    const drop = tmp(); await put(drop, { alias: 'stranger', ageDays: 1 });
    const r = scan(drop);
    assert.deepEqual(r.unattributed, [{ dir: 'stranger', reason: 'unexpected-alias' }]);
    assert.equal(stateOf(r).state, 'never-received');
  });

  it('dot-directories (.git) and temp files are not exporters and not rejections', async () => {
    const drop = tmp(); fs.mkdirSync(path.join(drop, '.git')); await put(drop, { ageDays: 1 });
    fs.writeFileSync(path.join(drop, 'acme', '.partial.json.tmp-1-abc'), 'x');
    const r = scan(drop);
    assert.deepEqual(r.unattributed, []);
    assert.equal(stateOf(r).rejectedCount, 0);
  });
});

describe('retention is explicit and never acts on a scan it does not trust', () => {
  it('prune keeps the newest KEEP_VALID valid exports and removes the rest', async () => {
    const drop = tmp();
    for (let i = 0; i < KEEP_VALID + 3; i++) await put(drop, { ageDays: i + 1 });
    const before = scan(drop);
    assert.equal(stateOf(before).validCount, KEEP_VALID + 3);
    const { removed } = pruneDrop(before);
    assert.equal(removed, 3);
    const after = scan(drop);
    assert.equal(stateOf(after).validCount, KEEP_VALID);
    assert.equal(stateOf(after).ageDays, 1, 'the newest survived');
  });

  it('failed deletions are REPORTED, not swallowed into a success count', async () => {
    const drop = tmp();
    for (let i = 0; i < KEEP_VALID + 2; i++) await put(drop, { ageDays: i + 1 });
    const r = pruneDrop(scan(drop), { unlink: () => { throw Object.assign(new Error('x'), { code: 'EACCES' }); } });
    assert.deepEqual(r, { removed: 0, failed: 2, skipped: false });
  });

  it('an untrusted scan is reported as skipped, not as zero removed', async () => {
    const drop = tmp(); await put(drop, { ageDays: 1 });
    assert.equal(pruneDrop({ ...scan(drop), scanIncomplete: 'total-bytes' }).skipped, true);
  });

  it('CONTROL — nothing is removed on an unreadable or incomplete scan', async () => {
    const drop = tmp(); await put(drop, { ageDays: 1 });
    let calls = 0;
    pruneDrop({ ...scan(drop), scanError: 'EACCES' }, { unlink: () => { calls++; } });
    pruneDrop({ ...scan(drop), scanIncomplete: 'total-bytes' }, { unlink: () => { calls++; } });
    assert.equal(calls, 0);
  });
});

describe('the registry declares who is expected', () => {
  it('only consumers with a telemetry block are expected', () => {
    assert.deepEqual(expectedExporters([{ name: 'a' }, { name: 'b', telemetry: { alias: 'work', cadence: 'weekly' } }]), [{ alias: 'work', cadence: 'weekly' }]);
    assert.deepEqual(expectedExporters([]), []);
  });
  it('two consumers sharing an export alias is refused (a file could not be attributed)', () => {
    const t = { alias: 'work', cadence: 'weekly' };
    assert.throws(() => expectedExporters([{ name: 'a', telemetry: t }, { name: 'b', telemetry: t }]), /refusing to guess/);
  });
});

describe('the CLI', () => {
  it('with nobody expected, nothing is scanned and nothing is rendered (default off: no change for anyone)', () => {
    assert.equal(scanRegistered({ expected: [], dropDir: tmp() }), null);
  });

  it('with someone expected, the registered wiring scans the drop it is given', async () => {
    const drop = tmp(); await put(drop, { ageDays: 1 });
    const r = scanRegistered({ expected: expected(), dropDir: drop, now: NOW });
    assert.equal(r.aliases[0].state, 'received');
  });
  it('--selfcheck-relocation and an unknown flag', () => {
    const run = (a) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'telemetry-exports.mjs'), ...a], { cwd: ROOT, encoding: 'utf-8', timeout: 60000, windowsHide: true });
    assert.equal(run(['--selfcheck-relocation']).stdout.trim().split('\n').pop(), 'OK');
    assert.equal(run(['--bogus']).status, 2);
  });
});

/**
 * @fileoverview Debt 3b96a5ef7971 — the census that closes the mutation list.
 *
 * Containment is only as good as the LIST of writes that go through it. The
 * parent had nine consumer writes/unlinks that did not (journal, manifest,
 * sidecar, watermark, receipt, the two managed blocks, the journal unlink) and
 * nothing that would have noticed a tenth. This scans the sync's own source for
 * every filesystem mutation call and requires each one to be either absent or a
 * NAMED, reasoned exception with a count that cannot silently grow.
 *
 * Detection is a scan of source (comments skipped), the one level at which an
 * unrouted write can be seen; the behaviour of the seam itself is proven in
 * tests/sync-consumer-io.test.mjs and the e2e suite.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MUTATION = /\b(atomicWriteFileSync|writeFileSync|appendFileSync|unlinkSync|rmSync|renameSync|copyFileSync|mkdirSync|rmdirSync)\s*\(/;

/** Lines of `src` that call a filesystem mutation, comments excluded. */
export function mutationSites(src) {
  const out = [];
  src.split(/\r?\n/).forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
    if (MUTATION.test(line)) out.push({ line: i + 1, text: line.trim().slice(0, 120) });
  });
  return out;
}

/** Files allowed to mutate the filesystem, with the reason and the exact number of sites. */
const EXCEPTIONS = {
  'scripts/lib/sync-manifest.mjs': {
    sites: 2,
    reason: 'writeManifest writes the SOURCE repo\'s own manifest; patchManifestWithExtraHashes writes the path the CLI got back from writeConsumerFile (already contained) for the consumer manifest',
  },
  'scripts/lib/sync-legacy-copilot-block.mjs': {
    sites: 2,
    reason: 'edits one tracked consumer file after an lstat + realpath containment check of its own (refuses a symlinked file or directory; R2 H3/M6, R3 H4) — an equivalent verified contract, covered by sync-legacy-copilot-block.test.mjs',
  },
  'scripts/lib/sync-pr.mjs': {
    sites: 2,
    reason: 'sync:pr writes its run log inside the SOURCE repo, never a consumer',
  },
};

const syncFiles = () => [
  'scripts/sync-to-repos.mjs',
  ...fs.readdirSync(path.join(ROOT, 'scripts/lib')).filter((f) => /^sync-.*\.mjs$/.test(f)).map((f) => `scripts/lib/${f}`),
];

describe('every consumer mutation goes through the one contained seam', () => {
  it('no sync file mutates the filesystem outside the seam, except the named exceptions', () => {
    const files = syncFiles();
    assert.ok(files.length > 10 && files.includes('scripts/lib/sync-consumer-io.mjs'), 'vacuous-pass guard: the scan covers the sync modules');
    const stray = [];
    for (const rel of files) {
      const sites = mutationSites(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
      const allowed = EXCEPTIONS[rel]?.sites ?? 0;
      if (sites.length !== allowed) stray.push(`${rel}: ${sites.length} mutation call(s), ${allowed} allowed — ${sites.map((s) => `L${s.line} ${s.text}`).join(' | ')}`);
    }
    assert.deepEqual(stray, [], 'a consumer write bypassing writeConsumerFile/removeConsumerFile (lib/sync-consumer-io.mjs) — route it through the seam, or add a NAMED exception with its reason');
  });

  it('every exception names a reason, and the file really has that many sites (an exception cannot go stale)', () => {
    for (const [rel, { sites, reason }] of Object.entries(EXCEPTIONS)) {
      assert.ok(reason.length > 40, `${rel}: the exception must say why`);
      assert.equal(mutationSites(fs.readFileSync(path.join(ROOT, rel), 'utf8')).length, sites, `${rel}: stale exception count`);
    }
  });

  it('the seam itself declares its mutations as injected seams, not direct calls', () => {
    assert.deepEqual(mutationSites(fs.readFileSync(path.join(ROOT, 'scripts/lib/sync-consumer-io.mjs'), 'utf8')), []);
  });

  it('RED on the parent: the same scan finds the nine unrouted consumer writes in the pre-change CLI', (t) => {
    const r = spawnSync('git', ['show', 'origin/main:scripts/sync-to-repos.mjs'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 });
    if (r.error) throw r.error;
    if (r.status !== 0) {
      if (/bad object|unknown revision|invalid object name|not a valid object|bad revision|ambiguous argument/i.test(r.stderr)) return t.skip('origin/main not available');
      assert.fail(`git show failed: ${r.stderr}`);
    }
    // After this change merges origin/main IS the fixed tree, so this evidence only reads the base while it still differs.
    const sites = mutationSites(r.stdout);
    if (sites.length === 0) return t.skip('origin/main already carries the fix; the evidence applied to the pre-change base');
    assert.ok(sites.length >= 8, `the pre-change CLI had ${sites.length} mutation sites`);
  });

  it('negative control: a planted bare write IS detected', () => {
    assert.equal(mutationSites("fs.writeFileSync(path.join(repo.path, 'x'), 'y');\n// fs.writeFileSync(a, b);\n").length, 1);
  });
});

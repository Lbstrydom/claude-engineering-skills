/**
 * @fileoverview A read-only, VIRTUAL filesystem over one git revision, so the
 * step-back pack reads repo content as it was at a checkpoint's `audited_sha`
 * (`git show <sha>:<path>` semantics) and never from the current tree or a
 * checkout. It implements only the two calls `buildStepBackPack` makes through
 * its injectable `fsImpl` (`realpathSync`, `readFileSync`), so the egress gate
 * (`resolveAndClassify`) still runs on every path.
 *
 * Fail closed: a path git cannot find, or a SYMLINK entry (mode 120000), throws
 * from `realpathSync`, which the classifier reports as `resolution-failed` — the
 * file is excluded and counted, never followed. A revision git cannot read at
 * all is reported by `createRevisionFs` as `{ok: false}`.
 *
 * Domain: audit-orchestration.
 *
 * @module scripts/lib/audit/step-back-gitfs
 */
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { classifyPath } from '../sensitive-paths.mjs';
import { isImportScannable } from './step-back.mjs';

const VIRTUAL_ROOT = path.resolve('/__revision__');

/** Parse `git ls-tree -r -z` output into [{mode, oid, path}]. */
export function parseLsTree(out) {
  return String(out).split('\0').filter(Boolean).map((rec) => {
    const tab = rec.indexOf('\t');
    const [mode, , oid] = rec.slice(0, tab).split(' ');
    return { mode, oid, path: rec.slice(tab + 1) };
  });
}

/** Default git runner for a repo cwd: `(args) => {status, stdout}`. */
export function gitRunner(cwd = process.cwd()) {
  return (args) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true }); return { status: r.status ?? -1, stdout: r.stdout || '' }; };
}

/** Default batch blob reader: one `git cat-file --batch` for many oids. Returns Map(oid -> utf8 text). */
export function gitBatchReader(cwd = process.cwd()) {
  return (oids) => {
    const r = spawnSync('git', ['cat-file', '--batch'], { cwd, input: `${oids.join('\n')}\n`, maxBuffer: 1024 * 1024 * 1024, windowsHide: true });
    const out = new Map(); const buf = r.stdout || Buffer.alloc(0);
    let pos = 0;
    while (pos < buf.length) {
      const nl = buf.indexOf(10, pos); if (nl < 0) break;
      const [oid, type, size] = buf.slice(pos, nl).toString('utf8').split(' ');
      if (type === 'missing' || size === undefined) { pos = nl + 1; continue; }
      const n = Number(size);
      out.set(oid, buf.slice(nl + 1, nl + 1 + n).toString('utf8'));
      pos = nl + 1 + n + 1;
    }
    return out;
  };
}

/**
 * @param {{sha: string, git?: Function, readBatch?: (oids: string[]) => Map<string, string>, cwd?: string}} a
 * @returns {{ok: true, fs: object, root: string, repoFiles: string[], stats: {files: number, prefetched: number}}|{ok: false, reason: string}}
 */
export function createRevisionFs({ sha, git = gitRunner(), readBatch = gitBatchReader() }) {
  if (!/^[0-9a-f]{7,64}$/i.test(String(sha || ''))) return { ok: false, reason: 'audited_sha is not a commit id' };
  const ls = git(['ls-tree', '-r', '-z', sha]);
  if (ls.status !== 0) return { ok: false, reason: `git cannot read revision ${String(sha).slice(0, 8)}` };
  const entries = parseLsTree(ls.stdout);
  const byPath = new Map(entries.map((e) => [e.path, e]));
  // Prefetch code files for the importer scan; sensitive paths are never read here.
  const want = entries.filter((e) => e.mode !== '120000' && isImportScannable(e.path) && classifyPath(e.path) !== 'sensitive');
  const blobs = want.length ? readBatch(want.map((e) => e.oid)) : new Map();
  const rel = (abs) => path.relative(VIRTUAL_ROOT, abs).split(path.sep).join('/');
  const fsView = {
    realpathSync(abs) {
      const e = byPath.get(rel(abs));
      if (!e) throw Object.assign(new Error('ENOENT: not in revision'), { code: 'ENOENT' });
      if (e.mode === '120000') throw Object.assign(new Error('ELOOP: symlink entry refused'), { code: 'ELOOP' });
      return abs;
    },
    readFileSync(abs) {
      const e = byPath.get(rel(abs));
      if (!e) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      if (blobs.has(e.oid)) return blobs.get(e.oid);
      const r = git(['show', `${sha}:${e.path}`]);
      if (r.status !== 0) throw Object.assign(new Error('git show failed'), { code: 'EIO' });
      return r.stdout;
    },
  };
  return { ok: true, fs: fsView, root: VIRTUAL_ROOT, repoFiles: entries.map((e) => e.path), stats: { files: entries.length, prefetched: blobs.size } };
}

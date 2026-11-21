/**
 * @fileoverview The ONE verified reader for arch-memory source files — shared
 * by the Python stage (`python-extract.mjs`) and the ts-morph path
 * (`extract.mjs::loadAndParseFile`). Plan: docs/plans/python-arch-memory-indexing.md §2.6.
 *
 * `admitFile` classifies a path, then something opens it later; a swap of a
 * path component in between would send a file that was never classified to the
 * embedding provider. Open-then-verify narrows that window on every platform:
 * open, `fstat` the descriptor, RE-RUN the full admission gate (`readmit`), and
 * require the inode now at the re-admitted canonical path to BE the descriptor's
 * (dev+ino). Linux additionally binds to `/proc/self/fd` (authoritative).
 * RESIDUAL (Windows/macOS, no fd-path API): a swap held across the open and
 * both stats but released only during the re-admission itself. It must be
 * flipped twice inside the window; it is narrowed, not closed.
 *
 * @module scripts/lib/symbol-index/admitted-read
 */

import fs from 'node:fs';

/** Terminal outcomes of a verified read (python-extract's OUTCOME spreads these). */
export const READ_OUTCOME = Object.freeze({
  IDENTITY_CHANGED: 'identity-changed',
  SIZE_CAP: 'size-cap',
  READ_ERROR: 'read-error',
});

const OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0);

/**
 * The opened descriptor's real path, where the OS exposes one (Linux
 * `/proc/self/fd`); `null` when it cannot be asked — never a guess.
 */
function descriptorPath(fd) {
  if (process.platform !== 'linux') return null;
  try { return fs.realpathSync(`/proc/self/fd/${fd}`); } catch { return null; }
}

/**
 * Read an ADMITTED file, bound to an admission decision made AFTER the open.
 * The read is bounded (`maxBytes + 1`, buffer sized to the file); a post-read
 * `fstat` must show the same size, mtime and ctime (a rewrite that restores mtime still bumps ctime), and the path must still name the
 * same inode (a swap after the read is refused, nothing returned).
 *
 * @param {{canonicalPath: string}} admission - from extract.mjs `admitFile`
 * @param {{maxBytes: number, readmit: () => {admitted: boolean, canonicalPath?: string},
 *          beforeOpen?: () => void, afterOpen?: () => void, afterRead?: () => void}} opts - the hooks are test seams
 * @returns {{ok: true, bytes: Buffer} | {ok: false, outcome: string, detail: string}}
 */
export function readAdmittedSource(admission, { maxBytes, readmit, beforeOpen, afterOpen, afterRead } = {}) {
  if (typeof readmit !== 'function') throw new Error('readAdmittedSource: readmit is required (open-then-verify)');
  const canonical = admission.canonicalPath;
  const refuse = (detail) => ({ ok: false, outcome: READ_OUTCOME.IDENTITY_CHANGED, detail });
  let fd = null;
  try {
    if (typeof beforeOpen === 'function') beforeOpen();
    // O_NONBLOCK where it exists: a path swapped to a FIFO with no writer must
    // not hang the open (regular files ignore the flag). Windows has no FIFOs here.
    fd = fs.openSync(canonical, OPEN_FLAGS);
    const st1 = fs.fstatSync(fd, { bigint: true });
    if (!st1.isFile()) return refuse('opened path is not a regular file');
    if (typeof afterOpen === 'function') afterOpen();
    const same = (st) => st.dev === st1.dev && st.ino === st1.ino;
    // The descriptor's OWN path, where the OS exposes it, is authoritative: no
    // later path lookup can be swapped under it.
    const fdPath = descriptorPath(fd);
    if (fdPath !== null && fdPath !== canonical) return refuse('opened file is not at the admitted canonical path');
    // Elsewhere, sandwich the re-admission between two identity checks: a swap
    // must hold the sensitive target for the open, release it for the
    // re-admission, and hold it again for both stats.
    if (!same(fs.statSync(canonical, { bigint: true }))) return refuse('opened file is not the file at the admitted path');
    const again = readmit();
    if (!again?.admitted || again.canonicalPath !== canonical) return refuse('path no longer admitted at its canonical location');
    if (!same(fs.statSync(canonical, { bigint: true }))) return refuse('opened file is not the file at the admitted path');
    if (st1.size > BigInt(maxBytes)) return { ok: false, outcome: READ_OUTCOME.SIZE_CAP, detail: `size ${st1.size} > ${maxBytes}` };
    // Sized to the file (+1 to detect growth), never maxBytes: a retained subarray
    // of a maxBytes buffer per small file is what made memory scale with the cap.
    const buf = Buffer.alloc(Number(st1.size) + 1);
    let total = 0;
    while (total < buf.length) {
      const n = fs.readSync(fd, buf, total, buf.length - total, total);
      if (n === 0) break;
      total += n;
    }
    if (total > maxBytes) return { ok: false, outcome: READ_OUTCOME.SIZE_CAP, detail: 'file grew past the cap during read' };
    if (typeof afterRead === 'function') afterRead();
    const st2 = fs.fstatSync(fd, { bigint: true });
    if (st2.size !== st1.size || st2.mtimeNs !== st1.mtimeNs || st2.ctimeNs !== st1.ctimeNs || BigInt(total) !== st1.size) return refuse('file changed during read');
    // The path must STILL name the inode we read: a swap after the read (or one
    // that outlived the re-admission) is refused and the bytes are dropped.
    if (!same(fs.statSync(canonical, { bigint: true }))) return refuse('path no longer names the file that was read');
    return { ok: true, bytes: buf.subarray(0, total) };
  } catch (err) {
    return { ok: false, outcome: READ_OUTCOME.READ_ERROR, detail: err.code || err.message };
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* already closed */ } }
  }
}

/**
 * @fileoverview The one `write(dir, rel, body)` fixture helper: create `rel` under `dir` (parents included) with `body`.
 * Was declared separately in six test files (arch:duplicates, cluster C of the 2026-10-25 triage).
 * @module tests/helpers/write-file
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {string} dir
 * @param {string} rel path under `dir`
 * @param {string|Buffer} body
 * @returns {string} the absolute path written
 */
export function writeFileIn(dir, rel, body) {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}

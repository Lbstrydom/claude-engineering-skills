/**
 * @fileoverview `upstream report --export` — render a consumer's upstream report as
 * sanitized Markdown the operator pastes into a PUBLIC GitHub issue by hand, and
 * record the export locally. Nothing here sends anything anywhere.
 *
 * Two representations, on purpose: the report filed into the consumer's own store
 * keeps the operator's original (gently redacted) text and never leaves the
 * organisation; the EXPORT is a separate rendering with the consumer's identity
 * strings replaced by a slug. The export is screened (`scanForLeaks`, prose mode) on
 * its FINAL bytes, fail-closed: a hit refuses and nothing is written or filed.
 * The scan is a screening aid for known shapes, never proof, which is why the CLI
 * warns the operator to read the file before pasting.
 *
 * Order (each step idempotent; a retry completes the rest):
 *   validate -> gentle redact -> render + substitute -> scan -> write .md -> create
 *   own record (.json, exclusive) -> file the report -> update ONLY its own record.
 *
 * Docs: docs/plans/policy-private-consumer-stores.md §2.4.
 *
 * @module scripts/lib/upstream/export
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { atomicWriteFileSync } from '../file-io.mjs';
import { canonicaliseRemoteUrl, resolveRepoIdentity } from '../repo-identity.mjs';
import { scanForLeaks } from '../telemetry-export/redact.mjs';
import { destRelToSourceRel } from '../sync-path-map.mjs';
import {
  computeFingerprint, readBundleStamp, redactReport, validateAffectedPath,
  validateReportInput,
} from './commands.mjs';

export const EXPORT_DIR = path.join('.audit', 'upstream-exports');
export const EXPORT_RECORD_SCHEMA = 'upstream-export/v1';
export const SLUG_RE = /^[a-z0-9-]{1,32}$/;
/** An identity this short cannot be substituted without mangling ordinary words. */
export const MIN_IDENTITY_LEN = 4;
export const PUBLIC_WARNING =
  'CES is a PUBLIC repository: whatever you paste there is public. Read the file before you paste it.';

const ID_CHARS = '-A-Za-z0-9_';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Raised when the consumer's identity cannot be established; the export refuses rather than guess. */
export class IdentityUndeterminableError extends Error {
  constructor(reason) {
    super(`the repository's identity could not be determined (${reason}); nothing was written or filed`);
    this.code = 'identity-undeterminable';
  }
}

/**
 * The consumer's own identity strings with their CLASS (owner | repo | package), most
 * specific first: the remote's full namespace path, every consecutive `a/b` pair, every
 * namespace component (a gitlab group and subgroup are owners), the checkout basename and
 * the `package.json` name. An ABSENT remote or package.json is fine; any other failure
 * (git error other than "no such key", malformed package.json) throws
 * IdentityUndeterminableError.
 *
 * @param {string} repoRoot
 * @returns {{value: string, kind: 'owner'|'repo'|'package'}[]} de-duplicated (case-insensitive)
 */
export function identityEntries(repoRoot) {
  const out = [];
  const add = (v, kind) => {
    const s = String(v ?? '').trim();
    if (s && !out.some((o) => o.value.toLowerCase() === s.toLowerCase())) out.push({ value: s, kind });
  };
  const g = spawnSync('git', ['config', '--get', 'remote.origin.url'], { cwd: repoRoot, encoding: 'utf-8' });
  if (g.error) throw new IdentityUndeterminableError('git could not be run');
  const url = (g.stdout || '').trim();
  if (g.status === 0 && url) {
    const canon = canonicaliseRemoteUrl(url);
    const all = canon ? canon.split('/').filter(Boolean) : [];
    const comps = all.length >= 2 ? all.slice(1) : all; // drop the host; it is public
    if (comps.length === 0) throw new IdentityUndeterminableError('the remote url has no path');
    add(comps.join('/'), 'repo');
    for (let i = 0; i + 1 < comps.length; i += 1) add(`${comps[i]}/${comps[i + 1]}`, 'repo');
    comps.forEach((c, i) => add(c, i === comps.length - 1 ? 'repo' : 'owner'));
  } else if (g.status !== 1) {
    // 1 = the key is absent (no remote): fine. Anything else is a git failure.
    throw new IdentityUndeterminableError('git config failed');
  }
  add(path.basename(path.resolve(repoRoot)), 'repo');
  let raw = null;
  try {
    raw = fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf-8');
  } catch (err) {
    if (err?.code !== 'ENOENT') throw new IdentityUndeterminableError('package.json is unreadable');
  }
  if (raw !== null) {
    let pkg;
    try { pkg = JSON.parse(raw); } catch { throw new IdentityUndeterminableError('package.json is malformed'); }
    if (!pkg || typeof pkg !== 'object') throw new IdentityUndeterminableError('package.json is malformed');
    if (typeof pkg.name === 'string') {
      const [scope, rest] = pkg.name.startsWith('@') ? pkg.name.slice(1).split('/') : [null, pkg.name];
      if (scope) add(scope, 'owner');
      add(rest, 'package');
    }
  }
  return out.sort((a, b) => (b.value.includes('/') - a.value.includes('/')) || (b.value.length - a.value.length));
}

/** The string form of {@link identityEntries}. */
export function identityStrings(repoRoot) {
  return identityEntries(repoRoot).map((e) => e.value);
}

const norm = (ids) => ids.map((i) => (typeof i === 'string' ? { value: i, kind: 'repo' } : i));

/** Token-bounded, case-insensitive literal. A sentence-final `.` still counts as a boundary. */
function boundedRe(identity) {
  return new RegExp(`(?<![${ID_CHARS}.])${escapeRe(identity)}(?![${ID_CHARS}]|\\.[${ID_CHARS}])`, 'gi');
}

/** A short identity (1-3 chars) bounded by start/end, whitespace, punctuation, `-` or `_`: not by a letter or digit. */
function shortRe(identity) {
  return new RegExp(`(?<![A-Za-z0-9])${escapeRe(identity)}(?![A-Za-z0-9])`, 'i');
}

/**
 * Replace each identity with `slug`, literally and only as a whole token.
 * (Embedded occurrences are NOT touched here; {@link findEmbeddedIdentity} refuses them.)
 *
 * @param {string} text
 * @param {(string|{value: string})[]} identities
 * @param {string} slug
 * @returns {{ok: true, text: string, replaced: number}
 *   | {ok: false, code: 'identity-too-short', length: number}}
 */
export function substituteIdentity(text, identities, slug) {
  const ids = norm(identities).map((i) => i.value);
  let out = String(text ?? '');
  for (const id of ids) {
    if (id.length < MIN_IDENTITY_LEN) {
      // Cannot be substituted safely. Refuse only when it actually appears as a token,
      // so a 3-char name that the body never mentions does not block every export.
      if (shortRe(id).test(out)) return { ok: false, code: 'identity-too-short', length: id.length };
    }
  }
  let replaced = 0;
  for (const id of ids) {
    if (id.length < MIN_IDENTITY_LEN) continue;
    out = out.replace(boundedRe(id), () => { replaced += 1; return slug; });
  }
  return { ok: true, text: out, replaced };
}

/**
 * After substitution: does any identity (4+ chars) still occur as a case-insensitive
 * substring, i.e. embedded in a larger token (`orgxtools`, `lib/orgx-helpers.mjs`)?
 * Returns the CLASS only, never the string. Identities under 4 chars are caught only when
 * bounded by a non-alphanumeric (substring-matching them would refuse ordinary words).
 *
 * @returns {'owner'|'repo'|'package'|null}
 */
export function findEmbeddedIdentity(text, identities) {
  const hay = String(text ?? '').toLowerCase();
  for (const { value, kind } of norm(identities)) {
    if (value.length >= MIN_IDENTITY_LEN ? hay.includes(value.toLowerCase()) : shortRe(value).test(hay)) return kind;
  }
  return null;
}

/**
 * The public-issue rendering. Carries nothing about the consumer's store, hosts or
 * local paths: title, severity, the affected UPSTREAM path, the short bundle sha, body.
 */
export function renderExportMarkdown({ title, body, severity, affectedPath, bundleSha, slug }) {
  const heading = String(title ?? '').replace(/\s+/g, ' ').trim();
  const sha = bundleSha ? String(bundleSha).slice(0, 7) : 'unknown';
  return [
    `# ${heading}`,
    '',
    `- **Severity:** ${severity}`,
    `- **Affected upstream path:** \`${affectedPath}\``,
    `- **Bundle:** \`${sha}\``,
    `- **Reported from:** ${slug}`,
    '',
    String(body ?? '').trim(),
    '',
  ].join('\n');
}

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const posix = (p) => p.split(path.sep).join('/');

const realIo = {
  mkdirSync: (d) => fs.mkdirSync(d, { recursive: true }),
  existsSync: (p) => fs.existsSync(p),
  readFileSync: (p) => fs.readFileSync(p, 'utf-8'),
  writeAtomic: (p, data) => atomicWriteFileSync(p, data),
  writeExclusive: (p, data) => atomicWriteFileSync(p, data, { exclusive: true }),
};

/**
 * @param {object} p
 * @param {string} p.repoRoot
 * @param {string|null} [p.repoUuid]
 * @param {string} p.title
 * @param {string} p.body
 * @param {string} [p.severity]
 * @param {string} p.affectedPath
 * @param {string} p.slug
 * @param {(args: object) => Promise<object>} p.fileFn files the report (the existing upstreamReport path)
 * @param {string|null} [p.storeFingerprint] the destination store's fingerprint now (null: cloud off)
 * @param {string[]} [p.identities] test seam; default `identityStrings(repoRoot)`
 * @param {() => Date} [p.now]
 * @param {typeof realIo} [p.io]
 * @returns {Promise<{ok: true, exportPath: string, recordPath: string, sha256: string, fingerprint: string, filing: object}
 *   | {ok: false, step: string, code: string, errors: string[], categories?: string[], exists: object}>}
 */
export async function exportReport({
  repoRoot, repoUuid = null, title, body, severity = 'MEDIUM', affectedPath, slug,
  fileFn, identities, storeFingerprint = null, now = () => new Date(), io = realIo,
}) {
  const exists = { exportPath: null, record: false, filed: false };
  const fail = (step, code, errors, extra = {}) => ({ ok: false, step, code, errors, exists, ...extra });

  if (!SLUG_RE.test(String(slug ?? ''))) {
    return fail('validate', 'BAD_INPUT', ['--slug must match [a-z0-9-]{1,32}']);
  }
  let identityList;
  try {
    identityList = norm(identities ?? identityEntries(repoRoot));
  } catch (err) {
    return fail('identity', err.code || 'identity-undeterminable', [err.message]);
  }
  if (identityList.some((i) => slug.includes(i.value.toLowerCase()))) {
    return fail('validate', 'BAD_INPUT', ['--slug must not contain any of this repository\'s own identity strings']);
  }

  // 1. validate + gentle redact
  const errs = validateReportInput({ title, body, severity, affectedPath });
  if (errs.length) return fail('validate', 'BAD_INPUT', errs);
  const manifest = readBundleStamp(repoRoot);
  const { normalised, recognised } = validateAffectedPath(affectedPath, manifest);
  const red = redactReport({
    title: String(title).trim(), body: String(body), affectedPath: normalised,
  });
  const fingerprint = computeFingerprint({
    repoUuid, title: red.title, affectedPath: red.affectedPath,
    reportedBundleSha: manifest?.commitSha ?? null, body: red.body,
  });

  // 2. substitute in title and body ONLY (the affected path is an upstream-relative path,
  // rendered verbatim), refuse an identity embedded in a larger token, then render.
  const subTitle = substituteIdentity(String(red.title).replace(/\s+/g, ' ').trim(), identityList, slug);
  const subBody = substituteIdentity(red.body, identityList, slug);
  const short = [subTitle, subBody].find((r) => !r.ok);
  if (short) {
    return fail('render', 'identity-too-short', [
      `an identity string of ${short.length} characters appears in the report and cannot be replaced safely; `
      + 'edit the report to remove it and run again',
    ]);
  }
  const embedded = findEmbeddedIdentity(`${subTitle.text}\n${subBody.text}`, identityList);
  if (embedded) {
    return fail('render', 'identity-embedded', [
      `a ${embedded} name of this repository occurs inside a larger word or path in the report and cannot be `
      + 'replaced safely; edit the report to remove it and run again. Nothing was written or filed',
    ], { identityClass: embedded });
  }
  // The affected path is exempt only when the bundle manifest recognises it as an upstream
  // file (it is then already public in this repository); otherwise it is consumer text.
  const pathEmbedded = recognised === true ? null : findEmbeddedIdentity(red.affectedPath, identityList);
  if (pathEmbedded) {
    return fail('render', 'identity-embedded', [
      `a ${pathEmbedded} name of this repository occurs in --affected-path, which is not a recognised upstream file; `
      + 'give the upstream path (see the bundle manifest) and run again. Nothing was written or filed',
    ], { identityClass: pathEmbedded });
  }
  const sub = {
    text: renderExportMarkdown({
      // A recognised path is normalised to its consumer destination; the public issue names the UPSTREAM file (final gate G1).
      title: subTitle.text, body: subBody.text, severity, affectedPath: recognised === true ? destRelToSourceRel(red.affectedPath) : red.affectedPath,
      bundleSha: manifest?.commitSha ?? null, slug,
    }),
  };

  // 3. fail-closed scan of the FINAL bytes
  const scan = scanForLeaks(sub.text, { prose: true });
  if (!scan.clean) {
    return fail('scan', 'EXPORT_REFUSED', [
      `the export matched ${scan.categories.join(', ')}; nothing was written or filed. `
      + 'Edit the report to remove those details and run again',
    ], { categories: scan.categories });
  }

  // 4. write the Markdown (immutable per content)
  const digest = sha256(sub.text);
  const stem = `${fingerprint}-${digest.slice(0, 16)}`;
  const dir = path.join(repoRoot, EXPORT_DIR);
  const mdPath = path.join(dir, `${stem}.md`);
  const recPath = path.join(dir, `${stem}.json`);
  const relMd = posix(path.join(EXPORT_DIR, `${stem}.md`));
  try {
    io.mkdirSync(dir);
    // Exclusive: an existing file with identical bytes is reused; different bytes are
    // NEVER overwritten (the file was edited after it was exported).
    try {
      io.writeExclusive(mdPath, sub.text);
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      if (io.readFileSync(mdPath) !== sub.text) {
        exists.exportPath = relMd;
        return fail('write', 'export-file-modified', [
          `${relMd} already exists with different content and was not overwritten; inspect or move it, then run again`,
        ]);
      }
    }
    exists.exportPath = relMd;
  } catch (err) {
    return fail('write', 'EXPORT_WRITE_FAILED', [err.message]);
  }

  // 5. record, created exclusively; a retry of the same content finds and reuses it
  let record;
  try {
    record = {
      schema: EXPORT_RECORD_SCHEMA, exportedAt: now().toISOString(), slug, fingerprint,
      sha256: digest, path: relMd, filed: null,
    };
    try {
      io.writeExclusive(recPath, `${JSON.stringify(record, null, 2)}\n`);
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      const prior = JSON.parse(io.readFileSync(recPath));
      if (prior?.sha256 !== digest) throw new Error('an export record exists whose hash does not match its file name');
      record = prior;
    }
    exists.record = true;
  } catch (err) {
    return fail('record', 'EXPORT_RECORD_FAILED', [err.message]);
  }

  // 6. file the report the usual way (fingerprint upsert), then update our own record only.
  // A record that says filed AGAINST THE SAME STORE is the answer: do not file again. A
  // different store (or a record from before stores were recorded) files again; the upsert is idempotent.
  if (record.filed && typeof record.filed === 'object' && (record.filed.store ?? null) === storeFingerprint
    && Object.hasOwn(record.filed, 'store')) {
    exists.filed = true;
    return {
      ok: true, exportPath: relMd, recordPath: posix(path.join(EXPORT_DIR, `${stem}.json`)),
      sha256: digest, fingerprint, filing: { ok: true, ...record.filed, fingerprint, alreadyFiled: true },
    };
  }
  let filing;
  try {
    filing = await fileFn({ title: String(title).trim(), body: String(body), severity, affectedPath });
  } catch (err) {
    return fail('file', 'EXPORT_FILE_FAILED', [err.message]);
  }
  if (!filing?.ok) {
    return fail('file', filing?.code || 'EXPORT_FILE_FAILED', filing?.errors ?? ['filing the report failed']);
  }
  try {
    record = {
      ...record,
      filed: {
        cloud: Boolean(filing.cloud), id: filing.id ?? null, spooled: Boolean(filing.spooled),
        store: filing.cloud ? storeFingerprint : null,
      },
    };
    io.writeAtomic(recPath, `${JSON.stringify(record, null, 2)}\n`);
    exists.filed = true;
  } catch (err) {
    return fail('update-record', 'EXPORT_RECORD_FAILED', [err.message]);
  }

  return {
    ok: true, exportPath: relMd, recordPath: posix(path.join(EXPORT_DIR, `${stem}.json`)),
    sha256: digest, fingerprint, filing,
  };
}


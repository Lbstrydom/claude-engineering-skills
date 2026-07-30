#!/usr/bin/env node
/**
 * @fileoverview Build the skills manifest for the installer.
 *
 * **Manifest v2** (Phase B.2): populates `files[]` per skill — every file
 * enumerated by `scripts/lib/skill-packaging.mjs`'s allowlist gets its own
 * SHA entry. Installers that understand v2 write all the files; old
 * installers see `schemaVersion: 2` and exit with
 * `UNSUPPORTED_MANIFEST_VERSION` before any install happens.
 *
 * **G5 fix** (from Gemini final-gate review): description extraction now
 * uses a proper YAML frontmatter parse path instead of the fragile regex
 * that required a newline after `description:`.
 *
 * Usage:
 *   node scripts/build-manifest.mjs           # rebuild manifest
 *   node scripts/build-manifest.mjs --check    # verify manifest is fresh (CI guard)
 *
 * @module scripts/build-manifest
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ManifestSchema } from './lib/schemas-install.mjs';
import { enumerateSkillFiles, listSkillNames } from './lib/skill-packaging.mjs';
import { assertKnownFlags, ArgvError } from './lib/cli-io.mjs';

/**
 * Every flag this CLI accepts. None take a value.
 *
 * `--check` is a SAFE mode over a MUTATING default (the bare invocation
 * rewrites the committed `skills.manifest.json`), so a silently-dropped
 * `--chek` would rewrite the artifact while the operator believed they were
 * only verifying it.
 */
const KNOWN_FLAGS = ['--check'];

const SKILLS_DIR = path.resolve('skills');
const MANIFEST_PATH = path.resolve('skills.manifest.json');
const BOOTSTRAP_TEMPLATE = path.resolve('scripts/lib/bootstrap-template.mjs');
// COPILOT_BLOCK_TEMPLATE ('scripts/lib/install/copilot-block.txt') removed
// 2026-07-30: the file has never existed, so its existsSync branch never fired
// and it contributed nothing to bundleVersion. Its writer (install/merge.mjs)
// was deleted with the install path — nothing emits a copilot-instructions
// block any more. See docs/reference/skill-surface-ownership.md §3.

const MANIFEST_SCHEMA_VERSION = 2;   // Phase B.2: flipped from 1 to 2

const REPO_URL = 'https://github.com/Lbstrydom/claude-engineering-skills';
const RAW_URL_BASE = 'https://raw.githubusercontent.com/Lbstrydom/claude-engineering-skills/main';

/**
 * Canonicalise text content for hashing: CRLF → LF.
 *
 * WHY (found 2026-07-20 by the pre-push sandbox, which computes this manifest
 * in a clean checkout): `.gitattributes` pins `* text=auto eol=lf`, so the
 * COMMITTED bytes are always LF — but an editor or tool can still leave CRLF
 * in the working tree, and git reports those files as CLEAN because it
 * normalises on comparison. Hashing raw working-tree bytes therefore made
 * `bundleVersion` a function of LOCAL LINE ENDINGS, not of committed source.
 *
 * That silently broke the artifact's own contract twice over: the AGENTS.md
 * generated-artifact policy requires a committed artifact to be a pure,
 * byte-identical function of committed source, and the comment below this
 * claimed exactly that. In practice 16 skill reference files carried CRLF
 * locally, so the committed manifest was generated from contaminated input —
 * a fresh clone computes a different `bundleVersion` and reads as STALE.
 * `size` is normalised for the same reason (CRLF inflates it by one byte
 * per line).
 *
 * @param {Buffer} buf
 * @returns {Buffer} LF-normalised content
 */
export function canonicaliseForHash(buf) {
  return Buffer.from(buf.toString('utf-8').replace(/\r\n/g, '\n'), 'utf-8');
}

/**
 * Compute SHA-256 hex of LF-normalised file content. 12-char short form.
 */
function fileSha(filePath) {
  const content = canonicaliseForHash(fs.readFileSync(filePath));
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 12);
}

/**
 * Extract YAML frontmatter from markdown content.
 * Returns the inner body (between --- fences), or null if missing.
 */
function extractFrontmatterBody(content) {
  if (!content.startsWith('---')) return null;
  const endIdx = content.indexOf('\n---', 3);
  if (endIdx === -1) return null;
  return content.slice(3, endIdx).replace(/^\r?\n/, '');
}

/**
 * Extract the `description:` summary from SKILL.md frontmatter — tolerant
 * of inline (`description: "..."`), block-scalar (`description: |\n...`),
 * or plain (`description: ...`) styles. Replaces the G5 regex that only
 * handled block-scalar form.
 *
 * @returns {string|null} one-line summary ≤100 chars, or null if not found
 */
export function extractSkillSummary(content) {
  const fm = extractFrontmatterBody(content);
  if (!fm) return null;

  const lines = fm.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*description\s*:\s*(\|[-+]?\s*)?\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const [, blockMarker, rest] = m;

    // Block-scalar form: `description: |` → first indented line is the summary
    if (blockMarker !== undefined) {
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim() === '') continue;
        const body = lines[j].trim();
        if (body) return body.slice(0, 100);
      }
      return null;
    }

    // Inline form: `description: whatever`
    let value = rest.trim();
    if (!value) continue;
    // Strip surrounding quotes if present
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    return value.slice(0, 100);
  }
  return null;
}

/**
 * Build the skills manifest from the authoritative `skills/` tree.
 */
export function buildManifest() {
  const skills = {};
  const artifactParts = [];

  for (const name of listSkillNames(SKILLS_DIR)) {
    const skillDir = path.join(SKILLS_DIR, name);
    const skillPath = path.join(skillDir, 'SKILL.md');
    if (!fs.existsSync(skillPath)) continue;

    // Use the packaging allowlist — rejects unexpected files, includes
    // references/**/*.md and examples/**/*.md
    const relFiles = enumerateSkillFiles(skillDir, { strict: true });
    const files = relFiles.map(rel => {
      const abs = path.join(skillDir, rel);
      // Normalised, so the manifest is a function of COMMITTED source rather
      // than of whatever line endings this checkout happens to carry.
      const content = canonicaliseForHash(fs.readFileSync(abs));
      return {
        relPath: rel,
        sha: crypto.createHash('sha256').update(content).digest('hex').slice(0, 12),
        size: content.length,
      };
    });

    const skillMdEntry = files.find(f => f.relPath === 'SKILL.md');
    const skillContent = fs.readFileSync(skillPath, 'utf-8');
    const summary = extractSkillSummary(skillContent) ?? name;

    skills[name] = {
      // Back-compat pointer fields — point at SKILL.md specifically
      path: `skills/${name}/SKILL.md`,
      sha: skillMdEntry?.sha ?? '',
      size: skillMdEntry?.size ?? 0,
      summary,
      // v2: full file list (allowlist-enforced)
      files,
    };

    // bundleVersion hash includes every file's SHA, not just SKILL.md
    for (const f of files) {
      artifactParts.push(`skill:${name}:${f.relPath}:${f.sha}`);
    }
  }

  if (fs.existsSync(BOOTSTRAP_TEMPLATE)) {
    artifactParts.push(`bootstrap:${fileSha(BOOTSTRAP_TEMPLATE)}`);
  }
  artifactParts.push(`manifest-schema:${MANIFEST_SCHEMA_VERSION}`);

  const pairs = artifactParts.sort().join('\n');
  const bundleVersion = crypto.createHash('sha256').update(pairs).digest('hex').slice(0, 16);

  // NO volatile fields. `bundleVersion` (a pure content hash of the committed
  // skill sources) answers "did it change"; git answers "when". A wall-clock
  // `updatedAt` used to live here and was the ONLY thing making a from-scratch
  // regeneration non-byte-identical — i.e. the one field that kept this
  // committed-and-freshness-checked artifact in the "messy middle" the
  // generated-artifact policy (AGENTS.md) forbids. No consumer ever read it
  // (install-skills / check-skill-updates read `bundleVersion` only), so it was
  // removed rather than managed.
  const manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    bundleVersion,
    repoUrl: REPO_URL,
    rawUrlBase: RAW_URL_BASE,
    skills,
  };

  ManifestSchema.parse(manifest);
  return manifest;
}

function main() {
  assertKnownFlags(process.argv, KNOWN_FLAGS, { cli: 'build-manifest' });

  const checkMode = process.argv.includes('--check');

  const manifest = buildManifest();

  if (checkMode) {
    if (!fs.existsSync(MANIFEST_PATH)) {
      console.error('FAIL: skills.manifest.json does not exist. Run: node scripts/build-manifest.mjs');
      process.exit(1);
    }
    const existing = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
    if (existing.bundleVersion === manifest.bundleVersion && existing.schemaVersion === manifest.schemaVersion) {
      console.log(`OK: manifest is fresh (schema v${manifest.schemaVersion}, bundle ${manifest.bundleVersion})`);
      process.exit(0);
    }
    console.error(`STALE: manifest bundleVersion mismatch`);
    console.error(`  committed: v${existing.schemaVersion} / ${existing.bundleVersion}`);
    console.error(`  computed:  v${manifest.schemaVersion} / ${manifest.bundleVersion}`);
    console.error(`Run: node scripts/build-manifest.mjs`);
    process.exit(1);
  }

  // Skip-if-identical is now a plain whole-body comparison — with no volatile
  // field a rewrite would be byte-identical anyway, so this is pure UX (report
  // "unchanged" instead of silently re-touching the file), not churn control.
  //
  // Compare the WHOLE body, not just `bundleVersion`. Skipping on a
  // bundleVersion match alone would break the remedy this command IS: a
  // hand-edited manifest (a tampered per-file `sha` with bundleVersion left
  // intact) passes --check AND would survive the rebuild, so
  // `node scripts/build-manifest.mjs` — the thing every error message tells you
  // to run — would no longer fix it. Any difference at all rewrites. An
  // unreadable/corrupt existing file falls through to a rewrite.
  //
  // The comparison is on the EXACT BYTES to be written, not on parsed JSON.
  // Parsed equality would call a file "unchanged" whose content is right but
  // whose FORMATTING is not (re-indented, key-reordered, CRLF, missing trailing
  // newline) — so the canonicaliser would decline to canonicalise, and the
  // committed artifact could sit in a form that a fresh regeneration does not
  // reproduce. That is exactly the byte-identity property this artifact's
  // Category-B status rests on.
  const nextText = JSON.stringify(manifest, null, 2) + '\n';
  const existingText = readManifestTextOrNull();
  if (existingText === nextText) {
    console.log(`skills.manifest.json already fresh: v${manifest.schemaVersion}, bundle ${manifest.bundleVersion} (unchanged)`);
    return;
  }

  fs.writeFileSync(MANIFEST_PATH, nextText);
  const totalFiles = Object.values(manifest.skills).reduce((sum, s) => sum + (s.files?.length ?? 1), 0);
  console.log(`skills.manifest.json updated: v${manifest.schemaVersion}, ${Object.keys(manifest.skills).length} skills, ${totalFiles} files, bundle ${manifest.bundleVersion}`);
}

/**
 * The manifest file's RAW TEXT, or null if absent/unreadable.
 *
 * Deliberately not parsed: the skip-if-unchanged check compares bytes, so a
 * difference ANYWHERE — a per-file sha, a dropped skill, a reordered key, or
 * merely different whitespace — counts and forces a rewrite. Erring toward
 * rewriting is the safe direction; the alternative is a manifest the rebuild
 * command silently refuses to repair. An unreadable file returns null and so
 * always rewrites.
 */
function readManifestTextOrNull() {
  try {
    if (!fs.existsSync(MANIFEST_PATH)) return null;
    return fs.readFileSync(MANIFEST_PATH, 'utf-8');
  } catch { return null; }
}

// Only run when invoked as a script. `main()` used to run unconditionally at
// module scope while tests/skills-artifact-freshness-wiring.test.mjs imports
// `buildManifest`/`canonicaliseForHash` from here — so importing for the
// exports also REGENERATED the manifest, and (after the flag guard landed)
// asserted against the test runner's argv. That was benign only by accident: a
// `node --test` child gets an empty argv.slice(2), so the guard no-ops. Anyone
// forwarding flags into per-file test children would have made the import
// throw. Matches the sibling generate-plans-index.mjs.
const isMain = (() => {
  try {
    const argv1 = (process.argv[1] || '').replace(/\\/g, '/');
    return import.meta.url === `file://${argv1}` || import.meta.url === `file:///${argv1}`;
  } catch { return false; }
})();

if (isMain) {
  try {
    main();
  } catch (err) {
    // A usage mistake is not a crash: print the diagnostic alone, no stack.
    if (err instanceof ArgvError || err?.code === 'ARGV_ERROR') {
      console.error(err.message);
      process.exit(2);
    }
    throw err;
  }
}

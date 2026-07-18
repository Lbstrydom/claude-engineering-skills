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

const SKILLS_DIR = path.resolve('skills');
const MANIFEST_PATH = path.resolve('skills.manifest.json');
const BOOTSTRAP_TEMPLATE = path.resolve('scripts/lib/bootstrap-template.mjs');
const COPILOT_BLOCK_TEMPLATE = path.resolve('scripts/lib/install/copilot-block.txt');

const MANIFEST_SCHEMA_VERSION = 2;   // Phase B.2: flipped from 1 to 2

const REPO_URL = 'https://github.com/Lbstrydom/claude-engineering-skills';
const RAW_URL_BASE = 'https://raw.githubusercontent.com/Lbstrydom/claude-engineering-skills/main';

/**
 * Compute SHA-256 hex of file content. 12-char short form.
 */
function fileSha(filePath) {
  const content = fs.readFileSync(filePath);
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
      const content = fs.readFileSync(abs);
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
  if (fs.existsSync(COPILOT_BLOCK_TEMPLATE)) {
    artifactParts.push(`copilot-block:${fileSha(COPILOT_BLOCK_TEMPLATE)}`);
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
  const existing = readManifestOrNull();
  if (existing && sameManifest(existing, manifest)) {
    console.log(`skills.manifest.json already fresh: v${manifest.schemaVersion}, bundle ${manifest.bundleVersion} (unchanged)`);
    return;
  }

  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
  const totalFiles = Object.values(manifest.skills).reduce((sum, s) => sum + (s.files?.length ?? 1), 0);
  console.log(`skills.manifest.json updated: v${manifest.schemaVersion}, ${Object.keys(manifest.skills).length} skills, ${totalFiles} files, bundle ${manifest.bundleVersion}`);
}

function readManifestOrNull() {
  try {
    if (!fs.existsSync(MANIFEST_PATH)) return null;
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
  } catch { return null; }
}

/**
 * Are two manifests identical?
 *
 * Serialised comparison, so a difference ANYWHERE — a per-file sha, a dropped
 * skill, a reordered key — counts and forces a rewrite. Erring toward rewriting
 * is the safe direction: the alternative is a corrupt manifest that the rebuild
 * command silently refuses to repair. (Previously `sameIgnoringTimestamp`, which
 * had to strip the volatile `updatedAt`; that field is gone, so this is a plain
 * equality.)
 */
function sameManifest(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

main();

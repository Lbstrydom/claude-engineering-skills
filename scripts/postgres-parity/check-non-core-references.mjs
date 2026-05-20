#!/usr/bin/env node
/**
 * @fileoverview Postgres-parity CI lint — flag new non-core references in
 * `supabase/migrations/*.sql` that the compat-bootstrap inventory hasn't
 * accepted yet. Doubles as a schema-coupling check: any `<schema>.<table>`
 * qualification outside the allowlisted pair (`public`, `auth`) is flagged.
 *
 * Plan: docs/plans/postgres-parity.md §0 #2 ("CI lint re-runs the inventory").
 * Inventory: docs/plans/postgres-parity-non-core-inventory.md
 * Schema-coupling baseline: docs/plans/postgres-parity-schema-coupling.md §1
 *
 * Usage:
 *   node scripts/postgres-parity/check-non-core-references.mjs            # text report
 *   node scripts/postgres-parity/check-non-core-references.mjs --json     # JSON
 *   node scripts/postgres-parity/check-non-core-references.mjs --strict   # exit 1 on any new finding
 *   node scripts/postgres-parity/check-non-core-references.mjs --schema-coupling
 *       # additionally flag any hardcoded `<schema>.` qualification beyond
 *       # the baseline (4 lines in 20260501120000_symbol_index.sql) — used
 *       # to detect new non-portable migrations.
 *
 * @module scripts/postgres-parity/check-non-core-references
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'supabase', 'migrations');

// ── Allowlist (the inventory) ──────────────────────────────────────────────
// Edit these when the compat-bootstrap gets a matching addition. Do NOT
// edit to silence a finding without updating the bootstrap.

const ALLOWED_AUTH_REFS = new Set([
  // table refs
  'auth.users(id)',
  'auth.users (id)',
  // function refs
  'auth.uid()',
]);

const ALLOWED_ROLES = new Set(['anon', 'authenticated', 'service_role']);

const ALLOWED_EXTENSIONS = new Set(['pg_trgm', 'vector', 'pgcrypto']);

// The schema-coupling baseline (plan §1 schema-coupling.md). Each entry is
// `<filename>:<line>` that we ACCEPT as legacy `public.` qualification. A
// new occurrence outside this set fails --schema-coupling.
const SCHEMA_COUPLING_BASELINE = new Set([
  '20260501120000_symbol_index.sql:184',
  '20260501120000_symbol_index.sql:196',
  '20260501120000_symbol_index.sql:201',
  '20260501120000_symbol_index.sql:211',
]);

// ── Scanner ────────────────────────────────────────────────────────────────

function readMigrations() {
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  return files.map((name) => ({
    name,
    path: path.join(MIGRATIONS_DIR, name),
    content: fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf-8'),
  }));
}

function scanForFindings(migrations, { schemaCoupling = false } = {}) {
  const findings = {
    unallowedAuthRef: [],
    unallowedRole: [],
    unallowedExtension: [],
    defaultAuthUid: [],     // R14 — must trigger a sentinel-UUID review
    newPublicQualification: [], // only filled when schemaCoupling=true
  };

  // Regexes — kept readable; one pass per migration over the line array.
  const RE_AUTH_REF = /\bauth\.\w+(\s*\([^)]*\))?/g;
  const RE_DEFAULT_AUTH = /DEFAULT\s+auth\.\w+/gi;
  const RE_CREATE_ROLE = /\bCREATE\s+ROLE\s+(\w+)/gi;
  const RE_GRANT_TO_ROLE = /\bTO\s+([\w, ]+?)(?:\s*;|\s*$|\s*USING)/gi;
  const RE_REVOKE_FROM_ROLE = /\bREVOKE\s+\w+(?:\s+\w+)?\s+ON\s+\S+\s+FROM\s+([\w, ]+?)(?:\s*;|\s*$)/gi;
  const RE_POLICY_TO_ROLE = /\bTO\s+(anon|authenticated|service_role|public)\b/gi;
  const RE_CREATE_EXTENSION = /\bCREATE\s+EXTENSION\s+(?:IF\s+NOT\s+EXISTS\s+)?["']?(\w+)["']?/gi;
  const RE_PUBLIC_QUAL = /\bpublic\.\w+/gi;

  for (const m of migrations) {
    const lines = m.content.split(/\r?\n/);
    lines.forEach((line, idx) => {
      const lineNum = idx + 1;
      const loc = `${m.name}:${lineNum}`;

      // strip line comments (-- ... and -- ║ banner blocks)
      const code = line.replace(/--.*$/, '');
      if (!code.trim()) return;

      // --- auth.* references
      for (const match of code.matchAll(RE_AUTH_REF)) {
        const ref = match[0].replace(/\s+/g, ' ').trim();
        // normalise function form `auth.uid()` vs table column form
        const normalised = ref.endsWith(')') ? ref : `auth.${ref.split('.')[1].split(/[\s(,)]/)[0]}()`;
        // table form is e.g. `auth.users(id)` - tolerate both styles
        const isUsersTable = /auth\.users\s*\(/.test(ref);
        const key = isUsersTable ? 'auth.users(id)' : (ref.endsWith(')') ? ref.replace(/\s+/g, '') : `auth.${match[0].split('.')[1]}`);
        if (!ALLOWED_AUTH_REFS.has(key) && !ALLOWED_AUTH_REFS.has(ref)) {
          // tolerate column-style "REFERENCES auth.users(id)" — already covered
          if (!/REFERENCES\s+auth\.users/.test(code)) {
            findings.unallowedAuthRef.push({ loc, ref });
          }
        }
      }

      // --- DEFAULT auth.uid() (R14 trigger)
      for (const match of code.matchAll(RE_DEFAULT_AUTH)) {
        findings.defaultAuthUid.push({ loc, fragment: match[0] });
      }

      // --- CREATE ROLE <name>
      for (const match of code.matchAll(RE_CREATE_ROLE)) {
        const role = match[1].toLowerCase();
        if (!ALLOWED_ROLES.has(role)) {
          findings.unallowedRole.push({ loc, role });
        }
      }

      // --- GRANT/REVOKE/POLICY TO <role list>
      for (const re of [RE_GRANT_TO_ROLE, RE_REVOKE_FROM_ROLE, RE_POLICY_TO_ROLE]) {
        for (const match of code.matchAll(re)) {
          const list = match[1].split(',').map((r) => r.trim().toLowerCase()).filter(Boolean);
          for (const role of list) {
            if (role === 'public' || role === '') continue; // public is built-in
            if (!ALLOWED_ROLES.has(role)) {
              findings.unallowedRole.push({ loc, role });
            }
          }
        }
      }

      // --- CREATE EXTENSION
      for (const match of code.matchAll(RE_CREATE_EXTENSION)) {
        const ext = match[1].toLowerCase();
        if (!ALLOWED_EXTENSIONS.has(ext)) {
          findings.unallowedExtension.push({ loc, extension: ext });
        }
      }

      // --- public.<table> qualification (schema-coupling)
      if (schemaCoupling) {
        for (const _match of code.matchAll(RE_PUBLIC_QUAL)) {
          const baselineKey = loc;
          if (!SCHEMA_COUPLING_BASELINE.has(baselineKey)) {
            findings.newPublicQualification.push({ loc, fragment: code.trim().slice(0, 100) });
          }
        }
      }
    });
  }
  return findings;
}

// ── Reporter ───────────────────────────────────────────────────────────────

function formatHumanReport(findings, schemaCoupling) {
  const lines = [];
  let total = 0;
  for (const [kind, items] of Object.entries(findings)) {
    if (!schemaCoupling && kind === 'newPublicQualification') continue;
    if (items.length === 0) continue;
    total += items.length;
    lines.push(`\n## ${kind} (${items.length})`);
    for (const item of items) {
      lines.push(`  ${item.loc} — ${JSON.stringify({ ...item, loc: undefined })}`);
    }
  }
  if (total === 0) {
    return 'OK — no un-allowlisted non-core references found.\n';
  }
  return `Found ${total} un-allowlisted reference(s):\n${lines.join('\n')}\n` +
    '\nRecourse:\n' +
    '  (1) Add the new reference to the compat-bootstrap inventory + this script\'s allowlist; or\n' +
    '  (2) Refactor the migration to avoid the non-core reference.\n' +
    'See docs/plans/postgres-parity-non-core-inventory.md.\n';
}

// ── CLI ────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const strict = args.includes('--strict');
  const schemaCoupling = args.includes('--schema-coupling');

  const migrations = readMigrations();
  const findings = scanForFindings(migrations, { schemaCoupling });

  const total = Object.entries(findings)
    .filter(([k]) => schemaCoupling || k !== 'newPublicQualification')
    .reduce((sum, [, items]) => sum + items.length, 0);

  if (json) {
    process.stdout.write(JSON.stringify({
      total,
      migrationCount: migrations.length,
      schemaCoupling,
      findings,
    }, null, 2) + '\n');
  } else {
    process.stdout.write(formatHumanReport(findings, schemaCoupling));
  }

  if (strict && total > 0) {
    process.exit(1);
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}` ||
  import.meta.url === pathToFileUrl(process.argv[1]);
function pathToFileUrl(p) { return new URL(`file://${path.resolve(p).replace(/\\/g, '/')}`).href; }

if (isMain) {
  main();
}

export const _internals = Object.freeze({
  readMigrations,
  scanForFindings,
  formatHumanReport,
  ALLOWED_AUTH_REFS,
  ALLOWED_ROLES,
  ALLOWED_EXTENSIONS,
  SCHEMA_COUPLING_BASELINE,
});

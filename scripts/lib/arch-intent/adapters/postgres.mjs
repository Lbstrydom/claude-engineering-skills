/**
 * @fileoverview Postgres adapter for the architecture-intent framework.
 *
 * Pure-JS analysis of `.sql` migration files — NO database, NO credentials,
 * CI-safe. Parses DDL, builds an epoch-tracked ordered catalog of the
 * CURRENT schema state, resolves cross-object dependency edges, and checks
 * each against `domainMap.allowedDeps`.
 *
 * Conforms to the PR-A adapter contract: exports
 * `default async function analyseImports({mapped, domainMap, repoPath})`
 * returning `{violations, _meta, analyzerVersion}`.
 *
 * NOT a live `pg_catalog` introspector — the parent plan sketched that, but
 * it needs a running DB + credentials and cannot run in CI. Pure `.sql`
 * parsing is the deliberate choice (see plan §1 Tension 1).
 *
 * 3-stage pipeline (plan §2): parseFile → buildSqlCatalog → resolveEdges.
 *
 * @module scripts/lib/arch-intent/adapters/postgres
 */

import fs from 'node:fs';
import path from 'node:path';
import { resolveFileToDomain, checkDepAllowed, VENDOR_DOMAIN } from '../domain-resolver.mjs';

const VERSION = 'postgres-1.0.0';

/**
 * Skip `.sql` files larger than this — a schema file this large is almost
 * certainly generated data, not DDL. Env-overridable via
 * `ARCH_SQL_MAX_FILE_BYTES` for repos with genuinely large hand-written
 * schema. Default 4 MiB. An invalid override (non-finite, ≤0, or absurdly
 * large) is rejected with a stderr warning and the default is used —
 * silently accepting `-1`/`Infinity`/`0` would gate parsing on a typo.
 */
export const SQL_MAX_FILE_BYTES = (() => {
  const DEFAULT = 4 * 1024 * 1024;
  const raw = process.env.ARCH_SQL_MAX_FILE_BYTES;
  if (raw === undefined || raw === '') return DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 1024 * 1024 * 1024) {
    process.stderr.write(
      `  [postgres-adapter] WARNING: invalid ARCH_SQL_MAX_FILE_BYTES="${raw}" ` +
      `— using default ${DEFAULT}\n`,
    );
    return DEFAULT;
  }
  return n;
})();

/**
 * Module allowlist — the ONLY way a SQL reference becomes `proven-external`
 * (plan §2.4): `pg_*` / `information_schema` prefixes, common builtin /
 * extension functions, and builtin column-type names. Read-only by
 * convention — only ever queried via `.has()`; do not mutate. (JS `Set`
 * cannot be made truly immutable; the contract is "treat as read-only".)
 */
export const SQL_BUILTIN = new Set([
  // builtin / extension functions
  'now', 'count', 'sum', 'avg', 'min', 'max', 'coalesce', 'nullif', 'greatest',
  'least', 'gen_random_uuid', 'uuid_generate_v4', 'uuid_generate_v1', 'nextval',
  'currval', 'setval', 'lower', 'upper', 'trim', 'length', 'substring', 'replace',
  'concat', 'format', 'to_char', 'to_timestamp', 'to_date', 'date_trunc', 'extract',
  'age', 'array_agg', 'string_agg', 'jsonb_build_object', 'jsonb_build_array',
  'jsonb_agg', 'jsonb_array_elements', 'jsonb_object_keys', 'json_build_object',
  'row_number', 'rank', 'dense_rank', 'current_timestamp', 'current_date',
  'current_user', 'session_user', 'pg_notify', 'md5', 'encode', 'decode', 'exists',
  // builtin column types
  'text', 'varchar', 'char', 'character', 'int', 'integer', 'int2', 'int4', 'int8',
  'smallint', 'bigint', 'serial', 'bigserial', 'smallserial', 'boolean', 'bool',
  'numeric', 'decimal', 'real', 'double', 'float', 'float4', 'float8', 'money',
  'date', 'time', 'timestamp', 'timestamptz', 'timetz', 'interval', 'uuid',
  'json', 'jsonb', 'bytea', 'inet', 'cidr', 'macaddr', 'bit', 'tsvector',
  'tsquery', 'xml', 'point', 'line', 'box', 'circle', 'oid', 'name',
]);

/**
 * Platform-provided schemas — objects the DATABASE PLATFORM owns, not the app.
 * A reference to `auth.users` / `auth.uid()` is a dependency on Supabase (or
 * the compatibility shim that stands in for it on self-hosted Postgres), NOT
 * on whatever repo file happens to `CREATE` a parity copy of it.
 *
 * Why this exists (2026-07-20): `compat-bootstrap.sql` (stores domain) does
 * `CREATE SCHEMA auth; CREATE TABLE auth.users` so self-hosted Postgres has the
 * `auth.users` Supabase provides natively. That made every migration's
 * `REFERENCES auth.users(id)` resolve to compat-bootstrap.sql, fabricating a
 * `supabase → stores` edge the mechanical pass reported for NINE rounds. The
 * migration has no real dependency on the shim — it depends on the platform
 * schema, which is external. Adjudicated FABRICATED in domain-map.json's
 * `_adjudication_2026_07_20`; this is the mechanical fix that stops it, so the
 * bouncer never sees the fabricated edge to hallucinate findings from.
 *
 * These are the standard Supabase-managed schemas. Treated exactly like
 * `pg_catalog` / `pg_*`: platform-owned, so a reference to them is
 * `proven-external`, never a local edge — even when a shim creates a copy.
 */
export const PLATFORM_SCHEMAS = new Set([
  'auth', 'storage', 'realtime', 'graphql', 'graphql_public', 'extensions',
  'vault', 'supabase_functions', 'supabase_migrations', 'pgbouncer', 'net', 'cron',
]);

/** A reference's expected target kind → which catalog map resolves it. */
const KIND_TO_MAP = {
  'foreign-key': 'relation',
  'view-select': 'relation',
  'partition-of': 'relation',
  'policy-reference': 'relation',
  'function-call': 'function',
  'trigger-binding': 'function',
  'column-type': 'type',
};

// ── Stage helper: lexical stripping ─────────────────────────────────────────

/**
 * Length-preserving lexical strip. Blanks line comments, NESTED block
 * comments, `'…'` / `E'…'` string literals, and `$tag$…$tag$` dollar-quotes
 * (replacing each char with a space; newlines kept). Quoted identifiers
 * `"…"` are PRESERVED (text kept) — only their quote-state is tracked so a
 * `;`/`--` inside `"weird;name"` is not misread.
 *
 * Output length === input length, so any offset maps 1:1 to the original.
 *
 * @param {string} source
 * @returns {string}
 */
export function stripSqlCommentsAndStrings(source) {
  const out = [];
  const n = source.length;
  let i = 0;
  const blank = ch => out.push(ch === '\n' ? '\n' : ' ');

  while (i < n) {
    const c = source[i];

    // Line comment
    if (c === '-' && source[i + 1] === '-') {
      while (i < n && source[i] !== '\n') { out.push(' '); i++; }
      continue;
    }
    // Block comment (nested)
    if (c === '/' && source[i + 1] === '*') {
      let depth = 1;
      out.push(' ', ' '); i += 2;
      while (i < n && depth > 0) {
        if (source[i] === '/' && source[i + 1] === '*') { depth++; out.push(' ', ' '); i += 2; continue; }
        if (source[i] === '*' && source[i + 1] === '/') { depth--; out.push(' ', ' '); i += 2; continue; }
        blank(source[i]); i++;
      }
      continue;
    }
    // Dollar-quoted string: $tag$ … $tag$
    if (c === '$') {
      const tagMatch = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(source.slice(i, i + 130));
      if (tagMatch) {
        const tag = tagMatch[0];
        for (let k = 0; k < tag.length; k++) out.push(' ');
        i += tag.length;
        while (i < n) {
          if (source.startsWith(tag, i)) {
            for (let k = 0; k < tag.length; k++) out.push(' ');
            i += tag.length;
            break;
          }
          blank(source[i]); i++;
        }
        continue;
      }
    }
    // String literal — plain '…' or escape-string E'…' / e'…'
    if (c === "'") {
      const prev = out.length > 0 ? out[out.length - 1] : '';
      const prevPrev = out.length > 1 ? out[out.length - 2] : '';
      // An E/e prefix only counts as an escape-string when the E is
      // STANDALONE — not the tail of a longer identifier (G2 fix;
      // `foo_e'…'` is invalid SQL anyway, but guard defensively).
      const isEscapeString = (prev === 'E' || prev === 'e')
        && !/[A-Za-z0-9_]/.test(prevPrev);
      out.push(' '); i++;
      while (i < n) {
        const ch = source[i];
        if (isEscapeString && ch === '\\') {
          out.push(' ');
          if (i + 1 < n) blank(source[i + 1]);
          i += 2; continue;
        }
        if (ch === "'") {
          if (source[i + 1] === "'") { out.push(' ', ' '); i += 2; continue; } // '' escape
          out.push(' '); i++; break;
        }
        blank(ch); i++;
      }
      continue;
    }
    // Quoted identifier — PRESERVED, only quote-state tracked.
    if (c === '"') {
      out.push('"'); i++;
      while (i < n) {
        const ch = source[i];
        if (ch === '"') {
          if (source[i + 1] === '"') { out.push('"', '"'); i += 2; continue; } // "" escape
          out.push('"'); i++; break;
        }
        out.push(ch); i++;
      }
      continue;
    }

    out.push(c); i++;
  }
  return out.join('');
}

// ── Stage 1: parseFile ──────────────────────────────────────────────────────

/**
 * Normalise an object name: split on TOP-LEVEL dots only (a dot inside a
 * quoted segment — `"my.table"` — is part of the identifier, not a
 * separator); strip quotes with case preserved + `""`→`"` un-escaping;
 * lowercase bare (unquoted) segments (Postgres case-folds them).
 */
function normName(raw) {
  if (!raw) return '';
  const src = raw.trim();
  const segments = [];
  let cur = '', inQ = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"') {
      if (inQ && src[i + 1] === '"') { cur += '""'; i++; continue; }
      inQ = !inQ; cur += '"'; continue;
    }
    if (ch === '.' && !inQ) { segments.push(cur); cur = ''; continue; }
    cur += ch;
  }
  segments.push(cur);
  return segments.map(seg => {
    const t = seg.trim();
    let v;
    if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
      v = t.slice(1, -1).replaceAll('""', '"'); // case preserved
    } else {
      v = t.toLowerCase();
    }
    // Escape a literal dot INSIDE a segment (a quoted identifier may contain
    // one — `"my.table"`) to U+0000 so the catalog key cannot collide with a
    // genuine schema-qualified `my.table` (G1 fix). Qualifier dots — the
    // `.join('.')` below — stay literal, so resolveSqlRef's dot-based
    // qualified-name logic is unaffected. `displayName()` reverses this for
    // human-facing `_meta` fields.
    return v.replaceAll('.', SEG_DOT);
  }).join('.');
}

/** Sentinel for a literal dot inside a single (quoted) identifier segment. */
const SEG_DOT = '\u0000';

/** Reverse normName's intra-segment dot escaping for human-facing output. */
function displayName(n) {
  return typeof n === 'string' ? n.replaceAll(SEG_DOT, '.') : n;
}

/** Split a stripped statement body's top-level comma list (paren-depth 0). */
function splitTopLevel(body, sep = ',') {
  const parts = [];
  let depth = 0, cur = '';
  for (const ch of body) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === sep && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

const CONSTRAINT_LEAD = /^\s*(constraint|primary\s+key|foreign\s+key|unique|check|exclude|like)\b/i;

/**
 * Stage 1 — parse one stripped `.sql` file into objectDefs, alterRefs, drops.
 *
 * @param {string} strippedSql - output of stripSqlCommentsAndStrings
 * @param {string} originalSource - same length; for dollar-quoted body recovery
 * @param {string} file - repo-relative path (for ref.definingFile)
 * @returns {{objectDefs:Array, alterRefs:Array, drops:Array}}
 */
export function parseFile(strippedSql, originalSource, file) {
  const objectDefs = [];
  const alterRefs = [];
  const drops = [];

  // Split into Statement artifacts with offsets (offsets index both sources).
  // The split is quote-aware: a `;` inside a quoted identifier ("weird;name")
  // is NOT a statement boundary. The stripper already neutralised every `;`
  // in comments/strings/dollar-quotes — quoted identifiers are the only
  // construct that retains a literal `;` (their text is preserved), so the
  // splitter must track `"…"` state (H3 fix).
  let stmtStart = 0;
  let inQuotedIdent = false;
  const lineAt = off => strippedSql.slice(0, off).split('\n').length;
  for (let i = 0; i <= strippedSql.length; i++) {
    if (i < strippedSql.length && strippedSql[i] === '"') {
      // `""` is an escaped quote inside an identifier — stays in-state.
      if (inQuotedIdent && strippedSql[i + 1] === '"') { i++; continue; }
      inQuotedIdent = !inQuotedIdent;
      continue;
    }
    if (i === strippedSql.length || (strippedSql[i] === ';' && !inQuotedIdent)) {
      const text = strippedSql.slice(stmtStart, i);
      if (text.trim()) {
        classifyStatement(text, stmtStart, i, lineAt(stmtStart), originalSource,
          file, objectDefs, alterRefs, drops);
      }
      stmtStart = i + 1;
    }
  }
  return { objectDefs, alterRefs, drops };
}

function classifyStatement(text, startOff, endOff, line, originalSource, file,
  objectDefs, alterRefs, drops) {
  // ── CREATE TABLE ──
  let m = /create\s+(?:or\s+replace\s+)?table\s+(?:if\s+not\s+exists\s+)?((?:"(?:[^"]|"")*"|\w+)(?:\.(?:"(?:[^"]|"")*"|\w+))*)([\s\S]*)/i.exec(text);
  if (m) {
    const name = normName(m[1]);
    const rest = m[2];
    const refs = [];
    const partMatch = /partition\s+of\s+((?:"(?:[^"]|"")*"|\w+)(?:\.(?:"(?:[^"]|"")*"|\w+))*)/i.exec(rest);
    if (partMatch) {
      refs.push({ kind: 'partition-of', fromObjectName: name, toName: normName(partMatch[1]),
        expectedKind: 'relation', definingFile: file, line });
    }
    const bodyMatch = /\(([\s\S]*)\)/.exec(rest);
    if (bodyMatch) {
      for (const colDef of splitTopLevel(bodyMatch[1])) {
        if (CONSTRAINT_LEAD.test(colDef)) {
          // table-level constraint — extract FK
          const fk = /(?:constraint\s+("[^"]+"|[\w]+)\s+)?foreign\s+key\s*\([^)]*\)\s*references\s+((?:"(?:[^"]|"")*"|\w+)(?:\.(?:"(?:[^"]|"")*"|\w+))*)/i.exec(colDef);
          if (fk) {
            refs.push({ kind: 'foreign-key', fromObjectName: name, toName: normName(fk[2]),
              expectedKind: 'relation', constraintName: fk[1] ? normName(fk[1]) : null,
              definingFile: file, line });
          }
          continue;
        }
        // column def: <col> <type> [...]  — inline REFERENCES + column-type
        const tokens = colDef.trim().split(/\s+/);
        if (tokens.length >= 2) {
          const typeBase = tokens[1].replace(/\([^)]*\)/g, '').replace(/\[\]/g, '').toLowerCase();
          if (typeBase && /^[\w.]+$/.test(typeBase) && !SQL_BUILTIN.has(normName(typeBase))) {
            refs.push({ kind: 'column-type', fromObjectName: name, toName: normName(typeBase),
              expectedKind: 'type', definingFile: file, line });
          }
        }
        const inlineFk = /references\s+((?:"(?:[^"]|"")*"|\w+)(?:\.(?:"(?:[^"]|"")*"|\w+))*)/i.exec(colDef);
        if (inlineFk) {
          refs.push({ kind: 'foreign-key', fromObjectName: name, toName: normName(inlineFk[1]),
            expectedKind: 'relation', constraintName: null, definingFile: file, line });
        }
      }
    }
    objectDefs.push({ kind: 'relation', name, definingFile: file, line, refs });
    return;
  }

  // ── CREATE VIEW / MATERIALIZED VIEW ──
  m = /create\s+(?:or\s+replace\s+)?(?:materialized\s+)?view\s+(?:if\s+not\s+exists\s+)?((?:"(?:[^"]|"")*"|\w+)(?:\.(?:"(?:[^"]|"")*"|\w+))*)\s+as\s+([\s\S]*)/i.exec(text);
  if (m) {
    const name = normName(m[1]);
    const refs = extractSelectRefs(m[2], name, file, line);
    objectDefs.push({ kind: 'relation', name, definingFile: file, line, refs });
    return;
  }

  // ── CREATE FUNCTION ──
  m = /create\s+(?:or\s+replace\s+)?function\s+((?:"(?:[^"]|"")*"|\w+)(?:\.(?:"(?:[^"]|"")*"|\w+))*)\s*\(([\s\S]*?)\)/i.exec(text);
  if (m) {
    const name = normName(m[1]);
    const body = recoverFunctionBody(originalSource, startOff, endOff);
    const refs = extractCallRefs(body, name, file, line);
    objectDefs.push({ kind: 'function', name, definingFile: file, line, refs });
    return;
  }

  // ── CREATE TYPE / DOMAIN ──
  m = /create\s+(?:type|domain)\s+((?:"(?:[^"]|"")*"|\w+)(?:\.(?:"(?:[^"]|"")*"|\w+))*)/i.exec(text);
  if (m) {
    objectDefs.push({ kind: 'type', name: normName(m[1]), definingFile: file, line, refs: [] });
    return;
  }

  // ── ALTER TABLE … ADD FOREIGN KEY ──
  m = /alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?((?:"(?:[^"]|"")*"|\w+)(?:\.(?:"(?:[^"]|"")*"|\w+))*)([\s\S]*)/i.exec(text);
  if (m) {
    const tbl = normName(m[1]);
    const rest = m[2];
    const fk = /add\s+(?:constraint\s+("[^"]+"|[\w]+)\s+)?foreign\s+key\s*\([^)]*\)\s*references\s+((?:"(?:[^"]|"")*"|\w+)(?:\.(?:"(?:[^"]|"")*"|\w+))*)/i.exec(rest);
    if (fk) {
      alterRefs.push({ kind: 'foreign-key', fromObjectName: tbl, toName: normName(fk[2]),
        expectedKind: 'relation', constraintName: fk[1] ? normName(fk[1]) : null,
        definingFile: file, line });
    }
    const dropCon = /drop\s+constraint\s+(?:if\s+exists\s+)?("[^"]+"|[\w]+)/i.exec(rest);
    if (dropCon) {
      drops.push({ what: 'constraint', table: tbl, name: normName(dropCon[1]) });
    }
    return;
  }

  // ── CREATE TRIGGER ──
  m = /create\s+(?:or\s+replace\s+)?(?:constraint\s+)?trigger\s+("[^"]+"|[\w]+)([\s\S]*)/i.exec(text);
  if (m) {
    const trigName = normName(m[1]);
    const onM = /\son\s+((?:"(?:[^"]|"")*"|\w+)(?:\.(?:"(?:[^"]|"")*"|\w+))*)/i.exec(m[2]);
    const fnM = /execute\s+(?:procedure|function)\s+((?:"(?:[^"]|"")*"|\w+)(?:\.(?:"(?:[^"]|"")*"|\w+))*)/i.exec(m[2]);
    if (onM && fnM) {
      alterRefs.push({ kind: 'trigger-binding', fromObjectName: normName(onM[1]),
        toName: normName(fnM[1]), expectedKind: 'function', alterName: trigName,
        onTable: normName(onM[1]), definingFile: file, line });
    }
    return;
  }

  // ── CREATE POLICY ──
  m = /create\s+policy\s+("[^"]+"|[\w]+)\s+on\s+((?:"(?:[^"]|"")*"|\w+)(?:\.(?:"(?:[^"]|"")*"|\w+))*)([\s\S]*)/i.exec(text);
  if (m) {
    const polName = normName(m[1]);
    const onTable = normName(m[2]);
    for (const t of extractPolicyTableRefs(m[3])) {
      alterRefs.push({ kind: 'policy-reference', fromObjectName: onTable, toName: t,
        expectedKind: 'relation', alterName: polName, onTable, definingFile: file, line });
    }
    return;
  }

  // ── DROP {TABLE|VIEW|...|TYPE|DOMAIN} a, b, c ──
  m = /drop\s+(table|view|materialized\s+view|function|type|domain)\s+(?:if\s+exists\s+)?([\s\S]*)/i.exec(text);
  if (m) {
    for (const seg of m[2].split(',')) {
      const nameTok = seg.trim().split(/\s+/)[0];
      if (nameTok && /^((?:"(?:[^"]|"")*"|\w+)(?:\.(?:"(?:[^"]|"")*"|\w+))*)$/.test(nameTok)) {
        drops.push({ what: 'object', name: normName(nameTok) });
      }
    }
    return;
  }
  // ── DROP TRIGGER / POLICY <name> ON <table> ──
  m = /drop\s+(trigger|policy)\s+(?:if\s+exists\s+)?("[^"]+"|[\w]+)\s+on\s+((?:"(?:[^"]|"")*"|\w+)(?:\.(?:"(?:[^"]|"")*"|\w+))*)/i.exec(text);
  if (m) {
    drops.push({ what: m[1].toLowerCase(), name: normName(m[2]), table: normName(m[3]) });
  }
}

/** Recover a function body span from the original source (offsets are 1:1). */
function recoverFunctionBody(originalSource, startOff, endOff) {
  const slice = originalSource.slice(startOff, endOff);
  const dollar = /\$([A-Za-z_][A-Za-z0-9_]*)?\$([\s\S]*?)\$\1\$/.exec(slice);
  if (dollar) return dollar[2];
  const asStr = /\bas\s+'((?:[^']|'')*)'/i.exec(slice);
  if (asStr) return asStr[1];
  return '';
}

/** Extract `FROM`/`JOIN` relation candidates from a view's SELECT text. */
function extractSelectRefs(selectText, fromName, file, line) {
  const refs = [];
  const ctes = new Set();
  for (const cte of selectText.matchAll(/\bwith\s+("[^"]+"|[\w]+)\s+as\s*\(/gi)) {
    ctes.add(normName(cte[1]));
  }
  for (const fm of selectText.matchAll(/\b(?:from|join)\s+((?:"(?:[^"]|"")*"|\w+)(?:\.(?:"(?:[^"]|"")*"|\w+))*)/gi)) {
    const raw = fm[1];
    // exclude function calls — a `(` right after the name
    const after = selectText.slice(fm.index + fm[0].length).trimStart();
    if (after.startsWith('(')) continue;
    const name = normName(raw);
    if (ctes.has(name)) continue;
    refs.push({ kind: 'view-select', fromObjectName: fromName, toName: name,
      expectedKind: 'relation', definingFile: file, line });
  }
  return refs;
}

/** Extract `identifier(` call candidates from a function body. */
function extractCallRefs(body, fromName, file, line) {
  const refs = [];
  const seen = new Set();
  for (const cm of body.matchAll(/\b([a-zA-Z_][\w.]*)\s*\(/g)) {
    const name = normName(cm[1]);
    if (seen.has(name)) continue;
    seen.add(name);
    refs.push({ kind: 'function-call', fromObjectName: fromName, toName: name,
      expectedKind: 'function', definingFile: file, line });
  }
  return refs;
}

/** Extract schema-qualified table names from a policy USING/WITH CHECK expr. */
function extractPolicyTableRefs(expr) {
  const out = new Set();
  for (const fm of expr.matchAll(/\b(?:from|join)\s+((?:"(?:[^"]|"")*"|\w+)(?:\.(?:"(?:[^"]|"")*"|\w+))*)/gi)) {
    out.add(normName(fm[1]));
  }
  for (const qm of expr.matchAll(/\b([a-z_][\w]*\.[a-z_][\w]*)\b/gi)) {
    out.add(normName(qm[1]));
  }
  return [...out];
}

// ── Stage 2: buildSqlCatalog ────────────────────────────────────────────────

/** Natural (numeric-aware) path comparison so `2_x` sorts before `10_x`. */
function naturalCompare(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * Stage 2 — replay parses in migration order into the current-state catalog.
 *
 * @param {Array<{file:string, parse:object}>} parses
 * @returns {{relationToDef:Map, functionToDef:Map, typeToDef:Map,
 *   survivingRefs:Array, objectRedefinitions:Array}}
 */
export function buildSqlCatalog(parses) {
  const ordered = [...parses].sort((a, b) => naturalCompare(a.file, b.file));
  const relationToDef = new Map();
  const functionToDef = new Map();
  const typeToDef = new Map();
  const epoch = new Map();             // name → current epoch
  const ownedRefs = new Map();         // name → refs of the surviving def
  const alterRefs = [];                // {ref, epoch}
  const objectRedefinitions = [];
  const mapFor = kind => kind === 'function' ? functionToDef
    : kind === 'type' ? typeToDef : relationToDef;

  for (const { parse } of ordered) {
    for (const def of parse.objectDefs) {
      const m = mapFor(def.kind);
      if (m.has(def.name)) {
        objectRedefinitions.push({ name: def.name, kind: def.kind, file: def.definingFile });
      }
      m.set(def.name, def);
      epoch.set(def.name, (epoch.get(def.name) || 0) + 1);
      ownedRefs.set(def.name, def.refs);
    }
    for (const ref of parse.alterRefs) {
      alterRefs.push({ ref, epoch: epoch.get(ref.fromObjectName) || 0 });
    }
    for (const drop of parse.drops) {
      if (drop.what === 'object') {
        relationToDef.delete(drop.name);
        functionToDef.delete(drop.name);
        typeToDef.delete(drop.name);
        ownedRefs.delete(drop.name);
        // NOTE: epoch is NOT deleted — it must stay monotonic. If the name
        // is later re-CREATEd, the next bump yields a DISTINCT epoch, so an
        // alterRef from the dropped instance (which captured the old epoch)
        // is correctly discarded rather than reattaching (H1).
      } else if (drop.what === 'constraint') {
        // remove a surviving FK alterRef on this table by constraint name
        for (let k = alterRefs.length - 1; k >= 0; k--) {
          const r = alterRefs[k].ref;
          if (r.kind === 'foreign-key' && r.fromObjectName === drop.table
              && r.constraintName === drop.name) alterRefs.splice(k, 1);
        }
      } else if (drop.what === 'trigger' || drop.what === 'policy') {
        const wantKind = drop.what === 'trigger' ? 'trigger-binding' : 'policy-reference';
        for (let k = alterRefs.length - 1; k >= 0; k--) {
          const r = alterRefs[k].ref;
          if (r.kind === wantKind && r.alterName === drop.name
              && r.onTable === drop.table) alterRefs.splice(k, 1);
        }
      }
    }
  }

  // Surviving refs: owned refs of every surviving objectDef + epoch-valid alterRefs.
  const survivingRefs = [];
  for (const refs of ownedRefs.values()) survivingRefs.push(...refs);
  for (const { ref, epoch: capturedEpoch } of alterRefs) {
    if ((epoch.get(ref.fromObjectName) || 0) === capturedEpoch) survivingRefs.push(ref);
  }

  return { relationToDef, functionToDef, typeToDef, survivingRefs, objectRedefinitions };
}

// ── Stage 3: resolveEdges ───────────────────────────────────────────────────

/**
 * Resolve a single reference name to a three-state result, kind-aware.
 * @param {string} name
 * @param {'relation'|'function'|'type'} expectedKind
 * @param {object} catalog
 * @returns {{state:'resolved-local'|'proven-external'|'unresolved', targetFile?:string}}
 */
export function resolveSqlRef(name, expectedKind, catalog) {
  const map = expectedKind === 'function' ? catalog.functionToDef
    : expectedKind === 'type' ? catalog.typeToDef : catalog.relationToDef;
  const bare = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name;
  const schema = name.includes('.') ? name.slice(0, name.indexOf('.')) : '';
  // Platform-owned schema (auth.*, storage.*, …) — external even when a parity
  // shim CREATEs a local copy, so this MUST precede the local-catalog match
  // below (compat-bootstrap.sql defines auth.users; without this, every
  // `REFERENCES auth.users` would fabricate an edge to it). See PLATFORM_SCHEMAS.
  if (schema && PLATFORM_SCHEMAS.has(schema)) return { state: 'proven-external' };
  // Exact (possibly schema-qualified) match.
  if (map.has(name)) return { state: 'resolved-local', targetFile: map.get(name).definingFile };
  // Builtin / pg_catalog / information_schema.
  if (schema === 'pg_catalog' || schema === 'information_schema'
      || bare.startsWith('pg_') || SQL_BUILTIN.has(bare)) {
    return { state: 'proven-external' };
  }
  // Unqualified: try public.<name>, then a unique bare-name match.
  if (!name.includes('.')) {
    if (map.has(`public.${name}`)) {
      return { state: 'resolved-local', targetFile: map.get(`public.${name}`).definingFile };
    }
    const matches = [...map.keys()].filter(k => k.slice(k.lastIndexOf('.') + 1) === name);
    if (matches.length === 1) {
      return { state: 'resolved-local', targetFile: map.get(matches[0]).definingFile };
    }
  }
  return { state: 'unresolved' };
}

// ── Adapter entry point ─────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {Map<string,string>} opts.mapped
 * @param {object} opts.domainMap
 * @param {string} opts.repoPath
 * @returns {Promise<{violations:Array, _meta:object, analyzerVersion:string}>}
 */
export default async function analyseImports({ mapped, domainMap, repoPath }) {
  const meta = {
    statementCount: 0, tableCount: 0, viewCount: 0, functionCount: 0, typeCount: 0,
    edgeCount: 0, fkEdges: 0, viewEdges: 0, functionCallEdges: 0, triggerEdges: 0,
    policyEdges: 0, partitionEdges: 0, columnTypeEdges: 0, vendorRefs: 0,
    unresolvedRefs: [], objectRedefinitions: [], unreadableFiles: [],
    parseErrors: [], skippedLargeFiles: [], edges: [], allFiles: [],
  };

  const sqlFiles = [...mapped.keys()]
    .filter(f => path.extname(f).toLowerCase() === '.sql')
    .map(f => f.replaceAll('\\', '/'))
    .sort((a, b) => a.localeCompare(b));

  if (sqlFiles.length === 0) {
    return { violations: [], _meta: meta, analyzerVersion: VERSION };
  }
  meta.allFiles = sqlFiles;

  // Stage 0 — per-file fault isolation.
  const parses = [];
  for (const file of sqlFiles) {
    let source;
    try {
      const stat = fs.statSync(path.join(repoPath, file));
      if (stat.size > SQL_MAX_FILE_BYTES) { meta.skippedLargeFiles.push(file); continue; }
      source = fs.readFileSync(path.join(repoPath, file), 'utf-8');
    } catch {
      meta.unreadableFiles.push(file);
      continue;
    }
    try {
      const stripped = stripSqlCommentsAndStrings(source);
      const parse = parseFile(stripped, source, file);
      parses.push({ file, parse });
    } catch (err) {
      meta.parseErrors.push({ file, message: err.message });
    }
  }

  // Stage 2 — ordered catalog.
  const catalog = buildSqlCatalog(parses);
  meta.objectRedefinitions = catalog.objectRedefinitions;
  meta.tableCount = [...catalog.relationToDef.values()].filter(d => d.kind === 'relation').length;
  meta.functionCount = catalog.functionToDef.size;
  meta.typeCount = catalog.typeToDef.size;

  // Stage 3 — resolve edges + domain-check.
  const violations = [];
  const seenViolation = new Set();
  const domainOf = f => mapped.get(f) ?? resolveFileToDomain(f, domainMap.rules);

  for (const ref of catalog.survivingRefs) {
    meta.edgeCount++;
    const kindCounter = {
      'foreign-key': 'fkEdges', 'view-select': 'viewEdges',
      'function-call': 'functionCallEdges', 'trigger-binding': 'triggerEdges',
      'policy-reference': 'policyEdges', 'partition-of': 'partitionEdges',
      'column-type': 'columnTypeEdges',
    }[ref.kind];
    if (kindCounter) meta[kindCounter]++;

    const res = resolveSqlRef(ref.toName, ref.expectedKind, catalog);
    if (res.state === 'proven-external') { meta.vendorRefs++; continue; }
    if (res.state === 'unresolved') {
      meta.unresolvedRefs.push({ from: displayName(ref.fromObjectName), to: displayName(ref.toName), kind: ref.kind });
      continue;
    }

    const fromFile = ref.definingFile;
    const toFile = res.targetFile;
    if (fromFile === toFile) continue;
    meta.edges.push({ fromObject: displayName(ref.fromObjectName), toObject: displayName(ref.toName), kind: ref.kind });

    const fromDomain = domainOf(fromFile);
    const toDomain = domainOf(toFile);
    if (!fromDomain || !toDomain) continue;
    if (!checkDepAllowed(fromDomain, toDomain, domainMap.allowedDeps)) {
      const key = `${fromFile} ${toFile} ${ref.kind}`;
      if (!seenViolation.has(key)) {
        seenViolation.add(key);
        violations.push({
          fromFile, toFile, fromDomain, toDomain,
          ruleViolated: 'not-in-allowedDeps',
        });
      }
    }
  }

  violations.sort((a, b) =>
    a.fromFile.localeCompare(b.fromFile) || a.toFile.localeCompare(b.toFile));

  return { violations, _meta: meta, analyzerVersion: VERSION };
}

export const _internals = {
  stripSqlCommentsAndStrings, parseFile, buildSqlCatalog, resolveSqlRef,
  normName, SQL_BUILTIN,
};

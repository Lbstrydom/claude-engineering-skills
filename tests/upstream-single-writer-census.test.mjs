/**
 * @fileoverview `upstreamTransition` must be the ONLY writer of a terminal
 * `upstream_issues.state` (consumer-friction-doctor plan §2.4, R1-H4). A
 * second writer could bypass the disposition ratchet entirely, so this is a
 * grep-based census gated in `check` — run in BOTH directions: it must pass
 * today (one writer), and it must FAIL against a deliberately-introduced
 * second `UPDATE upstream_issues` / `transitionUpstreamIssue` call site.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Every file under `scripts/` that writes `upstream_issues.state` — either
 * directly (`UPDATE upstream_issues ... SET ... state`) or by calling
 * `transitionUpstreamIssue`. Pure over an injected file map so the "must
 * fail" direction is testable without touching the real repo tree.
 *
 * @param {Map<string, string>} files relPath -> content
 * @returns {string[]} relative paths that write state, excluding the
 *   sanctioned writer itself (store/upstream-issues.mjs, which OWNS the SQL)
 *   and this module's own caller chain (commands.mjs -> store).
 */
/**
 * Files that legitimately contain state-writing-SHAPED text without
 * EXECUTING it. Excluded by NAME, not by a looser pattern — a genuinely new
 * bypass must not be able to hide behind a broadened regex.
 *
 *   - `lib/store/upstream-issues.mjs` — the ONE sanctioned writer.
 *   - `backfill-upstream-dispositions.mjs` — a pure SQL-TEXT GENERATOR (its
 *     own docstring: "it never opens a DB pool itself"). Its output template
 *     contains the literal substring `WHERE state IN (...)` in a generated
 *     `UPDATE ... SET disposition = ...` statement — that mentions `state`
 *     in a WHERE clause, never as a SET target, but is close enough to the
 *     real shape that excluding it explicitly is honester than trying to
 *     regex around it.
 */
const KNOWN_NON_WRITERS = new Set([
  'scripts/lib/store/upstream-issues.mjs',
  'scripts/backfill-upstream-dispositions.mjs',
]);

export function findStateWriters(files) {
  const hits = [];
  for (const [rel, content] of files) {
    if (KNOWN_NON_WRITERS.has(rel)) continue;
    // Requires `state` to be the assigned COLUMN (immediately followed by
    // `=`), not merely present somewhere after SET — a raw UPDATE's WHERE
    // clause can legitimately mention `state` (as `store/upstream-issues.mjs`'s
    // OWN prefix-match query does) without writing it. Tolerates an optional
    // schema qualifier (`public.upstream_issues`) and optional double-quoting
    // of either identifier (`"upstream_issues"`, `"state"`) — round-2 audit
    // M8/M14: the un-widened regex missed both forms a real second writer
    // could trivially use to slip past a bare `upstream_issues\b` match.
    // Also tolerates the standard PostgreSQL `UPDATE ONLY <table>` form
    // (round-3 audit H1) — `ONLY` disables inheritance-descent, a legal
    // modifier a second writer could use to slip past the un-widened match.
    const updateStmt = /UPDATE\s+(?:ONLY\s+)?(?:[\w$]+\.)?"?upstream_issues"?\b[\s\S]{0,200}\bSET\b[\s\S]{0,200}/im.exec(content);
    const writesRawSqlDirect = !!updateStmt && /(?:^|[,\s])"?state"?\s*=/im.test(updateStmt[0]);
    // PostgreSQL's tuple-assignment form `SET (state, disposition) = (...)`
    // (round-4 audit H4) — `state` appears inside a parenthesised column
    // list, immediately followed by a comma or `)`, never directly by `=`,
    // so the direct-assignment pattern above cannot see it at all.
    const writesRawSqlTuple = !!updateStmt
      && [...updateStmt[0].matchAll(/\(([^()]*)\)\s*=/g)]
        .some((m) => m[1].split(',').map((c) => c.trim().replace(/^"|"$/g, '')).includes('state'));
    const writesRawSql = writesRawSqlDirect || writesRawSqlTuple;
    // Calling transitionUpstreamIssue is fine when it's the ONE call site
    // that already exists (lib/upstream/commands.mjs's own `transitionFn`
    // parameter is an injected dependency, not a direct call — so this only
    // flags a file that actually IMPORTS and INVOKES the store function
    // directly, bypassing commands.mjs's disposition gate).
    //
    // Resolves the LOCAL BINDING the import introduces, not just the literal
    // name (round-1 audit H5): `import { transitionUpstreamIssue as t } from
    // '…/store/upstream-issues.mjs'; t(...)` used to slip past a bare
    // `transitionUpstreamIssue\(` grep entirely. A namespace import
    // (`import * as store from '…'`) is caught too, via `store.transitionUpstreamIssue(`.
    let callsStoreDirectly = false;
    if (rel !== 'scripts/lib/upstream/commands.mjs') {
      const importMatch = /import\s*(?:\{([^}]*)\}|(\*\s*as\s+[A-Za-z_$][\w$]*)|([A-Za-z_$][\w$]*))\s*from\s*['"].*store\/upstream-issues\.mjs['"]/.exec(content);
      if (importMatch) {
        const bindings = [];
        if (importMatch[1]) {
          // Named import list — resolve `transitionUpstreamIssue` or
          // `transitionUpstreamIssue as X` to the LOCAL name X.
          for (const spec of importMatch[1].split(',')) {
            const m = /^\s*transitionUpstreamIssue\s*(?:as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(spec);
            if (m) bindings.push(m[1] || 'transitionUpstreamIssue');
          }
        } else if (importMatch[2]) {
          // `* as store` — the call site reads `store.transitionUpstreamIssue(`.
          const ns = /\*\s*as\s+([A-Za-z_$][\w$]*)/.exec(importMatch[2])[1];
          bindings.push(`${ns}.transitionUpstreamIssue`);
          // Also a COMPUTED property access on the same namespace (round-5
          // audit M2): `store['transitionUpstreamIssue'](...)` or
          // `store["transitionUpstreamIssue"](...)` reads the exact same
          // export but the dot-access pattern above never matches it. Kept
          // as its own check, not squeezed into `bindings`, so the shared
          // per-name escaping below never has to distinguish a literal
          // identifier from an already-built regex fragment.
          if (new RegExp(`\\b${ns}\\[['"]transitionUpstreamIssue['"]\\]\\s*\\(`).test(content)) {
            callsStoreDirectly = true;
          }
        } else if (importMatch[3]) {
          // A default import cannot bind this named export; nothing to add.
        }
        callsStoreDirectly ||= bindings.some((name) => new RegExp(`\\b${name.replace('.', '\\.')}\\s*\\(`).test(content));
      }
      // A DYNAMIC import (round-3 audit M18 — `await import('…/store/upstream-issues.mjs')`
      // then destructuring/calling transitionUpstreamIssue) doesn't match the static
      // `import {...} from '...'` regex above at all — it flags any file that both
      // dynamically imports the store module AND calls transitionUpstreamIssue
      // anywhere in the file.
      // Round-6 audit H1: `require(...)` is the SAME class of dynamic,
      // non-statically-analyzed load `import(...)` is — this repo is
      // ESM-only (AGENTS.md forbids `require()`), so this is a defensive,
      // narrow addition rather than a realistic gap, but it costs nothing
      // to also recognize.
      if (!callsStoreDirectly && /(?:import|require)\s*\(\s*['"].*store\/upstream-issues\.mjs['"]/.test(content)) {
        if (/\btransitionUpstreamIssue\s*\(/.test(content)) {
          callsStoreDirectly = true;
        } else {
          // A destructuring RENAME (round-4 audit H4/M10 — `const {
          // transitionUpstreamIssue: transition } = await import(...)`, then
          // `transition(...)`) doesn't call the literal name at all — resolve
          // the local binding the destructuring introduces, same as the
          // static-import path already does via `as`.
          const destructureRename = /\{\s*transitionUpstreamIssue\s*:\s*([A-Za-z_$][\w$]*)\s*\}/.exec(content);
          if (destructureRename && new RegExp(`\\b${destructureRename[1]}\\s*\\(`).test(content)) {
            callsStoreDirectly = true;
          }
        }
      }
    }
    if (writesRawSql || callsStoreDirectly) hits.push(rel);
  }
  return hits;
}

function loadRepoScriptsFiles() {
  const out = new Map();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.claude-skills') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.mjs')) continue;
      const rel = path.relative(REPO_ROOT, full).replaceAll('\\', '/');
      out.set(rel, fs.readFileSync(full, 'utf-8'));
    }
  };
  walk(path.join(REPO_ROOT, 'scripts'));
  return out;
}

describe('upstream_issues.state has exactly one writer', () => {
  it('the REAL repo tree today: only store/upstream-issues.mjs writes state', () => {
    const hits = findStateWriters(loadRepoScriptsFiles());
    assert.deepEqual(hits, [], `unexpected additional state writer(s): ${hits.join(', ')}`);
  });

  it('poison-pill direction: a deliberately-introduced second writer IS detected', () => {
    const files = new Map([
      ['scripts/lib/store/upstream-issues.mjs', 'UPDATE upstream_issues SET state = $1 WHERE id = $2'],
      ['scripts/sneaky-second-writer.mjs', "UPDATE upstream_issues SET foo = 'x', state = 'fixed' WHERE id = $1"],
    ]);
    const hits = findStateWriters(files);
    assert.deepEqual(hits, ['scripts/sneaky-second-writer.mjs']);
  });

  it('poison-pill direction: a file calling transitionUpstreamIssue directly (bypassing commands.mjs) is detected', () => {
    const files = new Map([
      ['scripts/lib/store/upstream-issues.mjs', 'export async function transitionUpstreamIssue() {}'],
      ['scripts/some-other-tool.mjs', "import { transitionUpstreamIssue } from './lib/store/upstream-issues.mjs';\ntransitionUpstreamIssue({ id, to: 'fixed' });"],
    ]);
    const hits = findStateWriters(files);
    assert.deepEqual(hits, ['scripts/some-other-tool.mjs']);
  });

  it('poison-pill direction: an ALIASED import (round-1 audit H5) is detected, not just the literal name', () => {
    const files = new Map([
      ['scripts/lib/store/upstream-issues.mjs', 'export async function transitionUpstreamIssue() {}'],
      ['scripts/sneaky-alias.mjs', "import { transitionUpstreamIssue as t } from './lib/store/upstream-issues.mjs';\nt({ id, to: 'fixed' });"],
    ]);
    const hits = findStateWriters(files);
    assert.deepEqual(hits, ['scripts/sneaky-alias.mjs']);
  });

  it('poison-pill direction: a NAMESPACE import (`* as store`) is detected', () => {
    const files = new Map([
      ['scripts/lib/store/upstream-issues.mjs', 'export async function transitionUpstreamIssue() {}'],
      ['scripts/sneaky-namespace.mjs', "import * as store from './lib/store/upstream-issues.mjs';\nstore.transitionUpstreamIssue({ id, to: 'fixed' });"],
    ]);
    const hits = findStateWriters(files);
    assert.deepEqual(hits, ['scripts/sneaky-namespace.mjs']);
  });

  it('poison-pill direction (round-2 audit M8/M14): a schema-qualified table name is detected', () => {
    const files = new Map([
      ['scripts/lib/store/upstream-issues.mjs', 'UPDATE upstream_issues SET state = $1 WHERE id = $2'],
      ['scripts/sneaky-schema-qualified.mjs', "UPDATE public.upstream_issues SET state = 'fixed' WHERE id = $1"],
    ]);
    const hits = findStateWriters(files);
    assert.deepEqual(hits, ['scripts/sneaky-schema-qualified.mjs']);
  });

  it('poison-pill direction (round-2 audit M8/M14): quoted identifiers are detected', () => {
    const files = new Map([
      ['scripts/lib/store/upstream-issues.mjs', 'UPDATE upstream_issues SET state = $1 WHERE id = $2'],
      ['scripts/sneaky-quoted.mjs', 'UPDATE "upstream_issues" SET "state" = \'fixed\' WHERE id = $1'],
    ]);
    const hits = findStateWriters(files);
    assert.deepEqual(hits, ['scripts/sneaky-quoted.mjs']);
  });

  it('poison-pill direction (round-3 audit H1): UPDATE ONLY is detected', () => {
    const files = new Map([
      ['scripts/lib/store/upstream-issues.mjs', 'UPDATE upstream_issues SET state = $1 WHERE id = $2'],
      ['scripts/sneaky-update-only.mjs', "UPDATE ONLY upstream_issues SET state = 'fixed' WHERE id = $1"],
    ]);
    const hits = findStateWriters(files);
    assert.deepEqual(hits, ['scripts/sneaky-update-only.mjs']);
  });

  it('poison-pill direction (round-3 audit M18): a DYNAMIC import is detected', () => {
    const files = new Map([
      ['scripts/lib/store/upstream-issues.mjs', 'export async function transitionUpstreamIssue() {}'],
      ['scripts/sneaky-dynamic-import.mjs', "const { transitionUpstreamIssue } = await import('./lib/store/upstream-issues.mjs');\ntransitionUpstreamIssue({ id, to: 'fixed' });"],
    ]);
    const hits = findStateWriters(files);
    assert.deepEqual(hits, ['scripts/sneaky-dynamic-import.mjs']);
  });

  it('poison-pill direction (round-4 audit H4): a tuple-assignment SET (state, disposition) = (...) is detected', () => {
    const files = new Map([
      ['scripts/lib/store/upstream-issues.mjs', 'UPDATE upstream_issues SET state = $1 WHERE id = $2'],
      ['scripts/sneaky-tuple.mjs', "await db.query(\"UPDATE upstream_issues SET (state, disposition) = ('fixed', 'exempt:x') WHERE id = $1\")"],
    ]);
    const hits = findStateWriters(files);
    assert.deepEqual(hits, ['scripts/sneaky-tuple.mjs']);
  });

  it('poison-pill direction (round-4 audit M10): a destructuring-RENAME of a dynamic import is detected', () => {
    const files = new Map([
      ['scripts/lib/store/upstream-issues.mjs', 'export async function transitionUpstreamIssue() {}'],
      ['scripts/sneaky-destructure-rename.mjs', "const { transitionUpstreamIssue: transition } = await import('./lib/store/upstream-issues.mjs');\ntransition({ id, to: 'fixed' });"],
    ]);
    const hits = findStateWriters(files);
    assert.deepEqual(hits, ['scripts/sneaky-destructure-rename.mjs']);
  });

  it('poison-pill direction (round-5 audit M2): a COMPUTED property access on a namespace import is detected', () => {
    const files = new Map([
      ['scripts/lib/store/upstream-issues.mjs', 'export async function transitionUpstreamIssue() {}'],
      ['scripts/sneaky-computed-access.mjs', "import * as store from './lib/store/upstream-issues.mjs';\nawait store['transitionUpstreamIssue']({ id, to: 'fixed' });"],
    ]);
    const hits = findStateWriters(files);
    assert.deepEqual(hits, ['scripts/sneaky-computed-access.mjs']);
  });

  it('poison-pill direction (round-6 audit H1): a bare require() chained call is detected', () => {
    const files = new Map([
      ['scripts/lib/store/upstream-issues.mjs', 'export async function transitionUpstreamIssue() {}'],
      ['scripts/sneaky-require.mjs', "require('./lib/store/upstream-issues.mjs').transitionUpstreamIssue({ id, to: 'fixed' });"],
    ]);
    const hits = findStateWriters(files);
    assert.deepEqual(hits, ['scripts/sneaky-require.mjs']);
  });

  it('negative control: an UNRELATED import from the store module (e.g. LEGAL_TRANSITIONS) is not flagged', () => {
    const files = new Map([
      ['scripts/lib/store/upstream-issues.mjs', 'export const LEGAL_TRANSITIONS = {};\nexport async function transitionUpstreamIssue() {}'],
      ['scripts/reads-a-constant.mjs', "import { LEGAL_TRANSITIONS } from './lib/store/upstream-issues.mjs';\nconsole.log(LEGAL_TRANSITIONS);"],
    ]);
    const hits = findStateWriters(files);
    assert.deepEqual(hits, []);
  });
});

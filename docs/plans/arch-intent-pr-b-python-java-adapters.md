# Plan: Architecture-Intent PR-B — Python & Java Adapters

- **Date**: 2026-05-15
- **Status**: Complete (implemented + audited via /cycle; /audit-code → Gemini APPROVE 2026-05-15; see audit summary at docs/completed/arch-intent-pr-b-audit-summary.md)
- **Author**: Claude + Louis
- **Scope**: backend
- **Target domain(s)**: `shared-lib` (the `arch-intent/` module tree), `audit-orchestration` (stack detection)
- **Parent plan**: [architecture-intent-framework.md](../completed/architecture-intent-framework.md) — this is PR-B of the 3-PR series (§10, §11).

> **Neighbourhood considered** — explored directly (deeper than embedding
> search). [scripts/lib/arch-intent/adapters/js-ts.mjs](../../scripts/lib/arch-intent/adapters/js-ts.mjs)
> is the **reuse template** — the new adapters mirror its structure exactly.
> [scripts/lib/arch-intent/domain-resolver.mjs](../../scripts/lib/arch-intent/domain-resolver.mjs)
> (`resolveFileToDomain`, `checkDepAllowed`, `VENDOR_DOMAIN`) is stack-agnostic
> and **reused as-is** — no new domain-resolution code. The adapter contract
> in [adapter-contract.mjs](../../scripts/lib/arch-intent/adapter-contract.mjs)
> is **frozen** — PR-B conforms to it, does not modify it.

---

## 1. Context Summary

**Detected scope**: backend. **Stack**: js-ts (the tool repo). **Python framework**: n/a.

**What exists today (PR-A, shipped in commit `6c6be92`)**:
- The framework spine: `adapter-contract.mjs` runs a two-phase analysis —
  Phase 1 (inventory: glob → domain rules → `mapped`/`unmappedFiles`),
  Phase 2 (per-stack adapter edge analysis with fault isolation).
- One concrete adapter: `js-ts.mjs` — uses `dependency-cruiser` to extract
  the import graph, classifies edges via a canonical taxonomy, checks each
  against `domainMap.allowedDeps`, emits violations.
- The adapter contract: every adapter exports
  `default async function analyseImports({mapped, domainMap, repoPath})`
  returning `{violations, _meta, analyzerVersion}`.
- `ArchIntentViolationSchema`, `ArchIntentReportSchema`, `DomainMapSchema`
  in `schemas.mjs`. The `stackKinds` enum **already includes `java` and
  `postgres`** — schema is forward-ready.
- `loadAdapter(stackKind)` in `adapter-contract.mjs` dynamically imports
  `./adapters/${stackKind}.mjs`; a missing file → `unsupported` status
  (graceful), a present-but-broken file → `ArchIntentAnalyzerError`.

**Patterns reused vs new**:
- *Reused*: the contract, `domain-resolver.mjs`, the per-stack fault
  isolation, the `_meta` early-return shape discipline (js-ts R2/M3 fix),
  the `analyzerVersion` string convention.
- *New*: two pure-JS source parsers (Python imports, Java imports). Unlike
  js-ts there is no off-the-shelf cruiser — we parse import statements
  directly. This is the deliberate design choice below.

**The two design tensions (resolved)**:

### Tension 1 — Python: `import-linter` vs pure-JS parser

The parent plan §10 said "swap dependency-cruiser for import-linter".
**Rejected.** `import-linter` is a *Python package* — it would require:
(a) a Python interpreter installed wherever `/audit-code` runs (CI, every
consumer repo); (b) its own `.importlinter` contract file, creating a
**second source of truth** alongside `domain-map.json` (violates parent
plan's "domain-map.json is the SOLE machine-readable SoT", §0).

**Decision**: the Python adapter parses Python `import` statements directly
in JavaScript — no Python runtime, no second config. This mirrors how
js-ts uses a pure-Node library: the analysis is self-contained. Python's
import grammar is regular enough to parse reliably (see §2).

### Tension 2 — Java: ArchUnit code-gen vs pure-JS parser

The parent plan §8 said the Java adapter "generates ArchUnit test files
into consumer Java repos". **Rejected as an adapter.** The adapter contract
is `analyseImports(...) → {violations, _meta}` — a *synchronous, in-process*
return. ArchUnit codegen is fundamentally different: it writes `.java` files
that surface violations only when the consumer's *own* Gradle/Maven build
runs them — out-of-band, asynchronous, requires a JVM. It cannot return
`violations` to `runArchIntentAnalysis`. Forcing it into the contract would
mean either (a) the contract grows an async out-of-band mode (scope blow-up,
breaks `isArchIntentReportClean`), or (b) the Java adapter always returns
`violations: []` and the real check happens elsewhere (silent — the audit
would always show Java as clean).

**Decision**: the Java adapter parses Java `import` declarations directly
in JavaScript and returns violations like every other adapter. ArchUnit
test-file generation is a *different feature* (a consumer-side enforcement
artefact) and is explicitly **out of scope** for PR-B — noted in §8 as a
deferred idea, not built here.

---

## 1.5 Mandatory Pre-Implementation Consultation (M2 fix)

PR-B introduces new parser functions and source-file parsing logic. Per
AGENTS.md, two consultations are MANDATORY before writing this code and
MUST be run at the start of /cycle Step 3 (implementation):

1. **Architectural-memory** — new functions/modules:
   ```bash
   node scripts/cross-skill.mjs get-neighbourhood --json '{
     "targetPaths": ["scripts/lib/arch-intent/adapters/python.mjs",
                     "scripts/lib/arch-intent/adapters/java.mjs"],
     "intentDescription": "pure-JS Python and Java import-statement parsers + resolution indexes for the arch-intent adapter contract",
     "k": 8
   }'
   ```
   Act on the `recommendation` column. The `js-ts.mjs` adapter is the
   known `extend`/`reuse` template; any returned `reuse` ≥0.90 candidate
   must be reused or the divergence justified in the Implementation Log.

2. **Security-incident** — PR-B is input-parsing code (reads + parses
   arbitrary source files from consumer repos):
   ```bash
   node scripts/cross-skill.mjs get-incident-neighbourhood --json '{
     "targetPaths": ["scripts/lib/arch-intent/adapters/python.mjs",
                     "scripts/lib/arch-intent/adapters/java.mjs"],
     "intentDescription": "parsing untrusted source files for import extraction",
     "k": 3
   }'
   ```
   Any incident with `mitigation-failing` or
   `manual-verification-required` status that matches must be addressed
   in the implementation (e.g. ReDoS-safe regexes — the import matchers
   must use bounded patterns, no catastrophic backtracking, since they
   run over attacker-influenceable file content).

Consultation output is recorded in the Implementation Log (§Implementation
Log) with the action taken. `cloud:false` → log the `npm run arch:refresh`
hint and proceed. This is acceptance criterion #7.

## 2. Proposed Architecture

```
runArchIntentAnalysis (adapter-contract.mjs)        [PR-A — unchanged]
  │
  ├─ Phase 1: inventoryFiles → mapped, unmappedFiles  [PR-A — unchanged]
  │
  └─ Phase 2: for each stackKind → loadAdapter        [PR-A — unchanged]
       ├─ adapters/js-ts.mjs       [PR-A]
       ├─ adapters/python.mjs      [PR-B — NEW]
       └─ adapters/java.mjs        [PR-B — NEW]

detectRepoStack (repo-stack.mjs)                     [PR-B — EXTENDED]
  push 'java' to stackKinds when Java markers found
  ('python' already detected; 'js-ts' already detected)
```

### 2.1 Python adapter — `adapters/python.mjs`

**Contract conformance**: `default async function analyseImports({mapped, domainMap, repoPath})`
→ `{violations, _meta, analyzerVersion}`. Same shape as js-ts (#2 SoT, #20 flexibility).

#### 2.1.1 Lexical preprocessing — `stripPythonCommentsAndStrings(source)` (H4 fix)

NOT a naive comment remover. A character-level scanner with explicit state
for every Python string form. It walks the source once, emitting each
character UNLESS inside a comment or string literal (those positions emit a
space, preserving line/column so `line` numbers in `_meta` stay accurate):

- **Comment**: `#` to end-of-line (when not inside a string).
- **String delimiters**: `'`, `"`, `'''`, `"""` — triple-quote checked first.
- **String prefixes**: an identifier run of `[rRbBfFuU]{1,2}` immediately
  before a quote is consumed as a prefix; the string body still gets
  stripped regardless of prefix.
- **f-strings — brace-depth tracking (G1 fix, PEP 701)**: when the consumed
  prefix contains `f`/`F`, the scanner tracks `{`/`}` depth inside the
  string. A closing quote terminates the f-string ONLY at brace-depth 0.
  Inside an interpolation (`{...}`, depth ≥ 1) the content IS code — Python
  3.12+ permits the SAME quote character there (`f"Status: { "x" }"`), and
  nested strings inside the braces are scanned as their own string spans
  (their quotes do not terminate the outer f-string). `{{` / `}}` are
  literal-brace escapes and do not change depth. This prevents the
  state-corruption Gemini flagged: without it, the first inner quote would
  wrongly close the f-string and desync every subsequent string boundary.
  Interpolation code is blanked too (an f-string expression is not an
  `import` statement) — only the brace depth needs tracking, not the
  expression's meaning.
- **Escapes**: `\<anychar>` consumes both characters and does NOT terminate
  the string — in **both** normal and raw strings (G3 fix). Python's raw
  strings keep the backslash literally, but a backslash STILL prevents the
  next quote from closing the string: `r"\""` is a valid raw string
  containing `\` then `"`. The scanner's job is only to find where the
  string ends, so the rule "`\` + next char → consume both, don't
  terminate" is correct and identical for raw and non-raw. (The
  raw-vs-normal distinction only affects the string's runtime *value*,
  which is irrelevant to blanking.) The sole true exception — a string
  may not end with an odd number of backslashes — is a syntax error in
  Python anyway and needs no special handling.
- **Line continuation**: a `\` at physical end-of-line joins the next line
  (matters for multi-line `import` statements).

Output: source with all comment + string bytes blanked, newlines preserved.
Pure function, exported, exhaustively unit-tested (§9).

#### 2.1.2 Source-root discovery — `discoverPythonRoots(repoPath, mapped)` (H2 fix)

Python import roots are inferred from FOUR signals, in precedence order.
This handles PEP 420 namespace packages and modern `src/` layouts where
`__init__.py` is absent (the `__init__.py`-only model of the R1 draft was
unsound — H2):

1. **Packaging metadata, anywhere in the tree** (authoritative when present,
   G2 fix — monorepo-aware): find EVERY `pyproject.toml` / `setup.cfg`
   among the mapped files (not just the repo root). For each, read
   `[tool.setuptools] package-dir`, `[tool.poetry] packages`,
   `[tool.setuptools.packages.find] where`, or `setup.cfg [options]
   package_dir`. The metadata file's own directory, joined with any
   declared package-dir (e.g. `src`), is a root. So `apps/service-a/
   pyproject.toml` declaring `src` yields the root `apps/service-a/src`.
2. **`src/` convention, at any depth** (G2 fix): any directory named `src`
   that contains mapped `.py` files is a root — covers `src/` layouts and
   nested `apps/*/src/` monorepo layouts even with no metadata and no
   `__init__.py` (PEP 420 namespace packages).
3. **`__init__.py` walk** (regular packages): for each mapped file in a
   directory that DOES contain a mapped `__init__.py`, walk up while parent
   dirs also have a mapped `__init__.py`; the directory above the topmost
   one is a root.
4. **Repo root** is ALWAYS included last (flat-layout fallback).

Result: a deduplicated, deterministically-sorted `string[]` of repo-relative
roots. Resolution (§2.1.3) tries roots in this precedence order; first hit
wins. A module that resolves under NO root → `unresolved` (§2.4), never
silently dropped. (#3 no-hardcoding, #20 flexibility — data-driven from
real packaging signals, not a single hard assumption.)

#### 2.1.3 Module index — `buildPythonModuleIndex(mapped, roots)` (M2 + H1 fix)

Built ONCE per adapter run. **Each file is indexed under EXACTLY ONE root —
the most-specific (longest) root that is a path-prefix of it** (H1 fix).
Indexing `src/pkg/mod.py` under both `''` and `src` produced the bogus alias
`src.pkg.mod` AND risked two distinct files colliding on one dotted name in
the Map. With most-specific-root-wins, `src/pkg/mod.py` (roots `['', 'src']`)
indexes only as `pkg.mod`.

Two immutable Maps:

- `moduleToFile: Map<dottedName, filePath>` — dotted name computed relative
  to the file's single most-specific root. `src/a/b.py` under root `src` →
  `a.b`. `src/a/__init__.py` → package `a`.
- `packageDirs: Set<dottedName>` — every dotted name backed by an
  `__init__.py`.

If two files still resolve to the same dotted name (genuine duplicate —
e.g. the same module under two roots that are NOT prefixes of each other),
the collision is recorded in `_meta.indexCollisions: [{dottedName,
files:[...]}]` and the FIRST (sorted) file wins deterministically — never a
silent last-write-wins. All subsequent resolution is O(1) Map lookups.

#### 2.1.4 Import extraction — `extractImports(source)` (H2 input)

After lexical stripping, match the two forms, capturing `line`:

- `import a.b.c` / `import a.b.c as d` / `import a, b.c` (comma list — each
  comma segment is one ImportRef).
- `from a.b import x, y` / `from a.b import (x, y)` (parenthesised, possibly
  multi-line) / `from a.b import *` / `from . import m` / `from ..pkg import n`.

ImportRef shape: `{kind:'import'|'from', module, names:string[], isRelative,
dotCount, line}`.

#### 2.1.5 Resolution semantics — three-state (H2 + H3 fix)

Every import edge resolves to exactly ONE of three states — the canonical
§2.4 table applied to Python:

| State | Meaning | Treatment |
|---|---|---|
| `resolved-local` | resolves to a file in `mapped` via `moduleToFile` | domain-checked against `allowedDeps` |
| `proven-external` | the **top-level package** is in `PYTHON_STDLIB` (a frozen built-in list — `os`, `sys`, `json`, `collections`, …) | mapped to `VENDOR_DOMAIN`; always allowed |
| `unresolved` | neither — not in `mapped`, not a known stdlib root (third-party packages, out-of-tree relative imports, resolver gaps all land here) | recorded in `_meta.unresolvedEdges`; **NOT auto-allowed, NOT a violation** — exactly matches js-ts's handling of `couldNotResolve` edges |

**`from a.b import c` — explicit semantics (H2 + G3 fix)**: the dependency is
always recorded against the module being imported FROM — resolve `a.b`:
- If `a.b` → a mapped file (module `a/b.py` or package `a/b/__init__.py`),
  that is the edge target.
- ADDITIONALLY, for each imported name `c`: attempt `moduleToFile` lookup of
  `a.b.c` **unconditionally** — if it resolves to a mapped file, `c` is a
  submodule, record a SECOND edge to it. The R2 draft gated this on "`a.b`
  is a package" (present in `packageDirs`) — **dropped (G3 fix)**: a PEP 420
  namespace package has no `__init__.py`, so it is absent from `packageDirs`,
  and the gate would wrongly skip submodule resolution for every namespace
  package. The `moduleToFile` lookup IS the test — if `a.b.c` is in the
  index it is a real submodule regardless of how `a.b` is packaged. We do
  NOT parse `a/b.py` to prove a symbol exists — symbol-level imports
  collapse to the module edge, the correct granularity for domain analysis.
- `import a.b.c` records the single edge to the leaf module `a.b.c` (or its
  `__init__.py` if it is a package). Ancestor packages `a`, `a.b` are not
  separately recorded — the leaf edge already establishes the domain coupling.

**Relative imports**: `dotCount` leading dots resolve against the importing
file's package. 1 dot = current package, 2 = parent, etc. Resolve to a
candidate dotted name, then through `moduleToFile`. A relative import whose
dot-count walks above every source root → `unresolved` (recorded in
`_meta.unresolvedEdges`, never a violation).

**Edge-kind taxonomy** (recorded in `_meta` for transparency):

| Kind | Pattern | Treatment |
|---|---|---|
| `local-module` / `local-package` | `resolved-local` | domain-checked |
| `vendor` | `proven-external` | always allowed |
| `unresolved` | see §2.4 | `_meta.unresolvedEdges`; not flagged |
| `star-import` | `from x import *` | the edge to `x` is resolved + checked normally; `*` is irrelevant to the dependency |

**Conditional imports** (`import` nested in `try`/`if`/`def`) are NOT
specially classified (M1 fix). An import inside a `try:` block is still a
real domain coupling and is checked identically to a top-level import.
Distinguishing "conditional" would require an indentation-aware block
parser for zero checking benefit — deliberately dropped. Every matched
import statement, wherever it sits, is one edge.

**`_meta` shape** (fixed keys, always present — js-ts R2/M3 discipline):
`{edgeCount, localEdges, vendorEdges, unresolvedEdges:[], starImports,
indexCollisions:[], sourceRoots:[], allFiles:[]}`.

`analyzerVersion`: `'python-1.0.0'`.

### 2.2 Java adapter — `adapters/java.mjs`

**Contract conformance**: identical signature + return shape.

#### 2.2.1 Lexical preprocessing — `stripJavaCommentsAndLiterals(source)`

Character-level scanner: removes `//` line comments, `/* */` block comments,
double-quoted strings, single-quoted char literals, and Java text blocks
(`"""`). Escape-aware. Newlines preserved for accurate `line` numbers.

#### 2.2.2 Resolution index — `buildJavaResolutionIndex(mapped)` (M2 + M3 fix)

Built ONCE per run. Java FQN resolution is by parsed `package` declaration,
NOT by path-suffix guessing:

1. For each mapped `.java` file: strip, then read the first `package x.y.z;`
   declaration. The file's FQN is `package + '.' + <ClassName from filename>`.
   A file with no `package` declaration is in the default package.
2. Derive the file's **source root**: the path prefix obtained by removing
   the package-dir-chain from the file path. `src/main/java/com/foo/Bar.java`
   with package `com.foo` → source root `src/main/java`. This disambiguates
   `src/main/java` vs `src/test/java` (M3).
3. Build:
   - `fqnToFiles: Map<fqn, filePath[]>` — usually 1 file; >1 only across
     distinct source roots (e.g. main + test).
   - `packageToFiles: Map<packageName, filePath[]>` — for wildcard imports.
   - `fileToSourceRoot: Map<filePath, sourceRoot>`.

#### 2.2.3 Resolution semantics

Match `import com.foo.Bar;`, `import com.foo.Outer.Inner;`,
`import com.foo.*;`, `import static com.foo.Bar.m;`,
`import static com.foo.Outer.Inner.CONST;`.

Each `extractImports` ref carries `{fqn, isWildcard, isStatic, line}`.
Resolution branches on the `isStatic`/`isWildcard` pair — four cases.

**`progressiveResolve(fqn)`** — the shared subroutine: try
`fqnToFiles.get(fqn)`; on miss, strip the trailing dotted segment and retry,
until a hit or the FQN has ≤1 segment. **No uppercase-letter heuristic**
(G1 fix — the heuristic broke lowercase static members). It is unnecessary:
`fqnToFiles` contains ONLY real `package.ClassName` keys, so a package-prefix
never spuriously hits — stripping is self-correcting against the index.
Outcome:
  - 1 file → that edge.
  - >1 file (same FQN across source sets) → prefer the candidate whose
    source root equals the importing file's source root; residual ties
    recorded in `_meta.ambiguousEdges` (transparent), all edges kept.
  - 0 files after full stripping → `proven-external` if the FQN top segment
    is a `JAVA_VENDOR_PREFIXES` entry (`java.`, `javax.`, `jakarta.`,
    `kotlin.`); else `unresolved` → `_meta.unresolvedEdges`, never a violation.

**Case 1 — plain import** (`isStatic:false, isWildcard:false`):
`import com.foo.Bar;`, `import com.foo.Outer.Inner;` → `progressiveResolve(fqn)`
directly. Nested type `com.foo.Outer.Inner` misses, strips to `com.foo.Outer`,
hits `Outer.java`.

**Case 2 — static member import** (`isStatic:true, isWildcard:false`):
`import static com.foo.Bar.method;`, `import static com.foo.Outer.Inner.CONST;`.
The trailing segment is always a member (method/field), lowercase OR
uppercase — strip it **unconditionally once**, then `progressiveResolve` the
remainder. `com.foo.Bar.method` → strip → `progressiveResolve('com.foo.Bar')`
→ `Bar.java`. (G1 fix — `method` being lowercase no longer blocks resolution.)

**Case 3 — package wildcard** (`isStatic:false, isWildcard:true`):
`import com.foo.*;` — `com.foo` is a package. `packageToFiles.get('com.foo')`
→ the set of mapped files, hence the domains the package occupies. Emit
**one edge per distinct target DOMAIN** (not per file — G1's sibling R3-H2
fix: a wildcard opens a namespace, it does not prove use of every class).
`{fromFile, toFile:'com.foo.*' (namespace marker), fromDomain, toDomain,
ruleViolated}`. Recorded in `_meta.wildcardEdges`.

**Case 4 — static wildcard** (`isStatic:true, isWildcard:true`):
`import static com.foo.Bar.*;` — here `com.foo.Bar` is a **class**, not a
package (G2 fix — looking it up in `packageToFiles` would always miss). Strip
the `.*`, then `progressiveResolve('com.foo.Bar')` → exactly like Case 2's
remainder → one edge to `Bar.java`. Recorded in `_meta.staticImports`.

Empty/0-match outcomes in every case follow the §2.4 table (`proven-external`
via vendor prefix, else `unresolved`).

**Same-package coupling — soundness rule (H3 fix)**. Java classes in the
same package need no `import`, so same-package references are invisible to
an import parser. The R1 draft dismissed this as "almost always one domain"
— **unsound**, because the source-set model the adapter itself uses
(`src/main/java` vs `src/test/java`) routinely puts the *same package*
(`com.foo`) into *different domains* (e.g. `app` vs `tests`). A
same-package test→main reference would then be a real cross-domain edge the
parser cannot see.

PR-B does not attempt to detect same-package *type usage* (that needs full
type resolution — out of scope). Instead it makes the blind spot **explicit
and bounded**:

1. After building the resolution index, compute, for every Java package,
   the set of domains its mapped files belong to (via `mapped`).
2. Any package whose files span >1 domain is recorded in
   `_meta.packagesSpanningDomains: [{package, domains:[...], files:[...]}]`.

This stays in `_meta` rather than `violations` — a package spanning domains
is not a file→file dependency edge, so it cannot be a well-formed
`ArchIntentViolationSchema` entry (no real `fromFile`/`toFile`). It IS,
however, part of the report the architecture audit pass reads: the
LLM-bouncer prompt already receives `_meta`, so a non-empty
`packagesSpanningDomains` surfaces to the operator as "same-package
references inside these packages are NOT import-checked — a known blind
spot". A silent false-negative becomes a visible, documented limitation
without needing a type checker. The §8 risk row is updated accordingly.

**Edge-kind taxonomy**: `local-class`, `local-wildcard`, `static-import`,
`vendor` (proven-external), `unresolved`, `ambiguous`.

**`_meta` shape**: `{edgeCount, localEdges, wildcardEdges, vendorEdges,
staticImports, unresolvedEdges:[], ambiguousEdges:[],
packagesSpanningDomains:[], sourceRoots:[], allFiles:[]}`.

`analyzerVersion`: `'java-1.0.0'`.

### 2.3 Stack detection — `repo-stack.mjs` extension (M1 fix)

**Ground truth (G4 fix)**: `detectRepoStack()` today does NOT enumerate
files — it only runs `fs.existsSync` against a hardcoded list of repo-root
markers (`package.json`, `pyproject.toml`, …) and pushes `js-ts`/`python`
to `stackKinds`. The R2 draft wrongly claimed it "already performs" a
`git ls-files` enumeration; it does not. PR-B must ADD the capability, not
assume it.

PR-B extends `detectRepoStack()` with Java detection that is **data-driven**,
not root-marker-only (M1 — monorepos place `.java` under nested modules with
no root `pom.xml`). Push `'java'` to `stackKinds` when EITHER:

1. **Fast path** — a Java build marker exists in the repo root: `pom.xml`,
   `build.gradle`, `build.gradle.kts`, or `settings.gradle` (same
   `fs.existsSync` style the function already uses; cheap, no subprocess).
2. **Enumeration path** — a NEW bounded check: `execSync('git ls-files
   -- "*.java"', {stdio:['ignore','pipe','ignore']})` returns ≥1 path. This
   mirrors the `git ls-files` usage already proven in
   `adapter-contract.mjs::inventoryFiles`. Wrapped in try/catch — when the
   repo is not a git checkout, the catch path falls back to fast-path-only
   (root markers). No recursive `fs` walk is added; `git ls-files` is the
   bounded enumeration.

`repo-stack.mjs`'s module header ("filesystem-only, synchronous") is
updated to "filesystem + `git ls-files`, synchronous" to stay accurate —
`execSync` is a subprocess, not network, consistent with the no-network
guarantee.

The top-level `stack` field (`js-ts|python|mixed|unknown`) keeps its
current meaning — NOT extended to a Java value. That field feeds the
`/plan` principle-profile selector, which has no Java profile; changing
it is out of scope. Only `stackKinds` gains `java` — that is all the
arch-intent adapter selector (`openai-audit.mjs:1095`) reads. Deliberate,
documented split (§8).

`postgres` detection stays absent — that is PR-C.

### 2.4 Canonical resolution table (shared by both adapters + all tests)

One authoritative classification both adapters and the test suite reference
(H1 fix — no per-section drift). Resolution is attempted strictly in this
order; the first matching row decides:

| Order | Condition | State | Edge treatment |
|---|---|---|---|
| 1 | Import resolves (via the per-adapter index) to a file present in `mapped` | `resolved-local` | domain-checked against `allowedDeps`; may emit a violation |
| 2 | Python: top-level package ∈ `PYTHON_STDLIB`. Java: FQN starts with a `JAVA_VENDOR_PREFIXES` entry | `proven-external` | target domain = `VENDOR_DOMAIN`; always allowed; counted in `_meta.vendorEdges` |
| 3 | None of the above — the resolver could not place the import | `unresolved` | recorded in `_meta.unresolvedEdges`; **NOT** auto-allowed, **NOT** a violation; never mapped to `vendor` |

Invariant: an import is `proven-external` ONLY via row 2 — an explicit
allowlist match (stdlib set / vendor prefix). Everything the resolver
cannot place as `resolved-local` and cannot prove via the allowlist is
`unresolved` (row 3), always — it never falls through to `vendor`.

The R2 draft had a fourth "resolves cleanly to a path outside the audited
tree" row; **dropped (R3-M2)** — it required a filesystem probe neither
adapter specifies, and `unresolved` already covers that case correctly
(an out-of-tree import is simply something the index can't place → row 3,
visible in `_meta`, harmless). Tests assert one representative case per
row for each adapter.

### Key design decisions

- **Pure-JS parsers, no target runtime** (#20 long-term flexibility, #16
  graceful degradation): the audit tool must run anywhere Node runs.
  Requiring Python or a JVM to audit a polyglot repo would make the
  architecture pass fragile and frequently `SKIPPED`.
- **Comment/string stripping before import matching** (#12 validation):
  the #1 false-positive risk is matching `import` inside a string or
  comment. Both adapters strip first, match second.
- **Three-state resolution, never unresolved→vendor** (#15 error handling,
  H3-fix): an import resolves to exactly one of `resolved-local`,
  `proven-external`, or `unresolved` (the canonical table in §2.4). Only
  `proven-external` (stdlib set / known vendor prefix / resolves cleanly
  outside the audited tree) auto-allows. `unresolved` is recorded in
  `_meta.unresolvedEdges` — visible, never silently absorbed into `vendor`,
  never a violation. This keeps resolver gaps observable rather than hidden
  as false-clean.
- **Adapters share zero code with each other** (#2 modularity): both import
  only from `domain-resolver.mjs` and `node:` builtins. A bug in one adapter
  cannot affect another — reinforces the contract's fault-isolation design.

---

## 6. Sustainability Notes

- **Assumption**: import statements are statically analysable. True for the
  vast majority of Python/Java. Dynamic imports (`importlib.import_module`,
  Java reflection) are invisible — accepted, same limitation js-ts has with
  `await import(variable)`. Documented in §8.
- **If a third parser is needed** (PR-C Postgres, or Go/Rust later): the
  contract already supports it — drop a new `adapters/<kind>.mjs`, extend
  `repo-stack.mjs` detection. No contract change. PR-B proves this
  extension path works by exercising it twice.
- **Parser robustness seam**: each adapter's import-matching is one pure
  function (`extractImports(source) → ImportRef[]`) that is unit-tested in
  isolation from file resolution. If a parser needs hardening later (a new
  syntax edge case), the fix is localised to that function.
- **Comment-stripping is shared-shaped but not shared-code**: Python uses
  `#` + triple-quote; Java uses `//` + `/* */`. Different enough that a
  shared util would be a forced abstraction (#1 DRY is about knowledge, not
  coincidental shape). Each adapter owns its stripper.

---

## 7. File-Level Plan

### New files

#### `scripts/lib/arch-intent/adapters/python.mjs` (~260 LOC)
- `default async function analyseImports({mapped, domainMap, repoPath})` — contract entry.
- `stripPythonCommentsAndStrings(source)` — pure char-level scanner; blanks
  comments + every string form (single/double/triple, prefixed, escape-aware).
  Exported for tests.
- `extractImports(source)` — pure: stripped source → `[{kind, module, names,
  isRelative, dotCount, line}]`. Exported for tests.
- `discoverPythonRoots(repoPath, mapped)` — reads `pyproject.toml` /
  `setup.cfg` under `repoPath` (so it is NOT pure — it does fs reads) plus
  the `src/` + `__init__.py` signals; returns the sorted source-root list
  in precedence order. Signature matches §2.1.2. Exported for tests (tests
  pass a fixture `repoPath`).
- `buildPythonModuleIndex(mapped, roots)` — pure: → `{moduleToFile, packageDirs}`.
  Exported for tests.
- `resolvePythonImport(ref, fromFile, index, roots)` — ImportRef → `{state,
  targetFile?}` where state ∈ `resolved-local|proven-external|unresolved`.
- `PYTHON_STDLIB` — frozen Set of stdlib top-level package names.
- Imports: `node:path`, `node:fs`, `domain-resolver.mjs`. Nothing else.

#### `scripts/lib/arch-intent/adapters/java.mjs` (~240 LOC)
- `default async function analyseImports({mapped, domainMap, repoPath})` — contract entry.
- `stripJavaCommentsAndLiterals(source)` — pure char-level scanner; blanks
  `//`, `/* */`, strings, char literals, text blocks. Exported for tests.
- `extractImports(source)` — pure: stripped source → `[{fqn, isWildcard,
  isStatic, line}]`. Exported for tests.
- `extractPackage(source)` — pure: stripped source → package name or `''`.
  Exported for tests.
- `buildJavaResolutionIndex(mapped)` — pure: → `{fqnToFiles, packageToFiles,
  fileToSourceRoot}`. Exported for tests.
- `resolveJavaImport(ref, fromFile, index)` — ImportRef → `{state, targetFiles[],
  ambiguous?}`.
- `JAVA_VENDOR_PREFIXES` — frozen list (`java.`, `javax.`, `jakarta.`, `kotlin.`).
- Imports: `node:path`, `node:fs`, `domain-resolver.mjs`. Nothing else.

#### `tests/arch-intent-adapter-python.test.mjs` (~140 LOC)
- Unit tests for `stripPythonComments`, `extractImports` (absolute, relative,
  `as`-alias, comma-list, parenthesised, star, conditional).
- Integration: run `analyseImports` against the fixture repo; assert
  violations + `_meta` shape.

#### `tests/arch-intent-adapter-java.test.mjs` (~140 LOC)
- Unit tests for `stripJavaComments`, `extractImports` (plain, wildcard,
  static, multiple).
- Integration: run `analyseImports` against the fixture repo.

#### `tests/fixtures/arch-intent-python/` (~8 files)
Synthetic Python repo: 3 domains (`core`, `app`, `tests`), one deliberate
`app → tests` violation, one same-domain edge (allowed), one stdlib import
(vendor), one relative import, one conditional import.

#### `tests/fixtures/arch-intent-java/` (~8 files)
Synthetic Java repo: package-structured (`com/example/core`, `com/example/app`),
one deliberate cross-domain violation, one wildcard import, one static
import, one JDK import (vendor).

### Modified files

#### `scripts/lib/repo-stack.mjs` (~16 LOC)
Add data-driven Java detection (M1 + G4): push `'java'` to `stackKinds`
when a root build marker exists (`fs.existsSync` fast path) OR
`git ls-files -- "*.java"` returns ≥1 path (new bounded `execSync`
enumeration, try/catch with fast-path fallback for non-git repos). Update
the module header to "filesystem + `git ls-files`, synchronous". No change
to the top-level `stack` field or `pythonFramework`.

#### `tests/repo-stack.test.mjs` (existing file — add ~24 LOC of cases)
The file exists. Add cases asserting `stackKinds` includes `'java'` for
(a) a repo with `pom.xml`, (b) a repo with `.java` files but no root marker
(monorepo case), and excludes `'java'` for a pure JS repo.

#### `scripts/sync-to-repos.mjs` (~2 LOC)
**Correction to the R2 draft**: PR-A's plan claimed `scripts/lib/arch-intent/**`
was subtree-synced; in reality `sync-to-repos.mjs` enumerates each arch-intent
file **individually** in `CORE_SCRIPTS` (with a comment explicitly saying
"add new files … to this list as they're created"). PR-B therefore MUST add
`scripts/lib/arch-intent/adapters/python.mjs` and `…/java.mjs` to that list —
otherwise the new adapters never reach consumer repos. Verified by §9
acceptance criterion #6.

### Files NOT modified

- `adapter-contract.mjs` — frozen. PR-B conforms; the dynamic `loadAdapter`
  already discovers `python.mjs`/`java.mjs` by filename with zero changes.
- `schemas.mjs` — `stackKinds` enum already has `java`; violation/report
  schemas are stack-agnostic. No change.

---

## 8. Risk & Trade-off Register

| Risk / Trade-off | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Pure-JS parser misses an import syntax edge case | medium | low (false negative — missed edge) | `extractImports`/`strip*` are pure unit-tested functions exercised against every taxonomy form (§9). A genuinely unresolvable import lands in `unresolved` (visible in `_meta.unresolvedEdges`), NOT silently in `vendor` — so resolver gaps are observable, not hidden (H3 three-state model). |
| Resolver bug silently passes a real local import as clean | low | medium | **Mitigated by the three-state model** — only `proven-external` (stdlib set / known vendor prefix / resolves outside the tree) auto-allows. Everything the resolver can't place is `unresolved` and surfaced in `_meta`, not absorbed into `vendor`. |
| Java same-package cross-domain coupling invisible to an import parser | certain | medium | **Made explicit, not dismissed** (H3 fix): `_meta.packagesSpanningDomains` records every Java package whose mapped files span >1 domain. The audit pass reads `_meta`, so the operator sees exactly where same-package references are NOT import-checked. Full detection needs type resolution — out of scope; the visible signal bounds the blind spot. |
| ReDoS via malicious source file (import-matcher regexes run on untrusted content) | low | medium | Import/comment matchers use bounded, linear patterns — no nested quantifiers, no catastrophic backtracking. Verified in §1.5 security consultation + acceptance criterion #7. |
| Dynamic imports invisible (`importlib.import_module`, reflection) | certain | low | Same limitation js-ts has with `await import(var)`. Accepted; documented. |
| Java FQN ambiguous across source sets (`src/main` vs `src/test`) | medium | low | `buildJavaResolutionIndex` resolves by parsed `package` declaration + source-root; ties prefer the importing file's own source root; residual ties recorded in `_meta.ambiguousEdges` (transparent), not silently dropped (M3 fix). |
| Per-run index build adds latency on huge repos | low | low | Indexes are built ONCE per adapter run (M2), O(files); all per-import resolution is O(1) Map lookup. Strictly faster than the rejected per-import rescan. |
| `repo-stack.mjs` `stack` field not extended to a Java value | n/a (deliberate) | none | Documented decision — `stack` feeds `/plan`'s principle profiles (no Java profile exists); only `stackKinds` needs `java` for adapter selection. |
| Python stdlib set goes stale as Python adds modules | low | low | The set is the top-level package names (`os`, `sys`, …) — extremely stable across Python versions. New stdlib modules are rare; a miss → `unresolved` (visible), never a false violation. Frozen constant, easy to extend. |
| **Deferred**: ArchUnit test-file generation | n/a | n/a | Explicitly out of scope. A consumer-side enforcement artefact, not an analyser adapter (would break the synchronous `→ violations` contract — see §1 Tension 2). If wanted later, a separate feature/cycle that does not touch the adapter contract. |
| **Deferred**: PR-C Postgres adapter | n/a | n/a | Separate plan, separate cycle (parent plan §11). |

---

## 9. Testing Strategy

**Unit tested** (`node --test`) — each pure helper in isolation:
- `stripPythonCommentsAndStrings` / `stripJavaCommentsAndLiterals` —
  comment + every string-literal form, including the adversarial cases:
  `import` inside a single-quoted string, double-quoted string, triple-quoted
  docstring, prefixed string (`r"..."`, `f"..."`, `b"..."`), Java text block
  (`"""`), and `import` after a `/* */` comment on the same line. Assert
  line numbers are preserved (newlines not collapsed).
- `extractImports` (both) — every syntax form in the §2 taxonomy tables.
- `discoverPythonRoots` — flat layout (root only), `src/` layout, `lib/`
  layout, nested-package layout; assert deterministic sort.
- `buildPythonModuleIndex` — dotted-name correctness for modules vs
  `__init__.py` packages across multiple roots.
- `buildJavaResolutionIndex` — `fqnToFiles`, `packageToFiles`,
  `fileToSourceRoot`; the `src/main/java` vs `src/test/java` same-FQN case.
- `resolvePythonImport` / `resolveJavaImport` — every state transition:
  `resolved-local`, `proven-external` (stdlib / vendor prefix), `unresolved`;
  Python relative-import dot-walking; Java wildcard + ambiguous.

**Integration tested**:
- `analyseImports` end-to-end against each synthetic fixture repo —
  assert the deliberate violation is caught, the same-domain edge is NOT
  flagged, the vendor edge is NOT flagged, `unresolved` edges land in
  `_meta.unresolvedEdges` (not in `violations`), and `_meta` has all fixed keys.
- Run through `runArchIntentAnalysis` with a stubbed `stackKinds:['python']`
  / `['java']` to confirm contract-level integration (per-stack envelope
  `status:'ok'`, violations merged, `validateAdapterReport` passes).

**Key edge cases**:
- Python: `from . import x` at package root; `from ..too.many.dots import y`
  walking above all source roots (→ `unresolvedEdges`, not a violation);
  `import a, b, c` comma list; `from a.b import (x, y)` parenthesised
  multi-line; star import; an import inside a `try:`/`def` body checked
  identically to a top-level one; `src/`-layout resolution; a module
  shadowing a stdlib name.
- Java: `import static`; an `import` split by `/* */` mid-statement; a
  `package` declaration preceded by comments; same FQN in `src/main` +
  `src/test` (→ source-root preference, else `ambiguousEdges`);
  default-package file.
- Both: a file whose imports are entirely inside a block comment / docstring
  → zero edges.

**Highest-risk regression cases — explicit coverage required (R3-L1)**:
- *Python multi-root collision*: a fixture with both `''` and `src` as
  roots where `src/pkg/mod.py` exists — assert it indexes ONLY as `pkg.mod`,
  NOT also as `src.pkg.mod`; and a deliberate two-file same-dotted-name
  collision asserts `_meta.indexCollisions` is populated and resolution is
  deterministic (first sorted file wins).
- *Java nested-type imports*: `import com.foo.Outer.Inner;` resolves to
  `Outer.java` via progressive stripping; `import static
  com.foo.Outer.Inner.CONST;` resolves to `Outer.java`; a static import
  off a lowercase package segment is NOT mis-stripped.
- *Java wildcard*: `import com.foo.*;` into a single-domain package emits
  exactly ONE edge (to the domain), not one-per-file; into a domain the
  importer is allowed to use emits zero violations regardless of class count.
- *Java static imports* (G1): `import static com.foo.Bar.method;` (lowercase
  member) resolves to `Bar.java`; `import static com.foo.Bar.*;` (static
  wildcard — `Bar` is a class) resolves to `Bar.java`, NOT a package miss.
- *Python f-string PEP 701* (G1): `f"text { "inner" } more"` with a reused
  quote inside the interpolation — assert the scanner does not desync and an
  `import` on the following line is still detected.
- *Python namespace-package submodule* (G3): `from a.b import c` where `a.b`
  is a PEP 420 namespace package (no `__init__.py`) and `a/b/c.py` is mapped
  — assert the `a.b.c` submodule edge IS recorded.
- *Python monorepo roots* (G2): a fixture with `apps/svc/pyproject.toml` +
  `apps/svc/src/pkg/mod.py` — assert `apps/svc/src` is discovered as a root
  and `pkg.mod` resolves.

**Verification (not code — a step in implementation)**:
- After implementing, run `node scripts/sync-to-repos.mjs --dry-run` and
  confirm `python.mjs` + `java.mjs` appear in the planned sync set (proves
  the subtree-sync auto-include works as the parent plan claimed).

**Acceptance criteria** (backend — not Playwright):
1. `analyseImports` in `python.mjs` and `java.mjs` each conform to the
   contract: return `{violations, _meta, analyzerVersion}`, validated by
   `validateAdapterReport` inside `runArchIntentAnalysis` with no schema error.
2. Each adapter's fixture integration test catches exactly the deliberate
   violation(s) — no false positives on same-domain or vendor edges.
3. `detectRepoStack()` returns `stackKinds` containing `'java'` for a repo
   with `pom.xml`/`build.gradle`, and not containing it otherwise.
4. `import` statements inside comments/strings/docstrings produce zero edges.
5. All new tests pass under `npm test`; no regression in existing
   `arch-intent-*` tests.
6. `node scripts/sync-to-repos.mjs --dry-run` lists both new adapter files.
7. Both mandatory consultations (§1.5) were run at the start of
   implementation and their outcomes recorded in the Implementation Log;
   import-matching regexes are bounded (no catastrophic backtracking) since
   they parse attacker-influenceable file content.

---

## Implementation Log

### 2026-05-15 — PR-B implemented (/cycle Step 3)

**Mandatory consultations (§1.5)**:
- *Architectural-memory* (`get-neighbourhood`): 8 candidates, all `review`
  band (highest `pyResolveImport` 0.744, below the 0.85 extend threshold).
  **Justified divergence — greenfield**: `pyResolveImport` /
  `detectPythonPackageRoots` in `language-profiles.mjs` are related Python
  import logic, but (1) `pyResolveImport` is module-private (not exported);
  (2) `detectPythonPackageRoots` uses the `__init__.py`-only root model the
  /audit-plan explicitly rejected (H2/G2 — no PEP 420 / monorepo support) —
  reusing it would reintroduce just-fixed bugs; (3) the plan deliberately
  keeps adapters self-contained (import only `domain-resolver.mjs` + `node:`
  builtins) for fault isolation. The greenfield resolvers were informed by
  the dot-walking pattern observed in `pyResolveImport`.
- *Security-incident* (`get-incident-neighbourhood`): 0 incidents. Bounded,
  linear regexes used regardless (no nested quantifiers) — the import/comment
  matchers run on attacker-influenceable file content (acceptance #7).

**Built**:
- `scripts/lib/arch-intent/adapters/python.mjs` — pure-JS Python adapter.
- `scripts/lib/arch-intent/adapters/java.mjs` — pure-JS Java adapter.
- `scripts/lib/repo-stack.mjs` — `hasJavaSources()` + `java` in `stackKinds`.
- `scripts/sync-to-repos.mjs` — added both adapters to `CORE_SCRIPTS`.
- `tests/arch-intent-adapter-python.test.mjs` (29 tests),
  `tests/arch-intent-adapter-java.test.mjs` (26 tests),
  `tests/repo-stack.test.mjs` (+5 Java cases).

**Deviation from plan**: §8 (inherited from PR-A's plan) wrongly claimed
`scripts/lib/arch-intent/**` was subtree-synced. It is enumerated per-file
in `CORE_SCRIPTS`. The plan's "Files NOT modified" entry was corrected to a
"Modified files" entry; both adapters explicitly added. Acceptance #6
re-verified — `sync-to-repos.mjs --dry-run` now lists both.

**Status**: full suite 2011 pass / 0 fail / 20 pre-existing skips.

### 2026-05-15 — PR-B audited (/cycle Step 4)

`/audit-code` — 3 GPT rounds + 2 Gemini rounds → **Gemini APPROVE**
(architectural coherence "Strong", 0 wrongly-dismissed).

- **GPT R1–R3**: genuine in-scope findings 7 → 3 → 3, all fixed +
  regression-tested. Recurring HIGH H1/H2 ("missing adapter-contract /
  domain-resolver / js-ts.mjs") were confirmed-false 3× — PR-A shipped
  those files; the `--files` audit scope excluded them. A large volume of
  `cross-skill.mjs` findings were correctly dismissed as out-of-scope.
- **Gemini R1 → CONCERNS**: G1 (Java import regex anchored to line-start,
  missed `package X; import Y;` / `import a; import b;`), G2 (non-static
  wildcard missed JLS 7.5.2 type-import-on-demand). Both fixed — G1 via a
  zero-width lookbehind (self-caught a `;`-consumption bug in the first
  fix attempt), G2 via progressive-resolve fallback.
- **Gemini R2 → APPROVE**: one residual MEDIUM (`git ls-files` `execSync`
  1 MiB `maxBuffer` overflow in >12k-file monorepos) — fixed by raising
  `maxBuffer` to 64 MiB.

Final: full suite 2023 pass / 0 fail / 20 pre-existing skips.

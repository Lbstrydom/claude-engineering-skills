# Plan: Python indexing for architectural memory
- **Date**: 2026-11-20
- **Status**: Complete
- **Author**: Claude + Louis
- **Scope**: backend (stack `js-ts`; the change adds a Python *target* language, not a Python codebase)
- **Target domain(s)**: `arch-memory`, `shared-lib`
- ⚠ **Cross-domain work**: it touches `arch-memory` (extractor), `shared-lib` (egress gate, sync inventory, sync banner) and adds one dependency edge from `arch-memory` to `arch-intent` (it reuses that domain's Python import resolver, §2.3). These crossings are intentional.
- **Source**: consumer field report 2, item 1 (a mostly-Python work-org consumer: 221 `.py` files and an active snapshot with 0 symbols).

## 1. Context Summary

**What happens today.** `arch:refresh` in a Python repo publishes an active snapshot with **0 symbols**:
`coverage: unverified (empty_universe)`, and all 856 files are skipped as `extension-not-allowlisted`. AGENTS.md
makes `get-neighbourhood` **mandatory** before new code is written, so for a Python repo the rule checks nothing.
There are three causes, and each is a hand-kept JS-only list:

1. **Admission.** `admitFile` refuses anything outside `DEFAULT_EXT_ALLOWLIST`, which is
   `.js .jsx .mjs .cjs .ts .tsx .vue .svelte`.
2. **Parsing.** `extractSymbols` parses only through ts-morph.
3. **Coverage universe.** `eligibleFiles` admits only `CRUISABLE_EXTENSIONS`. A Python repo therefore has an
   *empty* denominator, which gives `empty_universe` instead of an honest "Python is present and unparsed".

**Code Trace** (read at `0ce1f50e`):
- `scripts/symbol-index/extract.mjs:1116` `main()` calls `enumerateFilesWithOwnership` (:1074), then
  `extractSymbols` (:505). Per file that runs `admitFile` (:304; lexical skip, then `resolveAndClassify`
  canonical/symlink/escape check, then `isExtensionAllowlisted(canonicalRel)` (:334), then the size cap
  `MAX_FILE_BYTES` (:976)), then `loadAndParseFile` (ts-morph, :362), `classifySymbolsInFile` (:387) and
  `redactAndEmit` (:441; thin-delegate filter, `containsSecrets`, signature redaction, `emit`).
- `extract.mjs:1184` `eligibleFiles(universeFiles, …)` (`scripts/lib/symbol-index/graph-coverage.mjs:103`, which
  filters by `CRUISABLE_SET`), then `extractGraphAndViolations` (:663; dep-cruiser `cruise`, edge buckets :771,
  `assessExtractionCoverage` :810, `assertExtractionExhaustive` :825, `warnAboutParserGap` :841).
- `graph-coverage.mjs:143` `assessParserAvailability(eligible, availableExtensions)` reports
  `unavailableExtensions` from `CRUISABLE_EXTENSIONS` only.
- `scripts/lib/sensitive-egress-gate.mjs:20` `DEFAULT_EXT_ALLOWLIST`. Its other readers are `gateSymbolForEgress`
  (:309, used by the duplication detector) and `scripts/lib/arch-render.mjs:427` (the "not indexed for these file
  types" callout).
- `scripts/symbol-index/refresh-subprocess.mjs:255-264` consumes the extract child's `symbol`, `import`,
  `processed` and `coverage` records. They are language-neutral, so the summarise/embed/publish stages need no change.
- `scripts/lib/symbol-index-contracts.mjs:16` `SymbolKindEnum` already includes `method`.
- `scripts/lib/arch-intent/adapters/python.mjs:278,382,437` holds `discoverPythonRoots`,
  `buildPythonModuleIndex` and `resolvePythonImport`: an **existing, tested** Python import resolver (pyproject /
  `src/` / `__init__.py` roots, relative imports, submodule `from a import b`, stdlib allowlist). It is exported and
  pinned by `tests/arch-intent-adapter-python.test.mjs`.
- `scripts/lib/sync-inventory.mjs:58` `CORE_ASSETS` holds non-importable shipped files (precedent:
  `scripts/lib/oss-call-policy.json`, read through `new URL(…, import.meta.url)`).
  `scripts/lib/sync-banner.mjs:26` `COMMENT_TOKEN_BY_EXT` has no `.py`.
- `scripts/lib/file-taxonomy.mjs:57` `{ id: 'py', extensions: ['.py', '.pyi'] }` is the registry entry for Python.

**Neighbourhood considered** (`get-neighbourhood`, k=8): `precedent` / `above-floor-cluster` for
`scripts/symbol-index/extract.mjs::main`. Everything else is `review` (`extractSymbols`, `redactAndEmit`,
`classifySymbolsInFile`, `assessExtractionCoverage`, `assessParserAvailability`, `parseArgs`). Decision: **extend,
do not fork.** Python files go through the *same* `admitFile` and the *same* `redactAndEmit`. The new code is a
Python **parser stage** plugged in where ts-morph sits, not a second extractor. A manual search also found the
`arch-intent` Python resolver above, which the embedding query did not surface. It is **reused**, never
re-implemented (§2.3).

**Security incident neighbourhood**: INC-001 (`manual-verification-required`), a symlink with an innocent name that
resolves to a sensitive target. It applies directly: the Python helper must read **only** the canonical path that
`admitFile` approved, never a path of its own choosing. See §2.6.

## 2. Proposed Architecture

```mermaid
sequenceDiagram
    participant M as extract.mjs main()
    participant A as admitFile (unchanged gate)
    participant T as ts-morph (JS/TS)
    participant P as python-extract.mjs
    participant H as python-ast-helper.py (python -I -B)
    participant R as arch-intent resolver
    participant G as graph-coverage.mjs
    M->>A: every walked file
    A-->>M: admitted (canonical path) or refused (reason)
    M->>T: admitted JS/TS
    M->>P: admitted .py (symbols scope) + universe .py (imports scope)
    P->>P: probePythonParser() (cached; ARCH_INDEX_PYTHON override)
    P->>H: NDJSON {path: canonical, rel, wantSymbols}
    H-->>P: NDJSON per file {symbols[], imports[]} or {error}
    P->>M: symbol candidates -> redactAndEmit (unchanged scrub)
    P->>R: import refs -> resolvePythonImport
    P-->>M: {cruisedSources, edges buckets, offeredEdges, available}
    M->>G: eligibleFiles + assessExtractionCoverage with python merged in
```

### 2.1 One admission gate, a wider allowlist (#5 SSoT, #1 DRY)
`DEFAULT_EXT_ALLOWLIST` becomes `[...JS_TS_EXT_ALLOWLIST, ...PYTHON_EXT_ALLOWLIST]`, and
`PYTHON_EXT_ALLOWLIST` is **derived** from `file-taxonomy.mjs` (`languageById('py').extensions`), minus `.pyi`.
Stub files restate the signatures of their `.py` twins, so indexing them would build false `precedent` clusters.
The `.pyi` exclusion is one named constant with that reason, not a hand-kept list. `admitFile` is **unchanged**:
the sensitive-path, canonical/symlink, escape and size-cap checks now cover `.py` by construction. A new
`isPythonIndexPath(p)` in the same module routes an admitted file to the Python stage instead of ts-morph.

### 2.2 The parser stage: a stdlib-only helper (#11, #16)
`scripts/lib/symbol-index/python-ast-helper.py` uses stdlib only, needs Python ≥ 3.9 (`ast.unparse`,
`end_lineno`), and runs as `python -I -B <helper>`. `-I` ignores `PYTHON*` env, the user site and cwd on
`sys.path`. `-B` writes no `__pycache__` into a consumer's `scripts/.claude-skills/`. It speaks the line protocol
in §2.9 and writes **one NDJSON line per request, flushed**:
- `symbols`: module-level `def`/`async def` (`function`), module-level `class` (`class`), and `def` directly in a
  top-level class (`method`, `symbolName: "Class.method"`). For each: `startLine`/`endLine`, `signature`
  (`def name(<ast.unparse(args)>) -> <ret>` / `class Name(<bases>)`), `bodyText`
  (`ast.get_source_segment`, so the docstring travels **inside** `bodyText`; **no separate docstring field**
  exists, so nothing can bypass the body scrub), and `isExported` (`__all__` literal when present, else not
  `_`-prefixed; dunders are public; a method is exported iff its class is and it is not `_`-private). Nested
  functions and lambdas are not emitted, matching what the JS path extracts.
- Node maps a helper symbol to a candidate through an **explicit allowlist**
  (`symbolName, kind, startLine, endLine, signature, bodyText, isExported`). An unknown key is dropped. A missing
  or ill-typed key fails that file closed (it counts as a parse failure, and none of its symbols are emitted).
- `imports`: refs in **exactly the shape** `arch-intent`'s `resolvePythonImport` consumes
  (`{kind:'import'|'from', module, names, isRelative, dotCount, line}`), walked over the **whole** tree with
  `ast.walk`. That includes imports inside `if`/`try`/functions, a form the regex extractor documents it misses.
- `error`: `SyntaxError` / `UnicodeDecodeError` / `OSError`, reported per file. One bad file never fails the batch.

It opens **no files at all** and never walks directories. It parses only the source text Node sends, and choosing
and reading files is Node's job (§2.6).

### 2.3 Import resolution: reuse, do not re-implement (#1, #5)
`python-extract.mjs` builds a `Map` of the **admitted** universe `.py` files only (each passed `admitFile`, §2.6)
and calls the **existing** `discoverPythonRoots`, `buildPythonModuleIndex` and `resolvePythonImport` from
`scripts/lib/arch-intent/adapters/python.mjs`. That adds the edge `arch-memory → arch-intent` to `allowedDeps` in
`.audit-loop/domain-map.json`, plus one line in `docs/architecture-intent.md` § `arch-memory`.

**Resolver filesystem reads (traced at `python.mjs:278-330`).** `discoverPythonRoots` reads only `pyproject.toml` /
`setup.cfg`: those named in the map plus the two at the repo root. It extracts `package-dir` / `where` **directory
names** used as path prefixes. Those names never leave the process. They only select which admitted file a dotted
name maps to, and an emitted edge always names two admitted files. A filtered map alone cannot guard the
**independent** repo-root probe (`fs.existsSync` + `readFileSync` at `python.mjs:~290`). So `discoverPythonRoots`
gains an optional third argument, `{ readMeta }`. The default is the current `readFileSync`, so arch-intent
behaviour and its tests are unchanged. **Every** metadata open, mapped or root-probe, goes through it.
`python-extract.mjs` passes a guarded reader that runs `shouldSkipForIndexing` + `resolveAndClassify` and returns
`''` (reads nothing) for a sensitive, escaped, unresolvable or oversize target, before any open. Tests cover a
mapped `pyproject.toml` symlinked to a sensitive target, a repo-root `setup.cfg` symlinked outside the repo, and
an injected reader spy asserting no read occurred. `buildPythonModuleIndex` / `resolvePythonImport` are pure over
the map. A refused
(sensitive, escaped, symlinked-out, oversize) file is absent from the index, so **no edge can name it**, and an
import of it falls to the rows below.

Mapping onto the **existing** extraction edge buckets, every offered edge lands in exactly one:

| resolver result | bucket |
|---|---|
| `proven-external` (stdlib) | `external` |
| `unresolved`, absolute, top-level segment **not** a local top-level package/module in the index | `external` (third-party; dep-cruiser's `npm` analogue) |
| `unresolved`, absolute, top-level segment **is** a known local package/module | `unresolved` (a misspelt or missing first-party module) |
| `unresolved`, relative | `unresolved` |
| `resolved-local`, target == importer | `selfEdge` |
| `resolved-local`, either end disowned | `disowned` |
| `resolved-local` otherwise | `persisted` (emits `{type:'import', importer, imported}`) |

**Dedup keys, defined for every category:** resolved is `importer → target file`. A `from a import b, c` that
resolves to two submodules is two edges. External and unresolved are `importer → ext:<dotted>` /
`importer → unres:<dots><dotted>`, so `import os` twice in one file is one offered edge. The deduplicated count is
the `offeredEdges` added to `cruisedEdges`, so `assertExtractionExhaustive` still holds by construction, and each
category has its own test.

### 2.4 Availability is the parser's own answer (#16; AGENTS.md "ask the parser")
`probePythonParser({env, spawn})` returns `{available, interpreter, version, reason}`. It runs once per extract
process:
- If `ARCH_INDEX_PYTHON` is set, only that interpreter is tried. A failure is **unavailable**, never a fall-through
  to another interpreter: an explicit choice must not be silently overridden.
- Otherwise it tries `py -3`, `python`, `python3` on win32, and `python3`, `python` elsewhere. Each candidate runs
  `-I -c "import sys,ast;print(sys.version_info[:2])"` under a 10 s timeout and must report ≥ (3, 9). This rejects
  the Windows Store `python3` stub, which exits non-zero.
- The helper file must exist next to the module (`new URL('./python-ast-helper.py', import.meta.url)`). If it is
  missing, the result is unavailable with reason `helper-missing`.

The result feeds coverage. `availableExtensions` = dep-cruiser's `allExtensions` ∪ `PYTHON_EXT_ALLOWLIST` **only if
`available`**. `assessParserAvailability` then reports a missing interpreter as `unparseable: N`,
`byExtension: {'.py': N}`, `unavailableExtensions: ['.py']`, never as indexed. The parser-gap warning moves into a
pure module (`parser-gap.mjs`) and gains a per-extension remedy: `.py` gets "install Python ≥ 3.9 on PATH or set
ARCH_INDEX_PYTHON". This also frees lines in `extract.mjs` (§8).

### 2.5 Coverage counts what was dropped (#19)
`graph-coverage.mjs` stays pure and **default-identical**. It gains two options:
- `eligibleFiles(files, {…, extensions})`: the default stays `CRUISABLE_EXTENSIONS`. `extract.mjs` passes
  `INDEXABLE_EXTENSIONS = CRUISABLE ∪ PYTHON_EXT_ALLOWLIST`.
- `assessExtractionCoverage({…, candidateExtensions})` passes through to
  `assessParserAvailability(eligible, available, candidates)`, whose `unavailableExtensions` is now computed from
  `candidates`. The default stays `CRUISABLE_EXTENSIONS`.

The numerator becomes dep-cruiser sources ∪ the `.py` files the helper **parsed successfully**. So a crashed
helper, a syntax error or a refused admission shows up as `uncruised`, which lowers the ratio and the verdict. It
never shows as 0 symbols and green. The Python consumer goes from `empty_universe` to a measured ratio.

**Import scope versus symbol scope.** dep-cruiser re-walks the whole tree on every run, incremental runs included,
so the import graph is always whole-repo. For parity the helper parses **every admitted universe `.py`** for
imports, but it emits symbols only for files in the extraction scope (`wantSymbols`). An incremental run therefore
still publishes a complete Python import graph and a commensurable ratio (cost: `ast.parse` of a few hundred
files, ~1–2 s).

### 2.6 Egress (Tier 3)
- **The helper never touches the filesystem.** Node performs the read, bound to the admission decision. It
  `admitFile`s (lexical skip, `resolveAndClassify` realpath re-classification, escape check, extension check on the
  **canonical** name, size cap), then `fs.openSync(canonical, 'r')`, then `fstatSync(fd, {bigint:true})`. It
  compares `dev`+`ino`+`size` with the `statSync(canonical, {bigint:true})` taken at admission. A mismatch fails
  closed with outcome `identity-changed` (counted, uncruised). The read is **bounded**: at most
  `MAX_FILE_BYTES + 1` bytes are read from the **fd**, and reading the extra byte means `size-cap`. After the read,
  a second `fstat` must show unchanged `size`/`mtimeNs`, otherwise the outcome is `identity-changed`. This catches
  growth or rewrite of the same inode mid-read. A deterministic test grows the inode between the first fstat and
  the read through an injected hook, and asserts rejection with no helper request sent. The **raw bytes**
  (base64) are sent to the helper (§2.9). Decoding is Python's job, so PEP 263 coding cookies and BOMs are honoured
  exactly as the interpreter would. This closes the admission-to-read race for the Python path, including a
  swapped path component, because the bytes come from the inode that was verified. A deterministic test swaps the
  file between admission and read through an injected `beforeRead` hook and asserts `identity-changed`, with no
  symbol and no import emitted. This holds for **both** scopes, so a universe file used only for imports is
  admitted and read the same way. (The ts-morph path now reads through the same helper; see §8.) Nothing the helper returns bypasses
  `redactAndEmit`: `containsSecrets` on the body, signature redaction, `bodyText: ''` and `SECRET_REDACTED` on a hit.
  Docstrings exist **only** inside `bodyText` (§2.2), so they are scrubbed with it.
- **Shared-gate inventory** (every reader of `DEFAULT_EXT_ALLOWLIST` / `isExtensionAllowlisted`, from a grep at
  `0ce1f50e`):

  | Caller | Effect of `.py` admission | Protection |
  |---|---|---|
  | `extract.mjs::admitFile` | `.py` admitted for extraction | the full gate above |
  | `sensitive-egress-gate.mjs::gateSymbolForEgress` | `.py` now `send`/`redact-content` | the same canonical, sensitive and generatedNoise checks plus `containsSecrets`. **No production caller** (the duplication detector's same-named adapter is `resolveAndClassify`, `duplication-detector.mjs:90`) |
  | `arch-render.mjs:427` | `.py` no longer called "not indexed" | display only. See §8 coordination item |

  Tier-3 tests in the **same commit** as the widening drive `gateSymbolForEgress` with `repoRoot` for: a sensitive
  `.py` path, a symlinked `notes.py` → a sensitive target, an escaping symlink, and a secret-bearing Python body.
  They assert `skip-path` / `skip-symlink-escape` / `redact-content`.
- The helper's stdout is validated per line against the §2.9 response schema. A malformed line fails closed: it is
  counted, and the file it can be attributed to (if any) becomes a parse failure. Lines are never filtered away
  silently.
- **Progress sequence** (M2): the Python stage emits an **unnamed** `{type:'progress'}` before admitting each
  import-only universe candidate (symbol-scope candidates already got theirs in the `extractSymbols` loop). It
  emits an **unnamed** beat per helper response, and a named `{progress, file}` only for an admitted path. An
  unadmitted path never appears in any record (INC-001 fail-closed, unchanged).

### 2.9 Helper protocol (versioned, correlated, bounded)
- **Request** (one line each): `{"v":1, "id":<int>, "rel":<repo-rel, for messages only>, "b64":<source bytes>, "wantSymbols":bool}`.
  No path is ever sent that the helper could open. The helper decodes with `tokenize.detect_encoding` (PEP 263
  cookie plus BOM; a cookie/BOM conflict or an unknown codec raises), then strict `bytes.decode(enc)`, then
  `ast.parse(text, filename=rel)`. A decode problem is error kind `decode`. Tests cover a valid `latin-1`-cookie
  file containing a non-ASCII docstring, a bogus cookie, and a BOM/cookie conflict.
  The first line is a header `{"v":1,"hello":true}`. The helper echoes `{"v":1,"hello":true,"python":"3.x.y"}`, so a
  stale or foreign helper is refused before any file is sent.
- **Response** (exactly one per request): `{"v":1, "id":<int>, "ok":true, "symbols":[…], "imports":[…]}` or
  `{"v":1, "id":<int>, "ok":false, "error":{"kind":"syntax|decode|internal","message":<≤200 chars>}}`. Each
  line is capped at 4 MiB, which covers the 500 KB source cap after JSON escaping. A longer line is rejected and
  fails that id.
- **Correlation:** the parent keeps a pending map keyed by `id`. An unknown or duplicate `id` is a counted protocol
  error and is ignored, so it can never be attributed to another file. A malformed line with no parsable `id` is
  counted, and the files it cannot name stay pending.
- **Concurrency and backpressure:** a single helper process with requests written one at a time. The next request
  is sent only after the previous response arrives, so at most one file is in flight and no pipe buffer can
  deadlock.
- **Deadlines and liveness** (all are named constants in `python-extract.mjs`):
  - Startup/hello: `PYTHON_HELLO_TIMEOUT_MS = 10000`. With no valid hello in time, the helper is killed and the
    event counts as a process failure.
  - Per file: `PYTHON_FILE_TIMEOUT_MS = 30000` (a single `ast.parse` of a ≤500 KB file is sub-second). On expiry the
    helper is killed and that file's outcome is `timeout`.
  - Heartbeat: while the stage is live, an **unnamed** `{type:'progress'}` is emitted every
    `PYTHON_HEARTBEAT_MS = 5000`, as well as per response. A slow-but-in-deadline parse therefore never starves the
    supervisor's idle timer.
  - Supervisor coordination: every stage deadline is strictly below `COVERAGE_DEFAULTS.hardTimeoutMs` (300 s
    idle), which is asserted at module load. The stage has no absolute budget of its own beyond
    per-file × queue: the supervisor's idle timeout remains the single wedge detector, and the heartbeat is
    suppressed once the helper is dead, so a wedged *Node* side still trips it.
  - Tests cover a helper that hangs before hello, one that answers slowly within its deadline (no failure, and
    heartbeats observed), and one that hangs past the deadline.
- **Queue model and failure accounting:** each candidate is `queued`, `in-flight` (at most one) or `done` with a
  terminal outcome. **Any** helper process failure triggers a restart, at most 3 restarts per stage: a non-zero
  exit, a signal, a hello failure, a protocol-fatal error or a deadline kill. The in-flight candidate's outcome is
  `timeout` (deadline kill) or `helper-died` (anything else), and queued candidates continue on the new process.
  When restarts are exhausted, **every** remaining queued and in-flight candidate gets terminal `helper-died`.
  Candidates never sent are included.
- **Terminal outcomes:** every candidate ends in exactly one of `parsed`, `syntax-error`, `decode-error`,
  `timeout`, `helper-died`, `identity-changed` or `size-cap`. The summary reports counts by outcome
  (`pythonParsed`, and `parseFailures` += the non-parsed, non-admission outcomes). A non-parsed file is
  `uncruised` in coverage and gets **no** `processed` record. Publication semantics are unchanged: a parse
  failure is the existing "file not reached" case. A test runs a 5-file queue whose fake helper dies permanently
  after file 2 and asserts files 3–5 are `helper-died` with no `processed` and the counts add up.
- **Tested with a controllable fake helper** (a tiny Node script substituted through the injectable spawn spec),
  covering a malformed line, a duplicate id, a missing response, mid-stream death, an oversize line and a hang
  past the deadline.

### 2.10 Incremental persistence contract (H1)
Python files follow the **same** contract as JS, traced at `refresh-subprocess.mjs:255-264`:
- `processed {file}` is emitted for **every symbol-scope `.py` file the helper parsed successfully**, *including
  files with zero symbols* (as the JS loop does at `extract.mjs:625`). A previously symbol-bearing file that now
  has none is therefore "reached", and its old symbols are not copied forward.
- Import-only universe files emit **no** `processed` record, because they were not in the extraction scope, and
  their symbols stay on the existing copy-forward path.
- A failed parse emits no `processed`, so the file is "not reached" and copy-forward keeps its prior symbols. That
  is the existing behaviour for a ts-morph parse failure, and the failure stays visible in `parseFailures` and
  coverage.
- Deletes and renames are decided upstream of extract by the diff and tombstone logic
  (`refresh-file-scope.mjs`, `filterDiffFiles`), which is extension-blind and unchanged.
- Tests (real CLI, incremental `--files-from`): a zero-symbol file is `processed` with no symbols; a failed file is
  not `processed`; an import-only file is not `processed` yet its edges are present.

### 2.7 Wiring into `extract.mjs` (#3 modularity)
- `extractSymbols` loop: an admitted Python file is diverted with `pyAdmitted.push(admission); continue;` before
  ts-morph.
- `main()`: after `extractSymbols` comes `await runPythonStage({…})`, which merges its stats (`symbolCount`,
  `parseFailures`, `redacted`, `skippedDelegate`, a new `skippedNoParser`). Then `extractGraphAndViolations` is
  called with `opts.python = {cruisedSources, edges, offeredEdges, available}`. That function adds Python's buckets
  into `edges`, its offered edges into `cruisedEdges`, and its sources into `cruisedSources`, and unions
  `availableExtensions`. **All Python logic lives in `scripts/lib/symbol-index/python-extract.mjs`.**
- The heartbeat is preserved: `python-extract.mjs` spawns asynchronously, reads lines, and emits beats per §2.6.
  The parent's idle timeout (`hardTimeoutMs`) keeps resetting, and the §2.9 deadline bounds a hung parse.
  `processed {file}` follows §2.10.

### 2.8 Test seam for the neighbourhood demonstration
`getNeighbourhoodForIntent` embeds the intent over the network before it reaches `adapters`, so no adapter-injected
test can get past it today. This plan adds **two optional adapter hooks**, `adapters.normalizeIntent(safeIntent)` and
`adapters.embedIntent(text, model, dim)`, used only when supplied. The production default is byte-identical and
**the envelope and schema are untouched**: `NeighbourhoodResultSchema` is not edited, because the sibling chip
`ces-private-store` owns that change. The hunk is in the embedding stage (~`neighbourhood-query.mjs:220-270`), away
from that chip's early-return edits (:180, :450), and the hand-off note names it.

## 6. Sustainability Notes
- **Assumption:** a usable CPython ≥ 3.9 exists on consumer machines. If it does not, the repo degrades loudly
  (`unparseable` plus the remedy line) rather than silently.
- **Extension point:** the parser stage is a seam with a defined request/response line protocol. A tree-sitter
  stage, or `.sql` (follow-up), would plug in as a sibling stage with its own `probe…`, and `availableExtensions`
  would union its answer the same way.
- **Right-sizing.**
  - *Band-aid:* add `.py` to the allowlist and regex-scrape `def` lines in JS. That yields no signatures/docstrings
    worth embedding, wrong spans, and a second Python parser.
  - *Over-built:* a general multi-language plugin registry with tree-sitter grammars and config.
  - *Chosen:* one helper using the language's own parser, plus the existing resolver. The current requirement it
    serves is that a Python consumer's mandatory lookup returns real neighbours.

## 7. File-Level Plan

| File | Purpose | Key exports / change |
|---|---|---|
| `scripts/lib/sensitive-egress-gate.mjs` (modify) | single allowlist | `JS_TS_EXT_ALLOWLIST`, `PYTHON_EXT_ALLOWLIST` (derived), `DEFAULT_EXT_ALLOWLIST` = union, `isPythonIndexPath` |
| `scripts/lib/symbol-index/graph-coverage.mjs` (modify) | coverage universe and parser candidates | `eligibleFiles` `extensions` opt, `assessParserAvailability` `candidates` arg, `assessExtractionCoverage` `candidateExtensions` |
| `scripts/lib/symbol-index/parser-gap.mjs` (create) | pure parser-gap messages | `describeParserGap(parser) → string[]` (moved from `extract.mjs::warnAboutParserGap`, plus a per-extension remedy) |
| `scripts/lib/symbol-index/python-ast-helper.py` (create) | stdlib `ast` parser | NDJSON protocol (§2.2) |
| `scripts/lib/symbol-index/python-extract.mjs` (create) | probe, run, map | `probePythonParser`, `runPythonHelper`, `toSymbolCandidates`, `bucketPythonImports`, `runPythonStage` |
| `scripts/symbol-index/extract.mjs` (modify) | route + merge (net line count within the ratchet) | divert `.py`, call `runPythonStage`, merge into coverage, use `describeParserGap` |
| `scripts/lib/neighbourhood-query.mjs` (modify) | optional test hooks | `adapters.normalizeIntent` / `adapters.embedIntent` |
| `.audit-loop/domain-map.json` (modify) | declare reuse edge | `allowedDeps['arch-memory']` += `arch-intent` |
| `docs/architecture-intent.md` (modify) | document the edge | one sentence under `arch-memory` |
| `scripts/lib/sync-inventory.mjs` (modify) | ship the helper | `CORE_ASSETS` += `scripts/lib/symbol-index/python-ast-helper.py` |
| `scripts/lib/sync-banner.mjs` (modify) | banner the synced `.py` | `COMMENT_TOKEN_BY_EXT['.py'] = '#'` |
| `docs/reference/environment-variables.md` (modify) | document `ARCH_INDEX_PYTHON` | one row |
| `docs/reference/architecture-index.md` (modify) | language coverage | short "Python" subsection |
| `tests/sensitive-egress.test.mjs` (modify) | allowlist derivation | `.py` admitted, `.pyi` excluded, derived from taxonomy |
| `tests/graph-coverage.test.mjs` (modify) | defaults unchanged + python candidates | negative control on defaults |
| `tests/python-extract.test.mjs` (create) | probe, helper, buckets, egress | see §9 |
| `tests/python-arch-index-e2e.test.mjs` (create) | fixture repo: extract, then neighbourhood | see §9 |
| `tests/sync-python-helper-asset.test.mjs` (create) | Tier 3 sync | the bundle contains the helper at the relocated path, with a `#` banner |

### 7b. Implementation Phases

**Phase 1 — Shared allowlist and coverage parameters**: derive `PYTHON_EXT_ALLOWLIST`, widen
`DEFAULT_EXT_ALLOWLIST`, add `isPythonIndexPath`, add the `extensions`/`candidates`/`candidateExtensions` options
(defaults unchanged), and add `parser-gap.mjs`. The allowlist test goes in the **same commit** (Tier 3 egress).
Files: `scripts/lib/sensitive-egress-gate.mjs` (modify), `scripts/lib/symbol-index/graph-coverage.mjs` (modify),
`scripts/lib/symbol-index/parser-gap.mjs` (create), `tests/sensitive-egress.test.mjs` (modify),
`tests/graph-coverage.test.mjs` (modify), `tests/parser-gap.test.mjs` (create).

**Phase 2 — Python parser stage**: the helper, `python-extract.mjs`, the domain-map edge and its doc line, and the
unit tests (probe with an injected spawn, helper on real files, bucket mapping, admission-only reads).
Files: `scripts/lib/symbol-index/python-ast-helper.py` (create), `scripts/lib/symbol-index/python-extract.mjs`
(create), `scripts/lib/arch-intent/adapters/python.mjs` (modify: optional guarded `readMeta`, default unchanged),
`.audit-loop/domain-map.json` (modify), `docs/architecture-intent.md` (modify),
`tests/python-extract.test.mjs` (create), `tests/arch-intent-adapter-python.test.mjs` (modify: `readMeta` is used
for every metadata read, and the default is unchanged).

**Phase 3 — Wire into extract, ship the helper, neighbourhood seam**: `extract.mjs` routing and merge, **plus
in the same commit** the helper's consumer delivery: `CORE_ASSETS`, the `.py` banner token, and the Tier-3 sync
test. No revision can wire production extraction to a helper the bundle does not ship. Also the
`neighbourhood-query.mjs` hooks and the end-to-end fixture test. The sync test asserts the helper is in
`bundleForRepo()` and gets a `#` banner that still parses (`python -I -c "import ast,sys;ast.parse(open(sys.argv[1]).read())"`
on the bannered text). It also asserts `sourceRelToDestRel` keeps `python-extract.mjs` and `python-ast-helper.py`
**siblings**, which is the invariant `new URL('./python-ast-helper.py', import.meta.url)` relies on. And it runs
the bannered helper through a relocated copy of the pair in a temp `scripts/.claude-skills/lib/symbol-index/`
layout, checking the probe reports available.
Files: `scripts/symbol-index/extract.mjs` (modify), `scripts/lib/neighbourhood-query.mjs` (modify),
`scripts/lib/sync-inventory.mjs` (modify), `scripts/lib/sync-banner.mjs` (modify),
`tests/python-arch-index-e2e.test.mjs` (create), `tests/sync-python-helper-asset.test.mjs` (create).

**Phase 4 — Docs**: the env var row and the architecture-index language note.
Files: `docs/reference/environment-variables.md` (modify), `docs/reference/architecture-index.md` (modify).

**Close-out (not a phase)**: `npm run size:ratchet:gate`, `npm run skills:check`, `npm run context:check`,
`npm run guards:preflight`, `npm test` (branch tier) and the related suites, `npm run arch:refresh` is **not** run
(it costs money and touches the shared store).

## 8. Risk & Trade-off Register
- **`extract.mjs` size ratchet (1225, baseline 1219 ± 10).** The routing adds ~15 lines. Moving
  `warnAboutParserGap` (~35 lines) to `parser-gap.mjs` keeps the net within [1209, 1229]. The gate is run at
  close-out.
- **Allowlist widening reaches other readers.** With `.py` allowlisted, `arch-render.mjs:427` stops printing "not
  indexed" for `.py`. That is correct where Python is indexed and wrong on a machine with no interpreter. The
  per-snapshot coverage verdict (the sibling chip's envelope work) is the honest place to carry "Python unparsed
  on this refresh"; editing it here would collide with that chip. **Recorded as a coordination item**, not silently
  deferred: the hand-off tells the coordinator. `gateSymbolForEgress` (duplication detector) now admits `.py`
  excerpts. Those come from the same extract output and pass the same secret checks, so this is consistent rather
  than new egress.
- **Third-party vs missing.** An absolute import whose top-level segment is a known local package is bucketed
  `unresolved`; any other unresolved absolute import is `external` (§2.3). The residual ambiguity is a first-party
  top-level name that does not exist locally at all, which is indistinguishable from a third-party package without
  an installed environment. It is accepted and documented in code.
- **Admission-to-read race, both paths (narrowed 2026-11-21, "option 2").** One shared reader,
  `scripts/lib/symbol-index/admitted-read.mjs::readAdmittedSource`, serves the Python stage AND ts-morph
  (`loadAndParseFile` reads the bytes through it and hands ts-morph the text via `createSourceFile`; ts-morph never
  opens the path). It opens, `fstat`s the descriptor, RE-RUNS the full admission gate on the canonical path, requires
  the path's dev+ino to equal the descriptor's (before and after the re-admission), reads bounded, and finally
  re-checks that the path still names the inode it read (a swap after the read drops the bytes). Linux additionally
  binds to `/proc/self/fd`. **Residual (Windows and macOS only):** a swap held across the open and both stats but
  released only during the re-admission itself, so it must flip twice inside one window. It is narrowed, not closed;
  closing it needs a native fd-to-path call. Tests: `tests/admitted-read.test.mjs` (hooks for each window, with a
  source-mutation negative control per check).
- **`.pyi` excluded** (§2.1). A stub-only package is not indexed, which is rare and stated.
- **Interpreter variance**: the helper uses only 3.9+ stdlib APIs. The version floor is enforced by the probe.
- **Deferred:** `.sql` extraction (field report item 1b, a follow-up); decorators in signatures; nested functions.

## 9. Testing Strategy

Proof plan (oracle → pass condition → evidence):

| Behaviour | Oracle | Pass |
|---|---|---|
| `.py` admitted through the same gate; `.pyi` not | unit, `isExtensionAllowlisted`, red before Phase 1 | `.py` true, `.pyi` false, JS unchanged |
| A symlinked `x.py` → sensitive target is refused, and the helper never receives it | e2e on a temp repo with a symlink (skip only where symlinks are unsupported, loudly) | no symbol/import for it; the helper's request log lacks the path |
| Secret in a Python body, **docstring** or default-arg signature is redacted | e2e with runtime-built AWS-shaped keys in each position | the complete emitted record (every field) contains no key bytes; `redacted:true`, `bodyText:''`, `purposeSummary: SECRET_REDACTED` |
| Shared egress gate on `.py` | unit, `gateSymbolForEgress({repoRoot})` on a sensitive `.py`, a symlink → sensitive, an escaping symlink, a secret body | `skip-path`, `skip-path`, `skip-symlink-escape`, `redact-content` (same commit as the widening) |
| Resolver never names a refused file | e2e: a sensitive-named `.py` and an escaping symlink inside a package, both imported by an admitted file | no `import` record and no index entry name either; bucketed `unresolved`/`external` per §2.3 |
| Helper protocol failures fail closed | fake helper (malformed, duplicate id, missing response, death, oversize, hang) | every request ends in exactly one terminal outcome; no symbol from a failed id; extract exits 0 with counts |
| Incremental contract | real CLI `--files-from` (§2.10) | zero-symbol file `processed`; failed file not; import-only file's edges present without `processed` |
| Records satisfy the real consumer | every `symbol` record from the real CLI is checked against the fields `refresh-subprocess`/summarise/embed read, with types (`filePath` string, line ints, `kind ∈ SymbolKindEnum`, `signatureHash` non-empty, `redacted` bool); every `import` names two fixture files | all pass. The neighbourhood RPC stub is labelled in the test as the store boundary |
| Functions/classes/methods with signatures and docstrings | e2e fixture repo | the exact expected `{symbolName, kind, signature}` set; the docstring present in `bodyText` |
| Import graph resolved against the package root | e2e: `src/pkg` layout plus a relative import, stdlib, third-party | the persisted edge set equals the expected set; every edge is bucketed; exhaustive `ok` |
| Missing interpreter is UNPARSEABLE, never indexed | e2e with `ARCH_INDEX_PYTHON=<nonexistent>` | 0 Python symbols; coverage `parser.byExtension['.py'] === N`; `.py` in `unavailableExtensions` |
| Missing helper file is unparseable | unit, `probePythonParser` with an injected helper path | `available:false, reason:'helper-missing'` |
| Defaults of `graph-coverage` unchanged | existing suite plus a negative control | the existing assertions stay green |
| `get-neighbourhood` returns real Python neighbours | e2e: extract the fixture, deterministic stub embedder over `signature+bodyText`, an adapter RPC ranking by cosine, `getNeighbourhoodForIntent` with the §2.8 hooks | the top record is the expected Python function from the fixture, its `filePath` ends `.py`, and the result passes `NeighbourhoodResultSchema` |
| Helper ships to consumers | `bundleForRepo()` plus `sourceRelToDestRel` plus `injectUpstreamBanner` | the path is present at `scripts/.claude-skills/lib/symbol-index/python-ast-helper.py` with a `#` banner |

**Python availability: required, everywhere, no skip path.** Every Python-dependent suite resolves an interpreter
through the same `probePythonParser`. If none is found, the suite **fails** with an actionable message ("install
Python ≥ 3.9 on PATH, or set ARCH_INDEX_PYTHON") in CI and locally alike. There is no opt-out flag, so a clean
checkout cannot report green having exercised nothing (sandbox-honesty rule). The missing-interpreter behaviour is
covered separately by tests that force `ARCH_INDEX_PYTHON` to a nonexistent path, which need no Python.

**Positive control:** each new oracle is seen failing first (red before the implementing change), one defect at a
time.

## 11. Execution Clustering

- **Cluster A** — Phases 1–3 — fix-gate: yes
  - Coupling: one seam. The allowlist and coverage options (P1) are consumed only by the Python stage (P2) and its
    wiring (P3), and the exhaustivity and coverage claims can only be audited across all three together.
- **Cluster B** — Phases 4–4 — fix-gate: final
  - Coupling: operator documentation for the behaviour Cluster A shipped. It changes no code path: consumer
    delivery moved into Phase 3, so Cluster A is self-contained and shippable on its own.
- **Final gate**: consolidated Gemini review over the union diff (mandatory).

## Audit trail
- `/audit-plan` (SID `audit-plan-1795201795908-108648`):
  - R1: H7 M2. 8 accepted; H7 compromised to MEDIUM by GPT deliberation.
  - R2: H3, all accepted.
  - R3: H3 M1, all accepted and folded in.
  - The GPT cap (3) was reached. The structural card showed 0 structural, 1 local and 7 polish clusters. **Decision:
    STOP** the GPT rounds, because every remaining finding was hardening detail now folded in. Continuing past the
    cap is Louis's call, and it was not needed.
  - Final gate: **APPROVE** (gemini / gemini-4-argon, round 1/2, blocking 0, debt 0).

## Implementation Log
- **Phase 1** (`663d2364`): the allowlist, coverage parameters and `parser-gap.mjs`. `arch-render.test.mjs` used
  `.py` as its "unindexed" example, so it moved to `.go`, and a case pins `.py` as indexed.
- **Phase 2** (`f973a6d0`): the helper, `python-extract.mjs`, the guarded `readMeta`, and the domain-map edge.
  **Found and fixed in the reused resolver:** relative imports under a `src/` root resolved against the directory
  path (`src.shop.orders.x`) and never matched the index. They now resolve against the importer's dotted module.
  This also changes `arch-intent`'s own `analyseImports` results in src-layout consumers, where such edges are now
  seen. It is a correctness fix, called out in the hand-off.
- **Phase 3 — load-bearing additions the plan missed** (each needed for "a Python consumer's `arch:refresh`
  indexes"):
  - `refresh.mjs` stack gate: a pure-Python repo (`stack=python`) skipped as `unsupported-stack` **before**
    extraction. Both the gate and the fit-check verdict now read one set, `ARCH_INDEXED_STACKS`
    (`lib/repo-stack.mjs`), and a source-coupling test pins both reads.
  - `fit-check/rules.mjs` (Python is now FITS and names the interpreter), `render-mermaid.mjs` (Python is no longer
    an "unindexed stack" banner input), and `/ship`'s reference line plus its gate-contract quote.
  - **The coverage universe excludes `.py` files the gate refuses.** The e2e test caught `secrets/creds.py` being
    *named* in `coverage.samples.uncruised`. A refused file is never read, so per the §2.1.1 clause it is neither
    counted nor named. This is scoped to Python: JS files are still cruised by dep-cruiser, which is unchanged.
- **Code audit** (6 rounds, cap reached; final gate `approve_with_debt` with 0 blocking findings): see
  [python-arch-memory-indexing-audit-summary.md](python-arch-memory-indexing-audit-summary.md). Changes driven by
  the audit:
  - the reader became open-then-verify, with a descriptor-path binding on Linux and a stat sandwich elsewhere;
  - the protocol accepts only the in-flight id;
  - the helper finds nested and decorated definitions and slices lines the way Python counts them;
  - `__all__` is trusted only on a single mention;
  - the Python sync banner is ASCII and keeps BOM and cookie positions.
- **Follow-ups (independent of this change, for the coordinator):**
  - ~~Decide on the non-Linux residual admission race~~ narrowed by the post-open recheck; see §8.
  - The `/audit-code` duplication wave filters candidates with its own JS-only regex
    (`lib/audit/duplication-detector.mjs:60`), so Python is not yet duplicate-checked there.
  - ~~The ts-morph admission-to-read race (§8).~~ Closed to the same narrowed residual (§8).
  - The `arch-render` "not indexed" callout keys on the allowlist, not on the snapshot's coverage verdict (the
    sibling chip's envelope work).
  - `.sql` extraction.

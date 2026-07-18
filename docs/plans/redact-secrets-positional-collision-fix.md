# Plan: Fix `redactSecrets` Positional-Collision Bug

- **Date**: 2026-07-16
- **Status**: Complete
- **Author**: Claude + Louis
- **Scope**: backend
- **Target domain(s)**: `shared-lib`, `tests`
- ⚠ **Cross-domain work** — touches >1 domain; the normal lib+test pair for
  a bug fix, intentional.

> **Origin**: found while auditing `docs/plans/local-db-test-container.md`
> — `/audit-code` flagged `scripts/db-test-container.mjs`'s `buildDsn()` as
> "returns a broken connection string" across 4 consecutive rounds. The
> function was correct; the string GPT *received* was corrupted by this
> repo's own egress-redaction gate before the prompt was ever assembled.

---

## 1. Context Summary

**Scope/stack**: backend; `js-ts` (Node ESM).

**What exists today**: `scripts/lib/secret-patterns.mjs::redactSecrets()`
is the canonical secret-redactor, reused (never reimplemented) by
`scripts/lib/sensitive-egress-gate.mjs::redactSecrets` (the fail-closed
wrapper used at the LLM-provider boundary) and by
`scripts/lib/audit-scope.mjs::readFilesAsContext` — the function that
reads every file's content into the `/audit-code` prompt, calling
`redactSecrets` on each file's **full body** by default (`redact: true`).
So any secret-shaped string anywhere in a file being audited — including
the audited code's OWN literal strings, not just user-supplied prose —
passes through this redactor before a model ever sees it.

**Code Trace**:

- `scripts/lib/secret-patterns.mjs:111-135` (`redactSecrets`) — for each
  `SECRET_PATTERNS` entry with a `captureGroup`, the replacer does
  `match.replace(group, '[REDACTED:${name}]')` (line 126) — a **plain
  first-occurrence string search** within the already-matched substring,
  not a positional splice at the capture group's actual offset.
- `scripts/lib/secret-patterns.mjs:51-55` — the `dsn-password` pattern:
  `/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?):\/\/[^:\s/@]+:([^@\s]+)@/gi`,
  `captureGroup: 1` (the password). Two patterns use `captureGroup`:
  `dsn-password` and `generic-token` (line 40-44).
- `scripts/lib/audit-scope.mjs:110-136` (`readFilesAsContext`) —
  `redact: true` by default; `raw = redactSecrets(result.content)` runs
  on every audited file's full body before it's assembled into the prompt.
  This is the path that corrupted `db-test-container.mjs`.
- `scripts/lib/sensitive-egress-gate.mjs:88-113` — the fail-closed
  provider-boundary wrapper; delegates to the same `redactSecretsImpl`
  from `secret-patterns.mjs`, so it inherits the identical bug.
- `tests/secret-patterns.test.mjs:140-158` — the existing DSN-redaction
  test (`'redacts DSN password only, keeps scheme/user/host readable'`)
  uses four fixtures (`Sup3rS3cret`, `pw123`, `t0ps3cret`, `cachepass`) —
  **none of these values coincide with an earlier substring in their own
  match** (scheme name or username), so the suite never exercised the
  collision path. Confirmed coverage gap, not a design decision.

**Empirically reproduced** (this session, against the real function):

```
redactSecrets('postgresql://postgres:postgres@127.0.0.1:5433/postgres').text
  → "[REDACTED:dsn-password]ql://postgres:postgres@127.0.0.1:5433/postgres"
  // "postgres" inside the SCHEME "postgresql" matched first — the real
  // password ("postgres", after the colon) is untouched.

redactSecrets('postgresql://admin:admin@realhost.example.com:5432/prod').text
  → "postgresql://[REDACTED:dsn-password]:admin@realhost.example.com:5432/prod"
  // the USERNAME got redacted; the real password ships in plaintext.
```

**Severity — corrected from the original framing.** This is not only an
audit-tool false-positive source (which is how it was first discovered):
it is a genuine secret-redaction correctness bug. Whenever the captured
secret's value coincidentally also appears **earlier** in the same regex
match (as a substring of the scheme name, or equal to the username, or —
for `generic-token` — repeated elsewhere in the matched span), the
redaction lands on the wrong span and **the actual secret ships to the
LLM provider unredacted**. This is the Tier-3 "sensitive-path egress"
seam (AGENTS.md) — hard test-first, same commit, non-negotiable.

**Patterns reused vs new**: fixes the existing canonical `redactSecrets` —
no new redaction path, no sibling. `sensitive-egress-gate.mjs` and
`audit-scope.mjs` need zero changes; they inherit the fix by calling
through to the same function.

**Neighbourhood considered**: cloud consultation's top match is
`redactSecrets` itself (`scripts/lib/secret-patterns.mjs:111-135`,
similarity 0.72) — correctly identifies this as a modify-in-place, not a
greenfield candidate.

**Security incidents consulted**: INC-001 (symlink-escape bypassing
path-based sensitivity classification) shares this file's neighbourhood
(`sensitive-egress-gate.mjs` is a cited affected path) and its central
lesson applies directly here: *"Fail-closed... never 'I couldn't classify
it so I'll allow it.'"* The fix below is fail-closed in the same spirit —
correct positional redaction, not a narrower allowlist that could regress
under a future pattern addition.

---

## 2. Proposed Architecture

```mermaid
graph LR
    A["readFilesAsContext()<br/>audit-scope.mjs"] -->|"raw file content"| B["redactSecrets()<br/>secret-patterns.mjs"]
    C["assertEgressSafe() /<br/>redactSecrets() wrapper<br/>sensitive-egress-gate.mjs"] -->|"delegates"| B
    B -->|"per-pattern matchAll<br/>+ indices splice"| D["SECRET_PATTERNS<br/>registry"]
    B -->|"sanitized text"| E["LLM provider<br/>(GPT / Gemini)"]
    style B fill:#f96,stroke:#333
```

**Component**: single function fix, `redactSecrets()` in
`scripts/lib/secret-patterns.mjs`. No new files, no new exports beyond
what already exists.

**Key design decision — indices-based splice, not a narrower allowlist**
(#12 defensive validation, #15 consistent error handling): the fix
replaces the nested `match.replace(group, ...)` string search with a
position-exact splice using `RegExp`'s `d` flag (`hasIndices`, Node ≥16) —
`String.prototype.matchAll` with a `d`-flagged pattern returns
`match.indices[n]` as `[start, end]` offsets. The rewritten algorithm
walks each pattern's matches once, copying untouched spans verbatim and
splicing `[REDACTED:name]` in at the group's (or, for non-`captureGroup`
patterns, the full match's) exact offset — never a secondary string
search that can hit an unintended earlier occurrence.

**Data-flow precision (audit H2 — the offset-relativity ambiguity)**:
patterns are processed **sequentially against an accumulating string**,
identical to the pre-fix algorithm's semantics (`redacted = redacted.replace(...)`
reassigns and the next iteration's `.replace` runs on the updated value).
Concretely, per pattern: `matchAll` runs once against `result` **as it
stands at the start of that pattern's turn**; `indices` are therefore
relative to that snapshot, not the original input, and not affected by a
different pattern's edits (which happen only after this pattern's full
pass completes and `result` is reassigned). Within one pattern's pass,
because the redacted marker text is always **shorter than or a fixed
transform of** the matched span and `matchAll` computes ALL its matches
against the pre-redaction snapshot before the loop body runs (JS
`matchAll` returns a lazy iterator over the ORIGINAL string the method
was called on, not the string being built), later matches' indices are
never invalidated by an earlier splice in the same pass — the output is
assembled into a separate `out` accumulator (never mutating `result`
mid-pass), so index arithmetic never needs adjustment. **`lastIndex`
safety**: each pattern gets a **fresh `RegExp` instance** constructed
inside the loop (`new RegExp(re.source, ...)`, matching the pre-fix
code's own pattern) — never the shared `SECRET_PATTERNS` registry object
— so no `.test()`-call-elsewhere staleness can leak in. `matchAll`'s
`g`-flag requirement is already a standing invariant, enforced by the
existing `'all patterns have name and regex'` / `'must be global'` test
in `tests/secret-patterns.test.mjs` (SECRET_PATTERNS registry describe
block) — no new validation needed for that half.

**Fail-closed on missing `d`-flag runtime support (audit H1, R3 —
`engines` is advisory-only and does not prevent execution)**: `engines`
in `package.json` is npm's own documented advisory mechanism — it warns,
it does not block `node scripts/foo.mjs` from running directly, which is
exactly how this repo's tooling executes once synced into a consumer
repo (`scripts/.claude-skills/` — a consumer's own Node version is
outside this repo's control). Relying on `engines` alone as the safety
mechanism is the "I couldn't classify it so I'll allow it" failure INC-001
warns against, applied to a runtime-version axis instead of a path axis.
So the fix is **runtime feature-detection, not a version claim**: at
module load, `secret-patterns.mjs` computes
`const D_FLAG_SUPPORTED = (() => { try { new RegExp('', 'gd'); return true; } catch { return false; } })();`
ONCE. **Corrected design (R4-H1 — the round-3 draft was internally
contradictory: it described a full-match fallback but then constructed
every pattern's `RegExp` by unconditionally appending `'d'`, which itself
throws on an unsupported runtime before any fallback branch could run)**:
the per-pattern `RegExp` construction is **conditional** on
`D_FLAG_SUPPORTED` —

- `D_FLAG_SUPPORTED === true`: `new RegExp(re.source, re.flags.includes('d') ? re.flags : re.flags + 'd')`
  (today's design) — `matchAll` results carry `.indices`, used for
  precise group-or-full-match splicing.
- `D_FLAG_SUPPORTED === false`: `new RegExp(re.source, re.flags)` — **no
  `'d'` appended, so construction never throws**. `matchAll` still works
  without the `d` flag (it doesn't require it) and every match result
  still carries `.index` (the full match's start offset) and `[0]` (the
  full matched string) regardless — confirmed empirically this session.
  The span redacted is **always the full match** (`[m.index, m.index + m[0].length)`),
  for every pattern including `captureGroup` ones — no attempt to
  isolate the group's position, since that requires `indices` and isn't
  determinable otherwise.

Either branch redacts at least the matched span; the unsupported-runtime
branch is more conservative (whole match, not just the group) but never
throws and never under-redacts. This protects **every** caller of
`secret-patterns.mjs::redactSecrets` uniformly (27 files import it,
directly or via `sensitive-egress-gate.mjs`'s wrapper — not all go
through the wrapper's own try/catch), not just the ones wrapped by
`sensitive-egress-gate.mjs`'s already-existing fail-closed catch block
(confirmed present: `redactSecretsImpl` failures there already return
`[REDACTED:redaction-failed]`, so that ONE call path was already safe;
this closes the gap for the other 26). `"engines": {"node": ">=22"}`
remains in the plan as a correct, evidence-grounded **documentation**
signal (§8) — but it is no longer the enforcement mechanism.

**Fail-closed on a non-participating or malformed capture group (audit
H3)**: `match.indices[captureGroup]` is `undefined` when the numbered
group didn't participate in that match (e.g. a future pattern with the
group inside an alternation) or `captureGroup` is out of range. The
rewritten loop treats this as `redact-the-full-match` (never
"leave unredacted") — consistent with INC-001's stated lesson ("fail-closed
... never 'I couldn't classify it so I'll allow it'"). All *current*
`SECRET_PATTERNS` entries with `captureGroup` (`dsn-password`,
`generic-token`) have a single, unconditionally-participating group, so
this path is defensive-only today; it is exercised by a dedicated test
(§9) rather than left as an unverified claim.

**Flag derivation and result-contract preservation (audit M1)**: each
pattern's per-call `RegExp` is constructed as
`new RegExp(re.source, re.flags.includes('d') ? re.flags : re.flags + 'd')`
— every existing registry flag (`g`, `i` on every current entry) is
preserved verbatim; `d` is appended exactly once, never duplicated. The
function's return contract is unchanged: `{ text: string, redacted: string[] }`
— `redacted` is still populated with a pattern's `name` iff at least one
match occurred that pattern (same `found` boolean semantics as today,
just set inside the `matchAll` loop instead of inside `.replace`'s
callback); newline-padding for multi-line matches (the `pem-private-key`
case) is computed identically (`(match[0].match(/\n/g) || []).length`)
and appended after the marker at the spliced position. No caller-visible
behavior changes except the redaction's *position* within `text` for the
previously-broken collision cases.

**Testable in isolation via `_internals`** (repo convention — e.g.
`scripts/db-test-container.mjs`, `scripts/lib/assert-repo-root.mjs`): the
span-selection logic (given one `matchAll` entry's `indices` and an
optional `captureGroup`, return the `[start, end)` to redact — the group's
span if it participated, else the full match's span) is factored into a
small pure function, exported as `_internals.resolveRedactionSpan`, so
the fail-closed fallback (H3) is directly unit-testable with a synthetic
`indices`-shaped input — no need to construct a real registry pattern
that can trigger non-participation (none currently can).

**`d`-flag fallback testability (R4-M1 — corrected)**: an ESM named
export is a read-only live binding — a test importing
`_internals.isDFlagSupported` cannot reassign it, and even if it
somehow could, the module-private value already closed over inside
`redactSecrets()` wouldn't observe the change. The fix is **parameterize,
don't monkeypatch**: the whole per-pattern replacement loop is factored
into `_internals.redactWithPatterns(text, patterns, { dFlagSupported })` —
a fully pure function taking the support flag as an explicit argument.
`redactSecrets(text)` (the public, signature-unchanged export) becomes a
thin wrapper: `redactWithPatterns(text, SECRET_PATTERNS, { dFlagSupported: D_FLAG_SUPPORTED })`.
The test calls `_internals.redactWithPatterns(text, SECRET_PATTERNS, { dFlagSupported: false })`
**directly** — genuine dependency injection through the existing
`_internals` convention, no binding mutation, no fragile module-state
hack.

Rejected alternative — **allowlisting known dummy credentials** (e.g.
`postgres`, `admin`, `test`): this was the original hypothesis before
root-causing the actual bug. Rejected because (a) it doesn't fix the
underlying correctness bug — a *real* secret that happens to collide with
an earlier substring (e.g. `password=password<random32chars>` for
`generic-token`, or any DSN where username equals password) would still
leak unredacted; (b) maintaining a dummy-credential allowlist is exactly
the kind of "narrower carve-out" INC-001's lesson warns against; (c) the
audit-tool false-positive this was originally reported for is a
*symptom* of the collision bug, not a separate problem — fixing the root
cause fixes both.

**Newline-preserving guarantee is unaffected** (existing invariant,
`redactSecrets`'s own docstring): the `pem-private-key` pattern is the one
multi-line, non-`captureGroup` match; its replacement span is now
computed from `indices[0]` instead of accumulated via `String.replace`,
but the same `newlineCount` calculation and trailing-`\n` padding apply,
so line-number alignment for any diff-hunk-annotating caller is preserved
byte-for-byte. Verified in prototype (§9).

**Multiple matches per pattern, and multiple patterns per string**:
already exercised by the existing `'handles multiple secrets in same
string'` test — the indices-based rewrite walks `matchAll`'s full result
set per pattern (not just the first match), so this behaviour is
preserved; verified with a new same-string two-DSN collision case (§9).

---

## 6. Sustainability Notes

**Right-sizing gate** (modifies existing structure — no new abstraction,
but the algorithm itself changes shape):

- **Band-aid extreme**: add a special-case check — "if the captured group
  equals a substring that also appears before it in the match, use
  `lastIndexOf` instead of the first occurrence." Rejected: `lastIndexOf`
  is just as fragile in the *other* direction (a real secret appearing
  earlier, with a coincidental dummy-looking repeat later, would then
  redact the wrong span the other way) — it doesn't fix the underlying
  problem, it just moves which collision case breaks.
- **Over-engineered extreme**: replace the whole `SECRET_PATTERNS`
  system with a proper parser/tokenizer per secret shape (e.g. a DSN
  parser using the `URL` class instead of regex). Rejected: regressing
  from "one regex-scanning module reused by 35 call sites" to N
  shape-specific parsers is a large, high-blast-radius rewrite for a bug
  whose actual fix is a positional-correctness change to one function's
  replacement loop.
- **Chosen**: fix `redactSecrets`'s replacement algorithm to use
  match/group indices instead of nested string search. Serves the
  *current* requirement (secrets must be redacted at their real position,
  never left exposed by a same-string collision) with no new surface
  area — same function signature, same call sites, same patterns.

**Manual vs scripted**: single function, single test file — by hand.

**Assumptions that could change**: a future `SECRET_PATTERNS` entry using
`captureGroup` inherits the fix automatically (the algorithm is
pattern-agnostic); a future entry NOT using `captureGroup` also inherits
the indices-based full-match splice. No entry-specific code needed.

---

## Security Considerations (Tier-3 seam — AGENTS.md)

This is the sensitive-path egress seam: `tests/sensitive-egress.test.mjs`
(the gate) and `tests/audit-scope-egress.test.mjs` (the assembly path) are
its existing regression locks per AGENTS.md's testing doctrine. This plan:

1. **Does not weaken detection** — every existing `SECRET_PATTERNS` entry,
   every existing passing test, and the redaction *decision* (does this
   text contain a secret-shaped string?) are unchanged. Only the
   *replacement position* changes.
2. **Closes a real leak vector**: the collision bug currently means a
   secret CAN ship to an external LLM provider unredacted whenever its
   value coincidentally matches an earlier substring in the same match.
   Fixed for both `captureGroup` patterns (`dsn-password`,
   `generic-token`).
3. **New test-first coverage** (Tier-3 mandatory, same commit): collision
   cases for both `captureGroup` patterns, verifying the ACTUAL secret
   value never survives in the output, added to `tests/secret-patterns.test.mjs`
   BEFORE the implementation change (red-green).
4. **`tests/sensitive-egress.test.mjs` and `tests/audit-scope-egress.test.mjs`**
   re-run unmodified as part of this plan's Testing Strategy — they must
   stay green (the fix must not change what gets flagged as sensitive,
   only where the redaction marker lands).

---

## 7. File-Level Plan

| File | Intent | Purpose |
|---|---|---|
| `scripts/lib/secret-patterns.mjs` | modify | Rewrite `redactSecrets()`'s per-pattern replacement loop to use `RegExp`'s `d` flag (`hasIndices`) + `matchAll`, splicing each match/group at its exact `[start,end)` offset instead of `match.replace(group, ...)`. Fail-closed full-match redaction when `indices[captureGroup]` is undefined (H3). No signature change; no change to `SECRET_PATTERNS`, `scanForSecrets`, or `redactFields` (they don't touch the buggy code path). |
| `tests/secret-patterns.test.mjs` | modify | Add a `describe('redactSecrets — positional collision (2026-07-16 fix)')` block, test-first (RED before the implementation change, GREEN after) — precise cases (audit M1): (a) **scheme collision** — input `postgresql://postgres:postgres@127.0.0.1:5433/postgres`, assert `r.text === 'postgresql://postgres:[REDACTED:dsn-password]@127.0.0.1:5433/postgres'` (exact string, not a substring-absence check — a substring check can't distinguish "redacted the right span" from "redacted the wrong span that happens to also remove the visible text"); (b) **username==password collision** — input `postgresql://admin:admin@realhost.example.com:5432/prod`, assert `r.text === 'postgresql://admin:[REDACTED:dsn-password]@realhost.example.com:5432/prod'`; (c) **generic-token — no realistic same-string collision exists** (proved: the pattern's captured value has a 32-char minimum length, always longer than its ~9-char keyword+separator prefix, so the value can never recur within that prefix) — instead, a plain non-collision regression case pins the exact pre-fix oracle (R5-L2, computed this session against the current implementation): `assert.equal(redactSecrets('password=abcdefghijklmnopqrstuvwxyz012345').text, 'password=[REDACTED:generic-token]')`, proving the refactor is byte-identical to today's behavior for this pattern, not merely "similar"; (d) **two DSNs, two independent collisions, one string** — `'a: postgresql://x:x@h1/db  b: mysql://root:root@h2/db2'`, assert both redact correctly and independently in one exact-string assertion; (e) **fail-closed non-participating group** (H3) — directly unit-tests the new `_internals.resolveRedactionSpan(indices, captureGroup)` helper with a synthetic `indices` array where `indices[captureGroup]` is `undefined`, asserting it returns `indices[0]` (the full-match span) rather than throwing or returning `undefined`; (f) **PEM byte-for-byte** (L1, exact oracle — the current, pre-fix
output, computed and pinned this session, unaffected by the fix since PEM
uses no `captureGroup`): fixture `` `cfg: ${pem} // ok` `` where `pem` is
the existing test's own `-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----`
constant; assert
`r.text === 'cfg: [REDACTED:pem-private-key]\n\n // ok'` (verbatim,
includes the two-newline padding from the pattern's 2 embedded `\n`s) —
replaces the current newline-*count*-only check with an exact-string one,
proving placement, not just count, is unchanged; (g) **d-flag-unsupported fallback** (H1/M1, corrected) — calls `_internals.redactWithPatterns(text, SECRET_PATTERNS, { dFlagSupported: false })` **directly** (real dependency injection, not a monkeypatch), asserting a `dsn-password` match redacts the FULL match span (e.g. `postgresql://admin:admin@host/db` → the whole `postgresql://admin:admin@` matched prefix becomes `[REDACTED:dsn-password]`, not just the password) — proving the fallback never throws (regex construction omits `'d'` in this branch) and never under-redacts on an unsupported runtime. |
| `tests/sensitive-egress.test.mjs` | modify | Add ONE case (H1/M2 — exact entry point and assertion, matching this file's own convention: it already imports `redactSecrets` from `sensitive-egress-gate.mjs` at line 11) — `describe('redactSecrets (provider-boundary wrapper) — positional collision (2026-07-16)')`: `const out = redactSecrets('postgresql://admin:admin@realhost.example.com:5432/prod'); assert.equal(out, 'postgresql://admin:[REDACTED:dsn-password]@realhost.example.com:5432/prod');`. Exercises the exact wrapper this file's OTHER tests already cover for detection (`containsSecrets`) — this case proves the *redaction position* fix reaches the LLM-provider-boundary call path, not just the underlying unit function. |
| `tests/audit-scope-egress.test.mjs` | modify | Add ONE case (H1/M2 — following this file's own established `mkdtemp` + `chdir` + `readFilesAsContext` convention verbatim, same as its existing `'readFilesAsContext includes benign content...'` test): write `dsn.js` containing `export const url = "postgresql://admin:admin@realhost.example.com:5432/prod";\n` into a temp dir, `chdir` in, call `readFilesAsContext(['dsn.js'])`, assert the returned context `.includes('postgresql://admin:[REDACTED:dsn-password]@realhost.example.com:5432/prod')` AND does NOT include `':admin@'` (the real password must not survive in the assembled prompt at ANY position). Proves the fix reaches the actual `/audit-code` file-reading path that triggered this plan — not a hypothetical "or in-memory equivalent," the file's real, already-established fixture pattern. |
| `package.json` | modify | Add `"engines": {"node": ">=22"}` (audit M1) — matches the floor every CI workflow already pins (verified: 8 workflow files, uniformly `'22'`), not an invented value. |
| `package-lock.json` | modify (regenerated, not hand-edited) | R4-L1: this repo commits its lockfile, and npm's lockfile root entry (`packages[""]`) mirrors `package.json`'s top-level fields including `engines`. Run `npm install` after the `package.json` edit (no dependency version changes — just re-syncs the root entry) and commit the resulting diff; do not hand-edit. Verified in close-out via `git diff --stat package-lock.json` showing only the `engines` field changed, no dependency drift. |

**No §7b/§11**: 6 files (R5-L1, corrected count: `secret-patterns.mjs`,
3 test files, `package.json`, `package-lock.json`), 1 subsystem
(shared-lib) + its two dedicated regression-lock test files, single
sitting — flat plan by Gate 1 (file count is borderline but there is no
dependency chain or multi-subsystem split; every file is a mechanical
extension of the same one-function fix, and `package-lock.json` is a
regenerated, not hand-authored, artifact).

---

## 8. Risk & Trade-off Register

| Risk / trade-off | Assessment |
|---|---|
| **`d` flag support** (audit M1, R2 — `>=16` would UNDERSTATE the real floor, not establish it) | Every `.github/workflows/*.yml` pins `node-version: '22'` uniformly (checked: `release.yml`, `migration-drift.yml`, `postgres-parity.yml`, `learning-weekly-review.yml`, `memory-health.yml`, `model-freshness.yml`, `architectural-drift.yml` — 22 across the board, no outlier). `package.json` gets `"engines": {"node": ">=22"}` — this documents the floor CI **already verifies today** (not a new claim this plan invents, and not a full repo-wide compatibility audit of every dependency either — that's independent of this fix; scoped here to correcting the previously-absent, previously-"implicit" declaration to match observed CI truth). `>=22` comfortably covers the `d` flag's actual Node ≥16 requirement, so no separate floor-vs-feature tension remains. |
| **Existing callers unaffected** | `sensitive-egress-gate.mjs` and `audit-scope.mjs` call through `redactSecrets` by reference — no call-site changes needed; both get the fix automatically. |
| **Performance** | `matchAll` + one pass per pattern is the same asymptotic cost as the current `String.replace` loop (both are O(matches) per pattern) — no measurable regression expected at this text-scan scale (audit file bodies, KB-sized). |
| **Deliberately deferred**: the `dsn-password` regex's own password-boundary assumption (`[^@\s]+` stops at the first literal `@`, so a password itself containing `@` truncates early) | Independent — a pre-existing, narrower edge case unrelated to the positional-collision bug this plan fixes; the plan's correctness does not depend on it. Noted for a future pass if it ever proves load-bearing. |

---

## 9. Testing Strategy

- **Unit (hermetic, in `npm test`)**: the 7 new cases in
  `tests/secret-patterns.test.mjs` (see §7 — scheme collision, username
  collision, generic-token non-collision regression, two-DSN same-string
  case, fail-closed `_internals.resolveRedactionSpan`, PEM byte-for-byte,
  `d`-flag-unsupported fallback), test-first per the Tier-3 mandate —
  written and confirmed RED against the current buggy implementation
  before the fix lands, then GREEN after.
- **Regression-lock (Tier-3 load-bearing paths, audit H1)**: ONE
  collision case added to each of `tests/sensitive-egress.test.mjs`
  (provider-boundary gate) and `tests/audit-scope-egress.test.mjs`
  (the actual `/audit-code` file-assembly path) — proves the fix reaches
  the two paths a leak would actually travel through, not just the
  unit-level function. The rest of both files re-runs unmodified and
  must stay green (proves the fix doesn't change *detection*, only
  redaction *position*).
- **Prototype already verified** (this session, ad-hoc, informs the
  design above — not a substitute for the committed tests): all four
  collision cases redact the correct span; the existing test suite's
  non-collision DSN cases (Sup3rS3cret, pw123, t0ps3cret, cachepass)
  continue to redact correctly; the multi-line PEM case preserves line
  count exactly; a same-string two-DSN case redacts both independently.
- **Key edge cases covered**: scheme-substring collision, username==password
  collision, multi-match-per-pattern-per-string, generic-token's
  structural immunity to same-string collision (proved, not assumed),
  fail-closed non-participating capture group, `d`-flag-unsupported
  full-match fallback, PEM multi-line byte-for-byte preservation
  (upgraded from a newline-count-only check).

---

## Out of Scope (Future)

- **R3-H2 (Section 9 as "Acceptance Criteria")**: dismissed as a category
  error, not deferred. The `/plan` skill's own Phase 6 structure makes
  §10 Acceptance Criteria (the machine-parseable, Playwright-verifiable
  format) conditional on `scope ⊇ frontend`; this plan is `backend`-only,
  so §9 Testing Strategy in narrative form is the *correct* section per
  the skill's own spec, not a gap. No plan change made.
- **`dsn-password`'s `@`-in-password truncation** (from §8): independent,
  pre-existing, narrower edge case; this plan's correctness does not
  depend on it.

## Audit Trail

- **GPT rounds**: R1 `SIGNIFICANT_GAPS` H3/M2/L1 → all 6 folded in
  (precise test specs, runtime feature-detection design, verified
  `engines` floor). R2 M1/M2/L1 → all folded in (evidence-grounded
  `engines`, exact API entry points matching each test file's own
  convention, exact PEM literal). R3 H2/H1/M1 → H1 (d-flag runtime
  fallback) and M1 (flag-preservation + result-contract precision)
  folded in; H2 dismissed as a category error (see Out of Scope above).
  R4 (one past cap, exceeded for genuine bugs — feedback_rigor_cap_genuine_bugs_exception):
  H1 caught a real self-contradiction in R3's own fallback design (the
  unconditional `+'d'` construction would throw before the fallback
  branch could execute); M1 caught that ESM export bindings can't be
  monkeypatched, so the R3 test design couldn't have exercised what it
  claimed to test. Both are genuine correctness bugs in THIS plan's own
  R3 fix, not rigor pressure — fixed properly (conditional regex
  construction; real dependency-injection via `_internals.redactWithPatterns`).
  L1 (lockfile sync) folded in. R5 `READY_TO_IMPLEMENT`, H:0 M:0, 2 LOW
  cosmetic-precision findings (file count, pinned generic-token oracle) —
  both fixed. Stopped at R5 — genuine convergence (not a cap-exceeded
  stop): zero HIGH/MEDIUM, remaining findings were both trivial and both
  fixed.
- **Gemini final gate**: R1 `APPROVE` — 0 new findings, 0 wrongly-dismissed.
  Deliberation-quality read: GPT's R3/R4 catches (unconditional `'d'`-flag
  construction throwing before the fallback could run; ESM export
  bindings can't be monkeypatched) were correctly accepted without bias;
  GPT's one false positive (Section 9 vs the frontend-only Section 10
  format) was correctly dismissed with a repo-convention-cited rationale.
  No round 2 needed.

## Implementation Log

### 2026-07-16
- **Completed**: `scripts/lib/secret-patterns.mjs` (`redactWithPatterns`,
  `resolveRedactionSpan`, `D_FLAG_SUPPORTED`, `_internals`), 7 new tests
  in `tests/secret-patterns.test.mjs` (test-first, RED confirmed before
  the fix, GREEN after), one collision case each in
  `tests/sensitive-egress.test.mjs` and `tests/audit-scope-egress.test.mjs`,
  `package.json` `engines`, regenerated `package-lock.json` (diff
  verified: only the `engines` field, zero dependency drift).
- **Code-audit trail** (4 GPT rounds + 1 Gemini round, `APPROVE`): every
  HIGH finding across all 4 rounds was a confirmed false positive, verified
  by direct evidence each time — round 1's "unsafe `redact:false`
  fixture" claim disproven by `git diff` (plaintext fixture, real
  assertion); round 3's "already-redacted fixture" claim root-caused to
  the audit pipeline's OWN `readFilesAsContext` redacting my test file's
  literal `admin:admin` fixture before GPT ever saw it (confirmed by
  directly invoking `readFilesAsContext` on the test file) — the exact
  issue class this plan fixes, now observed hitting test fixtures
  specifically. A recurring `scripts/foo.mjs` hallucination (illustrative
  plan prose, not a real reference) and the standing family of unrelated
  `.audit-loop/domain-map.json` architecture findings were dismissed each
  round. Gemini's `deliberation_quality`: "GPT's findings were entirely
  false positives... Claude's responses were highly rigorous, objective,
  and accurately bounded."
- **Remaining**: nothing from this plan's scope.
- **Deviations**: none — implemented exactly as the 5-round-audited plan
  specified.
- **New follow-up surfaced** (not fixed here, out of scope): the
  redaction-corrupts-audit-input issue now confirmed to affect test
  fixtures too, not just `buildDsn()`-style source strings — worth
  deciding whether audited test files should be exempt from
  `readFilesAsContext`'s default `redact: true`, or whether that's
  working as intended (test fixtures containing example secrets are, in
  fact, secret-shaped strings). Also noted: intermittent single-test
  flakiness in the full suite, non-reproducible on immediate re-run,
  observed 3 times this session across unrelated changes — worth a
  separate investigation.

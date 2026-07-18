# Reference integrity — the citation contract

**Enforced by** [`scripts/check-docs-refs.mjs`](../../scripts/check-docs-refs.mjs)
(`npm run docs:refs`). Plan: [`reference-integrity-gate.md`](../plans/reference-integrity-gate.md).

A doc's claim about a repo path should be *checkable*. This file is the contract
that makes it mechanical: what counts as a citation, what must resolve, and what
is deliberately exempt.

> **Why a written grammar, not "you know it when you see it".** A lint that
> *guesses* which path-shaped strings are real becomes noise, and noisy gates get
> bypassed — which is how the repo accumulated its stale citations in the first
> place. This repo has already paid for that lesson once:
> `scripts/lib/model-eval/egress-path-scan.mjs` documents a 2026-07-12 incident
> where a path-shaped-token gate false-positived on an audit finding's own prose,
> *and* a same-day revert when the fix over-tightened and broke recall. So the
> rule here is: **placeholders are marked, never guessed.**

`REFS_GRAMMAR_VERSION = 1`

---

## 1. The grammar

A citation is one of **two mutually-exclusive alternatives**:

```
citation    := concrete | placeholder
concrete    := "docs/" (seg "/")* stem ".md"
placeholder := "docs/" (seg "/")* phstem ".md"
seg         := [A-Za-z0-9._-]+                            ; segments are ALWAYS concrete
stem        := [A-Za-z0-9._-]+
phstem      := "<" [A-Za-z0-9._-]+ ">"                    ; bracketed final stem
             | [A-Za-z0-9._*-]* "*" [A-Za-z0-9._*-]*      ; glob final stem
```

They are disjoint by construction: a final stem either contains `<`/`*` or it does
not. The parser emits exactly one alternative per token and records which.

### Boundaries

**The grammar's regex IS the extractor.** It terminates at `.md`, so trailing
punctuation is never consumed — there is no extract-then-validate step and no
punctuation-stripping pass.

| Side | Rule |
|---|---|
| Leading | `(?<![A-Za-z0-9._/*-])` — includes `/` so `wine-cellar-app/docs/plans/a.md` (a **cross-repo** path) never matches. It **deliberately excludes `<`**: a CommonMark angle-bracket link destination `[x](<docs/plans/a.md>)` is a real citation, so a preceding `<` must not block the match (excluding it silently dropped such refs — a false negative). The placeholder `<` lives *inside* the token, consumed by `phstem`, so it never needed to be in this class. |
| Trailing | Two negative lookaheads: `(?![A-Za-z0-9_-])` (so `.mdx` is not this token) **and** `(?![./][A-Za-z0-9._-])` (so a `.`/`/` that continues into a longer token — `real.md.bak`, `real.md/obsolete` — does not terminate here; the continuation class equals `seg`/`stem`). A `.` followed by end/space/punct is a sentence period and still terminates. |

Why it matters: an earlier draft put `.` in the trailing boundary class (extensions
need it), which made `See docs/plans/my-plan.md.` extract as `docs/plans/my-plan.md.`
— failing the `.md`-terminated rule and falling **silently** into "not a citation".
Every prose citation ending a sentence would have been dropped by the gate meant to
catch them. Anchoring on `.md` fixes it by construction:

| Input | Result |
|---|---|
| `See docs/plans/x.md.` | `docs/plans/x.md` — the `.` is outside the match |
| `docs/plans/x.mdx` | **no match** (`x` fails the lookahead) |
| `wine-cellar-app/docs/plans/a.md` | **no match** (`/` fails the lookbehind) |

### Resolution

- **Only `concrete` is resolved.** `placeholder` is emitted as `PLACEHOLDER` and
  never resolved — a placeholder can therefore never be a finding.
- Resolution is against the **git index** (`git ls-files`), *not* `fs.existsSync`.
  The index is case-exact, so the verdict is identical on case-insensitive Windows
  and case-sensitive CI. A ref to `docs/plans/Foo.md` for `foo.md` is a finding on
  both.
- A trailing `#fragment` / `?query` is stripped before resolution; the fragment is
  never validated (it is not a path).
- A token containing `..` is a **finding**, never resolved.

### Contexts

**One parser, one rule: a token matching the grammar is a citation wherever it
appears.** Plain prose, code comments, JSON strings, Markdown link destinations,
and Markdown link *labels* are all the same — there is no per-context special
case to get wrong.

That means `[docs/plans/a.md](docs/plans/a.md)` is **two sites**, not one, and
that is correct: a label naming a path is itself a claim about that path. Both
sites resolve identically and both are fixed by the same edit, so the duplication
costs nothing. (An earlier draft said "only the destination is extracted" — a
rule the implementation never had and did not need. It was removed rather than
implemented: it added a context-sensitive branch to buy nothing.)

Each occurrence is its own **site**; a marker binds to its own token only.

---

## 2. Classes

| Class | Meaning |
|---|---|
| `RESOLVES` | The concrete target exists in the git index. |
| `GONE` | The concrete target does not exist. **This is the finding.** |
| `PLACEHOLDER` | Syntactically marked (`<…>` or a `*` glob). Never resolved. |
| `traversal` | Contains `..`. |
| `stale-planned-marker` | Marked `(planned)` but the target now resolves — the marker outlived its reason. |

> **There is deliberately no `MOVED` class.** `MOVED` is a claim about *relocation
> history*, and this gate has no relocation map: it cannot distinguish "moved" from
> "deleted" without one, and inferring a move from a sibling directory would be
> exactly the guessing this contract forbids. Relocation is a one-time migration
> concern and belongs to the tool that owns the manifest.

### The `(planned)` marker

A forward-reference to a doc that does not exist *yet* is legitimate — e.g.
`skills/click-test/SKILL.md`: *"Tracked in `docs/plans/click-test-v2-persistence.md`
(file to be created when v2 starts; not a v1 blocker)"*.

Mark it, and the lint honours it:

```markdown
See docs/plans/click-test-v2-persistence.md (planned)
```

**Attachment rule** — valid **only** as the literal `(planned)` immediately
following the token, separated by at most one space, or by a single closing
`` ` `` / `)` then one space. Nothing else on the line, in the sentence, or in an
enclosing block confers it. Placeholder-ness and planned-ness are properties of the
**token**, never of nearby prose.

A `(planned)` marker on a token that now resolves is itself a finding — it cannot
outlive its reason.

---

## 3. Scan policy

`scanPolicy(path)` → `text` | `binary` | `unclassified`. Applied **after** `lstat`,
**before** any read.

- **`text`** — an explicit extension set, **plus extensionless basenames** measured
  from the tracked inventory (`.gitignore`, `.githooks/*` — both carry real
  citations and neither has an extension).
- **`binary`** — explicit exclusions; skipped silently.
- **`unclassified`** — anything else: **reported, and the run exits non-zero.**

A new tracked text format must therefore force an explicit policy decision rather
than vanishing from coverage. A silently skipped file yields a green "0 refs" that
never checked the changed citation — the success-path hole
[`pre-ship-empirical-verify.md`](../runbooks/pre-ship-empirical-verify.md) rule 3
names.

---

## 4. Exclusions

Each exclusion declares its reason **in source** (mirroring
`check-docs-placement.mjs`'s `ROOT_ALLOWLIST`, so a stale entry is self-evident on
read).

| Surface | Why |
|---|---|
| `supabase/migrations/**` | **FROZEN.** `setup-postgres.mjs` pins a per-file `sha256` over the **whole file, comments included**, and refuses to re-apply on a mismatch. Editing a `-- Plan: …` banner in an applied migration breaks the migration ledger for **every consumer repo**. A stale citation here is permanent by design. |
| `docs/experiments/**/known-defects*.json` | **CORPUS.** Other repos' plan paths, mined from commits across three repos. Not citations at all. |
| `docs/plans/security/files/**` | **VENDORED.** A portable kit, path-mirrored on purpose. |
| `status.md` | **HISTORICAL.** An append-only session log; a past entry was true when written. Rewriting it falsifies the record. |
| `tests/**` | **FIXTURE.** Test files are not documentation — they construct synthetic doc paths as *data* (`docs/plans/a.md` written into a temp dir), not citations of real files. Structural subtree scope, not a per-token allowlist. Accepted trade-off: a stale docs ref inside a test comment goes unchecked (acceptable decay under the drift-gate). |
| `docs/arm-eval/**` | **TOOL_OWNED.** Append-only runtime export archives, tool-written (listed in `docs/README.md` under "Tool-owned directories"). Same class as HISTORICAL. |

Cross-repo references need no exclusion — they are structurally invisible to the
parser (the leading lookbehind includes `/`).

> **Design note (multi-LLM review, 2026-07-18) — LIVE since Cluster C.** An
> exclusion list is only safe because the gate is **drift-only**: under `--gating`
> (wired into `npm run check` as `docs:refs:gate`) it fails on a ref that is NOT in
> the accepted **baseline** — i.e. one that *newly* broke — never on the standing
> GONE total. That makes a noisy baseline free: write-target `--out` paths,
> never-produced generated artifacts, and illustrative comments sit in the baseline
> (`BASELINE` in `scripts/check-docs-refs.mjs`, keyed `<file>→<target>`) and never
> fire. Shrinking the baseline (a baselined ref that later resolves) is always fine;
> a GONE not in it is drift and fails. The alternative (chase every GONE to zero) is
> the noise-then-bypass spiral this gate exists to avoid. Exclusions are for whole
> *surfaces* that are not authored reference prose; the baseline absorbs individual
> non-citation path literals.

---

## 5. Fixing a finding

| Situation | Action |
|---|---|
| The doc moved | Update the citation to its real path. |
| The doc never existed / was deleted | Delete the claim, or write the doc. |
| It's an example, not a claim | Mark it: `docs/plans/<name>.md`. |
| It's a real forward-reference | Mark it: `docs/plans/thing.md (planned)`. |
| It's a write-target / generated output / illustrative example | **Leave it** — it belongs in the drift-gate baseline, not a fix. Marking a real `--out` path as a `<placeholder>` would be wrong. |
| It's a genuinely new exempt *surface* (a whole subtree of non-authored prose) | Add it to the exclusion table **with its reason** — never to silence an individual finding. |

**Do not** add a bare filename to an allowlist to make the gate pass. An allowlist
of bare filenames silently absolves real typos; that is why legacy literals
(`X.md`, `feature.md`, `my-feature.md`) were migrated to the marked form rather
than exempted.

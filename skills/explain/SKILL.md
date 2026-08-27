---
name: explain
description: |
  Explain WHY a piece of code is structured the way it is. Synthesises
  architectural-memory similar-symbols, git history (blame + commits +
  PR context), AGENTS.md/CLAUDE.md principles, and any plan documents
  that mention the target. Useful for onboarding ("why is this here?"),
  debugging ("why is X structured this way and not Y?"), and refactoring
  ("can I change this safely or is there hidden context?").
  Pick by INPUT: a TOPIC to survey comes here ("have we touched rate
  limiting?"); a CLAIM to test goes to /investigate ("that landed in July" —
  it uses --history as one of its instruments).
  Triggers on: "why is this", "explain this code", "why does this exist",
  "what is this for", "/explain", "give me context on".
  Full command syntax: see the Usage section in this skill.
---

# Code Explainer

> **Worktree preflight** — in a linked git worktree the synced tooling tree
> `scripts/.claude-skills/` is absent — it is gitignored, so `git worktree add`
> does not populate it, and every command below that uses it dies on a bare
> `MODULE_NOT_FOUND`. Run `npm run skills:hydrate` first.
>
> If this repo defines no such script, it has not adopted the remedy yet. Add
> this entry to its `package.json` `scripts` and run it — it copies the tooling
> tree in from the main checkout, and leans on nothing but node and git:
>
> "skills:hydrate": "node -e \"const{execFileSync}=require('node:child_process'),p=require('node:path'),f=require('node:fs');const main=p.dirname(execFileSync('git',['rev-parse','--path-format=absolute','--git-common-dir'],{encoding:'utf8'}).trim());const dir='scripts/.claude-skills';const src=p.join(main,dir);if(p.resolve(dir)===p.resolve(src)){console.log('[hydrate] main checkout - nothing to do');process.exit(0)}if(!f.existsSync(src)){console.error('[hydrate] no tooling at '+src+' - re-sync the main checkout first');process.exit(1)}f.cpSync(src,dir,{recursive:true});console.log('[hydrate] copied '+src)\""
>
> Rationale (source repo only — `docs/runbooks/` is not synced to consumers):
> `docs/runbooks/consumer-adoption.md` §"Linked git worktrees".

## Usage

```
Usage:
  /explain <file>                       — Explain the file's purpose + history
  /explain <file>:<line>                — Explain a specific line/section
  /explain <symbol-name>                — Find + explain a function/class by name
  /explain <file>:<line> --depth=full   — Include full neighbourhood + all blame
  /explain --history "<topic>"          — "Did we already solve this?" — cross-source search
```

Multi-source synthesiser for "why is this here?" questions. Given a
target (file, file:line, or symbol name), gathers context from four
sources and produces one coherent explanation.

**This skill does NOT modify code.** Read-only — gathers + synthesises.

---

## Step 0 — Parse Target

Input shapes:

| Input | Action |
|---|---|
| `<file>` (e.g., `scripts/openai-audit.mjs`) | Whole-file mode — explain purpose + history |
| `<file>:<line>` (e.g., `scripts/openai-audit.mjs:412`) | Section mode — explain the symbol containing that line |
| `<symbol-name>` (e.g., `runMultiPassCodeAudit`) | Symbol mode — find the file:line via architectural-memory + Grep, then explain |
| `--history "<topic>"` | **History mode** — "did we already solve this?" — jump to §History Mode below; skip Steps 1–5 |

Validate the file exists (file/section/symbol modes only). If symbol mode
+ symbol not found, exit with "Symbol '<name>' not found in repo via
architectural-memory or grep — narrow the query (try `<file>:<line>`)."

---

## History Mode — `--history "<topic>"`

When the input is `--history "<topic>"` (e.g. `/explain --history "rate limiting"`),
the question is "have we touched this before?" rather than "why is this here?"
Skip the file-shaped Steps 1–5 and run the cross-source aggregator instead.

### Invocation

```bash
node scripts/explain-history.mjs --topic "<topic>" [--since "<git-since>"] [--paths "<csv>"] [--limit <n>]
```

The aggregator searches four independent sources:

1. **Git log** — three passes: commit subjects + bodies (case-insensitive
   `--grep`); commits that introduced/removed the string (`-S`); and commits
   that touched any line mentioning it (`-G`). `-S` alone misses **moves** —
   a string deleted from one line and re-added verbatim on another leaves the
   net count unchanged, so `-S` reports nothing and you conclude the change
   never happened. Results are labelled per pass and selected round-robin so
   one pass cannot consume the whole `--limit`.
2. **Architectural memory** — `cross-skill.mjs get-neighbourhood` with
   the topic as `intentDescription` (similar symbols + recommendations)
3. **Plan documents** — line-by-line grep over `docs/plans/**/*.md` with
   heading context preserved so each match is anchored
4. **Brainstorm session ledger** — scan `.brainstorm/sessions/*.jsonl`
   for matching topics OR provider-response substrings (so the search
   surfaces "I asked OpenAI about X back in session Y" too)

Output: one JSON document with per-source results plus a unified
chronological timeline (most-recent first; plan matches use the plan
file's mtime as a date proxy).

Add `--skip-arch` when the cloud is offline or when the user wants
faster local-only search.

### Render the result

Read the helper's JSON output and produce a Markdown digest. Structure:

```markdown
## "<topic>" — prior touches

<helper's `summary` field verbatim>

### Timeline (most recent first)

For each item in `chronological`, render one bullet:
- **<date>** [<kind>] <summary> — `<ref>` (and author for git)

If empty, write: "No prior touches found — this appears to be new ground."

### Per-source detail

#### Git commits (`<count>`)
| Date | SHA | Author | Subject | How matched |
|---|---|---|---|---|
| <date> | `<sha>` | <author> | <subject> | <git-subject \| git-content \| git-touched> |

#### Architectural-memory (`<count>`)
| Sim | Symbol | Path | Recommendation | Purpose |
|---|---|---|---|---|
| <sim> | `<symbol>` | `<path>` | <reuse \| extend \| review> | <purpose> |

(If `archMemory.skipped` is set, render: "_arch-memory skipped: <reason>_")

#### Plan documents (`<count>`)
| Path | Heading | Excerpt |
|---|---|---|
| `<path>:<line>` | <heading> | <excerpt> |

#### Brainstorm sessions (`<count>`)
| Date | Session | Round | Matched in | Excerpt |
|---|---|---|---|---|
| <capturedAt> | `<sid>` | <round> | <topic \| provider-response> | <excerpt> |
```

Omit empty source-sections rather than printing empty tables.

### What to look for / how the user uses this

- **High git + high plan touches** → topic is well-known; the user
  should READ the plan first before re-solving
- **High brainstorm + low git** → topic was discussed but not implemented
  → user should consider resuming the brainstorm (`/brainstorm continue
  <sid> <new-angle>`)
- **High arch-memory + low everything-else** → similar code exists but
  the topic itself isn't documented → recommend `/explain <symbol>`
  on the matched record
- **Empty across all four** → genuinely new ground; safe to plan from
  scratch via `/plan "<topic>"`

### Output rules

- **Read-only** — same as the file/section modes; never edits anything
- **Cite sources** — every claim in the digest maps to one of the four
  source sections
- **Cost is small** — `~$0.0003` for the arch-memory embedding (skipped
  when `--skip-arch` or cloud is offline); the other three sources are
  local-only

---

## Step 1 — Gather Architectural-Memory Context

If `cross-skill.mjs` exists in the repo and Supabase is configured:

```bash
# 1. Near-duplicates and similar symbols
node scripts/cross-skill.mjs get-neighbourhood --json '{
  "targetPaths": ["<file>"],
  "intentDescription": "Understand the purpose and shape of <symbol-or-file>",
  "k": 6
}'

# 2. Domain assignment (Plan v6 §2.4 — anchors the explanation in
#    the architecture map's domain structure)
node scripts/cross-skill.mjs compute-target-domains --json '{
  "targetPaths": ["<file>"]
}'

# 3. Caller domains (cross-domain reach detection — Plan v6 §2.4)
node scripts/cross-skill.mjs get-callers-for-file --json '{
  "path": "<file>"
}'
```

Use the result to:
- Identify **what this symbol does** (the `purposeSummary` of the matching record)
- Identify **near-duplicates** — sibling symbols solving similar problems
- Identify **recommended uses** — if the matched record's recommendation is `reuse`, that's a signal this is the canonical version of a pattern
- Identify **the file's home domain** (from `compute-target-domains.domains[0]`) — emit as `**Domain**: \`<X>\`` in the output
- Identify **cross-domain reach** (from `get-callers-for-file`) — see deterministic spec below

### Cross-domain reach detection (deterministic — Gemini-R2-G3)

Let `homeDomain = compute-target-domains.domains[0]` and `callerDomains
= get-callers-for-file.callerDomains`. Trigger the "Cross-domain reach
detected" finding **if and only if all of**:

1. `callerDomains.length > 0` (importers exist)
2. `nonSelfCallerDomains = callerDomains.filter(d => d !== homeDomain)` has length **> 0** (any external-domain caller is the leak)
3. `homeDomain` is NOT `null`/`"unknown"` AND is NOT in the cross-cutting allowlist: `["shared-lib", "shared-frontend", "core", "utils", "scripts"]` (Audit-Gemini-G4: untagged files would otherwise spam false-positive cross-domain warnings on every importer — skip the check entirely when the file's home domain is unknown)
4. `get-callers-for-file.snapshotProvenance === "import-graph-populated"` (skip silently if "pre-feature-snapshot" / "no-active-snapshot" / "cloud-disabled" — false signal otherwise)

When triggered, render exactly:

```markdown
**Cross-domain reach detected**: `<homeDomain>` file called from
`<nonSelfCallerDomains[0]>`, `<nonSelfCallerDomains[1]>` (etc) — explain whether this is intentional shared API vs leaked internal.
```

Omit the section entirely when not triggered.

If Supabase is offline → skip all three subcommands and note
`[arch-memory: unavailable]` in the output.

---

## Step 2 — Gather Git History

```bash
# Who wrote it + when (last 5 lines of context if line is specified)
git blame -L <line>,<line>+5 <file>

# When the file was created + changed (last 10 commits)
git log --oneline -10 -- <file>

# Recent commits that touched the symbol (if line known)
# NOTE: use git's native +offset syntax — git does NOT evaluate "<line>+10"
# arithmetic in -L. Pass +10 directly so git computes line + 10 internally
# (Gemini-R1-G4 fix).
git log -L <line>,+10:<file> --oneline | head -10

# PR context (if gh CLI available)
LAST_COMMIT=$(git log -1 --format=%H -- <file>)
gh api "repos/{owner}/{repo}/commits/$LAST_COMMIT/pulls" --jq '.[].title' 2>/dev/null
```

Extract:
- **Author + date** of the most recent change to this section
- **Commit message** that introduced the section (often has the WHY)
- **PR title** if available (often has the requirement / bug context)
- **Co-evolution** — files frequently changed together (signals coupling)

---

## Step 3 — Find Principle Citations

Search AGENTS.md, CLAUDE.md, and any docs/plans/*.md for mentions of:
- The file path
- The symbol name
- Patterns this code uses (e.g., "single source of truth", "graceful degradation" — these often have explicit citations near the relevant code)

```bash
grep -rn "<symbol-name>\|<file>" AGENTS.md CLAUDE.md docs/plans/ 2>/dev/null | head -20
```

Look specifically for:
- Plans that planned this code (often explain WHY a particular design)
- "Accepted Technical Debt" entries (explain what compromises were made)
- "Do NOT" rules (explain the discipline being enforced)

---

## Step 4 — Read the Code Itself

Read the target file (or the symbol's enclosing function/class). Look for:
- **Doc comments** — explicit author intent
- **Type signatures** — what contract is being enforced
- **Imports** — what this depends on
- **Surrounding code** — how it's called

For section mode (file:line): read 30 lines of context around the target line.

---

## Step 5 — Synthesise

Produce a single Markdown response with these sections (omit any that
have no data):

```markdown
## What it is

One sentence describing the symbol/file purpose.

## Why it exists (history)

- Created **YYYY-MM-DD** by **<author>** in commit `abc1234` ("commit message")
- Most recent substantive change: **YYYY-MM-DD** by **<author>** ("commit message")
- Originating PR: #N "<title>" (if known)
- Co-evolved with: <files frequently changed together>

## Why this shape (architectural context)

- Plan: `docs/plans/<plan-file>.md` motivated this design (cite the relevant section)
- Principle citations from AGENTS.md / CLAUDE.md: <list>
- Architectural-memory ranking: this is the **canonical** version of <pattern> / OR a **sibling** to <other symbols>
- Accepted technical debt: <relevant entries from AGENTS.md "Accepted Technical Debt">

## Near-duplicates / related code

If architectural-memory found similar symbols, list them with similarity scores:

| Sim | Symbol | Path | Purpose |
|---|---|---|---|
| 0.85 | `<other>` | `path:line` | <purpose> |

Note explicitly whether this is the canonical version or an alternate.

## Safe-change advice

Based on coupling + plan + principles:
- **Safe to change** (low coupling, no plan citations) — list any tests that will catch regressions
- **Change with care** (cited in plan, has near-duplicates) — list the plan section to update + sibling symbols to reconcile
- **Do not change without re-planning** (load-bearing per plan, frequently co-changed with multiple files) — recommend running `/plan` for the proposed change first

## Sources used

- arch-memory: <yes/no>
- git blame: <N lines>
- git log: <N commits>
- AGENTS.md/CLAUDE.md: <N matches>
- docs/plans/*.md: <N matches>
- file read: <bytes>
```

Keep the response under ~600 words. If a section is empty (e.g., no plan
mentions), omit it rather than padding.

---

## Output rules

- **Read-only** — never edit, never commit, never trigger workflows
- **Cite sources** — every claim must be traceable to one of the four sources
- **No speculation** — if the WHY isn't in any source, say "no recorded reason" rather than guessing
- **Useful for next action** — the "Safe-change advice" section is the most actionable part; make it specific
- **Cost is small** — at most 1 architectural-memory consultation (~$0.0003) + git operations (free) + 1 file read

---

## Citing what you found

Every `file:line` this skill emits is a claim about a moment in history, so
**pin it to the commit you read it at** — `scripts/explain-history.mjs:120 (a4ec98da)`. A
path alone is durable; a path plus a line is a snapshot that decays silently
into a *wrong-but-resolving* reference. Measured: of nine bad claims in one
verified document, five were correct when written and rotted afterwards.

Cite append-newest-first files (`status.md`, changelogs, session logs) **by
section header, never by line** — every new entry shifts every earlier line, so
those citations begin decaying immediately. Cite an untracked or off-disk path
as `git show <sha>:<path>`; it resolves to nothing for any other reader.

→ `references/verification-discipline.md` §1.

---

## Reference files

This skill is a multi-source synthesiser: its evidence comes from the repo +
architectural-memory + git, gathered fresh each invocation. The one file below
covers a specialised situation — read it when the trigger applies.

| File | Summary | Read when |
|---|---|---|
| `references/verification-discipline.md` | Verification discipline — pinned citations, figure provenance, two-direction proof, attribution, consumer-side checks. | Writing any `file:line` citation into the explanation — every one needs the commit it was read at (§1). |

# Skill Reference-File Format Specification

This document defines the contract for reference files in skills that use
**progressive disclosure** — canonical SKILL.md flow plus on-demand reference
files under `references/` or `examples/`.

Source of truth for `scripts/check-skill-refs.mjs` lint.

## Why progressive disclosure

Claude Code loads a skill's `SKILL.md` body only when the skill is invoked.
Sibling files in the skill directory are **not automatically loaded** —
Claude must explicitly `Read()` them. Keeping edge / reference / large-format
content outside `SKILL.md` trades per-invocation token cost for an explicit
Read call, paid only when the reference is actually needed.

## Directory shape

```
skills/<skill-name>/
├── SKILL.md                    ← canonical flow; target ≤3K tokens
├── references/                 ← optional — rare/edge/lookup content
│   ├── <topic-a>.md
│   └── <topic-b>.md
└── examples/                   ← optional — long output templates
    └── <example-name>.md
```

- `SKILL.md` is **required**.
- `references/` and `examples/` directories are **optional** — create them only
  when a skill has content that meets the criteria below.
- No other files may live in a skill directory. Code belongs in `scripts/` at
  repo root. Configuration belongs in the manifest. The packaging allowlist
  (`scripts/lib/skill-packaging.mjs`) enforces this.

## Reference-index section in SKILL.md

Every `SKILL.md` that has sibling files **MUST** end with exactly one section
matching this shape. A skill with no sibling files omits the section entirely.

```markdown
## Reference files

This skill's canonical flow is above. The files below cover specialised
situations — read them only when the trigger applies.

| File | Summary | Read when |
|---|---|---|
| `references/interop.md` | How this skill feeds /audit-loop, /ship, /plan-*. | The user asks about cross-skill effects, OR you need to emit a correlation row. |
| `references/troubleshooting.md` | Recovery from mid-session failures. | A tool call fails twice in a row, OR the user asks "what went wrong". |
```

### Table rules (parser-enforced)

- The section heading is exactly `## Reference files`.
- The table has exactly three columns in this order: `File`, `Summary`, `Read when`.
- `File` is a relative path starting with `references/` or `examples/`.
- `Summary` is a single line ≤120 characters.
- `Read when` is a trigger clause — a **specific, detectable condition**.
- Entries are sorted by expected read frequency (most-likely first).

## Reference-file frontmatter

Every file under `references/` or `examples/` **MUST** begin with YAML
frontmatter containing a canonical `summary` string that is **byte-identical**
to its row in the parent `SKILL.md` reference-index.

```markdown
---
summary: How this skill feeds /audit-loop, /ship, /plan-*.
---

# Rest of the reference file…
```

### Frontmatter rules (lint-enforced)

- Opens with `---` on line 1, closes with `---` on its own line.
- Contains exactly one key: `summary:`.
- `summary` value is a single-line string, ≤120 characters.
- The summary **must exactly match** the `Summary` column in the parent
  SKILL.md reference-index entry that points at this file.

### Why exact-match

Fuzzy matching ("compare first paragraph", "flag large divergence") is a
heuristic — different implementers would score differently, and the lint
becomes policy-by-documentation rather than enforcement. The frontmatter
`summary` is the contract between the reference body and its index entry.
Forcing exact equality with a simple failure mode keeps the contract honest:
any change to one MUST update the other.

## Trigger writing — rules and anti-patterns

A good trigger answers **"what must be true before this reference should be
loaded?"** in a way Claude can detect at runtime.

### Good triggers

- "The user asks how this skill interacts with /ship"
- "Step 4 fails twice in a row"
- "About to generate the debrief section"
- "Plan includes modal interactions"
- "The response payload size exceeds 10 KB"
- "Running against an external / anti-bot URL"

### Bad triggers (reject in review)

- ~~"when relevant"~~ — every reference is "relevant"; defeats the point
- ~~"before proceeding"~~ — every invocation has a proceeding step
- ~~"if useful"~~ — offers no decision rule
- ~~"for context"~~ — every invocation has context
- ~~"when you need more detail"~~ — the reference body always has more detail

Triggers that fail review are blocked at PR time by the lint's anti-pattern
deny-list (follow-up; not in Phase A).

## Reference-file content rules

- A reference file should be **self-contained** for the case the trigger
  describes. Don't require a second Read to understand it.
- References may link to other references. Avoid long chains — 2 hops max.
- References should NOT duplicate canonical SKILL.md content. If a section
  appears in both, the reference is the source of truth; SKILL.md summarises.
- Keep references focused. A reference that covers 5 unrelated topics is
  actually 5 references.

## When to split content into a reference

Move a section from `SKILL.md` to `references/<topic>.md` when:

1. The section is **>40 lines** AND is not exercised by the canonical flow, OR
2. The section is an **enum / catalogue** (persona types, assertion patterns,
   framework lookup tables), OR
3. The section is **large-format output template** (report bodies, debrief
   narratives, spec file templates) that inflates SKILL.md but isn't consulted
   during the planning steps, OR
4. The section describes **cross-skill integration** that's only relevant when
   another skill is present in the flow, OR
5. The section handles **rare / recovery / troubleshooting** cases.

Content that fails all five tests stays in SKILL.md.

## Examples folder

`examples/` is reserved for **full output samples** — complete report bodies,
generated spec files, debrief narratives. Content there is read when:
- The skill is about to emit similar output and needs the shape, OR
- The user explicitly asks for a sample.

Examples are not trigger-loaded by edge conditions. They're bulk reference
material that would bloat SKILL.md if inlined.

## Lint — what `check-skill-refs.mjs` enforces

For each skill under `skills/<name>/`:

1. If SKILL.md has a `## Reference files` section, the table parses cleanly
   (three columns, each row well-formed).
2. Every `File` listed in the table corresponds to an existing file.
3. No orphan files — every file under `references/` or `examples/` appears in
   the table.
4. Every reference file has valid frontmatter with a `summary:` key.
5. Each reference's frontmatter `summary` is byte-identical to its index-row
   Summary column.
6. If SKILL.md has NO reference-index section, then `references/` and
   `examples/` must not exist or must be empty.

Violations exit non-zero with a clear diff showing the mismatch.

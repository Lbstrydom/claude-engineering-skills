---
summary: History mode in full — the four sources searched, the Markdown digest template, and how to read the result.
---

# History mode — `--history "<topic>"`

SKILL.md §History Mode keeps the invocation and flags. This file holds what
the aggregator searches, the digest template, and the reading guide.

## The four sources

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

## Render the result

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

## What to look for / how the user uses this

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

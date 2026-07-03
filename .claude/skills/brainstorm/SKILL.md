---
name: brainstorm
description: |
  Multi-LLM concept-level brainstorming. Sends the user's topic to OpenAI
  (and optionally Gemini) so the user can compare independent perspectives
  alongside Claude's. Convergence is manual — Claude waits for the user
  to ask for synthesis instead of auto-merging the views.
  Triggers on: "brainstorm", "let's think about", "get other LLMs on this",
  "what would Gemini/GPT say", "/brainstorm".
  Usage:
    /brainstorm <topic>                          # OpenAI only (default)
    /brainstorm --with-gemini <topic>            # both
    /brainstorm --models openai,gemini <topic>   # explicit
    /brainstorm --with-arch <topic>              # force-attach repo architecture context
    /brainstorm --no-arch <topic>                # force-skip architecture context (default: auto-attach on arch topics)
    /brainstorm --debate <topic>                 # second round where models react to each other
    /brainstorm --depth shallow|standard|deep <topic>  # token budget per response
    /brainstorm --continue-from <sid> <topic>    # resume a prior session
    /brainstorm --with-context "<text>" <topic>  # attach extra context (repeatable)
    /brainstorm save <sid> <round> "<insight>"   # record a keeper insight from a prior round
---

# /brainstorm — Multi-LLM Brainstorming

You're acting as the user's brainstorming partner alongside one or more
external LLMs. Your job is to fetch the other models' views, present them
faithfully, add your own take, then **wait for the user to drive the
conversation**. Do NOT auto-synthesise — that's the whole point of this
skill.

**Input**: `$ARGUMENTS` — `[flags] <topic-or-question>`.

---

## Step 0 — Parse Arguments

**Mode detection**: if the first non-flag argv is `save`, switch to
SAVE MODE (jump to §Step 5 below). Otherwise BRAINSTORM-ROUND mode.

### Brainstorm-round flags

| Flag | Default | Meaning |
|---|---|---|
| `--with-gemini` | off | Add Gemini alongside OpenAI |
| `--models <csv>` | `openai` | Explicit list (e.g. `openai,gemini`); overrides `--with-gemini` |
| `--openai-model <id>` | `latest-gpt` | OpenAI sentinel or concrete ID |
| `--gemini-model <id>` | `latest-pro` | Gemini sentinel or concrete ID |
| `--debate` | off | Run a SECOND round where each model reacts to the other's response. Doubles cost (~$0.05) and ~10s. Only meaningful when 2 providers AND both succeed in round 1. |
| `--depth <tier>` | auto | `shallow` (~500 tok) / `standard` (~1500) / `deep` (~4000). Auto-promote to `deep` when topic mentions architecture/schema/migration/refactor/design/"how should we structure"/"what's the best approach". |
| `--continue-from <sid>` | — | Resume from prior session id (assembles prior rounds as context per token budget). |
| `--with-context "<text>"` | — | Additional context (repeatable; max 8000 chars per flag, 24000 total). |
| `--with-arch` | auto | Force-attach the repo's `AGENTS.md` `## Architecture` section so the external LLMs share Claude's codebase grounding. |
| `--no-arch` | auto | Force-skip architecture context — unanchored greenfield ideation. |

**Architecture context (`--with-arch` / `--no-arch`)**: by default the
helper **auto-attaches** the repo's `## Architecture` section whenever the
topic shows architecture intent (same keyword trigger as `--depth` deep:
architecture / schema / migration / refactor / design). This fixes the
asymmetry where Claude's take is codebase-grounded but the external models
saw only the topic. `--with-arch` forces it on for any topic; `--no-arch`
forces it off when you want an unanchored outside view. The flags are
mutually exclusive (helper errors if both are passed).

### Save mode (§Step 5)

`/brainstorm save <sid> <round> "<insight-text>"` — record a keeper insight
from a prior round into `.brainstorm/insights/<topic-slug>/`. Required:
sid + round (which the skill prints in §Step 3). Implementation: invokes
the helper's `save` subcommand with `--topic-stdin` + `--insight-stdin`
via the `---END-TOPIC---` delimiter pattern (shell-safety per §16.A).

Strip flags; in brainstorm-round mode the remainder is the **topic**. If
empty, ask the user what they want to brainstorm and stop.

### Implicit synthesis triggers (Step 4)

Don't restrict yourself to literal keyword matches. **Judge synthesis-
readiness from conversation cues** — questions about value/decision/
direction (`is it worth`, `should we`, `what's your call`, `ok let's
continue`, `is there more value here`) all qualify, plus the explicit
keywords. The literal keyword list is examples, not exhaustive.

---

## Step 1 — Kickoff

Print a single-line kickoff (no resolution lookup — the helper resolves
sentinels and reports back). Include the SID — the user will need it for
`--continue-from` and `save` later.

```
═══════════════════════════════════════
  /brainstorm — Calling: openai[, gemini]
  Sentinels: openai=latest-gpt | gemini=latest-pro
  Session: <sid>            ← print so the user can resume / save later
  Topic: <first 80 chars>...
  Mode: round-1[ + debate][ continuing from <prev-sid>]
  Calling providers…
═══════════════════════════════════════
```

---

## Step 2 — Invoke the helper via temp-file stdin

**Write the topic to a repo-local temp file using the `Write` tool**, then
pipe it to the helper. Do NOT use a shell heredoc and do NOT interpolate
the topic into a command string — both are shell-injection / delimiter-collision
risks (Plan v6 §2.1, Gemini-G1 v1+v2).

1. Compute a session ID: `SID=$(date +%s%3N)` (epoch ms) — run via Bash.
2. Use `Write` (Claude tool) to create the file:
   - Path: `.claude/tmp/brainstorm-<SID>.txt`
   - Content: the topic verbatim (no escaping, no transformation)
3. Run the helper with stdin redirected from the file. Both topic and
   output JSON live in repo-local `.claude/tmp/` (gitignored, 0o600 — not
   the world-readable OS `/tmp`):
   ```bash
   node scripts/brainstorm-round.mjs \
     --topic-stdin \
     --sid <SID> \
     --models openai[,gemini] \
     [--openai-model <id>] [--gemini-model <id>] \
     [--depth shallow|standard|deep] \
     [--debate] \
     [--continue-from <prev-sid>] \
     [--with-context "<text>"]   # repeatable \
     [--with-arch | --no-arch] \
     --out .claude/tmp/brainstorm-<SID>.json \
     < .claude/tmp/brainstorm-<SID>.txt
   ```
   Pass through user-supplied `--debate` / `--depth` / `--continue-from` /
   `--with-context` / `--with-arch` / `--no-arch` flags; the helper
   validates them. The helper auto-attaches architecture context on
   architecture-intent topics without any flag — only forward `--with-arch`
   / `--no-arch` when the user explicitly asked. Always pass `--sid <SID>`
   so the helper writes to a session ledger you can resume from.
4. Always clean up after rendering (Step 3) finishes — both files:
   ```bash
   rm -f .claude/tmp/brainstorm-<SID>.txt .claude/tmp/brainstorm-<SID>.json
   ```

The helper exits 0 even when providers fail or are misconfigured — read the
JSON output's per-provider `state` field, not the exit code, to know what
worked. Only exit 1 means an argv error or helper bug; surface that to the
user verbatim.

---

## Step 3 — Render Per-Provider Blocks

Read the JSON from `--out`. For each provider entry, render exactly one
block. Use the resolved model ID from the helper's `resolvedModels` field
in the heading (e.g. `### OpenAI (gpt-5.x)` not `### OpenAI (latest-gpt)`).

State-driven rendering (the helper guarantees one of these states per
provider):

| State | Render |
|---|---|
| `success` | `### <Provider> (<resolved-model>)`<br>`<text verbatim>` |
| `misconfigured` | `### <Provider>`<br>`⚠ Not called: <errorMessage>` |
| `timeout` | `### <Provider> (<resolved-model>)`<br>`⚠ Timeout after <latencyMs>ms. Try again or lower --max-tokens.` |
| `http_error` | `### <Provider> (<resolved-model>)`<br>`⚠ HTTP <httpStatus>: <errorMessage>` |
| `empty` | `### <Provider> (<resolved-model>)`<br>`⚠ Empty response (<errorMessage>).` |
| `malformed` | `### <Provider> (<resolved-model>)`<br>`⚠ Malformed response: <errorMessage>` (path is in errorMessage) |
| `blocked` | `### <Provider> (<resolved-model>)`<br>`⚠ Blocked by safety filter: <errorMessage>` |

If the JSON's `redactionCount > 0`, prepend a single line above the blocks:
> ⚠ Redacted N secret pattern(s) from your topic before sending.

**Architecture-context lines** (driven purely by envelope fields — never
inspect argv):
- If `archContextAttached` is `true`, prepend an info line above the blocks:
  > ℹ Sent the repo's architecture summary (`archContextChars` chars) to the
  > external models — pass `--no-arch` for an unanchored view.
- If `archContextWarning` is non-null, prepend it as a prominent warning
  line (this fires only when the user explicitly passed `--with-arch` but
  the section was unavailable):
  > ⚠ `<archContextWarning>`

**Error UX rule (§A8)**: when one provider fails (`misconfigured` /
`timeout` / `http_error` / `empty` / `malformed` / `blocked`), surface the
failure as a SINGLE LINE ABOVE the views — not as a peer-shaped block.
Example:

> ⚠ Gemini errored: HTTP 404 unknown-model — proceeding with OpenAI only.

Then render only the providers that returned `success`. If BOTH failed,
render the two error lines and STOP (no Claude take, no synthesis prompt).

### Debate block (only when JSON has non-empty `debate` array)

If `--debate` was passed AND both providers succeeded in round 1, the
helper output includes a `debate: [...]` array of 2 entries. Render
between the parallel views and Claude's take:

```markdown
---

### Debate round

**OpenAI reacting to Gemini**:
<text from debate[?].text where provider='openai', reactingTo='gemini'>

**Gemini reacting to OpenAI**:
<text from debate[?].text where provider='gemini', reactingTo='openai'>
```

After all blocks (parallel + debate?), render a separator and your own take:

```markdown
---

### Claude (my take)
<your independent perspective — 200–400 words. **DIFFER from theirs in
substance, not be 'better'**. Look for what BOTH models missed. You're
a peer in this round, not a synthesiser. Don't recap what the others
said; add what they missed or where you disagree.>
```

End with these lines:

> **Session**: `<sid>` round `<N>`. Resume with
> `/brainstorm <new-topic-or-refinement> --continue-from <sid>`.
> **Save an insight from this round**: `/brainstorm save <sid> <N> "<insight>"`.
>
> **Your call** — push back, refine, ask me to synthesise, or just let
> the divergence sit. Say `/brainstorm done` (or stop invoking) when done.

Then **STOP**. No follow-up actions, no "shall I implement this?", no
proactive synthesis. The user drives.

---

## Step 4 — Synthesis (When Asked OR When Implicit)

**Don't restrict to literal keywords**. Judge synthesis-readiness from
conversation cues. Examples that qualify (non-exhaustive): "synthesise",
"converge", "what should I do", "sum it up", `/brainstorm done`, "is it
worth", "should we", "what's your call", "ok let's continue", "is there
more value here", any clear question about value/decision/direction.

```markdown
## Synthesis

**Where we agree**: <bullets — only true convergence>
**Where we diverge**: <bullets — and what the divergence reveals>
**Open questions**: <what the user still needs to decide>
**My recommendation**: <one paragraph, opinionated>
**Next concrete step**: <one sentence>
```

### Step 4.5 — Arm-eval capture (AUTOMATIC — no action)

Capture is now fired by the round helper itself: after `brainstorm-round.mjs`
appends the round-1 session it dispatches a detached, toggle-gated arm-eval
capture (`scripts/lib/arm-eval/capture-trigger.mjs`). You do NOT run any
`arm-eval-maybe-capture` command — doing so would double-capture. When the
per-repo `arm-eval-toggle` is off it is a byte-identical no-op; when on, one
blinded D/E/F session records for the same topic in the background, unaffecting
YOUR brainstorm flow. If the helper printed `arm-eval capture dispatched`, you
may mention it in one line; otherwise say nothing.

---

## Step 5 — Save Mode (`/brainstorm save <sid> <round> "<insight>"`)

User wants to capture a keeper insight from a prior round. Validate the
sid and round exist (the helper checks too) then invoke the helper's
`save` subcommand using the same stdin-file pattern as Step 2 (per
§16.A — never interpolate user-supplied content into the bash command):

1. `SID=$(date +%s%3N)` — fresh tmp ID for the save invocation files
2. Use `Write` to create three files in `.claude/tmp/`:
   - `save-<SID>-topic.txt` — the original topic from the round you're saving from (look it up in the rendered-history or pass through verbatim)
   - `save-<SID>-insight.txt` — the user's insight text verbatim
3. Build the combined stdin file with the `---END-TOPIC---` delimiter:
   ```bash
   cat .claude/tmp/save-<SID>-topic.txt > .claude/tmp/save-<SID>-combined.txt
   echo "---END-TOPIC---" >> .claude/tmp/save-<SID>-combined.txt
   cat .claude/tmp/save-<SID>-insight.txt >> .claude/tmp/save-<SID>-combined.txt
   ```
4. Invoke the helper:
   ```bash
   node scripts/brainstorm-round.mjs save \
     --sid <user-provided-sid> --round <user-provided-round> \
     --topic-stdin --insight-stdin \
     [--tags <csv>] \
     < .claude/tmp/save-<SID>-combined.txt
   ```
5. Clean up: `rm -f .claude/tmp/save-<SID>-*`
6. Report the result path to the user (`{ok:true, path, slugUsed}` JSON
   from the helper) — include the slug so they know where the file lives.

---

## Notes

- **Repo-bound in v1** — this skill works only when invoked from a repo
  that has the synced helper bundle (audit-loop, wine-cellar, ai-organiser).
  Standalone install is a v2 task.
- **Cost** — kickoff message includes a pre-call ceiling; final cost is
  in the JSON's `totalCostUsd`. Typical round: $0.001–$0.05.
- **No memory writes** — brainstorming is conversational scaffolding, not
  durable state. Don't save to memory unless the user explicitly says
  "save this".
- **Anti-pattern**: do not rank the LLMs ("Gemini gave the best answer").
  Present them as peers; the user judges.

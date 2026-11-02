---
name: brainstorm
description: |
  Multi-LLM concept-level brainstorming. Sends the user's topic to OpenAI
  (and optionally Gemini) so the user can compare independent perspectives
  alongside Claude's. Convergence is manual — Claude waits for the user
  to ask for synthesis instead of auto-merging the views. Supports model
  selection, repo-architecture context attachment (auto on arch topics),
  a debate second round, depth budgets, session resume, extra context and
  artifact attachment, and saving keeper insights from prior rounds.
  Triggers on: "brainstorm", "let's think about", "get other LLMs on this",
  "what would Gemini/GPT say", "/brainstorm".
  Full command syntax: see the Usage section in this skill.
---

> **Worktree preflight** — in a linked git worktree the synced tooling tree
> `scripts/.claude-skills/` is absent — it is gitignored, so `git worktree add`
> does not populate it, and every command below that uses it dies on a bare
> `MODULE_NOT_FOUND`. Run `npm run skills:hydrate` first. If this repo defines
> no such script, `references/worktree-preflight.md` holds the entry to add — ask
> the user first, since it edits their `package.json`.

## Usage

```
Usage:
  /brainstorm <topic>                          # two voices (default — see below)
  /brainstorm --no-gemini <topic>              # OpenAI only (alias: --openai-only)
  /brainstorm --models openai,gemini <topic>   # explicit
  /brainstorm --with-arch <topic>              # force-attach repo architecture context
  /brainstorm --no-arch <topic>                # force-skip architecture context (default: auto-attach on arch topics)
  /brainstorm --debate <topic>                 # second round where models react to each other
  /brainstorm --depth shallow|standard|deep <topic>  # token budget per response
  /brainstorm --continue-from <sid> <topic>    # resume a prior session
  /brainstorm --with-context "<text>" <topic>  # attach extra context (repeatable)
  /brainstorm --with-artifact <path> <topic>   # attach the focal artifact verbatim (repeatable)
  /brainstorm save <sid> <round> "<insight>"   # record a keeper insight from a prior round
```

# /brainstorm — Multi-LLM Brainstorming

> **This skill's last line is an end marker naming the skill between em-dashes, after
> the Reference files table.** If that last line is not in your context (context
> compaction keeps only the start of a skill), re-read
> `.claude/skills/brainstorm/SKILL.md` in full before continuing — the later steps still apply.

You're acting as the user's brainstorming partner alongside one or more
external LLMs. Your job is to fetch the other models' views, present them
faithfully, add your own take, then **wait for the user to drive the
conversation**. Do NOT auto-synthesise — that's the whole point of this
skill.

**Input**: `$ARGUMENTS` — `[flags] <topic-or-question>`.

<!-- host-contract: input-acquisition; grammar=free-text; empty=ask-and-stop -->

**Where `$ARGUMENTS` comes from** — orchestrator-supplied input first, else
the host's verbatim invocation suffix, else the span of the user's **current**
message naming this skill or its subject. Never inferred from surrounding
conversation. This site is `free-text`; on empty input, ask for the topic and stop — there is no default topic, and a guessed one spends provider budget on the wrong question.
Full contract: `references/input-acquisition.md`.


---

## Step 0 — Parse Arguments

**Mode detection**: if the first non-flag argv is `save`, switch to
SAVE MODE (jump to §Step 5 below). Otherwise BRAINSTORM-ROUND mode.

### Brainstorm-round flags

| Flag | Default | Meaning |
|---|---|---|
| `--with-gemini` | — | Force the Gemini leg in; a no-op on the public default, meaningful on Azure |
| `--no-gemini` / `--openai-only` | off | Just the OpenAI voice — on Azure this also drops `azure-claude` |
| `--models <csv>` | profile-dependent (below) | Explicit list, honoured verbatim; `--no-gemini` still reduces it to `openai` |
| `--openai-model <id>` | `latest-gpt` | OpenAI sentinel or concrete ID |
| `--gemini-model <id>` | `latest-pro` | Gemini sentinel or concrete ID |
| — | — | `azure-claude` has no model flag: it calls the deployment in `AZURE_FOUNDRY_CLAUDE_DEPLOYMENT` |
| `--debate` | off | Run a SECOND round where each model reacts to the other's response. Doubles cost (~$0.05) and ~10s. Only meaningful when 2 providers AND both succeed in round 1. |
| `--depth <tier>` | auto | Prose length asked for: `shallow` (150–250 words) / `standard` (250–500) / `deep` (600–1000). The output ceiling is derived from that plus reasoning headroom. Auto-promote to `deep` when topic mentions architecture/schema/migration/refactor/design/"how should we structure"/"what's the best approach". |
| `--continue-from <sid>` | — | Resume from prior session id (assembles prior rounds as context per token budget). |
| `--with-context "<text>"` | — | Additional context (repeatable; max 8000 chars per flag, 24000 total). |
| `--with-arch` | auto | Force-attach the repo's `AGENTS.md` `## Architecture` section so the external LLMs share Claude's codebase grounding. |
| `--no-arch` | auto | Force-skip architecture context — unanchored greenfield ideation. |
| `--with-artifact <path>` | — | Attach the **focal artifact** verbatim — the plan/diff/module the topic is actually about. Repeatable. Auto-attaches the policy pack. Sensitive paths are refused, never sent. |
| `--no-policy` | off | Suppress the auto-attached policy pack (artifact only). |

**Which two voices you get depends on the profile** — the default is "two
independent views", and which two is not a constant:

| Profile | Default `--models` | Why |
|---|---|---|
| Public (`OPENAI_API_KEY` etc.) | `openai,gemini` | Two vendors, genuinely independent |
| Azure work profile (`AZURE_OPENAI_ENDPOINT` set) | `openai,azure-claude` | There is no Gemini in an Azure tenant; Foundry Claude is the substitute, the same one the final reviewer makes |

On Azure, say plainly in the synthesis that the second voice is Claude on
Foundry: it has no conversation history and its own system prompt, so it is a
separate view — but it is **not** the cross-vendor independence the public pair
gives, and you should not present it as one.

**Architecture context** auto-attaches on architecture-intent topics; `--with-arch`
/ `--no-arch` force it on/off and are mutually exclusive (the helper errors if both
are passed). → `references/artifact-context.md` §Architecture context — read when
deciding whether to override the auto-attach.

**Focal artifact (`--with-artifact`) — reach for this first.** **Whenever the topic
concerns something that already exists, pass `--with-artifact <path>`.** Do not
paraphrase it into the topic; point at it. This is the single highest-value flag in
the skill. It also auto-attaches the repo **policy pack** (`--no-policy` suppresses
it). → `references/artifact-context.md` §Why the focal artifact comes first /
§The policy pack / §Budgets — read when the user questions why the artifact (not more
architecture) is attached, or what the policy pack and budgets contain.

`--with-artifact` is an **egress seam** — it reads an operator-supplied
path and sends it to OpenAI and Gemini. Sensitive paths, symlinks resolving
to sensitive targets, and symlinks escaping the repo are refused and
reported, never sent; secrets inside a permitted file are redacted. A
refusal never aborts the round — the other artifacts still go, and the
refusal is surfaced (contract: `tests/brainstorm-artifact-context.test.mjs`).

### Save mode (§Step 5)

`/brainstorm save <sid> <round> "<insight-text>"` — record a keeper insight
from a prior round into `.brainstorm/insights/<topic-slug>/`. Required:
sid + round (which the skill prints in §Step 3). Procedure: §Step 5.

Strip flags; in brainstorm-round mode the remainder is the **topic**. If
empty, ask the user what they want to brainstorm and stop.

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
   - Path: `.claude/tmp/brainstorm-$SID.txt`
   - Content: the topic verbatim (no escaping, no transformation)
3. Run the helper with stdin redirected from the file. Both topic and
   output JSON live in repo-local `.claude/tmp/` (gitignored, 0o600 — not
   the world-readable OS `/tmp`):
   ```bash
   cat .claude/tmp/brainstorm-$SID.txt | node scripts/brainstorm-round.mjs --topic-stdin --sid $SID --out .claude/tmp/brainstorm-$SID.json
   ```
   Optional flags, appended to the same command as needed: `--models
   openai,gemini` (omit for the profile default, two voices), `--no-gemini`
   (OpenAI only), `--openai-model` / `--gemini-model` (a model id), `--depth
   shallow|standard|deep`, `--debate`, `--continue-from` (a prior SID),
   `--with-context "..."` (repeatable), `--with-arch` / `--no-arch`,
   `--with-artifact` (a path, repeatable — the focal object), `--no-policy`.
   Pass through user-supplied `--debate` / `--depth` / `--continue-from` /
   `--with-context` / `--with-arch` / `--no-arch` flags; the helper
   validates them. The helper auto-attaches architecture context on
   architecture-intent topics without any flag — only forward `--with-arch`
   / `--no-arch` when the user explicitly asked. Always pass `--sid $SID`
   so the helper writes to a session ledger you can resume from.
4. Always clean up after rendering (Step 3) finishes — both files:
   ```bash
   rm -f .claude/tmp/brainstorm-$SID.txt .claude/tmp/brainstorm-$SID.json
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
Provider display names: `openai` → **OpenAI**, `gemini` → **Gemini**,
`azure-claude` → **Claude (Azure Foundry)** — name the host, so nobody reads it
as the agent talking to itself.

State-driven rendering (the helper guarantees one of these states per
provider):

| State | Render |
|---|---|
| `success` | `### <Provider> (<resolved-model>)`<br>`<text verbatim>` |
| `misconfigured` | `### <Provider>`<br>`⚠ Not called: <errorMessage>` |
| `timeout` | `### <Provider> (<resolved-model>)`<br>`⚠ Timeout after <latencyMs>ms. Try again or lower --max-tokens.` |
| `http_error` | `### <Provider> (<resolved-model>)`<br>`⚠ HTTP <httpStatus>: <errorMessage>` |
| `empty` | `### <Provider> (<resolved-model>)`<br>`⚠ Empty response (<errorMessage>).` |
| `truncated` | `### <Provider> (<resolved-model>)`<br>`⚠ INCOMPLETE — <errorMessage>`<br>then the partial `<text>` verbatim. The errorMessage names the ceiling, how much of it thinking spent (when the provider reports it), and the remedy for this tier — at `deep` that is `--max-tokens`, not `--depth`; don't substitute your own. **Render the warning ABOVE the text, never below** — a fragment read as a finished view is the bug this state exists to prevent. Treat it as a partial view in any synthesis, and say so. |
| `malformed` | `### <Provider> (<resolved-model>)`<br>`⚠ Malformed response: <errorMessage>` (path is in errorMessage) |
| `blocked` | `### <Provider> (<resolved-model>)`<br>`⚠ Blocked by safety filter: <errorMessage>` |

If the JSON's `redactionCount > 0`, prepend a single line above the blocks:
> ⚠ Redacted N secret pattern(s) from your topic before sending.

**Architecture-context lines** (driven purely by envelope fields — never
inspect argv):
- If `archContextAttached` is `true`, prepend an info line above the blocks:
  > ℹ Sent the repo's architecture summary (`archContextChars` chars) to the
  > external models — pass `--no-arch` for an unanchored view.
- If `artifactContext` is non-null, prepend one info line naming what the
  models actually saw:
  > ℹ Focal artifact(s) sent verbatim: `<paths>`[ + repo policy pack].
- If `artifactContext.refused` is non-empty, prepend a WARNING line per
  refusal. **Never silently drop one** — the user must not believe the
  models saw a file that was withheld:
  > ⚠ Artifact refused (`<reason>`): `<path>` — NOT sent to the providers.
- If `archContextWarning` is non-null, prepend it as a prominent warning
  line (this fires only when the user explicitly passed `--with-arch` but
  the section was unavailable):
  > ⚠ `<archContextWarning>`

**Error UX rule (§A8)**: when one provider fails (`misconfigured` /
`timeout` / `http_error` / `empty` / `malformed` / `blocked`), surface the
failure as a SINGLE LINE ABOVE the views — not as a peer-shaped block.
Example:

> ⚠ Gemini errored: HTTP 404 unknown-model — proceeding with OpenAI only.

Then render the providers that returned `success` **or `truncated`** — a
truncated response is a partial view, not a failure, so it gets a full block
(with its warning line) rather than being collapsed into a one-liner. If
BOTH genuinely failed, render the two error lines and STOP (no Claude take,
no synthesis prompt); `truncated` does NOT count as a failure for that test.

### Debate block (only when JSON has non-empty `debate` array or non-null `debateSkipped`)

Render a `### Debate round` block between the parallel views and Claude's take.
**If `debateSkipped` is non-null, say so — do not render nothing**: render a
`### Debate round — skipped` block with its `detail`. → `references/debate-round.md`
— read when the JSON has a non-empty `debate` array or a non-null `debateSkipped`,
for both templates and the per-`reason` wording.

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
**Raised by one voice only**: <bullets — each tagged with its source; keep the ones you disagree with>
**Open questions**: <what the user still needs to decide>
**My recommendation**: <one paragraph, opinionated>
**Next concrete step**: <one sentence>
```

Never drop the *one voice only* row — a lone view is what a synthesis drops first.
→ `references/synthesis-and-capture.md` §Why the one-voice-only row — read when asked why the row exists.

### Step 4.5 — Arm-eval capture (AUTOMATIC — no action)

The round helper fires capture itself. You do NOT run any `arm-eval-maybe-capture`
command — doing so would double-capture. If the helper printed `arm-eval capture
dispatched`, you may mention it in one line; otherwise say nothing.
→ `references/synthesis-and-capture.md` §Step 4.5 — read when the user asks what
the capture does or whether it affected the round.

---

## Step 5 — Save Mode (`/brainstorm save <sid> <round> "<insight>"`)

User wants to capture a keeper insight from a prior round. Validate the
sid and round exist (the helper checks too) then invoke the helper's
`save` subcommand using the same stdin-file pattern as Step 2 (per
§16.A — never interpolate user-supplied content into the bash command):

1. `SID=$(date +%s%3N)` — fresh tmp ID for the save invocation files
2. Use `Write` to create three files in `.claude/tmp/`:
   - `save-$SID-topic.txt` — the original topic from the round you're saving from (look it up in the rendered-history or pass through verbatim)
   - `save-$SID-insight.txt` — the user's insight text verbatim
3. Build the combined stdin file with the `---END-TOPIC---` delimiter:
   ```bash
   cat .claude/tmp/save-$SID-topic.txt > .claude/tmp/save-$SID-combined.txt
   echo "---END-TOPIC---" >> .claude/tmp/save-$SID-combined.txt
   cat .claude/tmp/save-$SID-insight.txt >> .claude/tmp/save-$SID-combined.txt
   ```
4. Invoke the helper — `$ROUND_SID`/`$ROUND_NUM` are the sid/round of the
   *existing* brainstorm round you're saving from, not the fresh tmp `$SID`
   above; `--tags` is optional, a comma-separated list:
   ```bash
   cat .claude/tmp/save-$SID-combined.txt | node scripts/brainstorm-round.mjs save --sid $ROUND_SID --round $ROUND_NUM --topic-stdin --insight-stdin
   ```
5. Clean up: `rm -f .claude/tmp/save-$SID-*`
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

---

## Reference files

This skill's canonical flow is above. The files below cover specialised
situations — read them only when the trigger applies.

| File | Summary | Read when |
|---|---|---|
| `references/input-acquisition.md` | Where a skill's arguments come from on any host, and what to do when there are none. | Reading $ARGUMENTS on a host that does not substitute it, or deciding what empty input means at a site. |
| `references/artifact-context.md` | Why --with-artifact beats more architecture context, what the policy pack attaches, and the context budgets. | Step 0 — deciding whether to override arch auto-attach, OR the user asks why/what the artifact and policy pack send. |
| `references/debate-round.md` | Step 3 debate rendering — the debate block template and the debateSkipped reasons and skipped-block template. | Step 3 — the helper JSON has a non-empty `debate` array or a non-null `debateSkipped`. |
| `references/synthesis-and-capture.md` | Why the synthesis keeps a one-voice-only row (dated A/B), and how the automatic arm-eval capture behaves. | Step 4/4.5 — asked why the one-voice row exists, OR what the arm-eval capture did. |
| `references/worktree-preflight.md` | Worktree preflight remedy — the skills:hydrate npm script to add when a linked worktree lacks the tooling tree. | A command dies with `MODULE_NOT_FOUND` in a linked worktree AND this repo has no `skills:hydrate` script. |

— end of /brainstorm —

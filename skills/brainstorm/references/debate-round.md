---
summary: Step 3 debate rendering — the debate block template and the debateSkipped reasons and skipped-block template.
---

# Debate round rendering (Step 3)

SKILL.md Step 3 points here when the helper JSON carries a non-empty `debate`
array or a non-null `debateSkipped`. Both render between the parallel views
and Claude's take.

## Debate block (only when JSON has non-empty `debate` array)

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

## Debate skipped

**If `debateSkipped` is non-null, say so — do not render nothing.** The user
asked for a debate and paid for round 1; silence reads as "the tool ignored my
flag". `debateSkipped` is `null` when the debate was not requested or when it
ran; an object means it was requested and cancelled, and carries the reason:

| `reason` | What to tell the user |
|---|---|
| `not-a-pair` | The debate round needs exactly two voices; name how many ran, and that `--models` decides it. |
| `round-1-incomplete` | One voice did not return usable text in round 1, so there was no peer response to react to; name which, from the `detail` string and the `providers[]` states. |

Render it where the debate round would have gone:

```markdown
---

### Debate round — skipped

<detail from debateSkipped.detail>

Round 1 above is unaffected. Re-run with `--debate` once both voices return.
```

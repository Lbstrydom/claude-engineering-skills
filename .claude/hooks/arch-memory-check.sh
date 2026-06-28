#!/usr/bin/env bash
# .claude/hooks/arch-memory-check.sh
#
# UserPromptSubmit hook for the architectural-memory feature. When the user
# submits a prompt that looks like an ad-hoc fix or feature request ("fix X",
# "add a Y", "implement Z", "create a Y for Z"), pre-consult the symbol-index
# for near-duplicates and prepend the result to Claude's context.
#
# Goal: catch architectural drift at the moment a casual prompt would
# otherwise bypass /plan-* skills entirely.
#
# Hook contract:
#   - stdin: JSON `{"hook_event_name": "UserPromptSubmit", "prompt": "..."}`
#     (Claude Code passes the full event envelope on stdin)
#   - stdout: text appended to Claude's context for this turn
#   - exit 0: prompt proceeds (always — never block the user)
#   - exit non-zero: blocks the prompt (we never use this)
#
# Test mode:
#   - `--prompt "<text>"`: bypass stdin, use the arg directly. Used by
#     tests/hook-arch-memory-check.test.mjs to exercise the hook in isolation.
#   - `--dry-run`: print the would-be intent + decision, but skip the
#     cross-skill call. Used in tests to verify pattern matching alone.
#
# Cost / latency: ~1 Gemini embed (~$0.0003) + 1 Supabase RPC (~50-200ms)
# per fired hook. Cached via .audit-loop/cache/intent-embeddings.json
# (per the architectural-memory plan §3 query path), so repeats are free.
#
# Set ARCH_MEMORY_HOOK_DISABLE=1 in env to bypass entirely.

set -u

# ── Argument parsing ────────────────────────────────────────────────────────

PROMPT=""
DRY_RUN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --prompt) PROMPT="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) shift ;;
  esac
done

# Honour explicit disable
if [[ "${ARCH_MEMORY_HOOK_DISABLE:-0}" == "1" ]]; then exit 0; fi

# ── Read prompt from stdin if not passed via arg ────────────────────────────

if [[ -z "$PROMPT" ]]; then
  # Read all of stdin (the hook event envelope)
  if [[ -t 0 ]]; then
    # No stdin attached — nothing to do
    exit 0
  fi
  STDIN_JSON="$(cat)"
  # Extract the prompt field. Use a tiny inline node script so we don't
  # depend on jq (which isn't always available on Windows). Falls back to
  # raw stdin if JSON parsing fails (defensive).
  PROMPT="$(printf '%s' "$STDIN_JSON" | node -e '
    let s = "";
    process.stdin.on("data", d => s += d);
    process.stdin.on("end", () => {
      try {
        const o = JSON.parse(s);
        process.stdout.write(o.prompt || o.user_prompt || "");
      } catch { process.stdout.write(s); }
    });
  ' 2>/dev/null || printf '%s' "$STDIN_JSON")"
fi

# Empty prompt → nothing to do
if [[ -z "$PROMPT" ]]; then exit 0; fi

# ── Intent detection ────────────────────────────────────────────────────────
#
# Trigger on imperative verbs at sentence start (or near it) that signal the
# user is about to ask Claude to write code. False-positive control matters:
# we'd rather miss a borderline "make sure X works" than fire on every
# "what does X do" question.
#
# Trigger verbs (case-insensitive, anchored at start or after common
# leading politeness like "please ", "could you "):
#   fix, add, implement, create, build, write (a|an), refactor, make,
#   wire (up|in), hook (up|into), introduce, replace, extend, bolt on
#
# Anti-trigger phrases (skip even if a trigger verb is present):
#   what, why, how, explain, where, when, who, show me, tell me,
#   does, did, is, was, can, could, would, should  (when it's a question)
#   "?" anywhere in the prompt → likely a question, skip
#
# Note: bash regex is POSIX ERE, no \b. We use [[:space:]] / start-of-string.

# Prompt body, lowercased + first-300-chars only (perf)
LOWER="$(printf '%s' "$PROMPT" | tr 'A-Z' 'a-z' | head -c 300)"

# Strip leading whitespace + leading politeness so verb detection lands on
# the real verb. Two-pass: first whitespace, then optional politeness phrase.
LEAD_STRIPPED="$(printf '%s' "$LOWER" | sed -E 's/^[[:space:]]+//' | sed -E 's/^(please[[:space:]]+|could you[[:space:]]+|can you[[:space:]]+|would you[[:space:]]+|i (need|want)[[:space:]]+(you[[:space:]]+to[[:space:]]+)?|let'"'"'?s[[:space:]]+|let us[[:space:]]+)//')"

INTENT=""
if   [[ "$LEAD_STRIPPED" =~ ^fix[[:space:]] ]]                   ; then INTENT="fix"
elif [[ "$LEAD_STRIPPED" =~ ^add[[:space:]] ]]                   ; then INTENT="add"
elif [[ "$LEAD_STRIPPED" =~ ^implement[[:space:]] ]]              ; then INTENT="implement"
elif [[ "$LEAD_STRIPPED" =~ ^create[[:space:]] ]]                 ; then INTENT="create"
elif [[ "$LEAD_STRIPPED" =~ ^build[[:space:]] ]]                  ; then INTENT="build"
elif [[ "$LEAD_STRIPPED" =~ ^write[[:space:]]+(a|an|the)[[:space:]] ]]; then INTENT="write"
elif [[ "$LEAD_STRIPPED" =~ ^refactor[[:space:]] ]]               ; then INTENT="refactor"
elif [[ "$LEAD_STRIPPED" =~ ^make[[:space:]] ]]                   ; then INTENT="make"
elif [[ "$LEAD_STRIPPED" =~ ^wire[[:space:]] ]]                   ; then INTENT="wire"
elif [[ "$LEAD_STRIPPED" =~ ^hook[[:space:]] ]]                   ; then INTENT="hook"
elif [[ "$LEAD_STRIPPED" =~ ^introduce[[:space:]] ]]              ; then INTENT="introduce"
elif [[ "$LEAD_STRIPPED" =~ ^replace[[:space:]] ]]                ; then INTENT="replace"
elif [[ "$LEAD_STRIPPED" =~ ^extend[[:space:]] ]]                 ; then INTENT="extend"
elif [[ "$LEAD_STRIPPED" =~ ^bolt[[:space:]] ]]                   ; then INTENT="bolt"
fi

# Anti-trigger: question marks in first 300 chars
if [[ "$LOWER" == *"?"* ]]; then INTENT=""; fi

# Anti-trigger: question words at start
case "$LEAD_STRIPPED" in
  what*|why*|how*|where*|when*|who*|explain*|"show me"*|"tell me"*|does*|"can you explain"*)
    INTENT="" ;;
esac

# No matching intent → exit silently
if [[ -z "$INTENT" ]]; then exit 0; fi

# Dry-run for testing: just echo the decision
if [[ "$DRY_RUN" == "1" ]]; then
  printf 'INTENT_DETECTED: %s\nPROMPT_HEAD: %s\n' "$INTENT" "$(printf '%s' "$PROMPT" | head -c 120)"
  exit 0
fi

# ── Find the repo root (where scripts/cross-skill.mjs lives) ────────────────

REPO_ROOT=""
if command -v git >/dev/null 2>&1; then
  REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
fi
[[ -z "$REPO_ROOT" ]] && REPO_ROOT="$(pwd)"

CROSS_SKILL="$REPO_ROOT/scripts/cross-skill.mjs"
if [[ ! -f "$CROSS_SKILL" ]]; then
  # Repo doesn't have architectural-memory installed — silently skip
  exit 0
fi

# ── Run get-neighbourhood with a short hard timeout ─────────────────────────
#
# 8s cap: typical cold-cache embed is 1-2s, RPC is 50-200ms, plus node
# startup. 8s leaves headroom for one transient retry. If we exceed,
# we fall through silently — never block the user's prompt.

PROMPT_FOR_QUERY="$(printf '%s' "$PROMPT" | head -c 1000)"
PAYLOAD="$(printf '%s' "$PROMPT_FOR_QUERY" | node -e '
  let s = "";
  process.stdin.on("data", d => s += d);
  process.stdin.on("end", () => {
    process.stdout.write(JSON.stringify({
      targetPaths: [],
      intentDescription: s,
      k: 5
    }));
  });
' 2>/dev/null)"

[[ -z "$PAYLOAD" ]] && exit 0

# Use timeout if available; otherwise just run (Windows Git Bash has timeout via coreutils usually).
RESULT=""
if command -v timeout >/dev/null 2>&1; then
  RESULT="$(timeout 8 node "$CROSS_SKILL" get-neighbourhood --json "$PAYLOAD" 2>/dev/null || true)"
else
  RESULT="$(node "$CROSS_SKILL" get-neighbourhood --json "$PAYLOAD" 2>/dev/null || true)"
fi

# M5: do NOT exit when the arch lookup is empty — the friction query below must
# run independently (an empty/failed arch result must not silently kill friction
# injection). Gate only the arch FORMATTING on a non-empty result; always fall
# through to the friction query.

# ── Format the consultation as additional context ──────────────────────────
#
# Output is a fenced "Architectural-memory consultation" block. Claude reads
# this as part of the user prompt context. Keep the framing neutral so it
# doesn't override the user's actual ask — it's a HINT.

if [[ -n "$RESULT" ]]; then
node -e '
  let s = "";
  process.stdin.on("data", d => s += d);
  process.stdin.on("end", () => {
    let r;
    try { r = JSON.parse(s); } catch { return; }
    if (!r || r.ok === false) return;
    const records = r.records || [];

    const out = [];
    out.push("\n---");
    out.push("**Architectural-memory consultation** (auto-fired by intent verb in prompt)");
    out.push("");
    if (r.cloud === false) {
      out.push("> Cloud store offline — no neighbourhood lookup performed.");
      out.push("> Recommend `npm run arch:refresh` to enable for future fixes.");
    } else if (records.length === 0) {
      const hint = r.hint ? " " + r.hint : "";
      out.push("> No near-duplicates in symbol-index for this intent." + hint);
      out.push("> Proceed; this looks like greenfield work for the asked scope.");
    } else {
      out.push("> Top " + records.length + " candidates from symbol-index. **Consider whether to reuse/extend before writing new code.**");
      out.push("");
      out.push("| Sim | Symbol | Path | Recommendation | Purpose |");
      out.push("| --- | --- | --- | --- | --- |");
      for (const x of records.slice(0, 5)) {
        const sim = (Number(x.similarityScore || 0)).toFixed(2);
        const sym = (x.symbolName || "").replace(/\|/g, "\\|");
        const path = ((x.filePath || "") + (x.startLine ? ":" + x.startLine : "")).replace(/\|/g, "\\|");
        const rec = (x.recommendation || "review").replace(/\|/g, "\\|");
        const pur = String(x.purposeSummary || "").slice(0, 100).replace(/\|/g, "\\|").replace(/\n/g, " ");
        out.push("| " + sim + " | `" + sym + "` | `" + path + "` | **" + rec + "** | " + pur + " |");
      }
      out.push("");
      out.push("_If a `reuse` or `extend` candidate matches your intent, prefer that over new code. Justify divergence in the change rationale if you proceed greenfield. To suppress this consultation per-prompt, set `ARCH_MEMORY_HOOK_DISABLE=1` in env._");
    }
    process.stdout.write(out.join("\n") + "\n");
  });
' <<< "$RESULT"
fi

# ── 3rd query: friction-feedback (plan: friction-feedback-loop.md C9) ────────
#
# Trigram-match the prompt against this repo's OPEN friction notes. Cheap (no
# embed — pg_trgm word_similarity), repo-scoped, top-2. The command appends the
# injection breadcrumb itself (.audit/friction-injected.jsonl) so /ship +
# `quality session-review` can offer closure later. Never blocks the prompt.

FRICTION_PAYLOAD="$(printf '%s' "$PROMPT_FOR_QUERY" | node -e '
  let s = "";
  process.stdin.on("data", d => s += d);
  process.stdin.on("end", () => {
    process.stdout.write(JSON.stringify({ prompt: s, k: 2 }));
  });
' 2>/dev/null)"

if [[ -n "$FRICTION_PAYLOAD" ]]; then
  FRICTION_RESULT=""
  if command -v timeout >/dev/null 2>&1; then
    FRICTION_RESULT="$(timeout 8 node "$CROSS_SKILL" get-friction-neighbourhood --json "$FRICTION_PAYLOAD" 2>/dev/null || true)"
  else
    FRICTION_RESULT="$(node "$CROSS_SKILL" get-friction-neighbourhood --json "$FRICTION_PAYLOAD" 2>/dev/null || true)"
  fi

  if [[ -n "$FRICTION_RESULT" ]]; then
    node -e '
      let s = "";
      process.stdin.on("data", d => s += d);
      process.stdin.on("end", () => {
        let r;
        try { r = JSON.parse(s); } catch { return; }
        if (!r || r.ok === false) return;
        const records = r.records || [];
        if (r.cloud === false || records.length === 0) return;   // silent when nothing relevant
        const out = [];
        out.push("\n---");
        out.push("**Relevant prior friction** (recurring papercuts in THIS repo matching your intent)");
        out.push("");
        out.push("| Cost | Note | Title |");
        out.push("| --- | --- | --- |");
        for (const x of records.slice(0, 2)) {
          const cost = String(x.cost || "M").replace(/\|/g, "\\|");
          const name = String(x.memory_name || "").replace(/\|/g, "\\|");
          const title = String(x.title || "").slice(0, 120).replace(/\|/g, "\\|").replace(/\n/g, " ");
          out.push("| " + cost + " | `" + name + "` | " + title + " |");
        }
        out.push("");
        out.push("_You hit these before. Avoid re-living them; if this work resolves one, `/ship` will offer to link the fix._");
        process.stdout.write(out.join("\n") + "\n");
      });
    ' <<< "$FRICTION_RESULT"
  fi
fi

exit 0

---
summary: Phase 1a detail — device prep contract shape, mobile tag semantics, viewport-only limits, MCP launch flags, pair mode.
---

# Device profile resolution — detail

The resident Phase 1a steps (run `device-presets.mjs prep`, echo `logLine`,
call `expectedFirstMcpCall` verbatim before the first navigate) are in
SKILL.md. This file holds the why and the edges.

## Why it is required

A persona who describes themselves as "mobile-first" or "tablet user" must
be tested in that viewport — otherwise responsive bugs, mobile-only CTAs,
narrow-width overflow, and touch-target sizing are silently invisible.
The resolver lives at [`scripts/lib/device-presets.mjs`](https://github.com/Lbstrydom/claude-engineering-skills/blob/main/scripts/lib/device-presets.mjs)
— it keyword-matches the persona's description against five presets
(desktop, desktop-large, tablet, mobile, mobile-small) and falls back to
desktop when no cue is present.

## The prep contract

The CLI returns a JSON contract:

```json
{
  "kind": "persona-test-prep",
  "version": 1,
  "device": { "name": "mobile", "viewport": {"width": 390, "height": 844}, "isMobile": true, "hasTouch": true, ... },
  "expectedFirstMcpCall": { "tool": "browser_resize", "args": {"width": 390, "height": 844} },
  "personaMentalModelTags": ["mobile-viewport", "thumb-reach", ...],
  "logLine": "[device-profile] mobile-first → mobile (390x844, touch=true)"
}
```

**Echo the `logLine` verbatim to stderr.** This is the audit trail — if
the device choice is later questioned, the line in the transcript proves
which preset was applied.

Resizing mid-session does not retroactively change media queries that
fired on the initial render — order matters.

## `personaMentalModelTags` (Step 1a.3)

When `device.isMobile === true`, the contract's `personaMentalModelTags`
array carries implicit constraints (`thumb-reach`, `one-handed`,
`distracted-attention`, `slow-network-assumption`). Apply these to
Phase 2's persona mental model **silently** — they shape Reflect
scoring (downgrade desktop-hover findings, upgrade thumb-reach
findings), but do NOT leak into Phase 5b's first-person persona voice.
A real mobile user doesn't narrate "I'm on mobile so I…" — they just
behave that way. The device is a runner-side fact, not persona dialogue.

## Limits — what viewport-only emulation does NOT cover

`browser_resize` (the per-call MCP tool used in Step 1a.2) changes only
the visual viewport. It does **not**:

- Inject a mobile user-agent at the network layer.
- Fire real touch events — synthesised clicks may remain mouse events;
  touch-only handlers (`touchstart` without `click` fallback) may not trigger.
- Change `navigator.maxTouchPoints` or pointer-type media queries.
- Apply device-pixel-ratio scaling that affects `@media (resolution: ...)`.

**Note this is a per-tool-call limit, not a hard ceiling on the MCP
session.** The Playwright MCP *server* itself accepts `--device <name>`,
`--mobile`, and `--user-agent <string>` launch flags (`npx @playwright/mcp
--help`), which apply Playwright's real device descriptor (UA string, DPR,
`hasTouch`) for the whole session via `.mcp.json` — a heavier, session-wide
lever that doesn't require switching modes. It has real limits of its own,
though: it's static once the server connects (can't switch devices between
Plan→Act→Reflect steps, and pair mode's two personas share one connection —
see "Pair-mode interaction" below), and whether the MCP's click/tap tool
implementations actually dispatch genuine touch events under `hasTouch:
true` is worth verifying empirically before relying on it, not assumed from
the flag's existence.

For per-step device switching, geolocation, or network throttling — or
if the empirical check above shows synthesised events still aren't real —
use `--mode consistency` (code-driven Playwright with launch context) and
write a consistency canary instead.

## Pair-mode interaction

In `--pair` mode (Phase 7), each persona gets its own device resolution.
Persona A may run in mobile while persona B runs in desktop — that's
intentional cross-device coverage. The pair report (Step P5) records
both devices in the header.

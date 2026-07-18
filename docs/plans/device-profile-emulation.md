# Plan: Device-profile emulation for persona-driven + structural browser tests

- **Date**: 2026-05-29
- **Status**: Complete — implemented in this repo; shareable brief for porting elsewhere
- **Author**: Claude + Louis
- **Scope**: testing infrastructure (skill spec + small shared lib)
- **Reference implementation**: this repo's [scripts/lib/device-presets.mjs](../../scripts/lib/device-presets.mjs), [skills/persona-test/SKILL.md](../../skills/persona-test/SKILL.md), [skills/click-test/SKILL.md](../../skills/click-test/SKILL.md)

---

## 1. The pain

We test deployed apps two ways:

1. **Persona test** — an LLM drives a browser as a specific user (e.g. "Pieter, wine enthusiast, mobile-first") via Playwright MCP, walks the app, reports UX issues.
2. **Structural test** — a scanner walks every interactive element, asserts semantic-HTML contracts (duplicate IDs, ARIA, touch targets, etc.).

Both run in **whatever viewport the MCP defaults to** (1280×720 Chromium). So a persona who self-describes as "mobile-first" silently runs on a desktop viewport. Result: responsive bugs, mobile-only CTAs, narrow-width overflow, and undersized touch targets are invisible — exactly the failure class the VS Code 1.122 "integrated browser with device emulation" release notes highlighted.

The fix is mechanical: resolve the device from intent → call `browser_resize` before the first navigate → tag findings with the device → optionally run a cross-device matrix.

---

## 2. Goal & non-goals

**Goal**:

- Auto-resolve a device preset from persona description text (no flag required for the common case).
- Allow explicit override per-run (`--device mobile`) and matrix mode (`--devices "desktop,mobile"`).
- Surface the device in every report header and tag every finding.
- Cross-device diff in the structural test so responsive-only bugs are obvious.

**Non-goals** (deferred to a v2 / consistency-mode path):

- Real touch-event emulation (synthesised clicks remain mouse events).
- UA-string injection at the network layer (server-side sniffing still sees Chromium desktop).
- Device-pixel-ratio scaling that affects `@media (resolution: ...)`.
- Persisting the resolved device on the persona registry row (today: re-resolved at session start from description; deterministic enough).

For full emulation, the right path is a code-driven Playwright runner using `playwright.devices['iPhone 13']` and a launch context — we have one of those in `--mode consistency` already. Exploratory tests trade fidelity for narrative coverage; viewport-only emulation catches ~80% of the value at zero extra infrastructure cost.

---

## 3. Architecture (single small module + skill edits)

### 3.1 The shared module

One file, ~100 LOC, pure (no I/O, no MCP coupling — just data + a resolver):

```
lib/device-presets.{mjs|ts}
├── DEVICE_PRESETS         5 presets: desktop, desktop-large, tablet, mobile, mobile-small
│                          Each: { name, viewport: {width, height}, userAgent, deviceScaleFactor, isMobile, hasTouch }
├── DEFAULT_PRESET         'desktop'
├── resolveDevicePreset(description, fallback?)
│                          Keyword-matches description against a regex list, returns a preset.
│                          Order matters: longer phrases first (mobile-small before mobile).
├── getPreset(name)        Throws on unknown.
├── parseViewportFlag(s)   "390x844" → custom preset with width/height + inferred isMobile/hasTouch.
├── parseDevicesFlag(s)    "desktop,mobile" → [preset, preset], dedup, trim.
└── CLI (when invoked directly): list | resolve "<desc>" | get <name>
```

**Why a flat data+function module, not a class**: this is one of the few cases where there's literally no state. Tests are trivial (input string → expected preset name). The CLI surface exists so skill instructions can shell out to it from a `node -e` snippet instead of asking the LLM to do the keyword-matching (which would be non-deterministic).

**Resolver patterns** — keep them ordered most-specific to least-specific. Wine-cellar-style real personas to anchor on:

| Description fragment | Preset |
|---|---|
| `mobile-first`, `iPhone`, `on their phone`, `smartphone` | mobile |
| `older phone`, `cheap android`, `low-end phone` | mobile-small |
| `tablet`, `iPad` | tablet |
| `ultrawide`, `4K`, `large desktop`, `wide monitor` | desktop-large |
| `desktop-first`, `on their laptop`, `laptop user` | desktop |
| (no cue) | desktop (fallback) |

Avoid over-broad patterns: `power user` does NOT imply desktop. A power user can be on mobile.

### 3.2 Skill integration — exploratory test ("persona-test")

Insert a phase between **detect browser tool** and **first navigate**:

```
Phase 1   — Detect browser tool          (existing)
Phase 1a  — Device profile resolution    (NEW)
              1. Explicit --device flag (if present) → getPreset(name)
              2. Else resolveDevicePreset(persona.description)
              3. Log: [device-profile] resolved "mobile-first" → mobile (390x844, touch=true)
              4. browser_resize({width, height}) — BEFORE the first navigate
              5. If isMobile=true, tag the persona's mental model with mobile constraints
                 (thumb reach, one-handed, distracted, slow network)
Phase 1b  — Service-worker cache-bust    (existing — runs AFTER resize)
Phase 2   — Build persona mental model   (existing — picks up the mobile tag)
...
Phase 5   — Report                       (HEADER GAINS: "Device: mobile 390x844 (touch=true, resolved-from=description)")
```

**Pair-mode interaction**: each persona resolves independently. Persona A may run mobile while B runs desktop — that's intentional cross-device coverage. The pair report header records both.

**What NOT to change**: don't pollute Phase 2's persona-voice narrative with the device. The device shapes the persona's mental model SILENTLY (reflect/score adjustment) — it doesn't show up in the first-person debrief as "I'm on mobile so I…". The persona always speaks naturally; the device is a runner-side fact.

### 3.3 Skill integration — structural test ("click-test")

Two new flags, mutually exclusive with each other and with the legacy `--viewport`:

```
--device <preset>             Single-device run.
--devices "<p1>,<p2>,...">    Matrix mode. Each preset runs the full route crawl independently.
--viewport <W>x<H>            Legacy direct viewport. Kept for back-compat.
(none)                        Default = desktop (1280×720). Identical to today.
```

Crawl structure becomes:

```
for device in devices:
  browser_resize(device.viewport)             ← once per device pass
  for route in routes:
    navigate, ready-check, scan, optional modal sweep
    tag every finding with device + route
dedup findings by {device, route, via, kind, selector}
                       ↑
                       device IS part of the dedup key — same duplicate-id
                       on mobile + desktop is two regressions (responsive CSS
                       can hide one), correctly reported twice.
```

Cache-bust runs **once per session**, not per device pass — service-worker state is global.

**Device-sensitive rules**: the `small-touch-target` assertion is meaningless on desktop (mouse cursor). When both desktop AND mobile passes ran, downgrade desktop-pass `small-touch-target` findings by one severity — the mobile pass is authoritative.

**Report structure** in matrix mode:

```
PER-DEVICE COVERAGE
  device=desktop
    /cellar — scanned — 312 elements — 4 findings (P0:1, P2:3)
  device=mobile
    /cellar — scanned — 308 elements — 9 findings (P0:2, P1:2, P2:5)

CROSS-DEVICE
  Shared (both):  4 findings — duplicate-id × 2, orphan-label × 2
  Desktop-only:   0
  Mobile-only:    6 findings — small-touch-target × 4, input-no-name × 2
  Interpretation: 6 issues only surface on mobile — typical responsive-CSS gap.
```

The cross-device row is the actual reason to do this. Without it, devs see "12 findings, looks fine on my desktop" and don't realise 6 of them only happen on phones.

---

## 4. Acceptance criteria

Lockable behaviours — pick a few for whatever test framework lives at the target repo:

1. `resolveDevicePreset("mobile-first wine enthusiast")` → preset `mobile`, `resolvedFrom: "description"`, `matched: "mobile-first"`.
2. `resolveDevicePreset("Admin power user")` → preset `desktop`, `resolvedFrom: "fallback"`. ("power user" must NOT match desktop.)
3. `resolveDevicePreset("Casual user on their phone in bed")` → preset `mobile`. (Possessive pronoun "their" — not just "my/a/the".)
4. `resolveDevicePreset("low-end Android, mobile-first")` → preset `mobile-small`. (Order: longer/more-specific match wins.)
5. `parseViewportFlag("390x844")` → `isMobile: true, hasTouch: true` (width <768 implies mobile).
6. `parseViewportFlag("100x100")` throws (out of `[320, 4096]` range).
7. `parseDevicesFlag("desktop,mobile,desktop")` returns 2 presets (dedup).
8. `parseDevicesFlag("desktop,foo")` throws.
9. End-to-end: a persona description with "mobile-first" results in a `browser_resize({width:390, height:844})` call recorded BEFORE the first `browser_navigate`. (Verify via MCP call log or a runner-side spy.)
10. End-to-end: click-test matrix run with `--devices "desktop,mobile"` produces a report containing both `device=desktop` and `device=mobile` sections, with at least one finding tagged to each.

---

## 5. Implementation order (~3-4 hours for someone who knows the codebase)

1. **Drop in the module** (~30 min)
   - Copy `scripts/lib/device-presets.mjs` from this repo to the target repo's shared lib location.
   - Adjust the file extension / import style (`.mjs` → `.ts` + named exports, or `import` → `require` for CJS).
   - Wire the CLI guard for the target's runtime (in this repo: `pathToFileURL(process.argv[1])` for Windows path safety — the naïve string compare breaks on Windows).

2. **Tests** (~30 min)
   - Port `tests/device-presets.test.mjs`. Keep it framework-agnostic-looking: 30 tiny assertions, no fixtures, no I/O.
   - Run them. If anything fails, the resolver regex needs a tweak — start with #2 (the "power user" anti-match) and #3 (the "their" possessive), those were the gotchas in this repo.

3. **Persona-test skill** (~45 min)
   - Add Phase 1a (device resolution) between tool-detect and cache-bust.
   - Add `--device <preset>` parsing to the argument block.
   - Add `Device:` line to the report header.
   - Add device line to the pair-mode report header.
   - Regenerate any mirror copies your skill-sync uses.

4. **Click-test skill** (~45 min)
   - Add `--device` + `--devices` to argument parsing with mutual-exclusion rules.
   - Wrap the per-route crawl in an outer device loop.
   - Update the finding-schema example: `device: string`.
   - Update dedup key: `{device, route, via, kind, selector}`.
   - Update report template: per-device coverage + cross-device diff section.
   - Add the small-touch-target downgrade note (desktop's reading is non-authoritative when mobile also ran).

5. **Verify** (~30 min)
   - Pick one mobile-first persona in your registry. Run a session. Check:
     - The log line `[device-profile] resolved ... → mobile (390x844, touch=true)` appears.
     - The first `browser_resize` MCP call has `{width: 390, height: 844}`.
     - The report header shows the device.
   - Pick one app. Run `/click-test <url> --devices "desktop,mobile"`. Check:
     - The PER-DEVICE COVERAGE table appears with two rows.
     - At least one finding is unique to mobile (probably small-touch-target on a real app).

6. **Document the back-compat** (~15 min)
   - In the work repo's README or skill docs, mention: existing callers passing no flags get **identical behaviour** to today (desktop, 1280×720). The new behaviour is opt-in via persona-description cues OR explicit flags.

---

## 6. Migration safety / back-compat

- **No DB schema change.** Resolution is runtime from description text.
- **No new dependencies.** Pure stdlib (regex + JSON).
- **No flag breakage.** `--viewport WxH` keeps working in click-test. `--device` and `--devices` are new and mutually exclusive with it.
- **No behaviour change for unmatched personas.** Descriptions with no device cue resolve to `desktop`, which equals today's default.
- **No coupling to MCP-specific APIs.** The module is pure data — the MCP `browser_resize` call lives in the skill instructions, not the module. A code-driven Playwright runner can consume the same module via `await page.setViewportSize(preset.viewport)`.

---

## 7. Trade-offs worth flagging in code review

1. **Keyword regex resolver, not embeddings.** Cheaper, deterministic, debuggable. The cost is that "tablet-first" gets `tablet` but "iPad-first" gets `mobile` (because "iPad" is a tablet cue that also contains the prefix some embedding model might cluster differently). For the persona-description corpus we actually see, regex is the right call. Revisit if descriptions get prose-heavy.

2. **Five presets, not Playwright's full device list.** Playwright ships ~120 device definitions. We use 5 because the SKILL.md's resolver pattern table has to fit on one screen for the LLM to reason about it. Adding more devices means adding more cues to the resolver, which is the friction point — not the data.

3. **Cross-device dedup keyed on `device`.** Means a true single-codebase bug (duplicate-id present on every device) gets reported once per device pass. That's the right call: surfaces the per-device fix surface separately (responsive CSS may have different fix sites). If it gets noisy, add a "deduplicated across devices" rollup in the report — but don't change the dedup key.

4. **Desktop fallback, not "infer from URL"** (e.g. mobile URLs like `m.example.com`). Out of scope — most modern apps are responsive on a single domain.

5. **Persistence deferred.** Today, every test session re-resolves from description. If you rename a persona from "mobile-first" to "main use case" without thinking, the device silently shifts to desktop. Mitigation: the resolved device is in the report header, so a diff between two reports surfaces the change. Add a `device_preset` column on the persona row only after you see this fire.

---

## 8. What this does NOT replace

- **Real device labs / BrowserStack** for OEM-quirk testing (Android Chrome ≠ desktop Chrome for some `:hover` and `vh` behaviours).
- **A11y audits with real screen readers** — the `small-touch-target` rule catches sizing but not how VoiceOver announces a fix.
- **Network throttling** for slow-3G performance work.

This patch is about catching the *invisible-in-default-viewport* class of bugs: layout, touch targets, mobile-only CTAs, narrow-width overflow. It's the cheap 80% — the right precursor to investing in any of the above.

---

## 9. Files to copy from the reference implementation

If the work repo already uses the same skill-bundle structure:

```
scripts/lib/device-presets.mjs           ← copy verbatim
tests/device-presets.test.mjs            ← copy verbatim (adjust import paths)
skills/persona-test/SKILL.md             ← apply Phase 1a + header changes
skills/click-test/SKILL.md               ← apply --device/--devices + matrix flow
```

If the work repo uses a different stack:
- Port the module idiomatically (TS / Python / Go all trivial — it's 5 dicts + a regex loop).
- The skill `.md` changes are platform-neutral prose; lift the structure, keep your own phrasing.

Reference commit (in this repo): the changes that landed alongside this plan touch only the four files above, plus an auto-regenerated mirror under `.claude/skills/`. ~150 LOC of code + ~200 lines of skill spec.

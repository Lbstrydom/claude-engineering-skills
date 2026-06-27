/**
 * @fileoverview Pure skill recommender — the à-la-carte "what's worth running next"
 * advisor (origin: `/brainstorm --with-gemini`, 2026-06-27; OpenAI+Gemini consensus).
 * Maps a change's signals to the FEW additional bundle skills that would add value, so
 * the user doesn't have to remember the whole chain.
 *
 * Load-bearing design rules (both models, emphatic — a recommender the team learns to
 * ignore in a week is worse than nothing):
 *   - DETERMINISTIC, no LLM (signal→lens is a lookup table).
 *   - NUDGE, NEVER GATE.
 *   - SILENT WHEN NOTHING FITS (no card on a backend-only change).
 *   - CAPPED + ranked by leverage (default max 2; one is often better).
 *   - Env-aware: a live-browser lens is dropped when no app URL is configured.
 *   - Never recommends the skill that just ran, nor a lens already covered for this commit.
 *
 * Signal hierarchy (best first): audit FINDINGS (post-implementation, code-grounded —
 * strictly dominates the others) → plan `applicable_lenses` (pre-code intent) → tight
 * positive-evidence file globs (fallback, structural lenses only — the fuzzy lenses
 * click/persona require a finding or plan signal, never file-paths alone).
 *
 * @module scripts/lib/skill-recommender
 */

/** Browser lenses need the app rendered live → suppressed without an app URL. */
const BROWSER_LENSES = new Set(['persona-test', 'click-test', 'nav-audit', 'visual-audit']);

/** Leverage rank (higher = recommended first) — matches the brainstorm consensus
 *  ordering: lock an unguarded fix first, then theme > nav > semantic-DOM > journey. */
const LEVERAGE = { 'ux-lock': 5, 'visual-audit': 4, 'nav-audit': 3, 'click-test': 2, 'persona-test': 1 };

const CMD = {
  'ux-lock': '/ux-lock "<the fix>"',
  'visual-audit': '/visual-audit --verify <url>',
  'nav-audit': '/nav-audit --verify <url>',
  'click-test': '/click-test <url>',
  'persona-test': '/persona-test "<persona>" <url>',
};

function shortFinding(f) {
  const s = String(f?.title || f?.message || f?.category || 'a finding').replace(/\s+/g, ' ').trim();
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
}

/**
 * Build per-lens evidence from the 3-tier signal hierarchy. First hit per lens wins
 * (audit > plan > files), so a lens always carries its STRONGEST reason.
 * @returns {{nav,visual,click,persona}} each `{hit:boolean, why?:string, source?:string}`
 */
function collectLensEvidence({ changedFiles = [], auditFindings = [], planLenses = [] }) {
  const ev = { nav: { hit: false }, visual: { hit: false }, click: { hit: false }, persona: { hit: false } };
  const set = (lens, why, source) => { if (!ev[lens].hit) ev[lens] = { hit: true, why, source }; };

  // Tier 1 — audit findings (highest signal): keyword over category+title+message.
  for (const f of auditFindings) {
    const t = `${f?.category || ''} ${f?.title || ''} ${f?.message || ''} ${f?.recommendation || ''}`.toLowerCase();
    if (/\baria\b|accessib|semantic.?html|\blabel(s|led|ling)?\b|role=|heading|alt text|tabindex|keyboard|duplicate id|form control/.test(t)) {
      set('click', `audit flagged a semantic-HTML/accessibility issue ("${shortFinding(f)}")`, 'audit');
    }
    if (/\broute|navigat|\blink\b|menu|breadcrumb|redirect|deep.?link|sitemap|reachab/.test(t)) {
      set('nav', `audit flagged a navigation/routing concern ("${shortFinding(f)}")`, 'audit');
    }
    if (/theme|dark.?mode|contrast|colou?r|\bcss\b|design.?token|spacing|typograph|\bfont\b|styling|stylesheet/.test(t)) {
      set('visual', `audit flagged a styling/theme issue ("${shortFinding(f)}")`, 'audit');
    }
    if (/journey|onboarding|checkout|user.?flow|user.?experience|confusing|friction|workflow|drop.?off/.test(t)) {
      set('persona', `audit flagged a user-journey concern ("${shortFinding(f)}")`, 'audit');
    }
  }

  // Tier 2 — plan applicable_lenses (explicit pre-code intent).
  for (const l of planLenses) {
    const lens = { nav: 'nav-audit', navigation: 'nav-audit', visual: 'visual-audit', click: 'click-test', persona: 'persona-test' }[String(l).toLowerCase()];
    if (lens) { const key = { 'nav-audit': 'nav', 'visual-audit': 'visual', 'click-test': 'click', 'persona-test': 'persona' }[lens]; set(key, `the plan declared this change needs the ${key} lens`, 'plan'); }
  }

  // Tier 3 — file-path evidence: ONLY the high-confidence STRUCTURAL lenses (visual,
  // nav). The fuzzy lenses (click/persona) deliberately do NOT fire on paths alone —
  // "a component changed" is the banner-blindness trap.
  // Conservative, high-confidence frontend signals only. Deliberately NOT bare
  // `route(s)` (matches backend `api/route.mjs`) or bare `tokens` (matches auth
  // `lib/tokens.mjs`) — those ambiguous cases stay silent unless an audit finding
  // (tier 1) raises them. False-positives erode trust faster than a missed nudge.
  const files = changedFiles.map((f) => String(f).toLowerCase());
  const firstMatch = (re) => files.find((f) => re.test(f));
  let m;
  if ((m = firstMatch(/\.(css|scss|sass|less|styl)$|tailwind\.config|\.module\.(css|scss)$|(^|\/)(design-tokens?|theme)[./]|(^|\/)styles?\//))) {
    set('visual', `a styling/token source changed (\`${m}\`)`, 'files');
  }
  if ((m = firstMatch(/(^|\/)(router|navigation|navbar|sidebar)[./]|(^|\/)menu\.[jt]sx?$|(^|\/)app\/.*\/(layout|page)\.[jt]sx?$|route[s-]?config/))) {
    set('nav', `a routing/nav source changed (\`${m}\`)`, 'files');
  }

  return ev;
}

/**
 * Recommend the few additional skills worth running on this change.
 *
 * @param {object} input
 * @param {string[]} [input.changedFiles]   repo-relative changed paths
 * @param {boolean}  [input.hasLiveUrl]     a deployed app URL is configured (PERSONA_TEST_APP_URL)
 * @param {Array}    [input.auditFindings]  `/audit-code` findings ({category,title,message,…}) — highest signal
 * @param {string[]} [input.planLenses]     plan `applicable_lenses` (`nav|visual|click|persona`)
 * @param {boolean}  [input.unlockedHighFix] a HIGH/P0 fix lacks a `/ux-lock` spec (from the `unlocked_fixes` view)
 * @param {string|null} [input.justRan]     skill that produced this card (suppressed)
 * @param {string[]} [input.alreadyCovered] skills already run for this commit (suppressed)
 * @param {number}   [input.max]            cap (default 2)
 * @returns {Array<{skill,command,reason,leverage,browser}>} ranked, capped, possibly empty
 */
export function recommendSkills(input = {}) {
  const {
    changedFiles = [], hasLiveUrl = false, auditFindings = [], planLenses = [],
    unlockedHighFix = false, justRan = null, alreadyCovered = [], max = 2,
  } = input;

  const ev = collectLensEvidence({ changedFiles, auditFindings, planLenses });
  const candidates = [];
  if (unlockedHighFix) candidates.push({ skill: 'ux-lock', reason: 'a HIGH/P0 fix has no /ux-lock regression spec (it can silently regress)' });
  for (const [key, lens] of [['visual', 'visual-audit'], ['nav', 'nav-audit'], ['click', 'click-test'], ['persona', 'persona-test']]) {
    if (ev[key].hit) candidates.push({ skill: lens, reason: ev[key].why });
  }

  const covered = new Set(alreadyCovered);
  return candidates
    .map((c) => ({ ...c, leverage: LEVERAGE[c.skill] ?? 0, browser: BROWSER_LENSES.has(c.skill), command: CMD[c.skill] }))
    .filter((c) => c.skill !== justRan)         // never the skill that just ran
    .filter((c) => !covered.has(c.skill))        // never a lens already covered for this commit
    .filter((c) => !c.browser || hasLiveUrl)     // env-aware: browser lens needs a live URL
    .sort((a, b) => b.leverage - a.leverage)
    .slice(0, Math.max(0, max));
}

/**
 * Render the "Recommended next" card. Returns '' when there's nothing to suggest —
 * the SILENT-WHEN-EMPTY rule (no card on a backend-only change).
 * @param {ReturnType<typeof recommendSkills>} recs
 * @returns {string}
 */
export function renderRecommendationCard(recs) {
  if (!Array.isArray(recs) || recs.length === 0) return '';
  const rows = recs.map((r, i) => `  ${i + 1}. ${r.command}\n     ↳ ${r.reason}`);
  return [
    '',
    '┌─ Recommended next ' + '─'.repeat(30),
    ...rows,
    '  (advisory — additional lenses that fit THIS change; not required. Browser lenses run against the deployed app.)',
    '└' + '─'.repeat(49),
    '',
  ].join('\n');
}

export const _internals = Object.freeze({ collectLensEvidence, LEVERAGE, BROWSER_LENSES });

/**
 * @fileoverview Home tab — the landing summary: is it healthy, what needs me, what
 * changed, what is moving. PURE `(slice, ui) -> string`: no I/O, no clock, no helper
 * imports (the section contract test enforces arity 2 and the import direction).
 *
 * Four cards, in the order of the three questions: Health -> Needs you ->
 * Recently shipped -> In flight. The model (`home-model.mjs`) has already decided
 * every state, rank and sentence; this file only draws them and refuses to
 * contradict them:
 *   - a chip is drawn `ok` only when the model says it is MEASURED; anything else
 *     is drawn `unmeasured` (state is re-derived here, not trusted blindly);
 *   - "Nothing needs you" is printed only from the model's `needs.headline`;
 *   - an unqueried source says so ("not queried (reason)"), never an empty list.
 *
 * State is never colour-only: every chip carries a text label and a glyph.
 * Every displayed string passes `bound()` (truncation) BEFORE `ui.escapeHtml`, and
 * a truncated value keeps its full text in a `title` attribute (capped at 400 by
 * `bound`). Titles draw on a panel-wide byte budget so the panel stays under its
 * 100 KB ceiling even for maximal, escape-heavy input: past the budget a value is
 * still truncated with an ellipsis, it just loses its hover text.
 *
 * Commands are TEXT in `<code>` — never links, never executed. Cross-tab links use
 * the existing `data-cross-tab` handler in dashboard.js.
 *
 * Slice: `{ src, home }` — `src` is `data.sources.home`, `home` is `data.home|null`.
 *
 * @module scripts/lib/dashboard/sections/home
 */
import { bound, LIMITS, MAX_NEEDS_ROWS } from '../home-model.mjs';
import { HOME_CAPS } from '../schema.mjs';

const SHIPPED_CAP = HOME_CAPS.shipped;
const MERGES_CAP = HOME_CAPS.merges;
const INFLIGHT_CAP = HOME_CAPS.inflight;
/** Escaped bytes all `title` attributes in the panel may spend (see file header). */
const TITLE_BUDGET_BYTES = 30000;
const NON_OK = new Set(['invalid', 'unexpected-error']);
const TAB_ID = /^[A-Za-z][A-Za-z0-9_-]{0,40}$/;

/** state -> glyph + visible label. `neutral` has a label too: "—" alone names nothing. */
const STATES = Object.freeze({
  ok: { glyph: '✓', label: 'OK' },
  warn: { glyph: '!', label: 'WARN' },
  bad: { glyph: '✕', label: 'BAD' },
  neutral: { glyph: '–', label: 'NEUTRAL' },
  unmeasured: { glyph: '?', label: 'unmeasured' },
});
const GRADED = new Set(['ok', 'warn', 'bad', 'neutral']);

export default function sectionHome({ src, home }, ui) {
  const x = ui.escapeHtml;
  let titleBudget = TITLE_BUDGET_BYTES;

  /** bound() then escape; the full text rides in a title while the budget lasts. */
  const show = (value, limit) => {
    const b = bound(value, limit);
    if (b.title === null) return x(b.text);
    const title = x(b.title);
    const cost = Buffer.byteLength(title);
    if (cost > titleBudget) return x(b.text);
    titleBudget -= cost;
    return `<span title="${title}">${x(b.text)}</span>`;
  };
  /** A bounded, escaped value for an ATTRIBUTE (no title of its own). */
  const attr = (value, limit = LIMITS.receiptLabel) => x(bound(value, limit).text);
  const tabLink = (tab, label) => (typeof tab === 'string' && TAB_ID.test(tab)
    ? `<a class="home-link" data-cross-tab href="#panel-${x(tab)}">${show(label, LIMITS.receiptLabel)}</a>` : '');
  const cmd = (command, limit) => `<code class="home-cmd">${show(command, limit)}</code>`;
  const list = (v) => (Array.isArray(v) ? v : []);

  if (!home) {
    return NON_OK.has(src.status)
      ? ui.warningPanel('home', src)
      // No payload is NOT "ok": whatever the source claims, the summary is unmeasured.
      : ui.emptyPanel('home-empty', `Home is unmeasured — ${bound(src.detail || 'the Home summary was not collected for this build', LIMITS.detail).text}`);
  }

  const cards = home.cards ?? {};
  const mOf = (card, id) => list(cards[card]?.measurements).find((m) => m.id === id) ?? null;

  /** A card's own warning: status, name and detail. The other cards are unaffected. */
  const warning = (label, w) => `<div class="home-warning" data-testid="home-card-warning" role="note">
      <strong>${show(label, LIMITS.receiptLabel)} unavailable (${show(w.status, LIMITS.receiptLabel)})</strong>
      <span class="home-warning-detail">${show(w.detail, LIMITS.detail)}</span></div>`;

  /** One measurement that could not answer: say so with the reason, never an empty list. */
  const notQueried = (m, noun) => `<p class="home-unavailable" data-testid="home-not-queried">${show(`${noun}: not queried (${m ? (m.detail || m.status) : 'no measurement was collected'})`, LIMITS.detail)}</p>`;

  // ── Health ──────────────────────────────────────────────────────────
  // A card whose every reading failed shows its cause ONCE, in its warning. A chip of that card whose own detail is the
  // same sentence does not repeat it (the stacked-chips-with-identical-text defect). Chip -> card by measurement id.
  const cardOfChip = new Map();
  for (const [cid, card] of Object.entries(cards)) for (const m of list(card?.measurements)) cardOfChip.set(m.id, cid);
  const sharedWarning = (c) => cards[cardOfChip.get(c.id)]?.warning ?? null;
  const sameCause = (detail, w) => typeof detail === 'string' && typeof w?.detail === 'string'
    && (detail === w.detail || (w.detail.length >= LIMITS.detail && detail.startsWith(w.detail))); // the warning is clipped at 200
  const chip = (c) => {
    // Re-derive: `ok` is reachable only from a measured value, whatever the model object claims.
    const real = c.measured === true && GRADED.has(c.state);
    const state = real ? c.state : 'unmeasured';
    const s = STATES[state];
    return `<li class="home-chip" data-testid="home-chip" data-chip="${attr(c.id)}" data-state="${state}" data-measured="${real}">
      <span class="chip-head"><span class="chip-glyph" aria-hidden="true">${s.glyph}</span><span class="chip-state">${s.label}</span><span class="chip-label">${show(c.label, LIMITS.receiptLabel)}</span></span>
      <span class="chip-value">${show(c.value, LIMITS.receiptLabel)}</span>
      ${!real && sameCause(c.detail, sharedWarning(c)) ? '' : `<span class="chip-detail">${show(c.detail, LIMITS.detail)}</span>`}
      <span class="chip-actions">${tabLink(c.tab, `${c.tab ?? ''} tab`)}${c.command ? cmd(c.command, LIMITS.path) : ''}</span>
    </li>`;
  };
  const healthWarnings = ['queues', 'vitals', 'consumers']
    .filter((id) => cards[id]?.warning)
    .map((id) => warning(cards[id].label ?? id, cards[id].warning)).join('');
  const health = `<section class="home-card" data-testid="home-card-health" aria-labelledby="home-h-health">
    <h3 id="home-h-health">Health</h3>
    ${healthWarnings}
    <ul class="home-chips">${list(home.health).map(chip).join('')}</ul>
  </section>`;

  // ── Needs you ───────────────────────────────────────────────────────
  const needs = home.needs ?? { rows: [], more: 0, unmeasured: 0, headline: null };
  const needRow = (r) => {
    const note = !r.command && r.commandNote ? `<span class="muted">${show(r.commandNote, LIMITS.receiptLabel)}</span>` : '';
    return `<li class="home-need" data-testid="home-need" data-rule="${attr(r.ruleId)}" data-severity="${x(Number(r.severity) || 0)}">
      <span class="need-sev" title="severity ${x(Number(r.severity) || 0)} of 3">S${x(Number(r.severity) || 0)}</span>
      <span class="need-text">${show(r.text, LIMITS.title)}</span>
      <span class="chip-actions">${r.command ? cmd(r.command, LIMITS.detail) : ''}${tabLink(r.tab, `${r.tab ?? ''} tab`)}${note}</span>
    </li>`;
  };
  const rows = list(needs.rows).slice(0, MAX_NEEDS_ROWS);
  const needsCard = `<section class="home-card" data-testid="home-card-needs" aria-labelledby="home-h-needs">
    <h3 id="home-h-needs">Needs you</h3>
    ${needs.headline ? `<p class="home-allclear" data-testid="home-nothing">${x(bound(needs.headline, LIMITS.receiptLabel).text)}</p>` : ''}
    ${rows.length ? `<ol class="home-needs" data-testid="home-needs">${rows.map(needRow).join('')}</ol>` : (needs.headline ? '' : '<p class="muted">No ranked items.</p>')}
    ${needs.more > 0 ? `<p class="home-more" data-testid="home-needs-more">+${x(Number(needs.more))} more</p>` : ''}
  </section>`;

  // ── Recently shipped ────────────────────────────────────────────────
  const logM = mOf('shipped', 'shipped-log');
  const mergeM = mOf('shipped', 'shipped-merges');
  const logEntry = (e) => `<li data-testid="home-shipped-entry"><span class="ship-date">${show(e.date, LIMITS.receiptLabel)}</span> <span class="ship-title">${show(e.title, LIMITS.title)}</span>${e.planPath ? ` ${tabLink('plans', 'plan')} <span class="muted">${show(e.planPath, LIMITS.path)}</span>` : ''}</li>`;
  const logList = () => {
    if (!logM || logM.status !== 'ok') return notQueried(logM, 'Status log');
    const v = logM.value;
    const entries = list(v.entries).slice(0, SHIPPED_CAP);
    return `${entries.length ? `<ul class="home-list" data-testid="home-shipped-log">${entries.map(logEntry).join('')}</ul>` : '<p class="muted" data-testid="home-shipped-log">No dated entries in status.md.</p>'}
      ${v.skippedHeadings > 0 ? `<p class="muted" data-testid="home-shipped-unparsed">${x(Number(v.skippedHeadings))} heading(s) unparsed</p>` : ''}
      ${v.partial ? '<p class="muted" data-testid="home-shipped-partial">partial: only the first 256 KB of status.md was read</p>' : ''}`;
  };
  const mergeList = () => {
    if (!mergeM || mergeM.status !== 'ok') return notQueried(mergeM, 'Merge log');
    const subjects = list(mergeM.value.subjects).slice(0, MERGES_CAP);
    return subjects.length
      ? `<ul class="home-list" data-testid="home-shipped-merges">${subjects.map((s) => `<li><code class="sha">${attr(s.sha7, 12)}</code> ${show(s.subject, LIMITS.subject)}</li>`).join('')}</ul>`
      : '<p class="muted" data-testid="home-shipped-merges">No merge commits on this branch.</p>';
  };
  const shippedWarn = cards.shipped?.warning;
  const shipped = `<section class="home-card" data-testid="home-card-shipped" aria-labelledby="home-h-shipped">
    <h3 id="home-h-shipped">Recently shipped</h3>
    ${shippedWarn ? warning(cards.shipped.label ?? 'Recently shipped', shippedWarn) : `
    <h4 class="home-sub">Status log</h4>${logList()}
    <h4 class="home-sub">Merges${mergeM && mergeM.status === 'ok' ? ` <span class="muted">(${show(mergeM.value.branch, LIMITS.receiptLabel)})</span>` : ''}</h4>${mergeList()}`}
  </section>`;

  // ── In flight ───────────────────────────────────────────────────────
  const flightM = mOf('inflight', 'inflight');
  const flightRow = (r) => `<li data-testid="home-inflight-row"><span class="fl-label">${show(r.label, LIMITS.path)}</span> <span class="muted">${show(r.kind, LIMITS.receiptLabel)}${r.ahead != null ? ` · ahead ${x(Number(r.ahead))}` : ''}${r.behind != null ? ` · behind ${x(Number(r.behind))}` : ''}${r.overlaps > 0 ? ` · ${x(Number(r.overlaps))} overlap(s)` : ''}</span> <span class="fl-state">${show(r.state, LIMITS.receiptLabel)}</span></li>`;
  const flightBody = () => {
    if (!flightM || flightM.status !== 'ok') return notQueried(flightM, 'In-flight facts');
    const v = flightM.value;
    const fr = list(v.rows).slice(0, INFLIGHT_CAP);
    const more = Math.max(Number(v.more) || 0, list(v.rows).length - fr.length);
    return `${fr.length ? `<ul class="home-list" data-testid="home-inflight">${fr.map(flightRow).join('')}</ul>` : `<p class="muted" data-testid="home-inflight">No worktrees besides ${show(v.baseBranch, LIMITS.receiptLabel)}.</p>`}
      ${more > 0 ? `<p class="home-more" data-testid="home-inflight-more">+${x(more)} more</p>` : ''}
      ${v.notAnalysed ? `<p class="muted">+${x(Number(v.notAnalysed.count))} branch(es) not analysed</p>` : ''}
      <p class="muted" data-testid="home-prs-note">${show(v.prs, LIMITS.detail)}</p>`;
  };
  const inflightWarn = cards.inflight?.warning;
  const inflight = `<section class="home-card" data-testid="home-card-inflight" aria-labelledby="home-h-inflight">
    <h3 id="home-h-inflight">In flight</h3>
    ${inflightWarn ? warning(cards.inflight.label ?? 'In flight', inflightWarn) : flightBody()}
  </section>`;

  // ── Frame ───────────────────────────────────────────────────────────
  const srcNote = src.status !== 'ok'
    ? `<p class="home-source-note muted" data-testid="home-source-note">Some measurements are unavailable (${show(src.status, LIMITS.receiptLabel)}): ${show(src.detail, LIMITS.detail)}</p>` : '';
  return `<div class="home" data-testid="home-root" data-built-at="${attr(home.builtAt)}">
    <p class="home-stale" data-testid="home-stale-banner" role="status" hidden>Built <span data-role="home-age"></span> ago — rebuild with <code>npm run dashboard:build</code></p>
    <p class="home-built muted">A snapshot built ${show(home.builtAt, LIMITS.receiptLabel)}; refresh it with <code>npm run dashboard:build</code>.</p>
    ${srcNote}
    <div class="home-grid">${health}${needsCard}${shipped}${inflight}</div>
  </div>`;
}

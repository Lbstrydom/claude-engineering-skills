/**
 * @fileoverview Start Here tab — new-user orientation for the whole
 * dashboard. Pure static prose (no collected data): what the toolkit is,
 * how the two pages split, the CATEGORY clusters, and the WORKFLOW clusters
 * ("I want to …" → which tabs/skills), all in plain English. Cross-tab
 * links use the existing `data-cross-tab` handler (dashboard.js) so a click
 * lands on the real tab; telemetry links are ordinary page links.
 * Signature: `default({}, ui) → string`.
 *
 * @module scripts/lib/dashboard/sections/start-here
 */

export default function sectionStartHere(_data, ui) {
  const x = ui.escapeHtml;
  const tabLink = (panelId, label) =>
    `<a data-cross-tab href="#panel-${x(panelId)}">${x(label)}</a>`;
  const tel = (hash, label) => `<a href="./telemetry.html${hash}">${x(label)}</a>`;

  return `
  <div class="starthere">
    <h2>What is this?</h2>
    <p>This dashboard is the local control panel for the <strong>Claude Engineering Skills</strong>
    toolkit — a bundle of slash-commands ("skills") that help an AI assistant plan, audit, test,
    and ship code with real quality gates. Everything on these pages is built from this repo and
    its private learning store; the pages are static, local files — nothing here talks to the network.</p>

    <div class="starthere-pages">
      <div class="card">
        <h3>📖 Reference <span class="muted">(this page)</span></h3>
        <p class="oneliner">What the toolkit <em>is</em> — the skills, the commands, how they chain
        together, and how this repo is designed.</p>
      </div>
      <div class="card">
        <h3>📈 <a href="./telemetry.html">Telemetry</a></h3>
        <p class="oneliner">What the toolkit has been <em>doing</em> — audit runs, what the system is
        learning from your decisions, live experiments, ship and security history.</p>
      </div>
    </div>

    <h2>Find things by category</h2>
    <ul class="starthere-cats">
      <li><strong>Understand the toolkit</strong> — ${tabLink('skills', 'Skills')} (every slash-command and when to use it) ·
        ${tabLink('cli', 'CLI')} (operator commands) · ${tabLink('flows', 'Process Flows')} (how they chain).</li>
      <li><strong>Design &amp; plans</strong> — ${tabLink('architecture', 'Architecture')} (what code lives where) ·
        ${tabLink('purpose', 'Purpose')} (why each subsystem exists) · ${tabLink('plans', 'Plans')} (design docs, active and done).</li>
      <li><strong>UX quality lenses</strong> — ${tabLink('navAudit', 'Nav Audit')} (can users reach things?) ·
        ${tabLink('visualAudit', 'Visual Audit')} (does the paint match the design system?).</li>
      <li><strong>Audit pipeline</strong> (Telemetry) — ${tel('', 'Audit Runs, Audit Effectiveness, Prompt Variants, Author Tier, A/B/C, Tiered Shadow')}.</li>
      <li><strong>Learning &amp; invariants</strong> (Telemetry) — what the system learns from your triage; the de-facto rules your code enforces.</li>
      <li><strong>Delivery &amp; governance</strong> (Telemetry) — ship outcomes, security incident memory, per-purpose health.</li>
    </ul>

    <h2>Find things by workflow — “I want to…”</h2>
    <div class="workflow-list">
      <div class="workflow">
        <h3>🏗️ …build a feature properly</h3>
        <p>Run <code>/plan</code> to design it → <code>/audit-plan</code> refines the design with a
        second and third AI model → implement → <code>/audit-code</code> reviews the diff in multiple
        passes → <code>/ship</code> commits, pushes, and updates the docs. See ${tabLink('flows', 'Process Flows')}
        for the full picture.</p>
      </div>
      <div class="workflow">
        <h3>🔍 …check UI quality after a change</h3>
        <p>Four complementary lenses, each catching what the others miss:
        <code>/persona-test</code> (walks the app as a realistic user), <code>/click-test</code>
        (mechanically tries every button and control), <code>/nav-audit</code> (is the navigation
        structure right for every kind of user?), <code>/visual-audit</code> (does the rendering match
        the design tokens?). Results land in ${tabLink('navAudit', 'Nav Audit')} and ${tabLink('visualAudit', 'Visual Audit')}.</p>
      </div>
      <div class="workflow">
        <h3>📊 …know whether the audits are actually helping</h3>
        <p>On ${tel('', 'Telemetry')}: <strong>Audit Effectiveness</strong> (how many findings were real
        vs. noise), <strong>Learning</strong> (what your accept/dismiss decisions are teaching it), and
        <strong>Tiered Shadow</strong> (a cheaper audit pipeline being trialled — and when its go/no-go
        decision is due).</p>
      </div>
      <div class="workflow">
        <h3>🧭 …understand this codebase</h3>
        <p>${tabLink('architecture', 'Architecture')} shows what code lives where and what depends on
        what; ${tabLink('purpose', 'Purpose')} explains <em>why</em> each area exists. The generated
        per-symbol index lives at <code>docs/architecture-map.md</code>.</p>
      </div>
      <div class="workflow">
        <h3>🔐 …check the security posture</h3>
        <p>On ${tel('', 'Telemetry')}: <strong>Security</strong> (incident memory + the audit trail of
        what the secret gate refused or redacted) and <strong>Ship Health</strong> (anything shipped
        with warnings or overrides).</p>
      </div>
    </div>

    <h2>Reading the page</h2>
    <ul class="starthere-tips">
      <li>Sections with a <span aria-hidden="true">▶</span> triangle expand on click — details are
        collapsed by default so pages stay scannable.</li>
      <li>Data-source health dots: <span class="status-dot status-ok"></span>collected ok ·
        <span class="status-dot status-warn"></span>nothing collected yet (usually fine — run the
        relevant skill) · <span class="status-dot status-err"></span>a collector errored.</li>
      <li>These pages are rebuilt locally: <code>npm run dashboard</code> (serve + rebuild) ·
        <code>npm run dashboard:setup</code> (first run).</li>
    </ul>
  </div>`;
}

/*
 * Dashboard browser controller — tab switching, skill search, collapse.
 * Inlined into every generated page by render.mjs. NO network calls of
 * any kind (no fetch, no HEAD probe). See docs/plans/local-dashboard.md §4.
 */
(function () {
  'use strict';

  // ── Tabs ───────────────────────────────────────────────────────
  // Delegated click on the tab strip; arrow-key navigation per WAI-ARIA.
  var strip = document.querySelector('.tabstrip');
  if (strip) {
    var tabs = Array.prototype.slice.call(strip.querySelectorAll('[role="tab"]'));

    function select(tab) {
      tabs.forEach(function (t) {
        var sel = t === tab;
        t.setAttribute('aria-selected', sel ? 'true' : 'false');
        t.tabIndex = sel ? 0 : -1;
        var panel = document.getElementById(t.getAttribute('aria-controls'));
        if (panel) panel.hidden = !sel;
      });
    }

    strip.addEventListener('click', function (e) {
      var tab = e.target.closest('[role="tab"]');
      if (tab) select(tab);
    });

    strip.addEventListener('keydown', function (e) {
      var i = tabs.indexOf(document.activeElement);
      if (i === -1) return;
      var next = -1;
      if (e.key === 'ArrowRight') next = (i + 1) % tabs.length;
      else if (e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = tabs.length - 1;
      if (next >= 0) {
        e.preventDefault();
        tabs[next].focus();
        select(tabs[next]);
      }
    });

    // ── Generic cross-tab links (Purpose ↔ Architecture, either way) ─────
    // Bound on <main> (NOT the tabstrip): chips live inside a tab PANEL, a
    // sibling of .tabstrip, so a tabstrip listener never sees the bubble. The
    // target tab is resolved from the href's element → its tabpanel → the tab
    // controlling it — so both link directions use one handler. `select` takes
    // a DOM element and is in scope here.
    var main = document.getElementById('main') || document.body;
    main.addEventListener('click', function (e) {
      var link = e.target.closest('a[data-cross-tab]');
      if (!link) return;
      var href = link.getAttribute('href') || '';
      if (href.charAt(0) !== '#') return;            // not a same-page hash → let native run
      var target = document.getElementById(href.slice(1));
      if (!target) return;                            // dead anchor → native, no trap
      var panel = target.closest('[role="tabpanel"]');
      if (!panel) return;
      var tab = tabs.filter(function (t) { return t.getAttribute('aria-controls') === panel.id; })[0];
      if (!tab) return;                               // no controlling tab → native, no preventDefault
      e.preventDefault();                             // only now: we can fully service the click
      select(tab); tab.focus();
      // Reveal the target: open ancestor <details> outermost → innermost.
      var chain = [];
      var d = target.closest('details');
      while (d) { chain.unshift(d); d = d.parentElement ? d.parentElement.closest('details') : null; }
      chain.forEach(function (el) { el.open = true; });
      if (target.tagName === 'DETAILS') target.open = true;
      target.scrollIntoView({ block: 'center' });
    });

    // ── Copy-to-clipboard, delegated ──────────────────────────────────
    // The campaigns tab renders a prefilled `campaign.mjs override` command per
    // finding. The command rides in `data-copy` and is read HERE, so no finding
    // id is ever interpolated into an inline handler — the page renders
    // model-authored prose, and an inline onclick built from that content is
    // the injection sink the escaping discipline exists to avoid.
    //
    // Added by the campaigns work: the plan assumed "the existing
    // copy-to-clipboard helper", and there was none.
    main.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-copy]');
      if (!btn) return;
      var text = btn.getAttribute('data-copy') || '';
      var done = function (ok) {
        var was = btn.textContent;
        btn.textContent = ok ? 'Copied' : 'Copy failed';
        setTimeout(function () { btn.textContent = was; }, 1200);
      };
      // `navigator.clipboard` is absent on a file:// origin in some browsers and
      // rejects without a user-activation in others. The fallback keeps the
      // affordance working rather than failing silently — a copy button that
      // does nothing is worse than no button.
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(fallbackCopy(text)); });
      } else {
        done(fallbackCopy(text));
      }
    });
  }

  function fallbackCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (err) { return false; }
  }

  // ── Panel-scoped search (skills + CLI) ─────────────────────────
  // Each search input lives inside a tab-panel; the cards it filters are
  // its sibling `[data-search]` elements within the SAME panel. This keeps
  // the skill search from also hiding CLI cards (and vice versa).
  function wireSearch(boxSelector, countSelector, noun) {
    var box = document.querySelector(boxSelector);
    if (!box) return;
    var panel = box.closest('[role="tabpanel"]') || document;
    var count = panel.querySelector(countSelector);
    var cards = Array.prototype.slice.call(panel.querySelectorAll('[data-search]'));
    var apply = function () {
      var q = box.value.trim().toLowerCase();
      var shown = 0;
      cards.forEach(function (c) {
        var hit = !q || c.getAttribute('data-search').indexOf(q) !== -1;
        c.hidden = !hit;
        if (hit) shown++;
      });
      if (count) {
        count.textContent = q
          ? shown + ' of ' + cards.length + ' ' + noun + ' match "' + q + '"'
          : cards.length + ' ' + noun;
      }
    };
    box.addEventListener('input', apply);
    apply();
  }
  wireSearch('[data-role="skill-search"]', '[data-role="skill-count"]', 'skills');
  wireSearch('[data-role="cli-search"]',   '[data-role="cli-count"]',   'commands');

  // ── Audit-run findings filters (docs/plans/dashboard-audit-run-viewer.md) ──
  // Namespaced + guarded: no-ops unless a [data-dashboard-kind="audit-run"]
  // root is present, so index.html / telemetry.html are unaffected (M3).
  // OR within a chip group, AND across groups; the free-text file filter is an
  // ANDed case-insensitive substring on the file cell's textContent (the file
  // is arbitrary text, never a data-* attribute — H3).
  function initAuditRunFilters(root) {
    if (!root) return;
    var bar = root.querySelector('.filter-bar');
    var rows = Array.prototype.slice.call(root.querySelectorAll('.finding-row'));
    if (!bar || !rows.length) return;
    var fileInput = root.querySelector('[data-filter-file]');
    var noMatch = root.querySelector('[data-filter-nomatch]');

    function activeValues(group) {
      var pressed = bar.querySelectorAll('.filter-chip[data-filter-group="' + group + '"][aria-pressed="true"]');
      return Array.prototype.map.call(pressed, function (c) { return c.getAttribute('data-filter-value'); });
    }

    function apply() {
      var sevs = activeValues('severity');
      var passes = activeValues('pass');
      var statuses = activeValues('status');
      var fileQ = (fileInput && fileInput.value ? fileInput.value : '').trim().toLowerCase();
      var shown = 0;
      rows.forEach(function (row) {
        var okSev = !sevs.length || sevs.indexOf(row.getAttribute('data-severity')) !== -1;
        var okPass = !passes.length || passes.indexOf(row.getAttribute('data-pass')) !== -1;
        var okStatus = !statuses.length || statuses.indexOf(row.getAttribute('data-status')) !== -1;
        var okFile = true;
        if (fileQ) {
          var cell = row.querySelector('[data-filter-file-cell]');
          var text = cell ? (cell.textContent || '').toLowerCase() : '';
          okFile = text.indexOf(fileQ) !== -1;
        }
        var visible = okSev && okPass && okStatus && okFile;
        row.hidden = !visible;
        if (visible) shown++;
      });
      if (noMatch) noMatch.hidden = shown !== 0;
    }

    bar.addEventListener('click', function (e) {
      var chip = e.target.closest('.filter-chip');
      if (chip) {
        chip.setAttribute('aria-pressed', chip.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
        apply();
        return;
      }
      var reset = e.target.closest('[data-filter-reset]');
      if (reset) {
        Array.prototype.forEach.call(bar.querySelectorAll('.filter-chip'), function (c) {
          c.setAttribute('aria-pressed', 'false');
        });
        if (fileInput) fileInput.value = '';
        apply();
      }
    });
    if (fileInput) fileInput.addEventListener('input', apply);
    apply();
  }
  initAuditRunFilters(document.querySelector('[data-dashboard-kind="audit-run"]'));
})();

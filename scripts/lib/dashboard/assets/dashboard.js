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
  }

  // ── Skill search ───────────────────────────────────────────────
  var box = document.querySelector('[data-role="skill-search"]');
  var count = document.querySelector('[data-role="skill-count"]');
  if (box) {
    var cards = Array.prototype.slice.call(document.querySelectorAll('[data-search]'));
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
          ? shown + ' of ' + cards.length + ' skills match "' + q + '"'
          : cards.length + ' skills';
      }
    };
    box.addEventListener('input', apply);
    apply();
  }
})();

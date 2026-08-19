// Minimised from wine-cellar-app wineShop/currencyHintBanner.js @ 274ad342
// (lines ~85-97). Disposition: FP — consumed by a live legacy DOM fallback kept
// by design, not by an in-repo addEventListener. Still dispatch-only in the
// current wine-cellar-app inventory (never "fixed" because it isn't a bug).
function renderSettingsLink(root) {
  const settingsLink = el('a', {
    href: '#',
    on: {
      click: (e) => {
        e.preventDefault();
        // @event-consumer-external: legacy #tab-settings click fallback kept by design (D5)
        const ev = new CustomEvent('wine-shop:navigate', {
          bubbles: true, cancelable: true, detail: { target: 'settings' },
        });
        root.dispatchEvent(ev);
      },
    },
  });
  return settingsLink;
}

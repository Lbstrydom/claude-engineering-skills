// Minimised from wine-cellar-app wineShop/index.js @ 274ad342 (lines ~1352-1360).
// Disposition: REAL-BUG (confirmed defect) — no listener existed anywhere at this
// commit; e01a49a6 wired routing through tier-gated switchView / add-bottle modal.
function _handleColdStartAction(actionKey) {
  const evt = new CustomEvent('wineShop:coldStartAction', {
    detail: { actionKey },
    bubbles: true,
    cancelable: true,
  });
  viewEl.dispatchEvent(evt);
}

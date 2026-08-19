// Minimised from wine-cellar-app shared/wineSearch.js @ 274ad342 (lines ~55-59).
// Disposition: FP — consumed by a browser-extension content script (not in-repo).
// Still dispatch-only in the current wine-cellar-app inventory.
export function setWineSources(sources) {
  safeStorage.set(STORAGE_KEY, JSON.stringify(sources));
  // @event-consumer-external: chrome.storage sync content script, not in-repo (D5)
  window.dispatchEvent(new CustomEvent('wineapp:sources-changed', { detail: sources }));
}

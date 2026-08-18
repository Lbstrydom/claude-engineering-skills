// Minimised from wine-cellar-app shared/undoToast.js @ 274ad342 (lines ~90-108).
// Disposition: REAL-BUG (confirmed defect) — no listener existed anywhere at this
// commit; e01a49a6 wired refreshInventoryViews for this event.
async function handleUndoClick(token) {
  const result = await executeUndo(token);
  if (result.success) {
    // Notify all views that cellar state changed
    window.dispatchEvent(new CustomEvent('cellar:mutation', { detail: { type: 'undo' } }));
  }
}

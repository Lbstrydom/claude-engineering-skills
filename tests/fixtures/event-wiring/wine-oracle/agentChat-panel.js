// Minimised from wine-cellar-app agentChat/panel.js @ 274ad342 (line ~138).
// Disposition: DELETED — e01a49a6 removed this dispatch as redundant.
function initPanel() {
  document.dispatchEvent(new CustomEvent('agent-chat:ready'));
}

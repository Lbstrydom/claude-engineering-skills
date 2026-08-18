// Minimised from wine-cellar-app cellarAnalysis/layoutDiffOrchestrator.js @ 274ad342
// (lines ~200-238). Disposition: DELETED — a4ec98da removed this dispatch
// ("delete the last orphan dispatch (walkthrough:cta-event)").
function renderLayoutDiffCta(ctaEl, proposal, moveCount) {
  ctaEl.querySelector('.layout-proposal-view-btn')?.addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('walkthrough:cta-event', {
      detail: { action: 'preview-proposed-layout', context: 'analysis-layout-cta', demoted: true, moveCount },
    }));
    openDiffView(proposal);
  });
}

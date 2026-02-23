// Copy-to-clipboard, parallax scroll, reveal observer, code tab switching.

// --- Copy Install Command ---
document.querySelectorAll('.copy-btn').forEach((button) => {
  button.addEventListener('click', async () => {
    const installCmd = button.closest('.install-box')
      ?.querySelector('.install-cmd')
      ?.textContent
      ?.trim();
    if (!installCmd) return;

    try {
      await navigator.clipboard.writeText(installCmd);
      button.classList.add('is-copied');
      setTimeout(() => button.classList.remove('is-copied'), 1200);
    } catch {
      button.classList.remove('is-copied');
    }
  });
});

// --- Parallax Scroll ---
let ticking = false;
window.addEventListener('scroll', () => {
  if (!ticking) {
    window.requestAnimationFrame(() => {
      document.documentElement.style.setProperty('--scroll-y', String(window.scrollY));
      ticking = false;
    });
    ticking = true;
  }
}, { passive: true });

// --- Reveal ---
document.querySelectorAll('.reveal').forEach((el) => {
  el.classList.add('visible');
});

// --- Code Tab Switching ---
document.querySelectorAll('.code-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    const panelId = (tab as HTMLElement).dataset.panel;
    if (!panelId) return;
    const parent = tab.closest('.code-tabs');
    if (!parent) return;
    parent.querySelectorAll('.code-tab').forEach(t => t.classList.remove('active'));
    parent.querySelectorAll('.code-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(panelId)?.classList.add('active');
  });
});

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

// --- Install Method Tabs ---
document.querySelectorAll('.install-panels').forEach((wrap) => {
  // Lock width to the terminal box so agent tab truncates to match
  const terminalBox = wrap.querySelector('.install-box:not(.install-box--agent)');
  if (terminalBox) {
    (wrap as HTMLElement).style.width = terminalBox.getBoundingClientRect().width + 'px';
  }
  const tabGroup = wrap.previousElementSibling;
  if (!tabGroup?.classList.contains('install-tabs')) return;
  const panels = wrap.querySelectorAll('.install-panel');
  tabGroup.querySelectorAll('.install-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const method = (tab as HTMLElement).dataset.install;
      if (!method) return;
      tabGroup.querySelectorAll('.install-tab').forEach(t => t.classList.remove('active'));
      panels.forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      panels.forEach(p => {
        if (p.id.endsWith(`install-${method}`)) p.classList.add('active');
      });
    });
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

// --- Reveal (GSAP ScrollTrigger) ---
import { initReveal } from './scroll-reveal';
initReveal();

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

// Global setTheme for canvas-animations to call after reinit.
// Click handler lives in Nav.astro (co-located with the toggle button).
// FOUC prevention lives in Base.astro as an inline <head> script.

declare global {
  interface Window {
    initLatentTopology?: () => void;
    setTheme?: (theme: string, persist?: boolean) => void;
  }
}

function setTheme(nextTheme: string, persist = true) {
  document.documentElement.setAttribute('data-theme', nextTheme);
  if (persist) localStorage.setItem('signet-theme', nextTheme);
  window.initLatentTopology?.();
}

window.setTheme = setTheme;

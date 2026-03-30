// Widget sandbox theme stylesheet and postMessage bridge.
// Injected into every widget iframe via srcdoc.

import { PAGE_AGENT_SCRIPT } from "./page-agent-bundle";

export const WIDGET_BASE_CSS = `
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html { font-family: 'Geist Mono', 'IBM Plex Mono', monospace; font-size: 13px; line-height: 1.5; color: var(--sig-text); background: var(--sig-bg); -webkit-font-smoothing: antialiased; }
body { margin: 0; padding: 8px; min-height: 100%; }

/* Form elements */
input[type="text"], input[type="number"], input[type="email"], input[type="search"], textarea, select {
  background: var(--sig-surface-raised);
  border: 1px solid var(--sig-border);
  border-radius: 4px;
  color: var(--sig-text);
  font-family: inherit;
  font-size: 12px;
  padding: 4px 8px;
  outline: none;
  transition: border-color 0.2s;
}
input[type="text"], input[type="number"], input[type="email"], input[type="search"], select {
  height: 32px;
}
input:focus, textarea:focus, select:focus {
  border-color: var(--sig-accent);
}

button {
  background: var(--sig-surface-raised);
  border: 1px solid var(--sig-border);
  border-radius: 3px;
  color: var(--sig-text);
  font-family: inherit;
  font-size: 11px;
  padding: 4px 10px;
  cursor: pointer;
  transition: background 0.2s;
}
button:hover {
  background: var(--sig-surface);
  border-color: var(--sig-border-strong);
}
button:active {
  transform: translateY(0.5px);
}
button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  pointer-events: none;
}

input[type="range"] {
  -webkit-appearance: none;
  appearance: none;
  width: 100%;
  height: 4px;
  background: var(--sig-surface-raised);
  border-radius: 2px;
  outline: none;
}
input[type="range"]::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--sig-accent);
  cursor: pointer;
}
input[type="range"]::-moz-range-thumb {
  width: 16px;
  height: 16px;
  border: none;
  border-radius: 50%;
  background: var(--sig-accent);
  cursor: pointer;
}

/* Utility classes */
.sig-panel { background: var(--sig-surface); border: 1px solid rgba(255,255,255,0.08); border-radius: 6px; }
.sig-panel-header { border-bottom: 1px solid rgba(0,0,0,0.4); padding: 6px 10px; }
.sig-switch { display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.1); border-radius: 3px; color: var(--sig-text); font-family: var(--font-mono); font-size: 10px; cursor: pointer; transition: all 0.2s; }
.sig-switch:hover { background: rgba(255,255,255,0.06); border-color: rgba(255,255,255,0.15); }
.sig-switch:active { transform: translateY(0.5px); }
.sig-badge { display: inline-flex; align-items: center; padding: 1px 6px; border-radius: 3px; font-size: 9px; font-family: var(--font-mono); text-transform: uppercase; letter-spacing: 0.04em; background: var(--sig-surface-raised); border: 1px solid var(--sig-border); color: var(--sig-text-muted); }
.sig-label { font-size: 11px; color: var(--sig-text-muted); font-family: var(--font-mono); }
.sig-eyebrow { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--sig-text-muted); font-family: var(--font-mono); }
.sig-heading { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.1em; color: var(--sig-text-bright); font-family: var(--font-mono); }
.sig-readout { font-size: 28px; font-weight: 700; font-family: var(--font-mono); letter-spacing: -0.02em; font-variant-numeric: tabular-nums; color: var(--sig-text-bright); }
.sig-data { font-size: 10px; font-family: var(--font-mono); font-variant-numeric: tabular-nums; color: var(--sig-text); }
.sig-groove { height: 2px; background: linear-gradient(to bottom, rgba(0,0,0,0.4), rgba(255,255,255,0.05)); }
.sig-divider { height: 1px; background: linear-gradient(to right, transparent, var(--sig-border-strong), transparent); margin: 8px 0; }
.sig-glow { box-shadow: 0 0 20px rgba(200,255,0,0.15); }
.sig-highlight-text { color: var(--sig-highlight-text); }
.sig-highlight-badge { display: inline-flex; align-items: center; padding: 1px 6px; border-radius: 3px; font-size: 9px; background: var(--sig-highlight-dim); border: 1px solid var(--sig-highlight-muted); color: var(--sig-highlight-text); }

/* Animations */
@keyframes sig-flicker { 0%,97%{opacity:1} 98%{opacity:0.85} 99%{opacity:0.95} 100%{opacity:1} }
@keyframes sig-glow-pulse { 0%,100%{box-shadow:0 0 4px var(--sig-highlight)} 50%{box-shadow:0 0 12px var(--sig-highlight),0 0 24px var(--sig-highlight-dim)} }
@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.5} }

/* Scrollbar */
::-webkit-scrollbar { width: 3px; height: 3px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--sig-border-strong); border-radius: 2px; }
`;

const THEME_VARS = [
	"--sig-bg",
	"--sig-surface",
	"--sig-surface-raised",
	"--sig-border",
	"--sig-border-strong",
	"--sig-text",
	"--sig-text-bright",
	"--sig-text-muted",
	"--sig-accent",
	"--sig-accent-hover",
	"--sig-danger",
	"--sig-warning",
	"--sig-success",
	"--sig-highlight",
	"--sig-highlight-muted",
	"--sig-highlight-dim",
	"--sig-highlight-text",
	"--sig-electric",
	"--sig-electric-muted",
	"--sig-electric-dim",
	"--sig-glow-highlight",
	"--sig-glow-electric",
	"--sig-grid-line",
	"--font-display",
	"--font-mono",
	"--space-xs",
	"--space-sm",
	"--space-md",
	"--space-lg",
	"--ease",
	"--dur",
] as const;

export function buildThemeVars(): string {
	const style = getComputedStyle(document.documentElement);
	const declarations = THEME_VARS.map((v) => `${v}: ${style.getPropertyValue(v).trim()};`)
		.filter((d) => !d.endsWith(": ;"))
		.join("\n  ");
	return `:root {\n  ${declarations}\n}`;
}

export const WIDGET_BRIDGE_SCRIPT = `(function() {
  var rid = 0;
  var pending = new Map();
  var eventListeners = new Map();

  window.signet = {
    callTool: function(name, args) {
      return new Promise(function(resolve, reject) {
        var id = String(++rid);
        pending.set(id, { resolve: resolve, reject: reject });
        parent.postMessage({ type: 'signet:callTool', id: id, tool: name, args: args || {} }, '*');
      });
    },
    readResource: function(uri) {
      return new Promise(function(resolve, reject) {
        var id = String(++rid);
        pending.set(id, { resolve: resolve, reject: reject });
        parent.postMessage({ type: 'signet:readResource', id: id, uri: uri }, '*');
      });
    },
    emit: function(eventType, data) {
      parent.postMessage({ type: 'signet:emit', eventType: eventType, data: data }, '*');
    },
    on: function(eventType, callback) {
      if (!eventListeners.has(eventType)) eventListeners.set(eventType, []);
      eventListeners.get(eventType).push(callback);
      return function unsubscribe() {
        var list = eventListeners.get(eventType);
        if (list) {
          var idx = list.indexOf(callback);
          if (idx >= 0) list.splice(idx, 1);
        }
      };
    }
  };

  var expectedOrigin = (document.location.ancestorOrigins && document.location.ancestorOrigins.length > 0)
    ? document.location.ancestorOrigins[0]
    : null;

  window.addEventListener('message', function(e) {
    if (expectedOrigin && e.origin !== expectedOrigin) return;
    var d = e.data;
    if (!d || typeof d.type !== 'string') return;
    if (d.type === 'signet:result' && pending.has(d.id)) {
      pending.get(d.id).resolve(d.result);
      pending.delete(d.id);
    }
    if (d.type === 'signet:error' && pending.has(d.id)) {
      pending.get(d.id).reject(new Error(d.error));
      pending.delete(d.id);
    }
    if (d.type === 'signet:theme') {
      var root = document.documentElement;
      for (var k in d.vars) {
        if (Object.prototype.hasOwnProperty.call(d.vars, k)) {
          root.style.setProperty(k, d.vars[k]);
        }
      }
    }
    if (d.type === 'signet:event' && d.eventType) {
      var listeners = eventListeners.get(d.eventType) || [];
      for (var i = 0; i < listeners.length; i++) {
        try { listeners[i](d.data); } catch(e) { console.error('signet event handler error:', e); }
      }
    }
    if (d.type === 'signet:action') {
      if (d.action === 'refresh') {
        // Dispatch DOM event for any listener, then trigger full re-fetch
        window.dispatchEvent(new CustomEvent('signet:refresh', { detail: d.data }));
        // Re-run all useEffect cleanups + mounts by forcing React reconciliation
        // Simplest: dispatch event that our React apps can hook into
        var refreshEvent = new Event('signet-data-refresh');
        window.dispatchEvent(refreshEvent);
      }
      if (d.action === 'navigate') {
        // Dispatch navigate event with target info (e.g., {view: "contact", id: "xxx"})
        window.dispatchEvent(new CustomEvent('signet:navigate', { detail: d.data }));
      }
      if (d.action === 'highlight') {
        // Highlight a specific element by text content match
        var target = d.data && d.data.text;
        if (target) {
          var allCells = document.querySelectorAll('td, .contact-name, .deal-name, [data-id]');
          for (var j = 0; j < allCells.length; j++) {
            if (allCells[j].textContent && allCells[j].textContent.toLowerCase().includes(target.toLowerCase())) {
              allCells[j].scrollIntoView({ behavior: 'smooth', block: 'center' });
              allCells[j].style.outline = '2px solid var(--sig-accent, #c8ff00)';
              allCells[j].style.outlineOffset = '2px';
              allCells[j].style.transition = 'outline 0.3s ease';
              var cell = allCells[j];
              // Find the parent row and click it
              var row = cell.closest('tr') || cell.closest('[data-id]') || cell;
              if (row && row.click) row.click();
              setTimeout(function() { cell.style.outline = 'none'; }, 3000);
              break;
            }
          }
        }
      }
    }
    // --- Page Agent bridge handlers ---
    if (d.type === 'signet:getDomState') {
      (async function() {
        try {
          if (window.signet && window.signet.getDomState) {
            var result = await window.signet.getDomState();
            parent.postMessage({ type: 'signet:domState', id: d.id, result: result }, '*');
          } else {
            parent.postMessage({ type: 'signet:domState', id: d.id, result: { success: false, error: 'PageController not ready' } }, '*');
          }
        } catch(err) {
          parent.postMessage({ type: 'signet:domState', id: d.id, result: { success: false, error: err.message || String(err) } }, '*');
        }
      })();
    }
    if (d.type === 'signet:executeAction') {
      (async function() {
        try {
          if (window.signet && window.signet.executeAction) {
            var result = await window.signet.executeAction(d.action);
            parent.postMessage({ type: 'signet:actionResult', id: d.id, result: result }, '*');
          } else {
            parent.postMessage({ type: 'signet:actionResult', id: d.id, result: { success: false, message: 'PageController not ready' } }, '*');
          }
        } catch(err) {
          parent.postMessage({ type: 'signet:actionResult', id: d.id, result: { success: false, message: err.message || String(err) } }, '*');
        }
      })();
    }
    if (d.type === 'signet:agentStart') {
      if (window.signet && window.signet.agentStart) {
        window.signet.agentStart().catch(function(e) { console.warn('agentStart error:', e); });
      }
    }
    if (d.type === 'signet:agentStop') {
      if (window.signet && window.signet.agentStop) {
        window.signet.agentStop().catch(function(e) { console.warn('agentStop error:', e); });
      }
    }
  });

  parent.postMessage({ type: 'signet:ready' }, '*');
})();`;

export function buildSrcdoc(html: string, serverId: string): string {
	const theme = buildThemeVars();
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Geist+Mono:wght@400;500;600;700&family=Chakra+Petch:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>${theme}\n${WIDGET_BASE_CSS}</style>
<script>${WIDGET_BRIDGE_SCRIPT}<\/script>
<script>${PAGE_AGENT_SCRIPT}<\/script>
</head>
<body data-server-id="${serverId.replace(/"/g, "&quot;")}">
${html}
</body>
</html>`;
}

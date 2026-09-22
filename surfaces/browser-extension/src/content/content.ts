import { getConfig } from "../shared/config.js";
import { applyTheme, resolveTheme } from "../shared/theme.js";
import type { ThemeMode } from "../shared/types.js";
document.documentElement.dataset.signetExtension = "true";

let panelHost: HTMLElement | null = null;
let shadowRoot: ShadowRoot | null = null;
let currentSelection = "";
let currentPageUrl = "";
let currentPageTitle = "";

const PANEL_STYLES = `
  @import url('https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap');

  :host {
    all: initial;
    font-family: "IBM Plex Mono", monospace;
    font-size: 13px;
    line-height: 1.55;
  }

  .panel {
    position: fixed;
    z-index: 2147483647;
    width: 320px;
    background: var(--sig-bg);
    border: 1px solid var(--sig-border-strong);
    color: var(--sig-text);
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
    font-family: "IBM Plex Mono", monospace;
    font-size: 13px;
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;

    --sig-bg: #08080a;
    --sig-surface: #0e0e12;
    --sig-surface-raised: #151519;
    --sig-border: rgba(255, 255, 255, 0.06);
    --sig-border-strong: rgba(255, 255, 255, 0.12);
    --sig-text: #d4d4d8;
    --sig-text-bright: #f0f0f2;
    --sig-text-muted: #6b6b76;
    --sig-accent: #8a8a96;
    --sig-accent-hover: #c0c0c8;
    --sig-danger: #8a4a48;
    --sig-success: #4a7a5e;

    --ease: cubic-bezier(0.16, 1, 0.3, 1);
    --dur: 0.2s;
  }

  .panel[data-theme="light"] {
    --sig-bg: #e4dfd8;
    --sig-surface: #dbd5cd;
    --sig-surface-raised: #d1cbc2;
    --sig-border: rgba(0, 0, 0, 0.06);
    --sig-border-strong: rgba(0, 0, 0, 0.12);
    --sig-text: #2a2a2e;
    --sig-text-bright: #0a0a0c;
    --sig-text-muted: #7a756e;
    --sig-accent: #6a6660;
    --sig-accent-hover: #3a3832;
  }

  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 16px;
    border-bottom: 1px solid var(--sig-border);
    background: var(--sig-surface);
  }

  .panel-title {
    font-family: "Chakra Petch", sans-serif;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--sig-text-bright);
  }

  .panel-close {
    background: none;
    border: none;
    color: var(--sig-text-muted);
    cursor: pointer;
    font-size: 16px;
    line-height: 1;
    padding: 0;
    font-family: "IBM Plex Mono", monospace;
    transition: color var(--dur) var(--ease);
  }

  .panel-close:hover {
    color: var(--sig-text-bright);
  }

  .panel-body {
    padding: 12px 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .preview {
    font-size: 11px;
    color: var(--sig-text);
    background: var(--sig-surface-raised);
    border: 1px solid var(--sig-border);
    padding: 8px;
    max-height: 80px;
    overflow-y: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .field-label {
    font-size: 10px;
    color: var(--sig-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-bottom: 2px;
  }

  .field-input {
    width: 100%;
    padding: 4px 8px;
    background: var(--sig-surface-raised);
    border: 1px solid var(--sig-border-strong);
    color: var(--sig-text);
    font-family: "IBM Plex Mono", monospace;
    font-size: 13px;
    outline: none;
    box-sizing: border-box;
    transition: border-color var(--dur) var(--ease);
  }

  .field-input:focus {
    border-color: var(--sig-accent);
  }

  .field-input::placeholder {
    color: var(--sig-text-muted);
  }

  .slider-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .slider {
    flex: 1;
    -webkit-appearance: none;
    appearance: none;
    height: 3px;
    background: var(--sig-border-strong);
    outline: none;
  }

  .slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 12px;
    height: 12px;
    background: var(--sig-text);
    cursor: pointer;
  }

  .slider::-moz-range-thumb {
    width: 12px;
    height: 12px;
    background: var(--sig-text);
    border: none;
    cursor: pointer;
  }

  .slider-value {
    font-size: 11px;
    color: var(--sig-text-muted);
    min-width: 32px;
    text-align: right;
  }

  .source-meta {
    font-size: 10px;
    color: var(--sig-text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .panel-footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 8px 16px;
    border-top: 1px solid var(--sig-border);
    background: var(--sig-surface);
  }

  .btn {
    padding: 4px 12px;
    font-family: "IBM Plex Mono", monospace;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    cursor: pointer;
    border: 1px solid var(--sig-border-strong);
    background: var(--sig-surface-raised);
    color: var(--sig-text);
    transition: all var(--dur) var(--ease);
  }

  .btn:hover {
    background: var(--sig-accent);
    color: var(--sig-bg);
  }

  .btn-primary {
    background: var(--sig-text-bright);
    color: var(--sig-bg);
    border-color: var(--sig-text-bright);
  }

  .btn-primary:hover {
    background: var(--sig-accent-hover);
  }

  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .toast {
    position: fixed;
    bottom: 16px;
    right: 16px;
    padding: 8px 16px;
    background: var(--sig-success);
    color: var(--sig-text-bright);
    font-family: "IBM Plex Mono", monospace;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    z-index: 2147483647;
    opacity: 0;
    transition: opacity var(--dur) var(--ease);
  }

  .toast.visible {
    opacity: 1;
  }
`;

function createPanel(theme: "dark" | "light"): void {
	if (panelHost) return;

	panelHost = document.createElement("div");
	panelHost.id = "signet-save-panel";
	document.body.appendChild(panelHost);

	shadowRoot = panelHost.attachShadow({ mode: "closed" });

	const style = document.createElement("style");
	style.textContent = PANEL_STYLES;
	shadowRoot.appendChild(style);

	const panel = document.createElement("div");
	panel.className = "panel";
	panel.setAttribute("data-theme", theme);
	panel.style.top = "80px";
	panel.style.right = "20px";
	const header = document.createElement("div");
	header.className = "panel-header";

	const title = document.createElement("span");
	title.className = "panel-title";
	title.textContent = "Remember with Signet";
	header.appendChild(title);

	const closeBtn = document.createElement("button");
	closeBtn.className = "panel-close";
	closeBtn.textContent = "\u00d7";
	closeBtn.addEventListener("click", destroyPanel);
	header.appendChild(closeBtn);

	panel.appendChild(header);
	const body = document.createElement("div");
	body.className = "panel-body";
	const preview = document.createElement("div");
	preview.className = "preview";
	preview.textContent = currentSelection;
	body.appendChild(preview);
	const tagsLabel = document.createElement("div");
	tagsLabel.className = "field-label";
	tagsLabel.textContent = "Tags (comma-separated)";
	body.appendChild(tagsLabel);

	const tagsInput = document.createElement("input");
	tagsInput.className = "field-input";
	tagsInput.type = "text";
	tagsInput.placeholder = "web, research, notes...";
	body.appendChild(tagsInput);
	const impLabel = document.createElement("div");
	impLabel.className = "field-label";
	impLabel.textContent = "Importance";
	body.appendChild(impLabel);

	const sliderRow = document.createElement("div");
	sliderRow.className = "slider-row";

	const slider = document.createElement("input");
	slider.className = "slider";
	slider.type = "range";
	slider.min = "0";
	slider.max = "100";
	slider.value = "50";

	const sliderValue = document.createElement("span");
	sliderValue.className = "slider-value";
	sliderValue.textContent = "0.50";

	slider.addEventListener("input", () => {
		sliderValue.textContent = (Number(slider.value) / 100).toFixed(2);
	});

	sliderRow.appendChild(slider);
	sliderRow.appendChild(sliderValue);
	body.appendChild(sliderRow);
	const sourceMeta = document.createElement("div");
	sourceMeta.className = "source-meta";
	sourceMeta.textContent = `Source: ${currentPageTitle || currentPageUrl}`;
	sourceMeta.title = currentPageUrl;
	body.appendChild(sourceMeta);

	panel.appendChild(body);
	const footer = document.createElement("div");
	footer.className = "panel-footer";

	const cancelBtn = document.createElement("button");
	cancelBtn.className = "btn";
	cancelBtn.textContent = "Cancel";
	cancelBtn.addEventListener("click", destroyPanel);
	footer.appendChild(cancelBtn);

	const saveBtn = document.createElement("button");
	saveBtn.className = "btn btn-primary";
	saveBtn.textContent = "Save";
	saveBtn.addEventListener("click", async () => {
		saveBtn.disabled = true;
		saveBtn.textContent = "Saving...";

		const tags = tagsInput.value.trim();
		const importance = Number(slider.value) / 100;
		const sourceNote = currentPageUrl ? `\n\nSource: ${currentPageTitle} (${currentPageUrl})` : "";
		const content = currentSelection + sourceNote;

		try {
			const config = await getConfig();
			const headers: Record<string, string> = { "Content-Type": "application/json" };
			if (config.authToken) {
				headers["Authorization"] = `Bearer ${config.authToken}`;
			}

			const response = await fetch(`${config.daemonUrl}/api/memory/remember`, {
				method: "POST",
				headers,
				body: JSON.stringify({
					content,
					tags: tags || undefined,
					importance,
					source_type: "browser-extension",
					type: "fact",
				}),
			});

			if (response.ok) {
				destroyPanel();
				showToast(theme, "Saved to Signet");
			} else {
				saveBtn.textContent = "Error";
				setTimeout(() => {
					saveBtn.disabled = false;
					saveBtn.textContent = "Save";
				}, 2000);
			}
		} catch {
			saveBtn.textContent = "Offline";
			setTimeout(() => {
				saveBtn.disabled = false;
				saveBtn.textContent = "Save";
			}, 2000);
		}
	});

	footer.appendChild(saveBtn);
	panel.appendChild(footer);

	shadowRoot.appendChild(panel);
	tagsInput.focus();
	const handleEscape = (e: KeyboardEvent): void => {
		if (e.key === "Escape") {
			destroyPanel();
			document.removeEventListener("keydown", handleEscape);
		}
	};
	document.addEventListener("keydown", handleEscape);
}

function destroyPanel(): void {
	if (panelHost) {
		panelHost.remove();
		panelHost = null;
		shadowRoot = null;
	}
}

function showToast(theme: "dark" | "light", message: string): void {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const shadow = host.attachShadow({ mode: "closed" });

	const style = document.createElement("style");
	style.textContent = PANEL_STYLES;
	shadow.appendChild(style);

	const toast = document.createElement("div");
	toast.className = "toast";
	toast.setAttribute("data-theme", theme);
	toast.textContent = message;
	shadow.appendChild(toast);

	requestAnimationFrame(() => {
		toast.classList.add("visible");
	});

	setTimeout(() => {
		toast.classList.remove("visible");
		setTimeout(() => host.remove(), 300);
	}, 2000);
}

chrome.runtime.onMessage.addListener((message, _sender, _sendResponse) => {
	if (message.action === "show-save-panel" || message.action === "trigger-save-shortcut") {
		const selectedText = message.text ?? window.getSelection()?.toString()?.trim() ?? "";
		if (!selectedText) return;

		currentSelection = selectedText;
		currentPageUrl = message.pageUrl ?? window.location.href;
		currentPageTitle = message.pageTitle ?? document.title;

		getConfig().then((config) => {
			const theme = resolveTheme(config.theme);
			destroyPanel();
			createPanel(theme);
		});
	}
});

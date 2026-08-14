// Copy-to-clipboard, parallax scroll, reveal observer, code tab switching.

import { initReveal } from "./scroll-reveal";

let ticking = false;
let hasBoundScroll = false;
let lastScrollY = -1;

function commandKind(command: string): string {
	if (command.startsWith("curl ")) return "native_install";
	if (command.startsWith("npm install")) return "npm_install";
	if (command.startsWith("bun add")) return "bun_install";
	if (command.startsWith("git clone")) return "source_install";
	if (command.startsWith("signet setup")) return "setup";
	if (command.startsWith("signet status")) return "status";
	if (command.startsWith("signet remember")) return "remember";
	if (command.startsWith("signet recall")) return "recall";
	return "other";
}

function initCopyButtons() {
	for (const button of document.querySelectorAll(".copy-btn")) {
		const el = button as HTMLElement;
		if (el.dataset.bound === "true") continue;

		el.dataset.bound = "true";
		button.addEventListener("click", async () => {
			const installCmd =
				button.closest(".quickstart-cmd")?.querySelector(".quickstart-code")?.textContent?.trim() ??
				button.closest(".quickstart-command-row")?.querySelector(".quickstart-command-code")?.textContent?.trim() ??
				button.closest(".install-box")?.querySelector(".install-cmd")?.textContent?.trim();
			if (!installCmd) return;

			try {
				await navigator.clipboard.writeText(installCmd);
				window.dispatchEvent(
					new CustomEvent("signet:command-copied", {
						detail: {
							commandKind: el.dataset.analyticsCommand ?? commandKind(installCmd),
							placement: button.closest(".hero-install") ? "hero" : "quickstart",
						},
					}),
				);
				button.classList.add("is-copied");
				setTimeout(() => button.classList.remove("is-copied"), 1200);
			} catch {
				button.classList.remove("is-copied");
			}
		});
	}
}

function initInstallTabs() {
	for (const wrap of document.querySelectorAll(".install-panels")) {
		const terminalBox = wrap.querySelector(".install-box:not(.install-box--agent)");
		if (terminalBox) {
			(wrap as HTMLElement).style.width = `${terminalBox.getBoundingClientRect().width}px`;
		}

		const tabGroup = wrap.previousElementSibling;
		if (!tabGroup?.classList.contains("install-tabs")) continue;
		const panels = wrap.querySelectorAll(".install-panel");

		for (const tab of tabGroup.querySelectorAll(".install-tab")) {
			const tabEl = tab as HTMLElement;
			if (tabEl.dataset.bound === "true") continue;

			tabEl.dataset.bound = "true";
			tab.addEventListener("click", () => {
				const method = tabEl.dataset.install;
				if (!method) return;
				for (const t of tabGroup.querySelectorAll(".install-tab")) t.classList.remove("active");
				for (const p of panels) p.classList.remove("active");
				tab.classList.add("active");
				for (const p of panels) {
					if (p.id.endsWith(`install-${method}`)) p.classList.add("active");
				}
			});
		}
	}
}

function initCodeTabs() {
	for (const tab of document.querySelectorAll(".code-tab")) {
		const tabEl = tab as HTMLElement;
		if (tabEl.dataset.bound === "true") continue;

		tabEl.dataset.bound = "true";
		tab.addEventListener("click", () => {
			const panelId = tabEl.dataset.panel;
			if (!panelId) return;
			const parent = tab.closest(".code-tabs");
			if (!parent) return;
			for (const t of parent.querySelectorAll(".code-tab")) t.classList.remove("active");
			for (const p of parent.querySelectorAll(".code-panel")) p.classList.remove("active");
			tab.classList.add("active");
			document.getElementById(panelId)?.classList.add("active");
		});
	}
}

function initQuickstartTabs() {
	for (const terminal of document.querySelectorAll(".quickstart-shell, .quickstart-terminal")) {
		const tabs = terminal.querySelectorAll<HTMLElement>("[data-quickstart-target]");
		const panels = terminal.querySelectorAll<HTMLElement>("[data-quickstart-panel]");

		for (const tab of tabs) {
			if (tab.dataset.bound === "true") continue;
			tab.dataset.bound = "true";

			tab.addEventListener("click", () => {
				const target = tab.dataset.quickstartTarget;
				if (!target) return;

				for (const item of tabs) {
					const isActive = item.dataset.quickstartTarget === target;
					item.classList.toggle("is-active", isActive);
					item.setAttribute("aria-selected", isActive ? "true" : "false");
				}

				for (const panel of panels) {
					const isActive = panel.dataset.quickstartPanel === target;
					panel.classList.toggle("is-active", isActive);
					panel.hidden = !isActive;
				}
			});
		}
	}
}

function bindScrollParallax() {
	if (hasBoundScroll) return;
	if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
	if (window.matchMedia("(max-width: 900px)").matches) return;

	const hasParallaxTarget =
		document.getElementById("ascii-dither") !== null ||
		document.getElementById("latent-topology") !== null ||
		document.querySelector(".hex-stream") !== null;

	if (!hasParallaxTarget) return;

	hasBoundScroll = true;
	document.documentElement.style.setProperty("--scroll-y", "0");
	window.addEventListener(
		"scroll",
		() => {
			if (!ticking) {
				window.requestAnimationFrame(() => {
					const nextScrollY = Math.round(window.scrollY);
					if (nextScrollY !== lastScrollY) {
						lastScrollY = nextScrollY;
						document.documentElement.style.setProperty("--scroll-y", String(nextScrollY));
					}
					ticking = false;
				});
				ticking = true;
			}
		},
		{ passive: true },
	);
}

function initInteractions() {
	initCopyButtons();
	initInstallTabs();
	initCodeTabs();
	initQuickstartTabs();
	bindScrollParallax();
	initReveal();
}

initInteractions();
document.addEventListener("astro:page-load", initInteractions);

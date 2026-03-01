// Copy-to-clipboard, parallax scroll, reveal observer, code tab switching.

import { initReveal } from "./scroll-reveal";

let ticking = false;
let hasBoundScroll = false;
let lastScrollY = -1;

function initCopyButtons() {
	document.querySelectorAll(".copy-btn").forEach((button) => {
		const el = button as HTMLElement;
		if (el.dataset.bound === "true") return;

		el.dataset.bound = "true";
		button.addEventListener("click", async () => {
			const installCmd =
				button.closest(".quickstart-cmd")?.querySelector(".quickstart-code")?.textContent?.trim() ??
				button.closest(".quickstart-command-row")?.querySelector(".quickstart-command-code")?.textContent?.trim() ??
				button.closest(".install-box")?.querySelector(".install-cmd")?.textContent?.trim();
			if (!installCmd) return;

			try {
				await navigator.clipboard.writeText(installCmd);
				button.classList.add("is-copied");
				setTimeout(() => button.classList.remove("is-copied"), 1200);
			} catch {
				button.classList.remove("is-copied");
			}
		});
	});
}

function initInstallTabs() {
	document.querySelectorAll(".install-panels").forEach((wrap) => {
		const terminalBox = wrap.querySelector(".install-box:not(.install-box--agent)");
		if (terminalBox) {
			(wrap as HTMLElement).style.width = `${terminalBox.getBoundingClientRect().width}px`;
		}

		const tabGroup = wrap.previousElementSibling;
		if (!tabGroup?.classList.contains("install-tabs")) return;
		const panels = wrap.querySelectorAll(".install-panel");

		tabGroup.querySelectorAll(".install-tab").forEach((tab) => {
			const tabEl = tab as HTMLElement;
			if (tabEl.dataset.bound === "true") return;

			tabEl.dataset.bound = "true";
			tab.addEventListener("click", () => {
				const method = tabEl.dataset.install;
				if (!method) return;
				tabGroup.querySelectorAll(".install-tab").forEach((t) => t.classList.remove("active"));
				panels.forEach((p) => p.classList.remove("active"));
				tab.classList.add("active");
				panels.forEach((p) => {
					if (p.id.endsWith(`install-${method}`)) p.classList.add("active");
				});
			});
		});
	});
}

function initCodeTabs() {
	document.querySelectorAll(".code-tab").forEach((tab) => {
		const tabEl = tab as HTMLElement;
		if (tabEl.dataset.bound === "true") return;

		tabEl.dataset.bound = "true";
		tab.addEventListener("click", () => {
			const panelId = tabEl.dataset.panel;
			if (!panelId) return;
			const parent = tab.closest(".code-tabs");
			if (!parent) return;
			parent.querySelectorAll(".code-tab").forEach((t) => t.classList.remove("active"));
			parent.querySelectorAll(".code-panel").forEach((p) => p.classList.remove("active"));
			tab.classList.add("active");
			document.getElementById(panelId)?.classList.add("active");
		});
	});
}

function initQuickstartTabs() {
	document.querySelectorAll(".quickstart-shell, .quickstart-terminal").forEach((terminal) => {
		const tabs = terminal.querySelectorAll<HTMLElement>("[data-quickstart-target]");
		const panels = terminal.querySelectorAll<HTMLElement>("[data-quickstart-panel]");

		tabs.forEach((tab) => {
			if (tab.dataset.bound === "true") return;
			tab.dataset.bound = "true";

			tab.addEventListener("click", () => {
				const target = tab.dataset.quickstartTarget;
				if (!target) return;

				tabs.forEach((item) => {
					const isActive = item.dataset.quickstartTarget === target;
					item.classList.toggle("is-active", isActive);
					item.setAttribute("aria-selected", isActive ? "true" : "false");
				});

				panels.forEach((panel) => {
					const isActive = panel.dataset.quickstartPanel === target;
					panel.classList.toggle("is-active", isActive);
					panel.hidden = !isActive;
				});
			});
		});
	});
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

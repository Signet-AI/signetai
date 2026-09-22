import { checkHealth, getMemories } from "../shared/api.js";
import { getConfig } from "../shared/config.js";
import { applyTheme, watchSystemTheme } from "../shared/theme.js";
import { initHealthBadge } from "./components/health-badge.js";
import { renderLoading, renderMemories, renderOffline, renderSearchEmpty } from "./components/memory-list.js";
import { updateStats } from "./components/memory-stats.js";
import { initSearch } from "./components/search-bar.js";

async function init(): Promise<void> {
	const config = await getConfig();
	applyTheme(document.documentElement, config.theme);
	watchSystemTheme(() => {
		if (config.theme === "auto") {
			applyTheme(document.documentElement, "auto");
		}
	});
	const healthDot = document.getElementById("health-dot");
	const versionEl = document.getElementById("version");
	const memoriesStatEl = document.getElementById("stat-memories");
	const embeddedStatEl = document.getElementById("stat-embedded");
	const pipelineStatEl = document.getElementById("stat-pipeline");
	const searchInput = document.getElementById("search-input") as HTMLInputElement | null;
	const memoryList = document.getElementById("memory-list");
	const openDashboard = document.getElementById("open-dashboard");
	const openOptions = document.getElementById("open-options");

	if (
		!healthDot ||
		!versionEl ||
		!memoriesStatEl ||
		!embeddedStatEl ||
		!pipelineStatEl ||
		!searchInput ||
		!memoryList ||
		!openDashboard ||
		!openOptions
	) {
		return;
	}
	renderLoading(memoryList);
	const health = await checkHealth();
	const isOnline = health !== null && (health.status === "ok" || health.status === "healthy");
	const updateHealth = initHealthBadge(healthDot, versionEl);
	await updateHealth();

	if (!isOnline) {
		renderOffline(memoryList);
		memoriesStatEl.textContent = "--";
		embeddedStatEl.textContent = "--";
		pipelineStatEl.textContent = "--";
		return;
	}
	let recentMemories = (await getMemories(10, 0)).memories;
	const { stats } = await getMemories(1, 0);
	await updateStats(stats, memoriesStatEl, embeddedStatEl, pipelineStatEl);
	renderMemories(memoryList, recentMemories);
	let isSearching = false;
	initSearch(
		searchInput,
		(results, query) => {
			isSearching = true;
			if (results.length === 0) {
				renderSearchEmpty(memoryList, query);
			} else {
				renderMemories(memoryList, results);
			}
		},
		() => {
			isSearching = false;
			renderMemories(memoryList, recentMemories);
		},
	);
	openDashboard.addEventListener("click", async () => {
		const cfg = await getConfig();
		chrome.tabs.create({ url: cfg.daemonUrl });
	});

	openOptions.addEventListener("click", () => {
		chrome.runtime.openOptionsPage();
	});
}

document.addEventListener("DOMContentLoaded", init);

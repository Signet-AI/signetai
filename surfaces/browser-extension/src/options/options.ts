/**
 * Signet options page
 * Manages daemon URL, auth token, and theme settings
 */

import { getConfig, setConfig } from "../shared/config.js";
import { applyTheme } from "../shared/theme.js";
import type { ThemeMode } from "../shared/types.js";

async function init(): Promise<void> {
	const config = await getConfig();

	// Apply theme to options page
	applyTheme(document.documentElement, config.theme);

	// DOM refs
	const daemonUrl = document.getElementById("daemon-url") as HTMLInputElement | null;
	const authToken = document.getElementById("auth-token") as HTMLInputElement | null;
	const themeSelect = document.getElementById("theme") as HTMLSelectElement | null;
	const saveBtn = document.getElementById("save-btn");
	const savedMsg = document.getElementById("saved-msg");

	if (!daemonUrl || !authToken || !themeSelect || !saveBtn || !savedMsg) return;

	// Populate fields
	daemonUrl.value = config.daemonUrl;
	authToken.value = config.authToken;
	themeSelect.value = config.theme;

	// Live theme preview
	themeSelect.addEventListener("change", () => {
		applyTheme(document.documentElement, themeSelect.value as ThemeMode);
	});

	// Save
	saveBtn.addEventListener("click", async () => {
		await setConfig({
			daemonUrl: daemonUrl.value.trim() || "http://127.0.0.1:3850",
			authToken: authToken.value,
			theme: themeSelect.value as ThemeMode,
		});

		savedMsg.classList.add("visible");
		setTimeout(() => savedMsg.classList.remove("visible"), 2000);
	});
}

document.addEventListener("DOMContentLoaded", init);

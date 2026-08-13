/** Chrome storage helpers for extension configuration */

import { DEFAULT_CONFIG, type ExtensionConfig } from "./types.js";

const STORAGE_KEY = "signet_config";

export function migrateDaemonUrl(raw: string): string {
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		return raw;
	}

	if (parsed.protocol !== "http:" || parsed.hostname.toLowerCase() !== "localhost") {
		return raw;
	}

	parsed.hostname = "127.0.0.1";
	return parsed.toString().replace(/\/$/, "");
}

export async function getConfig(): Promise<ExtensionConfig> {
	return new Promise((resolve) => {
		chrome.storage.local.get([STORAGE_KEY], (result) => {
			const stored = result[STORAGE_KEY] as Partial<ExtensionConfig> | undefined;
			const daemonUrl = migrateDaemonUrl(stored?.daemonUrl ?? DEFAULT_CONFIG.daemonUrl);
			const config: ExtensionConfig = {
				daemonUrl,
				authToken: stored?.authToken ?? DEFAULT_CONFIG.authToken,
				theme: stored?.theme ?? DEFAULT_CONFIG.theme,
			};
			if (stored?.daemonUrl !== undefined && stored.daemonUrl !== daemonUrl) {
				chrome.storage.local.set({ [STORAGE_KEY]: config }, () => resolve(config));
				return;
			}
			resolve(config);
		});
	});
}

export async function setConfig(config: Partial<ExtensionConfig>): Promise<void> {
	const current = await getConfig();
	const merged: ExtensionConfig = { ...current, ...config };
	return new Promise((resolve) => {
		chrome.storage.local.set({ [STORAGE_KEY]: merged }, resolve);
	});
}

export function onConfigChange(callback: (config: ExtensionConfig) => void): void {
	chrome.storage.onChanged.addListener((changes, area) => {
		if (area === "local" && changes[STORAGE_KEY] !== undefined) {
			const newValue = changes[STORAGE_KEY].newValue as ExtensionConfig | undefined;
			if (newValue) {
				callback(newValue);
			}
		}
	});
}

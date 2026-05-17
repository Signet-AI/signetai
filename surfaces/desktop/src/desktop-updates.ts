import { createRequire } from "node:module";
import { app, dialog } from "electron";
import type { AppUpdater, UpdateCheckResult } from "electron-updater";

const require = createRequire(import.meta.url);
const { autoUpdater } = require("electron-updater") as { readonly autoUpdater: AppUpdater };

export type DesktopUpdateStatus =
	| "unsupported"
	| "checking"
	| "not-available"
	| "available"
	| "downloading"
	| "downloaded"
	| "installing"
	| "error";

export interface DesktopUpdateResult {
	readonly status: DesktopUpdateStatus;
	readonly currentVersion: string;
	readonly version?: string;
	readonly message: string;
}

interface CheckDesktopUpdateOptions {
	readonly showNoUpdateDialog?: boolean;
}

let configured = false;
let checkPromise: Promise<DesktopUpdateResult> | null = null;

export function configureDesktopUpdates(): void {
	if (configured) return;
	configured = true;
	autoUpdater.autoDownload = false;
	autoUpdater.autoInstallOnAppQuit = true;
}

export function desktopUpdatesSupported():
	| { readonly supported: true }
	| { readonly supported: false; readonly reason: string } {
	if (!app.isPackaged && process.env.SIGNET_DESKTOP_ENABLE_UPDATES_IN_DEV !== "1") {
		return { supported: false, reason: "Desktop updates are only available in packaged builds." };
	}
	if (process.platform === "linux" && !process.env.APPIMAGE) {
		return { supported: false, reason: "Desktop auto-updates on Linux require the AppImage build." };
	}
	return { supported: true };
}

export async function checkForDesktopUpdate(options: CheckDesktopUpdateOptions = {}): Promise<DesktopUpdateResult> {
	if (checkPromise) return checkPromise;
	checkPromise = doCheckForDesktopUpdate(options).finally(() => {
		checkPromise = null;
	});
	return checkPromise;
}

async function doCheckForDesktopUpdate(options: CheckDesktopUpdateOptions): Promise<DesktopUpdateResult> {
	configureDesktopUpdates();
	const currentVersion = app.getVersion();
	const support = desktopUpdatesSupported();
	if (support.supported === false) {
		const result = { status: "unsupported", currentVersion, message: support.reason } as const;
		if (options.showNoUpdateDialog) await showMessage("Signet updates", result.message);
		return result;
	}

	try {
		const check = await autoUpdater.checkForUpdates();
		const info = updateInfo(check);
		const latestVersion = info?.version;
		if (!check?.updateInfo || !latestVersion || latestVersion === currentVersion) {
			const result = { status: "not-available", currentVersion, message: "Signet is up to date." } as const;
			if (options.showNoUpdateDialog) await showMessage("Signet updates", result.message);
			return result;
		}

		const wantsDownload = await confirmUpdate(latestVersion, currentVersion);
		if (!wantsDownload) {
			return {
				status: "available",
				currentVersion,
				version: latestVersion,
				message: `Signet ${latestVersion} is available.`,
			};
		}

		await autoUpdater.downloadUpdate();
		const wantsRestart = await confirmRestart(latestVersion);
		if (wantsRestart) {
			autoUpdater.quitAndInstall(false, true);
			return {
				status: "installing",
				currentVersion,
				version: latestVersion,
				message: `Installing Signet ${latestVersion}.`,
			};
		}
		return {
			status: "downloaded",
			currentVersion,
			version: latestVersion,
			message: `Signet ${latestVersion} downloaded. Restart Signet to install it.`,
		};
	} catch (err) {
		const message = `Failed to check for Signet updates: ${errorMessage(err)}`;
		console.error(message);
		if (options.showNoUpdateDialog) await showMessage("Signet updates", message, "error");
		return { status: "error", currentVersion, message };
	}
}

function updateInfo(check: UpdateCheckResult | null | undefined): { readonly version?: string } | null {
	return check?.updateInfo ?? null;
}

async function confirmUpdate(version: string, currentVersion: string): Promise<boolean> {
	const response = await dialog.showMessageBox({
		type: "info",
		buttons: ["Download and install", "Later"],
		defaultId: 0,
		cancelId: 1,
		title: "Signet update available",
		message: `Signet ${version} is available`,
		detail: `You are running Signet ${currentVersion}. Download the desktop update now?`,
	});
	return response.response === 0;
}

async function confirmRestart(version: string): Promise<boolean> {
	const response = await dialog.showMessageBox({
		type: "info",
		buttons: ["Restart and install", "Later"],
		defaultId: 0,
		cancelId: 1,
		title: "Signet update downloaded",
		message: `Signet ${version} is ready to install`,
		detail: "Restart Signet now to finish installing the update.",
	});
	return response.response === 0;
}

async function showMessage(title: string, message: string, type: "info" | "error" = "info"): Promise<void> {
	await dialog.showMessageBox({ type, title, message });
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

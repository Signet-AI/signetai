import { spawnSyncHidden } from "@signet/core";

export const DESKTOP_MINIMUM_BUN_VERSION = "1.4.2";

export function desktopBunVersionSupported(version: string): boolean {
	const match = /^(\d+)\.(\d+)\.(\d+)(?:\+[\w.-]+)?$/.exec(version.trim());
	if (!match) return false;
	const minimum = DESKTOP_MINIMUM_BUN_VERSION.split(".").map(Number);
	for (const [i, required] of minimum.entries()) {
		const part = Number(match[i + 1]);
		if (part !== required) return part > required;
	}
	return true;
}

export function readDesktopBunVersion(env: NodeJS.ProcessEnv = process.env): string {
	const result = spawnSyncHidden("bun", ["--version"], {
		env,
		encoding: "utf8",
		timeout: 10_000,
		maxBuffer: 4096,
	});
	if (result.error || result.status !== 0) {
		throw new Error(`Could not check Bun. Install Bun ${DESKTOP_MINIMUM_BUN_VERSION} or newer, then retry.`);
	}
	return result.stdout.trim();
}

export function assertDesktopBunVersion(version: string): void {
	if (!desktopBunVersionSupported(version)) {
		throw new Error(
			`Signet desktop builds require Bun ${DESKTOP_MINIMUM_BUN_VERSION} or newer; found ${version || "an unknown version"}. Upgrade Bun, then retry.`,
		);
	}
}

interface DesktopBunPreflightOptions {
	readonly readVersion?: () => string;
	readonly confirmUpgrade: (message: string, version: string) => Promise<boolean>;
	readonly upgrade?: () => void;
}

export async function prepareDesktopBun(options: DesktopBunPreflightOptions): Promise<void> {
	const readVersion = options.readVersion ?? readDesktopBunVersion;
	const version = readVersion();
	if (desktopBunVersionSupported(version)) return;
	const accepted = await options.confirmUpgrade(
		`Signet desktop requires Bun ${DESKTOP_MINIMUM_BUN_VERSION} or newer; found ${version || "an unknown version"}. Run bun upgrade --stable now? If you installed Bun with a package manager, cancel and upgrade with that manager.`,
		version,
	);
	if (!accepted) throw new Error("Desktop installation cancelled. Upgrade Bun, then retry.");
	(options.upgrade ?? upgradeDesktopBun)();
	assertDesktopBunVersion(readVersion());
}

function upgradeDesktopBun(): void {
	const result = spawnSyncHidden("bun", ["upgrade", "--stable"], { stdio: "inherit", timeout: 120_000 });
	if (result.error || result.status !== 0) {
		throw new Error("Bun upgrade failed. Upgrade Bun manually, then retry the desktop installation.");
	}
}

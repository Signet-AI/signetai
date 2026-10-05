import { spawnSyncHidden } from "@signet/core";

export const DESKTOP_UPDATE_FEED = {
	provider: "github",
	owner: "Signet-AI",
	repo: "signetai",
} as const;

export const DESKTOP_UPDATE_SIGNING_TEAM = "TQK8H7V7RP";

export interface DesktopUpdateEnvironment {
	readonly isPackaged: boolean;
	readonly platform: NodeJS.Platform;
	readonly hasAppImage: boolean;
	readonly codeSigningTeam: string | null;
}

export type DesktopUpdateSupport =
	| { readonly supported: true }
	| { readonly supported: false; readonly reason: string };

export interface DesktopUpdateCheck {
	readonly isUpdateAvailable?: boolean;
	readonly updateInfo?: { readonly version?: string };
}

export function desktopUpdateSupport(environment: DesktopUpdateEnvironment): DesktopUpdateSupport {
	if (!environment.isPackaged) {
		return { supported: false, reason: "Desktop updates are only available in packaged builds." };
	}
	if (environment.platform === "linux" && !environment.hasAppImage) {
		return { supported: false, reason: "Desktop auto-updates on Linux require the AppImage build." };
	}
	if (environment.platform === "darwin" && environment.codeSigningTeam !== DESKTOP_UPDATE_SIGNING_TEAM) {
		return {
			supported: false,
			reason:
				"This copy of Signet is not signed by the Signet release team, so macOS cannot install official updates into it. Update it with `signet desktop install`.",
		};
	}
	return { supported: true };
}

export function codeSigningTeam(codesignOutput: string): string | null {
	const team = /^TeamIdentifier=(.+)$/m.exec(codesignOutput)?.[1]?.trim();
	return team && team !== "not set" ? team : null;
}

export function macAppCodeSigningTeam(
	bundlePath: string,
	run: typeof spawnSyncHidden = spawnSyncHidden,
): string | null {
	const result = run("/usr/bin/codesign", ["--display", "--verbose=2", bundlePath], {
		encoding: "utf8",
		timeout: 5000,
	});
	if (result.error || result.status !== 0) return null;
	return codeSigningTeam(`${result.stdout ?? ""}${result.stderr ?? ""}`);
}

export function desktopUpdateVersion(
	check: DesktopUpdateCheck | null | undefined,
	currentVersion: string,
): string | null {
	if (check?.isUpdateAvailable !== true) return null;
	const version = check.updateInfo?.version;
	if (!version || version === currentVersion) return null;
	return version;
}

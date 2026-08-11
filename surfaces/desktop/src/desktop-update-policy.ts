export const DESKTOP_UPDATE_FEED = {
	provider: "github",
	owner: "Signet-AI",
	repo: "signetai",
} as const;

export interface DesktopUpdateEnvironment {
	readonly isPackaged: boolean;
	readonly platform: NodeJS.Platform;
	readonly hasAppImage: boolean;
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
	return { supported: true };
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

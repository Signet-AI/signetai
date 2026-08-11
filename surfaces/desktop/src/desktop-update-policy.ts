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

export function desktopUpdateSupport(environment: DesktopUpdateEnvironment): DesktopUpdateSupport {
	if (!environment.isPackaged) {
		return { supported: false, reason: "Desktop updates are only available in packaged builds." };
	}
	if (environment.platform === "linux" && !environment.hasAppImage) {
		return { supported: false, reason: "Desktop auto-updates on Linux require the AppImage build." };
	}
	return { supported: true };
}

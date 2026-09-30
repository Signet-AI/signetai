export type DesktopDeepLinkDestination = "dashboard" | "setup";

const DESKTOP_DEEP_LINK_SCHEME = "signet:";

export function desktopDashboardUrl(destination: DesktopDeepLinkDestination): string {
	return destination === "setup" ? "app://signet/#setup" : "app://signet/";
}

export function parseDesktopDeepLink(value: string): DesktopDeepLinkDestination | null {
	try {
		const link = new URL(value);
		if (
			link.protocol !== DESKTOP_DEEP_LINK_SCHEME ||
			link.username.length > 0 ||
			link.password.length > 0 ||
			link.port.length > 0 ||
			(link.pathname !== "" && link.pathname !== "/") ||
			link.search.length > 0 ||
			link.hash.length > 0
		)
			return null;

		if (link.hostname === "dashboard" || link.hostname === "setup") return link.hostname;
		return null;
	} catch {
		return null;
	}
}

export function findDesktopDeepLink(commandLine: readonly string[]): DesktopDeepLinkDestination | null {
	for (let index = commandLine.length - 1; index >= 0; index -= 1) {
		const argument = commandLine[index];
		if (argument === undefined) continue;
		const destination = parseDesktopDeepLink(argument);
		if (destination !== null) return destination;
	}
	return null;
}

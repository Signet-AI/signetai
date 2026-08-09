import type { DesktopBridge } from "@/lib/desktop";

export interface OAuthPopup {
	readonly closed: boolean;
	readonly location: { href: string };
	close(): void;
}

export interface OAuthNavigationOptions {
	readonly bridge: DesktopBridge | null;
	readonly popup: () => OAuthPopup | null;
	reportError(message: string): void;
	clearError(): void;
}

export interface OAuthNavigation {
	open(): boolean;
	navigate(url: string): void;
	close(): void;
	dispose(): void;
}

export function safeOAuthHref(uri: string | undefined): string | null {
	if (!uri) return null;
	try {
		const parsed = new URL(uri);
		return parsed.protocol === "https:" && parsed.hostname ? uri : null;
	} catch {
		return null;
	}
}

export function createOAuthNavigation(options: OAuthNavigationOptions): OAuthNavigation {
	let popup: OAuthPopup | null = null;
	let pendingUrl: string | null = null;
	let openedUrl: string | null = null;
	let active = true;

	const open = (): boolean => {
		if (options.bridge) return true;
		if (popup && !popup.closed) return true;
		popup = options.popup();
		return popup !== null;
	};

	const navigate = (url: string): void => {
		const href = safeOAuthHref(url);
		if (!href) {
			if (active) options.reportError("The provider returned an invalid sign-in URL.");
			return;
		}
		if (pendingUrl === href || openedUrl === href) return;
		if (options.bridge) {
			pendingUrl = href;
			void options.bridge.openExternal(href).then(
				() => {
					if (!active) return;
					pendingUrl = null;
					openedUrl = href;
					options.clearError();
				},
				() => {
					if (!active) return;
					pendingUrl = null;
					options.reportError("Could not open the sign-in page. Use the link below to continue.");
				},
			);
			return;
		}
		if (!popup || popup.closed) return;
		try {
			popup.location.href = href;
		} catch {
			/* cross-origin navigation in progress — the window still lands */
		}
	};

	const close = (): void => {
		if (popup && !popup.closed) {
			try {
				popup.close();
			} catch {
				/* noop */
			}
		}
		popup = null;
	};

	return {
		open,
		navigate,
		close,
		dispose: () => {
			active = false;
			close();
		},
	};
}

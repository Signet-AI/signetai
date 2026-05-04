export interface DesktopWindowState {
	readonly maximized: boolean;
}

export interface SignetDesktopBridge {
	readonly platform:
		| "aix"
		| "android"
		| "darwin"
		| "freebsd"
		| "haiku"
		| "linux"
		| "openbsd"
		| "sunos"
		| "win32"
		| "cygwin"
		| "netbsd";
	readonly daemonPort: number;
	readonly daemonBaseUrl?: string;
	readonly workspacePath?: string | null;
	readonly nativeFrame: boolean;
	minimize(): Promise<void>;
	toggleMaximize(): Promise<void>;
	close(): Promise<void>;
	isMaximized(): Promise<boolean>;
	startDaemon(): Promise<unknown>;
	stopDaemon(): Promise<unknown>;
	restartDaemon(): Promise<unknown>;
	getDaemonStatus(): Promise<unknown>;
	openDashboard(): Promise<void>;
	quickCapture(content: string): Promise<void>;
	searchMemories(query: string, limit?: number): Promise<string>;
	pickDirectory?(options?: { title?: string }): Promise<string | null>;
	checkForUpdate(): Promise<string | null>;
	quit(): Promise<void>;
	onWindowStateChange(callback: (state: DesktopWindowState) => void): () => void;
}

export function getDesktopShell(): SignetDesktopBridge | null {
	if (typeof window === "undefined") return null;
	return window.signetDesktop ?? null;
}

export function isDesktopAppProtocol(): boolean {
	if (typeof window === "undefined") return false;
	return window.location.protocol === "app:";
}

export function isDesktopShell(): boolean {
	return getDesktopShell() !== null || isDesktopAppProtocol();
}

export function desktopApiBase(): string {
	const shell = getDesktopShell();
	if (!shell) return "";
	if (shell.daemonBaseUrl) return shell.daemonBaseUrl;
	const port = Number.isFinite(shell.daemonPort) && shell.daemonPort > 0 ? shell.daemonPort : 3850;
	return `http://localhost:${port}`;
}

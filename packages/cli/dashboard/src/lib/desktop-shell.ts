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
	checkForUpdate(): Promise<string | null>;
	quit(): Promise<void>;
	onWindowStateChange(callback: (state: DesktopWindowState) => void): () => void;
}

export function getDesktopShell(): SignetDesktopBridge | null {
	if (typeof window === "undefined") return null;
	return window.signetDesktop ?? null;
}

export function isDesktopShell(): boolean {
	return getDesktopShell() !== null;
}

export function desktopApiBase(): string {
	const shell = getDesktopShell();
	if (!shell) return "";
	const port = Number.isFinite(shell.daemonPort) && shell.daemonPort > 0 ? shell.daemonPort : 3850;
	return `http://localhost:${port}`;
}

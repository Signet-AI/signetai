import { readFile, stat } from "node:fs/promises";
import { extname, normalize, relative, sep } from "node:path";
import { BrowserWindow, Menu, type OpenDialogOptions, app, dialog, ipcMain, protocol, shell } from "electron";
import { DaemonManager } from "./daemon-manager.js";
import { dashboardRoot, preloadPath } from "./paths.js";
import { daemonRouteTarget, isDaemonRouteUrl } from "./protocol-routes.js";
import { DesktopTray } from "./tray.js";
import { applyDesktopWorkspaceEnv, resolveDesktopWorkspace } from "./workspace.js";

const workspace = applyDesktopWorkspaceEnv(resolveDesktopWorkspace());
const daemon = new DaemonManager({ workspacePath: workspace.path });
let mainWindow: BrowserWindow | null = null;
let tray: DesktopTray | null = null;
let quitting = false;
let daemonStartupError: string | null = null;
let loadedMainWindowUrl: string | null = null;

function enableGpuRendering(): void {
	if (process.env.SIGNET_DESKTOP_DISABLE_GPU === "1") return;
	if (process.platform === "linux" && process.env.WAYLAND_DISPLAY) {
		app.commandLine.appendSwitch("ozone-platform", "wayland");
		app.commandLine.appendSwitch("enable-features", "UseOzonePlatform");
		app.commandLine.appendSwitch("disable-vulkan");
		app.commandLine.appendSwitch("disable-features", "Vulkan,DefaultANGLEVulkan,VulkanFromANGLE");
	}
	app.commandLine.appendSwitch("enable-gpu-rasterization");
	app.commandLine.appendSwitch("enable-zero-copy");
	app.commandLine.appendSwitch("enable-accelerated-2d-canvas");
}

function usesNativeWindowFrame(): boolean {
	return process.env.SIGNET_DESKTOP_NATIVE_FRAME === "1";
}

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".png": "image/png",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
};

function dashboardFile(url: string): string {
	const parsed = new URL(url);
	const rel = normalize(decodeURIComponent(parsed.pathname === "/" ? "/index.html" : parsed.pathname)).replace(
		/^[/\\]+/,
		"",
	);
	const root = dashboardRoot();
	const file = normalize(`${root}${sep}${rel}`);
	const back = relative(root, file);
	if (back.startsWith("..") || back === ".." || back.includes(`${sep}..${sep}`)) {
		throw new Error("Invalid dashboard path");
	}
	return file;
}

async function proxyDaemonRoute(request: Request): Promise<Response> {
	const target = daemonRouteTarget(daemon.baseUrl, request.url);
	const headers = new Headers(request.headers);
	headers.delete("host");
	headers.delete("origin");
	const body =
		request.method === "GET" || request.method === "HEAD"
			? undefined
			: await request.arrayBuffer().catch(() => undefined);

	try {
		return await fetch(target, {
			method: request.method,
			headers,
			body,
			redirect: "manual",
		});
	} catch (err) {
		return Response.json({ error: "Failed to reach Signet daemon", detail: errorMessage(err) }, { status: 502 });
	}
}

async function registerDashboardProtocol(): Promise<void> {
	protocol.handle("app", async (request) => {
		if (isDaemonRouteUrl(request.url)) return proxyDaemonRoute(request);

		let file = dashboardFile(request.url);
		const info = await stat(file).catch(() => null);
		if (!info?.isFile()) file = `${dashboardRoot()}${sep}index.html`;
		return new Response(await readFile(file), {
			headers: { "content-type": MIME[extname(file)] ?? "application/octet-stream" },
		});
	});
}

function focusedWindow(): BrowserWindow | null {
	return BrowserWindow.getFocusedWindow() ?? mainWindow;
}

function emitWindowState(win: BrowserWindow): void {
	win.webContents.send("desktop:windowState", { maximized: win.isMaximized() });
}

function lockNativeZoom(win: BrowserWindow): void {
	win.webContents.setZoomFactor(1);
	win.webContents.on("zoom-changed", (event) => {
		event.preventDefault();
		win.webContents.setZoomFactor(1);
	});
	win.webContents.on("did-finish-load", () => win.webContents.setZoomFactor(1));
}

function createMainWindow(): BrowserWindow {
	if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;

	mainWindow = new BrowserWindow({
		width: 1200,
		height: 800,
		minWidth: 800,
		minHeight: 600,
		show: false,
		frame: usesNativeWindowFrame(),
		title: "Signet",
		backgroundColor: "#0f0f0f",
		webPreferences: {
			preload: preloadPath(),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
		},
	});
	lockNativeZoom(mainWindow);

	mainWindow.webContents.setWindowOpenHandler(({ url }) => {
		if (url.startsWith("http://") || url.startsWith("https://")) {
			shell.openExternal(url).catch(() => undefined);
		}
		return { action: "deny" };
	});

	mainWindow.once("ready-to-show", () => mainWindow?.show());
	mainWindow.on("maximize", () => mainWindow && emitWindowState(mainWindow));
	mainWindow.on("unmaximize", () => mainWindow && emitWindowState(mainWindow));
	mainWindow.on("close", (event) => {
		if (quitting) return;
		event.preventDefault();
		mainWindow?.hide();
	});
	mainWindow.on("closed", () => {
		mainWindow = null;
	});

	return mainWindow;
}

function showDashboard(): void {
	void showDashboardReady();
}

async function showDashboardReady(): Promise<void> {
	await prepareDaemonForDashboard();
	const win = createMainWindow();
	loadMainWindow(win);
	if (win.isMinimized()) win.restore();
	win.show();
	win.focus();
}

async function prepareDaemonForDashboard(): Promise<void> {
	try {
		await daemon.ensureStarted();
		daemonStartupError = null;
	} catch (err) {
		daemonStartupError = errorMessage(err);
		console.error(err);
	}
}

async function assertDaemonUsable(): Promise<void> {
	try {
		await daemon.ensureStarted();
		daemonStartupError = null;
	} catch (err) {
		daemonStartupError = errorMessage(err);
		throw err;
	}
}

function loadMainWindow(win: BrowserWindow): void {
	const url = daemonStartupError ? startupErrorUrl(daemonStartupError) : "app://signet/";
	if (loadedMainWindowUrl === url) return;
	loadedMainWindowUrl = url;
	win.loadURL(url).catch((err) => {
		console.error(daemonStartupError ? "Failed to load startup error" : "Failed to load dashboard", err);
	});
}

function startupErrorUrl(message: string): string {
	return `data:text/html;charset=utf-8,${encodeURIComponent(startupErrorHtml(message))}`;
}

function startupErrorHtml(message: string): string {
	const safeMessage = escapeHtml(message);
	const safeWorkspace = escapeHtml(workspace.path);
	return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Signet daemon blocked</title>
<style>
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0f0f0f; color: #f2f2f2; font: 14px ui-monospace, SFMono-Regular, Menlo, monospace; }
main { max-width: 720px; padding: 40px; border: 1px solid #333; background: #151515; box-shadow: 0 24px 80px rgba(0,0,0,.45); }
h1 { margin: 0 0 16px; font-size: 22px; letter-spacing: .08em; text-transform: uppercase; }
p { line-height: 1.6; color: #cfcfcf; }
code { color: #b7ff00; word-break: break-all; }
.error { color: #ff8f8f; white-space: pre-wrap; }
</style>
</head>
<body>
<main>
<h1>Daemon workspace mismatch</h1>
<p>Signet blocked the dashboard because the daemon on the configured port is not confirmed to be using this desktop workspace.</p>
<p>Expected workspace: <code>${safeWorkspace}</code></p>
<p class="error">${safeMessage}</p>
<p>Stop the other daemon or restart it with the configured workspace, then reopen Signet.</p>
</main>
</body>
</html>`;
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

async function quickCapture(content: string): Promise<void> {
	const trimmed = content.trim();
	if (!trimmed) throw new Error("content is required");
	await assertDaemonUsable();
	const response = await fetch(`${daemon.baseUrl}/api/memory/remember`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ content: trimmed, who: "desktop-capture", importance: 0.7 }),
	});
	if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
}

async function searchMemories(query: string, limit?: number): Promise<string> {
	const trimmed = query.trim();
	if (!trimmed) throw new Error("query is required");
	await assertDaemonUsable();
	const response = await fetch(`${daemon.baseUrl}/api/memory/recall`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ query: trimmed, limit: limit ?? 10 }),
	});
	if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
	return response.text();
}

async function pickDirectory(options?: { title?: string }): Promise<string | null> {
	const win = focusedWindow();
	const dialogOptions: OpenDialogOptions = {
		title: options?.title ?? "Choose folder",
		properties: ["openDirectory"],
	};
	const result = win ? await dialog.showOpenDialog(win, dialogOptions) : await dialog.showOpenDialog(dialogOptions);
	return result.canceled ? null : (result.filePaths[0] ?? null);
}

function registerIpc(): void {
	ipcMain.handle("desktop:minimize", () => focusedWindow()?.minimize());
	ipcMain.handle("desktop:toggleMaximize", () => {
		const win = focusedWindow();
		if (!win) return;
		if (win.isMaximized()) win.unmaximize();
		else win.maximize();
		emitWindowState(win);
	});
	ipcMain.handle("desktop:close", () => focusedWindow()?.close());
	ipcMain.handle("desktop:isMaximized", () => focusedWindow()?.isMaximized() ?? false);
	ipcMain.handle("desktop:startDaemon", async () => {
		const status = await daemon.start();
		daemonStartupError = null;
		return status;
	});
	ipcMain.handle("desktop:stopDaemon", () => daemon.stop());
	ipcMain.handle("desktop:restartDaemon", async () => {
		const status = await daemon.restart();
		daemonStartupError = null;
		return status;
	});
	ipcMain.handle("desktop:getDaemonStatus", () => daemon.status());
	ipcMain.handle("desktop:openDashboard", () => showDashboard());
	ipcMain.handle("desktop:quickCapture", (_event, content: string) => quickCapture(content));
	ipcMain.handle("desktop:searchMemories", (_event, query: string, limit?: number) => searchMemories(query, limit));
	ipcMain.handle("desktop:pickDirectory", (_event, options?: { title?: string }) => pickDirectory(options));
	ipcMain.handle("desktop:checkForUpdate", () => null);
	ipcMain.handle("desktop:quit", () => app.quit());
}

enableGpuRendering();

protocol.registerSchemesAsPrivileged([
	{ scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

app.setName("Signet");

app.whenReady().then(async () => {
	Menu.setApplicationMenu(null);
	await registerDashboardProtocol();
	registerIpc();
	tray = new DesktopTray(daemon, showDashboard);
	tray.start();
	showDashboard();

	app.on("activate", () => showDashboard());
});

app.on("before-quit", () => {
	quitting = true;
});

app.on("will-quit", () => {
	tray?.stop();
	daemon.shutdownOwned();
});

app.on("window-all-closed", () => {
	// Keep the desktop app resident in the tray/menu bar.
});

import { readFile, stat } from "node:fs/promises";
import { extname, normalize, relative, sep } from "node:path";
import { BrowserWindow, Menu, app, ipcMain, protocol, shell } from "electron";
import { DaemonManager } from "./daemon-manager.js";
import { dashboardRoot, preloadPath } from "./paths.js";
import { DesktopTray } from "./tray.js";

const daemon = new DaemonManager();
let mainWindow: BrowserWindow | null = null;
let tray: DesktopTray | null = null;
let quitting = false;

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

async function registerDashboardProtocol(): Promise<void> {
	protocol.handle("app", async (request) => {
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

	mainWindow.loadURL("app://signet/").catch((err) => {
		console.error("Failed to load dashboard", err);
	});
	return mainWindow;
}

function showDashboard(): void {
	const win = createMainWindow();
	if (win.isMinimized()) win.restore();
	win.show();
	win.focus();
}

async function quickCapture(content: string): Promise<void> {
	const trimmed = content.trim();
	if (!trimmed) throw new Error("content is required");
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
	const response = await fetch(`${daemon.baseUrl}/api/memory/recall`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ query: trimmed, limit: limit ?? 10 }),
	});
	if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
	return response.text();
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
	ipcMain.handle("desktop:startDaemon", () => daemon.start());
	ipcMain.handle("desktop:stopDaemon", () => daemon.stop());
	ipcMain.handle("desktop:restartDaemon", () => daemon.restart());
	ipcMain.handle("desktop:getDaemonStatus", () => daemon.status());
	ipcMain.handle("desktop:openDashboard", () => showDashboard());
	ipcMain.handle("desktop:quickCapture", (_event, content: string) => quickCapture(content));
	ipcMain.handle("desktop:searchMemories", (_event, query: string, limit?: number) => searchMemories(query, limit));
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
	try {
		await daemon.ensureStarted();
	} catch (err) {
		console.error(err);
	}
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

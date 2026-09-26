import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveWorkspaceLayout, spawnHidden } from "@signet/core";
import {
	net,
	BrowserWindow,
	Menu,
	type IpcMainInvokeEvent,
	type OpenDialogOptions,
	app,
	dialog,
	ipcMain,
	nativeTheme,
	protocol,
	shell,
} from "electron";
import { DaemonManager } from "./daemon-manager.js";
import { checkForDesktopUpdate, configureDesktopUpdates } from "./desktop-updates.js";
import { validateExternalUrl } from "./external-url.js";
import {
	bunPath,
	daemonEntry,
	daemonRoot,
	dashboardRoot,
	iconPath,
	migrationRunnerEntry,
	preloadPath,
} from "./paths.js";
import { WorkspaceMigrationService, isTrustedMigrationDashboardUrl } from "./workspace-migration.js";
import { daemonRouteTarget, isDaemonRouteUrl } from "./protocol-routes.js";
import { DesktopTray } from "./tray.js";
import { applyDesktopWorkspaceEnv, resolveDesktopWorkspace } from "./workspace.js";
import { applicationMenuTemplate } from "./application-menu.js";
import { installSingleInstanceLock } from "./single-instance.js";

const hasSingleInstanceLock = installSingleInstanceLock(
	{
		requestSingleInstanceLock: () => app.requestSingleInstanceLock(),
		quit: () => app.quit(),
		onSecondInstance: (listener) => {
			app.on("second-instance", listener);
		},
	},
	showDashboard,
);

const workspace = applyDesktopWorkspaceEnv(resolveDesktopWorkspace());
const daemon = new DaemonManager({ workspacePath: workspace.path });
const workspaceMigration = new WorkspaceMigrationService({
	workspace,
	appVersion: app.getVersion(),
	layoutVersion: (workspacePath) => resolveWorkspaceLayout(workspacePath).version,
	daemonStatus: async () => {
		const status = await daemon.status();
		return { running: status.running, owned: status.owned, workspacePath: status.workspacePath };
	},
	ensureDaemon: () => daemon.ensureStarted(),
	runWorker: runWorkspaceMigrationWorker,
	configuredWorkspacePath,
	relaunch: relaunchForWorkspace,
});
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

function windowTitleBarStyle(): "hidden" | "hiddenInset" | undefined {
	if (usesNativeWindowFrame()) return undefined;
	if (process.platform === "darwin") return "hiddenInset";
	if (process.platform === "win32" || process.platform === "linux") return "hidden";
	return undefined;
}

type WindowTheme = "light" | "dark";

const TITLE_BAR_OVERLAY_PALETTE: Record<WindowTheme, Electron.TitleBarOverlay> = {
	light: { color: "#f2f5f7", symbolColor: "#27313a", height: 56 },
	dark: { color: "#0f1215", symbolColor: "#d6dbe1", height: 56 },
};

function titleBarOverlayForTheme(theme: WindowTheme): Electron.TitleBarOverlay {
	return TITLE_BAR_OVERLAY_PALETTE[theme];
}

function windowTitleBarOverlay(): Electron.TitleBarOverlay | undefined {
	if (usesNativeWindowFrame()) return undefined;
	if (process.platform === "win32" || process.platform === "linux") {
		return titleBarOverlayForTheme(nativeTheme.shouldUseDarkColors ? "dark" : "light");
	}
	return undefined;
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
		const response = await net.fetch(pathToFileURL(file).toString());
		return new Response(response.body, {
			headers: { "content-type": MIME[extname(file)] ?? "application/octet-stream" },
			status: response.status,
			statusText: response.statusText,
		});
	});
}

function focusedWindow(): BrowserWindow | null {
	return BrowserWindow.getFocusedWindow() ?? mainWindow;
}

function lockNativeZoom(win: BrowserWindow): void {
	win.webContents.setZoomFactor(1);
	win.webContents.on("zoom-changed", (event) => {
		event.preventDefault();
		win.webContents.setZoomFactor(1);
	});
	win.webContents.on("did-finish-load", () => win.webContents.setZoomFactor(1));
}

function setWindowTheme(theme: WindowTheme): void {
	if (!mainWindow || mainWindow.isDestroyed()) return;
	if (usesNativeWindowFrame()) return;
	if (process.platform !== "win32" && process.platform !== "linux") return;
	mainWindow.setTitleBarOverlay(titleBarOverlayForTheme(theme));
}

function createMainWindow(): BrowserWindow {
	if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;

	mainWindow = new BrowserWindow({
		width: 1200,
		height: 800,
		minWidth: 800,
		minHeight: 600,
		show: true,
		frame: true,
		titleBarStyle: windowTitleBarStyle(),
		titleBarOverlay: windowTitleBarOverlay(),
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

	mainWindow.on("close", (event) => {
		if (quitting) return;
		event.preventDefault();
		mainWindow?.hide();
	});
	mainWindow.on("closed", () => {
		mainWindow = null;
		loadedMainWindowUrl = null;
	});

	return mainWindow;
}

function showDashboard(): void {
	void showDashboardReady();
}

async function showDashboardReady(): Promise<void> {
	const win = createMainWindow();
	loadStartupWindow(win);
	if (win.isMinimized()) win.restore();
	win.show();
	win.focus();
	await prepareDaemonForDashboard();
	loadMainWindow(win);
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

function loadStartupWindow(win: BrowserWindow): void {
	if (loadedMainWindowUrl) return;
	const url = `data:text/html;charset=utf-8,${encodeURIComponent(startupLoadingHtml())}`;
	loadedMainWindowUrl = url;
	win.loadURL(url).catch((err) => {
		console.error("Failed to load startup window", err);
	});
}

function startupLoadingHtml(): string {
	return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Signet</title>
<style>
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0f0f0f; color: #f2f2f2; font: 14px ui-monospace, SFMono-Regular, Menlo, monospace; }
main { display: grid; gap: 18px; justify-items: center; }
.mark { width: 84px; height: 84px; border-radius: 24px; background: #151515; display: grid; place-items: center; box-shadow: 0 24px 80px rgba(0,0,0,.45); }
.dot { width: 10px; height: 10px; border-radius: 999px; background: #fff; box-shadow: 20px 0 #fff, 40px 0 #fff, 0 20px #fff, 20px 20px #fff, 40px 20px #fff; }
p { margin: 0; color: #cfcfcf; }
</style>
</head>
<body>
<main>
<div class="mark"><div class="dot"></div></div>
<p>Starting Signet...</p>
</main>
</body>
</html>`;
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
<h1>Signet daemon blocked</h1>
<p>Signet could not start the local daemon, so the dashboard is unavailable.</p>
<p>Expected workspace: <code>${safeWorkspace}</code></p>
<p class="error">${safeMessage}</p>
<p>Follow the corrective action above, then reopen Signet. If another daemon is using the configured port, stop it or restart it with this workspace.</p>
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

function configuredWorkspacePath(): string {
	const env = { ...process.env };
	delete env.SIGNET_PATH;
	delete env.SIGNET_WORKSPACE;
	return resolveDesktopWorkspace(env).path;
}

function relaunchForWorkspace(workspacePath: string): void {
	const target = resolve(workspacePath);
	process.env.SIGNET_PATH = target;
	process.env.SIGNET_WORKSPACE = target;
	setTimeout(() => {
		app.relaunch();
		app.quit();
	}, 1000);
}

async function runWorkspaceMigrationWorker(
	action: "status" | "run" | "rollback",
	workspacePath: string,
): Promise<unknown> {
	const runner = migrationRunnerEntry();
	if (!existsSync(runner)) throw new Error("Workspace migration helper is not staged");
	const root = daemonRoot();
	const child = spawnHidden(bunPath(), [runner, action, "--source", workspacePath], {
		cwd: root,
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			...process.env,
			SIGNET_PATH: workspacePath,
			SIGNET_WORKSPACE: workspacePath,
			SIGNET_PORT: String(daemon.port),
			SIGNET_DAEMON_URL: daemon.baseUrl,
			SIGNET_DAEMON_RUNTIME: "bun-js",
			SIGNET_DAEMON_JS_PATH: daemonEntry(),
			SIGNET_TIKTOKEN_WASM_PATH: join(root, "node_modules", "tiktoken", "tiktoken_bg.wasm"),
			SIGNET_CONNECTOR_ASSETS_DIR: process.env.SIGNET_CONNECTOR_ASSETS_DIR ?? join(root, "connectors"),
			SIGNET_DESKTOP: "1",
			SIGNET_TELEMETRY_OPTOUT: "1",
			SIGNET_ANALYTICS_DISABLED: "1",
		},
	});
	let output = "";
	child.stdout?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string | Buffer) => {
		output += String(chunk);
	});
	child.stderr?.resume();
	return await new Promise((resolveResult, rejectResult) => {
		child.once("error", () => rejectResult(new Error("Workspace migration helper could not start")));
		child.once("close", (code: number | null) => {
			if (code !== 0) {
				rejectResult(new Error("Workspace migration helper failed"));
				return;
			}
			for (const line of output.split(/\r?\n/).reverse()) {
				if (!line.trim()) continue;
				try {
					const result: unknown = JSON.parse(line);
					if (result && typeof result === "object" && !Array.isArray(result)) {
						resolveResult(result);
						return;
					}
				} catch {}
			}
			rejectResult(new Error("Workspace migration helper returned invalid output"));
		});
	});
}

function configureApplicationMenu(): void {
	const template = applicationMenuTemplate(process.platform);
	Menu.setApplicationMenu(template === null ? null : Menu.buildFromTemplate(template));
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

function assertTrustedMigrationIpc(event: IpcMainInvokeEvent): void {
	if (event.sender !== mainWindow?.webContents || !isTrustedMigrationDashboardUrl(event.senderFrame?.url))
		throw new Error("Workspace migration is only available to the Signet desktop dashboard");
}

function registerIpc(): void {
	ipcMain.handle("desktop:getWorkspaceMigrationStatus", async (event) => {
		assertTrustedMigrationIpc(event);
		return workspaceMigration.status();
	});
	ipcMain.handle("desktop:startWorkspaceMigration", async (event) => {
		assertTrustedMigrationIpc(event);
		return workspaceMigration.run();
	});
	ipcMain.handle("desktop:rollbackWorkspaceMigration", async (event) => {
		assertTrustedMigrationIpc(event);
		return workspaceMigration.rollback();
	});
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
	ipcMain.handle("desktop:setTitleBarTheme", (_event, theme: unknown) => {
		if (theme !== "light" && theme !== "dark") throw new Error("theme must be light or dark");
		setWindowTheme(theme);
	});
	ipcMain.handle("desktop:openDashboard", () => showDashboard());
	ipcMain.handle("desktop:quickCapture", (_event, content: string) => quickCapture(content));
	ipcMain.handle("desktop:searchMemories", (_event, query: string, limit?: number) => searchMemories(query, limit));
	ipcMain.handle("desktop:pickDirectory", (_event, options?: { title?: string }) => pickDirectory(options));
	ipcMain.handle("desktop:openExternal", (_event, url: string) => shell.openExternal(validateExternalUrl(url)));
	ipcMain.handle("desktop:checkForUpdate", () => checkForDesktopUpdate({ showNoUpdateDialog: true }));
	ipcMain.handle("desktop:quit", () => app.quit());
}

enableGpuRendering();

protocol.registerSchemesAsPrivileged([
	{ scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

app.setName("Signet");

app.whenReady().then(async () => {
	if (!hasSingleInstanceLock) return;
	configureApplicationMenu();
	if (process.platform === "darwin" && app.dock) {
		app.dock.setIcon(iconPath("icon.png"));
	}
	configureDesktopUpdates();
	await registerDashboardProtocol();
	registerIpc();
	tray = new DesktopTray(daemon, showDashboard, () => void checkForDesktopUpdate({ showNoUpdateDialog: true }));
	tray.start();
	showDashboard();
	setTimeout(() => void checkForDesktopUpdate(), 5000);

	app.on("activate", () => showDashboard());
});

app.on("before-quit", () => {
	quitting = true;
});

app.on("will-quit", () => {
	tray?.stop();
	daemon.shutdownOwned();
});

app.on("window-all-closed", () => {});

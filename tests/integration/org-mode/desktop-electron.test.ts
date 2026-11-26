import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { LoginStore } from "@signet/sdk/node";
import { OrgDaemon, repo, reservePort, terminateOwnedGroup } from "./daemon";
import { browser, record, request, success, text, until } from "./http";

class DesktopCdp {
	private next = 0;
	private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
	private constructor(private readonly socket: WebSocket) {
		socket.addEventListener("message", (event) => {
			const value: unknown = JSON.parse(String(event.data));
			const message = record(value);
			if (typeof message.id !== "number") return;
			const waiter = this.pending.get(message.id);
			this.pending.delete(message.id);
			if (message.error) waiter?.reject(new Error(JSON.stringify(message.error)));
			else waiter?.resolve(message.result);
		});
	}
	static async connect(url: string): Promise<DesktopCdp> {
		const socket = new WebSocket(url);
		await new Promise<void>((resolve, reject) => {
			socket.addEventListener("open", () => resolve(), { once: true });
			socket.addEventListener("error", () => reject(new Error("Desktop CDP failed to connect")), { once: true });
		});
		return new DesktopCdp(socket);
	}
	async call(method: string, params: object): Promise<Record<string, unknown>> {
		const id = ++this.next;
		const response = new Promise<unknown>((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
		});
		this.socket.send(JSON.stringify({ id, method, params }));
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return record(
				await Promise.race([
					response,
					new Promise<never>((_resolve, reject) => {
						timer = setTimeout(() => reject(new Error(`Desktop CDP deadline: ${method}`)), 15_000);
					}),
				]),
			);
		} finally {
			clearTimeout(timer);
			this.pending.delete(id);
		}
	}
	async evaluate(expression: string): Promise<unknown> {
		const result = await this.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
		if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
		return record(result.result).value;
	}
	async screenshot(path: string): Promise<void> {
		await this.call("Emulation.setDeviceMetricsOverride", {
			width: 1440,
			height: 900,
			deviceScaleFactor: 1,
			mobile: false,
		});
		const result = await this.call("Page.captureScreenshot", { format: "png" });
		await writeFile(path, Buffer.from(text(result.data), "base64"));
	}
	close(): void {
		this.socket.close();
	}
}

test.skipIf(process.platform !== "linux" || !process.env.SIGNET_ELECTRON_TEST_EXECUTABLE)(
	"real Electron main process uses remote IPC and bearer proxy without creating a local workspace",
	async () => {
		const executable = process.env.SIGNET_ELECTRON_TEST_EXECUTABLE;
		if (!executable) throw new Error("Set SIGNET_ELECTRON_TEST_EXECUTABLE");
		const temporaryRoot = process.env.SIGNET_ELECTRON_TMPDIR;
		if (!temporaryRoot || temporaryRoot.length > 70)
			throw new Error("Set SIGNET_ELECTRON_TMPDIR to a short disposable scratch directory for Chromium sockets");
		const runtime = await mkdtemp(join(temporaryRoot, "e-"));
		const daemon = await OrgDaemon.create().catch(async (error: unknown) => {
			await rm(runtime, { recursive: true, force: true });
			throw error;
		});
		let electron: ReturnType<typeof Bun.spawn> | null = null;
		let cdp: DesktopCdp | null = null;
		try {
			const claim = await request(daemon.origin, "/api/org/claim", {}, "POST", {
				setupToken: await daemon.setupToken(),
				organizationName: "Desktop Fixture",
				admin: { username: "alice", displayName: "Alice", password: "disposable electron password" },
			});
			success(claim, "Claim Electron fixture");
			const home = join(daemon.root, "desktop-home");
			const profile = join(home, "profile");
			const local = join(home, "must-not-exist");
			await mkdir(profile, { recursive: true });
			await writeFile(
				join(profile, "workspace-selection.json"),
				JSON.stringify({ mode: "organization", origin: daemon.origin }),
			);
			const opened = join(daemon.root, "browser-url.txt");
			const bootstrap = join(daemon.root, "desktop-bootstrap.mjs");
			await writeFile(
				bootstrap,
				`import {createRequire} from 'node:module'; import {writeFile} from 'node:fs/promises'; const require=createRequire(${JSON.stringify(join(repo, "surfaces/desktop/package.json"))}); const {app,shell}=require('electron'); process.on('uncaughtException',error=>{console.error(error);app.exit(1)}); process.on('unhandledRejection',error=>{console.error(error);app.exit(1)}); app.setPath('userData',${JSON.stringify(profile)}); shell.openExternal=async url=>{await writeFile(${JSON.stringify(opened)},url)}; await import(${JSON.stringify(pathToFileURL(join(repo, "surfaces/desktop/dist/main.js")).href)}).catch(error=>{console.error(error);app.exit(1)});`,
			);
			const port = await reservePort();
			electron = Bun.spawn(
				[
					"setsid",
					"xvfb-run",
					"-a",
					executable,
					bootstrap,
					"--no-sandbox",
					"--disable-gpu",
					`--remote-debugging-port=${port}`,
					"--remote-debugging-address=127.0.0.1",
				],
				{
					cwd: join(repo, "surfaces/desktop"),
					env: {
						...daemon.env,
						TMPDIR: runtime,
						TMP: runtime,
						TEMP: runtime,
						XDG_RUNTIME_DIR: runtime,
						HOME: home,
						XDG_CONFIG_HOME: join(home, ".config"),
						SIGNET_PATH: local,
						SIGNET_WORKSPACE: local,
						SIGNET_PORT: String(await reservePort()),
						DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(runtime, "no-keyring")}`,
						SIGNET_DESKTOP_DISABLE_GPU: "1",
					},
					stdout: "ignore",
					stderr: Bun.file(join(daemon.root, "electron.log")),
				},
			);
			let websocket: string | null = null;
			await until(
				async () => {
					if (electron?.exitCode !== null) throw new Error("Electron exited before opening its window");
					try {
						const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) });
						const pages: unknown = await response.json();
						if (!Array.isArray(pages)) return false;
						for (const value of pages) {
							const page = record(value);
							if (page.url === "app://signet/desktop/workspaces") websocket = text(page.webSocketDebuggerUrl);
						}
						return websocket !== null;
					} catch {
						return false;
					}
				},
				"Electron remote workspace window",
				30_000,
			);
			if (!websocket) throw new Error("No Electron page target");
			cdp = await DesktopCdp.connect(websocket);
			expect(await cdp.evaluate("window.signetDesktop.getWorkspace()")).toEqual({
				mode: "organization",
				origin: daemon.origin,
			});
			expect(await cdp.evaluate("window.signetDesktop.workspaceStatus()")).toMatchObject({ state: "signed-out" });
			expect(await cdp.evaluate("getComputedStyle(document.body).fontFamily")).toContain("Schibsted Grotesk");
			expect(
				await cdp.evaluate("Array.from(document.styleSheets).some(sheet=>sheet.href && sheet.cssRules.length>0)"),
			).toBe(true);
			expect(
				await cdp.evaluate("document.querySelector('[data-mode=organization]').getAttribute('aria-checked')"),
			).toBe("true");
			const screenDir = process.env.SIGNET_DESKTOP_SCREEN_DIR;
			if (screenDir) {
				await mkdir(screenDir, { recursive: true });
				await cdp.screenshot(join(screenDir, "workspace-switcher.png"));
			}
			const flow = record(await cdp.evaluate("window.signetDesktop.signIn()"));
			expect(JSON.stringify(flow)).not.toMatch(/accessToken|refreshToken|deviceCode/);
			expect(new URL(await readFile(opened, "utf8")).searchParams.get("user_code")).toBe(text(flow.userCode));
			success(
				await request(daemon.origin, "/api/auth/device/approve", browser(claim), "POST", {
					userCode: text(flow.userCode),
					decision: "approve",
				}),
				"Approve real desktop",
			);
			const page = cdp;
			await until(
				async () => record(await page.evaluate("window.signetDesktop.workspaceStatus()")).state === "signed-in",
				"Electron approved session",
			);

			expect(await cdp.evaluate("window.signetDesktop.startDaemon().then(()=>false,()=>true)")).toBe(true);

			const cli = new LoginStore(daemon.origin, {
				env: { HOME: home },
				keyring: {
					async get() {
						return { state: "unsupported" };
					},
					async set() {
						return { state: "unsupported" };
					},
				},
			});
			const saved = await cli.load();
			expect(saved).not.toBeNull();
			if (!saved) throw new Error("CLI cannot read desktop login");
			await until(
				async () => (await page.evaluate("document.getElementById('status').dataset.state")) === "signed-in",
				"Signed-in workspace rendered",
			);
			if (screenDir) await cdp.screenshot(join(screenDir, "signed-in-remote-workspace.png"));
			await cdp.evaluate("window.signetDesktop.openDashboard()");
			await until(async () => (await page.evaluate("location.href")) === "app://signet/", "Remote dashboard loaded");
			expect(
				await cdp.evaluate(
					"fetch('/api/auth/whoami').then(r=>r.json()).then(r=>({authenticated:r.authenticated,name:r.user.displayName}))",
				),
			).toEqual({ authenticated: true, name: "Alice" });
			expect(await cdp.evaluate("fetch('/api/auth/refresh',{method:'POST'}).then(r=>r.status)")).toBe(403);
			await until(
				async () => text(await page.evaluate("document.body.innerText")).length > 100,
				"Remote dashboard rendered",
			);
			if (screenDir) await cdp.screenshot(join(screenDir, "remote-dashboard-baseline.png"));
			await cdp.evaluate(
				"void fetch('/api/auth/logout',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}); true",
			);
			await until(
				async () => (await page.evaluate("location.href")) === "app://signet/desktop/workspaces",
				"Desktop logout returns to workspace selection",
			);
			expect(await cdp.evaluate("window.signetDesktop.workspaceStatus()")).toMatchObject({ state: "signed-out" });
			expect(await cli.load()).toBeNull();
			expect(
				(await request(daemon.origin, "/api/auth/sessions", { bearer: saved.credential.accessToken })).status,
			).toBe(401);
			expect(
				(await request(daemon.origin, "/api/auth/refresh", {}, "POST", { refreshToken: saved.credential.refreshToken }))
					.status,
			).toBe(401);
			const workspace = await stat(local).then(
				() => true,
				() => false,
			);
			expect(workspace).toBe(false);
			const processList = Bun.spawn(["ps", "-eo", "pgid=,args="], { stdout: "pipe" });
			const processes = await new Response(processList.stdout).text();
			expect(await processList.exited).toBe(0);
			const own = processes.split("\n").filter((line) => line.trim().startsWith(`${electron?.pid} `));
			expect(own.length).toBeGreaterThan(0);
			expect(own.some((line) => /daemon\.(?:ts|js)|db-owner-worker/.test(line))).toBe(false);
			console.log(
				JSON.stringify({
					probe: "real-electron-remote",
					bearerProxy: 200,
					localWorkspaceCreated: false,
					ownedDaemonProcesses: 0,
					revoked: true,
				}),
			);
		} catch (error) {
			console.error(error);
			console.error(await readFile(join(daemon.root, "electron.log"), "utf8"));
			if (electron) {
				const ps = Bun.spawn(["ps", "--sid", String(electron.pid), "-o", "pid=,ppid=,pgid=,args="], { stdout: "pipe" });
				console.error(await new Response(ps.stdout).text());
				await ps.exited;
			}
			throw error;
		} finally {
			try {
				try {
					if (cdp) await cdp.evaluate("setTimeout(()=>window.signetDesktop.quit(),50); true");
				} finally {
					cdp?.close();
					if (electron) {
						await Promise.race([electron.exited, Bun.sleep(3000)]);
						await terminateOwnedGroup(electron.pid);
					}
				}
			} finally {
				try {
					await daemon.dispose();
				} finally {
					await rm(runtime, { recursive: true, force: true });
				}
			}
		}
	},
	120_000,
);

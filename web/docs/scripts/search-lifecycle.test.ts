import { afterEach, describe, expect, it } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

type PendingCall = {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
};

type JsonRecord = Record<string, unknown>;

const DOCS_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PREVIEW_URL = "http://127.0.0.1";
let preview: ChildProcess | null = null;
let chrome: ChildProcess | null = null;
let client: DevToolsClient | null = null;
let profile: string | null = null;

function record(value: unknown): JsonRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Expected a JSON object");
	}
	return Object.fromEntries(Object.entries(value));
}

async function waitForPreviewPort(child: ChildProcess): Promise<number> {
	const output: string[] = [];
	child.stdout?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => output.push(chunk));
	for (let attempt = 0; attempt < 120; attempt += 1) {
		if (child.exitCode !== null) throw new Error(`Docs preview exited with code ${child.exitCode}`);
		const match = output.join("").match(/127\.0\.0\.1:(\d+)/);
		if (match?.[1]) return Number.parseInt(match[1], 10);
		await Bun.sleep(100);
	}
	throw new Error("Docs preview did not report a listening port");
}

async function waitForChromePort(profilePath: string, child: ChildProcess): Promise<number> {
	const marker = join(profilePath, "DevToolsActivePort");
	for (let attempt = 0; attempt < 120; attempt += 1) {
		if (child.exitCode !== null) throw new Error(`Chrome exited with code ${child.exitCode}`);
		try {
			const port = Number.parseInt(readFileSync(marker, "utf8").split("\\n", 1)[0] ?? "", 10);
			if (Number.isInteger(port) && port > 0) return port;
		} catch {
			// Chrome has not written its DevTools marker yet.
		}
		await Bun.sleep(100);
	}
	throw new Error("Chrome did not publish its DevTools port");
}

function findChrome(): string {
	const candidates = process.env.CHROME_BIN
		? [process.env.CHROME_BIN]
		: ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser"];
	for (const candidate of candidates) {
		const result = spawnSync(candidate, ["--version"], { stdio: "ignore" });
		if (result.status === 0) return candidate;
	}
	throw new Error("A Chromium browser is required; set CHROME_BIN to its executable path");
}

async function waitForHttp(url: string, child: ChildProcess, label: string): Promise<void> {
	for (let attempt = 0; attempt < 120; attempt += 1) {
		if (child.exitCode !== null) throw new Error(`${label} exited with code ${child.exitCode}`);
		try {
			const response = await fetch(url);
			if (response.ok) return;
		} catch {
			// The process is still starting.
		}
		await Bun.sleep(100);
	}
	throw new Error(`${label} did not become ready at ${url}`);
}

function targetWebSocket(value: unknown): string {
	if (!Array.isArray(value)) throw new Error("Chrome returned no targets");
	for (const item of value) {
		const target = record(item);
		if (target.type === "page" && typeof target.webSocketDebuggerUrl === "string") {
			return target.webSocketDebuggerUrl;
		}
	}
	throw new Error("Chrome returned no page target");
}

async function waitForChrome(port: number): Promise<string> {
	for (let attempt = 0; attempt < 120; attempt += 1) {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/json`);
			if (response.ok) return targetWebSocket(await response.json());
		} catch {
			// Chrome is still starting.
		}
		await Bun.sleep(100);
	}
	throw new Error(`Chrome DevTools did not become ready on port ${port}`);
}

class DevToolsClient {
	private readonly socket: WebSocket;
	private nextId = 1;
	private readonly pending = new Map<number, PendingCall>();

	constructor(url: string) {
		this.socket = new WebSocket(url);
		this.socket.addEventListener("message", (event) => this.handleMessage(event));
		this.socket.addEventListener("error", () => this.rejectPending(new Error("Chrome DevTools WebSocket failed")));
		this.socket.addEventListener("close", () => this.rejectPending(new Error("Chrome DevTools WebSocket closed")));
	}

	async connect(): Promise<void> {
		if (this.socket.readyState === WebSocket.OPEN) return;
		if (this.socket.readyState !== WebSocket.CONNECTING) throw new Error("Chrome DevTools WebSocket did not connect");
		await new Promise<void>((resolve, reject) => {
			const onOpen = () => {
				this.socket.removeEventListener("error", onError);
				resolve();
			};
			const onError = () => {
				this.socket.removeEventListener("open", onOpen);
				reject(new Error("Chrome DevTools WebSocket failed to connect"));
			};
			this.socket.addEventListener("open", onOpen, { once: true });
			this.socket.addEventListener("error", onError, { once: true });
		});
	}

	call(method: string, params: JsonRecord = {}): Promise<unknown> {
		const id = this.nextId;
		this.nextId += 1;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			try {
				this.socket.send(JSON.stringify({ id, method, params }));
			} catch (error) {
				this.pending.delete(id);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	close(): void {
		this.rejectPending(new Error("Chrome DevTools client closed"));
		this.socket.close();
	}

	private handleMessage(event: MessageEvent): void {
		if (typeof event.data !== "string") return;
		const message = record(JSON.parse(event.data));
		if (typeof message.id !== "number") return;
		const pending = this.pending.get(message.id);
		if (!pending) return;
		this.pending.delete(message.id);
		if (message.error !== undefined) {
			pending.reject(new Error(JSON.stringify(message.error)));
			return;
		}
		pending.resolve(message.result);
	}

	private rejectPending(error: Error): void {
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
	}
}

async function evaluate(expression: string): Promise<unknown> {
	if (!client) throw new Error("Chrome DevTools client is not connected");
	const response = record(
		await client.call("Runtime.evaluate", {
			expression,
			awaitPromise: true,
			returnByValue: true,
		}),
	);
	if (response.exceptionDetails !== undefined) throw new Error(JSON.stringify(response.exceptionDetails));
	return record(response.result).value;
}

async function waitForTrue(expression: string, label: string): Promise<void> {
	for (let attempt = 0; attempt < 150; attempt += 1) {
		try {
			if ((await evaluate(expression)) === true) return;
		} catch {
			// The page may be between document swaps.
		}
		await Bun.sleep(100);
	}
	throw new Error(`Timed out waiting for ${label}`);
}

async function pressShortcut(modifier: "Control" | "Meta"): Promise<void> {
	if (!client) throw new Error("Chrome DevTools client is not connected");
	const modifiers = modifier === "Control" ? 2 : 4;
	const code = modifier === "Control" ? "ControlLeft" : "MetaLeft";
	await client.call("Input.dispatchKeyEvent", { type: "keyDown", modifiers, key: modifier, code });
	await client.call("Input.dispatchKeyEvent", { type: "keyDown", modifiers, key: "k", code: "KeyK" });
	await client.call("Input.dispatchKeyEvent", { type: "keyUp", modifiers, key: "k", code: "KeyK" });
	await client.call("Input.dispatchKeyEvent", { type: "keyUp", modifiers: 0, key: modifier, code });
}

async function pressEscape(): Promise<void> {
	if (!client) throw new Error("Chrome DevTools client is not connected");
	await client.call("Input.dispatchKeyEvent", {
		type: "keyDown",
		key: "Escape",
		code: "Escape",
		windowsVirtualKeyCode: 27,
		nativeVirtualKeyCode: 27,
	});
	await client.call("Input.dispatchKeyEvent", {
		type: "keyUp",
		key: "Escape",
		code: "Escape",
		windowsVirtualKeyCode: 27,
		nativeVirtualKeyCode: 27,
	});
}

async function clickFirstResult(): Promise<void> {
	const value = await evaluate(`(() => {
		const link = document.querySelector("dialog .pagefind-ui__result-link");
		if (!link) return null;
		const rect = link.getBoundingClientRect();
		return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
	})()`);
	const box = record(value);
	if (typeof box.x !== "number" || typeof box.y !== "number") throw new Error("Search result has no clickable bounds");
	if (!client) throw new Error("Chrome DevTools client is not connected");
	await client.call("Input.dispatchMouseEvent", {
		type: "mousePressed",
		x: box.x,
		y: box.y,
		button: "left",
		clickCount: 1,
	});
	await client.call("Input.dispatchMouseEvent", {
		type: "mouseReleased",
		x: box.x,
		y: box.y,
		button: "left",
		clickCount: 1,
	});
}

afterEach(() => {
	client?.close();
	client = null;
	if (chrome && chrome.exitCode === null) chrome.kill();
	chrome = null;
	if (preview && preview.exitCode === null) preview.kill();
	preview = null;
	if (profile) rmSync(profile, { recursive: true, force: true });
	profile = null;
});

describe("docs search lifecycle", () => {
	it("keeps Ctrl+K and Cmd+K search usable after client navigation", async () => {
		const chromePath = findChrome();
		if (!existsSync(join(DOCS_ROOT, "dist", "index.html"))) {
			throw new Error("Build web/docs before running the browser regression");
		}

		const previewProcess = spawn(process.execPath, ["run", "preview", "--", "--host", "127.0.0.1", "--port", "0"], {
			cwd: DOCS_ROOT,
			stdio: ["ignore", "pipe", "ignore"],
		});
		preview = previewProcess;
		const previewPort = await waitForPreviewPort(previewProcess);
		const baseUrl = `${PREVIEW_URL}:${previewPort}`;
		await waitForHttp(`${baseUrl}/quickstart/`, previewProcess, "Docs preview");

		profile = mkdtempSync(join(tmpdir(), "signet-docs-search-"));
		chrome = spawn(
			chromePath,
			[
				"--headless=new",
				"--no-sandbox",
				"--disable-gpu",
				"--disable-dev-shm-usage",
				"--no-first-run",
				"--no-default-browser-check",
				"--remote-debugging-address=127.0.0.1",
				"--remote-debugging-port=0",
				`--user-data-dir=${profile}`,
				"about:blank",
			],
			{ stdio: "ignore" },
		);
		const chromePort = await waitForChromePort(profile, chrome);
		client = new DevToolsClient(await waitForChrome(chromePort));
		await client.connect();
		await client.call("Page.enable");
		await client.call("Runtime.enable");
		await client.call("Page.navigate", { url: `${baseUrl}/quickstart/` });
		await waitForTrue("document.querySelector('#starlight__search input') !== null", "the initial Pagefind UI");

		await evaluate("document.querySelector(\"a[href='/daemon/']\")?.click(); true");
		await waitForTrue(
			"location.pathname === '/daemon/' && document.querySelector('#starlight__search input') !== null",
			"the persisted search UI after client navigation",
		);

		await pressShortcut("Control");
		await waitForTrue(
			"document.querySelector('dialog')?.open === true && document.activeElement?.matches('dialog input') === true",
			"Ctrl+K focus",
		);
		await client.call("Input.insertText", { text: "daemon" });
		await waitForTrue("document.querySelectorAll('dialog .pagefind-ui__result-link').length > 0", "Pagefind results");
		expect(
			await evaluate("document.querySelector('dialog .pagefind-ui__result-link')?.textContent?.trim().length > 0"),
		).toBe(true);

		await pressEscape();
		await waitForTrue("document.querySelector('dialog')?.open === false", "Escape dismissal");
		await pressShortcut("Meta");
		await waitForTrue(
			"document.querySelector('dialog')?.open === true && document.activeElement?.matches('dialog input') === true",
			"Cmd+K focus",
		);
		await client.call("Input.insertText", { text: "daemon" });
		await waitForTrue(
			"document.querySelectorAll('dialog .pagefind-ui__result-link').length > 0",
			"results after Cmd+K",
		);
		await clickFirstResult();
		await waitForTrue("location.pathname === '/cli/profiling/'", "result navigation");
		await waitForTrue("document.querySelector('dialog')?.open !== true", "result modal teardown");
		expect(await evaluate("document.querySelector('dialog')?.open !== true")).toBe(true);
	});
});

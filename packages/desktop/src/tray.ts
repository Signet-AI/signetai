import { type DaemonState, type RecentMemory, type TrayUpdate, buildTrayUpdate } from "@signet/tray";
import { BrowserWindow, Menu, type MenuItemConstructorOptions, Tray, app, nativeImage } from "electron";
import type { DaemonManager } from "./daemon-manager.js";
import { iconPath, preloadPath } from "./paths.js";

interface MemoryResponse {
	readonly memories?: readonly Record<string, unknown>[];
	readonly stats?: {
		readonly total?: number;
		readonly withEmbeddings?: number;
		readonly critical?: number;
	};
}

interface DiagnosticsResponse {
	readonly composite?: {
		readonly score?: number;
		readonly status?: string;
	};
	readonly queue?: {
		readonly depth?: number;
	};
}

interface EmbeddingResponse {
	readonly provider?: string;
	readonly model?: string;
	readonly available?: boolean;
}

interface SnapshotState {
	version: string;
	pid: number;
	uptime: number;
	healthScore: number | null;
	healthStatus: string | null;
	memoryCount: number | null;
	memoriesWithEmbeddings: number | null;
	criticalMemories: number | null;
	memoriesToday: number | null;
	embeddingProvider: string | null;
	embeddingModel: string | null;
	embeddingAvailable: boolean | null;
	queueDepth: number | null;
	recentMemories: readonly RecentMemory[];
	ingestionRate: number | null;
}

function numberOrNull(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function boolOrNull(value: unknown): boolean | null {
	return typeof value === "boolean" ? value : null;
}

function formatCount(value: number): string {
	return new Intl.NumberFormat("en-US").format(value);
}

function countToday(memories: readonly RecentMemory[]): number {
	const midnight = new Date();
	midnight.setHours(0, 0, 0, 0);
	const start = midnight.getTime();
	return memories.filter((memory) => new Date(memory.created_at).getTime() >= start).length;
}

function shorten(text: string, max = 64): string {
	const clean = text.replace(/\s+/g, " ").trim();
	return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

async function json<T>(url: string, timeoutMs: number): Promise<T | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(url, { signal: controller.signal });
		if (!response.ok) return null;
		return (await response.json()) as T;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

function iconFor(update: TrayUpdate): Electron.NativeImage {
	const name =
		update.kind === "running"
			? "signet-running.png"
			: update.kind === "error"
				? "signet-error.png"
				: "signet-stopped.png";
	const image = nativeImage.createFromPath(iconPath(name));
	if (process.platform === "darwin") image.setTemplateImage(true);
	return image;
}

function recentMenu(memories: readonly RecentMemory[]): MenuItemConstructorOptions[] {
	if (memories.length === 0) return [{ label: "No recent memories", enabled: false }];
	return memories.slice(0, 5).map((memory) => ({
		label: shorten(memory.content),
		subLabel: memory.who,
		enabled: false,
	}));
}

export class DesktopTray {
	readonly #daemon: DaemonManager;
	readonly #openDashboard: () => void;
	#tray: Tray | null = null;
	#lastJson = "";
	#timer: NodeJS.Timeout | null = null;
	#snapshot: SnapshotState | null = null;
	#lastMemoryCount: number | null = null;
	#lastMemoryCountTime: number | null = null;
	#ingestionRate: number | null = null;
	#polling = false;
	#pollAgain = false;

	constructor(daemon: DaemonManager, openDashboard: () => void) {
		this.#daemon = daemon;
		this.#openDashboard = openDashboard;
	}

	start(): void {
		this.#tray = new Tray(iconFor({ kind: "stopped" }));
		this.#tray.setToolTip("Signet — Starting");
		this.#tray.on("click", () => this.#openDashboard());
		void this.poll();
	}

	stop(): void {
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = null;
		this.#pollAgain = false;
		this.#tray?.destroy();
		this.#tray = null;
	}

	async poll(): Promise<void> {
		if (this.#polling) {
			this.#pollAgain = true;
			return;
		}
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = null;
		this.#polling = true;
		let delay = 2000;
		try {
			const state = await this.#state();
			this.apply(buildTrayUpdate(state));
			delay = state.kind === "running" ? 5000 : 2000;
		} finally {
			this.#polling = false;
			if (this.#tray) {
				const nextDelay = this.#pollAgain ? 0 : delay;
				this.#pollAgain = false;
				this.#timer = setTimeout(() => void this.poll(), nextDelay);
			}
		}
	}

	apply(update: TrayUpdate): void {
		if (!this.#tray) return;
		const jsonText = JSON.stringify(update);
		if (jsonText === this.#lastJson) return;
		this.#lastJson = jsonText;

		this.#tray.setImage(iconFor(update));
		this.#tray.setToolTip(
			update.kind === "running"
				? `Signet v${update.version ?? "unknown"} — Running`
				: update.kind === "error"
					? `Signet — Error: ${update.message ?? "unknown"}`
					: "Signet — Stopped",
		);
		if (process.platform === "darwin") {
			this.#tray.setTitle(
				update.kind === "running" && typeof update.memory_count === "number" ? formatCount(update.memory_count) : "",
			);
		}
		this.#tray.setContextMenu(Menu.buildFromTemplate(this.#menu(update)));
	}

	#menu(update: TrayUpdate): MenuItemConstructorOptions[] {
		const running = update.kind === "running";
		return [
			{ label: running ? `Signet v${update.version ?? "unknown"}` : "Signet", enabled: false },
			...(running
				? [
						{ label: `Memories: ${formatCount(update.memory_count ?? 0)}`, enabled: false },
						{ label: `Health: ${update.health_status ?? "unknown"}`, enabled: false },
					]
				: update.kind === "error"
					? [{ label: update.message ?? "Daemon error", enabled: false }]
					: [{ label: "Daemon stopped", enabled: false }]),
			{ type: "separator" },
			{ label: "Open Dashboard", click: this.#openDashboard },
			{ label: "Quick Capture…", enabled: running, click: () => this.#openUtilityWindow("capture") },
			{ label: "Search Memories…", enabled: running, click: () => this.#openUtilityWindow("search") },
			{ type: "separator" },
			{ label: "Recent Memories", submenu: recentMenu(this.#snapshot?.recentMemories ?? []) },
			{ type: "separator" },
			{ label: "Start Daemon", enabled: !running, click: () => void this.#daemon.start().then(() => this.poll()) },
			{ label: "Restart Daemon", enabled: running, click: () => void this.#daemon.restart().then(() => this.poll()) },
			{ label: "Stop Daemon", enabled: running, click: () => void this.#daemon.stop().then(() => this.poll()) },
			{ type: "separator" },
			{ label: "Quit Signet", click: () => app.quit() },
		];
	}

	async #state(): Promise<DaemonState> {
		const health = await this.#daemon.probe();
		if (!health) {
			this.#snapshot = null;
			return { kind: "stopped" };
		}

		const [memories, diagnostics, embeddings] = await Promise.all([
			json<MemoryResponse>(`${this.#daemon.baseUrl}/api/memories?limit=10`, 5000),
			json<DiagnosticsResponse>(`${this.#daemon.baseUrl}/api/diagnostics`, 5000),
			json<EmbeddingResponse>(`${this.#daemon.baseUrl}/api/embeddings/status`, 5000),
		]);

		const recent = (memories?.memories ?? []).map(
			(memory): RecentMemory => ({
				id: stringOrNull(memory.id) ?? "",
				content: stringOrNull(memory.content) ?? "",
				created_at: stringOrNull(memory.created_at) ?? "",
				who: stringOrNull(memory.who) ?? "unknown",
				importance: numberOrNull(memory.importance) ?? 0,
			}),
		);
		const count = memories?.stats?.total ?? null;
		this.#updateIngestionRate(count);

		this.#snapshot = {
			version: health.version,
			pid: health.pid,
			uptime: health.uptime,
			healthScore: diagnostics?.composite?.score ?? null,
			healthStatus: diagnostics?.composite?.status ?? null,
			memoryCount: count,
			memoriesWithEmbeddings: memories?.stats?.withEmbeddings ?? null,
			criticalMemories: memories?.stats?.critical ?? null,
			memoriesToday: countToday(recent),
			embeddingProvider: embeddings?.provider ?? null,
			embeddingModel: embeddings?.model ?? null,
			embeddingAvailable: boolOrNull(embeddings?.available),
			queueDepth: diagnostics?.queue?.depth ?? null,
			recentMemories: recent,
			ingestionRate: this.#ingestionRate,
		};

		return { kind: "running", ...this.#snapshot };
	}

	#updateIngestionRate(count: number | null): void {
		if (count === null) return;
		const now = Date.now();
		if (this.#lastMemoryCount !== null && this.#lastMemoryCountTime !== null) {
			const deltaCount = count - this.#lastMemoryCount;
			const deltaHours = (now - this.#lastMemoryCountTime) / 3_600_000;
			if (deltaHours > 0 && deltaCount >= 0) {
				const rate = deltaCount / deltaHours;
				this.#ingestionRate = this.#ingestionRate === null ? rate : 0.3 * rate + 0.7 * this.#ingestionRate;
			}
		}
		this.#lastMemoryCount = count;
		this.#lastMemoryCountTime = now;
	}

	#openUtilityWindow(kind: "capture" | "search"): void {
		const win = new BrowserWindow({
			width: kind === "capture" ? 420 : 620,
			height: kind === "capture" ? 300 : 480,
			title: kind === "capture" ? "Quick Capture" : "Search Memories",
			resizable: true,
			webPreferences: {
				preload: preloadPath(),
				contextIsolation: true,
				nodeIntegration: false,
				sandbox: true,
			},
		});
		win
			.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(kind === "capture" ? captureHtml() : searchHtml())}`)
			.catch(() => undefined);
	}
}

function shellStyle(): string {
	return `<style>
		body{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;background:#111;color:#eee;margin:0;padding:18px;}
		textarea,input{box-sizing:border-box;width:100%;background:#171717;color:#eee;border:1px solid #333;border-radius:6px;padding:10px;font:inherit;}
		textarea{height:160px;resize:vertical;}button{margin-top:12px;background:#eee;color:#111;border:0;border-radius:6px;padding:8px 12px;font:inherit;cursor:pointer;}button:disabled{opacity:.5;cursor:not-allowed;}pre{white-space:pre-wrap;background:#171717;border:1px solid #333;border-radius:6px;padding:10px;max-height:300px;overflow:auto;}
	</style>`;
}

function captureHtml(): string {
	return `<!doctype html><html><head><title>Quick Capture</title>${shellStyle()}</head><body>
		<h3>Quick Capture</h3><textarea id="content" autofocus placeholder="Save a memory..."></textarea><br><button id="save">Save</button><span id="status"></span>
		<script>
		const btn = document.getElementById('save');
		const status = document.getElementById('status');
		btn.onclick = async () => { btn.disabled = true; try { await window.signetDesktop.quickCapture(document.getElementById('content').value); status.textContent = ' Saved.'; setTimeout(() => window.close(), 500); } catch (err) { status.textContent = ' ' + String(err); btn.disabled = false; } };
		</script></body></html>`;
}

function searchHtml(): string {
	return `<!doctype html><html><head><title>Search Memories</title>${shellStyle()}</head><body>
		<h3>Search Memories</h3><input id="query" autofocus placeholder="Search..."/><br><button id="search">Search</button><pre id="results"></pre>
		<script>
		const btn = document.getElementById('search'); const query = document.getElementById('query'); const results = document.getElementById('results');
		btn.onclick = async () => { btn.disabled = true; try { const res = await window.signetDesktop.searchMemories(query.value, 10); results.textContent = JSON.stringify(JSON.parse(res), null, 2); } catch (err) { results.textContent = String(err); } finally { btn.disabled = false; } };
		query.addEventListener('keydown', (e) => { if (e.key === 'Enter') btn.click(); });
		</script></body></html>`;
}

import { type ChildProcess, spawn } from "node:child_process";
import { type WriteStream, createWriteStream, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import { bunPath, daemonEntry, daemonRoot } from "./paths.js";

export interface HealthStatus {
	readonly version: string;
	readonly pid: number;
	readonly uptime: number;
}

export interface DesktopDaemonStatus {
	readonly running: boolean;
	readonly owned: boolean;
	readonly pid: number | null;
	readonly version: string | null;
	readonly uptime: number | null;
	readonly port: number;
	readonly baseUrl: string;
}

function readPort(): number {
	const parsed = Number.parseInt(process.env.SIGNET_PORT ?? "3850", 10);
	return Number.isFinite(parsed) && parsed > 0 && parsed < 65536 ? parsed : 3850;
}

function controllerSignal(ms: number): { readonly signal: AbortSignal; readonly cancel: () => void } {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), ms);
	return {
		signal: controller.signal,
		cancel: () => clearTimeout(timer),
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function numberOrNull(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

export class DaemonManager {
	readonly port = readPort();
	readonly baseUrl = `http://localhost:${this.port}`;
	#child: ChildProcess | null = null;
	#owned = false;
	#startPromise: Promise<DesktopDaemonStatus> | null = null;
	#stdout: WriteStream | null = null;
	#stderr: WriteStream | null = null;

	async probe(timeoutMs = 1200): Promise<HealthStatus | null> {
		const { signal, cancel } = controllerSignal(timeoutMs);
		try {
			const response = await fetch(`${this.baseUrl}/health`, { signal });
			if (!response.ok) return null;
			const data = (await response.json()) as Record<string, unknown>;
			const pid = numberOrNull(data.pid);
			return {
				version: stringOrNull(data.version) ?? "unknown",
				pid: pid ?? 0,
				uptime: numberOrNull(data.uptime) ?? 0,
			};
		} catch {
			return null;
		} finally {
			cancel();
		}
	}

	async status(): Promise<DesktopDaemonStatus> {
		const health = await this.probe();
		return {
			running: health !== null,
			owned: this.#owned,
			pid: health?.pid ?? null,
			version: health?.version ?? null,
			uptime: health?.uptime ?? null,
			port: this.port,
			baseUrl: this.baseUrl,
		};
	}

	async ensureStarted(): Promise<DesktopDaemonStatus> {
		if (this.#startPromise) return this.#startPromise;
		this.#startPromise = this.#ensureStarted();
		try {
			return await this.#startPromise;
		} finally {
			this.#startPromise = null;
		}
	}

	async #ensureStarted(): Promise<DesktopDaemonStatus> {
		const existing = await this.probe();
		if (existing) {
			this.#owned = false;
			return this.status();
		}

		if (!this.#child) this.#spawn();
		for (let i = 0; i < 60; i += 1) {
			const health = await this.probe(500);
			if (health) return this.status();
			await sleep(250);
		}
		throw new Error("Daemon failed to start within 15 seconds");
	}

	async start(): Promise<DesktopDaemonStatus> {
		return this.ensureStarted();
	}

	async stop(): Promise<DesktopDaemonStatus> {
		const health = await this.probe();
		if (!health) {
			this.#owned = false;
			return this.status();
		}

		const child = this.#child;
		if (!child || !this.#owned) return this.status();

		child.kill("SIGTERM");
		if (!(await this.#waitForExit(child, 5000))) {
			throw new Error("Owned daemon did not exit within 5 seconds");
		}

		for (let i = 0; i < 30; i += 1) {
			if (!(await this.probe(300))) break;
			await sleep(100);
		}

		return this.status();
	}

	async restart(): Promise<DesktopDaemonStatus> {
		const stopped = await this.stop();
		if (stopped.running) {
			throw new Error(`Cannot restart daemon because port ${this.port} is still occupied`);
		}
		await sleep(500);
		return this.start();
	}

	shutdownOwned(): void {
		if (!this.#child || !this.#owned) return;
		this.#child.kill("SIGTERM");
		this.#child = null;
		this.#owned = false;
	}

	#closeLogs(): void {
		this.#stdout?.end();
		this.#stderr?.end();
		this.#stdout = null;
		this.#stderr = null;
	}

	#waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
		if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
		return new Promise((resolve) => {
			const timer = setTimeout(() => resolve(false), timeoutMs);
			child.once("exit", () => {
				clearTimeout(timer);
				resolve(true);
			});
		});
	}

	#spawn(): void {
		const entry = daemonEntry();
		if (!existsSync(entry)) {
			throw new Error(`Bundled daemon entry not found: ${entry}`);
		}

		const logDir = join(app.getPath("userData"), "logs");
		mkdirSync(logDir, { recursive: true });
		this.#closeLogs();
		this.#stdout = createWriteStream(join(logDir, "daemon.out.log"), { flags: "a" });
		this.#stderr = createWriteStream(join(logDir, "daemon.err.log"), { flags: "a" });

		this.#child = spawn(bunPath(), [entry], {
			cwd: daemonRoot(),
			detached: false,
			stdio: ["ignore", this.#stdout, this.#stderr],
			env: {
				...process.env,
				SIGNET_PORT: String(this.port),
				SIGNET_DESKTOP: "1",
			},
		});
		this.#owned = true;
		this.#child.once("exit", () => {
			this.#child = null;
			this.#owned = false;
			this.#closeLogs();
		});
	}
}

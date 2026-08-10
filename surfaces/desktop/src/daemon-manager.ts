import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { join, resolve } from "node:path";
import { type WorkspaceMismatch, healthWorkspaceMismatch } from "./daemon-workspace.js";
import { bunPath, daemonEntry, daemonRoot } from "./paths.js";

export type DaemonMode = "attached" | "bundled" | "none";

export interface HealthStatus {
	readonly version: string;
	readonly pid: number;
	readonly uptime: number;
	readonly agentsDir: string | null;
}

export interface DesktopDaemonStatus {
	readonly running: boolean;
	readonly owned: boolean;
	readonly mode: DaemonMode;
	readonly pid: number | null;
	readonly version: string | null;
	readonly uptime: number | null;
	readonly port: number;
	readonly baseUrl: string;
	readonly workspacePath: string;
	readonly mismatch: WorkspaceMismatch | null;
}

export interface DaemonManagerOptions {
	readonly workspacePath: string;
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
	readonly #workspacePath: string;
	#child: ChildProcess | null = null;
	#owned = false;
	#mode: DaemonMode = "none";
	#startPromise: Promise<DesktopDaemonStatus> | null = null;
	// File descriptors opened with openSync (sync fd). Closed on process exit or spawn cleanup.
	#stdoutFd: number | null = null;
	#stderrFd: number | null = null;
	#lastMismatch: WorkspaceMismatch | null = null;

	constructor(options: DaemonManagerOptions) {
		this.#workspacePath = resolve(options.workspacePath);
		process.env.SIGNET_DESKTOP_DAEMON_BASE_URL = this.baseUrl;
	}

	get daemonMode(): DaemonMode {
		return this.#mode;
	}

	async probe(timeoutMs = 1200): Promise<HealthStatus | null> {
		const health = await this.#probeRaw(timeoutMs);
		const mismatch = health ? healthWorkspaceMismatch(this.#workspacePath, health.agentsDir) : null;
		this.#lastMismatch = mismatch;
		return mismatch ? null : health;
	}

	async #probeRaw(timeoutMs = 1200): Promise<HealthStatus | null> {
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
				agentsDir: stringOrNull(data.agentsDir),
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
			mode: this.#mode,
			pid: health?.pid ?? null,
			version: health?.version ?? null,
			uptime: health?.uptime ?? null,
			port: this.port,
			baseUrl: this.baseUrl,
			workspacePath: this.#workspacePath,
			mismatch: this.#lastMismatch,
		};
	}

	/**
	 * Dual-mode startup (fixes #606 spawn fd race + update drift):
	 *
	 * 1. Probe http://localhost:<port>/health with a short 500ms timeout.
	 * 2. If a daemon responds → attach (skip spawn, no version check, no auto-update).
	 *    This eliminates the update-drift restart loop: the CLI-managed daemon is
	 *    already running its own version; we just proxy to it.
	 * 3. If not responding → spawn the bundled daemon using fs.openSync (synchronous
	 *    file descriptor) instead of createWriteStream (lazy fd). Node's child_process
	 *    spawn validates stdio descriptors synchronously at call time, so the lazy
	 *    WriteStream fd was undefined at that moment — causing the TypeError described
	 *    in issue #606. openSync returns a real fd immediately, fixing the race.
	 */
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
		// Step 1: fast probe (500ms) — prefer attach to avoid version-check/restart loop.
		const raw = await this.#probeRaw(500);
		const mismatch = raw ? healthWorkspaceMismatch(this.#workspacePath, raw.agentsDir) : null;
		this.#lastMismatch = mismatch;

		if (mismatch) {
			throw new Error(
				`Signet daemon on ${this.baseUrl} is using workspace ${mismatch.actual}, expected ${mismatch.expected}. Stop that daemon or start it with the configured workspace before opening the desktop app.`,
			);
		}

		if (raw) {
			// Step 2: attach — daemon already running (CLI-managed or otherwise).
			// Skip bundled spawn, version check, and auto-update entirely.
			this.#owned = false;
			this.#mode = "attached";
			return this.status();
		}

		// Step 3: bundled fallback — spawn the daemon we ship inside the .dmg / .app.
		// Uses fs.openSync (sync fd) instead of createWriteStream (lazy fd) to fix the
		// TypeError: stream must have an underlying descriptor race from issue #606.
		if (!this.#child) this.#spawnBundled();
		for (let i = 0; i < 60; i += 1) {
			const health = await this.probe(500);
			if (health) return this.status();
			await sleep(250);
		}
		throw new Error("Bundled daemon failed to start within 15 seconds");
	}

	async start(): Promise<DesktopDaemonStatus> {
		return this.ensureStarted();
	}

	async stop(): Promise<DesktopDaemonStatus> {
		const health = await this.probe();
		if (!health) {
			this.#owned = false;
			this.#mode = "none";
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
		this.#mode = "none";
		this.#closeFds();
	}

	#closeFds(): void {
		if (this.#stdoutFd !== null) {
			try {
				closeSync(this.#stdoutFd);
			} catch {
				/* ignore */
			}
			this.#stdoutFd = null;
		}
		if (this.#stderrFd !== null) {
			try {
				closeSync(this.#stderrFd);
			} catch {
				/* ignore */
			}
			this.#stderrFd = null;
		}
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

	/**
	 * Spawn the bundled bun daemon.
	 *
	 * FD-race fix (issue #606): createWriteStream opens the file lazily — the
	 * underlying fd is not available until the 'open' event fires, which happens
	 * asynchronously. Node's child_process.spawn validates stdio descriptors
	 * synchronously at call time, so passing a WriteStream whose fd is still
	 * undefined produces:
	 *   TypeError: stream must have an underlying descriptor
	 *
	 * Using openSync returns a real integer fd immediately. We pass that fd
	 * directly to spawn's stdio array, which satisfies the sync validation.
	 */
	#spawnBundled(): void {
		const entry = daemonEntry();
		if (!existsSync(entry)) {
			throw new Error(`Bundled daemon entry not found: ${entry}. Install the .dmg or run stage:runtime first.`);
		}

		const logDir = join(this.#workspacePath, ".daemon", "logs");
		mkdirSync(logDir, { recursive: true });
		this.#closeFds();

		// openSync returns a real fd synchronously — no race with spawn's fd validation.
		// See issue #606: createWriteStream causes "TypeError: stream must have an underlying descriptor"
		this.#stdoutFd = openSync(join(logDir, "daemon.out.log"), "a");
		this.#stderrFd = openSync(join(logDir, "daemon.err.log"), "a");

		this.#child = spawn(bunPath(), [entry], {
			cwd: daemonRoot(),
			detached: false,
			stdio: ["ignore", this.#stdoutFd, this.#stderrFd],
			env: {
				...process.env,
				SIGNET_PORT: String(this.port),
				SIGNET_PATH: this.#workspacePath,
				SIGNET_WORKSPACE: this.#workspacePath,
				SIGNET_DESKTOP: "1",
				SIGNET_TELEMETRY_INSTALL_CHANNEL: process.env.SIGNET_TELEMETRY_INSTALL_CHANNEL ?? "desktop",
			},
		});
		this.#owned = true;
		this.#mode = "bundled";
		this.#child.once("exit", () => {
			this.#child = null;
			this.#owned = false;
			this.#mode = "none";
			this.#closeFds();
		});
	}
}

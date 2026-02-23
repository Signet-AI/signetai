/**
 * CaptureManager — orchestrates all capture adapters.
 *
 * Provides start/stop lifecycle, capture aggregation into bundles,
 * and rolling cleanup of aged-out raw data.
 */

import type {
	CaptureAdapter,
	CaptureBundle,
	PerceptionConfig,
	ScreenCapture,
	FileActivity,
	TerminalCapture,
	CommCapture,
	VoiceSegment,
} from "../types";
import { ScreenCaptureAdapter } from "./screen";
import { FileWatcherAdapter } from "./files";
import { TerminalWatcherAdapter } from "./terminal";
import { CommsWatcherAdapter } from "./comms";
import { VoiceCaptureAdapter } from "./voice";

export class CaptureManager {
	private adapters: CaptureAdapter[] = [];
	private config: PerceptionConfig;
	private cleanupTimer: ReturnType<typeof setInterval> | null = null;
	private started = false;

	constructor(config: PerceptionConfig) {
		this.config = config;

		if (config.screen.enabled) {
			this.adapters.push(new ScreenCaptureAdapter(config.screen));
		}
		if (config.files.enabled) {
			this.adapters.push(new FileWatcherAdapter(config.files));
		}
		if (config.terminal.enabled) {
			this.adapters.push(new TerminalWatcherAdapter(config.terminal));
		}
		if (config.comms.enabled) {
			this.adapters.push(new CommsWatcherAdapter(config.comms));
		}
		if (config.voice.enabled) {
			this.adapters.push(new VoiceCaptureAdapter(config.voice));
		}
	}

	async start(): Promise<void> {
		if (this.started) return;

		for (const adapter of this.adapters) {
			try {
				await adapter.start();
				console.log(`[perception] Started ${adapter.name} adapter`);
			} catch (err) {
				console.warn(
					`[perception] Failed to start ${adapter.name}:`,
					err instanceof Error ? err.message : String(err),
				);
			}
		}

		// Cleanup every hour — remove captures older than retention
		this.cleanupTimer = setInterval(
			() => this.cleanup(),
			60 * 60 * 1000,
		);

		this.started = true;
	}

	async stop(): Promise<void> {
		if (!this.started) return;

		if (this.cleanupTimer) {
			clearInterval(this.cleanupTimer);
			this.cleanupTimer = null;
		}

		for (const adapter of this.adapters) {
			try {
				await adapter.stop();
			} catch {
				// Best-effort stop
			}
		}

		this.started = false;
	}

	isRunning(): boolean {
		return this.started;
	}

	getEnabledAdapters(): string[] {
		return this.adapters.map((a) => a.name);
	}

	/**
	 * Aggregate recent captures from all adapters into a CaptureBundle.
	 */
	async getRecentCaptures(since: string): Promise<CaptureBundle> {
		const bundle: CaptureBundle = {
			screen: [],
			voice: [],
			files: [],
			terminal: [],
			comms: [],
			since,
			until: new Date().toISOString(),
		};

		for (const adapter of this.adapters) {
			try {
				const captures = await adapter.getCaptures(since);

				switch (adapter.name) {
					case "screen":
						bundle.screen = captures as ScreenCapture[];
						break;
					case "files":
						bundle.files = captures as FileActivity[];
						break;
					case "terminal":
						bundle.terminal = captures as TerminalCapture[];
						break;
					case "comms":
						bundle.comms = captures as CommCapture[];
						break;
					case "voice":
						bundle.voice = captures as VoiceSegment[];
						break;
				}
			} catch {
				// Skip failed adapters
			}
		}

		return bundle;
	}

	/**
	 * Get capture counts per adapter.
	 */
	async getCounts(): Promise<Record<string, number>> {
		const epoch = "1970-01-01T00:00:00.000Z";
		const counts: Record<string, number> = {};

		for (const adapter of this.adapters) {
			try {
				const captures = await adapter.getCaptures(epoch);
				counts[adapter.name] = captures.length;
			} catch {
				counts[adapter.name] = 0;
			}
		}

		return counts;
	}

	/**
	 * Rolling cleanup — remove in-memory captures older than max retention.
	 * In production, this would also clean the SQLite tables.
	 */
	private cleanup(): void {
		// For now, trim in-memory arrays (DB cleanup would go here)
		const maxRetentionDays = Math.max(
			this.config.screen.retentionDays,
			this.config.files.retentionDays,
			this.config.terminal.retentionDays,
			this.config.comms.retentionDays,
		);

		const cutoff = new Date(
			Date.now() - maxRetentionDays * 24 * 60 * 60 * 1000,
		).toISOString();

		// Each adapter manages its own in-memory store;
		// we just log the cleanup cycle for now
		console.log(`[perception] Cleanup cycle — cutoff: ${cutoff}`);
	}
}

export { ScreenCaptureAdapter } from "./screen";
export { FileWatcherAdapter } from "./files";
export { TerminalWatcherAdapter } from "./terminal";
export { CommsWatcherAdapter } from "./comms";
export { VoiceCaptureAdapter } from "./voice";

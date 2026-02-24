/**
 * Screen Capture Adapter — uses Peekaboo CLI for OCR/window info.
 *
 * Runs periodic captures of the focused window, extracts text via OCR,
 * and deduplicates by tracking recent app+window combinations.
 */

import { execFile, spawnSync } from "child_process";
import { existsSync } from "fs";
import { promisify } from "util";
import type { CaptureAdapter, ScreenCapture, ScreenConfig } from "../types";

const execFileAsync = promisify(execFile);

/** Maximum number of screen captures to retain in memory (C-2). */
const MAX_CAPTURES = 10_000;

/** Resolve Peekaboo path: try `which`, then check known paths (M-12). */
function resolvePeekabooPath(): string {
	try {
		const result = spawnSync("which", ["peekaboo"], { encoding: "utf-8", timeout: 3000 });
		const resolved = result.stdout?.trim();
		if (resolved && existsSync(resolved)) return resolved;
	} catch { /* fall through */ }
	if (existsSync("/opt/homebrew/bin/peekaboo")) return "/opt/homebrew/bin/peekaboo";
	if (existsSync("/usr/local/bin/peekaboo")) return "/usr/local/bin/peekaboo";
	return "/opt/homebrew/bin/peekaboo"; // fallback
}

const PEEKABOO_PATH = resolvePeekabooPath();

/** Jaccard similarity on word sets — cheap text similarity check. */
function textSimilarity(a: string, b: string): number {
	if (!a && !b) return 1;
	if (!a || !b) return 0;
	const setA = new Set(a.toLowerCase().split(/\s+/));
	const setB = new Set(b.toLowerCase().split(/\s+/));
	let intersection = 0;
	for (const word of setA) {
		if (setB.has(word)) intersection++;
	}
	const union = setA.size + setB.size - intersection;
	return union === 0 ? 1 : intersection / union;
}

export class ScreenCaptureAdapter implements CaptureAdapter {
	readonly name = "screen";
	private config: ScreenConfig;
	private timer: ReturnType<typeof setInterval> | null = null;
	private captures: ScreenCapture[] = [];
	private peekabooAvailable = false;

	// Deduplication state
	private lastApp = "";
	private lastWindow = "";
	private lastOcrText = "";
	private consecutiveSameCount = 0;

	constructor(config: ScreenConfig) {
		this.config = config;
	}

	async start(): Promise<void> {
		// Check if Peekaboo is available
		try {
			await execFileAsync(PEEKABOO_PATH, ["--version"]);
			this.peekabooAvailable = true;
		} catch {
			console.warn(
				"[perception:screen] Peekaboo not found at",
				PEEKABOO_PATH,
				"— screen capture disabled.",
			);
			return;
		}

		const intervalMs = this.config.intervalSeconds * 1000;
		this.timer = setInterval(() => {
			this.captureOnce().catch((err) => {
				console.warn("[perception:screen] Capture error:", err.message);
			});
		}, intervalMs);

		// First capture immediately
		await this.captureOnce().catch(() => {});
	}

	async stop(): Promise<void> {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	async getCaptures(since: string): Promise<ScreenCapture[]> {
		return this.captures.filter((c) => c.timestamp >= since);
	}

	/** C-5: Return count without copying the array. */
	getCount(): number {
		return this.captures.length;
	}

	/** C-2: Trim captures older than cutoff. Returns number trimmed. */
	trimCaptures(cutoff: string): number {
		const before = this.captures.length;
		this.captures = this.captures.filter((c) => c.timestamp >= cutoff);
		return before - this.captures.length;
	}

	private async captureOnce(): Promise<void> {
		if (!this.peekabooAvailable) return;

		try {
			// Get focused window info
			const { focusedApp, focusedWindow, bundleId } =
				await this.getFocusedWindow();

			// Check exclusion lists
			if (this.isExcluded(focusedApp, focusedWindow)) return;

			// Get OCR text from focused window
			const ocrText = await this.getOcrText();

			// Deduplication check
			if (this.isDuplicate(focusedApp, focusedWindow, ocrText)) return;

			const capture: ScreenCapture = {
				id: `scr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
				timestamp: new Date().toISOString(),
				focusedApp,
				focusedWindow,
				bundleId,
				ocrText,
			};

			this.captures.push(capture);
			// C-2: FIFO trimming
			if (this.captures.length > MAX_CAPTURES) {
				this.captures.splice(0, this.captures.length - MAX_CAPTURES);
			}

			// Update dedup state
			this.lastApp = focusedApp;
			this.lastWindow = focusedWindow;
			this.lastOcrText = ocrText;
		} catch (err) {
			// Silently skip individual capture failures
		}
	}

	private async getFocusedWindow(): Promise<{
		focusedApp: string;
		focusedWindow: string;
		bundleId: string;
	}> {
		try {
			const { stdout } = await execFileAsync(PEEKABOO_PATH, [
				"list",
				"--filter",
				"focused",
				"--output",
				"json",
			], { timeout: 10_000 });

			const data = JSON.parse(stdout);
			// Peekaboo returns an array of windows, pick the first focused one
			const focused = Array.isArray(data) ? data[0] : data;
			return {
				focusedApp: focused?.app || focused?.appName || "Unknown",
				focusedWindow: focused?.title || focused?.windowTitle || "Unknown",
				bundleId: focused?.bundleId || focused?.bundle_id || "",
			};
		} catch {
			return { focusedApp: "Unknown", focusedWindow: "Unknown", bundleId: "" };
		}
	}

	private async getOcrText(): Promise<string> {
		try {
			const { stdout } = await execFileAsync(PEEKABOO_PATH, [
				"capture",
				"--target",
				"focused",
			], { timeout: 30_000 });

			return stdout.trim().slice(0, 10_000); // Cap OCR text length
		} catch {
			return "";
		}
	}

	private isExcluded(app: string, window: string): boolean {
		const appLower = app.toLowerCase();
		const windowLower = window.toLowerCase();

		for (const excluded of this.config.excludeApps) {
			if (appLower.includes(excluded.toLowerCase())) return true;
		}

		for (const pattern of this.config.excludeWindows) {
			const p = pattern.replace(/\*/g, "").toLowerCase();
			// H-14: Skip empty patterns (e.g., pattern "*" becomes "")
			if (p.length === 0) continue;
			if (windowLower.includes(p)) return true;
		}

		return false;
	}

	private isDuplicate(
		app: string,
		window: string,
		ocrText: string,
	): boolean {
		if (app === this.lastApp && window === this.lastWindow) {
			this.consecutiveSameCount++;
			// Skip if same window for 3+ consecutive captures AND OCR text >80% similar
			if (
				this.consecutiveSameCount >= 3 &&
				textSimilarity(ocrText, this.lastOcrText) > 0.8
			) {
				return true;
			}
		} else {
			this.consecutiveSameCount = 0;
		}
		return false;
	}
}

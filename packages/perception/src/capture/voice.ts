/**
 * Voice Capture Adapter — records ambient audio via ffmpeg, transcribes via Whisper.
 *
 * Records rolling 10-second WAV segments, applies Voice Activity Detection
 * (VAD) to skip silence, then transcribes speech segments with Whisper.
 * All processing is 100% local — nothing leaves the device.
 *
 * OFF by default — the most privacy-sensitive capture type.
 */

import { execFile, spawnSync } from "child_process";
import { promisify } from "util";
import { existsSync, mkdirSync, unlinkSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { CaptureAdapter, VoiceSegment, VoiceConfig } from "../types";

const execFileAsync = promisify(execFile);

/** Maximum number of voice captures to retain in memory (C-2). */
const MAX_CAPTURES = 10_000;

/** Resolve tool path: use `which` first, fall back to Homebrew ARM path (M-13). */
function resolveToolPath(name: string, fallback: string): string {
	try {
		const result = spawnSync("which", [name], { encoding: "utf-8", timeout: 3000 });
		const resolved = result.stdout?.trim();
		if (resolved && existsSync(resolved)) return resolved;
	} catch { /* fall through */ }
	return fallback;
}

const FFMPEG_PATH = resolveToolPath("ffmpeg", "/opt/homebrew/bin/ffmpeg");
const WHISPER_PATH = resolveToolPath("whisper", "/opt/homebrew/bin/whisper");

/** Default VAD threshold — maps to -30dB mean volume. */
const DEFAULT_VAD_THRESHOLD = 0.3;

/** Duration of each recording segment in seconds. */
const SEGMENT_DURATION = 10;

/** Temp directory for audio files. */
const VOICE_TMP_DIR = join(tmpdir(), "signet-voice");

/**
 * Parse ffmpeg volumedetect output to extract mean volume in dB.
 * Returns a normalised 0–1 energy value (1 = loud, 0 = silence).
 */
function parseVolumeDetect(stderr: string): number {
	// ffmpeg volumedetect writes to stderr, e.g.:
	//   [Parsed_volumedetect_0 ...] mean_volume: -28.4 dB
	const match = stderr.match(/mean_volume:\s*([-\d.]+)\s*dB/);
	if (!match) return 0;

	const dbValue = parseFloat(match[1]);
	if (isNaN(dbValue)) return 0;

	// Convert dB to 0-1 range. -91 dB ≈ silence, 0 dB ≈ max
	// We map -91→0, 0→1 linearly (good enough for VAD)
	const normalised = Math.max(0, Math.min(1, (dbValue + 91) / 91));
	return normalised;
}

/**
 * Redact keywords from transcript text.
 */
function redactKeywords(text: string, keywords: string[]): string {
	if (!keywords || keywords.length === 0) return text;

	let result = text;
	for (const keyword of keywords) {
		const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const re = new RegExp(escaped, "gi");
		result = result.replace(re, "[REDACTED]");
	}
	return result;
}

/**
 * Clean up all files in the voice temp directory.
 */
function cleanupTempDir(): void {
	try {
		if (!existsSync(VOICE_TMP_DIR)) return;
		const files = readdirSync(VOICE_TMP_DIR);
		for (const file of files) {
			try {
				unlinkSync(join(VOICE_TMP_DIR, file));
			} catch {
				// Best-effort cleanup
			}
		}
	} catch {
		// Ignore cleanup errors
	}
}

/**
 * Safely remove a single file.
 */
function safeUnlink(path: string): void {
	try {
		if (existsSync(path)) unlinkSync(path);
	} catch {
		// Best-effort
	}
}

export class VoiceCaptureAdapter implements CaptureAdapter {
	readonly name = "voice";
	private config: VoiceConfig;
	private captures: VoiceSegment[] = [];
	private timer: ReturnType<typeof setInterval> | null = null;
	private ffmpegAvailable = false;
	private whisperAvailable = false;
	private vadThreshold: number;
	private excludeKeywords: string[];
	private segmentCounter = 0;
	private capturing = false; // H-5: concurrency guard
	private exitHandler: (() => void) | null = null; // M-20: process exit cleanup

	constructor(config: VoiceConfig) {
		this.config = config;
		this.vadThreshold = config.vadThreshold ?? DEFAULT_VAD_THRESHOLD;
		this.excludeKeywords = config.excludeKeywords ?? [];
	}

	async start(): Promise<void> {
		// Check if ffmpeg is available (async — C-3)
		try {
			await execFileAsync(FFMPEG_PATH, ["-version"], { timeout: 5000 });
			this.ffmpegAvailable = true;
		} catch {
			console.warn(
				"[perception:voice] ffmpeg not found at",
				FFMPEG_PATH,
				"— voice capture disabled.",
			);
			return;
		}

		// Check if whisper is available (async — C-3)
		try {
			await execFileAsync(WHISPER_PATH, ["--help"], { timeout: 5000 });
			this.whisperAvailable = true;
		} catch {
			console.warn(
				"[perception:voice] whisper not found at",
				WHISPER_PATH,
				"— voice capture disabled.",
			);
			return;
		}

		// Ensure temp directory exists
		mkdirSync(VOICE_TMP_DIR, { recursive: true });

		// Clean up any stale files from previous runs
		cleanupTempDir();

		// M-20: Register process exit handler for cleanup
		this.exitHandler = () => cleanupTempDir();
		process.on("exit", this.exitHandler);

		console.log(
			"[perception:voice] ⚠ Voice capture active. All processing is local.",
		);

		// Start recording loop — every SEGMENT_DURATION seconds
		const intervalMs = SEGMENT_DURATION * 1000 + 500; // slight buffer
		this.timer = setInterval(() => {
			this.captureOnce().catch((err) => {
				console.warn(
					"[perception:voice] Capture error:",
					err instanceof Error ? err.message : String(err),
				);
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

		// Remove process exit handler
		if (this.exitHandler) {
			process.removeListener("exit", this.exitHandler);
			this.exitHandler = null;
		}

		// Clean up temp files on stop
		cleanupTempDir();
	}

	async getCaptures(since: string): Promise<VoiceSegment[]> {
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

	/**
	 * Record a single audio segment, check VAD, transcribe if speech detected.
	 */
	private async captureOnce(): Promise<void> {
		if (!this.ffmpegAvailable || !this.whisperAvailable) return;

		// H-5: Concurrency guard — prevent overlapping captures
		if (this.capturing) return;
		this.capturing = true;

		const segmentId = `voice_${Date.now()}_${this.segmentCounter++}`;
		const wavPath = join(VOICE_TMP_DIR, `${segmentId}.wav`);

		try {
			// Step 1: Record audio segment with ffmpeg (async — C-3)
			await this.recordSegment(wavPath);

			// Verify the file was created
			if (!existsSync(wavPath)) return;

			// Step 2: Voice Activity Detection — check energy level
			const energy = this.detectVoiceActivity(wavPath);
			const isSpeaking = energy >= this.vadThreshold;

			if (!isSpeaking) {
				// Silence or ambient noise — skip transcription to save CPU
				safeUnlink(wavPath);
				return;
			}

			// Step 3: Transcribe with Whisper (async — C-3)
			const transcription = await this.transcribe(wavPath, segmentId);

			if (!transcription || !transcription.text.trim()) {
				safeUnlink(wavPath);
				return;
			}

			// Step 4: Apply privacy redaction
			let transcript = transcription.text.trim();
			if (this.excludeKeywords.length > 0) {
				transcript = redactKeywords(transcript, this.excludeKeywords);
			}

			// Step 5: Store the voice segment (with FIFO trimming — C-2)
			const segment: VoiceSegment = {
				id: segmentId,
				timestamp: new Date().toISOString(),
				durationSeconds: SEGMENT_DURATION,
				transcript,
				confidence: transcription.confidence,
				language: transcription.language || "en",
				isSpeaking: true,
			};

			this.captures.push(segment);
			if (this.captures.length > MAX_CAPTURES) {
				this.captures.splice(0, this.captures.length - MAX_CAPTURES);
			}
		} catch (err) {
			// Silently skip individual capture failures
		} finally {
			// Always clean up the audio file
			safeUnlink(wavPath);
			// Clean up any whisper output files for THIS segment (M-3)
			this.cleanupWhisperOutputs(segmentId);
			this.capturing = false;
		}
	}

	/**
	 * Record a WAV segment using ffmpeg's avfoundation input.
	 * Uses ":0" (default audio input device on macOS).
	 * Async to avoid blocking the event loop (C-3).
	 */
	private async recordSegment(outputPath: string): Promise<void> {
		try {
			await execFileAsync(
				FFMPEG_PATH,
				[
					"-f", "avfoundation",
					"-i", ":0",
					"-t", String(SEGMENT_DURATION),
					"-ar", "16000",     // 16kHz sample rate (Whisper preference)
					"-ac", "1",         // Mono
					"-y",               // Overwrite
					outputPath,
				],
				{
					timeout: (SEGMENT_DURATION + 5) * 1000,
				},
			);
		} catch (err) {
			// ffmpeg may write warnings to stderr but still succeed
			// Check if file was created
			if (!existsSync(outputPath)) {
				throw new Error("ffmpeg recording failed — no output file");
			}
		}
	}

	/**
	 * Run ffmpeg volumedetect filter to check audio energy level.
	 * Returns normalised energy 0-1 (higher = louder).
	 *
	 * C-1 FIX: ffmpeg writes volumedetect output to stderr, not stdout.
	 * Use spawnSync to reliably capture stderr regardless of exit code.
	 */
	private detectVoiceActivity(wavPath: string): number {
		try {
			const result = spawnSync(
				FFMPEG_PATH,
				[
					"-i", wavPath,
					"-af", "volumedetect",
					"-f", "null",
					"-",
				],
				{
					stdio: "pipe",
					timeout: 10_000,
				},
			);

			// ffmpeg writes volumedetect stats to stderr
			const stderr = result.stderr?.toString() || "";
			return parseVolumeDetect(stderr);
		} catch {
			return 0;
		}
	}

	/**
	 * Transcribe a WAV file using Whisper CLI.
	 * Returns transcript text and confidence score.
	 * Async to avoid blocking the event loop (C-3).
	 */
	private async transcribe(
		wavPath: string,
		segmentId: string,
	): Promise<{ text: string; confidence: number; language: string } | null> {
		const outputDir = VOICE_TMP_DIR;
		const model = this.config.model || "tiny.en";

		try {
			await execFileAsync(
				WHISPER_PATH,
				[
					wavPath,
					"--model", model,
					"--output_format", "json",
					"--output_dir", outputDir,
				],
				{
					timeout: 30_000, // 30s timeout for transcription
				},
			);

			// Whisper outputs <basename>.json in the output directory
			const baseName = wavPath.split("/").pop()?.replace(".wav", "") || segmentId;
			const jsonPath = join(outputDir, `${baseName}.json`);

			if (!existsSync(jsonPath)) {
				return null;
			}

			const raw = readFileSync(jsonPath, "utf-8");
			const data = JSON.parse(raw);

			// Whisper JSON format: { text: "...", segments: [{ ... }] }
			const text = data.text || "";

			// H-8 FIX: Calculate confidence correctly from no_speech_prob
			// confidence = 1 - average(no_speech_prob) across segments
			let confidence = 0.5; // default
			if (Array.isArray(data.segments) && data.segments.length > 0) {
				const avgNoSpeech =
					data.segments.reduce(
						(sum: number, seg: any) =>
							sum + (typeof seg.no_speech_prob === "number" ? seg.no_speech_prob : 0),
						0,
					) / data.segments.length;
				confidence = Math.max(0, Math.min(1, 1 - avgNoSpeech));
			}

			const language = data.language || "en";

			// Clean up JSON output
			safeUnlink(jsonPath);

			return { text, confidence, language };
		} catch (err) {
			// Whisper might fail on very short or corrupt audio
			return null;
		}
	}

	/**
	 * Clean up any Whisper output files for a given segment.
	 * M-3 FIX: Only delete files for the specific segmentId, not all voice_ files.
	 */
	private cleanupWhisperOutputs(segmentId: string): void {
		try {
			const files = readdirSync(VOICE_TMP_DIR);
			for (const file of files) {
				if (file.startsWith(segmentId) && (file.endsWith(".json") || file.endsWith(".txt") || file.endsWith(".srt") || file.endsWith(".vtt") || file.endsWith(".tsv"))) {
					safeUnlink(join(VOICE_TMP_DIR, file));
				}
			}
		} catch {
			// Best-effort cleanup
		}
	}
}

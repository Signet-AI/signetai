/**
 * Voice Capture Adapter — records ambient audio via ffmpeg, transcribes via Whisper.
 *
 * Records rolling 10-second WAV segments, applies Voice Activity Detection
 * (VAD) to skip silence, then transcribes speech segments with Whisper.
 * All processing is 100% local — nothing leaves the device.
 *
 * OFF by default — the most privacy-sensitive capture type.
 */

import { execFileSync } from "child_process";
import { existsSync, mkdirSync, unlinkSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { CaptureAdapter, VoiceSegment, VoiceConfig } from "../types";

const FFMPEG_PATH = "/opt/homebrew/bin/ffmpeg";
const WHISPER_PATH = "/opt/homebrew/bin/whisper";

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

	constructor(config: VoiceConfig) {
		this.config = config;
		this.vadThreshold = config.vadThreshold ?? DEFAULT_VAD_THRESHOLD;
		this.excludeKeywords = config.excludeKeywords ?? [];
	}

	async start(): Promise<void> {
		// Check if ffmpeg is available
		try {
			execFileSync(FFMPEG_PATH, ["-version"], {
				stdio: "pipe",
				timeout: 5000,
			});
			this.ffmpegAvailable = true;
		} catch {
			console.warn(
				"[perception:voice] ffmpeg not found at",
				FFMPEG_PATH,
				"— voice capture disabled.",
			);
			return;
		}

		// Check if whisper is available
		try {
			execFileSync(WHISPER_PATH, ["--help"], {
				stdio: "pipe",
				timeout: 5000,
			});
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

		// Clean up temp files on stop
		cleanupTempDir();
	}

	async getCaptures(since: string): Promise<VoiceSegment[]> {
		return this.captures.filter((c) => c.timestamp >= since);
	}

	/**
	 * Record a single audio segment, check VAD, transcribe if speech detected.
	 */
	private async captureOnce(): Promise<void> {
		if (!this.ffmpegAvailable || !this.whisperAvailable) return;

		const segmentId = `voice_${Date.now()}_${this.segmentCounter++}`;
		const wavPath = join(VOICE_TMP_DIR, `${segmentId}.wav`);

		try {
			// Step 1: Record audio segment with ffmpeg
			this.recordSegment(wavPath);

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

			// Step 3: Transcribe with Whisper
			const transcription = this.transcribe(wavPath, segmentId);

			if (!transcription || !transcription.text.trim()) {
				safeUnlink(wavPath);
				return;
			}

			// Step 4: Apply privacy redaction
			let transcript = transcription.text.trim();
			if (this.excludeKeywords.length > 0) {
				transcript = redactKeywords(transcript, this.excludeKeywords);
			}

			// Step 5: Store the voice segment
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
		} catch (err) {
			// Silently skip individual capture failures
		} finally {
			// Always clean up the audio file
			safeUnlink(wavPath);
			// Clean up any whisper output files
			this.cleanupWhisperOutputs(segmentId);
		}
	}

	/**
	 * Record a WAV segment using ffmpeg's avfoundation input.
	 * Uses ":0" (default audio input device on macOS).
	 */
	private recordSegment(outputPath: string): void {
		try {
			execFileSync(
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
					stdio: "pipe",
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
	 */
	private detectVoiceActivity(wavPath: string): number {
		try {
			// ffmpeg writes volumedetect output to stderr
			const result = execFileSync(
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

			// execFileSync returns stdout; we need stderr
			// But with stdio: 'pipe', stderr is captured in the error on failure
			// On success, we need to parse what we can
			return 0; // If no error, volume was detected
		} catch (err: any) {
			// ffmpeg outputs volumedetect to stderr, and writing to /dev/null
			// may cause a "non-zero exit" even on success.
			// The stderr contains the volume info.
			const stderr = err?.stderr?.toString?.() || err?.message || "";
			return parseVolumeDetect(stderr);
		}
	}

	/**
	 * Transcribe a WAV file using Whisper CLI.
	 * Returns transcript text and confidence score.
	 */
	private transcribe(
		wavPath: string,
		segmentId: string,
	): { text: string; confidence: number; language: string } | null {
		const outputDir = VOICE_TMP_DIR;
		const model = this.config.model || "tiny.en";

		try {
			execFileSync(
				WHISPER_PATH,
				[
					wavPath,
					"--model", model,
					"--output_format", "json",
					"--output_dir", outputDir,
				],
				{
					stdio: "pipe",
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

			// Calculate average confidence from segments
			let confidence = 0.5; // default
			if (Array.isArray(data.segments) && data.segments.length > 0) {
				const avgProb =
					data.segments.reduce(
						(sum: number, seg: any) =>
							sum + (seg.avg_logprob || seg.no_speech_prob ? 1 - seg.no_speech_prob : 0.5),
						0,
					) / data.segments.length;
				// avg_logprob is negative, convert to 0-1
				confidence = Math.max(0, Math.min(1, avgProb));
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
	 */
	private cleanupWhisperOutputs(segmentId: string): void {
		try {
			const files = readdirSync(VOICE_TMP_DIR);
			for (const file of files) {
				if (file.startsWith(`voice_`) && (file.endsWith(".json") || file.endsWith(".txt") || file.endsWith(".srt") || file.endsWith(".vtt") || file.endsWith(".tsv"))) {
					safeUnlink(join(VOICE_TMP_DIR, file));
				}
			}
		} catch {
			// Best-effort cleanup
		}
	}
}

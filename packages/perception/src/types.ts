/**
 * Types for the Signet Perception Layer.
 *
 * Covers raw captures (screen, voice, files, terminal, comms),
 * capture bundles for refiners, refiner outputs, and configuration.
 */

// ---------------------------------------------------------------------------
// Raw Capture Types
// ---------------------------------------------------------------------------

export interface ScreenCapture {
	id: string;
	timestamp: string;
	focusedApp: string;
	focusedWindow: string;
	bundleId?: string;
	ocrText: string;
	vlmDescription?: string;
}

export interface VoiceSegment {
	id: string;
	timestamp: string;
	durationSeconds: number;
	transcript: string;
	confidence: number;
	language: string;
	isSpeaking: boolean;
	speakerLabel?: string;
}

export interface FileActivity {
	id: string;
	timestamp: string;
	eventType: "create" | "modify" | "delete" | "rename";
	filePath: string;
	fileType: string;
	isGitRepo: boolean;
	gitBranch?: string;
	sizeBytes?: number;
}

export interface TerminalCapture {
	id: string;
	timestamp: string;
	command: string;
	workingDirectory: string;
	exitCode?: number;
	shell: string;
}

export interface CommCapture {
	id: string;
	timestamp: string;
	source: "git_commit" | "git_branch" | "notification";
	content: string;
	metadata: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Capture Bundle — Aggregated data for refiners
// ---------------------------------------------------------------------------

export interface CaptureBundle {
	screen: ScreenCapture[];
	voice: VoiceSegment[];
	files: FileActivity[];
	terminal: TerminalCapture[];
	comms: CommCapture[];
	since: string;
	until: string;
}

// ---------------------------------------------------------------------------
// Capture Adapter Interface
// ---------------------------------------------------------------------------

export interface CaptureAdapter {
	readonly name: string;
	start(): Promise<void>;
	stop(): Promise<void>;
	getCaptures(since: string): Promise<unknown[]>;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ScreenConfig {
	enabled: boolean;
	intervalSeconds: number;
	excludeApps: string[];
	excludeWindows: string[];
	retentionDays: number;
}

export interface VoiceConfig {
	enabled: boolean;
	vadThreshold: number;
	model: string;
	retentionDays: number;
	excludeKeywords: string[];
}

export interface FilesConfig {
	enabled: boolean;
	watchDirs: string[];
	excludePatterns: string[];
	retentionDays: number;
}

export interface TerminalConfig {
	enabled: boolean;
	excludeCommands: string[];
	retentionDays: number;
}

export interface CommsConfig {
	enabled: boolean;
	gitRepos: string[];
	retentionDays: number;
}

export interface PerceptionConfig {
	enabled: boolean;
	refinerIntervalMinutes: number;
	refinerModel: string;
	ollamaUrl: string;
	screen: ScreenConfig;
	voice: VoiceConfig;
	files: FilesConfig;
	terminal: TerminalConfig;
	comms: CommsConfig;
}

// ---------------------------------------------------------------------------
// Refiner Types
// ---------------------------------------------------------------------------

export interface ExtractedMemory {
	content: string;
	type: string;
	importance: number;
	confidence: number;
	tags: string[];
	sourceCaptures: string[];
}

export interface RefinerOutput {
	refinerName: string;
	memories: ExtractedMemory[];
	warnings: string[];
}

export interface BaseRefinerInterface {
	readonly name: string;
	readonly cooldownMinutes: number;
	shouldRun(bundle: CaptureBundle, lastRun?: Date): boolean;
	refine(bundle: CaptureBundle): Promise<RefinerOutput>;
}

// ---------------------------------------------------------------------------
// Perception Status
// ---------------------------------------------------------------------------

export interface PerceptionStatus {
	running: boolean;
	startedAt?: string;
	adapters: {
		screen: { enabled: boolean; captureCount: number };
		voice: { enabled: boolean; captureCount: number };
		files: { enabled: boolean; captureCount: number };
		terminal: { enabled: boolean; captureCount: number };
		comms: { enabled: boolean; captureCount: number };
	};
	lastRefinerRun?: string;
	memoriesExtractedToday: number;
}

// ---------------------------------------------------------------------------
// Default Configuration
// ---------------------------------------------------------------------------

export const DEFAULT_PERCEPTION_CONFIG: PerceptionConfig = {
	enabled: true,
	refinerIntervalMinutes: 20,
	refinerModel: "qwen2.5:7b",
	ollamaUrl: "http://localhost:11434",
	screen: {
		enabled: true,
		intervalSeconds: 30,
		excludeApps: ["1Password", "Keychain Access", "System Preferences"],
		excludeWindows: ["*password*", "*secret*", "*private*"],
		retentionDays: 7,
	},
	voice: {
		enabled: false,
		vadThreshold: 0.3,
		model: "tiny.en",
		retentionDays: 3,
		excludeKeywords: [],
	},
	files: {
		enabled: true,
		watchDirs: ["~/projects"],
		excludePatterns: [
			"node_modules",
			".git/objects",
			"dist",
			"*.lock",
			"__pycache__",
		],
		retentionDays: 14,
	},
	terminal: {
		enabled: true,
		excludeCommands: ["*password*", "*secret*", "*token*"],
		retentionDays: 14,
	},
	comms: {
		enabled: true,
		gitRepos: ["~/projects/*"],
		retentionDays: 14,
	},
};

/**
 * @signet/perception — Ambient Perception Layer
 *
 * Passively learns who you are — what you work on, how you think,
 * what tools you prefer, and how you solve problems.
 *
 * Zero config. Zero effort. Maximum signal. Minimum creep factor.
 */

import { CaptureManager } from "./capture/index";
import { RefinerScheduler } from "./refiners/index";
import type { PerceptionConfig, PerceptionStatus } from "./types";
import { DEFAULT_PERCEPTION_CONFIG } from "./types";

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let captureManager: CaptureManager | null = null;
let refinerScheduler: RefinerScheduler | null = null;
let startedAt: string | undefined;
let activeConfig: PerceptionConfig | null = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start the perception layer with the given config.
 * Launches capture adapters and the refiner scheduler.
 */
export async function startPerception(
	config: Partial<PerceptionConfig> = {},
): Promise<void> {
	if (captureManager) {
		console.warn("[perception] Already running. Call stopPerception() first.");
		return;
	}

	const mergedConfig: PerceptionConfig = {
		...DEFAULT_PERCEPTION_CONFIG,
		...config,
		screen: { ...DEFAULT_PERCEPTION_CONFIG.screen, ...config.screen },
		voice: { ...DEFAULT_PERCEPTION_CONFIG.voice, ...config.voice },
		files: { ...DEFAULT_PERCEPTION_CONFIG.files, ...config.files },
		terminal: { ...DEFAULT_PERCEPTION_CONFIG.terminal, ...config.terminal },
		comms: { ...DEFAULT_PERCEPTION_CONFIG.comms, ...config.comms },
	};

	activeConfig = mergedConfig;

	// Start capture layer
	captureManager = new CaptureManager(mergedConfig);
	await captureManager.start();

	// Start refiner scheduler
	refinerScheduler = new RefinerScheduler(
		mergedConfig,
		(since) => captureManager!.getRecentCaptures(since),
	);
	await refinerScheduler.start();

	startedAt = new Date().toISOString();
	console.log("[perception] Started.");
}

/**
 * Stop the perception layer gracefully.
 */
export async function stopPerception(): Promise<void> {
	if (refinerScheduler) {
		await refinerScheduler.stop();
		refinerScheduler = null;
	}

	if (captureManager) {
		await captureManager.stop();
		captureManager = null;
	}

	startedAt = undefined;
	activeConfig = null;
	console.log("[perception] Stopped.");
}

/**
 * Get the current status of the perception layer.
 */
export async function getPerceptionStatus(): Promise<PerceptionStatus> {
	if (!captureManager || !activeConfig) {
		return {
			running: false,
			adapters: {
				screen: { enabled: false, captureCount: 0 },
				voice: { enabled: false, captureCount: 0 },
				files: { enabled: false, captureCount: 0 },
				terminal: { enabled: false, captureCount: 0 },
				comms: { enabled: false, captureCount: 0 },
			},
			memoriesExtractedToday: 0,
		};
	}

	const counts = await captureManager.getCounts();

	return {
		running: captureManager.isRunning(),
		startedAt,
		adapters: {
			screen: {
				enabled: activeConfig.screen.enabled,
				captureCount: counts.screen ?? 0,
			},
			voice: {
				enabled: activeConfig.voice.enabled,
				captureCount: counts.voice ?? 0,
			},
			files: {
				enabled: activeConfig.files.enabled,
				captureCount: counts.files ?? 0,
			},
			terminal: {
				enabled: activeConfig.terminal.enabled,
				captureCount: counts.terminal ?? 0,
			},
			comms: {
				enabled: activeConfig.comms.enabled,
				captureCount: counts.comms ?? 0,
			},
		},
		lastRefinerRun: refinerScheduler?.getLastRefinerRun(),
		memoriesExtractedToday: refinerScheduler?.getMemoriesExtractedToday() ?? 0,
	};
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export type {
	PerceptionConfig,
	PerceptionStatus,
	ScreenCapture,
	VoiceSegment,
	FileActivity,
	TerminalCapture,
	CommCapture,
	CaptureBundle,
	CaptureAdapter,
	RefinerOutput,
	ExtractedMemory,
	BaseRefinerInterface,
} from "./types";

export { DEFAULT_PERCEPTION_CONFIG } from "./types";
export { CaptureManager } from "./capture/index";
export { RefinerScheduler } from "./refiners/index";
export {
	BaseRefiner,
	SkillRefiner,
	ProjectRefiner,
	DecisionRefiner,
	WorkflowRefiner,
	ContextRefiner,
	PatternRefiner,
} from "./refiners/index";

// Distillation layer
export {
	runDistillation,
	getDistillationState,
	shouldRunDistillation,
	buildCognitiveProfile,
	updateCognitiveProfile,
	loadCognitiveProfile,
	analyzeWorkingStyle,
	buildExpertiseGraph,
	getExpertiseGraph,
	getRelatedSkills,
	getExpertiseDepth,
	generateAgentCard,
	exportAgentCard,
	generateTrainingContext,
	loadMemoriesForCard,
} from "./distillation/index";

export type {
	CognitiveProfile,
	WorkingStyle,
	ExpertiseGraph,
	ExpertiseNode,
	ExpertiseEdge,
	ExpertiseDepth,
	AgentCard,
	AgentCardSkill,
	DistillationState,
} from "./distillation/index";

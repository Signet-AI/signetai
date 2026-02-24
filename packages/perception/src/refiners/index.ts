/**
 * RefinerScheduler — runs all refiners on a configurable interval.
 *
 * Triggers on timer (default 20 min) or on significant context changes
 * (project switch). Stores extracted memories via the Signet daemon API.
 */

import type { CaptureBundle, PerceptionConfig, RefinerOutput, ExtractedMemory } from "../types";
import { BaseRefiner, type RefinerLLMConfig } from "./base";
import { SkillRefiner } from "./skill-refiner";
import { ProjectRefiner } from "./project-refiner";
import { DecisionRefiner } from "./decision-refiner";
import { WorkflowRefiner } from "./workflow-refiner";
import { ContextRefiner } from "./context-refiner";
import { PatternRefiner } from "./pattern-refiner";

const DEFAULT_DAEMON_URL = "http://localhost:3850";

export class RefinerScheduler {
	private refiners: BaseRefiner[];
	private intervalMs: number;
	private lastRun: Map<string, Date> = new Map();
	private timer: ReturnType<typeof setInterval> | null = null;
	private daemonUrl: string;
	private getCaptureBundle: (since: string) => Promise<CaptureBundle>;
	private memoriesExtractedToday = 0;
	private lastRefinerRun?: string;
	private lastProject = "";

	constructor(
		config: PerceptionConfig,
		getCaptureBundle: (since: string) => Promise<CaptureBundle>,
		daemonUrl = DEFAULT_DAEMON_URL,
	) {
		this.intervalMs = config.refinerIntervalMinutes * 60 * 1000;
		this.getCaptureBundle = getCaptureBundle;
		this.daemonUrl = daemonUrl;

		const llmConfig: Partial<RefinerLLMConfig> = {
			ollamaUrl: config.ollamaUrl,
			model: config.refinerModel,
		};

		this.refiners = [
			new SkillRefiner(llmConfig),
			new ProjectRefiner(llmConfig),
			new DecisionRefiner(llmConfig),
			new WorkflowRefiner(llmConfig),
			new ContextRefiner(llmConfig),
			new PatternRefiner(llmConfig),
		];
	}

	async start(): Promise<void> {
		// Run first cycle after a short delay (let captures accumulate)
		setTimeout(() => {
			this.runCycle().catch((err) => {
				console.warn("[perception:refiner] Cycle error:", err.message);
			});
		}, 60_000); // 1 minute initial delay

		this.timer = setInterval(() => {
			this.runCycle().catch((err) => {
				console.warn("[perception:refiner] Cycle error:", err.message);
			});
		}, this.intervalMs);
	}

	async stop(): Promise<void> {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	getLastRefinerRun(): string | undefined {
		return this.lastRefinerRun;
	}

	getMemoriesExtractedToday(): number {
		return this.memoriesExtractedToday;
	}

	/**
	 * Run all eligible refiners against recent captures.
	 */
	async runCycle(): Promise<Record<string, RefinerOutput>> {
		const since = new Date(Date.now() - this.intervalMs * 2).toISOString();
		const bundle = await this.getCaptureBundle(since);

		const results: Record<string, RefinerOutput> = {};

		// Detect project switch as trigger for immediate refinement
		const currentProject = this.detectCurrentProject(bundle);
		const projectSwitch = currentProject !== this.lastProject && this.lastProject !== "";
		if (projectSwitch) {
			console.log(
				`[perception:refiner] Project switch detected: ${this.lastProject} → ${currentProject}`,
			);
		}
		this.lastProject = currentProject;

		for (const refiner of this.refiners) {
			// On project switch, skip cooldown check for project-related refiners
			const shouldForce =
				projectSwitch &&
				(refiner.name === "context-extractor" ||
					refiner.name === "project-extractor");

			if (!shouldForce && !refiner.shouldRun(bundle, this.lastRun.get(refiner.name))) {
				continue;
			}

			try {
				const output = await refiner.refine(bundle);
				results[refiner.name] = output;

				// Store extracted memories
				for (const memory of output.memories) {
					await this.storeMemory(memory, refiner.name);
					this.memoriesExtractedToday++;
				}

				this.lastRun.set(refiner.name, new Date());

				if (output.memories.length > 0) {
					console.log(
						`[perception:refiner] ${refiner.name}: extracted ${output.memories.length} memories`,
					);
				}
			} catch (err) {
				console.warn(
					`[perception:refiner] ${refiner.name} failed:`,
					err instanceof Error ? err.message : String(err),
				);
			}
		}

		this.lastRefinerRun = new Date().toISOString();
		return results;
	}

	/**
	 * Store an extracted memory via the Signet daemon API.
	 */
	private async storeMemory(
		memory: ExtractedMemory,
		refinerName: string,
	): Promise<void> {
		try {
			const res = await fetch(`${this.daemonUrl}/api/memory/remember`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					content: memory.content,
					type: memory.type,
					importance: memory.importance,
					confidence: memory.confidence,
					tags: memory.tags,
					source_type: "ambient-perception",
					source_refiner: refinerName,
				}),
				signal: AbortSignal.timeout(10_000),
			});

			if (!res.ok) {
				const body = await res.text().catch(() => "");
				console.warn(
					`[perception:refiner] Failed to store memory: ${res.status} ${body.slice(0, 100)}`,
				);
			}
		} catch {
			// Daemon might not be running — queue for later or silently skip
		}
	}

	/**
	 * Detect the current project from screen/file captures.
	 */
	private detectCurrentProject(bundle: CaptureBundle): string {
		// Check recent screen captures for project clues
		if (bundle.screen.length > 0) {
			const latest = bundle.screen[bundle.screen.length - 1];
			// Window titles often contain project names
			if (latest.focusedWindow) {
				const parts = latest.focusedWindow.split(/[—\-–]/);
				if (parts.length > 1) {
					return parts[parts.length - 1].trim();
				}
			}
		}

		// Check recent file activity for git repo names
		if (bundle.files.length > 0) {
			const latest = bundle.files[bundle.files.length - 1];
			if (latest.gitBranch) {
				// Extract project name from path
				const parts = latest.filePath.split("/");
				const projectsIdx = parts.indexOf("projects");
				if (projectsIdx >= 0 && parts.length > projectsIdx + 1) {
					return parts[projectsIdx + 1];
				}
			}
		}

		return "unknown";
	}
}

export { BaseRefiner, sanitizeForPrompt, anonymizePath } from "./base";
export { SkillRefiner } from "./skill-refiner";
export { ProjectRefiner } from "./project-refiner";
export { DecisionRefiner } from "./decision-refiner";
export { WorkflowRefiner } from "./workflow-refiner";
export { ContextRefiner } from "./context-refiner";
export { PatternRefiner } from "./pattern-refiner";

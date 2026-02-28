import { type ConfigFile, saveConfigFileResult } from "$lib/api";
import { toast } from "$lib/stores/toast.svelte";
import { parse, stringify } from "yaml";

export const KNOWN_HARNESSES = ["claude-code", "openclaw", "opencode"];

export const PIPELINE_CORE_BOOLS = [
	{ key: "enabled", desc: "Master switch. Pipeline does nothing when disabled." },
	{ key: "shadowMode", desc: "Run extraction and decisions without writing. Safe for evaluation." },
	{ key: "mutationsFrozen", desc: "Emergency brake. Block all writes even if shadowMode is off." },
] as const;

export const PIPELINE_FEATURE_BOOLS = [
	{ key: "allowUpdateDelete", desc: "Permit UPDATE/DELETE decisions on existing memories." },
	{ key: "graphEnabled", desc: "Build and query a knowledge graph from extracted entity relationships." },
	{ key: "autonomousEnabled", desc: "Allow autonomous pipeline operations like maintenance and repair." },
	{ key: "autonomousFrozen", desc: "Block autonomous writes while still allowing autonomous reads." },
	{
		key: "semanticContradictionEnabled",
		desc: "Use LLM to detect semantic contradictions on update proposals. Adds latency but catches subtle conflicts.",
	},
] as const;

export const PIPELINE_RERANKER_BOOLS = [
	{
		key: "rerankerEnabled",
		desc: "Re-score recall candidates using full-content embedding similarity. No LLM call needed.",
	},
] as const;

export const PIPELINE_EXTRACTION_NUMS = [
	{
		key: "extractionTimeout",
		label: "Extraction timeout (ms)",
		desc: "Timeout for the extraction LLM call.",
		min: 5000,
		max: 300000,
		step: 1000,
	},
	{
		key: "minFactConfidenceForWrite",
		label: "Min fact confidence",
		desc: "Facts below this threshold are dropped. Lower captures more at the cost of noise.",
		min: 0,
		max: 1,
		step: 0.05,
	},
] as const;

export const PIPELINE_SEARCH_NUMS = [
	{
		key: "graphBoostWeight",
		label: "Graph boost weight",
		desc: "Score boost applied to graph-linked memories during search.",
		min: 0,
		max: 1,
		step: 0.05,
	},
	{
		key: "rerankerTopN",
		label: "Reranker top N",
		desc: "Number of top candidates re-scored by embedding similarity.",
		min: 1,
		max: 100,
		step: 1,
	},
	{
		key: "rerankerTimeoutMs",
		label: "Reranker timeout (ms)",
		desc: "Timeout for the reranking pass. Original order returned on timeout.",
		min: 100,
		max: 30000,
		step: 100,
	},
] as const;

export const PIPELINE_WORKER_NUMS = [
	{
		key: "workerPollMs",
		label: "Worker poll (ms)",
		desc: "How often the worker polls for pending jobs.",
		min: 100,
		max: 60000,
		step: 100,
	},
	{
		key: "workerMaxRetries",
		label: "Worker max retries",
		desc: "Max retry attempts before a job goes to dead-letter.",
		min: 1,
		max: 10,
		step: 1,
	},
	{
		key: "leaseTimeoutMs",
		label: "Lease timeout (ms)",
		desc: "Time before an uncompleted job lease expires and is retried.",
		min: 10000,
		max: 600000,
		step: 1000,
	},
	{
		key: "maintenanceIntervalMs",
		label: "Maintenance interval (ms)",
		desc: "How often the maintenance worker runs diagnostics.",
		min: 60000,
		max: 86400000,
		step: 60000,
	},
] as const;

export type YamlValue = string | number | boolean | null | YamlObject | YamlValue[];
export type YamlObject = { [key: string]: YamlValue };

export const SETTINGS_PRIORITY = ["agent.yaml", "AGENT.yaml", "config.yaml"] as const;

class SettingsStore {
	agent = $state<YamlObject>({});
	config = $state<YamlObject>({});
	saving = $state(false);
	lastSavedAt = $state<string | null>(null);
	lastSaveFeedback = $state<string>("");

	agentFile = $state<ConfigFile | null>(null);
	configFile = $state<ConfigFile | null>(null);
	agentSnapshot = $state("{}");
	configSnapshot = $state("{}");

	settingsFileName = $derived(
		SETTINGS_PRIORITY.find((name) => this.agentFile?.name === name || this.configFile?.name === name) ?? null,
	);

	settingsIsSameAsAgent = $derived(this.settingsFileName === "agent.yaml" || this.settingsFileName === "AGENT.yaml");

	hasFiles = $derived(!!this.agentFile || !!this.configFile);

	isDirty = $derived(
		this.agentSnapshot !== JSON.stringify(this.agent) ||
			(!this.settingsIsSameAsAgent &&
				this.configSnapshot !== JSON.stringify(this.config)),
	);

	init(configFiles: ConfigFile[]) {
		this.agentFile = configFiles.find((f) => f.name === "agent.yaml" || f.name === "AGENT.yaml") ?? null;
		this.configFile = configFiles.find((f) => f.name === "config.yaml") ?? null;

		if (this.agentFile?.content) {
			try {
				this.agent = JSON.parse(JSON.stringify(parse(this.agentFile.content) ?? {}));
			} catch {
				this.agent = {};
			}
		} else {
			this.agent = {};
		}

		if (this.configFile?.content) {
			try {
				this.config = JSON.parse(JSON.stringify(parse(this.configFile.content) ?? {}));
			} catch {
				this.config = {};
			}
		} else {
			this.config = {};
		}

		this.agentSnapshot = JSON.stringify(this.agent);
		this.configSnapshot = JSON.stringify(this.config);
		this.lastSaveFeedback = "";
	}

	get(obj: YamlObject, ...path: string[]): YamlValue {
		let cur: YamlValue = obj;
		for (const key of path) {
			if (cur == null || typeof cur !== "object" || Array.isArray(cur)) return null;
			cur = (cur as YamlObject)[key] ?? null;
		}
		return cur;
	}

	set(obj: YamlObject, path: string[], value: YamlValue): void {
		let cur = obj;
		for (let i = 0; i < path.length - 1; i++) {
			const key = path[i];
			if (cur[key] == null || typeof cur[key] !== "object" || Array.isArray(cur[key])) {
				cur[key] = {};
			}
			cur = cur[key] as YamlObject;
		}
		cur[path[path.length - 1]] = value;
	}

	sObj(): YamlObject {
		return this.settingsIsSameAsAgent ? this.agent : this.config;
	}

	// Accessors for agent.yaml
	aStr(path: string[]) {
		return String(this.get(this.agent, ...path) ?? "");
	}
	aNum(path: string[]) {
		const v = this.get(this.agent, ...path);
		return typeof v === "number" ? v : v ? Number(v) : "";
	}
	aBool(path: string[]) {
		return Boolean(this.get(this.agent, ...path));
	}
	aSetStr(path: string[], val: string) {
		this.set(this.agent, path, val);
	}
	aSetNum(path: string[], val: string | number) {
		this.set(this.agent, path, val === "" ? null : Number(val));
	}
	aSetBool(path: string[], val: boolean) {
		this.set(this.agent, path, val);
	}

	// Settings accessors: route to agent or config based on daemon's resolution
	sStr(path: string[]) {
		return String(this.get(this.sObj(), ...path) ?? "");
	}
	sNum(path: string[]) {
		const v = this.get(this.sObj(), ...path);
		return typeof v === "number" ? v : v ? Number(v) : "";
	}
	sBool(path: string[]) {
		return Boolean(this.get(this.sObj(), ...path));
	}
	sSetStr(path: string[], val: string) {
		this.set(this.sObj(), path, val);
	}
	sSetNum(path: string[], val: string | number) {
		this.set(this.sObj(), path, val === "" ? null : Number(val));
	}
	sSetBool(path: string[], val: boolean) {
		this.set(this.sObj(), path, val);
	}

	embPath(): string[] {
		const s = this.sObj();
		if (this.get(s, "embedding") != null) return ["embedding"];
		if (this.get(s, "memory", "embeddings") != null) return ["memory", "embeddings"];
		return ["embeddings"];
	}

	harnessArray(): string[] {
		const v = this.get(this.agent, "harnesses");
		return Array.isArray(v) ? v.map(String) : [];
	}

	toggleHarness(name: string, checked: boolean): void {
		const arr = this.harnessArray();
		this.set(this.agent, ["harnesses"], checked ? [...arr, name] : arr.filter((h) => h !== name));
	}

	addCustomHarness(name: string): void {
		name = name.trim();
		if (!name) return;
		const arr = this.harnessArray();
		if (!arr.includes(name)) this.set(this.agent, ["harnesses"], [...arr, name]);
	}

	removeCustomHarness(name: string): void {
		this.set(
			this.agent,
			["harnesses"],
			this.harnessArray().filter((x) => x !== name),
		);
	}

	async save(): Promise<void> {
		if (!this.isDirty) {
			this.lastSaveFeedback = "No changes to save";
			return;
		}

		this.saving = true;
		const successfulFiles: string[] = [];
		const failed: Array<{ file: string; error: string }> = [];
		try {
			if (this.agentFile) {
				const result = await saveConfigFileResult(
					this.agentFile.name,
					stringify(this.agent),
				);
				if (result.ok) {
					successfulFiles.push(this.agentFile.name);
					this.agentSnapshot = JSON.stringify(this.agent);
				} else {
					failed.push({
						file: this.agentFile.name,
						error: result.error ?? `HTTP ${result.status}`,
					});
				}
			}
			if (!this.settingsIsSameAsAgent && this.settingsFileName) {
				const result = await saveConfigFileResult(
					this.settingsFileName,
					stringify(this.config),
				);
				if (result.ok) {
					successfulFiles.push(this.settingsFileName);
					this.configSnapshot = JSON.stringify(this.config);
				} else {
					failed.push({
						file: this.settingsFileName,
						error: result.error ?? `HTTP ${result.status}`,
					});
				}
			}

			if (successfulFiles.length > 0) {
				this.lastSavedAt = new Date().toISOString();
			}

			if (failed.length === 0 && successfulFiles.length > 0) {
				this.lastSaveFeedback = `Saved ${successfulFiles.join(", ")}`;
				toast(this.lastSaveFeedback, "success");
			} else if (failed.length > 0 && successfulFiles.length > 0) {
				this.lastSaveFeedback = `Saved ${successfulFiles.join(", ")}; failed ${failed
					.map((f) => f.file)
					.join(", ")}`;
				toast(
					`${this.lastSaveFeedback}: ${failed
						.map((f) => `${f.file} (${f.error})`)
						.join(", ")}`,
					"warning",
					5000,
				);
			} else if (failed.length > 0) {
				this.lastSaveFeedback = `Failed to save ${failed
					.map((f) => f.file)
					.join(", ")}`;
				toast(
					`${this.lastSaveFeedback}: ${failed
						.map((f) => `${f.file} (${f.error})`)
						.join(", ")}`,
					"error",
					5000,
				);
			}
		} catch (err) {
			this.lastSaveFeedback = "Save failed";
			toast(`Error: ${String(err)}`, "error");
		} finally {
			this.saving = false;
		}
	}
}

export const st = new SettingsStore();

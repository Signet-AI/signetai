<script lang="ts">
import { parse, stringify } from "yaml";
import { saveConfigFile, type ConfigFile } from "$lib/api";
import { toast } from "$lib/stores/toast.svelte";
import FormField from "$lib/components/config/FormField.svelte";
import FormSection from "$lib/components/config/FormSection.svelte";

interface Props {
	configFiles: ConfigFile[];
}

let { configFiles }: Props = $props();

const KNOWN_HARNESSES = ["claude-code", "openclaw", "opencode"];

const PIPELINE_BOOLS = [
	{ key: "enabled", desc: "Master switch. Pipeline does nothing when disabled." },
	{ key: "shadowMode", desc: "Run extraction and decisions without writing. Safe for evaluation." },
	{ key: "allowUpdateDelete", desc: "Permit UPDATE/DELETE decisions on existing memories. Infrastructure-only for now." },
	{ key: "graphEnabled", desc: "Build and query a knowledge graph from extracted entity relationships." },
	{ key: "autonomousEnabled", desc: "Allow autonomous pipeline operations like maintenance and repair." },
	{ key: "mutationsFrozen", desc: "Emergency brake. Block all writes even if shadowMode is off." },
	{ key: "autonomousFrozen", desc: "Block autonomous writes while still allowing autonomous reads." },
	{ key: "rerankerEnabled", desc: "Enable cross-encoder reranking pass after initial retrieval." },
] as const;

const PIPELINE_NUMS = [
	{ key: "extractionTimeout", label: "Extraction timeout (ms)", desc: "Timeout for the Ollama extraction call. Range: 5,000–300,000 ms.", min: 5000, max: 300000, step: 1000 },
	{ key: "workerPollMs", label: "Worker poll (ms)", desc: "How often the worker polls for pending jobs. Range: 100–60,000 ms.", min: 100, max: 60000, step: 100 },
	{ key: "workerMaxRetries", label: "Worker max retries", desc: "Max retry attempts before a job goes to dead-letter. Range: 1–10.", min: 1, max: 10, step: 1 },
	{ key: "leaseTimeoutMs", label: "Lease timeout (ms)", desc: "Time before an uncompleted job lease expires and is retried. Range: 10,000–600,000 ms.", min: 10000, max: 600000, step: 1000 },
	{ key: "minFactConfidenceForWrite", label: "Min fact confidence", desc: "Facts below this threshold are dropped. Lower captures more at the cost of noise. Range: 0.0–1.0.", min: 0, max: 1, step: 0.05 },
	{ key: "graphBoostWeight", label: "Graph boost weight", desc: "Score boost applied to graph-linked memories during search. Range: 0.0–1.0.", min: 0, max: 1, step: 0.05 },
	{ key: "maintenanceIntervalMs", label: "Maintenance interval (ms)", desc: "How often the maintenance worker runs diagnostics. Range: 60s–24h.", min: 60000, max: 86400000, step: 60000 },
	{ key: "rerankerTopN", label: "Reranker top N", desc: "Number of candidates passed to the cross-encoder reranker. Range: 1–100.", min: 1, max: 100, step: 1 },
	{ key: "rerankerTimeoutMs", label: "Reranker timeout (ms)", desc: "Timeout for the reranking call. Original order returned on timeout. Range: 100–30,000 ms.", min: 100, max: 30000, step: 100 },
] as const;

type YamlValue = string | number | boolean | null | YamlObject | YamlValue[];
type YamlObject = { [key: string]: YamlValue };

// Parse both files into separate form states
let agent = $state<YamlObject>({});
let config = $state<YamlObject>({});

let agentFile = $derived(
	configFiles?.find((f) => f.name === "agent.yaml")
);
let configFile = $derived(
	configFiles?.find((f) => f.name === "config.yaml")
);

$effect(() => {
	if (agentFile?.content) {
		try {
			agent = JSON.parse(JSON.stringify(parse(agentFile.content) ?? {}));
		} catch { agent = {}; }
	} else { agent = {}; }
});

$effect(() => {
	if (configFile?.content) {
		try {
			config = JSON.parse(JSON.stringify(parse(configFile.content) ?? {}));
		} catch { config = {}; }
	} else { config = {}; }
});

// Helpers scoped to a specific form object
function get(obj: YamlObject, ...path: string[]): YamlValue {
	let cur: YamlValue = obj;
	for (const key of path) {
		if (cur == null || typeof cur !== "object" || Array.isArray(cur)) return null;
		cur = (cur as YamlObject)[key] ?? null;
	}
	return cur;
}

function set(obj: YamlObject, path: string[], value: YamlValue): void {
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

// Accessors for agent.yaml
const aStr = (path: string[]) => String(get(agent, ...path) ?? "");
const aNum = (path: string[]) => { const v = get(agent, ...path); return typeof v === "number" ? v : (v ? Number(v) : ""); };
const aBool = (path: string[]) => Boolean(get(agent, ...path));
const aOnStr = (path: string[]) => (e: Event) => set(agent, path, (e.target as HTMLInputElement).value);
const aOnNum = (path: string[]) => (e: Event) => { const v = (e.target as HTMLInputElement).value; set(agent, path, v === "" ? null : Number(v)); };
const aOnBool = (path: string[]) => (e: Event) => set(agent, path, (e.target as HTMLInputElement).checked);

// Accessors for config.yaml
const cStr = (path: string[]) => String(get(config, ...path) ?? "");
const cNum = (path: string[]) => { const v = get(config, ...path); return typeof v === "number" ? v : (v ? Number(v) : ""); };
const cOnStr = (path: string[]) => (e: Event) => set(config, path, (e.target as HTMLInputElement).value);
const cOnNum = (path: string[]) => (e: Event) => { const v = (e.target as HTMLInputElement).value; set(config, path, v === "" ? null : Number(v)); };

function harnessArray(): string[] {
	const v = get(agent, "harnesses");
	return Array.isArray(v) ? v.map(String) : [];
}

function toggleHarness(name: string, checked: boolean): void {
	const arr = harnessArray();
	set(agent, ["harnesses"], checked ? [...arr, name] : arr.filter((h) => h !== name));
}

let customHarnessInput = $state("");

function addCustomHarness(): void {
	const name = customHarnessInput.trim();
	if (!name) return;
	const arr = harnessArray();
	if (!arr.includes(name)) set(agent, ["harnesses"], [...arr, name]);
	customHarnessInput = "";
}

function formatDate(raw: YamlValue): string {
	if (!raw) return "";
	try { return new Date(String(raw)).toLocaleString(); } catch { return String(raw); }
}

let showRegistry = $derived(aStr(["trust", "verification"]) === "registry");
let saving = $state(false);

async function saveSettings(): Promise<void> {
	saving = true;
	const results: boolean[] = [];
	try {
		if (agentFile) {
			results.push(await saveConfigFile("agent.yaml", stringify(agent)));
		}
		if (configFile) {
			results.push(await saveConfigFile("config.yaml", stringify(config)));
		}
		const allOk = results.length > 0 && results.every(Boolean);
		toast(allOk ? "Settings saved" : "Failed to save settings", allOk ? "success" : "error");
	} catch (err) {
		toast(`Error: ${String(err)}`, "error");
	} finally {
		saving = false;
	}
}

let hasFiles = $derived(!!agentFile || !!configFile);
</script>

<div class="settings-tab">
	{#if !hasFiles}
		<div class="empty-state">No YAML config files found</div>
	{:else}
		<div class="form-body">

			<!-- === AGENT (agent.yaml) === -->
			{#if agentFile}
				<FormSection title="Agent" description="Core identity metadata. Created by signet setup, synced to all harnesses on change.">
					{#snippet children()}
						<FormField label="Name" description="Display name shown in harness configs and session context.">
							{#snippet children()}
								<input type="text" class="inp" value={aStr(["agent", "name"])} oninput={aOnStr(["agent", "name"])} />
							{/snippet}
						</FormField>
						<FormField label="Description" description="Short description of the agent's role and purpose.">
							{#snippet children()}
								<textarea class="inp ta" rows={3} value={aStr(["agent", "description"])} oninput={aOnStr(["agent", "description"])}></textarea>
							{/snippet}
						</FormField>
						<FormField label="Created" description="ISO 8601 creation timestamp. Read-only.">
							{#snippet children()}
								<input type="text" class="inp ro" readonly value={formatDate(get(agent, "agent", "created"))} />
							{/snippet}
						</FormField>
						<FormField label="Updated" description="ISO 8601 last update timestamp. Read-only.">
							{#snippet children()}
								<input type="text" class="inp ro" readonly value={formatDate(get(agent, "agent", "updated"))} />
							{/snippet}
						</FormField>
					{/snippet}
				</FormSection>

				<FormSection title="Harnesses" defaultOpen={false} description="AI platforms to integrate with. The daemon syncs identity files and installs hooks for each active harness.">
					{#snippet children()}
						<FormField label="Active harnesses" description="Supported: claude-code, openclaw, opencode. Cursor, windsurf, chatgpt, and gemini are planned.">
							{#snippet children()}
								<div class="checkbox-group">
									{#each KNOWN_HARNESSES as h (h)}
										<label class="cb-row">
											<input type="checkbox" checked={harnessArray().includes(h)} onchange={(e) => toggleHarness(h, (e.target as HTMLInputElement).checked)} />
											<span>{h}</span>
										</label>
									{/each}
									{#each harnessArray().filter((h) => !KNOWN_HARNESSES.includes(h)) as h (h)}
										<label class="cb-row">
											<input type="checkbox" checked={true} onchange={() => set(agent, ["harnesses"], harnessArray().filter((x) => x !== h))} />
											<span>{h} <em class="custom-tag">custom</em></span>
										</label>
									{/each}
								</div>
							{/snippet}
						</FormField>
						<FormField label="Add custom harness" description="Add a custom harness name for third-party integrations.">
							{#snippet children()}
								<div class="inline-add">
									<input type="text" class="inp" placeholder="harness-name" bind:value={customHarnessInput} onkeydown={(e) => { if (e.key === "Enter") addCustomHarness(); }} />
									<button class="btn-add" onclick={addCustomHarness}>Add</button>
								</div>
							{/snippet}
						</FormField>
					{/snippet}
				</FormSection>
			{/if}

			<!-- === EMBEDDINGS (config.yaml) === -->
			{#if configFile}
				<FormSection title="Embeddings" defaultOpen={false} description="Vector embedding configuration for semantic memory search. Embeddings power the vector half of hybrid recall.">
					{#snippet children()}
						<FormField label="Provider" description="Embedding backend. Ollama runs locally, OpenAI requires an API key.">
							{#snippet children()}
								<select class="inp sel" value={cStr(["embeddings", "provider"])} onchange={cOnStr(["embeddings", "provider"])}>
									<option value="">— select —</option>
									<option value="ollama">ollama</option>
									<option value="openai">openai</option>
								</select>
							{/snippet}
						</FormField>
						<FormField label="Model" description="Ollama: nomic-embed-text (768d), all-minilm (384d), mxbai-embed-large (1024d). OpenAI: text-embedding-3-small (1536d), text-embedding-3-large (3072d).">
							{#snippet children()}
								<input type="text" class="inp" value={cStr(["embeddings", "model"])} oninput={cOnStr(["embeddings", "model"])} />
							{/snippet}
						</FormField>
						<FormField label="Dimensions" description="Must match the model's output dimension. Mismatched dimensions will produce broken search results.">
							{#snippet children()}
								<input type="number" class="inp" value={cNum(["embeddings", "dimensions"])} oninput={cOnNum(["embeddings", "dimensions"])} />
							{/snippet}
						</FormField>
						<FormField label="Base URL" description="Ollama default: http://localhost:11434. OpenAI default: https://api.openai.com/v1.">
							{#snippet children()}
								<input type="text" class="inp" value={cStr(["embeddings", "base_url"])} oninput={cOnStr(["embeddings", "base_url"])} />
							{/snippet}
						</FormField>
						<FormField label="API Key" description="Optional for Ollama, required for OpenAI. Use $secret:NAME to reference a stored secret instead of plaintext.">
							{#snippet children()}
								<input type="password" class="inp" value={cStr(["embeddings", "api_key"])} oninput={cOnStr(["embeddings", "api_key"])} />
							{/snippet}
						</FormField>
					{/snippet}
				</FormSection>

				<!-- === SEARCH (config.yaml) === -->
				<FormSection title="Search" defaultOpen={false} description="Hybrid search tuning. Controls the blend between semantic (vector) and keyword (BM25) retrieval.">
					{#snippet children()}
						<FormField label="Alpha" description="Vector weight (0–1). At 0.9 results are heavily semantic; at 0.3 they skew toward keyword matching. Default 0.7 works well generally.">
							{#snippet children()}
								<input type="number" class="inp" min="0" max="1" step="0.1" value={cNum(["search", "alpha"])} oninput={cOnNum(["search", "alpha"])} />
							{/snippet}
						</FormField>
						<FormField label="Top K" description="Candidate count fetched from each source (BM25 and vector) before alpha-blending. Default: 20.">
							{#snippet children()}
								<input type="number" class="inp" value={cNum(["search", "top_k"])} oninput={cOnNum(["search", "top_k"])} />
							{/snippet}
						</FormField>
						<FormField label="Min Score" description="Minimum combined score to include in results. Results below this threshold are dropped. Default: 0.3.">
							{#snippet children()}
								<input type="number" class="inp" min="0" max="1" step="0.1" value={cNum(["search", "min_score"])} oninput={cOnNum(["search", "min_score"])} />
							{/snippet}
						</FormField>
					{/snippet}
				</FormSection>

				<!-- === MEMORY (config.yaml) === -->
				<FormSection title="Memory" defaultOpen={false} description="Memory system settings. Controls how much context is injected into sessions and how memories age over time.">
					{#snippet children()}
						<FormField label="Session budget" description="Character limit for context injected at session start via hooks. Default: 2000.">
							{#snippet children()}
								<input type="number" class="inp" value={cNum(["memory", "session_budget"])} oninput={cOnNum(["memory", "session_budget"])} />
							{/snippet}
						</FormField>
						<FormField label="MEMORY.md budget" description="Character limit for the auto-generated MEMORY.md summary. Default: 10000.">
							{#snippet children()}
								<input type="number" class="inp" value={cNum(["memory", "current_md_budget"])} oninput={cOnNum(["memory", "current_md_budget"])} />
							{/snippet}
						</FormField>
						<FormField label="Decay rate" description="Daily importance decay factor for non-pinned memories. Formula: importance(t) = base × decay_rate^days. 0.99 = slow, 0.95 = default, 0.90 = fast.">
							{#snippet children()}
								<input type="number" class="inp" min="0" max="1" step="0.01" value={cNum(["memory", "decay_rate"])} oninput={cOnNum(["memory", "decay_rate"])} />
							{/snippet}
						</FormField>
					{/snippet}
				</FormSection>

				<!-- === PATHS (config.yaml) === -->
				<FormSection title="Paths" defaultOpen={false} description="File paths for memory storage. All paths are relative to ~/.agents/ (or $SIGNET_PATH).">
					{#snippet children()}
						<FormField label="Database" description="SQLite database file for structured memory storage.">
							{#snippet children()}
								<input type="text" class="inp" value={cStr(["paths", "database"])} oninput={cOnStr(["paths", "database"])} />
							{/snippet}
						</FormField>
						<FormField label="Vectors" description="Vector store file for embedding data.">
							{#snippet children()}
								<input type="text" class="inp" value={cStr(["paths", "vectors"])} oninput={cOnStr(["paths", "vectors"])} />
							{/snippet}
						</FormField>
						<FormField label="MEMORY.md" description="Output path for the auto-generated working memory summary.">
							{#snippet children()}
								<input type="text" class="inp" value={cStr(["paths", "current_md"])} oninput={cOnStr(["paths", "current_md"])} />
							{/snippet}
						</FormField>
					{/snippet}
				</FormSection>
			{/if}

			<!-- === PIPELINE (agent.yaml: memory.pipelineV2) === -->
			{#if agentFile}
				<FormSection title="Pipeline" defaultOpen={false} description="V2 memory pipeline. Runs LLM-based fact extraction on incoming memories, then decides whether to write, update, or skip. Lives under memory.pipelineV2 in agent.yaml.">
					{#snippet children()}
						{#each PIPELINE_BOOLS as { key, desc } (key)}
							<FormField label={key} description={desc}>
								{#snippet children()}
									<label class="toggle">
										<input type="checkbox" checked={aBool(["memory", "pipelineV2", key])} onchange={aOnBool(["memory", "pipelineV2", key])} />
										<span class="toggle-track"><span class="toggle-thumb"></span></span>
									</label>
								{/snippet}
							</FormField>
						{/each}

						<FormField label="Extraction provider" description="LLM backend for fact extraction. Ollama runs locally; claude-code uses the Claude Code headless provider.">
							{#snippet children()}
								<select class="inp sel" value={aStr(["memory", "pipelineV2", "extractionProvider"])} onchange={aOnStr(["memory", "pipelineV2", "extractionProvider"])}>
									<option value="">— select —</option>
									<option value="ollama">ollama</option>
									<option value="claude-code">claude-code</option>
								</select>
							{/snippet}
						</FormField>
						<FormField label="Extraction model" description="Model name for fact extraction. Must be available locally via Ollama. Default: qwen3:4b.">
							{#snippet children()}
								<input type="text" class="inp" value={aStr(["memory", "pipelineV2", "extractionModel"])} oninput={aOnStr(["memory", "pipelineV2", "extractionModel"])} />
							{/snippet}
						</FormField>
						<FormField label="Maintenance mode" description="'observe' logs diagnostics without changes. 'execute' attempts repairs. Only works when autonomousEnabled is true.">
							{#snippet children()}
								<select class="inp sel" value={aStr(["memory", "pipelineV2", "maintenanceMode"])} onchange={aOnStr(["memory", "pipelineV2", "maintenanceMode"])}>
									<option value="">— select —</option>
									<option value="observe">observe</option>
									<option value="execute">execute</option>
								</select>
							{/snippet}
						</FormField>
						<FormField label="Reranker model" description="Cross-encoder model for optional reranking pass. Leave empty to disable.">
							{#snippet children()}
								<input type="text" class="inp" value={aStr(["memory", "pipelineV2", "rerankerModel"])} oninput={aOnStr(["memory", "pipelineV2", "rerankerModel"])} />
							{/snippet}
						</FormField>

						{#each PIPELINE_NUMS as { key, label, desc, min, max, step } (key)}
							<FormField {label} description={desc}>
								{#snippet children()}
									<input
										type="number"
										class="inp"
										{min}
										{max}
										{step}
										value={aNum(["memory", "pipelineV2", key])}
										oninput={aOnNum(["memory", "pipelineV2", key])}
									/>
								{/snippet}
							</FormField>
						{/each}
					{/snippet}
				</FormSection>

				<!-- === TRUST (agent.yaml) === -->
				<FormSection title="Trust" defaultOpen={false} description="Identity verification method. Controls how the agent proves its identity to peers and registries.">
					{#snippet children()}
						<FormField label="Verification" description="none = local only. erc8128 = wallet-based (recommended). gpg/did = alternative signing. registry = contract-based lookup.">
							{#snippet children()}
								<select class="inp sel" value={aStr(["trust", "verification"])} onchange={aOnStr(["trust", "verification"])}>
									<option value="">— select —</option>
									{#each ["none", "erc8128", "gpg", "did", "registry"] as v (v)}
										<option value={v}>{v}</option>
									{/each}
								</select>
							{/snippet}
						</FormField>
						{#if showRegistry}
							<FormField label="Registry URL" description="Registry contract address or ENS name for identity lookups.">
								{#snippet children()}
									<input type="text" class="inp" value={aStr(["trust", "registry"])} oninput={aOnStr(["trust", "registry"])} />
								{/snippet}
							</FormField>
						{/if}
					{/snippet}
				</FormSection>

				<!-- === AUTH (agent.yaml) === -->
				<FormSection title="Auth" defaultOpen={false} description="Authentication for the daemon API. Optional — disabled in local mode. Uses HMAC-SHA256 signed tokens.">
					{#snippet children()}
						<FormField label="Method" description="Signing method for auth tokens. erc8128 uses wallet signatures, gpg/did use alternative signing.">
							{#snippet children()}
								<select class="inp sel" value={aStr(["auth", "method"])} onchange={aOnStr(["auth", "method"])}>
									<option value="">— select —</option>
									{#each ["none", "erc8128", "gpg", "did"] as v (v)}
										<option value={v}>{v}</option>
									{/each}
								</select>
							{/snippet}
						</FormField>
						<FormField label="Mode" description="local = no auth required (localhost only). team = tokens required for all requests. hybrid = localhost skips auth, remote requires tokens.">
							{#snippet children()}
								<select class="inp sel" value={aStr(["auth", "mode"])} onchange={aOnStr(["auth", "mode"])}>
									<option value="">— select —</option>
									{#each ["local", "team", "hybrid"] as v (v)}
										<option value={v}>{v}</option>
									{/each}
								</select>
							{/snippet}
						</FormField>
						<FormField label="Chain ID" description="Ethereum chain ID for ERC-8128 signature verification. Default: 1 (mainnet).">
							{#snippet children()}
								<input type="number" class="inp" value={aNum(["auth", "chainId"])} oninput={aOnNum(["auth", "chainId"])} />
							{/snippet}
						</FormField>
					{/snippet}
				</FormSection>
			{/if}

		</div>

		<div class="save-bar">
			<button class="save-btn" onclick={saveSettings} disabled={saving}>
				{saving ? "Saving…" : "Save"}
			</button>
		</div>
	{/if}
</div>

<style>
	.settings-tab {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
	}

	.empty-state {
		display: flex;
		align-items: center;
		justify-content: center;
		flex: 1;
		font-family: var(--font-mono);
		font-size: var(--font-size-sm);
		color: var(--sig-text-muted);
	}

	.form-body {
		flex: 1;
		overflow-y: auto;
		padding-bottom: 56px;
	}

	/* Inputs */
	.inp {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--sig-text);
		background: var(--sig-bg);
		border: 1px solid var(--sig-border-strong);
		border-radius: 0;
		padding: 5px 8px;
		width: 100%;
		outline: none;
		box-sizing: border-box;
		transition: border-color var(--dur) var(--ease);
	}

	.inp:focus { border-color: var(--sig-accent); }
	.inp.ro { color: var(--sig-text-muted); cursor: default; }
	.inp.ta { resize: vertical; min-height: 60px; }
	.inp.sel { appearance: none; cursor: pointer; }

	/* Harness checkboxes */
	.checkbox-group { display: flex; flex-direction: column; gap: 6px; }

	.cb-row {
		display: flex;
		align-items: center;
		gap: 8px;
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--sig-text);
		cursor: pointer;
	}

	.cb-row input[type="checkbox"] { accent-color: var(--sig-accent); width: 13px; height: 13px; }

	.custom-tag {
		font-style: normal;
		font-size: 9px;
		color: var(--sig-text-muted);
		border: 1px solid var(--sig-border-strong);
		padding: 0 4px;
		vertical-align: middle;
		margin-left: 4px;
	}

	.inline-add { display: flex; gap: 6px; }
	.inline-add .inp { flex: 1; }

	.btn-add {
		font-family: var(--font-mono);
		font-size: 10px;
		letter-spacing: 0.04em;
		color: var(--sig-text);
		background: var(--sig-surface-raised);
		border: 1px solid var(--sig-border-strong);
		border-radius: 0;
		padding: 5px 12px;
		cursor: pointer;
		white-space: nowrap;
		transition: background var(--dur) var(--ease);
	}

	.btn-add:hover { background: var(--sig-border-strong); }

	/* Toggle */
	.toggle { display: inline-flex; align-items: center; cursor: pointer; }
	.toggle input[type="checkbox"] { position: absolute; opacity: 0; width: 0; height: 0; }

	.toggle-track {
		display: inline-flex;
		align-items: center;
		width: 32px;
		height: 16px;
		background: var(--sig-surface-raised);
		border: 1px solid var(--sig-border-strong);
		border-radius: 0;
		position: relative;
		transition: background var(--dur) var(--ease), border-color var(--dur) var(--ease);
	}

	.toggle input:checked + .toggle-track {
		background: var(--sig-success);
		border-color: var(--sig-success);
	}

	.toggle-thumb {
		position: absolute;
		left: 2px;
		width: 10px;
		height: 10px;
		background: var(--sig-text-muted);
		transition: transform var(--dur) var(--ease), background var(--dur) var(--ease);
	}

	.toggle input:checked + .toggle-track .toggle-thumb {
		transform: translateX(16px);
		background: var(--sig-text-bright);
	}

	/* Save bar */
	.save-bar {
		position: sticky;
		bottom: 0;
		display: flex;
		justify-content: flex-end;
		padding: var(--space-sm) var(--space-md);
		background: var(--sig-surface);
		border-top: 1px solid var(--sig-border);
		flex-shrink: 0;
	}

	.save-btn {
		font-family: var(--font-mono);
		font-size: 11px;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--sig-bg);
		background: var(--sig-text-bright);
		border: none;
		border-radius: 0;
		padding: 6px 20px;
		cursor: pointer;
		transition: opacity var(--dur) var(--ease);
	}

	.save-btn:disabled { opacity: 0.5; cursor: not-allowed; }
	.save-btn:not(:disabled):hover { opacity: 0.85; }
</style>

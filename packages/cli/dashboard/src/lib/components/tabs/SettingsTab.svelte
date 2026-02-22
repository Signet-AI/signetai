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

// Paths are relative to the "pipeline" key
const PIPELINE_BOOLS = [
	"enabled", "shadowMode", "allowUpdateDelete", "graphEnabled",
	"autonomousEnabled", "mutationsFrozen", "autonomousFrozen", "rerankerEnabled",
] as const;

const PIPELINE_NUMS = [
	{ key: "extractionTimeout", label: "Extraction timeout (ms)" },
	{ key: "workerPollMs", label: "Worker poll (ms)" },
	{ key: "workerMaxRetries", label: "Worker max retries" },
	{ key: "leaseTimeoutMs", label: "Lease timeout (ms)" },
	{ key: "minFactConfidenceForWrite", label: "Min fact confidence", min: 0, max: 1, step: 0.05 },
	{ key: "graphBoostWeight", label: "Graph boost weight", min: 0, max: 1, step: 0.05 },
	{ key: "maintenanceIntervalMs", label: "Maintenance interval (ms)" },
	{ key: "rerankerTopN", label: "Reranker top N" },
	{ key: "rerankerTimeoutMs", label: "Reranker timeout (ms)" },
] as const;

let yamlFiles = $derived(
	configFiles?.filter((f) => f.name.endsWith(".yaml") || f.name.endsWith(".yml")) ?? [],
);

let selectedYaml = $state("");

$effect(() => {
	if (yamlFiles.length && !yamlFiles.some((f) => f.name === selectedYaml)) {
		const preferred = yamlFiles.find((f) => f.name === "agent.yaml");
		selectedYaml = preferred ? preferred.name : (yamlFiles[0]?.name ?? "");
	}
});

let activeFile = $derived(yamlFiles.find((f) => f.name === selectedYaml));

type YamlValue = string | number | boolean | null | YamlObject | YamlValue[];
type YamlObject = { [key: string]: YamlValue };

let form = $state<YamlObject>({});

$effect(() => {
	if (activeFile?.content) {
		try {
			const parsed = parse(activeFile.content) as YamlObject;
			form = JSON.parse(JSON.stringify(parsed ?? {})) as YamlObject;
		} catch {
			form = {};
		}
	} else {
		form = {};
	}
});

function get(obj: YamlObject, ...path: string[]): YamlValue {
	let cur: YamlValue = obj;
	for (const key of path) {
		if (cur == null || typeof cur !== "object" || Array.isArray(cur)) return null;
		cur = (cur as YamlObject)[key] ?? null;
	}
	return cur;
}

function set(path: string[], value: YamlValue): void {
	let cur: YamlObject = form;
	for (let i = 0; i < path.length - 1; i++) {
		const key = path[i];
		if (cur[key] == null || typeof cur[key] !== "object" || Array.isArray(cur[key])) {
			cur[key] = {};
		}
		cur = cur[key] as YamlObject;
	}
	cur[path[path.length - 1]] = value;
}

const str = (path: string[]) => String(get(form, ...path) ?? "");
const num = (path: string[]) => { const v = get(form, ...path); return typeof v === "number" ? v : (v ? Number(v) : ""); };
const bool = (path: string[]) => Boolean(get(form, ...path));

const onStr = (path: string[]) => (e: Event) => set(path, (e.target as HTMLInputElement).value);
const onNum = (path: string[]) => (e: Event) => { const v = (e.target as HTMLInputElement).value; set(path, v === "" ? null : Number(v)); };
const onBool = (path: string[]) => (e: Event) => set(path, (e.target as HTMLInputElement).checked);

function harnessArray(): string[] {
	const v = get(form, "harnesses");
	return Array.isArray(v) ? v.map(String) : [];
}

function toggleHarness(name: string, checked: boolean): void {
	const arr = harnessArray();
	set(["harnesses"], checked ? [...arr, name] : arr.filter((h) => h !== name));
}

let customHarnessInput = $state("");

function addCustomHarness(): void {
	const name = customHarnessInput.trim();
	if (!name) return;
	const arr = harnessArray();
	if (!arr.includes(name)) set(["harnesses"], [...arr, name]);
	customHarnessInput = "";
}

function formatDate(raw: YamlValue): string {
	if (!raw) return "";
	try { return new Date(String(raw)).toLocaleString(); } catch { return String(raw); }
}

let showRegistry = $derived(str(["trust", "verification"]) === "registry");
let saving = $state(false);

async function saveSettings(): Promise<void> {
	saving = true;
	try {
		const ok = await saveConfigFile(selectedYaml, stringify(form));
		toast(ok ? `${selectedYaml} saved` : "Failed to save settings", ok ? "success" : "error");
	} catch (err) {
		toast(`Error: ${String(err)}`, "error");
	} finally {
		saving = false;
	}
}
</script>

<div class="settings-tab">
	{#if yamlFiles.length === 0}
		<div class="empty-state">No YAML config files found</div>
	{:else}
		{#if yamlFiles.length > 1}
			<nav class="file-nav">
				{#each yamlFiles as file (file.name)}
					<button
						class="file-btn"
						class:active={file.name === selectedYaml}
						onclick={() => { selectedYaml = file.name; }}
					>
						{file.name}
					</button>
				{/each}
			</nav>
		{/if}

		<div class="form-body">

			<FormSection title="Agent">
				{#snippet children()}
					<FormField label="Name">
						{#snippet children()}
							<input type="text" class="inp" value={str(["agent", "name"])} oninput={onStr(["agent", "name"])} />
						{/snippet}
					</FormField>
					<FormField label="Description">
						{#snippet children()}
							<textarea class="inp ta" rows={3} value={str(["agent", "description"])} oninput={onStr(["agent", "description"])}></textarea>
						{/snippet}
					</FormField>
					<FormField label="Created" description="Read-only">
						{#snippet children()}
							<input type="text" class="inp ro" readonly value={formatDate(get(form, "agent", "created"))} />
						{/snippet}
					</FormField>
					<FormField label="Updated" description="Read-only">
						{#snippet children()}
							<input type="text" class="inp ro" readonly value={formatDate(get(form, "agent", "updated"))} />
						{/snippet}
					</FormField>
				{/snippet}
			</FormSection>

			<FormSection title="Harnesses" defaultOpen={false}>
				{#snippet children()}
					<FormField label="Active harnesses">
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
										<input type="checkbox" checked={true} onchange={() => set(["harnesses"], harnessArray().filter((x) => x !== h))} />
										<span>{h} <em class="custom-tag">custom</em></span>
									</label>
								{/each}
							</div>
						{/snippet}
					</FormField>
					<FormField label="Add custom harness">
						{#snippet children()}
							<div class="inline-add">
								<input type="text" class="inp" placeholder="harness-name" bind:value={customHarnessInput} onkeydown={(e) => { if (e.key === "Enter") addCustomHarness(); }} />
								<button class="btn-add" onclick={addCustomHarness}>Add</button>
							</div>
						{/snippet}
					</FormField>
				{/snippet}
			</FormSection>

			<FormSection title="Embedding" defaultOpen={false}>
				{#snippet children()}
					<FormField label="Provider">
						{#snippet children()}
							<select class="inp sel" value={str(["embedding", "provider"])} onchange={onStr(["embedding", "provider"])}>
								<option value="">— select —</option>
								<option value="ollama">ollama</option>
								<option value="openai">openai</option>
							</select>
						{/snippet}
					</FormField>
					<FormField label="Model">
						{#snippet children()}
							<input type="text" class="inp" value={str(["embedding", "model"])} oninput={onStr(["embedding", "model"])} />
						{/snippet}
					</FormField>
					<FormField label="Dimensions">
						{#snippet children()}
							<input type="number" class="inp" value={num(["embedding", "dimensions"])} oninput={onNum(["embedding", "dimensions"])} />
						{/snippet}
					</FormField>
					<FormField label="Base URL">
						{#snippet children()}
							<input type="text" class="inp" value={str(["embedding", "base_url"])} oninput={onStr(["embedding", "base_url"])} />
						{/snippet}
					</FormField>
					<FormField label="API Key">
						{#snippet children()}
							<input type="password" class="inp" value={str(["embedding", "api_key"])} oninput={onStr(["embedding", "api_key"])} />
						{/snippet}
					</FormField>
				{/snippet}
			</FormSection>

			<FormSection title="Search" defaultOpen={false}>
				{#snippet children()}
					<FormField label="Alpha" description="0 = keyword, 1 = vector">
						{#snippet children()}
							<input type="number" class="inp" min="0" max="1" step="0.1" value={num(["search", "alpha"])} oninput={onNum(["search", "alpha"])} />
						{/snippet}
					</FormField>
					<FormField label="Top K">
						{#snippet children()}
							<input type="number" class="inp" value={num(["search", "top_k"])} oninput={onNum(["search", "top_k"])} />
						{/snippet}
					</FormField>
					<FormField label="Min Score" description="Relevance threshold (0–1)">
						{#snippet children()}
							<input type="number" class="inp" min="0" max="1" step="0.1" value={num(["search", "min_score"])} oninput={onNum(["search", "min_score"])} />
						{/snippet}
					</FormField>
				{/snippet}
			</FormSection>

			<FormSection title="Memory" defaultOpen={false}>
				{#snippet children()}
					<FormField label="Database path">
						{#snippet children()}
							<input type="text" class="inp" value={str(["memory", "database"])} oninput={onStr(["memory", "database"])} />
						{/snippet}
					</FormField>
					<FormField label="Vectors path">
						{#snippet children()}
							<input type="text" class="inp" value={str(["memory", "vectors"])} oninput={onStr(["memory", "vectors"])} />
						{/snippet}
					</FormField>
					<FormField label="Session budget">
						{#snippet children()}
							<input type="number" class="inp" value={num(["memory", "session_budget"])} oninput={onNum(["memory", "session_budget"])} />
						{/snippet}
					</FormField>
					<FormField label="Decay rate" description="(0–1)">
						{#snippet children()}
							<input type="number" class="inp" min="0" max="1" step="0.01" value={num(["memory", "decay_rate"])} oninput={onNum(["memory", "decay_rate"])} />
						{/snippet}
					</FormField>
				{/snippet}
			</FormSection>

			<FormSection title="Pipeline" defaultOpen={false}>
				{#snippet children()}
					{#each PIPELINE_BOOLS as flag (flag)}
						<FormField label={flag}>
							{#snippet children()}
								<label class="toggle">
									<input type="checkbox" checked={bool(["pipeline", flag])} onchange={onBool(["pipeline", flag])} />
									<span class="toggle-track"><span class="toggle-thumb"></span></span>
								</label>
							{/snippet}
						</FormField>
					{/each}

					<FormField label="Extraction provider">
						{#snippet children()}
							<select class="inp sel" value={str(["pipeline", "extractionProvider"])} onchange={onStr(["pipeline", "extractionProvider"])}>
								<option value="">— select —</option>
								<option value="ollama">ollama</option>
								<option value="claude-code">claude-code</option>
							</select>
						{/snippet}
					</FormField>
					<FormField label="Extraction model">
						{#snippet children()}
							<input type="text" class="inp" value={str(["pipeline", "extractionModel"])} oninput={onStr(["pipeline", "extractionModel"])} />
						{/snippet}
					</FormField>
					<FormField label="Maintenance mode">
						{#snippet children()}
							<select class="inp sel" value={str(["pipeline", "maintenanceMode"])} onchange={onStr(["pipeline", "maintenanceMode"])}>
								<option value="">— select —</option>
								<option value="observe">observe</option>
								<option value="execute">execute</option>
							</select>
						{/snippet}
					</FormField>
					<FormField label="Reranker model">
						{#snippet children()}
							<input type="text" class="inp" value={str(["pipeline", "rerankerModel"])} oninput={onStr(["pipeline", "rerankerModel"])} />
						{/snippet}
					</FormField>

					{#each PIPELINE_NUMS as { key, label, min, max, step } (key)}
						<FormField {label}>
							{#snippet children()}
								<input
									type="number"
									class="inp"
									{min}
									{max}
									{step}
									value={num(["pipeline", key])}
									oninput={onNum(["pipeline", key])}
								/>
							{/snippet}
						</FormField>
					{/each}
				{/snippet}
			</FormSection>

			<FormSection title="Trust" defaultOpen={false}>
				{#snippet children()}
					<FormField label="Verification">
						{#snippet children()}
							<select class="inp sel" value={str(["trust", "verification"])} onchange={onStr(["trust", "verification"])}>
								<option value="">— select —</option>
								{#each ["none", "erc8128", "gpg", "did", "registry"] as v (v)}
									<option value={v}>{v}</option>
								{/each}
							</select>
						{/snippet}
					</FormField>
					{#if showRegistry}
						<FormField label="Registry URL">
							{#snippet children()}
								<input type="text" class="inp" value={str(["trust", "registry"])} oninput={onStr(["trust", "registry"])} />
							{/snippet}
						</FormField>
					{/if}
				{/snippet}
			</FormSection>

			<FormSection title="Auth" defaultOpen={false}>
				{#snippet children()}
					<FormField label="Method">
						{#snippet children()}
							<select class="inp sel" value={str(["auth", "method"])} onchange={onStr(["auth", "method"])}>
								<option value="">— select —</option>
								{#each ["none", "erc8128", "gpg", "did"] as v (v)}
									<option value={v}>{v}</option>
								{/each}
							</select>
						{/snippet}
					</FormField>
					<FormField label="Mode">
						{#snippet children()}
							<select class="inp sel" value={str(["auth", "mode"])} onchange={onStr(["auth", "mode"])}>
								<option value="">— select —</option>
								{#each ["local", "team", "hybrid"] as v (v)}
									<option value={v}>{v}</option>
								{/each}
							</select>
						{/snippet}
					</FormField>
					<FormField label="Chain ID">
						{#snippet children()}
							<input type="number" class="inp" value={num(["auth", "chainId"])} oninput={onNum(["auth", "chainId"])} />
						{/snippet}
					</FormField>
				{/snippet}
			</FormSection>

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

	.file-nav {
		display: flex;
		padding: 0 var(--space-md);
		border-bottom: 1px solid var(--sig-border);
		flex-shrink: 0;
		overflow-x: auto;
	}

	.file-btn {
		font-family: var(--font-mono);
		font-size: 10px;
		letter-spacing: 0.04em;
		color: var(--sig-text-muted);
		background: none;
		border: none;
		border-bottom: 1px solid transparent;
		padding: 8px 12px;
		cursor: pointer;
		white-space: nowrap;
		transition: color var(--dur) var(--ease), border-color var(--dur) var(--ease);
	}

	.file-btn:hover { color: var(--sig-text); }
	.file-btn.active { color: var(--sig-text-bright); border-bottom-color: var(--sig-text-bright); }

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

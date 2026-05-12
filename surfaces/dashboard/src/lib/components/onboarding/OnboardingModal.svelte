<script lang="ts">
import { invalidateAll } from "$app/navigation";
import type { ConfigFile, DaemonStatus, MemoryStats } from "$lib/api";
import { applyRecommendedPipelineSetup } from "$lib/components/tabs/settings/pipeline-settings";
import { Button } from "$lib/components/ui/button/index.js";
import { Input } from "$lib/components/ui/input/index.js";
import * as Select from "$lib/components/ui/select/index.js";
import type { TabId } from "$lib/stores/navigation.svelte";
import { st } from "$lib/stores/settings.svelte";
import { toast } from "$lib/stores/toast.svelte";
import type { PipelineProviderChoice } from "@signet/core/pipeline-providers";
import { onMount, untrack } from "svelte";

interface Props {
	configFiles: ConfigFile[];
	memoryStats: MemoryStats;
	daemonStatus: DaemonStatus | null;
	onnavigate?: (tab: TabId) => void;
}

const { configFiles, memoryStats, daemonStatus, onnavigate }: Props = $props();

const selectTriggerClass =
	"font-mono text-[11px] text-[var(--sig-text)] bg-[var(--sig-bg)] border-[var(--sig-border-strong)] rounded-md w-full h-9 px-2 box-border focus-visible:border-[var(--sig-accent)]";
const selectContentClass =
	"font-mono text-[11px] bg-[var(--sig-bg)] text-[var(--sig-text)] border-[var(--sig-border-strong)] rounded-md";
const selectItemClass = "font-mono text-[11px] rounded-md";

const PROVIDERS: Array<{ value: PipelineProviderChoice; label: string; model: string; note: string }> = [
	{
		value: "acpx",
		label: "ACPX — use existing agent CLI",
		model: "gpt-5-codex-mini",
		note: "Best default if Codex/Claude/OpenCode is already configured.",
	},
	{
		value: "llama-cpp",
		label: "llama.cpp — local",
		model: "qwen3.5:4b",
		note: "Local extraction; needs a llama.cpp server.",
	},
	{
		value: "ollama",
		label: "Ollama — local",
		model: "qwen3:4b",
		note: "Local extraction; needs Ollama and the model installed.",
	},
	{
		value: "none",
		label: "Disable background extraction",
		model: "",
		note: "Safe choice for VPS/shared installs or testing the shell only.",
	},
];

let open = $state(false);
let initialized = $state(false);
let saving = $state(false);
let agentName = $state("My Agent");
let agentDescription = $state("Personal AI assistant");
let provider = $state<PipelineProviderChoice>("acpx");
let model = $state("gpt-5-codex-mini");
let forceOpen = false;

const storageKey = $derived(`signet:onboarding:dismissed:${daemonStatus?.agentsDir ?? "unknown"}`);
const providerNote = $derived(PROVIDERS.find((option) => option.value === provider)?.note ?? "");

function currentProvider(): PipelineProviderChoice {
	const raw = st.aStr(["memory", "pipelineV2", "extractionProvider"]);
	return PROVIDERS.some((option) => option.value === raw) ? (raw as PipelineProviderChoice) : "acpx";
}

function hydrateFromSettings(): void {
	st.init(configFiles);
	agentName = st.aStr(["agent", "name"]) || st.aStr(["name"]) || "My Agent";
	agentDescription = st.aStr(["agent", "description"]) || st.aStr(["description"]) || "Personal AI assistant";
	provider = currentProvider();
	model =
		st.aStr(["memory", "pipelineV2", "extractionModel"]) ||
		PROVIDERS.find((option) => option.value === provider)?.model ||
		"";
	initialized = true;
}

function isDefaultishWorkspace(): boolean {
	const name = agentName.trim().toLowerCase();
	return memoryStats.total === 0 && (name === "my agent" || name.length === 0);
}

function maybeOpen(): void {
	if (typeof window === "undefined") return;
	if (!initialized || !daemonStatus) return;
	if (forceOpen) {
		open = true;
		return;
	}
	if (localStorage.getItem(storageKey) === "true") return;
	if (isDefaultishWorkspace()) open = true;
}

onMount(() => {
	forceOpen = new URLSearchParams(window.location.search).get("onboarding") === "1";
	untrack(hydrateFromSettings);
	maybeOpen();
});

$effect(() => {
	const _configFiles = configFiles;
	untrack(hydrateFromSettings);
});

$effect(() => {
	const _daemonStatus = daemonStatus;
	const _memoryTotal = memoryStats.total;
	void _daemonStatus;
	void _memoryTotal;
	maybeOpen();
});

function setProvider(value: string | undefined): void {
	const next = PROVIDERS.find((option) => option.value === value);
	if (!next) return;
	provider = next.value;
	model = next.model;
}

function dismiss(): void {
	localStorage.setItem(storageKey, "true");
	open = false;
}

function openSettings(): void {
	dismiss();
	onnavigate?.("settings");
}

async function finish(): Promise<void> {
	if (saving) return;
	saving = true;
	try {
		st.aSetStr(["agent", "name"], agentName.trim() || "My Agent");
		st.aSetStr(["agent", "description"], agentDescription.trim() || "Personal AI assistant");
		applyRecommendedPipelineSetup(st.agent, { provider, model });
		st.agent = { ...st.agent };
		await st.save();
		localStorage.setItem(storageKey, "true");
		open = false;
		await invalidateAll();
		toast("Onboarding settings saved", "success");
	} finally {
		saving = false;
	}
}
</script>

{#if open}
	<div class="onboarding-backdrop" role="presentation">
		<div class="onboarding-modal" role="dialog" aria-modal="true" aria-labelledby="onboarding-title" tabindex="-1">
			<div class="onboarding-rail" aria-hidden="true"></div>
			<header class="onboarding-header">
				<div>
					<p class="onboarding-kicker">First run</p>
					<h2 id="onboarding-title">Set up your Signet workspace</h2>
				</div>
				<button class="icon-button" type="button" aria-label="Dismiss onboarding" onclick={dismiss}>×</button>
			</header>

			<div class="onboarding-grid">
				<label class="field">
					<span>Agent name</span>
					<Input bind:value={agentName} placeholder="My Agent" />
				</label>

				<label class="field">
					<span>Agent description</span>
					<Input bind:value={agentDescription} placeholder="Personal AI assistant" />
				</label>

				<div class="field field-wide">
					<span>Memory extraction provider</span>
					<Select.Root type="single" value={provider} onValueChange={setProvider}>
						<Select.Trigger class={selectTriggerClass}>
							{PROVIDERS.find((option) => option.value === provider)?.label ?? provider}
						</Select.Trigger>
						<Select.Content class={selectContentClass}>
							{#each PROVIDERS as option (option.value)}
								<Select.Item class={selectItemClass} value={option.value} label={option.label} />
							{/each}
						</Select.Content>
					</Select.Root>
					<small>{providerNote}</small>
				</div>

				<label class="field field-wide">
					<span>Model</span>
					<Input bind:value={model} placeholder={provider === "none" ? "disabled" : "model id"} disabled={provider === "none"} />
				</label>
			</div>

			<div class="onboarding-copy">
				<p>These choices write the existing <code>agent.yaml</code> identity and <code>memory.pipelineV2</code> provider settings. No separate dashboard-only ACPX routing gets created.</p>
			</div>

			<footer class="onboarding-actions">
				<Button variant="ghost" type="button" onclick={openSettings}>Open full settings</Button>
				<div class="action-cluster">
					<Button variant="outline" type="button" onclick={dismiss}>Skip for now</Button>
					<Button type="button" onclick={finish} disabled={saving}>{saving ? "Saving…" : "Save and start"}</Button>
				</div>
			</footer>
		</div>
	</div>
{/if}

<style>
	.onboarding-backdrop {
		position: fixed;
		inset: 0;
		z-index: 90;
		display: grid;
		place-items: center;
		padding: 24px;
		background:
			linear-gradient(135deg, color-mix(in srgb, var(--sig-bg), transparent 8%), color-mix(in srgb, var(--sig-bg), transparent 24%)),
			rgba(0, 0, 0, 0.55);
		backdrop-filter: blur(8px);
	}

	.onboarding-modal {
		position: relative;
		width: min(720px, 100%);
		border: 1px solid var(--sig-border-strong);
		border-radius: 0;
		background: color-mix(in srgb, var(--sig-surface), var(--sig-bg) 18%);
		box-shadow: 0 24px 80px rgba(0, 0, 0, 0.5);
		overflow: hidden;
	}

	.onboarding-rail {
		position: absolute;
		inset: 0 auto 0 0;
		width: 4px;
		background: var(--sig-highlight);
		box-shadow: 0 0 24px color-mix(in srgb, var(--sig-highlight), transparent 40%);
	}

	.onboarding-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 16px;
		padding: 22px 24px 16px 28px;
		border-bottom: 1px solid var(--sig-border);
	}

	.onboarding-kicker,
	.field > span {
		margin: 0 0 6px;
		font-family: var(--font-mono, monospace);
		font-size: 10px;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--sig-highlight);
	}

	h2 {
		margin: 0;
		font-family: var(--font-heading, inherit);
		font-size: 24px;
		letter-spacing: -0.02em;
		color: var(--sig-text-bright);
	}

	.icon-button {
		border: 1px solid var(--sig-border-strong);
		background: transparent;
		color: var(--sig-text-muted);
		font-size: 20px;
		line-height: 1;
		width: 32px;
		height: 32px;
		cursor: pointer;
	}

	.icon-button:hover {
		color: var(--sig-text-bright);
		border-color: var(--sig-highlight);
	}

	.onboarding-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 14px;
		padding: 20px 24px 10px 28px;
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.field-wide {
		grid-column: 1 / -1;
	}

	small {
		font-size: 11px;
		line-height: 1.4;
		color: var(--sig-text-muted);
	}

	.onboarding-copy {
		padding: 4px 24px 0 28px;
		font-size: 12px;
		line-height: 1.55;
		color: var(--sig-text-muted);
	}

	code {
		font-family: var(--font-mono, monospace);
		font-size: 11px;
		color: var(--sig-highlight);
	}

	.onboarding-actions {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 18px 24px 22px 28px;
	}

	.action-cluster {
		display: flex;
		gap: 10px;
	}

	@media (max-width: 640px) {
		.onboarding-grid {
			grid-template-columns: 1fr;
		}

		.onboarding-actions {
			align-items: stretch;
			flex-direction: column-reverse;
		}

		.action-cluster {
			flex-direction: column;
		}
	}
</style>

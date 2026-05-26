<script lang="ts">
	import type { Harness } from "$lib/api";
	import { Checkbox } from "$lib/components/ui/checkbox/index.js";
	import { Input } from "$lib/components/ui/input/index.js";
	import { Textarea } from "$lib/components/ui/textarea/index.js";
	import { KNOWN_HARNESSES } from "$lib/stores/settings.svelte";
	import type { OnboardingState } from "../onboarding-state.svelte";

	interface Props {
		state: OnboardingState;
		harnesses?: Harness[];
	}

	const { state, harnesses = [] }: Props = $props();

	const harnessOptions = $derived.by(() => {
		const fromApi = harnesses.map((h) => h.id || h.name).filter(Boolean);
		const combined = [...new Set([...fromApi, ...KNOWN_HARNESSES])];
		return combined.map((id) => ({
			id,
			meta: harnesses.find((h) => h.id === id || h.name === id),
		}));
	});

	function toggleHarness(id: string, checked: boolean | string): void {
		if (checked) {
			state.selectedHarnesses = [...new Set([...state.selectedHarnesses, id])];
			if (!state.selectedHarness) state.selectedHarness = id;
			return;
		}
		state.selectedHarnesses = state.selectedHarnesses.filter((h) => h !== id);
		if (state.selectedHarness === id) state.selectedHarness = state.selectedHarnesses[0] ?? "";
	}

	export function validate(): string[] {
		const errors: string[] = [];
		if (!state.agentName.trim()) errors.push("Agent name is required.");
		if (state.selectedHarnesses.length === 0) errors.push("Select at least one harness.");
		return errors;
	}
</script>

<div class="identity-fields">
	<div class="field-grid">
		<label class="field">
			<span class="field-label">Name</span>
			<Input class="onboarding-input" bind:value={state.agentName} placeholder="Dot" />
		</label>
		<label class="field field-wide">
			<span class="field-label">Description</span>
			<Textarea
				class="onboarding-input onboarding-textarea"
				rows={2}
				bind:value={state.agentDescription}
				placeholder="A portable memory agent for..."
			/>
		</label>
	</div>

	<div class="harness-section">
		<span class="field-label">Harnesses</span>
		<div class="harness-list">
			{#each harnessOptions as h (h.id)}
				<label
					class="harness-row sig-switch"
					class:harness-row-active={state.selectedHarnesses.includes(h.id)}
				>
					<Checkbox
						checked={state.selectedHarnesses.includes(h.id)}
						onCheckedChange={(checked) => toggleHarness(h.id, checked)}
					/>
					<span class="status-dot" class:status-dot-installed={h.meta?.exists}></span>
					<span class="harness-main">
						<strong>{h.id}</strong>
						<small>{h.meta?.path ?? "known harness"}</small>
					</span>
					<span class="harness-state">{h.meta?.exists ? "installed" : "not found"}</span>
				</label>
			{/each}
		</div>
	</div>
</div>

<style>
	.identity-fields {
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.field-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 10px;
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 7px;
	}

	.field-wide {
		grid-column: 1 / -1;
	}

	.field-label {
		font-family: var(--font-mono, monospace);
		font-size: 10px;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--sig-text-muted);
	}

	:global(.onboarding-input) {
		border-radius: var(--sig-radius) !important;
		border-color: var(--sig-border-strong) !important;
		background: color-mix(in srgb, var(--sig-bg), transparent 6%) !important;
		color: var(--sig-text-bright) !important;
		font-family: var(--font-mono, monospace) !important;
		box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.28) !important;
	}

	:global(.onboarding-textarea) {
		min-height: 48px !important;
		resize: vertical;
	}

	.harness-section {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.harness-list {
		display: flex;
		flex-direction: column;
		gap: 4px;
		max-height: 240px;
		overflow: auto;
		padding-right: 2px;
	}

	.harness-row {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 8px 10px;
		cursor: pointer;
		border: 1px solid transparent;
		border-radius: var(--sig-radius);
		transition: background var(--dur) var(--ease), border-color var(--dur) var(--ease);
	}

	.harness-row-active {
		border-color: var(--sig-highlight-dim);
		background: var(--sig-highlight-muted);
		box-shadow: inset 3px 0 0 var(--sig-highlight),
			inset 0 1px 0 rgba(255, 255, 255, 0.05);
	}

	.status-dot {
		width: 8px;
		height: 8px;
		border: 1px solid var(--sig-text-muted);
		background: transparent;
		flex: 0 0 auto;
	}

	.status-dot-installed {
		border-color: var(--sig-success);
		background: var(--sig-success);
		box-shadow: 0 0 8px color-mix(in srgb, var(--sig-success), transparent 40%);
	}

	.harness-main {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
		flex: 1;
	}

	.harness-main strong {
		font-size: 13px;
		color: var(--sig-text-bright);
	}

	.harness-main small {
		font-size: 12px;
		line-height: 1.35;
		color: var(--sig-text-muted);
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.harness-state {
		font-family: var(--font-mono, monospace);
		font-size: 10px;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--sig-text-muted);
		flex: 0 0 auto;
	}

	@media (max-width: 620px) {
		.field-grid {
			grid-template-columns: 1fr;
		}
	}
</style>

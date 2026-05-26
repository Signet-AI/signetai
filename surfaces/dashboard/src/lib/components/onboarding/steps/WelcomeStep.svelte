<script lang="ts">
	import { IDENTITY_PRESET_META, type IdentityPresetName, type OnboardingState } from "../onboarding-state.svelte";

	interface Props {
		state: OnboardingState;
	}

	const { state }: Props = $props();

	const PRESET_META = IDENTITY_PRESET_META;

	function selectPreset(name: IdentityPresetName): void {
		state.identityPreset = name;
	}
</script>

<div class="welcome-grid">
	<p class="welcome-intro">
		Choose an identity preset. This determines which files load at startup and shapes how your agent
		thinks. You can change it later in Settings.
	</p>

	{#each PRESET_META as preset (preset.name)}
		<button
			type="button"
			class="preset-card sig-switch"
			class:preset-card-active={state.identityPreset === preset.name}
			onclick={() => selectPreset(preset.name)}
			aria-pressed={state.identityPreset === preset.name}
		>
			<span class="preset-radio" aria-hidden="true"></span>
			<div class="preset-content">
				<div class="preset-header">
					<strong>{preset.title}</strong>
					{#if state.identityPreset === preset.name}
						<span class="selected-badge">selected</span>
					{/if}
				</div>
				<p>{preset.subtitle}</p>
				<span class="preset-files">{preset.files}</span>
			</div>
		</button>
	{/each}
</div>

<style>
	.welcome-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 12px;
	}

	.welcome-intro {
		grid-column: 1 / -1;
		margin: 0 0 4px;
		font-size: 13px;
		line-height: 1.4;
		color: var(--sig-text);
	}

	.preset-card {
		position: relative;
		padding: 14px 14px 14px 36px;
		text-align: left;
		cursor: pointer;
		border: 1px solid var(--sig-border-strong);
		border-radius: var(--sig-radius);
		background: color-mix(in srgb, var(--sig-surface), transparent 5%);
		color: var(--sig-text);
		transition: border-color var(--dur) var(--ease), background var(--dur) var(--ease),
			box-shadow var(--dur) var(--ease);
	}

	.preset-card:hover {
		border-color: var(--sig-highlight);
		background: color-mix(in srgb, var(--sig-surface), var(--sig-highlight) 4%);
	}

	.preset-card-active {
		border-color: var(--sig-highlight);
		background: color-mix(in srgb, var(--sig-surface-raised), var(--sig-highlight) 10%);
		box-shadow: var(--sig-glow-highlight), inset 3px 0 0 var(--sig-highlight),
			inset 0 1px 0 rgba(255, 255, 255, 0.08);
	}

	.preset-radio {
		position: absolute;
		top: 16px;
		left: 12px;
		width: 13px;
		height: 13px;
		border: 1px solid var(--sig-border-strong);
		background: var(--sig-bg);
		border-radius: 50%;
	}

	.preset-card-active .preset-radio {
		border-color: var(--sig-highlight);
		background: var(--sig-highlight);
		box-shadow: inset 0 0 0 3px var(--sig-bg),
			0 0 10px color-mix(in srgb, var(--sig-highlight), transparent 36%);
	}

	.preset-content {
		display: flex;
		flex-direction: column;
		gap: 5px;
	}

	.preset-header {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.preset-header strong {
		font-family: var(--font-display, monospace);
		font-size: 13px;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--sig-text-bright);
	}

	.selected-badge {
		font-family: var(--font-mono, monospace);
		font-size: 9px;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--sig-highlight-text);
	}

	.preset-content p {
		margin: 0;
		font-size: 12px;
		line-height: 1.35;
		color: var(--sig-text-muted);
	}

	.preset-files {
		font-family: var(--font-mono, monospace);
		font-size: 10px;
		letter-spacing: 0.04em;
		color: var(--sig-text-muted);
		opacity: 0.7;
	}

	@media (max-width: 620px) {
		.welcome-grid {
			grid-template-columns: 1fr;
		}
	}
</style>

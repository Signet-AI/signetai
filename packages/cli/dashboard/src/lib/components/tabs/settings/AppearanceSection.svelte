<script lang="ts">
	import FormField from "$lib/components/config/FormField.svelte";
	import FormSection from "$lib/components/config/FormSection.svelte";
	import { titlebar, type DecorationMode } from "$lib/stores/titlebar.svelte";
	import { uiScale } from "$lib/stores/ui-scale.svelte";
	import AppWindowMac from "@lucide/svelte/icons/app-window-mac";
	import Monitor from "@lucide/svelte/icons/monitor";
	import EyeOff from "@lucide/svelte/icons/eye-off";
	import ZoomIn from "@lucide/svelte/icons/zoom-in";
	import ZoomOut from "@lucide/svelte/icons/zoom-out";
	import RotateCcw from "@lucide/svelte/icons/rotate-ccw";

	const isTauri =
		typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

	const modes: { id: DecorationMode; label: string; icon: typeof Monitor; desc: string }[] = [
		{ id: "macos", label: "macOS", icon: AppWindowMac, desc: "Traffic light buttons, centered title" },
		{ id: "windows", label: "Windows", icon: Monitor, desc: "Minimize / maximize / close on right" },
		{ id: "none", label: "None", icon: EyeOff, desc: "No window titlebar" },
	];
</script>

<FormSection description="Local display preferences. These settings are stored in your browser and not synced.">
	{#if isTauri}
		<FormField label="Window decorations" description="Controls how the window titlebar and controls are rendered.">
			<div class="mode-grid">
				{#each modes as mode (mode.id)}
					<button
						type="button"
						class="mode-card"
						class:mode-card--active={titlebar.mode === mode.id}
						aria-pressed={titlebar.mode === mode.id}
						onclick={() => (titlebar.mode = mode.id)}
					>
						<div class="mode-icon">
							<mode.icon size={18} />
						</div>
						<div class="mode-info">
							<span class="mode-label">{mode.label}</span>
							<span class="mode-desc">{mode.desc}</span>
						</div>
					</button>
				{/each}
			</div>
		</FormField>
	{:else}
		<FormField label="Window decorations" description="Only available in the desktop app.">
			<span class="not-available">Run Signet as a desktop app to configure window decorations.</span>
		</FormField>
	{/if}

	<FormField label="UI scale" description="Adjust text and spacing size. Icons remain crisp at all levels. Ctrl+/- or Ctrl+0 to reset.">
		<div class="scale-control">
			<button class="scale-btn" onclick={() => uiScale.zoomOut()} title="Zoom out (Ctrl+-)" aria-label="Zoom out">
				<ZoomOut size={14} />
			</button>
			<span class="scale-value">{uiScale.percent}</span>
			<button class="scale-btn" onclick={() => uiScale.zoomIn()} title="Zoom in (Ctrl+=)" aria-label="Zoom in">
				<ZoomIn size={14} />
			</button>
			<button class="scale-btn scale-btn--reset" onclick={() => uiScale.reset()} title="Reset (Ctrl+0)" aria-label="Reset zoom">
				<RotateCcw size={12} />
			</button>
		</div>
	</FormField>
</FormSection>

<style>
	.mode-grid {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.mode-card {
		display: flex;
		align-items: center;
		gap: var(--space-sm);
		padding: 10px 12px;
		background: var(--sig-bg);
		border: 1px solid var(--sig-border);
		border-radius: 6px;
		cursor: pointer;
		transition: border-color 0.15s, background 0.15s;
		text-align: left;
	}

	.mode-card:hover {
		border-color: var(--sig-border-strong);
		background: var(--sig-surface);
	}

	.mode-card--active {
		border-color: var(--sig-highlight);
		background: color-mix(in srgb, var(--sig-highlight), var(--sig-bg) 94%);
	}

	.mode-card--active:hover {
		border-color: var(--sig-highlight);
	}

	.mode-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 32px;
		height: 32px;
		flex-shrink: 0;
		color: var(--sig-text-muted);
		border-radius: 4px;
	}

	.mode-card--active .mode-icon {
		color: var(--sig-highlight);
	}

	.mode-info {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.mode-label {
		font-family: var(--font-mono);
		font-size: 11px;
		font-weight: 600;
		color: var(--sig-text-bright);
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}

	.mode-desc {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--sig-text-muted);
	}

	.not-available {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--sig-text-muted);
	}

	.scale-control {
		display: flex;
		align-items: center;
		gap: 4px;
	}

	.scale-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 32px;
		height: 32px;
		border: 1px solid var(--sig-border);
		background: var(--sig-bg);
		color: var(--sig-text-muted);
		border-radius: 4px;
		cursor: pointer;
		transition: border-color 0.15s, color 0.15s, background 0.15s;
	}

	.scale-btn:hover {
		border-color: var(--sig-border-strong);
		color: var(--sig-text-bright);
		background: var(--sig-surface);
	}

	.scale-btn--reset {
		margin-left: 4px;
		width: 28px;
		height: 28px;
	}

	.scale-value {
		min-width: 48px;
		text-align: center;
		font-family: var(--font-mono);
		font-size: 12px;
		font-weight: 600;
		color: var(--sig-text-bright);
		letter-spacing: 0.04em;
	}
</style>

<script lang="ts">
type Section = "troubleshooter" | "logs";
const SECTION_SET = new Set<string>(["troubleshooter", "logs"]);

function readSection(): Section {
	if (typeof window === "undefined") return "troubleshooter";
	const hash = window.location.hash.replace("#", "");
	const parts = hash.split("/");
	if (parts[0] !== "audit") return "troubleshooter";
	if (parts[1] && SECTION_SET.has(parts[1])) return parts[1] as Section;
	return "troubleshooter";
}

let section = $state<Section>(readSection());

$effect(() => {
	if (typeof window === "undefined") return;
	const next = section === "troubleshooter" ? "audit" : `audit/${section}`;
	if (window.location.hash !== `#${next}`) {
		window.history.replaceState(null, "", `#${next}`);
	}
});

$effect(() => {
	if (typeof window === "undefined") return;
	const onHash = () => {
		const next = readSection();
		if (next === section) return;
		section = next;
	};
	window.addEventListener("hashchange", onHash);
	return () => window.removeEventListener("hashchange", onHash);
});

const btn =
	"px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.06em] rounded-md transition-colors duration-150 border-none cursor-pointer whitespace-nowrap";
const active = `${btn} text-[var(--sig-highlight)] bg-[color-mix(in_srgb,var(--sig-highlight),var(--sig-bg)_90%)] border border-[color-mix(in_srgb,var(--sig-highlight),transparent_85%)]`;
const idle = `${btn} bg-transparent text-[var(--sig-text-muted)] hover:text-[var(--sig-highlight)] hover:bg-[color-mix(in_srgb,var(--sig-highlight),var(--sig-bg)_94%)]`;
</script>

<div class="audit-tab">
	<header class="tab-header">
		<div class="tab-header-left">
			<span class="tab-header-title">AUDIT</span>
			<span class="tab-header-sep" aria-hidden="true"></span>
			<span class="tab-header-count">TROUBLESHOOTER + LOGS</span>
		</div>
		<div class="sub-group">
			<button class={section === "troubleshooter" ? active : idle} onclick={() => (section = "troubleshooter")}>
				TROUBLESHOOTER
			</button>
			<button class={section === "logs" ? active : idle} onclick={() => (section = "logs")}>
				LOGS
			</button>
		</div>
	</header>

	<div class="audit-content audit-embed">
		{#if section === "troubleshooter"}
			{#await import("$lib/components/cortex/TroubleshooterPanel.svelte")}
				<div class="audit-loading">Loading troubleshooter...</div>
			{:then mod}
				<mod.default />
			{:catch err}
				<div class="audit-error">Failed to load: {err?.message ?? "unknown"}</div>
			{/await}
		{:else}
			{#await import("$lib/components/tabs/LogsTab.svelte")}
				<div class="audit-loading">Loading logs...</div>
			{:then mod}
				<mod.default />
			{:catch err}
				<div class="audit-error">Failed to load: {err?.message ?? "unknown"}</div>
			{/await}
		{/if}
	</div>
</div>

<style>
	.audit-tab {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
		overflow: hidden;
	}

	.tab-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: 8px;
		padding: var(--space-sm) var(--space-md);
		border-bottom: 1px solid var(--sig-border);
		flex-shrink: 0;
	}

	.tab-header-left {
		display: flex;
		align-items: center;
		gap: var(--space-sm);
	}

	.tab-header-title {
		font-family: var(--font-display);
		font-size: 11px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.1em;
		color: var(--sig-text-bright);
	}

	.tab-header-count {
		font-family: var(--font-mono);
		font-size: 8px;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--sig-text-muted);
	}

	.tab-header-sep {
		width: 1px;
		height: 10px;
		background: var(--sig-border);
	}

	.sub-group {
		display: flex;
		align-items: center;
		gap: 2px;
		background: var(--sig-bg);
		border: 1px solid var(--sig-border);
		border-radius: 0.5rem;
		padding: 1px;
	}

	.audit-content {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
		overflow: hidden;
	}

	.audit-embed :global(.banner) {
		display: none;
	}

	.audit-loading {
		display: flex;
		align-items: center;
		justify-content: center;
		flex: 1;
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--sig-text-muted);
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}

	.audit-error {
		display: flex;
		align-items: center;
		justify-content: center;
		flex: 1;
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--sig-danger);
	}
</style>

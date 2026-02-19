<script lang="ts">
	import type { ConfigFile, Harness, Identity } from "$lib/api";

	interface Props {
		identity: Identity;
		harnesses: Harness[];
		configFiles: ConfigFile[];
		selectedFile: string;
		memCount: number;
		onselectfile: (name: string) => void;
	}

	let { identity, harnesses, configFiles, selectedFile, memCount, onselectfile }: Props = $props();

	function fmtSize(bytes: number): string {
		if (bytes < 1024) return `${bytes}B`;
		return `${(bytes / 1024).toFixed(1)}KB`;
	}
</script>

<aside class="sidebar sidebar-left">
	<!-- 01 // IDENTITY -->
	<section class="section section-panel">
		<div class="section-header">
			<span class="section-index">01</span>
			<span class="section-title">Identity</span>
			<span class="seal-indicator"></span>
		</div>
		<div class="agent-card">
			<div class="agent-name">{identity?.name ?? 'Unknown'}</div>
			{#if identity?.creature}
				<div class="agent-creature">{identity.creature}</div>
			{/if}
			<div class="agent-stats">
				<div class="agent-stat">
					<span class="agent-stat-value">{memCount}</span>
					<span class="agent-stat-label">MEM</span>
				</div>
				<div class="agent-stat">
					<span class="agent-stat-value">{harnesses?.length ?? 0}</span>
					<span class="agent-stat-label">CONN</span>
				</div>
			</div>
		</div>
	</section>

	<!-- 02 // CONNECTORS -->
	<section class="section section-panel">
		<div class="section-header">
			<span class="section-index">02</span>
			<span class="section-title">Connectors</span>
		</div>
		{#each harnesses ?? [] as harness}
			<div class="harness-row">
				<div class="seal-status" class:seal-status-active={harness.exists}></div>
				<span class="harness-name">{harness.name}</span>
				<span class="harness-badge">{harness.exists ? 'OK' : 'OFF'}</span>
			</div>
		{/each}
	</section>

	<!-- 03 // FILES -->
	<section class="section section-panel section-grow">
		<div class="section-header">
			<span class="section-index">03</span>
			<span class="section-title">Config Files</span>
		</div>
		<div class="file-list">
			{#each configFiles ?? [] as file}
				{@const active = selectedFile === file.name}
				<button
					class="file-item"
					class:file-item-active={active}
					onclick={() => onselectfile(file.name)}
				>
					<span class="file-name">{file.name}</span>
					<span class="file-meta">{fmtSize(file.size)}</span>
				</button>
			{/each}
		</div>
	</section>
</aside>

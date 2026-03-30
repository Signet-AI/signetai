<script lang="ts">
import type { TabId } from "$lib/stores/navigation.svelte";
import { PAGE_FOOTERS } from "./page-headers";

interface Props {
	activeTab: TabId;
	memoryFooterLabel: string;
	memorySearching: boolean;
	memorySimilarActive: boolean;
	timelineGeneratedFor: string;
	taskCount: number;
}

let { activeTab, memoryFooterLabel, memorySearching, memorySimilarActive, timelineGeneratedFor, taskCount }: Props =
	$props();

function formatTimelineGeneratedFor(value: string): string {
	if (!value) return "";
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed)) return "";
	return new Date(parsed).toLocaleString("en-US", {
		month: "short",
		day: "numeric",
		year: "numeric",
		hour: "numeric",
		minute: "2-digit",
		timeZone: "UTC",
	});
}

const staticFooter = $derived(PAGE_FOOTERS[activeTab]);

interface FooterSlot {
	left: string;
	right: string;
}

const content = $derived.by((): FooterSlot | null => {
	if (activeTab === "skills") return null;
	if (activeTab === "settings")
		return {
			left: "SETTINGS",
			right: "CTRL+S SAVE",
		};
	if (activeTab === "memory")
		return {
			left: memoryFooterLabel.toUpperCase(),
			right: memorySearching ? "SEARCHING" : memorySimilarActive ? "SIMILARITY" : "HYBRID INDEX",
		};
	if (activeTab === "timeline")
		return {
			left: "TIMELINE",
			right: timelineGeneratedFor ? formatTimelineGeneratedFor(timelineGeneratedFor).toUpperCase() : "EVOLUTION VIEW",
		};
	if (activeTab === "tasks")
		return {
			left: `${taskCount} TASKS`,
			right: "SCHEDULER",
		};
	if (staticFooter)
		return {
			left: staticFooter.left.toUpperCase(),
			right: staticFooter.right.toUpperCase(),
		};
	return null;
});
</script>

{#if content}
<div class="footer">
	<span class="footer-pip" aria-hidden="true"></span>
	<span class="footer-text">{content.left}</span>
	<span class="footer-fill"></span>
	<span class="footer-text">{content.right}</span>
</div>
{/if}

<style>
	.footer {
		display: flex;
		align-items: center;
		gap: 6px;
		height: 22px;
		padding: 0 12px;
		background: var(--sig-bg);
		border-top: 1px solid var(--sig-border);
		flex-shrink: 0;
		font-family: var(--font-mono);
		font-size: 8px;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}

	.footer-pip {
		width: 4px;
		height: 4px;
		border-radius: 50%;
		background: var(--sig-highlight);
		opacity: 0.5;
		flex-shrink: 0;
	}

	.footer-text {
		color: var(--sig-text-muted);
		white-space: nowrap;
		flex-shrink: 0;
	}

	.footer-fill {
		flex: 1;
		min-width: 8px;
		height: 1px;
		background: var(--sig-border);
	}
</style>

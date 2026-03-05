<script lang="ts">
import {
	type MarketplaceMcpServer,
	type Memory,
	type MemoryTimelineBucket,
	type Skill,
	getMarketplaceMcpServers,
	getMemories,
	getMemoryTimeline,
	getSkills,
} from "$lib/api";
import { Button } from "$lib/components/ui/button/index.js";
import ChevronLeft from "@lucide/svelte/icons/chevron-left";
import ChevronRight from "@lucide/svelte/icons/chevron-right";
import RotateCcw from "@lucide/svelte/icons/rotate-ccw";
import { onMount } from "svelte";

interface Props {
	ontimelinegeneratedforchange?: (generatedFor: string) => void;
}

const { ontimelinegeneratedforchange }: Props = $props();

const railButtonBase =
	"h-8 px-3 rounded-lg border text-[10px] uppercase tracking-[0.08em] font-[family-name:var(--font-mono)] transition-colors";

const memoryCardIconColors = [
	"var(--sig-icon-bg-1)",
	"var(--sig-icon-bg-2)",
	"var(--sig-icon-bg-3)",
	"var(--sig-icon-bg-4)",
	"var(--sig-icon-bg-5)",
	"var(--sig-icon-bg-6)",
] as const;

let loading = $state(false);
let error = $state<string | null>(null);
let buckets = $state<MemoryTimelineBucket[]>([]);
let activeIndex = $state(0);
let bucketSkillUsage = $state<Record<string, number>>({});
let bucketMcpUsage = $state<Record<string, number>>({});
let bucketTopMemories = $state<Record<string, Memory[]>>({});
const refs: { rootEl: HTMLDivElement | null } = { rootEl: null };

const activeBucket = $derived(buckets[activeIndex] ?? null);
const activeSkillsUsed = $derived(activeBucket ? (bucketSkillUsage[activeBucket.rangeKey] ?? 0) : 0);

function inferMcpUsageFromBucket(bucket: MemoryTimelineBucket): number {
	const sourceSignals = bucket.sourceBreakdown.filter((metric: { key: string }) => hasMcpSignal(metric.key)).length;
	const tagSignals = bucket.topTags.filter((metric: { key: string }) => hasMcpSignal(metric.key)).length;
	return sourceSignals + tagSignals;
}

function hasMcpSignal(raw: string): boolean {
	const key = raw.trim().toLowerCase();
	if (!key) return false;
	if (/\bmcp\b/.test(key)) return true;
	if (/\btool[-\s]?servers?\b/.test(key)) return true;
	if (key.includes("model context protocol")) return true;
	if (key.includes("model-context-protocol")) return true;
	if (key.includes("modelcontextprotocol")) return true;
	return false;
}

const activeMcpServersUsed = $derived(
	activeBucket ? Math.max(bucketMcpUsage[activeBucket.rangeKey] ?? 0, inferMcpUsageFromBucket(activeBucket)) : 0,
);

const activeTopMemories = $derived(activeBucket ? (bucketTopMemories[activeBucket.rangeKey] ?? []) : []);

function escapeRegex(raw: string): string {
	return raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseTags(tags: Memory["tags"]): string[] {
	if (Array.isArray(tags)) {
		return tags
			.filter((tag) => typeof tag === "string")
			.map((tag) => tag.trim())
			.filter((tag) => tag.length > 0);
	}
	if (typeof tags === "string") {
		const trimmed = tags.trim();
		if (!trimmed) return [];
		if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
			try {
				const parsed = JSON.parse(trimmed);
				if (Array.isArray(parsed)) {
					return parsed
						.filter((tag) => typeof tag === "string")
						.map((tag) => tag.trim())
						.filter((tag) => tag.length > 0);
				}
			} catch {
				// fall through to csv parsing
			}
		}
		return trimmed
			.split(",")
			.map((tag) => tag.trim())
			.filter((tag) => tag.length > 0);
	}
	return [];
}

function buildBucketUsageMaps(
	bucketsInput: readonly MemoryTimelineBucket[],
	memories: readonly Memory[],
	skills: readonly Skill[],
	mcpServers: readonly MarketplaceMcpServer[],
): {
	skillUsage: Record<string, number>;
	mcpUsage: Record<string, number>;
} {
	const skillMatchers = skills
		.map((skill) => skill.name.trim().toLowerCase())
		.filter((name) => name.length > 0)
		.map((name) => ({
			name,
			pattern: new RegExp(`\\b${escapeRegex(name)}\\b`, "i"),
		}));

	const mcpMatchers = mcpServers
		.flatMap((server) => [server.name, server.id])
		.map((value) => value.trim().toLowerCase())
		.filter((value) => value.length > 0)
		.map((value) => ({
			value,
			pattern: new RegExp(`\\b${escapeRegex(value)}\\b`, "i"),
		}));

	const storage = bucketsInput.map((bucket) => ({
		bucket,
		skillSet: new Set<string>(),
		mcpSet: new Set<string>(),
		mcpMentionIds: new Set<string>(),
		startMs: Date.parse(bucket.start),
		endMs: Date.parse(bucket.end),
	}));

	for (const memory of memories) {
		const createdAt = Date.parse(memory.created_at);
		if (!Number.isFinite(createdAt)) continue;

		const tags = parseTags(memory.tags).join(" ");
		const memoryText = [memory.content, memory.who, memory.type, tags]
			.filter((value): value is string => typeof value === "string")
			.join(" ")
			.toLowerCase();

		for (const entry of storage) {
			if (createdAt < entry.startMs || createdAt > entry.endMs) continue;

			for (const matcher of skillMatchers) {
				if (matcher.pattern.test(memoryText)) {
					entry.skillSet.add(matcher.name);
				}
			}

			let matchedMcp = false;
			for (const matcher of mcpMatchers) {
				if (matcher.pattern.test(memoryText)) {
					entry.mcpSet.add(matcher.value);
					matchedMcp = true;
				}
			}

			if (!matchedMcp && hasMcpSignal(memoryText)) {
				entry.mcpMentionIds.add(memory.id);
			}
		}
	}

	const skillUsage: Record<string, number> = {};
	const mcpUsage: Record<string, number> = {};
	for (const entry of storage) {
		skillUsage[entry.bucket.rangeKey] = entry.skillSet.size;
		mcpUsage[entry.bucket.rangeKey] = entry.mcpSet.size > 0 ? entry.mcpSet.size : entry.mcpMentionIds.size;
	}

	return { skillUsage, mcpUsage };
}

function normalizeImportance(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 0;
	if (value <= 0) return 0;
	if (value >= 1) return 1;
	return value;
}

function buildBucketTopMemories(
	bucketsInput: readonly MemoryTimelineBucket[],
	memories: readonly Memory[],
): Record<string, Memory[]> {
	const bucketEntries: Array<{
		bucket: MemoryTimelineBucket;
		startMs: number;
		endMs: number;
		candidates: Array<{ memory: Memory; score: number; createdAt: number }>;
	}> = bucketsInput.map((bucket) => ({
		bucket,
		startMs: Date.parse(bucket.start),
		endMs: Date.parse(bucket.end),
		candidates: [],
	}));

	for (const memory of memories) {
		const createdAt = Date.parse(memory.created_at);
		if (!Number.isFinite(createdAt)) continue;

		for (const entry of bucketEntries) {
			if (createdAt < entry.startMs || createdAt > entry.endMs) continue;

			const rangeSpan = Math.max(1, entry.endMs - entry.startMs);
			const recency = Math.max(0, Math.min(1, (createdAt - entry.startMs) / rangeSpan));
			const score = normalizeImportance(memory.importance) * 100 + (memory.pinned ? 24 : 0) + recency * 8;

			entry.candidates.push({ memory, score, createdAt });
		}
	}

	const result: Record<string, Memory[]> = {};
	for (const entry of bucketEntries) {
		entry.candidates.sort((left, right) => {
			if (right.score !== left.score) return right.score - left.score;
			const leftImportance = normalizeImportance(left.memory.importance);
			const rightImportance = normalizeImportance(right.memory.importance);
			if (rightImportance !== leftImportance) {
				return rightImportance - leftImportance;
			}
			if (right.createdAt !== left.createdAt) {
				return right.createdAt - left.createdAt;
			}
			return left.memory.id.localeCompare(right.memory.id);
		});

		result[entry.bucket.rangeKey] = entry.candidates.slice(0, 3).map((candidate) => candidate.memory);
	}

	return result;
}

function moveOlder(step = 1): void {
	if (buckets.length === 0) return;
	activeIndex = Math.min(buckets.length - 1, activeIndex + step);
}

function moveNewer(step = 1): void {
	if (buckets.length === 0) return;
	activeIndex = Math.max(0, activeIndex - step);
}

function emitGeneratedFor(value: string): void {
	if (!ontimelinegeneratedforchange) return;
	ontimelinegeneratedforchange(value);
}

async function loadTimeline(): Promise<void> {
	loading = true;
	error = null;
	try {
		const memoryResultPromise = getMemories(5000, 0);
		const [response, skills, mcp, memoryResult] = await Promise.all([
			getMemoryTimeline({
				fallbackMemories: memoryResultPromise.then((result) => result.memories),
			}),
			getSkills(),
			getMarketplaceMcpServers(),
			memoryResultPromise,
		]);
		buckets = response.buckets;
		emitGeneratedFor(response.generatedFor);
		const usage = buildBucketUsageMaps(response.buckets, memoryResult.memories, skills, mcp.servers);
		bucketSkillUsage = usage.skillUsage;
		bucketMcpUsage = usage.mcpUsage;
		bucketTopMemories = buildBucketTopMemories(response.buckets, memoryResult.memories);
		activeIndex = 0;
		if (response.error) {
			error = response.error;
		}
	} catch {
		error = "Failed to load timeline.";
		buckets = [];
		emitGeneratedFor("");
		bucketSkillUsage = {};
		bucketMcpUsage = {};
		bucketTopMemories = {};
	}
	loading = false;
}

function formatDateRange(startIso: string, endIso: string): string {
	const start = new Date(startIso);
	const end = new Date(endIso);
	return `${start.toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
	})} - ${end.toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
		year: "numeric",
	})}`;
}

function formatMemoryMoment(value: string, rangeKey: MemoryTimelineBucket["rangeKey"]): string {
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed)) return "Unknown";
	const date = new Date(parsed);
	if (rangeKey === "today") {
		return date.toLocaleTimeString("en-US", {
			hour: "numeric",
			minute: "2-digit",
		});
	}
	return date.toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
	});
}

function formatMemoryImportance(value: number | undefined): string {
	return `${Math.round(normalizeImportance(value) * 100)}%`;
}

function formatCountUnit(value: number, singular: string, plural: string): string {
	return value === 1 ? singular : plural;
}

function getMemoryMonogram(value: string): string {
	const parts = value
		.split(/[-_.\s]+/)
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
	if (parts.length >= 2) {
		return `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`.toUpperCase();
	}
	return value.slice(0, 2).toUpperCase() || "M";
}

function getMemoryMonogramBg(seed: string): string {
	let hash = 0;
	for (const char of seed) {
		hash = (hash * 31 + char.charCodeAt(0)) & 0xffff;
	}
	return memoryCardIconColors[Math.abs(hash) % memoryCardIconColors.length] ?? memoryCardIconColors[0];
}

function getRangeChipLabel(bucket: MemoryTimelineBucket): string {
	if (bucket.rangeKey === "last_week") return "Week";
	if (bucket.rangeKey === "one_month") return "Month";
	return "Today";
}

function handleKeydown(event: KeyboardEvent): void {
	if (!shouldHandleTimelineNavigation(event)) return;

	if (event.key === "ArrowRight") {
		event.preventDefault();
		moveOlder(event.shiftKey ? 3 : 1);
		return;
	}
	if (event.key === "ArrowLeft") {
		event.preventDefault();
		moveNewer(event.shiftKey ? 3 : 1);
		return;
	}
	if (event.key === "PageDown") {
		event.preventDefault();
		moveOlder(3);
		return;
	}
	if (event.key === "PageUp") {
		event.preventDefault();
		moveNewer(3);
	}
}

function isEditableElement(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	const tag = target.tagName;
	if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
	return target.isContentEditable;
}

function shouldHandleTimelineNavigation(event: KeyboardEvent): boolean {
	if (event.defaultPrevented) return false;
	if (event.altKey || event.ctrlKey || event.metaKey) return false;
	if (event.key !== "ArrowRight" && event.key !== "ArrowLeft" && event.key !== "PageDown" && event.key !== "PageUp") {
		return false;
	}
	if (isEditableElement(event.target)) return false;

	const active = document.activeElement;
	if (isEditableElement(active)) return false;
	if (!(active instanceof HTMLElement)) return false;
	if (!refs.rootEl) return active === document.body;
	return active === document.body || refs.rootEl.contains(active);
}

onMount(() => {
	loadTimeline();
	return () => {
		emitGeneratedFor("");
	};
});
</script>

<svelte:window onkeydown={handleKeydown} />

<div
	bind:this={refs.rootEl}
	class="timeline-shell flex flex-1 min-h-0 flex-col gap-3 bg-[var(--sig-bg)] p-3"
	role="region"
	aria-label="Memory timeline. Use left and right arrows to move through eras."
>
	{#if loading}
		<div class="flex flex-1 items-center justify-center sig-label">Loading timeline...</div>
	{:else if buckets.length === 0}
		<div class="flex flex-1 items-center justify-center sig-label text-[var(--sig-text-muted)]">
			No timeline data yet.
		</div>
	{:else if activeBucket}
		<div class="timeline-stack flex flex-1 min-h-0 flex-col gap-3">
			<section
				class="timeline-hero rounded-xl border border-[var(--sig-border)] p-3"
			>
				<div class="timeline-hero-grid">
					<div class="min-w-0">
						<h2 class="timeline-hero-title">
							Signet Evolution Timeline
						</h2>
						<p class="timeline-hero-subtitle">
							Track added, evolved, and pinned memories across recap eras.
						</p>
					</div>
					<div class="timeline-hero-metrics">
						<div class="timeline-hero-metric">
							<span class="timeline-hero-metric-label">Agent skills used</span>
							<strong class="timeline-hero-metric-display">
								{activeSkillsUsed} {formatCountUnit(activeSkillsUsed, "skill", "skills")}
							</strong>
						</div>
						<div class="timeline-hero-metric">
							<span class="timeline-hero-metric-label">MCP servers used</span>
							<strong class="timeline-hero-metric-display">
								{activeMcpServersUsed} {formatCountUnit(activeMcpServersUsed, "server", "servers")}
							</strong>
						</div>
						<div class="timeline-hero-metric">
							<span class="timeline-hero-metric-label">Average importance</span>
							<strong class="timeline-hero-metric-display">
								{Math.round(activeBucket.avgImportance * 100)}% avg
							</strong>
						</div>
						<div class="timeline-hero-metric">
							<span class="timeline-hero-metric-label">Pinned</span>
							<strong class="timeline-hero-metric-display">
								{activeBucket.pinned} {formatCountUnit(activeBucket.pinned, "card", "cards")}
							</strong>
						</div>
					</div>
				</div>
			</section>

			<div class="timeline-content-split min-h-0 gap-3">
				<section class="timeline-detail-panel flex min-h-0 flex-col gap-3 overflow-auto rounded-xl border border-[var(--sig-border)] bg-[var(--sig-surface)] p-3">
					<div class="timeline-era-head">
						<div class="timeline-era-title-row">
							<p class="sig-heading timeline-era-title">
								{activeBucket.label}: <span class="timeline-era-title-range">{formatDateRange(activeBucket.start, activeBucket.end)}</span>
							</p>
							<div class="timeline-era-controls" role="tablist" aria-orientation="horizontal">
								<Button
									variant="outline"
									size="sm"
									class="h-8 px-2"
									onclick={() => moveNewer()}
									disabled={activeIndex <= 0}
									title="Move to newer era"
								>
									<ChevronLeft class="size-3.5" />
								</Button>

								{#each buckets as bucket, index (bucket.eraIndex)}
									<button
										class={`${railButtonBase} ${index === activeIndex
											? 'border-[var(--sig-accent)] bg-[color-mix(in_srgb,var(--sig-surface-raised)_76%,transparent)] text-[var(--sig-text-bright)]'
											: 'border-[var(--sig-border-strong)] text-[var(--sig-text-muted)] hover:text-[var(--sig-text-bright)]'}`}
										onclick={() => {
											activeIndex = index;
										}}
										role="tab"
										aria-selected={index === activeIndex}
									>
										{getRangeChipLabel(bucket)}
									</button>
								{/each}

								<Button
									variant="outline"
									size="sm"
									class="h-8 px-2"
									onclick={() => moveOlder()}
									disabled={activeIndex >= buckets.length - 1}
									title="Move to older era"
								>
									<ChevronRight class="size-3.5" />
								</Button>

								<Button
									variant="ghost"
									size="sm"
									class="h-8 px-2 sig-label"
									onclick={() => {
										activeIndex = 0;
									}}
									title="Jump to today"
								>
									<RotateCcw class="size-3.5" />
								</Button>
							</div>
						</div>
					</div>

					<div class="timeline-summary-grid">
						<div class="flex min-h-[56px] items-center justify-center rounded-lg border border-[var(--sig-border-strong)] bg-[var(--sig-surface-raised)] p-2">
							<p class="timeline-summary-line">
								<span class="sig-heading leading-none">{activeBucket.memoriesAdded}</span>
								<span class="timeline-summary-copy">- Added</span>
							</p>
						</div>
						<div class="flex min-h-[56px] items-center justify-center rounded-lg border border-[var(--sig-border-strong)] bg-[var(--sig-surface-raised)] p-2">
							<p class="timeline-summary-line">
								<span class="sig-heading leading-none">{activeBucket.trackedEvents}</span>
								<span class="timeline-summary-copy">- Tracked events captured</span>
							</p>
						</div>
						<div class="flex min-h-[56px] items-center justify-center rounded-lg border border-[var(--sig-border-strong)] bg-[var(--sig-surface-raised)] p-2">
							<p class="timeline-summary-line">
								<span class="sig-heading leading-none">{activeBucket.evolved}</span>
								<span class="timeline-summary-copy">- Evolved</span>
							</p>
						</div>
						<div class="flex min-h-[56px] items-center justify-center rounded-lg border border-[var(--sig-border-strong)] bg-[var(--sig-surface-raised)] p-2">
							<p class="timeline-summary-line">
								<span class="sig-heading leading-none">{activeBucket.strengthened}</span>
								<span class="timeline-summary-copy">- Strengthened</span>
							</p>
						</div>
					</div>

					<div class="timeline-mix-grid">
						<div class="timeline-mix-card timeline-mix-card--type rounded-lg p-2">
							<p class="sig-label mb-1">Type mix</p>
							{#if activeBucket.typeBreakdown.length === 0}
								<p class="sig-label text-[var(--sig-text-muted)]">No type signals</p>
							{:else}
								{#each activeBucket.typeBreakdown as metric}
									<div class="flex items-center justify-between text-[11px]">
										<span>{metric.key}</span>
										<span class="text-[var(--sig-text-muted)]">{metric.count}</span>
									</div>
								{/each}
							{/if}
						</div>

						<div class="timeline-mix-card timeline-mix-card--source rounded-lg p-2">
							<p class="sig-label mb-1">Source mix</p>
							{#if activeBucket.sourceBreakdown.length === 0}
								<p class="sig-label text-[var(--sig-text-muted)]">No source signals</p>
							{:else}
								{#each activeBucket.sourceBreakdown as metric}
									<div class="flex items-center justify-between text-[11px]">
										<span>{metric.key}</span>
										<span class="text-[var(--sig-text-muted)]">{metric.count}</span>
									</div>
								{/each}
							{/if}
						</div>

						<div class="timeline-mix-card timeline-mix-card--tags rounded-lg p-2">
							<p class="sig-label mb-1">Top tags</p>
							{#if activeBucket.topTags.length === 0}
								<p class="sig-label text-[var(--sig-text-muted)]">No tags this era</p>
							{:else}
								{#each activeBucket.topTags as metric}
									<div class="flex items-center justify-between text-[11px]">
										<span>{metric.key}</span>
										<span class="text-[var(--sig-text-muted)]">{metric.count}</span>
									</div>
								{/each}
							{/if}
						</div>
					</div>
				</section>

				<section class="timeline-top-panel rounded-xl border border-[var(--sig-border)] bg-[var(--sig-surface)] p-3">
					<div class="flex items-center justify-between gap-2">
						<p class="sig-label">Top Three Memories</p>
						<p class="text-[11px] text-[var(--sig-text-muted)]">{activeBucket.label}</p>
					</div>
					{#if activeTopMemories.length === 0}
						<p class="mt-2 sig-label text-[var(--sig-text-muted)]">
							No memories saved in this era yet.
						</p>
					{:else}
						<div class="timeline-top-card-grid mt-2">
							{#each activeTopMemories as memory (memory.id)}
								<article class="timeline-top-card rounded-lg border border-[var(--sig-border-strong)] bg-[var(--sig-surface-raised)] p-2">
									<div class="timeline-top-card-head">
										<div class="timeline-top-card-icon" style={`background: ${getMemoryMonogramBg(memory.id)};`}>
											{getMemoryMonogram(memory.who || memory.type || "memory")}
										</div>
										<div class="timeline-top-card-title-wrap">
											<p class="timeline-top-card-title">{memory.who || "Unknown source"}</p>
											<p class="timeline-top-card-subtitle">{memory.type?.trim() || "memory"}</p>
										</div>
									</div>
									<p class="timeline-top-card-content mt-1 text-[11px] leading-relaxed text-[var(--sig-text)] line-clamp-4">
										{memory.content}
									</p>
									<div class="timeline-top-card-meta mt-auto flex items-center justify-between gap-2 pt-2 text-[11px] text-[var(--sig-text-muted)]">
										<p class="timeline-top-card-badge">imp {formatMemoryImportance(memory.importance)}</p>
										<p>{formatMemoryMoment(memory.created_at, activeBucket.rangeKey)}</p>
									</div>
								</article>
							{/each}
						</div>
					{/if}
				</section>
			</div>
		</div>
	{/if}

	{#if error}
		<p class="sig-label text-[var(--sig-danger)]">{error}</p>
	{/if}
</div>

<style>
	.timeline-hero {
		border-radius: 1rem;
		background:
			radial-gradient(circle at 85% -20%, color-mix(in srgb, var(--sig-accent) 16%, transparent), transparent 45%),
			linear-gradient(140deg, color-mix(in srgb, var(--sig-surface-raised) 88%, black) 0%, var(--sig-surface) 68%);
		padding: 1.05rem 1.15rem;
	}

	.timeline-hero-grid {
		display: grid;
		gap: 0.6rem;
		grid-template-columns: minmax(0, 1fr);
	}

	.timeline-hero-title {
		margin: 0;
		font-family: var(--font-display);
		font-size: clamp(1.05rem, 1.65vw, 1.35rem);
		line-height: 1.2;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--sig-text-bright);
	}

	.timeline-hero-subtitle {
		margin: 0.22rem 0 0;
		font-family: var(--font-mono);
		font-size: 0.66rem;
		line-height: 1.45;
		letter-spacing: 0.04em;
		color: var(--sig-text-muted);
	}

	.timeline-hero-metrics {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.45rem;
	}

	.timeline-hero-metric {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		justify-content: flex-start;
		gap: 0.2rem;
		padding: 0.45rem 0.55rem;
		border: 1px solid var(--sig-border-strong);
		border-radius: 0.4rem;
		background: color-mix(in srgb, var(--sig-surface-raised) 55%, transparent);
	}

	.timeline-hero-metric-label {
		font-family: var(--font-mono);
		font-size: 0.57rem;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--sig-text-muted);
	}

	.timeline-hero-metric-display {
		font-family: var(--font-display);
		font-size: 0.76rem;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--sig-text-bright);
	}

	.timeline-summary-panel {
		background:
			linear-gradient(135deg, color-mix(in srgb, var(--sig-surface-raised) 92%, transparent), var(--sig-surface-raised));
		border-color: var(--sig-border-strong);
		box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.03);
	}

	.timeline-mix-grid {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 0.5rem;
	}

	.timeline-mix-card {
		border: 1px solid var(--sig-border);
		background: color-mix(in srgb, var(--sig-surface-raised) 58%, transparent);
	}

	.timeline-mix-card--type {
		border-color: color-mix(in srgb, var(--sig-log-category-watcher) 58%, var(--sig-border-strong));
	}

	.timeline-mix-card--source {
		border-color: color-mix(in srgb, var(--sig-log-category-daemon) 58%, var(--sig-border-strong));
	}

	.timeline-mix-card--tags {
		border-color: color-mix(in srgb, var(--sig-log-category-pipeline) 58%, var(--sig-border-strong));
	}

	.timeline-summary-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.5rem;
	}

	.timeline-summary-line {
		display: flex;
		width: 100%;
		align-items: center;
		justify-content: center;
		gap: 0.3rem;
		text-align: center;
		font-size: 0.69rem;
		line-height: 1.2;
	}

	.timeline-summary-copy {
		color: var(--sig-text-muted);
	}

	.timeline-content-split {
		display: grid;
		grid-template-columns: minmax(0, 1.45fr) minmax(18rem, 1fr);
		align-items: stretch;
	}

	.timeline-top-panel {
		display: flex;
		min-height: 0;
		flex-direction: column;
	}

	.timeline-content-split .timeline-top-card-grid {
		grid-template-columns: minmax(0, 1fr);
	}

	.timeline-top-card-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
		gap: 0.5rem;
	}

	.timeline-top-card {
		display: flex;
		min-height: 8.2rem;
		flex-direction: column;
		gap: 0.45rem;
		background:
			radial-gradient(circle at 12% -24%, color-mix(in srgb, var(--sig-accent) 8%, transparent), transparent 52%),
			linear-gradient(220deg, color-mix(in srgb, var(--sig-surface-raised) 92%, black) 0%, var(--sig-surface-raised) 72%);
		transition: border-color 0.15s;
	}

	.timeline-top-card:hover {
		border-color: var(--sig-accent);
	}

	.timeline-top-card-head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.timeline-top-card-icon {
		display: flex;
		height: 1.65rem;
		width: 1.65rem;
		align-items: center;
		justify-content: center;
		border-radius: 0.35rem;
		font-family: var(--font-display);
		font-size: 0.62rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--sig-icon-fg);
		border: 1px solid var(--sig-icon-border);
		box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.22);
	}

	.timeline-top-card-title-wrap {
		min-width: 0;
	}

	.timeline-top-card-title {
		margin: 0;
		font-family: var(--font-display);
		font-size: 0.68rem;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--sig-text-bright);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.timeline-top-card-subtitle {
		margin: 0;
		font-family: var(--font-mono);
		font-size: 0.6rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--sig-text-muted);
	}

	.timeline-top-card-content {
		margin: 0;
	}

	.timeline-top-card-meta {
		font-family: var(--font-mono);
	}

	.timeline-top-card-badge {
		margin: 0;
		padding: 0.08rem 0.3rem;
		border: 1px solid var(--sig-border-strong);
		border-radius: 0.32rem;
		font-size: 0.6rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--sig-text-muted);
		background: color-mix(in srgb, var(--sig-surface-raised) 62%, transparent);
	}

	@media (max-width: 900px) and (orientation: portrait) {
		.timeline-hero {
			border-radius: 1rem;
			padding: 0.95rem;
		}

		.timeline-content-split {
			grid-template-columns: minmax(0, 1fr);
		}

		.timeline-summary-grid {
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: 0.45rem;
		}

		.timeline-summary-line {
			gap: 0.22rem;
			font-size: 0.64rem;
		}

		.timeline-summary-copy {
			letter-spacing: 0.01em;
		}

		.timeline-content-split .timeline-top-card-grid {
			grid-template-columns: minmax(0, 1fr);
		}

		.timeline-hero-metrics {
			display: grid;
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: 0.4rem;
		}

		.timeline-hero-metric {
			padding: 0.42rem 0.48rem;
			gap: 0.16rem;
		}

		.timeline-hero-metric-label {
			font-size: 0.53rem;
		}

		.timeline-hero-metric-display {
			font-size: 0.68rem;
		}

		.timeline-shell {
			overflow-y: auto;
		}

		.timeline-stack {
			min-height: auto;
		}

		.timeline-detail-panel {
			overflow: visible;
			min-height: auto;
		}

		.timeline-top-card-grid {
			grid-template-columns: minmax(0, 1fr);
		}

		.timeline-top-card {
			min-height: 0;
		}
	}

	.timeline-era-head {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}

	.timeline-era-title-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		gap: 0.75rem;
	}

	.timeline-era-title {
		justify-self: start;
	}

	.timeline-era-title-range {
		font-size: 0.8rem;
		font-weight: 500;
		color: var(--sig-text-muted);
		white-space: nowrap;
	}

	.timeline-era-controls {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: flex-end;
		justify-self: end;
		gap: 0.45rem;
	}

	@media (min-width: 1024px) {
		.timeline-hero-grid {
			grid-template-columns: minmax(0, 1fr) minmax(24rem, 0.95fr);
			align-items: start;
			gap: 0.95rem;
		}

		.timeline-hero-metric {
			min-height: 3rem;
		}

		.timeline-era-controls {
			flex-wrap: nowrap;
		}
	}
</style>

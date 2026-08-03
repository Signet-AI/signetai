import { Check, Clock3, MessageSquare, Network, Pin, Plus, Search, Trash2, UserRound, Wrench, X, type LucideIcon } from "lucide-react";
import { sourceLogo } from "@/components/icons";
import { Surface } from "@/components/ui/surface";
import { api, type EmbeddingHealthReport, type Memory } from "@/lib/api";
import { useAsync } from "@/lib/use-async";
import { cn } from "@/lib/utils";
import { useEffect, useMemo, useState } from "react";
import { useView } from "@/lib/view-context";

const TYPE_TINTS: Record<string, string> = {
	decision: "text-[oklch(0.82_0.16_150)]",
	issue: "text-[oklch(0.78_0.18_25)]",
	learning: "text-[oklch(0.82_0.14_200)]",
};

/**
 * Daemon `tags` is inconsistent: sometimes a string (comma/newline-delimited),
 * sometimes an array, sometimes null. Coerce to a clean string array.
 */
function toTagArray(tags: unknown): string[] {
	if (Array.isArray(tags))
		return tags.filter((t): t is string => typeof t === "string").map((t) => t.trim()).filter(Boolean);
	if (typeof tags === "string") return tags.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean);
	return [];
}

function SourceGlyph({ kind }: { kind: string }) {
	const logo = sourceLogo(kind, { className: "size-[15px]", "aria-hidden": true });
	if (logo) return logo;
	if (kind === "slack" || kind === "discord") return <MessageSquare className="size-[15px]" aria-hidden="true" />;
	return <UserRound className="size-[15px]" aria-hidden="true" />;
}

export function MemoryView() {
	const [q, setQ] = useState("");
	const [topics, setTopics] = useState<Set<string>>(() => new Set());
	const [memoryType, setMemoryType] = useState<string | null>(null);
	const [filterCatalog, setFilterCatalog] = useState<Memory[]>([]);
	const { requestConnectSource } = useView();
	const { data: mems, loading, refresh } = useAsync(
		async () => q.trim() || memoryType || topics.size > 0
			? api.searchMemories(q, 50, { type: memoryType ?? undefined, tags: [...topics] })
			: api.getMemories({ limit: 50 }),
		{ deps: [q, memoryType, topics] },
	);
	const summary = useAsync(() => api.getMemories({ limit: 1 }), { intervalMs: 30_000 }).data;
	const embeddingHealth = useAsync(() => api.getEmbeddingHealth(), { intervalMs: 30_000 }).data;
	useEffect(() => {
		const focusSearch = (event: KeyboardEvent) => {
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
				event.preventDefault();
				document.getElementById("memory-search-input")?.focus();
			}
		};
		window.addEventListener("keydown", focusSearch);
		return () => window.removeEventListener("keydown", focusSearch);
	}, []);
	useEffect(() => {
		if (!q.trim() && memoryType === null && topics.size === 0 && mems?.memories) {
			setFilterCatalog(mems.memories);
		}
	}, [mems?.memories, memoryType, q, topics]);
	const memories = mems?.memories ?? [];
	const groups = useMemo(() => groupMemories(memories, Boolean(q.trim())), [memories, q]);
	const filterRows = filterCatalog.length > 0 ? filterCatalog : memories;
	const memoryTypes = useMemo(() => getMemoryTypes(filterRows), [filterRows]);
	const topTopics = useMemo(() => getTopTopics(filterRows), [filterRows]);
	const coverage = coveragePercent(embeddingHealth);

	return (
		<div className="flex flex-1 flex-col gap-3.5 min-h-0">
			<Surface className="flex h-10 shrink-0 items-center gap-2.5 px-3.5">
				<Stat label="memories" value={summary?.stats ? summary.stats.total.toLocaleString() : "—"} />
				<Stat label="indexed" value={coverage === null ? "—" : `${coverage}%`} />
				<div className="flex-1" />
				<span className={cn("flex items-center gap-1.5 text-[11px] text-muted-foreground", healthTextColor(embeddingHealth))}>
					<span className="size-1.5 rounded-full bg-current shadow-[0_0_6px_currentColor]" />
					{embeddingHealth ? `${embeddingHealth.status} index` : "checking index"}
				</span>
				<button
					type="button"
					onClick={() => requestConnectSource()}
					className="flex h-7 items-center gap-1.75 rounded-[var(--radius)] border border-[oklch(1_0_0/0.16)] bg-[color-mix(in_oklch,var(--foreground)_6%,transparent)] px-3 text-[12px] font-medium transition-colors hover:border-[oklch(1_0_0/0.3)] hover:bg-[color-mix(in_oklch,var(--foreground)_10%,transparent)]"
				>
					<Plus className="size-3.5 text-muted-foreground" />
					Ingest source
				</button>
			</Surface>

			<div
				className={cn(
					"flex h-10 shrink-0 items-center gap-2.5 rounded-[var(--radius)] border px-3.5",
					"border-[oklch(1_0_0/0.14)] bg-[color-mix(in_oklch,var(--foreground)_4%,transparent)]",
					"focus-within:border-[color-mix(in_oklch,var(--foreground)_35%,transparent)] focus-within:shadow-[0_0_0_3px_color-mix(in_oklch,var(--foreground)_8%,transparent)]",
				)}
			>
				<Search className="size-4 text-muted-foreground" />
				<input
					id="memory-search-input"
					aria-label="Search memories"
					value={q}
					onChange={(e) => setQ(e.target.value)}
					placeholder="Search memories, tags, queries…"
					className="h-full min-w-0 flex-1 border-0 bg-transparent p-0 text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
				/>
				{q && (
					<span className="font-mono text-[10px] text-success">{memories.length} ranked by similarity</span>
				)}
				<kbd className="hidden rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground sm:inline">⌘K</kbd>
			</div>

			<div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(0,1fr)] gap-4 md:grid-cols-[1fr_240px]">
				<div className="flex min-h-0 flex-col gap-2 overflow-y-auto pr-1">
					{groups.map((group) => (
						<div key={group.label ?? "search"} className="mb-2.5 last:mb-0">
							{group.label && <GroupHeader label={group.label} count={group.memories.length} />}
							{group.memories.map((memory) => <MemoryCard key={memory.id} memory={memory} onMutate={refresh} />)}
						</div>
					))}
					{memories.length === 0 && (
						<div className="grid flex-1 place-items-center p-8 text-center text-[12px] text-muted-foreground">
							{loading
								? "Loading memories…"
								: q
									? `No memories match "${q}"`
									: topics.size > 0 || memoryType !== null
										? "No memories match the selected filters."
										: "No memories yet."}
						</div>
					)}
				</div>

					<div className="hidden min-h-0 flex-col gap-3.5 overflow-y-auto pr-0.5 md:flex">
						<SideGroup label="Memory type">
							{memoryTypes.map((chip) => (
								<SideChip
									key={chip.type}
									label={typeLabel(chip.type)}
									count={chip.count}
									icon={typeIcon(chip.type)}
									active={memoryType === chip.type}
									onClick={() => setMemoryType((current) => current === chip.type ? null : chip.type)}
								/>
							))}
					</SideGroup>
					<SideGroup label="Recurring topics">
						<div className="flex flex-wrap gap-1.5 rounded-[var(--radius)] border border-[oklch(1_0_0/0.06)] bg-[color-mix(in_oklch,var(--foreground)_4%,transparent)] p-2">
							{topTopics.map(({ tag }) => (
								<button
									type="button"
									key={tag}
									onClick={() => setTopics((current) => toggleTopic(current, tag))}
									aria-pressed={topics.has(tag)}
									className={cn(
										"inline-flex items-center gap-1.25 rounded-full border border-[oklch(1_0_0/0.08)] bg-[color-mix(in_oklch,var(--foreground)_5%,transparent)] px-2 py-0.75 font-mono text-[10px] text-muted-foreground transition-colors hover:border-[oklch(1_0_0/0.24)] hover:text-foreground",
										topics.has(tag) && "border-[oklch(1_0_0/0.18)] bg-[color-mix(in_oklch,var(--foreground)_10%,transparent)] text-foreground",
									)}
								>
									#{tag}
								</button>
							))}
						</div>
					</SideGroup>
				</div>
			</div>
		</div>
	);
}

function MemoryCard({ memory, onMutate }: { memory: Memory; onMutate: () => void }) {
	const kind = memory.source_type ?? "agent";
	const [confirming, setConfirming] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const pinned = memory.pinned === 1;

	const togglePin = async () => {
		if (busy) return;
		setBusy(true);
		setError(null);
		const result = await api.updateMemory(memory.id, { pinned: !pinned }, "Pin toggled from dashboard memory feed");
		setBusy(false);
		if (!result.ok) {
			setError(result.error ?? "pin failed");
			return;
		}
		onMutate();
	};

	const doDelete = async () => {
		if (busy) return;
		setBusy(true);
		setError(null);
		const result = await api.deleteMemory(memory.id, "Deleted from dashboard memory feed");
		setBusy(false);
		if (!result.ok) {
			setError(result.error ?? "delete failed");
			setConfirming(false);
			return;
		}
		onMutate();
	};

	return (
		<div className="sig-mfeed group mb-2 flex gap-3 px-3.5 py-3">
			<span className="grid size-7 shrink-0 place-items-center rounded-[7px] border border-[oklch(1_0_0/0.06)] bg-[color-mix(in_oklch,var(--foreground)_8%,transparent)] text-foreground">
				<SourceGlyph kind={kind} />
			</span>
			<div className="min-w-0 flex-1">
				<div className="mb-1 flex items-center gap-1.5">
					<span className="text-[11.5px] font-semibold">{sourceLabel(kind)}</span>
					<span className="font-mono text-[9.5px] text-muted-foreground">via {memory.who}</span>
					{memory.type && <span className={cn("rounded px-1.5 py-px font-mono text-[9px] bg-[color-mix(in_oklch,var(--foreground)_8%,transparent)] border border-[oklch(1_0_0/0.06)]", TYPE_TINTS[memory.type] ?? "text-muted-foreground")}>{memory.type}</span>}
				</div>
				<p className="m-0 text-[12.5px] leading-[1.55] text-foreground">{memory.content}</p>
				<div className="mt-2 flex flex-wrap items-center gap-2">
					{toTagArray(memory.tags).slice(0, 4).map((tag) => <span key={tag} className="font-mono text-[9.5px] text-muted-foreground">#{tag}</span>)}
					{error && <span className="font-mono text-[9.5px] text-destructive">{error}</span>}
					<span className="ml-auto font-mono text-[9.5px] text-muted-foreground">{timeAgo(memory.created_at)}</span>
				</div>
			</div>
			<div
				className={cn(
					"flex shrink-0 items-center gap-0.5 self-center transition-opacity",
					confirming ? "opacity-100" : "opacity-0 group-hover:opacity-100",
				)}
			>
				{confirming ? (
					<>
						<span className="mr-1 font-mono text-[9.5px] text-muted-foreground">Delete?</span>
						<button
							type="button"
							onClick={doDelete}
							disabled={busy}
							aria-label="Confirm delete"
							className="grid size-[26px] place-items-center rounded-[var(--radius)] border border-transparent text-destructive hover:border-[oklch(1_0_0/0.1)] hover:bg-[color-mix(in_oklch,var(--foreground)_8%,transparent)]"
						>
							<Check className="size-[13px]" />
						</button>
						<button
							type="button"
							onClick={() => setConfirming(false)}
							disabled={busy}
							aria-label="Cancel delete"
							className="grid size-[26px] place-items-center rounded-[var(--radius)] border border-transparent text-muted-foreground hover:border-[oklch(1_0_0/0.1)] hover:bg-[color-mix(in_oklch,var(--foreground)_8%,transparent)] hover:text-foreground"
						>
							<X className="size-[13px]" />
						</button>
					</>
				) : (
					<>
						<button
							type="button"
							onClick={togglePin}
							disabled={busy}
							title={pinned ? "Unpin" : "Pin"}
							aria-label={pinned ? "Unpin memory" : "Pin memory"}
							aria-pressed={pinned}
							className={cn(
								"grid size-[26px] place-items-center rounded-[var(--radius)] border border-transparent hover:border-[oklch(1_0_0/0.1)] hover:bg-[color-mix(in_oklch,var(--foreground)_8%,transparent)]",
								pinned ? "text-[oklch(0.85_0.14_75)]" : "text-muted-foreground hover:text-foreground",
							)}
						>
							<Pin className="size-[13px]" />
						</button>
						<button
							type="button"
							onClick={() => setConfirming(true)}
							disabled={busy}
							title="Delete"
							aria-label="Delete memory"
							className="grid size-[26px] place-items-center rounded-[var(--radius)] border border-transparent text-muted-foreground hover:border-[oklch(1_0_0/0.1)] hover:bg-[color-mix(in_oklch,var(--foreground)_8%,transparent)] hover:text-[oklch(0.78_0.18_25)]"
						>
							<Trash2 className="size-[13px]" />
						</button>
					</>
				)}
			</div>
		</div>
	);
}

function GroupHeader({ label, count }: { label: string; count: number }) {
	return <div className="flex items-baseline gap-2.5 px-0.5 pb-2"><span className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-[oklch(0.58_0_0)]">{label}</span><span className="font-mono text-[10px] text-muted-foreground">{count}</span><span className="h-px flex-1 bg-[oklch(1_0_0/0.06)]" /></div>;
}

function groupMemories(memories: Memory[], searching: boolean): Array<{ label: string | null; memories: Memory[] }> {
	if (searching) return [{ label: null, memories }];
	const groups = new Map<string, Memory[]>();
	for (const memory of memories) {
		const label = dateGroup(memory.created_at);
		groups.set(label, [...(groups.get(label) ?? []), memory]);
	}
	return ["Today", "Yesterday", "Earlier this week", "Earlier"]
		.map((label) => ({ label, memories: groups.get(label) ?? [] }))
		.filter((group) => group.memories.length > 0);
}

function getTopTopics(memories: Memory[]): Array<{ tag: string; count: number }> {
	const counts = new Map<string, number>();
	for (const memory of memories) {
		for (const tag of toTagArray(memory.tags)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
	}
	return [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)).slice(0, 8);
}

function getMemoryTypes(memories: Memory[]): Array<{ type: string; count: number }> {
	const counts = new Map<string, number>();
	for (const memory of memories) {
		if (memory.type) counts.set(memory.type, (counts.get(memory.type) ?? 0) + 1);
	}
	return [...counts]
		.map(([type, count]) => ({ type, count }))
		.sort((a, b) => b.count - a.count || a.type.localeCompare(b.type))
		.slice(0, 3);
}

function typeLabel(type: string): string {
	return type.replace(/[-_]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function typeIcon(type: string): LucideIcon {
	if (type === "semantic") return Network;
	if (type === "learning" || type === "observation") return Clock3;
	return Wrench;
}

function toggleTopic(current: Set<string>, topic: string): Set<string> {
	const next = new Set(current);
	if (next.has(topic)) next.delete(topic);
	else next.add(topic);
	return next;
}

function sourceLabel(sourceType: string): string {
	return sourceType.replace(/[-_]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function dateGroup(iso: string): string {
	const date = new Date(iso);
	const now = new Date();
	const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	const yesterday = new Date(day);
	yesterday.setDate(day.getDate() - 1);
	const week = new Date(day);
	week.setDate(day.getDate() - 7);
	if (date >= day) return "Today";
	if (date >= yesterday) return "Yesterday";
	if (date >= week) return "Earlier this week";
	return "Earlier";
}

function timeAgo(iso: string): string {
	const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.round(hours / 24)}d ago`;
}

function coveragePercent(report: EmbeddingHealthReport | null): number | null {
	const detail = report?.checks.find((check) => check.name === "coverage")?.detail;
	return typeof detail?.coverage === "number" ? Math.round(detail.coverage) : null;
}

function healthTextColor(report: EmbeddingHealthReport | null): string {
	if (report?.status === "healthy") return "text-success";
	if (report?.status === "degraded") return "text-[oklch(0.8_0.14_80)]";
	if (report?.status === "unhealthy") return "text-destructive";
	return "text-muted-foreground";
}

function Stat({ label, value }: { label: string; value: string }) {
	return (
		<span className="flex h-full items-center gap-1.5 border-r border-[oklch(1_0_0/0.07)] px-4 last:border-r-0">
			<span className="font-mono text-[13px] font-medium">{value}</span>
			<span className="text-[11px] text-muted-foreground">{label}</span>
		</span>
	);
}

function SideGroup({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="flex flex-col gap-1.5">
			<div className="px-0.5 font-mono text-[9.5px] font-semibold uppercase tracking-[0.08em] text-[oklch(0.58_0_0)]">
				{label}
			</div>
			{children}
		</div>
	);
}

function SideChip({
	label,
	count,
	icon: Icon,
	active = false,
	onClick,
}: {
	label: string;
	count: number;
	icon: LucideIcon;
	active?: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-pressed={active}
			title={`${count} loaded ${label.toLowerCase()} memories`}
			className={cn(
				"flex items-center gap-2 rounded-[var(--radius)] border border-[oklch(1_0_0/0.06)] px-2.5 py-1.75 text-[12px] text-muted-foreground transition-colors hover:bg-[var(--accent-subtle)] hover:text-foreground",
				active && "border-[oklch(1_0_0/0.12)] bg-[color-mix(in_oklch,var(--foreground)_9%,transparent)] text-foreground",
			)}
		>
			<Icon className="size-3.5 shrink-0 text-muted-foreground" />
			<span>{label}</span>
			<span className="ml-auto font-mono text-[10px] text-muted-foreground">{count.toLocaleString()}</span>
		</button>
	);
}

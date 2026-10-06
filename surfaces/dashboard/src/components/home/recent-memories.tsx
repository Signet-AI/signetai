import { LoadingRows } from "@/components/ui/skeleton";
import { SectionHeading } from "@/components/dashboard/heading";
import { SearchField } from "@/components/ui/field";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Dialog, DialogTrigger, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { api, type Memory } from "@/lib/api";
import { useAsync } from "@/lib/use-async";
import { cn } from "@/lib/utils";
import { useMemo, useState } from "react";
import { useScrollEnd } from "@/lib/use-scroll-end";

const TYPE_TINTS: Record<string, string> = {
	decision: "home-type-decision",
	issue: "home-type-issue",
	learning: "home-type-learning",
};

export function HomeRecentMemories() {
	const [query, setQuery] = useState("");
	const [sourceFilter, setSourceFilter] = useState("all");
	const trimmedQuery = query.trim();
	const memoriesQuery = useAsync(
		async () => {
			try {
				const result = await (trimmedQuery ? api.searchMemories(trimmedQuery, 20) : api.getMemories({ limit: 20 }));
				return { memories: result?.memories ?? null, query: trimmedQuery };
			} catch {
				return { memories: null, query: trimmedQuery };
			}
		},
		{ key: `recent-memories:${trimmedQuery}`, deps: [trimmedQuery], intervalMs: 30_000 },
	);
	const memories = memoriesQuery.data?.memories ?? [];
	const sourceOptions = useMemo(
		() =>
			Array.from(
				new Set([
					...memories.map((memory) => memory.source_type ?? "agent"),
					...(sourceFilter === "all" ? [] : [sourceFilter]),
				]),
			).sort(),
		[memories, sourceFilter],
	);
	const visibleMemories =
		sourceFilter === "all" ? memories : memories.filter((memory) => (memory.source_type ?? "agent") === sourceFilter);
	const scroll = useScrollEnd<HTMLDivElement>();
	const searching = memoriesQuery.loading || memoriesQuery.data?.query !== trimmedQuery;
	const failed = !searching && memoriesQuery.data?.memories === null;
	const meta = searching
		? trimmedQuery
			? "searching…"
			: "loading…"
		: failed
			? "unavailable"
			: `${visibleMemories.length} ${trimmedQuery ? (visibleMemories.length === 1 ? "match" : "matches") : "latest"}`;

	return (
		<section className="home-recent group flex flex-col" aria-labelledby="recent-memories-title">
			<SectionHeading
				id="recent-memories-title"
				title="Recently saved"
				className="shrink-0"
				meta={
					<span role="status" className="text-meta tabular-nums text-muted-foreground">
						{meta}
					</span>
				}
			/>

			<div className="mt-3 flex shrink-0 items-center gap-2">
				<SearchField
					className="min-w-0 flex-1"
					aria-label="Search saved memories"
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					placeholder="Search saved memories…"
				/>
				<Select value={sourceFilter} onValueChange={setSourceFilter}>
					<SelectTrigger className="home-source-filter" aria-label="Filter memories by source">
						<SelectValue />
					</SelectTrigger>
					<SelectContent className="home-source-options" position="popper" align="end" sideOffset={4}>
						<SelectItem value="all">All sources</SelectItem>
						{sourceOptions.map((source) => (
							<SelectItem key={source} value={source}>
								{sourceLabel(source)}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>

			<div className="mt-2">
				<div aria-busy={searching}>
					{memoriesQuery.loading && memoriesQuery.data === null ? (
						<LoadingRows label="Loading memories…" rows={4} />
					) : failed ? (
						<div className="flex min-h-[84px] items-center justify-center gap-2 text-meta text-muted-foreground">
							<span>{trimmedQuery ? "Unable to search saved memories." : "Unable to load saved memories."}</span>
							<button type="button" className="home-text-action" onClick={() => void memoriesQuery.refresh()}>
								Retry
							</button>
						</div>
					) : visibleMemories.length === 0 ? (
						<div className="grid min-h-[84px] place-items-center text-center text-meta text-muted-foreground">
							{searching
								? "Searching…"
								: trimmedQuery
									? `No saved memories match “${trimmedQuery}”.`
									: sourceFilter !== "all"
										? "No saved memories from this source."
										: "No saved memories yet."}
						</div>
					) : (
						<div
							ref={scroll.ref}
							onScroll={scroll.onScroll}
							data-at-end={scroll.atEnd}
							className="home-recent-list flex flex-col"
						>
							{visibleMemories.map((memory) => (
								<RecentMemoryRow key={memory.id} memory={memory} />
							))}
						</div>
					)}
				</div>
			</div>
		</section>
	);
}

function RecentMemoryRow({ memory }: { memory: Memory }) {
	const kind = memory.source_type ?? "agent";
	const title = memory.content.trim().split(/(?<=[.!?])\s+/)[0] || memory.content;
	return (
		<Dialog>
			<DialogTrigger asChild>
				<button type="button" className="home-memory-row home-memory-summary group/memory w-full text-left">
					<div className="min-w-0 flex-1">
						<p className="m-0 line-clamp-1 text-body leading-[1.35] text-foreground">{title}</p>
						<div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-meta tabular-nums text-muted-foreground">
							<span className="shrink-0">{timeAgo(memory.created_at)}</span>
							<span aria-hidden="true">·</span>
							<span className={cn("shrink-0", TYPE_TINTS[memory.type] ?? "text-muted-foreground")}>
								{memory.type || sourceLabel(kind)}
							</span>
							{memory.who && memory.who !== "dreaming" && (
								<>
									<span aria-hidden="true">·</span>
									<span className="truncate">via {memory.who}</span>
								</>
							)}
						</div>
					</div>
				</button>
			</DialogTrigger>
			<DialogContent className="home-memory-reader">
				<DialogTitle className="text-body font-medium">Saved memory</DialogTitle>
				<DialogDescription className="text-meta tabular-nums">
					<span className="block">
						via {memory.who || sourceLabel(kind)} · {sourceLabel(kind)} · {memory.type || "memory"}
					</span>
					<time className="mt-1 block" dateTime={memory.created_at}>
						Saved {new Date(memory.created_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "long" })}
					</time>
				</DialogDescription>
				<div className="min-h-0 overflow-y-auto whitespace-pre-wrap break-words text-title leading-relaxed">
					{memory.content}
				</div>
			</DialogContent>
		</Dialog>
	);
}

function sourceLabel(sourceType: string): string {
	return sourceType.replace(/[-_]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function timeAgo(iso: string): string {
	const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.round(hours / 24)}d ago`;
}

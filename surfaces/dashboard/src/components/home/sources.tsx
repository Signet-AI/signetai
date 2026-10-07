import { LoadingRows } from "@/components/ui/skeleton";
import { SectionAction, type StatusTone, StatusLabel } from "@/components/dashboard/heading";
import { SetupRow } from "@/components/home/setup-row";
import { sourceLogo } from "@/components/icons";
import { ConnectSourceDialog } from "@/components/sources/connect-source-dialog";
import { type SignetSource, type SourceHealth, type SourceIndexJob, api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useView } from "@/lib/view-context";
import {
	Check,
	ChevronRight,
	Copy,
	Download,
	Folder,
	FolderOpen,
	GitBranch,
	Globe,
	RotateCw,
	Trash2,
	X,
} from "@/components/mingcute-icons";
import { useEffect, useRef, useState } from "react";

const HEALTH_STATUS: Record<string, { tone: StatusTone; label: string } | undefined> = {
	degraded: { tone: "warn", label: "Degraded" },
	unhealthy: { tone: "error", label: "Unhealthy" },
	empty: { tone: "neutral", label: "Empty" },
	unknown: { tone: "neutral", label: "Couldn't check" },
};

const REINDEXABLE_KINDS = new Set(["obsidian", "web", "github", "notion", "discord"]);

export interface SourceIssue {
	readonly tone: StatusTone;
	readonly title: string;
	readonly detail?: string;
	readonly fix: "reindex" | "details";
	readonly actionable: boolean;
}

function plural(count: number, word: string): string {
	return `${count} ${word}${count === 1 ? "" : "s"}`;
}
export function sourceIssue(source: SignetSource): SourceIssue | null {
	const health = source.health;
	if (!health) return null;
	const reindex = REINDEXABLE_KINDS.has(source.kind) ? "reindex" : "details";
	if (health.status === "unknown")
		return {
			tone: "neutral",
			title: "Signet couldn't check this source",
			detail: health.error,
			fix: "details",
			actionable: false,
		};
	if (health.permission?.status === "denied")
		return {
			tone: "error",
			title: "Signet can't read this folder",
			detail: health.permission.issues[0]?.guidance,
			fix: "details",
			actionable: true,
		};
	const failures = health.failures?.total ?? 0;
	if (failures > 0) {
		const recoverable = health.failures?.recoverable ?? 0;
		return {
			tone: "warn",
			title: `${plural(failures, "item")} failed to sync`,
			detail:
				recoverable > 0
					? `${recoverable} can be retried by re-indexing.`
					: "None can be retried automatically; check the source itself.",
			fix: recoverable > 0 ? reindex : "details",
			actionable: true,
		};
	}
	const stale = health.checkpoints?.stale ?? 0;
	const partial = health.checkpoints?.partial ?? 0;
	if (stale + partial > 0)
		return {
			tone: "warn",
			title: "Sync didn't finish",
			detail:
				[stale ? `${stale} stale` : "", partial ? `${partial} partial` : ""].filter(Boolean).join(" and ") +
				" checkpoints.",
			fix: reindex,
			actionable: true,
		};
	const orphans = health.purge?.orphanChunks ?? 0;
	const deleted = health.purge?.deletedArtifacts ?? 0;
	if (orphans + deleted > 0)
		return {
			tone: "warn",
			title: "Index still holds data from deleted items",
			detail: [orphans ? plural(orphans, "orphaned chunk") : "", deleted ? plural(deleted, "deleted item") : ""]
				.filter(Boolean)
				.join(" and ")
				.concat("."),
			fix: "details",
			actionable: true,
		};
	if (health.status === "unhealthy" || health.status === "degraded")
		return {
			tone: health.status === "unhealthy" ? "error" : "warn",
			title: `Source is ${health.status}`,
			fix: "details",
			actionable: true,
		};
	return null;
}
function RootIcon({ kind }: { kind: string }) {
	const cls = "size-[13px] shrink-0 text-muted-foreground";
	if (kind === "github") return <GitBranch className={cls} aria-hidden="true" />;
	if (kind === "web" || kind === "notion") return <Globe className={cls} aria-hidden="true" />;
	if (kind === "discord" || kind === "slack") return <Globe className={cls} aria-hidden="true" />;
	return <Folder className={cls} aria-hidden="true" />;
}
export function HomeSourcesPanel({
	sources,
	loading,
	onRefresh,
	focus,
}: {
	sources?: readonly SignetSource[];
	loading: boolean;
	onRefresh: () => void;
	focus?: { readonly id: string; readonly at: number } | null;
}) {
	const [connectOpen, setConnectOpen] = useState(false);
	const [expanded, setExpanded] = useState(false);
	const listRef = useRef<HTMLDivElement>(null);
	const { connectSourceRequested, clearConnectSource } = useView();

	useEffect(() => {
		if (!connectSourceRequested) return;
		setConnectOpen(true);
		clearConnectSource();
	}, [connectSourceRequested, clearConnectSource]);

	const [pendingFocus, setPendingFocus] = useState<string | null>(null);
	useEffect(() => {
		if (!focus) return;
		setExpanded(true);
		setPendingFocus(focus.id);
	}, [focus]);
	useEffect(() => {
		if (!expanded || !pendingFocus || !sources?.some((source) => source.id === pendingFocus)) return;
		const row = [...(listRef.current?.querySelectorAll<HTMLDetailsElement>("details[data-source-id]") ?? [])].find(
			(candidate) => candidate.dataset.sourceId === pendingFocus,
		);
		if (!row) return;
		row.open = true;
		row.scrollIntoView({ block: "nearest", behavior: "smooth" });
		setPendingFocus(null);
	}, [expanded, pendingFocus, sources]);

	const summary = loading
		? "Loading…"
		: sources === undefined
			? "Unavailable"
			: sources.length === 0
				? "None connected"
				: sources.map((source) => source.name).join(", ");

	return (
		<>
			<section className="home-setup-group" aria-labelledby="home-sources-title">
				<SetupRow
					id="home-sources-title"
					label="Sources"
					summary={summary}
					count={sources?.length || undefined}
					expanded={expanded}
					onToggle={() => setExpanded((open) => !open)}
				/>
				{expanded && (
					<div ref={listRef} className="home-setup-detail">
						{loading ? (
							<LoadingRows label="Loading sources…" rows={2} />
						) : sources === undefined ? (
							<div className="flex min-h-[48px] items-center gap-2">
								<span className="text-small text-muted-foreground">Unable to load sources.</span>
								<button type="button" className="home-text-action shrink-0" onClick={onRefresh}>
									Retry
								</button>
							</div>
						) : sources.length > 0 ? (
							<div className="divide-y divide-border">
								{sources.map((source) => (
									<HomeSourceRow key={source.id} source={source} onMutate={onRefresh} />
								))}
							</div>
						) : (
							<p className="py-2 text-small text-muted-foreground">Connect a source to start indexing.</p>
						)}
						<SectionAction className="mt-1" onClick={() => setConnectOpen(true)}>
							Connect a source
						</SectionAction>
					</div>
				)}
			</section>
			<ConnectSourceDialog open={connectOpen} onClose={() => setConnectOpen(false)} onConnected={onRefresh} />
		</>
	);
}

function HomeSourceRow({ source, onMutate }: { source: SignetSource; onMutate: () => void }) {
	const health = source.health?.status ?? "empty";
	const failures = source.health?.failures?.total ?? 0;
	const {
		copied,
		confirming,
		busy,
		action,
		message,
		error,
		copyRoot,
		browseRoot,
		reindex,
		snapshot,
		remove,
		setConfirming,
	} = useSourceActions(source, onMutate);
	const format = typeof source.providerSettings?.format === "string" ? source.providerSettings.format : source.kind;
	const issue = sourceIssue(source);

	return (
		<details className="group/source" data-health={health} data-source-id={source.id}>
			<summary className="flex min-w-0 cursor-pointer list-none items-center gap-2 py-2.5 [&::-webkit-details-marker]:hidden">
				<span className="grid size-4.5 shrink-0 place-items-center text-foreground">
					{sourceLogo(source.kind, { className: "size-4" }) ?? <Folder className="size-3.5" />}
				</span>
				<span className="flex min-w-0 flex-1 flex-col leading-tight">
					<span className="truncate text-body">{source.name}</span>
				</span>
				{(HEALTH_STATUS[health] || failures > 0) && (
					<StatusLabel tone={HEALTH_STATUS[health]?.tone ?? "warn"}>
						{HEALTH_STATUS[health]?.label ?? "Healthy"}
						{failures > 0 && ` · ${failures} ${failures === 1 ? "failure" : "failures"}`}
					</StatusLabel>
				)}
				<ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open/source:rotate-90" />
			</summary>
			<div className="pb-2.5 pl-6.5">
				{issue && (
					<p className="home-source-reason" data-tone={issue.tone}>
						<span>{issue.title}.</span>
						{issue.detail && source.health?.permission?.status !== "denied" && <> {issue.detail}</>}
					</p>
				)}
				<div className="flex min-w-0 items-center gap-1.5">
					<div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-[var(--control-radius)] bg-[color-mix(in_oklch,var(--foreground)_3%,transparent)] pl-2 pr-1">
						<RootIcon kind={source.kind} />
						<span className="min-w-0 flex-1 break-all py-1 font-mono text-meta leading-relaxed text-muted-foreground">
							{source.root}
						</span>
						{source.kind === "obsidian" && (
							<button
								type="button"
								onClick={browseRoot}
								disabled={busy}
								title="Choose vault folder"
								aria-label="Choose vault folder"
								className="grid size-[22px] shrink-0 place-items-center rounded-[var(--control-radius)] text-muted-foreground hover:bg-[var(--home-interactive)] hover:text-foreground disabled:opacity-40"
							>
								<FolderOpen className="size-3" />
							</button>
						)}
						<button
							type="button"
							onClick={copyRoot}
							title={copied ? "Copied" : "Copy path"}
							aria-label={copied ? "Copied" : "Copy source root path"}
							className="grid size-[22px] shrink-0 place-items-center rounded-[var(--control-radius)] text-muted-foreground hover:bg-[var(--home-interactive)] hover:text-foreground"
						>
							{copied ? <Check className="size-3" /> : <Copy className="size-3" />}
						</button>
					</div>
				</div>

				<div
					className="mt-1.5 flex flex-wrap items-baseline gap-x-2 text-meta tabular-nums text-muted-foreground"
					role="group"
					aria-label="Source indexing totals"
				>
					<span>
						<span className="text-foreground">{source.stats?.artifacts?.toLocaleString() ?? "—"}</span> artifacts
					</span>
					<span aria-hidden="true">·</span>
					<span>
						<span className="text-foreground">{source.stats?.chunks?.toLocaleString() ?? "—"}</span> chunks
					</span>
					<span aria-hidden="true">·</span>
					<span>
						<span className="text-foreground">{source.stats?.indexed?.toLocaleString() ?? "—"}</span> indexed
					</span>
				</div>

				<div className="mt-1.5">
					<PipeStrip job={source.indexJob} health={health} compact />
				</div>
				<div className="mt-2 flex items-center justify-between gap-2 text-meta tabular-nums text-muted-foreground">
					<span>
						{format} · {source.mode}
					</span>
					<span className="shrink-0">{relTime(source.lastIndexedAt)}</span>
				</div>
				{source.health?.permission?.status === "denied" && (
					<div className="home-source-warning mt-2 rounded-md border px-2 py-1.5 text-meta tabular-nums">
						{source.health.permission.issues.map((issue) => (
							<div key={issue.path} title={issue.path}>
								{issue.guidance}
							</div>
						))}
					</div>
				)}
				{source.kind === "import" && <ImportExtractionSummary extraction={source.health?.importExtraction} />}

				<div className="mt-2 flex items-center justify-between gap-2">
					{error ? (
						<span role="alert" className="min-w-0 break-words text-meta tabular-nums text-destructive">
							{error}
						</span>
					) : (
						<span role="status" className="text-meta tabular-nums text-muted-foreground">
							{copied
								? "Copied"
								: action === "reindex"
									? "Requesting re-index…"
									: action === "snapshot"
										? "Preparing snapshot…"
										: action === "browse"
											? "Choosing folder…"
											: action === "remove"
												? "Removing…"
												: message}
						</span>
					)}
					<div className="flex shrink-0 gap-0.5">
						{confirming ? (
							<>
								<ActionButton label="Remove source" danger onClick={remove} disabled={busy}>
									<Check className="size-[13px]" />
								</ActionButton>
								<ActionButton label="Cancel" onClick={() => setConfirming(false)} disabled={busy}>
									<X className="size-[13px]" />
								</ActionButton>
							</>
						) : (
							<>
								<ActionButton label="Re-index" onClick={reindex} disabled={busy}>
									<RotateCw
										className={cn("size-[13px]", action === "reindex" && "animate-spin motion-reduce:animate-none")}
									/>
								</ActionButton>
								<ActionButton label="Snapshot" onClick={snapshot} disabled={busy}>
									<Download className="size-[13px]" />
								</ActionButton>
								<ActionButton label="Remove" danger onClick={() => setConfirming(true)} disabled={busy}>
									<Trash2 className="size-[13px]" />
								</ActionButton>
							</>
						)}
					</div>
				</div>
			</div>
		</details>
	);
}

function ImportExtractionSummary({ extraction }: { extraction: SourceHealth["importExtraction"] | undefined }) {
	if (!extraction) {
		return <span className="truncate text-meta tabular-nums text-muted-foreground">import result unavailable</span>;
	}
	return (
		<span
			className="truncate text-meta tabular-nums text-muted-foreground"
			title={extraction.documentEntityId ? `Document entity ${extraction.documentEntityId}` : undefined}
		>
			{extraction.documentEntityId ? "document indexed · read by Dreaming" : "no document entity"}
		</span>
	);
}

function useSourceActions(source: SignetSource, onMutate: () => void) {
	const [copied, setCopied] = useState(false);
	const [confirming, setConfirming] = useState(false);
	const [action, setAction] = useState<"browse" | "reindex" | "snapshot" | "remove" | null>(null);
	const busy = action !== null;
	const [message, setMessage] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(
		() => () => {
			if (copyTimer.current) clearTimeout(copyTimer.current);
		},
		[],
	);

	const copyRoot = async () => {
		setError(null);
		setMessage(null);
		try {
			await navigator.clipboard.writeText(source.root);
			setCopied(true);
			if (copyTimer.current) clearTimeout(copyTimer.current);
			copyTimer.current = setTimeout(() => setCopied(false), 1200);
		} catch {
			setError("Unable to copy the source path.");
		}
	};

	const browseRoot = async () => {
		if (busy || source.kind !== "obsidian") return;
		setAction("browse");
		setMessage(null);
		setError(null);
		const picked = await api.pickDirectory();
		if (!picked.ok || !picked.path) {
			setAction(null);
			setError(picked.unavailable ? "Choose a folder from the desktop app." : "Select a folder to continue.");
			return;
		}
		if (picked.path === source.root) {
			setAction(null);
			return;
		}
		const result = await api.addSource("obsidian", { root: picked.path, name: source.name });
		setAction(null);
		if (!result.ok) {
			setError(result.error ?? "Unable to update the source folder. Try again.");
			return;
		}
		onMutate();
	};

	const reindex = async () => {
		if (busy) return;
		setAction("reindex");
		setMessage(null);
		setError(null);
		const result = await api.reindexSource(source);
		setAction(null);
		if (!result.ok) {
			setError(result.error ?? "Unable to re-index the source. Try again.");
			return;
		}
		setMessage("Re-index requested.");
		onMutate();
	};

	const snapshot = async () => {
		if (busy) return;
		setAction("snapshot");
		setMessage(null);
		setError(null);
		const data = await api.getSourceSnapshot(source.id);
		setAction(null);
		if (data === null) {
			setError("Unable to prepare the snapshot. Try again.");
			return;
		}
		const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = `${source.id.replace(/[^a-z0-9]+/gi, "-")}-snapshot.json`;
		a.click();
		URL.revokeObjectURL(url);
		setMessage("Snapshot ready.");
	};

	const remove = async () => {
		if (busy) return;
		setAction("remove");
		setMessage(null);
		setError(null);
		const result = await api.removeSource(source.id);
		setAction(null);
		if (!result.ok) {
			setError(result.error ?? "Unable to remove the source. Try again.");
			setConfirming(false);
			return;
		}
		onMutate();
	};

	return {
		copied,
		confirming,
		busy,
		action,
		message,
		error,
		copyRoot,
		browseRoot,
		reindex,
		snapshot,
		remove,
		setConfirming,
	};
}

function PipeStrip({
	job,
	health,
	compact = false,
}: {
	job?: SourceIndexJob | null;
	health: string;
	compact?: boolean;
}) {
	const healthDot = health === "degraded" ? "amber" : health === "unhealthy" ? "red" : "";
	const healthFill = health === "degraded" ? "degraded" : health === "unhealthy" ? "unhealthy" : "";

	let dot: string = healthDot;
	let fill: string = healthFill;
	let pct = 0;
	let text = "no job";

	if (job) {
		if (job.status === "complete") {
			pct = 100;
			text = `indexed ${(job.indexed ?? 0).toLocaleString()}`;
		} else if (job.status === "queued") {
			dot = "amber";
			fill = "queued";
			pct = 0;
			text = "queued…";
		} else if (job.status === "running") {
			pct = job.total && job.total > 0 ? Math.round(((job.scanned ?? 0) / job.total) * 100) : 0;
			text = `${pct}% · ${job.currentPath || "scanning"}`;
		} else if (job.status === "error") {
			dot = "red";
			fill = "error";
			pct = 100;
			text = "error";
		}
	}

	return (
		<div
			className={cn(
				"flex items-center",
				compact
					? "gap-1.5"
					: "gap-[9px] rounded-[7px] bg-[color-mix(in_oklch,var(--foreground)_2.5%,transparent)] px-2.5 py-2",
			)}
		>
			<span
				className={cn(
					"shrink-0 rounded-full",
					compact ? "size-1" : "size-1.5",
					dot === "amber" && "home-status-warning",
					dot === "red" && "home-status-danger",
					dot === "" && "home-status-healthy",
				)}
			/>
			<div
				className={cn(
					"flex-1 overflow-hidden rounded-sm bg-[color-mix(in_oklch,var(--foreground)_8%,transparent)]",
					compact ? "h-[2px]" : "h-[3px]",
				)}
			>
				<div
					className={cn(
						"h-full rounded-sm transition-[width] duration-500",
						fill === "error" || fill === "unhealthy"
							? "home-status-danger"
							: fill === "queued" || fill === "degraded"
								? "home-status-warning"
								: "home-status-healthy",
					)}
					style={{ width: `${pct}%` }}
				/>
			</div>
			<span
				className={cn(
					"shrink-0 truncate text-muted-foreground",
					compact ? "max-w-[38%] text-meta" : "max-w-[45%] text-meta",
				)}
				title={text}
			>
				{text}
			</span>
		</div>
	);
}

function ActionButton({
	label,
	danger = false,
	disabled = false,
	onClick,
	children,
}: {
	label: string;
	danger?: boolean;
	disabled?: boolean;
	onClick: () => void;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			title={label}
			aria-label={label}
			disabled={disabled}
			onClick={onClick}
			className={cn(
				"grid size-[26px] place-items-center rounded-md text-muted-foreground transition-colors hover:bg-[var(--home-interactive)] hover:text-foreground disabled:opacity-40",
				danger && "hover:text-[var(--home-health-unhealthy)]",
			)}
		>
			{children}
		</button>
	);
}

function relTime(iso?: string | null): string {
	if (!iso) return "never";
	const sec = (Date.now() - new Date(iso).getTime()) / 1000;
	if (sec < 60) return "just now";
	if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
	if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
	return `${Math.floor(sec / 86400)}d ago`;
}

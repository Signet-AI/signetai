import { LoadingRows } from "@/components/ui/skeleton";
import { SectionHeading } from "@/components/dashboard/heading";
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
	Plus,
	RotateCw,
	Trash2,
	X,
} from "@/components/mingcute-icons";
import { useEffect, useRef, useState } from "react";

const HEALTH_STYLES: Record<string, string> = {
	healthy: "home-health-healthy",
	degraded: "home-health-degraded",
	unhealthy: "home-health-unhealthy",
	empty: "home-health-empty",
};
function RootIcon({ kind }: { kind: string }) {
	const cls = "size-[13px] shrink-0 text-muted-foreground";
	if (kind === "github") return <GitBranch className={cls} aria-hidden="true" />;
	if (kind === "web") return <Globe className={cls} aria-hidden="true" />;
	if (kind === "discord" || kind === "slack") return <Globe className={cls} aria-hidden="true" />;
	return <Folder className={cls} aria-hidden="true" />;
}
export function HomeSourcesPanel({
	sources,
	loading,
	onRefresh,
}: {
	sources?: readonly SignetSource[];
	loading: boolean;
	onRefresh: () => void;
}) {
	const [connectOpen, setConnectOpen] = useState(false);
	const { connectSourceRequested, clearConnectSource } = useView();

	useEffect(() => {
		if (!connectSourceRequested) return;
		setConnectOpen(true);
		clearConnectSource();
	}, [connectSourceRequested, clearConnectSource]);

	return (
		<>
			<section className="group pb-3">
				<SectionHeading
					title="Sources"
					className="items-center gap-3"
					actions={
						<button
							type="button"
							onClick={() => setConnectOpen(true)}
							className="home-text-action h-7 rounded-[var(--control-radius)] px-1 hover:text-foreground"
						>
							<Plus className="size-3" />
							Connect a source
						</button>
					}
				/>
				{loading ? (
					<LoadingRows label="Loading sources…" rows={2} />
				) : sources === undefined ? (
					<div className="flex min-h-[72px] items-center justify-center gap-2 text-center">
						<span className="font-mono text-[10px] text-muted-foreground">Unable to load sources.</span>
						<button type="button" className="home-text-action shrink-0" onClick={onRefresh}>
							Retry
						</button>
					</div>
				) : sources.length > 0 ? (
					<div className="mt-3 divide-y divide-border">
						{sources.map((source) => (
							<HomeSourceRow key={source.id} source={source} onMutate={onRefresh} />
						))}
					</div>
				) : (
					<div className="mt-3 flex min-h-[60px] items-center gap-3">
						<Folder className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
						<div>
							<p className="text-[13px] text-foreground">No sources connected yet</p>
							<p className="mt-1 text-xs text-muted-foreground">Connect a source to start indexing.</p>
						</div>
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

	return (
		<details className="group/source" data-health={health}>
			<summary className="flex min-w-0 cursor-pointer list-none items-center gap-2 py-2.5 [&::-webkit-details-marker]:hidden">
				<span className="grid size-4.5 shrink-0 place-items-center text-foreground">
					{sourceLogo(source.kind, { className: "size-4" }) ?? <Folder className="size-3.5" />}
				</span>
				<span className="flex min-w-0 flex-1 flex-col leading-tight">
					<span className="truncate text-[12px] font-medium">{source.name}</span>
				</span>
				<span className={cn("flex shrink-0 items-center gap-1 font-mono text-[9px]", HEALTH_STYLES[health])}>
					<span className="size-1.5 rounded-full bg-current" />
					{health}
					{failures > 0 && ` · ${failures} ${failures === 1 ? "failure" : "failures"}`}
				</span>
				<ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open/source:rotate-90" />
			</summary>
			<div className="pb-2.5 pl-6.5">
				<div className="flex min-w-0 items-center gap-1.5">
					<div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-[var(--control-radius)] bg-[color-mix(in_oklch,var(--foreground)_3%,transparent)] pl-2 pr-1">
						<RootIcon kind={source.kind} />
						<span className="min-w-0 flex-1 break-all py-1 font-mono text-[9.5px] leading-relaxed text-muted-foreground">
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
					className="mt-1.5 flex flex-wrap items-baseline gap-x-2 font-mono text-[9px] text-muted-foreground"
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
				<div className="mt-2 flex items-center justify-between gap-2 font-mono text-[9px] text-muted-foreground">
					<span>
						{format} · {source.mode}
					</span>
					<span className="shrink-0">{relTime(source.lastIndexedAt)}</span>
				</div>
				{source.health?.permission?.status === "denied" && (
					<div className="home-source-warning mt-2 rounded-md border px-2 py-1.5 font-mono text-[9px]">
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
						<span role="alert" className="min-w-0 break-words font-mono text-[9px] text-destructive">
							{error}
						</span>
					) : (
						<span role="status" className="font-mono text-[9px] text-muted-foreground">
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
	if (
		!extraction ||
		typeof extraction.aspectsCreated !== "number" ||
		typeof extraction.attributesCreated !== "number"
	) {
		return <span className="truncate font-mono text-[9px] text-muted-foreground">extraction result unavailable</span>;
	}
	if (extraction.aspectsCreated === 0 && extraction.attributesCreated === 0) {
		return <span className="truncate font-mono text-[9px] text-muted-foreground">no structured graph result</span>;
	}
	const entity = extraction.documentEntityId ? "entity linked" : "no entity linked";
	return (
		<span
			className="truncate font-mono text-[9px] text-muted-foreground"
			title={extraction.documentEntityId ? `Document entity ${extraction.documentEntityId}` : undefined}
		>
			{extraction.aspectsCreated} aspects · {extraction.attributesCreated} attributes · {entity}
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
					"shrink-0 truncate font-mono text-muted-foreground",
					compact ? "max-w-[38%] text-[8px]" : "max-w-[45%] text-[9.5px]",
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

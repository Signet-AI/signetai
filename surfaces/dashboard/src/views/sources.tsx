import { sourceLogo } from "@/components/icons";
import { ConnectSourceDialog } from "@/components/sources/connect-source-dialog";
import { Surface } from "@/components/ui/surface";
import { type SignetSource, type SourceHealth, type SourceImportJob, type SourceIndexJob, api } from "@/lib/api";
import { useAsync } from "@/lib/use-async";
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
	MessageCircle as MessageSquare,
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

/** Leading glyph in the root-path bar (mockup ROOT_ICONS). */
function RootIcon({ kind }: { kind: string }) {
	const cls = "size-[13px] shrink-0 text-muted-foreground";
	if (kind === "github") return <GitBranch className={cls} aria-hidden="true" />;
	if (kind === "web") return <Globe className={cls} aria-hidden="true" />;
	if (kind === "discord" || kind === "slack") return <Globe className={cls} aria-hidden="true" />;
	return <Folder className={cls} aria-hidden="true" />;
}

/**
 * Home owns the source workflow. Keep the default view compact and defer
 * source-specific telemetry/actions to native disclosure rows.
 */
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
				<div className="flex items-center justify-between gap-3">
					<span className="text-[15px] font-semibold tracking-tight text-foreground">Sources</span>
					<button
						type="button"
						onClick={() => setConnectOpen(true)}
						className="inline-flex h-6 items-center gap-1.5 rounded-[var(--radius)] border border-border px-2 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
					>
						<Plus className="size-3" />
						Connect a source
					</button>
				</div>
				{loading ? (
					<div className="grid min-h-[72px] place-items-center">
						<span className="font-mono text-[10px] text-muted-foreground">Loading sources…</span>
					</div>
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
					<div className="grid min-h-[72px] place-items-center text-center">
						<span className="font-mono text-[10px] text-muted-foreground">No sources connected yet. Add a source to begin indexing.</span>
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
	const { copied, confirming, busy, action, message, error, copyRoot, browseRoot, reindex, snapshot, remove, setConfirming } =
		useSourceActions(source, onMutate);
	const format = typeof source.providerSettings?.format === "string" ? source.providerSettings.format : source.kind;

	return (
		<details className="group/source" data-health={health}>
			<summary className="flex min-w-0 cursor-pointer list-none items-center gap-2 py-2.5 [&::-webkit-details-marker]:hidden">
				<span className="grid size-4.5 shrink-0 place-items-center text-foreground">
					{sourceLogo(source.kind, { className: "size-4" }) ?? <Folder className="size-3.5" />}
				</span>
				<span className="flex min-w-0 flex-1 flex-col leading-tight">
					<span className="truncate text-[12px] font-medium">
						{source.name}
					</span>
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
					<div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md bg-[color-mix(in_oklch,var(--foreground)_3%,transparent)] pl-2 pr-1">
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
									className="grid size-[22px] shrink-0 place-items-center rounded-[5px] text-muted-foreground hover:bg-[var(--home-interactive)] hover:text-foreground disabled:opacity-40"
							>
								<FolderOpen className="size-3" />
							</button>
						)}
						<button
							type="button"
							onClick={copyRoot}
							title={copied ? "Copied" : "Copy path"}
							aria-label={copied ? "Copied" : "Copy source root path"}
							className="grid size-[22px] shrink-0 place-items-center rounded-[5px] text-muted-foreground hover:bg-[var(--home-interactive)] hover:text-foreground"
						>
							{copied ? <Check className="size-3" /> : <Copy className="size-3" />}
						</button>
					</div>
				</div>

				<div
					className="mt-1.5 flex flex-wrap items-baseline gap-x-2 font-mono text-[9px] text-muted-foreground"
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
							{copied ? "Copied" : action === "reindex" ? "Requesting re-index…" : action === "snapshot" ? "Preparing snapshot…" : action === "browse" ? "Choosing folder…" : action === "remove" ? "Removing…" : message}
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
									<RotateCw className={cn("size-[13px]", action === "reindex" && "animate-spin motion-reduce:animate-none")} />
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

export function SourcesView() {
	const { data, refresh } = useAsync(() => api.getSources(), { intervalMs: 30000 });
	const sources = data?.sources;
	const { data: importsData, refresh: refreshImports } = useAsync(() => api.getSourceImports(), { intervalMs: 5000 });
	const imports = importsData?.data?.imports ?? [];
	const refreshAll = () => {
		refresh();
		refreshImports();
	};
	const [connectOpen, setConnectOpen] = useState(false);
	const { connectSourceRequested, clearConnectSource } = useView();

	// Cross-view handoff: the memory view's "Ingest source" button sets this
	// flag (via requestConnectSource) and we consume it on mount/update.
	useEffect(() => {
		if (!connectSourceRequested) return;
		setConnectOpen(true);
		clearConnectSource();
	}, [connectSourceRequested, clearConnectSource]);

	const allSources = sources ?? [];
	const importedSources = allSources.filter((source) => source.kind === "import");
	const connectedSources = allSources.filter((source) => source.kind !== "import");
	const totals = allSources.reduce(
		(acc, s) => ({
			artifacts: acc.artifacts + (s.stats?.artifacts ?? 0),
			chunks: acc.chunks + (s.stats?.chunks ?? 0),
			indexed: acc.indexed + (s.stats?.indexed ?? 0),
		}),
		{ artifacts: 0, chunks: 0, indexed: 0 },
	);
	const connected = connectedSources.filter((s) => s.enabled).length;

	return (
		<div className="flex flex-1 flex-col gap-3 min-h-0">
			<div className="flex shrink-0 items-center gap-[9px] px-0.5 pb-3.5 font-mono">
				<HeroStat value={sources ? totals.artifacts.toLocaleString() : "—"} label="artifacts" />
				<Sep />
				<HeroStat value={sources ? totals.chunks.toLocaleString() : "—"} label="chunks" />
				<Sep />
				<HeroStat value={sources ? totals.indexed.toLocaleString() : "—"} label="indexed" />
				<Sep />
				<span className="inline-flex items-center gap-[5px] text-[10.5px] text-muted-foreground">
					<span className="size-1.5 rounded-full bg-success shadow-[0_0_6px_color-mix(in_oklch,var(--success)_50%,transparent)]" />
					{sources ? `${connected} sources connected` : "connecting…"}
				</span>
				<div className="flex-1" />
			</div>

			<div className="grid flex-1 grid-cols-1 content-start gap-3 overflow-y-auto py-3 md:grid-cols-2 [mask-image:linear-gradient(180deg,#000_0,#000_calc(100%-24px),transparent_100%)]">
				<button
					type="button"
					onClick={() => setConnectOpen(true)}
					className="flex min-h-[180px] flex-col items-center justify-center gap-2.5 rounded-[var(--radius)] border-[1.5px] border-dashed border-[oklch(1_0_0/0.12)] bg-[color-mix(in_oklch,var(--card)_86%,transparent)] p-6 transition-all hover:border-[color-mix(in_oklch,var(--success)_45%,transparent)] hover:bg-[color-mix(in_oklch,var(--success)_5%,transparent)] [html:not(.dark)_&]:border-[oklch(0_0_0/0.12)]"
				>
					<span className="grid size-10 place-items-center rounded-full border border-[oklch(1_0_0/0.08)] bg-[color-mix(in_oklch,var(--foreground)_4%,transparent)] text-muted-foreground">
						<Plus className="size-[18px]" />
					</span>
					<span className="text-[12.5px] font-medium">Connect a source</span>
					<span className="font-mono text-[9.5px] text-muted-foreground">Obsidian · GitHub · Discord</span>
				</button>
				{imports.map((job) => (
					<TranscriptImportCard key={job.id} job={job} onMutate={refreshAll} />
				))}
				{importedSources.length > 0 && <ImportedDocumentsCard documents={importedSources} onMutate={refresh} />}
				{connectedSources.map((source) => (
					<SourceCard key={source.id} source={source} onMutate={refresh} />
				))}
			</div>
			<ConnectSourceDialog open={connectOpen} onClose={() => setConnectOpen(false)} onConnected={refresh} />
		</div>
	);
}

function TranscriptImportCard({ job, onMutate }: { job: SourceImportJob; onMutate: () => void }) {
	const { data: detail } = useAsync(() => api.getSourceImport(job.id), { intervalMs: 3000 });
	const current = detail?.data?.job ?? job;
	const files = detail?.data?.files ?? job.files ?? [];
	const terminal = ["completed", "completed_with_rejections", "cancelled", "failed"].includes(current.state);
	const control = async (action: "pause" | "resume" | "retry" | "cancel") => {
		await api.controlSourceImport(job.id, action);
		onMutate();
	};
	return (
		<Surface
			data-testid="transcript-import-job"
			aria-label={`Transcript import ${current.id}`}
			className="sig-src-card flex flex-col gap-2.5 p-4"
		>
			<div className="flex items-center gap-3">
				<MessageSquare className="size-5" />
				<div className="min-w-0 flex-1">
					<div className="text-[14px] font-semibold">Agent transcripts</div>
					<div className="truncate font-mono text-[9.5px] text-muted-foreground">job {current.id}</div>
				</div>
				<span className="font-mono text-[10px]">{current.state}</span>
			</div>
			<div className="grid grid-cols-2 gap-2 font-mono text-[10px]">
				<MiniStat value={String(current.imported ?? 0)} label="imported" />
				<MiniStat value={String(current.rejected ?? 0)} label="rejected" />
				<MiniStat value={String(current.pending ?? 0)} label="pending" />
				<MiniStat value="—" label="dreaming" />
			</div>
			{files.length > 0 && (
				<ul aria-label="Transcript import files" className="flex flex-col gap-1 font-mono text-[10px]">
					{files.map((file) => (
						<li key={file.id} className="flex justify-between gap-2">
							<span className="truncate">{file.name ?? file.id}</span>
							<span>{file.state ?? "pending"}</span>
						</li>
					))}
				</ul>
			)}
			{!terminal && (
				<div className="flex gap-1">
					{current.state === "paused" ? (
						<ActionButton label="Resume" onClick={() => void control("resume")}>
							<RotateCw className="size-3" />
						</ActionButton>
					) : (
						<ActionButton label="Pause" onClick={() => void control("pause")}>
							<X className="size-3" />
						</ActionButton>
					)}
					<ActionButton label="Retry" onClick={() => void control("retry")}>
						<RotateCw className="size-3" />
					</ActionButton>
					<ActionButton label="Cancel" danger onClick={() => void control("cancel")}>
						<X className="size-3" />
					</ActionButton>
				</div>
			)}
			<div className="flex gap-2 font-mono text-[10px]">
				<button type="button" className="underline" onClick={() => void downloadImportData(current.id, "rejections")}>
					Download rejections
				</button>
				<button type="button" className="underline" onClick={() => void showReconciliation(current.id)}>
					Reconciliation
				</button>
			</div>
		</Surface>
	);
}

async function downloadImportData(jobId: string, kind: "rejections"): Promise<void> {
	const data = await api.getSourceImportRejections(jobId);
	if (!data) return;
	const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
	const link = document.createElement("a");
	link.href = url;
	link.download = `${jobId}-${kind}.json`;
	link.click();
	URL.revokeObjectURL(url);
}

async function showReconciliation(jobId: string): Promise<void> {
	const data = await api.getSourceImportReconciliation(jobId);
	if (data) window.alert(JSON.stringify(data.reconciliation));
}
function ImportedDocumentsCard({ documents, onMutate }: { documents: readonly SignetSource[]; onMutate: () => void }) {
	const totals = documents.reduce(
		(acc, source) => ({
			artifacts: acc.artifacts + (source.stats?.artifacts ?? 0),
			chunks: acc.chunks + (source.stats?.chunks ?? 0),
			indexed: acc.indexed + (source.stats?.indexed ?? 0),
		}),
		{ artifacts: 0, chunks: 0, indexed: 0 },
	);

	return (
		<Surface
			data-testid="imported-documents-card"
			aria-label="Imported documents"
			className="sig-src-card sig-keylight-src flex h-[clamp(360px,45vh,480px)] min-h-0 flex-col gap-2.5 p-4"
		>
			<div className="flex shrink-0 items-center gap-3">
				<span className="grid size-9.5 shrink-0 place-items-center rounded-[9px] border border-[oklch(1_0_0/0.06)] bg-[color-mix(in_oklch,var(--foreground)_5%,transparent)] text-foreground">
					<Folder className="size-5" />
				</span>
				<div className="min-w-0 flex-1">
					<div className="text-[14px] font-semibold leading-tight tracking-tight">Documents</div>
					<div className="mt-0.5 font-mono text-[9.5px] tracking-[0.06em] text-muted-foreground">IMPORTED FILES</div>
				</div>
				<span className="shrink-0 font-mono text-[10px] text-muted-foreground">
					{documents.length} {documents.length === 1 ? "document" : "documents"}
				</span>
			</div>

			<ul
				aria-label="Imported documents"
				className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain pr-1 scrollbar-none"
				data-testid="imported-document-list"
			>
				{documents.map((source) => (
					<ImportedDocumentRow key={source.id} source={source} onMutate={onMutate} />
				))}
			</ul>

			<div className="grid shrink-0 grid-cols-3 gap-2 border-t border-[oklch(1_0_0/0.06)] pt-2 [html:not(.dark)_&]:border-[oklch(0_0_0/0.06)]">
				<MiniStat value={totals.artifacts.toLocaleString()} label="artifacts" />
				<MiniStat value={totals.chunks.toLocaleString()} label="chunks" />
				<MiniStat value={totals.indexed.toLocaleString()} label="indexed" />
			</div>
		</Surface>
	);
}

function ImportedDocumentRow({ source, onMutate }: { source: SignetSource; onMutate: () => void }) {
	const health = source.health?.status ?? "empty";
	const failures = source.health?.failures?.total ?? 0;
	const { copied, confirming, busy, error, copyRoot, snapshot, remove, setConfirming } = useSourceActions(
		source,
		onMutate,
	);
	const format = typeof source.providerSettings?.format === "string" ? source.providerSettings.format : "document";

	return (
		<li
			data-testid="imported-document-row"
			className="flex min-w-0 flex-col gap-1.5 border-b border-[oklch(1_0_0/0.07)] py-2 first:pt-0 last:border-b-0 last:pb-0 [html:not(.dark)_&]:border-[oklch(0_0_0/0.08)]"
		>
			<div className="flex min-w-0 items-center gap-2">
				<span className="grid size-7 shrink-0 place-items-center rounded-md bg-[color-mix(in_oklch,var(--foreground)_5%,transparent)] text-muted-foreground">
					<Folder className="size-3.5" />
				</span>
				<div className="min-w-0 flex-1">
					<div className="truncate text-[12px] font-medium" title={source.name}>
						{source.name}
					</div>
					<div className="mt-0.5 flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.05em] text-muted-foreground">
						<span>{format}</span>
						<span>·</span>
						<span>{source.mode}</span>
					</div>
				</div>
				<span className={cn("flex shrink-0 items-center gap-1 font-mono text-[9px]", HEALTH_STYLES[health])}>
					<span className="size-1.5 rounded-full bg-current" />
					{health}
					{failures > 0 && ` · ${failures} ${failures === 1 ? "failure" : "failures"}`}
				</span>
			</div>

			<div className="flex min-w-0 items-center gap-1.5">
				<div className="group/root flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden rounded-md bg-[color-mix(in_oklch,var(--foreground)_3%,transparent)] pl-2 pr-1">
					<Folder className="size-3 shrink-0 text-muted-foreground" />
					<span className="flex-1 truncate font-mono text-[9.5px] text-muted-foreground" title={source.root}>
						{source.root}
					</span>
					<button
						type="button"
						onClick={copyRoot}
						title="Copy path"
						aria-label="Copy source root path"
						className="grid size-[22px] shrink-0 place-items-center rounded-[5px] text-muted-foreground hover:bg-[var(--home-interactive)] hover:text-foreground"
					>
						{copied ? <Check className="size-3" /> : <Copy className="size-3" />}
					</button>
				</div>
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

			<PipeStrip job={source.indexJob} health={health} />
			<div className="flex min-w-0 items-center justify-between gap-2 font-mono text-[9px] text-muted-foreground">
				<span
					className="truncate"
					title={`${source.stats?.artifacts ?? 0} artifacts · ${source.stats?.chunks ?? 0} chunks · ${source.stats?.indexed ?? 0} indexed`}
				>
					{source.stats?.artifacts ?? 0} artifacts · {source.stats?.chunks ?? 0} chunks · {source.stats?.indexed ?? 0}{" "}
					indexed
				</span>
				<span className="shrink-0">{relTime(source.lastIndexedAt)}</span>
			</div>
			<ImportExtractionSummary extraction={source.health?.importExtraction} />
			{error && (
				<span className="truncate font-mono text-[9px] text-destructive" title={error}>
					{error}
				</span>
			)}
		</li>
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

	return { copied, confirming, busy, action, message, error, copyRoot, browseRoot, reindex, snapshot, remove, setConfirming };
}

function SourceCard({ source, onMutate }: { source: SignetSource; onMutate: () => void }) {
	const health = source.health?.status ?? "empty";
	const failures = source.health?.failures?.total ?? 0;
	const { copied, confirming, busy, error, copyRoot, reindex, snapshot, remove, setConfirming } = useSourceActions(
		source,
		onMutate,
	);

	return (
		<Surface className="sig-src-card sig-keylight-src group flex flex-col gap-2.5 p-4">
			<div className="flex items-center gap-3">
				<span className="grid size-9.5 shrink-0 place-items-center rounded-[9px] border border-[oklch(1_0_0/0.06)] bg-[color-mix(in_oklch,var(--foreground)_5%,transparent)] text-foreground">
					{sourceLogo(source.kind, { className: "size-5" }) ?? <span className="text-xs">●</span>}
				</span>
				<div className="min-w-0 flex-1">
					<div className="text-[14px] font-semibold leading-tight tracking-tight">{source.name}</div>
					<div className="mt-0.5 flex items-center gap-1.5 font-mono text-[9.5px] tracking-[0.06em] text-muted-foreground">
						<span className="uppercase">{source.kind}</span>
						<span>·</span>
						<span>{source.mode}</span>
					</div>
				</div>
				<span
					className={cn(
						"flex shrink-0 items-center gap-1.25 font-mono text-[9.5px] font-medium",
						HEALTH_STYLES[health],
					)}
				>
					<span className="size-1.5 rounded-full bg-current shadow-[0_0_6px_currentColor]" />
					{health.charAt(0).toUpperCase() + health.slice(1)}
					{failures > 0 && ` · ${failures} ${failures === 1 ? "failure" : "failures"}`}
				</span>
			</div>

			<div className="group/root flex h-7 items-center gap-1.75 overflow-hidden rounded-md bg-[color-mix(in_oklch,var(--foreground)_3%,transparent)] pl-2 pr-1 transition-colors hover:bg-[color-mix(in_oklch,var(--foreground)_5%,transparent)]">
				<RootIcon kind={source.kind} />
				<span className="flex-1 truncate font-mono text-[10.5px] text-muted-foreground">{source.root}</span>
				<button
					type="button"
					onClick={copyRoot}
					title="Copy path"
					aria-label="Copy source root path"
						className="grid size-[22px] shrink-0 place-items-center rounded-[5px] text-muted-foreground opacity-0 transition-opacity hover:bg-[var(--home-interactive)] hover:text-foreground group-hover/root:opacity-70 hover:!opacity-100"
				>
					{copied ? <Check className="size-3" /> : <Copy className="size-3" />}
				</button>
			</div>

			<div className="grid grid-cols-3 gap-2">
				<MiniStat value={source.stats?.artifacts?.toLocaleString() ?? "—"} label="artifacts" />
				<MiniStat value={source.stats?.chunks?.toLocaleString() ?? "—"} label="chunks" />
				<MiniStat value={source.stats?.indexed?.toLocaleString() ?? "—"} label="indexed" />
			</div>

			<PipeStrip job={source.indexJob} health={health} />
			{source.health?.permission?.status === "denied" && (
				<div className="home-source-warning rounded-md border px-2 py-1.5 font-mono text-[9.5px]">
					{source.health.permission.issues.map((issue) => (
						<div key={issue.path} title={issue.path}>
							{issue.guidance}
						</div>
					))}
				</div>
			)}

			<div className="mt-0.5 flex items-center justify-between border-t border-[oklch(1_0_0/0.06)] pt-2 [html:not(.dark)_&]:border-[oklch(0_0_0/0.06)]">
				{error ? (
					<span className="truncate font-mono text-[9.5px] text-destructive" title={error}>
						{error}
					</span>
				) : (
					<span className="font-mono text-[9.5px] text-muted-foreground">{relTime(source.lastIndexedAt)}</span>
				)}
				<div className="flex gap-0.5 opacity-50 transition-opacity group-hover:opacity-100">
					{confirming ? (
						<>
							<span className="mr-1 self-center font-mono text-[9.5px] text-muted-foreground">Remove and purge?</span>
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
								<RotateCw className="size-[13px]" />
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
		</Surface>
	);
}

/** Pipeline telemetry strip — mockup `pipeHtml` logic: job status wins, health tints dot/fill. */
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

function HeroStat({ value, label }: { value: string; label: string }) {
	return (
		<span className="inline-flex items-baseline gap-[5px]">
			<span className="font-mono text-[12px] font-medium tracking-tight text-foreground">{value}</span>
			<span className="text-[10.5px] text-muted-foreground">{label}</span>
		</span>
	);
}
function Sep() {
	return <span className="select-none text-muted-foreground/70">/</span>;
}
function MiniStat({ value, label }: { value: string; label: string }) {
	return (
		<div className="flex flex-col gap-0.5 rounded-[7px] bg-[color-mix(in_oklch,var(--foreground)_2.5%,transparent)] px-2.5 py-2">
			<span className="font-mono text-[14px] font-medium tracking-tight">{value}</span>
			<span className="text-[9px] uppercase tracking-[0.05em] text-muted-foreground">{label}</span>
		</div>
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

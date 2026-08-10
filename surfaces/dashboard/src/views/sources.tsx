import { sourceLogo } from "@/components/icons";
import { ConnectSourceDialog } from "@/components/sources/connect-source-dialog";
import { Surface } from "@/components/ui/surface";
import { type SignetSource, type SourceIndexJob, api } from "@/lib/api";
import { useAsync } from "@/lib/use-async";
import { cn } from "@/lib/utils";
import { useView } from "@/lib/view-context";
import { Check, Copy, Download, Folder, GitBranch, Globe, Plus, RotateCw, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

const HEALTH_STYLES: Record<string, string> = {
	healthy: "text-[oklch(0.72_0.15_150)]",
	degraded: "text-[oklch(0.75_0.15_85)]",
	unhealthy: "text-[oklch(0.7_0.18_25)]",
	empty: "text-muted-foreground",
};

/** Leading glyph in the root-path bar (mockup ROOT_ICONS). */
function RootIcon({ kind }: { kind: string }) {
	const cls = "size-[13px] shrink-0 text-[oklch(0.55_0_0)] [html:not(.dark)_&]:text-[oklch(0.45_0_0)]";
	if (kind === "github") return <GitBranch className={cls} aria-hidden="true" />;
	if (kind === "discord" || kind === "slack") return <Globe className={cls} aria-hidden="true" />;
	return <Folder className={cls} aria-hidden="true" />;
}

export function SourcesView() {
	const { data, refresh } = useAsync(() => api.getSources(), { intervalMs: 30000 });
	const sources = data?.sources;
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
				{importedSources.length > 0 && <ImportedDocumentsCard documents={importedSources} onMutate={refresh} />}
				{connectedSources.map((source) => (
					<SourceCard key={source.id} source={source} onMutate={refresh} />
				))}
			</div>
			<ConnectSourceDialog open={connectOpen} onClose={() => setConnectOpen(false)} onConnected={refresh} />
		</div>
	);
}

function ImportedDocumentsCard({
	documents,
	onMutate,
}: {
	documents: readonly SignetSource[];
	onMutate: () => void;
}) {
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
			className="sig-src-card sig-keylight-src flex flex-col gap-2.5 p-4"
		>
			<div className="flex items-center gap-3">
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

			<div
				className="flex max-h-[360px] flex-col gap-1.5 overflow-y-auto scrollbar-none"
				data-testid="imported-document-list"
			>
				{documents.map((source) => (
					<ImportedDocumentRow key={source.id} source={source} onMutate={onMutate} />
				))}
			</div>

			<div className="grid grid-cols-3 gap-2 border-t border-[oklch(1_0_0/0.06)] pt-2 [html:not(.dark)_&]:border-[oklch(0_0_0/0.06)]">
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
		<div className="flex min-w-0 flex-col gap-2 rounded-lg border border-[oklch(1_0_0/0.07)] bg-[color-mix(in_oklch,var(--foreground)_2.5%,transparent)] p-2.5 [html:not(.dark)_&]:border-[oklch(0_0_0/0.08)]">
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
					{failures > 0 && ` · ${failures} fail`}
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
						className="grid size-[22px] shrink-0 place-items-center rounded-[5px] text-muted-foreground hover:bg-[oklch(1_0_0/0.08)] hover:text-foreground"
					>
						{copied ? <Check className="size-3" /> : <Copy className="size-3" />}
					</button>
				</div>
				<div className="flex shrink-0 gap-0.5">
					{confirming ? (
						<>
							<ActionButton label="Confirm remove" danger onClick={remove} disabled={busy}>
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
			{error && (
				<span className="truncate font-mono text-[9px] text-destructive" title={error}>
					{error}
				</span>
			)}
		</div>
	);
}

function useSourceActions(source: SignetSource, onMutate: () => void) {
	const [copied, setCopied] = useState(false);
	const [confirming, setConfirming] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(
		() => () => {
			if (copyTimer.current) clearTimeout(copyTimer.current);
		},
		[],
	);

	const copyRoot = async () => {
		try {
			await navigator.clipboard.writeText(source.root);
			setCopied(true);
			if (copyTimer.current) clearTimeout(copyTimer.current);
			copyTimer.current = setTimeout(() => setCopied(false), 1200);
		} catch {
			setError("copy failed");
		}
	};

	const reindex = async () => {
		if (busy) return;
		setBusy(true);
		setError(null);
		const result = await api.reindexSource(source);
		setBusy(false);
		if (!result.ok) {
			setError(result.error ?? "re-index failed");
			return;
		}
		onMutate();
	};

	const snapshot = async () => {
		if (busy) return;
		setBusy(true);
		setError(null);
		const data = await api.getSourceSnapshot(source.id);
		setBusy(false);
		if (data === null) {
			setError("snapshot failed");
			return;
		}
		const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = `${source.id.replace(/[^a-z0-9]+/gi, "-")}-snapshot.json`;
		a.click();
		URL.revokeObjectURL(url);
	};

	const remove = async () => {
		if (busy) return;
		setBusy(true);
		setError(null);
		const result = await api.removeSource(source.id);
		setBusy(false);
		if (!result.ok) {
			setError(result.error ?? "remove failed");
			setConfirming(false);
			return;
		}
		onMutate();
	};

	return { copied, confirming, busy, error, copyRoot, reindex, snapshot, remove, setConfirming };
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
					{failures > 0 && ` · ${failures} fail`}
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
					className="grid size-[22px] shrink-0 place-items-center rounded-[5px] text-muted-foreground opacity-0 transition-opacity hover:bg-[oklch(1_0_0/0.08)] hover:text-foreground group-hover/root:opacity-70 hover:!opacity-100"
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
							<span className="mr-1 self-center font-mono text-[9.5px] text-muted-foreground">Remove + purge?</span>
							<ActionButton label="Confirm remove" danger onClick={remove} disabled={busy}>
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
function PipeStrip({ job, health }: { job?: SourceIndexJob | null; health: string }) {
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
		<div className="flex items-center gap-[9px] rounded-[7px] bg-[color-mix(in_oklch,var(--foreground)_2.5%,transparent)] px-2.5 py-2">
			<span
				className={cn(
					"size-1.5 shrink-0 rounded-full",
					dot === "amber" && "bg-[oklch(0.75_0.15_85)] shadow-[0_0_6px_oklch(0.75_0.15_85/0.5)]",
					dot === "red" && "bg-[oklch(0.7_0.18_25)]",
					dot === "" && "bg-success shadow-[0_0_6px_color-mix(in_oklch,var(--success)_50%,transparent)]",
				)}
			/>
			<div className="h-[3px] flex-1 overflow-hidden rounded-sm bg-[color-mix(in_oklch,var(--foreground)_8%,transparent)]">
				<div
					className={cn(
						"h-full rounded-sm transition-[width] duration-500",
						fill === "error" || fill === "unhealthy"
							? "bg-[oklch(0.7_0.18_25)]"
							: fill === "queued"
								? "bg-[oklch(0.75_0.15_85)]"
								: fill === "degraded"
									? "bg-[oklch(0.75_0.15_85)] shadow-[0_0_6px_oklch(0.75_0.15_85/0.4)]"
									: "bg-success shadow-[0_0_6px_color-mix(in_oklch,var(--success)_50%,transparent)]",
					)}
					style={{ width: `${pct}%` }}
				/>
			</div>
			<span className="max-w-[45%] shrink-0 truncate font-mono text-[9.5px] text-muted-foreground" title={text}>
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
				"grid size-[26px] place-items-center rounded-md text-muted-foreground transition-colors hover:bg-[oklch(1_0_0/0.08)] hover:text-foreground disabled:opacity-40",
				danger && "hover:text-[oklch(0.7_0.18_25)]",
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
	return <span className="select-none text-[oklch(0.35_0_0)] [html:not(.dark)_&]:text-[oklch(0.65_0_0)]">/</span>;
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

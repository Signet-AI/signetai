import { DashboardRegion } from "@/components/dashboard/region";
import { MarkdownSummary, markdownSummaryPreview } from "@/components/dreams/summary";
import { PageHeading, SectionHeading } from "@/components/dashboard/heading";
import { PageControls, useBoundedPagination } from "@/components/dashboard/pagination";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { type DreamPass, type DreamToolCall, api } from "@/lib/api";
import { useAsync } from "@/lib/use-async";
import { cn } from "@/lib/utils";
import { Activity, AlertCircle, Check, ChevronRight, Loader2, Play, X } from "@/components/mingcute-icons";
import { useEffect, useMemo, useState } from "react";

function parseDate(s: string): Date | null {
	const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? `${s.replace(" ", "T")}Z` : s;
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? null : d;
}

function fmtTokens(n: number | null | undefined): string {
	if (n === null || n === undefined) return "—";
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

function fmtCost(n: number | null | undefined): string {
	if (n === null || n === undefined) return "—";
	return `$${n.toFixed(4)}`;
}

function fmtDuration(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const m = Math.floor(total / 60);
	const s = total % 60;
	return `${m}m ${String(s).padStart(2, "0")}s`;
}

function fmtTime(sqliteOrIso: string | null | undefined): string {
	if (!sqliteOrIso) return "—";
	const d = parseDate(sqliteOrIso);
	if (!d) return sqliteOrIso;
	return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

function fmtTimeShort(sqliteOrIso: string | null | undefined): string {
	if (!sqliteOrIso) return "—";
	const d = parseDate(sqliteOrIso);
	if (!d) return sqliteOrIso;
	return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function modeLabel(mode: string | null | undefined): string {
	if (!mode) return "—";
	if (mode.includes("hygiene")) return "hygiene";
	if (mode.includes("content")) return "content";
	return mode;
}

interface OntologyOp {
	operation?: string;
	payload?: Record<string, unknown>;
}
export function DreamsView() {
	const [detailPass, setDetailPass] = useState<DreamPass | null>(null);
	const status = useAsync(() => api.getDreamStatus(), { key: "dream-status", intervalMs: 3000 });

	const activePass = useMemo(() => status.data?.passes.find((p) => p.status === "running") ?? null, [status.data]);
	const trackedPass = activePass ?? status.data?.passes[0] ?? null;

	const lastSuccessful = useMemo(
		() => status.data?.passes.find((p) => p.status === "completed") ?? null,
		[status.data],
	);
	const runbook = useAsync(() => (lastSuccessful ? api.getDreamPassTools(lastSuccessful.id) : Promise.resolve(null)), {
		key: lastSuccessful ? `dream-tools:${lastSuccessful.id}` : undefined,
		intervalMs: 30000,
		deps: [lastSuccessful?.id ?? ""],
	});
	const summaryText = useMemo(() => {
		const items = runbook.data?.items ?? [];
		const write = items.find((t) => t.toolName === "runbook_write");
		const runbookSummary =
			write && typeof write.input?.summary === "string" && write.input.summary.trim()
				? write.input.summary.trim()
				: null;
		return runbookSummary ?? lastSuccessful?.summary ?? null;
	}, [runbook.data, lastSuccessful]);
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!activePass) return;
		const id = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(id);
	}, [activePass]);

	const lastPass = status.data?.passes[0] ?? null;
	const pendingAttention = status.data?.attention ?? [];
	const running = Boolean(activePass);
	const scheduler = status.data?.scheduler ?? null;
	const queueDeferred = scheduler?.status === "deferred" && scheduler.reason === "queue_pressure";
	const elapsedMs = activePass ? Math.max(0, now - (parseDate(activePass.startedAt ?? "")?.getTime() ?? now)) : 0;

	return (
		<div className="dreams-page">
			<PageHeading
				title="Dreams"
				description="How Signet reflects on your memories."
				className="flex h-auto! flex-wrap items-start justify-between gap-4"
			>
				<TriggerControl running={running} refresh={status.refresh} />
			</PageHeading>
			<div className="dreams-stats flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-border pb-4">
				<Stat label="state" value={running ? "running" : "idle"} live={running} />
				<Stat
					label={running ? "pass" : "last attempt"}
					value={
						running
							? `${modeLabel(activePass?.mode)} · ${fmtDuration(elapsedMs)}`
							: lastPass
								? `${modeLabel(lastPass.mode)} · ${fmtTimeShort(lastPass.completedAt ?? lastPass.startedAt)}`
								: "—"
					}
				/>
				<Stat
					label="tokens"
					value={`${fmtTokens((activePass ?? lastPass)?.tokensInput)} ↑ ${fmtTokens((activePass ?? lastPass)?.tokensOutput)} ↓`}
				/>
				<Stat label="cost" value={fmtCost((activePass ?? lastPass)?.tokensCost)} />
				<Stat label="attention" value={String(pendingAttention.length)} />
				<Stat label="backlog" value={fmtTokens(status.data?.episodicTokensPending ?? null)} />
				<span className="ml-auto flex shrink-0 items-center gap-3">
					<span
						className={cn(
							"flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground",
							queueDeferred && "text-[oklch(0.8_0.14_80)]",
						)}
					>
						<span
							className={cn("size-1.5 rounded-full bg-success", queueDeferred && "bg-[oklch(0.8_0.14_80)] shadow-none")}
						/>
						{status.error
							? "updates unavailable · showing saved data"
							: status.loading
								? "connecting to daemon…"
								: queueDeferred
									? "automatic Dreaming deferred: queue pressure"
									: "daemon reachable"}
					</span>
				</span>
			</div>

			<div className="dreams-workspace">
				<DreamingSummarySection pass={lastSuccessful} summary={summaryText} loading={runbook.loading} />
				<div className="dreams-right">
					<PassLedger passes={status.data?.passes ?? []} onSelect={setDetailPass} />
					<PassActivity pass={trackedPass} onDetails={setDetailPass} />
				</div>
			</div>

			{detailPass && <PassDetailDialog pass={detailPass} onClose={() => setDetailPass(null)} />}
		</div>
	);
}

function Stat({ label, value, live }: { label: string; value: string; live?: boolean }) {
	return (
		<span className="flex min-w-0 items-baseline gap-2">
			<span className="text-xs text-muted-foreground">{label}</span>
			<span className="flex min-w-0 items-center gap-1.5">
				{live && <span className="size-1.5 shrink-0 rounded-full bg-success" />}
				<span className="font-mono text-xs leading-relaxed text-foreground">{value}</span>
			</span>
		</span>
	);
}

function TriggerControl({ running, refresh }: { running: boolean; refresh: () => void }) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const trigger = async () => {
		setBusy(true);
		setError(null);
		const res = await api.triggerDream("incremental");
		setBusy(false);
		if (!res.ok) {
			setError(res.error ?? `HTTP ${res.status}`);
			return;
		}
		refresh();
	};
	if (running) {
		return (
			<span className="flex min-h-8 shrink-0 items-center gap-2 text-sm text-muted-foreground">
				<span className="size-1.5 rounded-full bg-success" />
				running
			</span>
		);
	}
	return (
		<div className="flex items-center gap-2">
			<Button
				variant="outline"
				size="compact"
				onClick={trigger}
				disabled={busy}
				className="min-h-9! gap-2! px-3! disabled:cursor-not-allowed disabled:opacity-50"
			>
				{busy ? (
					<>
						<Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" /> Starting…
					</>
				) : (
					<>
						<Play className="size-3.5" /> Run a pass
					</>
				)}
			</Button>
			{error && <span className="font-mono text-[10px] text-destructive">{error}</span>}
		</div>
	);
}

function DreamingSummarySection({
	pass,
	summary,
	loading,
}: {
	pass: DreamPass | null;
	summary: string | null;
	loading: boolean;
}) {
	return (
		<section className="dreams-summary dashboard-region">
			<SectionHeading
				title="Latest reflection"
				titleClassName="font-medium tracking-normal"
				meta={
					<span className="text-xs text-muted-foreground">
						{pass
							? `${modeLabel(pass.mode)} · ${fmtTimeShort(pass.completedAt ?? pass.startedAt)}`
							: "no completed pass"}
					</span>
				}
			/>
			<div
				role="region"
				className="dashboard-region-body dreams-reflection-body"
				tabIndex={0}
				aria-label="Reflection summary"
			>
				<MarkdownSummary text={summary ?? (loading ? "Loading reflection…" : "No reflection recorded yet.")} />
			</div>
		</section>
	);
}

function PassActivity({ pass, onDetails }: { pass: DreamPass | null; onDetails: (pass: DreamPass) => void }) {
	const tools = useAsync(() => (pass ? api.getDreamPassTools(pass.id) : Promise.resolve(null)), {
		key: pass ? `dream-tools:${pass.id}` : undefined,
		deps: [pass?.id],
		intervalMs: pass?.status === "running" ? 2500 : undefined,
	});
	const items = tools.data?.passId === pass?.id ? (tools.data?.items ?? []) : [];
	const { ref, page, pages, setPage, visible } = useBoundedPagination(items, 36, 28);
	return (
		<DashboardRegion
			className="dreams-activity"
			title={pass?.status === "running" ? "Current activity" : "Pass activity"}
			headerClassName="gap-2"
			bodyRef={ref}
			actions={
				pass && (
					<button type="button" className="dreams-text-action" onClick={() => onDetails(pass)}>
						Details <ChevronRight className="size-3" />
					</button>
				)
			}
			footer={<PageControls page={page} pages={pages} onPage={setPage} label="activity page" />}
		>
			{pass && (
				<p className="m-0 mb-2 text-xs text-muted-foreground">
					{modeLabel(pass.mode)} · {pass.status} · {fmtTimeShort(pass.startedAt)}
				</p>
			)}
			{items.length ? (
				visible.map((t) => (
					<div key={t.id} className="flex h-9 items-center justify-between gap-2 border-b border-border text-xs">
						<span className="truncate font-mono">
							{t.sequence} · {t.toolName}
						</span>
						<span>{t.success ? "done" : "failed"}</span>
					</div>
				))
			) : (
				<p className="m-0 line-clamp-3 text-sm text-muted-foreground">
					{tools.loading
						? "Loading activity…"
						: (pass?.error ?? (pass ? "No tool calls recorded." : "No passes recorded."))}
				</p>
			)}
		</DashboardRegion>
	);
}

function PassLedger({ passes, onSelect }: { passes: DreamPass[]; onSelect: (p: DreamPass) => void }) {
	const { ref, page, pages, setPage, visible } = useBoundedPagination(passes, 60);
	return (
		<DashboardRegion
			className="dreams-ledger"
			title="Recent passes"
			headerClassName="mb-3"
			bodyRef={ref}
			meta={<span className="font-mono text-xs text-muted-foreground">{passes.length} latest</span>}
			footer={<PageControls page={page} pages={pages} onPage={setPage} label="history page" />}
		>
			{passes.length ? (
				<ul className="m-0 list-none divide-y divide-border p-0">
					{visible.map((pass) => {
						const duration = Math.max(
							0,
							(parseDate(pass.completedAt ?? "")?.getTime() ?? 0) - (parseDate(pass.startedAt ?? "")?.getTime() ?? 0),
						);
						return (
							<li key={pass.id}>
								<button
									type="button"
									onClick={() => onSelect(pass)}
									className="dreams-pass-row h-15 w-full overflow-hidden rounded-md py-2 text-left hover:bg-muted/30"
								>
									<div className="flex items-start gap-3">
										<span className="min-w-0 flex-1 truncate text-sm leading-relaxed text-foreground">
											{pass.error ?? (pass.summary ? markdownSummaryPreview(pass.summary) : "No summary recorded.")}
										</span>
										<span className="shrink-0 font-mono text-xs text-muted-foreground">
											{fmtTimeShort(pass.startedAt)}
										</span>
										<ChevronRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
									</div>
									<div className="mt-1.5 flex items-center gap-3 overflow-hidden whitespace-nowrap text-xs text-muted-foreground">
										<ModeBadge mode={pass.mode} running={pass.status === "running"} failed={pass.status === "failed"} />
										<span>{pass.status}</span>
										<span>{duration > 0 ? fmtDuration(duration) : "—"}</span>
										<span>{fmtTokens(pass.tokensConsumed)} tokens</span>
										<span>{fmtCost(pass.tokensCost)}</span>
										<span>
											{(pass.mutationsApplied ?? 0) > 0 ? `${pass.mutationsApplied} applied` : "no mutations"}
										</span>
									</div>
								</button>
							</li>
						);
					})}
				</ul>
			) : (
				<p className="py-4 text-sm text-muted-foreground">No passes recorded.</p>
			)}
		</DashboardRegion>
	);
}

function PassDetailDialog({ pass, onClose }: { pass: DreamPass; onClose: () => void }) {
	const tools = useAsync(() => api.getDreamPassTools(pass.id), {
		key: `dream-tools:${pass.id}`,
		deps: [pass.id],
		intervalMs: pass.status === "running" ? 2500 : undefined,
	});
	const items = tools.data?.items ?? [];
	const nameMap = useMemo(() => {
		const m = new Map<string, string>();
		for (const t of items) {
			if (t.toolName !== "get_entity" || !t.output || typeof t.output !== "object") continue;
			const entity = (t.output as { entity?: { id?: string; name?: string } }).entity;
			if (entity?.id && entity.name) m.set(entity.id, entity.name);
		}
		return m;
	}, [items]);

	const mutations = useMemo(() => {
		const out: Array<{ seq: number; op: OntologyOp; callId: string }> = [];
		for (const t of items) {
			if (t.toolName !== "apply_ontology_ops" || !Array.isArray(t.input?.operations)) continue;
			for (const op of t.input.operations as ReadonlyArray<OntologyOp>) {
				out.push({ seq: t.sequence, op, callId: t.id });
			}
		}
		return out;
	}, [items]);

	const duration = Math.max(
		0,
		(parseDate(pass.completedAt ?? "")?.getTime() ?? 0) - (parseDate(pass.startedAt ?? "")?.getTime() ?? 0),
	);

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="max-w-3xl">
				<DialogHeader className="flex-row items-center justify-between gap-3 border-b border-border px-5 py-4">
					<DialogTitle className="flex items-center gap-2.5 text-[15px] font-semibold tracking-tight">
						<ModeBadge mode={pass.mode} running={pass.status === "running"} failed={pass.status === "failed"} />
						<span className="font-mono text-[12.5px]">pass {pass.id.slice(0, 8)}</span>
						<span className="font-mono text-[10.5px] font-normal text-muted-foreground">
							{fmtTime(pass.startedAt)} → {fmtTime(pass.completedAt)}
							{duration > 0 ? ` · ${fmtDuration(duration)}` : ""}
						</span>
					</DialogTitle>
				</DialogHeader>

				<div className="flex max-h-[72vh] flex-col gap-4 overflow-y-auto px-5 py-4">
					{pass.summary && <MarkdownSummary text={pass.summary} />}
					{pass.error && (
						<p className="m-0 flex items-start gap-1.5 text-[12px] leading-relaxed text-destructive">
							<AlertCircle className="mt-px size-3.5 shrink-0" />
							{pass.error}
						</p>
					)}

					{mutations.length > 0 && <MutationsList mutations={mutations} nameMap={nameMap} />}

					{tools.loading && !tools.data ? (
						<div className="grid min-h-[90px] place-items-center">
							<span className="flex items-center gap-2 font-mono text-[10.5px] text-muted-foreground">
								<Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" /> loading trace…
							</span>
						</div>
					) : items.length ? (
						<ToolCallList items={items} nameMap={nameMap} />
					) : (
						<div className="grid min-h-[60px] place-items-center">
							<span className="font-mono text-[10.5px] text-muted-foreground">No tool calls recorded.</span>
						</div>
					)}

					<div className="border-t border-border/60 pt-2.5 font-mono text-[10px] text-muted-foreground">
						<span>tokens {fmtTokens(pass.tokensConsumed)}</span>
						<span>
							{" "}
							· in {fmtTokens(pass.tokensInput)} / out {fmtTokens(pass.tokensOutput)}
						</span>
						<span>
							{" "}
							· cache {fmtTokens(pass.tokensCacheRead)}r/{fmtTokens(pass.tokensCacheWrite)}w
						</span>
						<span> · cost {fmtCost(pass.tokensCost)}</span>
						<span>
							{" "}
							· mutations {pass.mutationsApplied ?? 0}a/{pass.mutationsSkipped ?? 0}s/{pass.mutationsFailed ?? 0}f
						</span>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}
function MutationsList({
	mutations,
	nameMap,
}: {
	mutations: ReadonlyArray<{ seq: number; op: OntologyOp; callId: string }>;
	nameMap: ReadonlyMap<string, string>;
}) {
	const [expanded, setExpanded] = useState(false);
	const visible = expanded ? mutations : mutations.slice(0, 10);
	return (
		<div className="flex flex-col gap-1.5">
			<span className="font-mono text-[9px] uppercase tracking-[0.08em] text-muted-foreground/70">
				Mutations — {mutations.length}
			</span>
			{visible.map(({ seq, op, callId }) => (
				<MutationCard key={`${callId}-${seq}`} op={op} nameMap={nameMap} />
			))}
			{!expanded && mutations.length > 10 && (
				<Button variant="ghost" size="sm" className="self-start" onClick={() => setExpanded(true)}>
					show all {mutations.length}
				</Button>
			)}
		</div>
	);
}

function MutationCard({ op, nameMap }: { op: OntologyOp; nameMap: ReadonlyMap<string, string> }) {
	const name = op.operation ?? "?";
	const payload = op.payload && typeof op.payload === "object" ? (op.payload as Record<string, unknown>) : null;
	const details =
		payload?.details && typeof payload.details === "object" ? (payload.details as Record<string, unknown>) : null;
	const subjectRef = typeof payload?.subjectRef === "string" ? payload.subjectRef : null;
	const reason = typeof details?.reason === "string" ? details.reason : null;
	const extra = payload
		? Object.entries(payload).filter(([k]) => k !== "subjectRef" && k !== "details" && k !== "priority")
		: [];

	return (
		<div className="border-b border-border py-3">
			<div className="flex flex-wrap items-center gap-2">
				<span className="font-mono text-xs text-foreground">{name}</span>
				{typeof details?.kind === "string" && (
					<span className="font-mono text-xs text-muted-foreground">{details.kind}</span>
				)}
				{subjectRef && (
					<span className="font-mono text-[10px] text-muted-foreground">{resolveRef(subjectRef, nameMap)}</span>
				)}
				{extra.map(([k, v]) => (
					<span key={k} className="font-mono text-[10px] text-muted-foreground/80">
						{k}={String(v).slice(0, 40)}
					</span>
				))}
			</div>
			{reason && <p className="m-0 mt-1.5 text-[11.5px] leading-relaxed text-muted-foreground">{reason}</p>}
		</div>
	);
}
function resolveRef(ref: string, nameMap: ReadonlyMap<string, string>): string {
	if (ref.startsWith("entity:")) {
		const id = ref.slice("entity:".length);
		return nameMap.get(id) ?? `entity:${id.slice(0, 8)}`;
	}
	if (ref.startsWith("aspect:")) return `aspect:${ref.slice("aspect:".length, "aspect:".length + 8)}`;
	if (ref.startsWith("attention:")) return `attention:${ref.slice("attention:".length, "attention:".length + 8)}`;
	return ref.length > 24 ? `${ref.slice(0, 24)}…` : ref;
}
function ToolCallList({ items, nameMap }: { items: DreamToolCall[]; nameMap: ReadonlyMap<string, string> }) {
	return (
		<div className="flex flex-col gap-2">
			<span className="font-mono text-[9px] uppercase tracking-[0.08em] text-muted-foreground/70">
				Tool calls — {items.length}
			</span>
			{items.map((t) => (
				<ToolCallCard key={t.id} call={t} nameMap={nameMap} />
			))}
		</div>
	);
}

function ToolCallCard({ call, nameMap }: { call: DreamToolCall; nameMap: ReadonlyMap<string, string> }) {
	const inputText = prettyJson(call.input);
	const MAX = 4000;
	const truncated = inputText.length > MAX;
	const entityId = (call.input as { entityId?: string } | null)?.entityId;
	const resolvedName = entityId ? nameMap.get(entityId) : undefined;

	return (
		<div className="border-b border-border py-3">
			<div className="flex flex-wrap items-center gap-2 border-b border-border/40 px-3 py-1.5">
				<span className="font-mono text-[9.5px] text-muted-foreground/60">#{call.sequence}</span>
				<span className="font-mono text-[11px] font-medium text-foreground">{call.toolName}</span>
				{resolvedName && <span className="font-mono text-[10.5px] text-foreground">{resolvedName}</span>}
				<span className="ml-auto flex shrink-0 items-center gap-1.5 font-mono text-[9.5px] text-muted-foreground/70">
					{call.latencyMs}ms
					{call.success ? (
						<Check className="size-3 text-success" strokeWidth={3} />
					) : (
						<X className="size-3 text-destructive" strokeWidth={3} />
					)}
				</span>
			</div>
			<pre className="m-0 overflow-x-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[10.5px] leading-relaxed text-muted-foreground">
				{truncated ? `${inputText.slice(0, MAX)}\n… (parameters truncated at ${MAX} chars)` : inputText}
			</pre>
		</div>
	);
}

function prettyJson(v: unknown): string {
	if (v === null || v === undefined) return "";
	try {
		return JSON.stringify(v, null, 2);
	} catch {
		return String(v);
	}
}

function ModeBadge({ mode, running, failed }: { mode: string; running?: boolean; failed?: boolean }) {
	return (
		<span
			className={cn(
				"inline-flex shrink-0 items-center gap-1 font-mono text-xs",
				failed ? "text-destructive" : running ? "text-success" : "text-muted-foreground",
			)}
		>
			{running ? <Activity className="size-3" /> : null}
			{modeLabel(mode)}
		</span>
	);
}

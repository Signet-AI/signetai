import { MarkdownSummary, markdownSummaryPreview } from "@/components/dreams/summary";
import { PageHeading, SectionAction, SectionHeading, StatusLabel } from "@/components/dashboard/heading";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { type DreamPass, type DreamToolCall, api } from "@/lib/api";
import { useAsync } from "@/lib/use-async";
import { useScrollEnd } from "@/lib/use-scroll-end";
import { cn } from "@/lib/utils";
import { Activity, AlertCircle, Check, Loader2, Play, X } from "@/components/mingcute-icons";
import { useEffect, useMemo, useState } from "react";

export function parseDate(s: string): Date | null {
	const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(s) ? `${s.replace(" ", "T")}Z` : s;
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
			<div className="dreams-content">
				<PageHeading
					title="Dreams"
					description={
						<span className="dreams-status-line">
							<StatusLabel tone={running ? "ok" : "neutral"}>{running ? "Running" : "Idle"}</StatusLabel>
							{running ? (
								<span>
									{modeLabel(activePass?.mode)} pass, {fmtDuration(elapsedMs)}
								</span>
							) : (
								lastPass && (
									<span>
										Last pass {fmtTimeShort(lastPass.completedAt ?? lastPass.startedAt)}
										{lastPass.status === "failed" ? ", failed" : ""}
									</span>
								)
							)}
							{pendingAttention.length > 0 && <span>{pendingAttention.length} need attention</span>}
							{(status.data?.episodicTokensPending ?? 0) > 0 && (
								<span>{fmtTokens(status.data?.episodicTokensPending)} tokens waiting</span>
							)}
							{(status.error || queueDeferred) && (
								<StatusLabel tone={queueDeferred ? "warn" : "neutral"}>
									{status.error
										? "Updates unavailable, showing saved data"
										: "Automatic Dreaming deferred: queue pressure"}
								</StatusLabel>
							)}
						</span>
					}
					className="dreams-heading"
				>
					<TriggerControl running={running} refresh={status.refresh} />
				</PageHeading>

				<div className="dreams-workspace">
					<DreamingSummarySection pass={lastSuccessful} summary={summaryText} loading={runbook.loading} />
					<div className="dreams-right">
						<PassLedger passes={status.data?.passes ?? []} onSelect={setDetailPass} />
						<PassActivity pass={trackedPass} onDetails={setDetailPass} />
					</div>
				</div>
			</div>

			{detailPass && <PassDetailDialog pass={detailPass} onClose={() => setDetailPass(null)} />}
		</div>
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
	return (
		<div className="flex flex-col items-end gap-1.5">
			<button type="button" onClick={trigger} disabled={busy || running} className="dreams-run">
				{running ? (
					<>
						<Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" /> Running…
					</>
				) : busy ? (
					<>
						<Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" /> Starting…
					</>
				) : (
					<>
						<Play className="size-3.5" /> Run a pass
					</>
				)}
			</button>
			{error && <span className="text-meta text-destructive">{error}</span>}
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
	const scroll = useScrollEnd<HTMLDivElement>();
	return (
		<section className="dreams-summary" aria-labelledby="dreams-summary-title">
			<SectionHeading
				id="dreams-summary-title"
				title="Latest reflection"
				meta={
					<span className="text-meta tabular-nums text-muted-foreground">
						{pass
							? `${modeLabel(pass.mode)} · ${fmtTimeShort(pass.completedAt ?? pass.startedAt)}`
							: "No completed pass"}
					</span>
				}
			/>
			<div ref={scroll.ref} onScroll={scroll.onScroll} data-at-end={scroll.atEnd} className="dreams-reflection-body">
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
	const scroll = useScrollEnd<HTMLOListElement>();
	return (
		<section className="dreams-activity" aria-labelledby="dreams-activity-title">
			<SectionHeading
				id="dreams-activity-title"
				title={pass?.status === "running" ? "Current activity" : "Pass activity"}
				meta={
					pass && (
						<span className="text-meta tabular-nums text-muted-foreground">
							{modeLabel(pass.mode)} · {fmtTimeShort(pass.startedAt)}
						</span>
					)
				}
				actions={pass && <SectionAction onClick={() => onDetails(pass)}>Details</SectionAction>}
			/>
			{items.length ? (
				<ol
					ref={scroll.ref}
					onScroll={scroll.onScroll}
					data-at-end={scroll.atEnd}
					className="dreams-list dreams-activity-list"
				>
					{items.map((t) => (
						<li key={t.id} className="dreams-tool-row">
							<span className="w-6 shrink-0 text-meta tabular-nums text-muted-foreground">{t.sequence}</span>
							<span className="min-w-0 flex-1 truncate font-mono text-small text-foreground">{t.toolName}</span>
							{t.success ? (
								<span className="shrink-0 text-meta tabular-nums text-muted-foreground">{t.latencyMs}ms</span>
							) : (
								<StatusLabel tone="error">Failed</StatusLabel>
							)}
						</li>
					))}
				</ol>
			) : (
				<p className="m-0 mt-3 text-small text-muted-foreground">
					{tools.loading
						? "Loading activity…"
						: (pass?.error ?? (pass ? "No tool calls recorded." : "No passes recorded."))}
				</p>
			)}
		</section>
	);
}

function PassLedger({ passes, onSelect }: { passes: DreamPass[]; onSelect: (p: DreamPass) => void }) {
	return (
		<section className="dreams-ledger" aria-labelledby="dreams-ledger-title">
			<SectionHeading
				id="dreams-ledger-title"
				title="Recent passes"
				meta={<span className="text-meta tabular-nums text-muted-foreground">{passes.length}</span>}
			/>
			{passes.length ? (
				<ul className="dreams-list dreams-ledger-list">
					{passes.map((pass) => (
						<li key={pass.id}>
							<button type="button" onClick={() => onSelect(pass)} className="dreams-pass-row">
								<span className="block truncate text-body text-foreground">
									{pass.error ?? (pass.summary ? markdownSummaryPreview(pass.summary) : "No summary recorded.")}
								</span>
								<span className="mt-0.5 flex min-w-0 items-center gap-1.5 whitespace-nowrap text-meta tabular-nums text-muted-foreground">
									{pass.status === "failed" && <StatusLabel tone="error">Failed</StatusLabel>}
									{pass.status === "running" && <StatusLabel tone="ok">Running</StatusLabel>}
									{pass.status !== "completed" && <span aria-hidden="true">·</span>}
									<span>{modeLabel(pass.mode)}</span>
									<span aria-hidden="true">·</span>
									<span>{fmtTimeShort(pass.startedAt)}</span>
									{(pass.tokensConsumed ?? 0) > 0 && (
										<>
											<span aria-hidden="true">·</span>
											<span>{fmtTokens(pass.tokensConsumed)} tokens</span>
										</>
									)}
									{(pass.mutationsApplied ?? 0) > 0 && (
										<>
											<span aria-hidden="true">·</span>
											<span>{pass.mutationsApplied} applied</span>
										</>
									)}
								</span>
							</button>
						</li>
					))}
				</ul>
			) : (
				<p className="m-0 mt-3 text-small text-muted-foreground">No passes recorded.</p>
			)}
		</section>
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

import { Panel } from "@/components/home/panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Surface } from "@/components/ui/surface";
import { type DreamPass, type DreamStatus, type DreamToolCall, api } from "@/lib/api";
import { useAsync } from "@/lib/use-async";
import { cn } from "@/lib/utils";
import { Activity, AlertCircle, Check, ChevronRight, Loader2, Play, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

/* ── Formatting helpers ──────────────────────────────────────────────────── */

function parseDate(s: string): Date | null {
	// SQLite datetime('now') strings ("YYYY-MM-DD HH:MM:SS") are UTC; ISO
	// strings pass through unchanged. Never let the engine parse the space
	// form as local time — it would shift every pass by the TZ offset.
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

/** One-line summary of a tool call's input, so the stream reads at a glance. */
function summarizeToolInput(t: DreamToolCall): string {
	const input = t.input;
	if (!input || typeof input !== "object") return "";
	if (t.toolName === "apply_ontology_ops" && Array.isArray(input.operations)) {
		const ops = input.operations as ReadonlyArray<OntologyOp>;
		const names = ops
			.slice(0, 5)
			.map((o) => o.operation ?? "?")
			.join(", ");
		return ops.length > 5 ? `${names} +${ops.length - 5} more` : names;
	}
	if (t.toolName === "attention_list") {
		return `kind=${String(input.kind ?? "?")} status=${String(input.status ?? "?")}`;
	}
	if (t.toolName === "search_evidence") {
		return `kind=${String(input.kind ?? "?")} limit=${String(input.limit ?? "?")}`;
	}
	return Object.entries(input)
		.slice(0, 2)
		.map(([k, v]) => `${k}=${String(v).slice(0, 18)}`)
		.join(" ");
}

/** Per-operation counts for an apply_ontology_ops call, or null for other tools. */
function opCounts(t: DreamToolCall): ReadonlyArray<[string, number]> | null {
	if (t.toolName !== "apply_ontology_ops" || !Array.isArray(t.input?.operations)) return null;
	const counts = new Map<string, number>();
	for (const op of t.input.operations as ReadonlyArray<OntologyOp>) {
		const name = op.operation ?? "?";
		counts.set(name, (counts.get(name) ?? 0) + 1);
	}
	return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

/** Syntax-highlighted parameter rendering: cyan keys, bright values, op pills. */
function ParamTokens({ t }: { t: DreamToolCall }) {
	const input = t.input;
	if (!input || typeof input !== "object") return null;

	// apply_ontology_ops renders each operation as a translucent pill badge.
	if (t.toolName === "apply_ontology_ops" && Array.isArray(input.operations)) {
		const ops = input.operations as ReadonlyArray<OntologyOp>;
		const names = ops.slice(0, 4).map((o) => o.operation ?? "?");
		return (
			<>
				{names.map((n) => (
					<span
						key={n}
						className="shrink-0 rounded-full bg-white/[0.08] px-1.5 py-px font-mono text-[9.5px] text-slate-200 dark:text-slate-100"
					>
						{n}
					</span>
				))}
				{ops.length > 4 && (
					<span className="shrink-0 rounded-full bg-white/[0.08] px-1.5 py-px font-mono text-[9.5px] text-slate-300 dark:text-slate-300">
						+{ops.length - 4} more
					</span>
				)}
			</>
		);
	}

	// Generic key=value pairs render as one non-wrapping pill each, so a key
	// never separates from its value and rows stay single-line.
	const text = Object.entries(input)
		.map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
		.join(" ");
	const out: React.ReactNode[] = [];
	const re = /([A-Za-z_][A-Za-z0-9_]*)=([^\s]+)/g;
	let last = 0;
	for (let m = re.exec(text); m; m = re.exec(text)) {
		if (m.index > last) {
			out.push(
				<span key={`t${last}`} className="shrink-0 text-slate-500 dark:text-slate-400">
					{text.slice(last, m.index)}
				</span>,
			);
		}
		out.push(
			<span
				key={`kv${m.index}`}
				className="inline-flex shrink-0 items-baseline gap-0.5 whitespace-nowrap rounded-[4px] bg-white/[0.06] px-1.5 py-px font-mono text-[10px]"
			>
				<span className="text-[#38BDF8]">{m[1]}=</span>
				<span className="text-slate-50 dark:text-slate-100">{m[2]}</span>
			</span>,
		);
		last = re.lastIndex;
	}
	if (last < text.length) {
		out.push(
			<span key={`t${last}`} className="shrink-0 text-slate-500 dark:text-slate-400">
				{text.slice(last)}
			</span>,
		);
	}
	return <>{out}</>;
}

/* ── View ────────────────────────────────────────────────────────────────── */

export function DreamsView() {
	// Status is the heartbeat: worker state, active pass, ledger, attention.
	// Polled at 3s — a pass runs for minutes and tool calls land every few
	// seconds, so this is effectively live without a daemon-side SSE emitter.
	const status = useAsync(() => api.getDreamStatus(), { intervalMs: 3000 });

	const activePass = useMemo(() => status.data?.passes.find((p) => p.status === "running") ?? null, [status.data]);
	// While idle, keep showing the most recent pass's trace so the panel
	// doesn't go empty between passes.
	const trackedPass = activePass ?? status.data?.passes[0] ?? null;

	const tools = useAsync(() => (trackedPass ? api.getDreamPassTools(trackedPass.id) : Promise.resolve(null)), {
		intervalMs: activePass ? 2500 : 10000,
		deps: [trackedPass?.id ?? ""],
	});

	// The last successfully completed pass, plus its runbook summary (the
	// natural-language account the agent writes at the end of the pass).
	const lastSuccessful = useMemo(
		() => status.data?.passes.find((p) => p.status === "completed") ?? null,
		[status.data],
	);
	const runbook = useAsync(() => (lastSuccessful ? api.getDreamPassTools(lastSuccessful.id) : Promise.resolve(null)), {
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
	// Ticking elapsed clock while a pass is running.
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!activePass) return;
		const id = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(id);
	}, [activePass]);

	// Ledger drill-down: which pass's trace is open in the dialog.
	const [selectedPass, setSelectedPass] = useState<DreamPass | null>(null);

	const lastPass = status.data?.passes[0] ?? null;
	const pendingAttention = status.data?.attention ?? [];
	const failures = status.data?.state.consecutiveFailures ?? 0;
	const running = Boolean(activePass);
	const scheduler = status.data?.scheduler ?? null;
	const queueDeferred = scheduler?.status === "deferred" && scheduler.reason === "queue_pressure";
	const elapsedMs = activePass ? Math.max(0, now - (parseDate(activePass.startedAt ?? "")?.getTime() ?? now)) : 0;
	const passDurationMs = lastPass
		? Math.max(
				0,
				(parseDate(lastPass.completedAt ?? "")?.getTime() ?? 0) - (parseDate(lastPass.startedAt ?? "")?.getTime() ?? 0),
			)
		: 0;

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-3.5">
			{/* Compact breadcrumb-style stat strip — mirrors the memory page header. */}
			<Surface className="flex h-10 shrink-0 items-center justify-between gap-6 px-4">
				<Stat label="state" value={running ? "running" : "idle"} live={running} />
				<Stat
					label="pass"
					value={
						running
							? `${modeLabel(activePass?.mode)} · ${fmtDuration(elapsedMs)}`
							: lastPass
								? `${modeLabel(lastPass.mode)} · ${fmtTimeShort(lastPass.completedAt ?? lastPass.startedAt)}`
								: "—"
					}
				/>
				<Stat label="tokens" value={`${fmtTokens(lastPass?.tokensInput)} ↑ ${fmtTokens(lastPass?.tokensOutput)} ↓`} />
				<Stat label="cost" value={fmtCost(lastPass?.tokensCost)} />
				<Stat label="attention" value={String(pendingAttention.length)} />
				<Stat label="backlog" value={fmtTokens(status.data?.episodicTokensPending ?? null)} />
				<Stat label="failures" value={failures > 0 ? String(failures) : "0"} tone={failures > 0 ? "warn" : "ok"} />
				<span className="ml-auto flex shrink-0 items-center gap-3">
					<span
						className={cn(
							"flex items-center gap-1.5 font-mono text-[10px] text-slate-500 dark:text-slate-400",
							queueDeferred && "text-[oklch(0.8_0.14_80)]",
						)}
					>
						<span
							className={cn(
								"size-1.5 rounded-full bg-success shadow-[0_0_6px_color-mix(in_oklch,var(--success)_70%,transparent)]",
								queueDeferred && "bg-[oklch(0.8_0.14_80)] shadow-none",
							)}
						/>
						{queueDeferred ? "automatic Dreaming deferred: queue pressure" : "daemon reachable"}
					</span>
					<TriggerControl running={running} refresh={status.refresh} />
				</span>
			</Surface>

			{/* Summary prose sits on the canvas to the left; the two cards share the
			    right column so they keep the same width. */}
			<div className="grid min-h-0 flex-1 grid-cols-1 gap-6 lg:grid-cols-[minmax(13rem,1fr)_1.9fr] lg:grid-rows-[minmax(0,1fr)]">
				<DreamingSummarySection pass={lastSuccessful} summary={summaryText} loading={runbook.loading} />
				<div className="flex min-h-0 min-w-0 flex-col gap-4.5">
					<LivePassPanel
						pass={trackedPass}
						running={running}
						elapsedMs={elapsedMs}
						tools={tools.data?.items ?? []}
						loadingTools={tools.loading}
						onSelect={setSelectedPass}
					/>
					<PassLedger passes={status.data?.passes ?? []} onSelect={setSelectedPass} />
				</div>
			</div>

			{selectedPass && <PassDetailDialog pass={selectedPass} onClose={() => setSelectedPass(null)} />}
		</div>
	);
}

/* ── Header stat chip (memory-page style) ───────────────────────────────── */

function Stat({
	label,
	value,
	live,
	tone,
}: {
	label: string;
	value: string;
	live?: boolean;
	tone?: "ok" | "warn";
}) {
	return (
		<span className="flex h-full min-w-0 shrink-0 flex-col justify-center gap-[3px]">
			<span className="font-mono text-[10px] font-semibold uppercase leading-none tracking-[0.08em] text-slate-500 dark:text-slate-400">
				{label}
			</span>
			<span className="flex min-w-0 items-center gap-1.5">
				{live && (
					<span className="size-1.5 shrink-0 animate-pulse rounded-full bg-success shadow-[0_0_6px_color-mix(in_oklch,var(--success)_70%,transparent)]" />
				)}
				<span
					className={cn(
						"truncate font-mono text-[14px] font-semibold leading-none text-foreground",
						tone === "warn" && "text-destructive",
						tone === "ok" && "text-success",
					)}
				>
					{value}
				</span>
			</span>
		</span>
	);
}

/* ── Trigger control ─────────────────────────────────────────────────────── */

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
		// Passive status indicator while a pass is active — deliberately NOT a
		// primary-looking button, so the trigger affordance stays unambiguous.
		return (
			<span className="flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-[oklch(1_0_0/0.12)] bg-white/[0.04] px-3 font-mono text-[10px] font-medium uppercase tracking-[0.06em] text-slate-500 dark:text-slate-400">
				<span className="size-1.5 animate-pulse rounded-full bg-success shadow-[0_0_6px_color-mix(in_oklch,var(--success)_70%,transparent)]" />
				running
			</span>
		);
	}
	return (
		<div className="flex items-center gap-2">
			<button
				type="button"
				onClick={trigger}
				disabled={busy}
				className="flex h-7 items-center gap-1.75 rounded-md border border-transparent bg-[#2563EB] px-3 text-[12px] font-semibold text-white shadow-[0_0_12px_color-mix(in_oklch,#2563EB_35%,transparent)] transition-colors hover:bg-[#3B82F6] disabled:cursor-not-allowed disabled:opacity-50"
			>
				{busy ? (
					<>
						<Loader2 className="size-3.5 animate-spin" /> triggering…
					</>
				) : (
					<>
						<Play className="size-3.5 drop-shadow-[0_0_4px_rgba(255,255,255,0.7)]" /> trigger pass
					</>
				)}
			</button>
			{error && <span className="font-mono text-[10px] text-destructive">{error}</span>}
		</div>
	);
}

/* ── Dreaming summary (last successful run) — prose on the canvas ─────────── */

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
		<section className="min-h-0 min-w-0 overflow-y-auto scrollbar-none">
			<div className="flex flex-col gap-2">
				<div className="flex items-baseline gap-2.5">
					<span className="text-[13px] font-semibold tracking-tight text-foreground">Dreaming summary</span>
					{pass ? (
						<span className="font-mono text-[10.5px] text-slate-500 dark:text-slate-400">
							{modeLabel(pass.mode)} · {fmtTime(pass.completedAt ?? pass.startedAt)}
						</span>
					) : (
						<span className="font-mono text-[10.5px] text-slate-500 dark:text-slate-400">no completed pass</span>
					)}
				</div>
				{loading && !summary ? (
					<span className="flex items-center gap-2 font-mono text-[10.5px] text-muted-foreground">
						<Loader2 className="size-3.5 animate-spin" /> loading…
					</span>
				) : summary ? (
					<div className="max-w-3xl">
						<MarkdownSummary text={summary} />
					</div>
				) : (
					<span className="font-mono text-[10.5px] text-muted-foreground">
						No summary recorded for the last completed pass.
					</span>
				)}
			</div>
		</section>
	);
}

/** Markdown prose renderer for the runbook summary. Handles headings, lists,
 *  paragraphs, **bold**, *italic*, `code`, and [links](url) — no raw HTML, so
 *  no sanitization surface. Ids/error phrases get the same tinting as before. */
function MarkdownSummary({ text }: { text: string }) {
	const blocks = splitMarkdownBlocks(text);
	return (
		<div className="flex flex-col gap-2 text-[12.5px] leading-relaxed text-slate-700 dark:text-slate-300">
			{blocks.map((block) => {
				if (block.type === "heading") {
					const Tag = block.level === 1 ? "h3" : block.level === 2 ? "h4" : "h5";
					return (
						<Tag key={block.id} className="m-0 text-[13px] font-semibold tracking-tight text-foreground">
							{renderInline(block.text, block.id)}
						</Tag>
					);
				}
				if (block.type === "list") {
					return (
						<ul key={block.id} className="m-0 flex list-disc flex-col gap-1 pl-4">
							{block.items?.map((item) => (
								<li key={item.id} className="pl-0.5">
									{renderInline(item.text, item.id)}
								</li>
							))}
						</ul>
					);
				}
				return (
					<p key={block.id} className="m-0 whitespace-pre-wrap">
						{renderInline(block.text, block.id)}
					</p>
				);
			})}
		</div>
	);
}

const INLINE_MD_RE = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;

function renderInline(text: string, keyBase: string): React.ReactNode[] {
	const out: React.ReactNode[] = [];
	let last = 0;
	let n = 0;
	for (let m = INLINE_MD_RE.exec(text); m; m = INLINE_MD_RE.exec(text)) {
		if (m.index > last) out.push(...renderTinted(text.slice(last, m.index), `${keyBase}t${n}`));
		const tok = m[0];
		if (tok.startsWith("**")) {
			out.push(
				<strong key={`${keyBase}b${n}`} className="font-semibold text-foreground">
					{tok.slice(2, -2)}
				</strong>,
			);
		} else if (tok.startsWith("`")) {
			out.push(
				<code
					key={`${keyBase}c${n}`}
					className="rounded-[4px] bg-white/[0.08] px-1 py-px font-mono text-[11px] text-slate-200 dark:text-slate-100"
				>
					{tok.slice(1, -1)}
				</code>,
			);
		} else if (tok.startsWith("[")) {
			const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok);
			if (link) {
				out.push(
					<a
						key={`${keyBase}a${n}`}
						href={link[2]}
						target="_blank"
						rel="noreferrer"
						className="text-[#4d7cfe] underline underline-offset-2"
					>
						{link[1]}
					</a>,
				);
			} else {
				out.push(<span key={`${keyBase}a${n}`}>{tok}</span>);
			}
		} else {
			out.push(
				<em key={`${keyBase}e${n}`} className="italic">
					{tok.slice(1, -1)}
				</em>,
			);
		}
		last = m.index + tok.length;
		n += 1;
	}
	if (last < text.length) out.push(...renderTinted(text.slice(last), `${keyBase}t${n}`));
	return out;
}

/** Ids get a neutral chip, error-ish phrases get a red wash. */
function renderTinted(text: string, keyBase: string): React.ReactNode[] {
	const out: React.ReactNode[] = [];
	let last = 0;
	let n = 0;
	for (let m = SUMMARY_TOKEN_RE.exec(text); m; m = SUMMARY_TOKEN_RE.exec(text)) {
		if (m.index > last) out.push(<span key={`${keyBase}x${n}`}>{text.slice(last, m.index)}</span>);
		const token = m[0];
		const looksLikeId = /^[0-9a-f]/.test(token) || /^(entity|aspect|attention):/.test(token);
		out.push(
			looksLikeId ? (
				<span
					key={`${keyBase}i${n}`}
					className="rounded-[4px] bg-white/[0.07] px-1 py-px font-mono text-[11px] text-cyan-700 dark:text-cyan-300"
				>
					{token}
				</span>
			) : (
				<span
					key={`${keyBase}e${n}`}
					className="rounded-[4px] bg-[rgba(239,68,68,0.15)] px-1 py-px font-medium text-red-600 dark:text-red-300"
				>
					{token}
				</span>
			),
		);
		last = m.index + token.length;
		n += 1;
	}
	if (last < text.length) out.push(<span key={`${keyBase}x${n}`}>{text.slice(last)}</span>);
	return out;
}

const SUMMARY_TOKEN_RE =
	/(\b(?:entity|aspect|attention):[0-9a-f]{8}\b|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b|\b[0-9a-f]{8}\b|non-functional|non functional|failed|failure|unresolved|unaddressable|deferred indefinitely|not found|error)/gi;

function splitMarkdownBlocks(text: string): ReadonlyArray<{
	id: string;
	type: "heading" | "list" | "para";
	level?: number;
	text: string;
	items?: Array<{ id: string; text: string }>;
}> {
	const blocks: Array<{
		id: string;
		type: "heading" | "list" | "para";
		level?: number;
		text: string;
		items?: Array<{ id: string; text: string }>;
	}> = [];
	let para: string[] = [];
	let listItems: Array<{ id: string; text: string }> | null = null;
	let seq = 0;
	const nextId = () => `b${seq++}`;
	const flushPara = () => {
		if (para.length) {
			blocks.push({ id: nextId(), type: "para", text: para.join("\n") });
			para = [];
		}
	};
	const flushList = () => {
		if (listItems) {
			blocks.push({ id: nextId(), type: "list", text: "", items: listItems });
			listItems = null;
		}
	};
	for (const line of text.split("\n")) {
		const heading = /^(#{1,3})\s+(.*)$/.exec(line);
		const bullet = /^[-*]\s+(.*)$/.exec(line);
		const ordered = /^\d+\.\s+(.*)$/.exec(line);
		if (heading) {
			flushPara();
			flushList();
			blocks.push({ id: nextId(), type: "heading", level: heading[1].length, text: heading[2] });
		} else if (bullet || ordered) {
			flushPara();
			if (!listItems) listItems = [];
			listItems.push({ id: nextId(), text: (bullet ?? ordered)?.[1] ?? "" });
		} else if (line.trim() === "") {
			flushPara();
			flushList();
		} else {
			flushList();
			para.push(line);
		}
	}
	flushPara();
	flushList();
	return blocks;
}

/** Plain one-line preview for ledger rows and native browser tooltips. */
function markdownSummaryPreview(text: string): string {
	const content = splitMarkdownBlocks(text)
		.map((block) => (block.type === "list" ? (block.items ?? []).map((item) => item.text).join(" · ") : block.text))
		.join(" ");
	return content
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/\*([^*]+)\*/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
		.replace(/\s+/g, " ")
		.trim();
}

/* ── Live pass + tool trace ──────────────────────────────────────────────── */

function LivePassPanel({
	pass,
	running,
	elapsedMs,
	tools,
	loadingTools,
	onSelect,
}: {
	pass: DreamPass | null;
	running: boolean;
	elapsedMs: number;
	tools: DreamToolCall[];
	loadingTools: boolean;
	onSelect?: (p: DreamPass) => void;
}) {
	if (!pass) {
		return (
			<Panel title="Live pass" meta="no passes yet">
				<div className="grid min-h-[140px] place-items-center gap-2">
					<Play className="size-4 text-muted-foreground/50" />
					<span className="font-mono text-[10.5px] text-muted-foreground">
						No dreaming passes recorded. Trigger one to see it work.
					</span>
				</div>
			</Panel>
		);
	}

	const mutations = (pass.mutationsApplied ?? 0) + (pass.mutationsSkipped ?? 0) + (pass.mutationsFailed ?? 0);
	const durationLabel = running ? fmtDuration(elapsedMs) : "";

	return (
		<Panel
			title="Live pass"
			meta={`${modeLabel(pass.mode)} · ${pass.status} · ${fmtTime(pass.startedAt)}${running ? ` · ${durationLabel}` : ""}`}
		>
			<div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1.5">
				<ModeBadge mode={pass.mode} running={running} failed={pass.status === "failed"} />
				<span className="font-mono text-[10.5px] text-slate-500 dark:text-slate-400">
					{mutations > 0 ? (
						<>
							<span className="text-success">{pass.mutationsApplied ?? 0} applied</span>
							{" · "}
							{pass.mutationsSkipped ?? 0} skipped ·{" "}
							<span className="text-destructive">{pass.mutationsFailed ?? 0} failed</span>
						</>
					) : (
						"no mutations yet"
					)}
				</span>
				<span className="ml-auto font-mono text-[10px] text-slate-500 dark:text-slate-400">
					{loadingTools && !tools.length ? "loading trace…" : `${tools.length} tool calls`}
				</span>
			</div>

			{tools.length ? (
				<TraceTable items={tools} compact short={!running} onSelectPass={onSelect ? () => onSelect(pass) : undefined} />
			) : !running ? (
				<div className="grid min-h-[120px] place-items-center gap-2">
					<span className="flex items-center gap-2 font-mono text-[11px] text-slate-400 dark:text-slate-400">
						<Check className="size-3.5 text-success" strokeWidth={3} />
						no active execution stream — daemon idle
					</span>
				</div>
			) : (
				<div className="grid min-h-[120px] place-items-center">
					<span className="flex items-center gap-2 font-mono text-[10.5px] text-muted-foreground">
						<Loader2 className="size-3.5 animate-spin" />
						waiting for the first tool call…
					</span>
				</div>
			)}
		</Panel>
	);
}

/** Structured trace table: # · Function · Parameters · Duration · Status. */
function TraceTable({
	items,
	compact,
	short,
	onSelectPass,
}: {
	items: DreamToolCall[];
	compact?: boolean;
	short?: boolean;
	onSelectPass?: () => void;
}) {
	const rows = [...items].reverse();
	const visible = compact ? rows.slice(0, 25) : rows;
	return (
		<div
			className={cn(
				"flex min-h-0 flex-col overflow-y-auto pr-1",
				compact ? (short ? "max-h-[150px]" : "max-h-[200px]") : "max-h-[320px]",
			)}
		>
			<div className="grid grid-cols-[2rem_6.5rem_minmax(0,1fr)_2.75rem_2rem] items-center gap-2.5 border-b border-border/60 px-2 pb-1.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-slate-500 dark:text-slate-400">
				<span className="text-right">#</span>
				<span>Function</span>
				<span>Parameters</span>
				<span className="text-right">Duration</span>
				<span className="text-center">Status</span>
			</div>
			<div className="flex flex-col gap-px">
				{visible.map((t) => (
					<div
						key={t.id}
						onClick={onSelectPass}
						onKeyDown={(e) => {
							if (onSelectPass && (e.key === "Enter" || e.key === " ")) {
								e.preventDefault();
								onSelectPass();
							}
						}}
						role={onSelectPass ? "button" : undefined}
						tabIndex={onSelectPass ? 0 : undefined}
						className={cn(
							"grid h-7 grid-cols-[2rem_6.5rem_minmax(0,1fr)_2.75rem_2rem] items-center gap-2.5 rounded-[6px] px-2 text-[11px]",
							onSelectPass && "cursor-pointer",
							"hover:bg-white/[0.04]",
						)}
					>
						<span className="text-right font-mono text-[9.5px] text-slate-500 dark:text-slate-400">{t.sequence}</span>
						<span className="truncate font-mono font-medium text-foreground">{t.toolName}</span>
						<span
							className="flex min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap"
							title={summarizeToolInput(t)}
						>
							<ParamTokens t={t} />
						</span>
						<span className="text-right font-mono text-[9.5px] text-slate-500 dark:text-slate-400">
							{t.latencyMs}ms
						</span>
						{t.success ? (
							<span className="grid size-4 place-items-center self-center justify-self-center rounded-full bg-success/15">
								<Check
									className="size-2.5 text-success drop-shadow-[0_0_3px_color-mix(in_oklch,var(--success)_70%,transparent)]"
									strokeWidth={3}
								/>
							</span>
						) : (
							<span className="grid size-4 place-items-center self-center justify-self-center rounded-full bg-destructive/15">
								<X className="size-2.5 text-destructive" strokeWidth={3} />
							</span>
						)}
					</div>
				))}
				{compact && items.length > 25 && (
					<div className="px-2 py-1 font-mono text-[9.5px] text-muted-foreground">
						+{items.length - 25} older calls in this pass
					</div>
				)}
			</div>
		</div>
	);
}

/* ── Pass ledger (drill-down) ────────────────────────────────────────────── */

function PassLedger({ passes, onSelect }: { passes: DreamPass[]; onSelect: (p: DreamPass) => void }) {
	return (
		<Panel title="Pass ledger" meta={`last ${passes.length} · click a row for details`}>
			{passes.length ? (
				<div className="flex max-h-[336px] min-h-0 flex-col overflow-y-auto pr-1">
					<div className="grid grid-cols-[5rem_4rem_4rem_4.5rem_4rem_5.5rem_minmax(0,1fr)_1rem] items-center gap-2 border-b border-border/60 px-2 pb-1.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-slate-500 dark:text-slate-400">
						<span>Type</span>
						<span>Time</span>
						<span className="text-right">Duration</span>
						<span className="text-right">Tokens</span>
						<span className="text-right">Cost</span>
						<span>Mutations</span>
						<span>Summary</span>
						<span />
					</div>
					{passes.map((p, idx) => {
						const duration = Math.max(
							0,
							(parseDate(p.completedAt ?? "")?.getTime() ?? 0) - (parseDate(p.startedAt ?? "")?.getTime() ?? 0),
						);
						return (
							<button
								type="button"
								key={p.id}
								onClick={() => onSelect(p)}
								className={cn(
									"relative grid w-full cursor-pointer grid-cols-[5rem_4rem_4rem_4.5rem_4rem_5.5rem_minmax(0,1fr)_1rem] items-center gap-2 rounded-[6px] px-2 py-[5px] text-left transition-colors",
									"hover:bg-white/[0.03]",
								)}
								title={p.summary ? markdownSummaryPreview(p.summary) : undefined}
							>
								{/* Latest pass gets a blue accent bar — it's the active reference row. */}
								{idx === 0 && (
									<span className="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full bg-[#3B82F6]" />
								)}
								<ModeBadge mode={p.mode} running={p.status === "running"} failed={p.status === "failed"} fixedWidth />
								<span className="text-[10px] text-slate-700 dark:text-slate-200">{fmtTime(p.startedAt)}</span>
								<span className="text-right font-mono text-[10px] text-slate-700 dark:text-slate-200">
									{duration > 0 ? fmtDuration(duration) : "—"}
								</span>
								<span className="text-right font-mono text-[11px]">{fmtTokens(p.tokensConsumed)}</span>
								<span className="text-right font-mono text-[10.5px] text-slate-700 dark:text-slate-200">
									{fmtCost(p.tokensCost)}
								</span>
								<span className="text-[10px] text-slate-700 dark:text-slate-200">
									{(p.mutationsApplied ?? 0) > 0 ? `${p.mutationsApplied} applied` : "no mutations"}
								</span>
								<span className="min-w-0 truncate text-[11px] text-slate-700 dark:text-slate-300">
									{p.error ?? (p.summary ? markdownSummaryPreview(p.summary) : "")}
								</span>
								<ChevronRight className="size-3 shrink-0 text-slate-500 dark:text-slate-500" />
							</button>
						);
					})}
				</div>
			) : (
				<div className="grid min-h-[120px] place-items-center">
					<span className="font-mono text-[10.5px] text-muted-foreground">No passes recorded.</span>
				</div>
			)}
		</Panel>
	);
}

/* ── Pass detail dialog (drill-down) ─────────────────────────────────────── */

function PassDetailDialog({ pass, onClose }: { pass: DreamPass; onClose: () => void }) {
	const tools = useAsync(() => api.getDreamPassTools(pass.id), { deps: [pass.id] });
	const items = tools.data?.items ?? [];

	// Resolve entity ids → names from the pass's own get_entity outputs, so
	// mutation cards read "Discord" instead of a 36-char uuid.
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
								<Loader2 className="size-3.5 animate-spin" /> loading trace…
							</span>
						</div>
					) : items.length ? (
						<ToolCallList items={items} nameMap={nameMap} />
					) : (
						<div className="grid min-h-[60px] place-items-center">
							<span className="font-mono text-[10.5px] text-muted-foreground">No tool calls recorded.</span>
						</div>
					)}

					{/* One-line stats footer — the substance is above; this is context. */}
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

/** Readable rendering of one ontology mutation (flag/archive/add_claim/...). */
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
		<div className="rounded-[8px] border border-border/60 bg-card px-3 py-2">
			<div className="flex flex-wrap items-center gap-2">
				<span className="rounded-full border border-border bg-accent/50 px-1.5 py-px font-mono text-[10px] text-foreground">
					{name}
				</span>
				{typeof details?.kind === "string" && (
					<Badge variant="outline" className="h-[18px] rounded-full px-1.5 text-[9px] font-normal">
						{details.kind}
					</Badge>
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

/** Shorten a subject ref, resolving entity ids through the pass's name map. */
function resolveRef(ref: string, nameMap: ReadonlyMap<string, string>): string {
	if (ref.startsWith("entity:")) {
		const id = ref.slice("entity:".length);
		return nameMap.get(id) ?? `entity:${id.slice(0, 8)}`;
	}
	if (ref.startsWith("aspect:")) return `aspect:${ref.slice("aspect:".length, "aspect:".length + 8)}`;
	if (ref.startsWith("attention:")) return `attention:${ref.slice("attention:".length, "attention:".length + 8)}`;
	return ref.length > 24 ? `${ref.slice(0, 24)}…` : ref;
}

/** Full tool calls with readable, un-truncated parameters. */
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
		<div className="rounded-[8px] border border-border/60 bg-card">
			<div className="flex flex-wrap items-center gap-2 border-b border-border/40 px-3 py-1.5">
				<span className="font-mono text-[9.5px] text-muted-foreground/60">#{call.sequence}</span>
				<span className="font-mono text-[11px] font-medium text-foreground">{call.toolName}</span>
				{resolvedName && (
					<span className="font-mono text-[10.5px] text-cyan-600 dark:text-cyan-300">{resolvedName}</span>
				)}
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

/* ── Shared bits ─────────────────────────────────────────────────────────── */

function ModeBadge({
	mode,
	running,
	failed,
	fixedWidth,
}: {
	mode: string;
	running?: boolean;
	failed?: boolean;
	fixedWidth?: boolean;
}) {
	const label = modeLabel(mode);
	return (
		<Badge
			variant="outline"
			className={cn(
				"h-[18px] shrink-0 rounded-full px-1.5 font-mono text-[9px] font-normal normal-case tracking-wide",
				fixedWidth && "w-20 justify-center",
				// Pass-type colors: cyan = content, purple = hygiene.
				label === "content" &&
					!running &&
					!failed &&
					"border-cyan-400/35 bg-cyan-400/10 text-cyan-600 dark:text-cyan-300",
				label === "hygiene" &&
					!running &&
					!failed &&
					"border-purple-400/35 bg-purple-400/10 text-purple-600 dark:text-purple-300",
				label !== "content" && label !== "hygiene" && !running && !failed && "text-muted-foreground",
				running && "border-success/40 text-success",
				failed && "border-destructive/40 text-destructive",
			)}
		>
			{running && <Activity className="mr-1 size-2.5 animate-pulse" />}
			{label}
		</Badge>
	);
}

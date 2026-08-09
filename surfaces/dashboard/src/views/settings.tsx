import { ConnectProviderDialog } from "@/components/settings/connect-dialog";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { type AgentConfigStore, isDreamingEnabled, useAgentConfig } from "@/lib/agent-config";
import { type InferenceCatalog, type LogEntry, api } from "@/lib/api";
import { allowRemoteMemoryExtraction, ensureInferenceRoute } from "@/lib/inference-route-config";
import {
	ACPX_AGENTS,
	type AccountsMap,
	type ConnectableProvider,
	LOCAL_EXECUTORS,
	PROVIDER_NAMES,
	accountForFamily,
	backendFamily,
	backendKind,
	connectableProviders,
	secretNameFor,
	titleCase,
} from "@/lib/providers";
import { type SettingsSection, useSettings } from "@/lib/settings-context";
import { useAsync } from "@/lib/use-async";
import { cn } from "@/lib/utils";
import { CheckCircle, Download, Loader2, RefreshCw, Search, TriangleAlert, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

const NAV: { id: SettingsSection; label: string; icon: React.ReactNode }[] = [
	{
		id: "network",
		label: "Network",
		icon: <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z" /><path d="M2 12h20M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20" /></svg>,
	},
	{
		id: "inference",
		label: "Inference",
		icon: <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round"><path d="M12 2v4M12 18v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M2 12h4M18 12h4M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8" /><circle cx="12" cy="12" r="3" /></svg>,
	},
	{
		id: "logs",
		label: "Logs",
		icon: <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round"><path d="M14 4h7v16h-7M3 4h7v16H3M7 9h0M7 15h0" /><path d="M6 9h.01M6 15h.01" /></svg>,
	},
	{
		id: "advanced",
		label: "Advanced",
		icon: <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round"><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h13M21 18h-1" /><circle cx="16" cy="6" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="19" cy="18" r="2" /></svg>,
	},
];

/** Radix Select rejects empty-string item values; map the "none" choice. */
const NONE = "__none__";

export function SettingsModal() {
	const { open, setOpen, section, setSection } = useSettings();
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogContent
				className="sig-modal flex h-[560px] max-h-[calc(100vh-48px)] w-[840px] max-w-[calc(100vw-48px)] gap-0 overflow-hidden rounded-[12px] border border-[oklch(1_0_0/0.1)] bg-card p-0 sm:max-w-[840px] [html:not(.dark)_&]:border-[oklch(0_0_0/0.1)]"
				showCloseButton={false}
			>
				{/* internal sidebar */}
				<aside className="flex w-[220px] shrink-0 flex-col gap-1 border-r border-[oklch(1_0_0/0.06)] bg-[color-mix(in_oklch,var(--background)_60%,var(--card))] p-3 pt-4.5 [html:not(.dark)_&]:border-[oklch(0_0_0/0.06)]">
					<div className="px-2.5 pb-2 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
						Settings
					</div>
					{NAV.map((n) => (
						<button
							key={n.id}
							type="button"
							onClick={() => setSection(n.id)}
							className={cn(
								"flex items-center gap-2.5 rounded-[var(--radius)] px-2.5 py-2 text-left text-[13px] transition-colors",
								section === n.id
									? "bg-[color-mix(in_oklch,var(--foreground)_9%,transparent)] font-medium text-foreground shadow-[inset_0_1px_0_oklch(1_0_0/0.08)]"
									: "text-muted-foreground hover:bg-[color-mix(in_oklch,var(--foreground)_6%,transparent)] hover:text-foreground",
							)}
						>
							<span className="mnav-icon">{n.icon}</span>
							{n.label}
						</button>
					))}
				</aside>

				<div className="flex min-w-0 flex-1 flex-col">
					<DialogHeader className="flex-row items-center justify-between border-b border-[oklch(1_0_0/0.06)] px-5 py-4 [html:not(.dark)_&]:border-[oklch(0_0_0/0.06)]">
						<DialogTitle className="text-[15px] font-semibold tracking-tight">
							{NAV.find((n) => n.id === section)?.label}
						</DialogTitle>
						<div className="flex items-center gap-2.5">
							<span className="sig-esc-pill hidden sm:inline-flex">Esc</span>
							<button
								type="button"
								onClick={() => setOpen(false)}
								className="grid size-7 place-items-center rounded-[var(--radius)] text-muted-foreground hover:bg-[var(--active-overlay)] hover:text-foreground"
								aria-label="Close"
							>
								<X className="size-4" />
							</button>
						</div>
					</DialogHeader>

					<div className="min-h-0 flex-1 overflow-y-auto p-5">
						{section === "network" && <NetworkSection />}
						{section === "inference" && <InferenceSection />}
						{section === "logs" && <LogsSection />}
						{section === "advanced" && <AdvancedSection />}
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}

/* ── shared bits ── */

function GroupLabel({ children, suffix }: { children: React.ReactNode; suffix?: React.ReactNode }) {
	return (
		<div className="mb-1 px-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-[oklch(0.42_0_0)] dark:text-[oklch(0.62_0_0)]">
			{children}
			{suffix && <span className="font-normal normal-case tracking-normal text-muted-foreground"> {suffix}</span>}
		</div>
	);
}

function Row({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
	return (
		<div className="flex items-center justify-between gap-4 rounded-[var(--radius)] px-2.5 py-2 hover:bg-[var(--accent-subtle)]">
			<div className="min-w-0">
				<div className="text-[13px] font-medium">{title}</div>
				{desc && <div className="mt-0.5 text-[11.5px] leading-snug text-muted-foreground">{desc}</div>}
			</div>
			<div className="flex shrink-0 items-center">{children}</div>
		</div>
	);
}

function CtrlSelect({
	value,
	options,
	onChange,
	placeholder = "— select —",
}: {
	value: string;
	options: { value: string; label: string }[];
	onChange: (value: string) => void;
	placeholder?: string;
}) {
	return (
		<Select value={value || NONE} onValueChange={(v) => onChange(v === NONE ? "" : v)}>
			<SelectTrigger
				size="sm"
				className="h-7.5 w-[220px] justify-between gap-2 rounded-[var(--radius)] border-[oklch(1_0_0/0.16)] bg-[color-mix(in_oklch,var(--foreground)_5%,transparent)] px-2.5 font-mono text-[11.5px] font-medium hover:border-[oklch(1_0_0/0.3)] [html:not(.dark)_&]:border-[oklch(0_0_0/0.14)]"
			>
				<SelectValue placeholder={placeholder} />
			</SelectTrigger>
			<SelectContent className="max-h-[320px] font-mono text-[11px]">
				<SelectItem value={NONE}>— none —</SelectItem>
				{options.map((o) => (
					<SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

function CtrlInput({
	value,
	placeholder,
	onChange,
	type = "text",
}: {
	value: string;
	placeholder?: string;
	onChange: (value: string) => void;
	type?: string;
}) {
	return (
		<div className="ctrl ctrl--field w-[220px]">
			<input
				type={type}
				value={value}
				placeholder={placeholder}
				autoComplete="off"
				spellCheck={false}
				onChange={(e) => onChange(e.target.value)}
			/>
		</div>
	);
}

function CtrlReadonly({ value, sub }: { value: string; sub?: string }) {
	return (
		<span className="ctrl ctrl--readonly w-[220px]">
			<span className="ctrl__value">{value}</span>
			{sub && <span className="ctrl__sub">{sub}</span>}
		</span>
	);
}

/* ── Network ── */

function NetworkSection() {
	const status = useAsync(() => api.getStatus()).data;
	const store = useAgentConfig();
	const gitEnabled = store.aBool(["git", "enabled"]);
	const autoCommit = store.aBool(["git", "autoCommit"]);
	const apply = (path: readonly string[], value: boolean) => {
		store.aSetBool(path, value);
		void store.save();
	};
	return (
		<div className="flex flex-col gap-3">
			<div className="sig-mcard flex flex-col gap-px">
				<GroupLabel>Daemon</GroupLabel>
				<Row title="Listen port" desc="Port the local daemon serves the dashboard and API on.">
					<CtrlReadonly value={String(status?.port ?? "3850")} sub="localhost" />
				</Row>
				<Row title="Bind address" desc="Restrict the daemon to a specific interface.">
					<CtrlReadonly value={status?.bindHost ?? "127.0.0.1"} />
				</Row>
				<Row title="Network mode" desc="local · tailscale · hybrid">
					<CtrlReadonly value={status?.networkMode ?? "local"} />
				</Row>
			</div>
			<div className="sig-mcard flex flex-col gap-px">
				<GroupLabel>Sync</GroupLabel>
				<Row title="Cloud sync" desc="Encrypted backup of memories, ontology, and skills.">
					<Switch checked={gitEnabled} onCheckedChange={(v) => apply(["git", "enabled"], v)} />
				</Row>
				<Row title="Auto-commit changes" desc="Debounced git commits on workspace file changes.">
					<Switch checked={autoCommit} onCheckedChange={(v) => apply(["git", "autoCommit"], v)} />
				</Row>
			</div>
		</div>
	);
}

/* ── Inference ── */

function readAccounts(store: AgentConfigStore): AccountsMap {
	const raw = store.agent["inference"];
	if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return {};
	const accounts = (raw as Record<string, unknown>)["accounts"];
	if (accounts == null || typeof accounts !== "object" || Array.isArray(accounts)) return {};
	return accounts as AccountsMap;
}

/** Persist provider wiring, then reload the catalog — the daemon re-reads
 * agent.yaml from disk, so save() must land BEFORE the refresh (mirrors the
 * old Svelte save→invalidate ordering). */
async function persistProviderChange(store: AgentConfigStore, refreshCatalog: () => void): Promise<void> {
	await store.save();
	refreshCatalog();
}

function InferenceSection() {
	const store = useAgentConfig();
	const catalogQuery = useAsync(() => api.getInferenceCatalog(), { intervalMs: 60_000 });
	const catalog = catalogQuery.data;
	const [filter, setFilter] = useState("");
	const [connecting, setConnecting] = useState<ConnectableProvider | null>(null);
	const accounts = readAccounts(store);
	const providers = useMemo(() => connectableProviders(catalog, accounts), [catalog, accounts]);
	const refreshCatalog = () => catalogQuery.refresh();
	const [routeRefreshKey, setRouteRefreshKey] = useState(0);
	const refreshRoutes = () => setRouteRefreshKey((value) => value + 1);

	const visible = providers.filter((p) => p.name.toLowerCase().includes(filter.toLowerCase()));
	const connectedCount = providers.filter((p) => p.connected).length;

	return (
		<div className="flex flex-col gap-3">
			{/* TOP ZONE: model assignment — background / aggregation / embeddings */}
			<div className="sig-mcard flex flex-col gap-px">
				<GroupLabel suffix={store.saving ? "· saving…" : undefined}>Model assignment</GroupLabel>
				<TargetEditor
					label="Backend inference"
					tag="primary"
					targetName="background"
					workloadKey="memoryExtraction"
					includeAcpx
					catalog={catalog}
					store={store}
					accounts={accounts}
					providers={providers}
					onRouteChanged={refreshRoutes}
				/>
				<TargetEditor
					label="Aggregation"
					tag="fallback"
					targetName="aggregation"
					workloadKey="aggregateRecall"
					includeAcpx={false}
					catalog={catalog}
					store={store}
					accounts={accounts}
					providers={providers}
					onRouteChanged={refreshRoutes}
				/>
				<EmbeddingEditor store={store} />
			</div>
			<RouteHealthPanel refreshKey={routeRefreshKey} />

			{/* BOTTOM ZONE: connected providers matrix */}
			<div className="sig-mcard flex flex-col gap-px">
				<GroupLabel suffix={`· ${providers.length} available`}>Connected providers</GroupLabel>
				<div className="mb-2 flex h-7.5 items-center gap-2 rounded-[var(--radius)] border border-[oklch(1_0_0/0.16)] bg-[color-mix(in_oklch,var(--foreground)_5%,transparent)] px-2.5 [html:not(.dark)_&]:border-[oklch(0_0_0/0.14)]">
					<Search className="size-3 shrink-0 text-muted-foreground" />
					<input
						value={filter}
						onChange={(e) => setFilter(e.target.value)}
						placeholder="Search providers…"
						className="w-full border-0 bg-transparent text-[11.5px] outline-none placeholder:text-muted-foreground"
					/>
				</div>
				{!catalog && !catalogQuery.loading && (
					<div className="px-2.5 py-3 text-[12px] text-muted-foreground">
						Couldn&apos;t load the provider catalog. Update the daemon and retry.
					</div>
				)}
				<div className="grid max-h-[240px] grid-cols-2 gap-1.5 overflow-y-auto pr-0.5 pb-4 [mask-image:linear-gradient(to_bottom,#000_calc(100%-24px),transparent_100%)]">
					{visible.map((p) => (
						<div
							key={p.id}
							className="flex items-center gap-2.25 rounded-[var(--radius)] border border-[oklch(1_0_0/0.06)] bg-[color-mix(in_oklch,var(--foreground)_2%,transparent)] px-2.5 py-2 transition-colors hover:border-[oklch(1_0_0/0.14)] hover:bg-[color-mix(in_oklch,var(--foreground)_5%,transparent)]"
						>
							<span
								className={cn(
									"size-1.75 shrink-0 rounded-full",
									p.connected
										? "bg-success shadow-[0_0_0_3px_color-mix(in_oklch,var(--success)_16%,transparent),0_0_8px_color-mix(in_oklch,var(--success)_60%,transparent)]"
										: "bg-[oklch(0.38_0_0)]",
								)}
							/>
							<span className="flex min-w-0 flex-1 flex-col gap-px">
								<span className="truncate text-[12px] font-medium leading-tight">{p.name}</span>
								<span className="truncate font-mono text-[9px] text-muted-foreground">
									{p.connected
										? `Connected · ${p.isOAuth ? "OAuth" : "API key"}`
										: p.supportsOAuth && p.supportsApiKey
											? "Sign in or key"
											: p.supportsOAuth
												? "OAuth sign-in"
												: "API key"}
									{(catalog?.models[p.id]?.length ?? 0) > 0 ? ` · ${catalog!.models[p.id].length} models` : ""}
								</span>
							</span>
							<button
								type="button"
								onClick={() => setConnecting(p)}
								className={cn(
									"shrink-0 rounded-[var(--radius)] border border-[oklch(1_0_0/0.16)] px-2 py-1.25 font-mono text-[9.5px] font-medium transition-colors hover:border-[oklch(1_0_0/0.3)] hover:text-foreground [html:not(.dark)_&]:border-[oklch(0_0_0/0.14)]",
									p.connected ? "bg-[color-mix(in_oklch,var(--foreground)_6%,transparent)] text-muted-foreground" : "text-muted-foreground",
								)}
							>
								{p.connected ? "Manage" : p.supportsOAuth && !p.supportsApiKey ? "Sign in" : p.supportsOAuth ? "Connect" : "Add key"}
							</button>
						</div>
					))}
				</div>
				{Object.keys(catalog?.modelErrors ?? {}).length > 0 && (
					<div className="flex flex-col gap-1 px-1.5 pb-1">
						{Object.entries(catalog!.modelErrors).map(([providerId, message]) => (
							<div key={providerId} className="flex items-center gap-1.5 font-mono text-[10px] text-[oklch(0.82_0.15_85)]">
								<TriangleAlert className="size-3 shrink-0" />
								<span>{providerId}: {message}</span>
							</div>
						))}
					</div>
				)}
			</div>

			{connecting && (
				<ConnectProviderDialog
					provider={connecting}
					modelCount={catalog?.models[connecting.id]?.length ?? 0}
					onClose={() => setConnecting(null)}
					onSaved={() => persistProviderChange(store, refreshCatalog)}
					linkOAuthAccount={() => {
						const base = ["inference", "accounts", connecting.id] as const;
						store.aSetStr([...base, "kind"], "subscription_session");
						store.aSetStr([...base, "providerFamily"], connecting.id);
						store.aDel([...base, "credentialRef"]);
					}}
					linkApiKeyAccount={(secretName) => {
						const base = ["inference", "accounts", connecting.id] as const;
						store.aSetStr([...base, "kind"], "api");
						store.aSetStr([...base, "providerFamily"], connecting.id);
						store.aSetStr([...base, "credentialRef"], secretName);
					}}
					unlinkAccount={() => store.aDel(["inference", "accounts", connecting.id])}
				/>
			)}
		</div>
	);
}

type RouteCheckReport = {
	status: Awaited<ReturnType<typeof api.getInferenceStatusDetailed>>["data"];
	statusError: string | null;
	memoryExtraction: Awaited<ReturnType<typeof api.getInferenceDecision>> | null;
	aggregateRecall: Awaited<ReturnType<typeof api.getInferenceDecision>> | null;
	probeOk: boolean | null;
};

function RouteHealthPanel({ refreshKey }: { refreshKey: number }) {
	const statusQuery = useAsync(() => api.getInferenceStatusDetailed(), { intervalMs: 60_000, deps: [refreshKey] });
	const memoryDecisionQuery = useAsync(() => api.getInferenceDecision({ operation: "memory_extraction" }), { intervalMs: 60_000, deps: [refreshKey] });
	const [checking, setChecking] = useState(false);
	const [report, setReport] = useState<RouteCheckReport | null>(null);
	const status = report?.status ?? statusQuery.data?.data;
	const statusError = report?.statusError ?? statusQuery.data?.error;
	const issues = status?.configIssues ?? [];
	const targets = Object.entries(status?.runtimeSnapshot?.targets ?? {}) as Array<[
		string,
		{ available?: boolean; unavailableReason?: string } | undefined,
	]>;

	const checkRoutes = async () => {
		setChecking(true);
		const nextStatusResult = await api.getInferenceStatusDetailed(true);
		const nextStatus = nextStatusResult.data;
		const [memoryExtraction, aggregateRecall, probe] = await Promise.all([
			api.getInferenceDecision({ operation: "memory_extraction", refresh: true }),
			nextStatus?.workloadBindings?.aggregateRecall
				? api.getInferenceDecision({ operation: "aggregate_recall", refresh: true })
				: Promise.resolve(null),
			nextStatus?.workloadBindings?.memoryExtraction
				? api.executeInferenceProbe({
						operation: "memory_extraction",
						prompt: "Respond with exactly OK.",
						maxTokens: 8,
						timeoutMs: 15_000,
						refresh: true,
					})
				: Promise.resolve(null),
		]);
		const probeOk =
			probe !== null &&
			probe.text.trim().length > 0 &&
			probe.decision.targetRef.length > 0 &&
			probe.attempts.some((attempt) => attempt.ok);
		setReport({ status: nextStatus, statusError: nextStatusResult.error, memoryExtraction, aggregateRecall, probeOk });
		setChecking(false);
	};

	// The refresh key is the intentional trigger; checkRoutes is recreated from live query state.
	// biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey intentionally controls the route check.
	useEffect(() => {
		if (refreshKey > 0) void checkRoutes();
	}, [refreshKey]);

	return (
		<div className="sig-mcard flex flex-col gap-px">
			<div className="flex items-center justify-between px-1.5">
				<GroupLabel
					suffix={
						report?.probeOk == null
							? "· route resolution + executor availability"
							: report.probeOk
								? "· probe passed"
								: "· probe failed"
					}
				>Runtime route</GroupLabel>
				<button
					type="button"
					onClick={() => void checkRoutes()}
					disabled={checking}
					className="mb-1 flex items-center gap-1.5 rounded-[var(--radius)] border border-[oklch(1_0_0/0.14)] px-2 py-1 font-mono text-[9.5px] text-muted-foreground transition-colors hover:border-[oklch(1_0_0/0.28)] hover:text-foreground disabled:opacity-50 [html:not(.dark)_&]:border-[oklch(0_0_0/0.14)]"
				>
					<RefreshCw className={cn("size-3", checking && "animate-spin")} />
					{checking ? "Checking…" : "Check routes"}
				</button>
			</div>
			{status ? (
				<>
					<div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
						<RouteMeta label="Policy" value={status.defaultPolicy ?? "not set"} />
						<RouteMeta label="Policies" value={String(status.policies?.length ?? 0)} />
						<RouteMeta label="Task classes" value={String(status.taskClasses?.length ?? 0)} />
						<RouteMeta label="Targets" value={String(status.targetRefs?.length ?? 0)} />
					</div>
					<div className="mt-1.5 flex flex-col gap-1">
						<RouteDecisionRow label="Memory extraction" decision={report?.memoryExtraction ?? memoryDecisionQuery.data} />
						{status.workloadBindings?.aggregateRecall && (
							<RouteDecisionRow label="Aggregate recall" decision={report?.aggregateRecall} />
						)}
					</div>
					{targets.length > 0 && (
						<div className="mt-1.5 flex flex-wrap gap-1.5">
							{targets.map(([ref, state]) => (
								<span key={ref} className={cn("rounded bg-[color-mix(in_oklch,var(--foreground)_5%,transparent)] px-1.5 py-1 font-mono text-[9px]", state?.available ? "text-success" : "text-muted-foreground")}>
									{state?.available ? "●" : "○"} {ref}
								</span>
							))}
						</div>
					)}
					{issues.length > 0 && (
						<div className="mt-1.5 flex flex-col gap-1 rounded-[var(--radius)] bg-[oklch(0.7_0.15_85/0.08)] px-2.5 py-2 font-mono text-[9.5px] text-[oklch(0.72_0.15_85)]">
							{issues.map((issue) => <span key={`${issue.field}:${issue.ref}`}>{issue.severity}: {issue.message}</span>)}
						</div>
					)}
				</>
			) : (
				<div className="px-2.5 pb-1 text-[11px] text-muted-foreground">{statusError ?? "Route status is unavailable. Check routes to read the daemon&apos;s effective configuration."}</div>
			)}
		</div>
	);
}

function RouteMeta({ label, value }: { label: string; value: string }) {
	return (
		<div className="rounded-[var(--radius)] bg-[color-mix(in_oklch,var(--foreground)_3%,transparent)] px-2.5 py-1.5">
			<div className="font-mono text-[8.5px] uppercase tracking-[0.06em] text-muted-foreground">{label}</div>
			<div className="mt-0.5 truncate font-mono text-[10.5px] font-medium">{value}</div>
		</div>
	);
}

function routeBlockedBy(details: unknown): string[] {
	if (details == null || typeof details !== "object" || Array.isArray(details)) return [];
	const trace = (details as Record<string, unknown>).trace;
	if (trace == null || typeof trace !== "object" || Array.isArray(trace)) return [];
	const candidates = (trace as Record<string, unknown>).candidates;
	if (!Array.isArray(candidates)) return [];
	return candidates.flatMap((candidate) => {
		if (candidate == null || typeof candidate !== "object" || Array.isArray(candidate)) return [];
		const row = candidate as Record<string, unknown>;
		const blockedBy = Array.isArray(row.blockedBy) ? row.blockedBy.filter((reason): reason is string => typeof reason === "string") : [];
		if (blockedBy.length === 0) return [];
		const targetRef = typeof row.targetRef === "string" ? row.targetRef : "candidate";
		return [`${targetRef}: ${blockedBy.join(", ")}`];
	});
}

function RouteDecisionRow({ label, decision }: { label: string; decision: Awaited<ReturnType<typeof api.getInferenceDecision>> | undefined | null }) {
	const route = decision?.data;
	const blockedBy = routeBlockedBy(decision?.details);
	const value = route
		? `${route.targetRef} · ${route.policyId}`
		: blockedBy.length > 0
			? `blocked: ${blockedBy.join(", ")}`
			: decision?.error ?? "not resolved — check routes";
	return (
		<div className="flex items-center gap-2 rounded-[var(--radius)] px-2.5 py-1.5 text-[11px]">
			{route ? <CheckCircle className="size-3.5 shrink-0 text-success" /> : <TriangleAlert className="size-3.5 shrink-0 text-[oklch(0.75_0.14_75)]" />}
			<span className="font-medium">{label}</span>
			<span className="truncate font-mono text-[9.5px] text-muted-foreground" title={value}>
				{value}
			</span>
		</div>
	);
}

/** One model-assignment row group (backend + model + endpoint + optional key).
 * Logic ported from the Svelte InferenceSection's writeTarget — field clearing
 * keeps stale config from a prior selection from leaking into agent.yaml. */
function TargetEditor({
	label,
	tag,
	targetName,
	workloadKey,
	includeAcpx,
	catalog,
	store,
	accounts,
	providers,
	onRouteChanged,
}: {
	label: string;
	tag: string;
	targetName: string;
	workloadKey: string;
	includeAcpx: boolean;
	catalog: InferenceCatalog | null;
	store: AgentConfigStore;
	accounts: AccountsMap;
	providers: ConnectableProvider[];
	onRouteChanged: () => void;
}) {
	const accountName = targetName; // per-target account for local openai-compatible keys
	const targetBase = ["inference", "targets", targetName] as const;
	const accountBase = ["inference", "accounts", accountName] as const;
	const workloadBase = ["inference", "workloads", workloadKey] as const;

	const executor = store.aStr([...targetBase, "executor"]);
	const modelId = store.aStr([...targetBase, "models", "default", "model"]);
	const endpoint = store.aStr([...targetBase, "endpoint"]);
	const acpxAgent = store.aStr([...targetBase, "acpx", "agent"]) || "claude";
	const apiKeyRef = store.aStr([...accountBase, "credentialRef"]);
	const [pendingRemote, setPendingRemote] = useState<string | null>(null);
	const [remoteConsentDismissed, setRemoteConsentDismissed] = useState(false);
	const memoryPrivacy = store.aStr(["inference", "taskClasses", "memory_extraction", "privacy"]);

	const kind = backendKind(executor);
	useEffect(() => {
		if (!remoteConsentDismissed && pendingRemote === null && targetName === "background" && kind === "provider" && memoryPrivacy !== "remote_ok") {
			setPendingRemote(executor);
		}
	}, [executor, kind, memoryPrivacy, pendingRemote, remoteConsentDismissed, targetName]);
	const family = backendFamily(executor);
	const modelOptions = (catalog?.models[family] ?? []).map((m) => ({ value: m.id, label: `${m.name} (${m.id})` }));

	const backendOptions = (() => {
		const opts: { value: string; label: string }[] = [];
		for (const p of providers.filter((p) => p.connected)) opts.push({ value: p.id, label: p.name });
		for (const e of LOCAL_EXECUTORS) opts.push({ value: e.value, label: e.label });
		if (includeAcpx) opts.push({ value: "acpx", label: "ACPX (harness subprocess)" });
		if (executor && !opts.some((o) => o.value === executor)) {
			opts.push({ value: executor, label: `${PROVIDER_NAMES[executor] ?? titleCase(executor)} (disconnected)` });
		}
		return opts;
	})();

	const ensureAccount = (fam: string) => {
		store.aSetStr([...accountBase, "kind"], "api");
		store.aSetStr([...accountBase, "providerFamily"], fam);
	};
	const saveAndCheck = () => {
		void store.save().then((saved) => {
			if (saved) onRouteChanged();
		});
	};

	const applyTarget = (next: string, remoteConsent = false) => {
		if (!next) {
			store.aDel([...targetBase, "executor"]);
			store.aDel([...targetBase, "account"]);
			store.aDel([...targetBase, "models"]);
			store.aDel([...targetBase, "endpoint"]);
			store.aDel([...targetBase, "acpx"]);
			store.aDel(accountBase);
			store.aDel(workloadBase);
		} else {
			store.aSetStr([...targetBase, "executor"], next);
			store.aSetStr([...workloadBase, "target"], `${targetName}/default`);
			const nextKind = backendKind(next);
			if (nextKind !== "acpx") store.aDel([...targetBase, "acpx"]);
			if (nextKind !== "local") store.aDel([...targetBase, "endpoint"]);
			if (nextKind === "provider") {
				// Reference a connected account for this family (resolved by family,
				// not literal name — accounts may be named e.g. `openrouter-api`.
				store.aSetStr([...targetBase, "account"], accountForFamily(accounts, next) ?? next);
				store.aDel(accountBase);
			} else if (nextKind === "acpx") {
				store.aDel([...targetBase, "account"]);
				store.aDel(accountBase);
			} else {
				// local: keyless unless a per-target openai-compatible key exists
				const hasKey = !!store.aStr([...accountBase, "credentialRef"]);
				if (next === "openai-compatible" && hasKey) {
					store.aSetStr([...targetBase, "account"], accountName);
					ensureAccount("openai");
				} else {
					store.aDel([...targetBase, "account"]);
					store.aDel(accountBase);
				}
			}
		}
		if (remoteConsent) {
			store.aUpdate((draft) => {
				allowRemoteMemoryExtraction(draft);
				ensureInferenceRoute(draft);
			});
		} else {
			store.aUpdate(ensureInferenceRoute);
		}
		saveAndCheck();
	};

	const writeTarget = (next: string) => {
		const privacy = store.aStr(["inference", "taskClasses", "memory_extraction", "privacy"]);
		if (targetName === "background" && backendKind(next) === "provider" && privacy !== "remote_ok") {
			setRemoteConsentDismissed(false);
			setPendingRemote(next);
			return;
		}
		applyTarget(next);
	};

	const setModel = (v: string) => {
		store.aSetStr([...targetBase, "models", "default", "model"], v);
		store.aUpdate(ensureInferenceRoute);
		saveAndCheck();
	};
	const setEndpoint = (v: string) => {
		store.aSetStr([...targetBase, "endpoint"], v);
		store.aUpdate(ensureInferenceRoute);
		saveAndCheck();
	};
	const setAcpxAgent = (v: string) => {
		store.aSetStr([...targetBase, "acpx", "agent"], v);
		store.aUpdate(ensureInferenceRoute);
		saveAndCheck();
	};
	const setApiKey = (v: string) => {
		store.aSetStr([...accountBase, "credentialRef"], v);
		if (v) {
			ensureAccount(executor);
			store.aSetStr([...targetBase, "account"], accountName);
		} else if (executor === "openai-compatible") {
			store.aDel([...targetBase, "account"]);
			store.aDel(accountBase);
		}
		store.aUpdate(ensureInferenceRoute);
		saveAndCheck();
	};

	return (
		<>
			<div className="flex items-center justify-between gap-3 rounded-[var(--radius)] px-2.5 py-1.75 hover:bg-[var(--accent-subtle)]">
				<div className="flex min-w-0 items-baseline gap-1.75">
					<span className="text-[12.5px] font-medium">{label}</span>
					<span className="font-mono text-[9px] text-muted-foreground">{tag}</span>
				</div>
				<CtrlSelect value={executor} options={backendOptions} onChange={writeTarget} placeholder="— none —" />
			</div>
			{executor !== "" && kind === "acpx" && (
				<Row title="ACPX agent" desc="The harness ACPX drives.">
					<CtrlSelect value={acpxAgent} options={ACPX_AGENTS.map((a) => ({ value: a, label: a }))} onChange={setAcpxAgent} />
				</Row>
			)}
			{executor !== "" && kind !== "acpx" && (
				<Row title="Model" desc={kind === "local" ? "The model id your server exposes." : "From the pi-ai catalog — or type a custom id."}>
					<div className="flex w-[220px] flex-col gap-1.5">
						{modelOptions.length > 0 && <CtrlSelect value={modelId} options={modelOptions} onChange={setModel} />}
						<CtrlInput value={modelId} placeholder="custom model id" onChange={setModel} />
					</div>
				</Row>
			)}
			{kind === "local" && (
				<Row title="Endpoint" desc="LM Studio: http://localhost:1234/v1 · Ollama: http://localhost:11434 · llama.cpp: http://localhost:8080/v1">
					<CtrlInput value={endpoint} placeholder="http://localhost:1234/v1" onChange={setEndpoint} />
				</Row>
			)}
			{executor === "openai-compatible" && (
				<Row title="API key (secret name)" desc="The Signet secret holding the key. Optional for local servers.">
					<CtrlInput value={apiKeyRef} placeholder={secretNameFor(executor)} onChange={setApiKey} />
				</Row>
			)}
			{pendingRemote && (
				<div className="mt-2 rounded-[var(--radius)] border border-[oklch(0.72_0.15_85/0.3)] bg-[oklch(0.72_0.15_85/0.08)] px-3 py-2.5">
					<div className="text-[12px] font-semibold">Use {PROVIDER_NAMES[pendingRemote] ?? titleCase(pendingRemote)} for memory extraction?</div>
					<div className="mt-1 text-[11.5px] leading-snug text-muted-foreground">Selected memory sources and transcript text may be sent to the remote provider to extract durable facts.</div>
					<div className="mt-2 flex flex-wrap gap-1.5">
						<button type="button" onClick={() => { applyTarget(pendingRemote, true); setPendingRemote(null); }} className="rounded-[var(--radius)] bg-foreground px-2.5 py-1.5 text-[10.5px] font-medium text-background">Use remotely</button>
						<button type="button" onClick={() => { setRemoteConsentDismissed(true); setPendingRemote(null); }} className="rounded-[var(--radius)] border border-[oklch(1_0_0/0.16)] px-2.5 py-1.5 text-[10.5px] text-muted-foreground hover:text-foreground [html:not(.dark)_&]:border-[oklch(0_0_0/0.14)]">Keep memory extraction local</button>
						<button type="button" onClick={() => { setRemoteConsentDismissed(true); setPendingRemote(null); }} className="px-2 py-1.5 text-[10.5px] text-muted-foreground hover:text-foreground">Cancel</button>
					</div>
				</div>
			)}
		</>
	);
}

/** Resolve the live embeddings config path like the old store did:
 * `embedding` wins, legacy `memory.embeddings` respected, else canonical. */
function resolveEmbPath(agent: Record<string, unknown>): readonly string[] {
	if (agent["embedding"] != null) return ["embedding"];
	const memory = agent["memory"];
	if (memory && typeof memory === "object" && !Array.isArray(memory) && (memory as Record<string, unknown>)["embeddings"] != null) {
		return ["memory", "embeddings"];
	}
	return ["embedding"];
}

/** Embeddings assignment — provider + model + endpoint. Changing provider or
 * model re-embeds the entire memory database, so the warning stays visible. */
function EmbeddingEditor({ store }: { store: AgentConfigStore }) {
	const embPath = useMemo(() => resolveEmbPath(store.agent), [store.agent]);

	const provider = store.aStr([...embPath, "provider"]) || "native";
	const model = store.aStr([...embPath, "model"]);
	const endpoint = store.aStr([...embPath, "baseUrl"]) || store.aStr([...embPath, "endpoint"]);
	const nonNative = provider !== "native" && provider !== "";

	const apply = (path: readonly string[], value: string) => {
		store.aSetStr(path, value);
		void store.save();
	};

	return (
		<>
			<div className="flex items-center justify-between gap-3 rounded-[var(--radius)] px-2.5 py-1.75 hover:bg-[var(--accent-subtle)]">
				<div className="flex min-w-0 items-baseline gap-1.75">
					<span className="text-[12.5px] font-medium">Embeddings</span>
					<span className="font-mono text-[9px] text-muted-foreground">vectors</span>
				</div>
				<CtrlSelect
					value={provider}
					options={[
						{ value: "native", label: "native (built-in nomic)" },
						{ value: "ollama", label: "ollama" },
						{ value: "openai", label: "openai" },
						{ value: "llama-cpp", label: "llama.cpp" },
					]}
					onChange={(v) => apply([...embPath, "provider"], v || "native")}
				/>
			</div>
			<Row title="Model" desc="Changing provider or model re-embeds your entire memory database.">
				<CtrlInput value={model} placeholder="nomic-embed-text" onChange={(v) => apply([...embPath, "model"], v)} />
			</Row>
			{nonNative && (
				<Row title="Endpoint" desc="Base URL of the embedding server.">
					<CtrlInput value={endpoint} placeholder="http://localhost:11434" onChange={(v) => apply([...embPath, "baseUrl"], v)} />
				</Row>
			)}
		</>
	);
}

/* ── Advanced ── */

/** Numeric ctrl — commits on blur/Enter, clamps to [min,max], reverts on junk. */
function NumCtrl({
	value,
	min,
	max,
	step,
	onCommit,
}: {
	value: string;
	min: number;
	max: number;
	step?: number;
	onCommit: (n: number) => void;
}) {
	const [text, setText] = useState(value);
	useEffect(() => setText(value), [value]);
	const commit = () => {
		const n = Number.parseFloat(text);
		if (!Number.isFinite(n)) {
			setText(value);
			return;
		}
		const clamped = Math.min(max, Math.max(min, n));
		if (String(clamped) !== value) onCommit(clamped);
		setText(String(clamped));
	};
	return (
		<div className="ctrl ctrl--field w-[220px]">
			<input
				type="number"
				value={text}
				min={min}
				max={max}
				step={step ?? 1}
				onChange={(e) => setText(e.target.value)}
				onBlur={commit}
				onKeyDown={(e) => {
					if (e.key === "Enter") commit();
				}}
			/>
		</div>
	);
}

function AdvToggle({
	store,
	path,
	title,
	desc,
}: {
	store: AgentConfigStore;
	path: readonly string[];
	title: string;
	desc: string;
}) {
	return (
		<Row title={title} desc={desc}>
			<Switch
				checked={store.aBool(path)}
				onCheckedChange={(v) => {
					store.aSetBool(path, v);
					void store.save();
				}}
			/>
		</Row>
	);
}

function DreamingToggle({ store }: { store: AgentConfigStore }) {
	const dreamingEnabled = isDreamingEnabled(store.agent);

	return (
		<Row title="Dreaming" desc="Runs while the memory pipeline is not paused or frozen.">
			<Switch checked={dreamingEnabled} disabled aria-label="Dreaming runtime status" />
		</Row>
	);
}

function AdvNum({
	store,
	path,
	title,
	desc,
	min,
	max,
	step,
}: {
	store: AgentConfigStore;
	path: readonly string[];
	title: string;
	desc: string;
	min: number;
	max: number;
	step?: number;
}) {
	return (
		<Row title={title} desc={desc}>
			<NumCtrl
				value={store.aStr(path)}
				min={min}
				max={max}
				step={step}
				onCommit={(n) => {
					store.aSetNum(path, n);
					void store.save();
				}}
			/>
		</Row>
	);
}

/** Consolidated power-user surface. Everything here is config the daemon
 * actually reads (verified against memory-config.ts); the old dashboard's
 * dead sections (auth/trust/mode/paths) were dropped, not ported. */
function AdvancedSection() {
	const store = useAgentConfig();
	const pv2 = (key: string): readonly string[] => ["memory", "pipelineV2", key];
	const srch = (key: string): readonly string[] => ["search", key];
	const drm = (key: string): readonly string[] => ["memory", "dreaming", key];
	const embPath = useMemo(() => resolveEmbPath(store.agent), [store.agent]);
	const maintenanceMode = store.aStr(pv2("maintenanceMode"));

	return (
		<div className="flex flex-col gap-3">
			<div className="sig-mcard flex flex-col gap-px">
				<GroupLabel>Pipeline</GroupLabel>
				<AdvToggle store={store} path={pv2("enabled")} title="Pipeline enabled" desc="Master switch. The memory pipeline does nothing when disabled." />
				<AdvToggle store={store} path={pv2("shadowMode")} title="Shadow mode" desc="Run extraction and decisions without writing. Safe for evaluation." />
				<AdvToggle store={store} path={pv2("mutationsFrozen")} title="Freeze mutations" desc="Emergency brake — blocks all writes even when shadow mode is off." />
				<AdvToggle store={store} path={pv2("graphEnabled")} title="Knowledge graph" desc="Build and query a graph from extracted entity relationships." />
			</div>

			<div className="sig-mcard flex flex-col gap-px">
				<GroupLabel>Autonomy &amp; maintenance</GroupLabel>
				<AdvToggle store={store} path={pv2("autonomousEnabled")} title="Autonomous operations" desc="Allow autonomous pipeline operations like maintenance and repair." />
				<AdvToggle store={store} path={pv2("autonomousFrozen")} title="Freeze autonomous writes" desc="Block autonomous writes while still allowing autonomous reads." />
				<AdvToggle store={store} path={pv2("allowUpdateDelete")} title="Allow update/delete" desc="Permit UPDATE/DELETE decisions on existing memories." />
				<Row title="Maintenance mode" desc="'observe' logs diagnostics without changes; 'execute' attempts repairs. Unset defaults to execute.">
					<CtrlSelect
						value={maintenanceMode}
						options={[
							{ value: "observe", label: "observe" },
							{ value: "execute", label: "execute" },
						]}
						onChange={(v) => {
							store.aSetStr(pv2("maintenanceMode"), v);
							void store.save();
						}}
					/>
				</Row>
			</div>

			<div className="sig-mcard flex flex-col gap-px">
				<GroupLabel>Extraction</GroupLabel>
				<AdvNum store={store} path={pv2("extractionTimeout")} title="Extraction timeout (ms)" desc="Deadline for the extraction LLM call." min={5000} max={300000} step={1000} />
				<AdvNum store={store} path={pv2("minFactConfidenceForWrite")} title="Min fact confidence" desc="Facts below this threshold are dropped. Lower captures more at the cost of noise." min={0} max={1} step={0.05} />
				<AdvToggle store={store} path={pv2("semanticContradictionEnabled")} title="Semantic contradiction check" desc="Use an LLM to detect contradictions on update proposals. Adds latency but catches subtle conflicts." />
				<AdvNum store={store} path={pv2("semanticContradictionTimeoutMs")} title="Contradiction timeout (ms)" desc="Falls back to 'no contradiction' on timeout." min={5000} max={300000} step={1000} />
				<AdvNum store={store} path={pv2("workerPollMs")} title="Worker poll (ms)" desc="How often the pipeline worker polls for pending jobs." min={100} max={60000} step={100} />
			</div>

			<div className="sig-mcard flex flex-col gap-px">
				<GroupLabel>Recall</GroupLabel>
				<AdvNum store={store} path={srch("alpha")} title="Alpha" desc="Vector weight (0–1). 0.9 is heavily semantic; 0.3 skews toward keyword matching. Default 0.7." min={0} max={1} step={0.05} />
				<AdvNum store={store} path={srch("top_k")} title="Top K" desc="Candidates fetched from each source (BM25 and vector) before blending. Default 20." min={1} max={100} />
				<AdvNum store={store} path={srch("min_score")} title="Min score" desc="Results below this combined-score threshold are dropped. Default 0.3." min={0} max={1} step={0.05} />
				<AdvToggle store={store} path={srch("rehearsal_enabled")} title="Rehearsal boost" desc="Boost scores for frequently-recalled memories using access count and last-accessed time." />
				<AdvNum store={store} path={srch("rehearsal_weight")} title="Rehearsal weight" desc="Score multiplier for the rehearsal boost. Default 0.1." min={0} max={1} step={0.05} />
				<AdvNum store={store} path={srch("rehearsal_half_life_days")} title="Rehearsal half-life (days)" desc="Days until the rehearsal boost decays to half. Default 30." min={1} max={365} />
				<AdvToggle store={store} path={pv2("rerankerEnabled")} title="Reranker" desc="Re-score recall candidates by full-content embedding similarity. No LLM call needed." />
				<AdvNum store={store} path={pv2("rerankerTopN")} title="Reranker top N" desc="Number of top candidates re-scored by embedding similarity." min={1} max={100} />
				<AdvNum store={store} path={pv2("graphBoostWeight")} title="Graph boost weight" desc="Score boost applied to graph-linked memories during search." min={0} max={1} step={0.05} />
			</div>

			<div className="sig-mcard flex flex-col gap-px">
				<GroupLabel>Dreaming</GroupLabel>
				<DreamingToggle store={store} />
				<AdvNum store={store} path={drm("tokenThreshold")} title="Token threshold" desc="Accumulated transcript tokens that trigger a dreaming pass. Default 100,000." min={10000} max={1000000} step={10000} />
				<AdvToggle store={store} path={drm("backfillOnFirstRun")} title="Backfill on first run" desc="Process existing transcripts the first time dreaming is enabled." />
			</div>

			<div className="sig-mcard flex flex-col gap-px">
				<GroupLabel>Embeddings extras</GroupLabel>
				<AdvNum store={store} path={[...embPath, "dimensions"]} title="Dimensions" desc="Vector dimensions for the active embedding model. Changing this re-embeds everything." min={64} max={4096} />
				<AdvNum store={store} path={[...embPath, "promptSubmitTimeoutMs"]} title="Prompt-submit timeout (ms)" desc="Deadline for the recall embedding before prompt injection. Raise for slow local models that cold-load." min={1000} max={300000} step={1000} />
			</div>
		</div>
	);
}

/* ── Logs ── */

type LogLevel = "info" | "warn" | "error" | "debug";

function formatLogTime(ts: string): string {
	const d = new Date(ts);
	if (Number.isNaN(d.getTime())) return ts;
	const base = d.toLocaleTimeString("en-GB", { hour12: false });
	return `${base}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

function LogsSection() {
	const [level, setLevel] = useState<LogLevel | "all">("all");
	const [query, setQuery] = useState("");
	const [openRaw, setOpenRaw] = useState<number | null>(null);
	const logsQuery = useAsync(() => api.getLogs(200), { intervalMs: 5_000 });
	const logs: LogEntry[] = useMemo(() => [...(logsQuery.data?.logs ?? [])].reverse(), [logsQuery.data]);

	const filtered = logs.filter((l) => {
		if (level !== "all" && l.level !== level) return false;
		if (query) {
			const hay = `${l.message} ${l.category} ${l.level}`.toLowerCase();
			if (!hay.includes(query.toLowerCase())) return false;
		}
		return true;
	});

	function exportLogs() {
		const blob = new Blob([JSON.stringify(filtered, null, 2)], { type: "application/json" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = `signet-logs-${Date.now()}.json`;
		document.body.appendChild(a);
		a.click();
		a.remove();
		URL.revokeObjectURL(url);
	}

	return (
		<div className="-m-5 flex h-full flex-col">
			<div className="flex items-center gap-2.5 border-b border-[oklch(1_0_0/0.06)] px-6 pb-3 pt-1.5 [html:not(.dark)_&]:border-[oklch(0_0_0/0.06)]">
				<button
					type="button"
					onClick={exportLogs}
					className="flex items-center gap-1.5 rounded-[var(--radius)] border border-[oklch(1_0_0/0.1)] px-2.5 py-1 font-mono text-[10px] text-muted-foreground transition-colors hover:border-[oklch(1_0_0/0.22)] hover:text-foreground [html:not(.dark)_&]:border-[oklch(0_0_0/0.1)]"
				>
					<Download className="size-3" /> Export
				</button>
				<div className="flex-1" />
				<div className="flex h-7 min-w-0 items-center gap-1.75 rounded-[var(--radius)] border border-[oklch(1_0_0/0.1)] bg-[color-mix(in_oklch,var(--foreground)_3%,transparent)] px-2.5 [html:not(.dark)_&]:border-[oklch(0_0_0/0.1)]">
					<Search className="size-3 shrink-0 text-muted-foreground" />
					<input
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder="Filter logs…"
						className="w-[110px] border-0 bg-transparent text-[11px] outline-none placeholder:text-muted-foreground"
					/>
				</div>
				<div className="flex shrink-0 gap-px rounded-[var(--radius)] border border-[oklch(1_0_0/0.08)] bg-[color-mix(in_oklch,var(--foreground)_4%,transparent)] p-0.75 [html:not(.dark)_&]:border-[oklch(0_0_0/0.08)]">
					{(["all", "info", "warn", "error"] as const).map((l) => (
						<button
							key={l}
							type="button"
							onClick={() => {
								setLevel(l);
								setOpenRaw(null);
							}}
							className={cn(
								"flex items-center gap-1.25 rounded-[calc(var(--radius)-2px)] px-2.25 py-1 font-mono text-[9.5px] font-semibold uppercase tracking-[0.05em] transition-colors",
								level === l
									? "bg-[var(--active-overlay)] text-foreground"
									: "text-muted-foreground hover:text-foreground",
							)}
						>
							{l !== "all" && (
								<span
									className="size-1.5 rounded-full"
									style={{
										background:
											l === "info" ? "oklch(0.7 0.1 220)" : l === "warn" ? "oklch(0.78 0.15 85)" : "oklch(0.72 0.19 25)",
									}}
								/>
							)}
							{l}
						</button>
					))}
				</div>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto font-mono text-[11px] leading-[1.7] [mask-image:linear-gradient(180deg,#000_0,#000_calc(100%-20px),transparent_100%)]">
				{logsQuery.loading && (
					<div className="flex items-center gap-2 px-6 py-4 text-muted-foreground">
						<Loader2 className="size-3 animate-spin" /> Loading daemon logs…
					</div>
				)}
				{!logsQuery.loading && filtered.length === 0 && (
					<div className="px-6 py-4 text-muted-foreground">No log lines match.</div>
				)}
				{filtered.map((l, i) => {
					const raw = l.data && Object.keys(l.data).length > 0 ? JSON.stringify(l.data, null, 2) : null;
					return (
						<div key={i}>
							<button
								type="button"
								onClick={() => raw && setOpenRaw(openRaw === i ? null : i)}
								className={cn(
									"grid w-full items-baseline gap-0 border-b border-[oklch(1_0_0/0.03)] px-6 py-0.75 text-left transition-colors [html:not(.dark)_&]:border-[oklch(0_0_0/0.03)]",
									raw ? "cursor-pointer" : "cursor-default",
									l.level === "error" ? "hover:bg-[oklch(0.4_0.15_25/0.08)]" : l.level === "warn" ? "hover:bg-[oklch(0.5_0.15_85/0.06)]" : "hover:bg-[var(--accent-subtle)]",
								)}
								style={{ gridTemplateColumns: "84px 50px 80px 1fr" }}
							>
								<span className="pr-3 text-[oklch(0.5_0_0)] [html:not(.dark)_&]:text-[oklch(0.55_0_0)]">{formatLogTime(l.timestamp)}</span>
								<span
									className={cn(
										"pr-3 text-[10px] font-semibold",
										l.level === "info" && "text-[oklch(0.7_0.1_220)]",
										l.level === "warn" && "w-fit rounded bg-[oklch(0.7_0.15_85/0.12)] px-1.5 text-[oklch(0.82_0.15_85)]",
										l.level === "error" && "w-fit rounded bg-[oklch(0.6_0.2_25/0.14)] px-1.5 text-[oklch(0.78_0.19_25)]",
										l.level === "debug" && "text-[oklch(0.55_0_0)] [html:not(.dark)_&]:text-[oklch(0.5_0_0)]",
									)}
								>
									{l.level.toUpperCase()}
								</span>
								<span className="overflow-hidden whitespace-nowrap pr-3 text-ellipsis text-[10.5px] text-[oklch(0.62_0_0)] [html:not(.dark)_&]:text-[oklch(0.42_0_0)]">
									{l.category}
								</span>
								<span className="overflow-hidden text-ellipsis whitespace-nowrap text-[oklch(0.82_0_0)] [html:not(.dark)_&]:text-[oklch(0.25_0_0)]">
									{l.message}
								</span>
							</button>
							{openRaw === i && raw && (
								<pre className="mx-6 my-1 max-h-40 overflow-auto rounded-[var(--radius)] border border-[oklch(1_0_0/0.08)] bg-[oklch(0.14_0_0)] p-3.5 font-mono text-[10px] leading-[1.6] [html:not(.dark)_&]:border-[oklch(0_0_0/0.08)] [html:not(.dark)_&]:bg-[oklch(0.96_0_0)]">
									{raw}
								</pre>
							)}
						</div>
					);
				})}
			</div>
		</div>
	);
}

// Keyboard: ⌘, opens settings (wired in the layout).
export function useSettingsHotkey() {
	const { open, setOpen } = useSettings();
	useEffect(() => {
		function onKey(e: KeyboardEvent) {
			if (e.key === "," && (e.metaKey || e.ctrlKey) && !open) {
				e.preventDefault();
				setOpen(true);
			}
		}
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [open, setOpen]);
}

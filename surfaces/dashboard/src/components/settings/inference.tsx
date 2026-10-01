import { Button } from "@/components/ui/button";
import { SearchField } from "@/components/ui/field";
import { Metric } from "@/components/ui/metric";
import { ConnectProviderDialog } from "@/components/settings/connect-dialog";
import { type AgentConfigStore, useAgentConfig } from "@/lib/agent-config";
import { type InferenceCatalog, api } from "@/lib/api";
import { readEmbeddingEndpoint, writeEmbeddingEndpoint } from "@/lib/embedding-config";
import {
	allowRemoteMemoryExtraction,
	ensureInferenceRoute,
	requiresRemoteMemoryConsent,
} from "@/lib/inference-route-config";
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
import { useAsync } from "@/lib/use-async";
import { cn } from "@/lib/utils";
import { CheckCircle, RefreshCw, TriangleAlert } from "@/components/mingcute-icons";
import { useEffect, useMemo, useState } from "react";

import { GroupLabel, SettingRow, SettingSelect, SettingInput, SettingsGroup } from "./controls";
function readAccounts(store: AgentConfigStore): AccountsMap {
	const raw = store.agent["inference"];
	if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return {};
	const accounts = (raw as Record<string, unknown>)["accounts"];
	if (accounts == null || typeof accounts !== "object" || Array.isArray(accounts)) return {};
	return accounts as AccountsMap;
}
async function persistProviderChange(store: AgentConfigStore, refreshCatalog: () => void): Promise<void> {
	if (!(await store.save())) throw new Error("Could not save the connection settings. Please retry.");
	refreshCatalog();
}

export function InferenceSection() {
	const store = useAgentConfig();
	const catalogQuery = useAsync(() => api.getInferenceCatalog(), { key: "inference-catalog", intervalMs: 60_000 });
	const catalog = catalogQuery.data;
	const [filter, setFilter] = useState("");
	const [connecting, setConnecting] = useState<ConnectableProvider | null>(null);
	const accounts = readAccounts(store);
	const providers = useMemo(() => connectableProviders(catalog, accounts), [catalog, accounts]);
	const refreshCatalog = () => catalogQuery.refresh();
	const [routeRefreshKey, setRouteRefreshKey] = useState(0);
	const refreshRoutes = () => setRouteRefreshKey((value) => value + 1);

	const visible = providers.filter((p) => p.name.toLowerCase().includes(filter.toLowerCase()));

	return (
		<div className="flex flex-col gap-3">
			<RouteHealthPanel refreshKey={routeRefreshKey} />
			<SettingsGroup title="Model assignment" suffix={store.saving ? "· saving…" : undefined}>
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
			</SettingsGroup>

			<SettingsGroup title="Connected providers" suffix={`· ${providers.length} available`}>
				<SearchField
					className="mb-2"
					value={filter}
					onChange={(e) => setFilter(e.target.value)}
					placeholder="Search providers…"
				/>
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
									{(catalog?.models[p.id]?.length ?? 0) > 0 ? ` · ${catalog?.models[p.id].length} models` : ""}
								</span>
							</span>
							<Button variant="outline" size="compact" type="button" onClick={() => setConnecting(p)}>
								{p.connected
									? "Manage"
									: p.supportsOAuth && !p.supportsApiKey
										? "Sign in"
										: p.supportsOAuth
											? "Connect"
											: "Add key"}
							</Button>
						</div>
					))}
				</div>
				{Object.keys(catalog?.modelErrors ?? {}).length > 0 && (
					<div className="flex flex-col gap-1 px-1.5 pb-1">
						{Object.entries(catalog?.modelErrors ?? {}).map(([providerId, message]) => (
							<div
								key={providerId}
								className="flex items-center gap-1.5 font-mono text-[10px] text-[oklch(0.82_0.15_85)]"
							>
								<TriangleAlert className="size-3 shrink-0" />
								<span>
									{providerId}: {message}
								</span>
							</div>
						))}
					</div>
				)}
			</SettingsGroup>

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
	const statusQuery = useAsync(() => api.getInferenceStatusDetailed(), {
		key: "inference-status",
		intervalMs: 60_000,
		deps: [refreshKey],
	});
	const memoryDecisionQuery = useAsync(() => api.getInferenceDecision({ operation: "memory_extraction" }), {
		key: "inference-decision:memory-extraction",
		intervalMs: 60_000,
		deps: [refreshKey],
	});
	const [checking, setChecking] = useState(false);
	const [report, setReport] = useState<RouteCheckReport | null>(null);
	const status = report?.status ?? statusQuery.data?.data;
	const statusError = report?.statusError ?? statusQuery.data?.error;
	const issues = status?.configIssues ?? [];
	const targets = Object.entries(status?.runtimeSnapshot?.targets ?? {}) as Array<
		[string, { available?: boolean; unavailableReason?: string } | undefined]
	>;

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
	// biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey intentionally controls the route check.
	useEffect(() => {
		if (refreshKey > 0) void checkRoutes();
	}, [refreshKey]);

	return (
		<SettingsGroup>
			<div className="flex items-center justify-between px-1.5">
				<GroupLabel
					suffix={
						report?.probeOk == null ? undefined : report.probeOk ? "· test response received" : "· test response failed"
					}
				>
					Inference check
				</GroupLabel>
				<Button variant="outline" size="compact" type="button" onClick={() => void checkRoutes()} disabled={checking}>
					<RefreshCw className={cn("size-3", checking && "animate-spin")} />
					{checking ? "Checking…" : "Run check"}
				</Button>
			</div>
			<p className="settings-row-description mb-2">
				Shows where Signet sends memory processing and recall requests. Run check refreshes this information and sends a
				small test request for memory processing.
			</p>
			{status ? (
				<>
					<div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
						<Metric label="Default routing rule" value={status.defaultPolicy ?? "not set"} />
						<Metric label="Routing rules" value={String(status.policies?.length ?? 0)} />
						<Metric label="Task types" value={String(status.taskClasses?.length ?? 0)} />
						<Metric label="Destinations" value={String(status.targetRefs?.length ?? 0)} />
					</div>
					<div className="mt-1.5 flex flex-col gap-1">
						<RouteDecisionRow
							label="Memory processing"
							decision={report?.memoryExtraction ?? memoryDecisionQuery.data}
						/>
						{status.workloadBindings?.aggregateRecall && (
							<RouteDecisionRow label="Recall" decision={report?.aggregateRecall} />
						)}
					</div>
					{targets.length > 0 && (
						<div className="mt-1.5 flex flex-wrap gap-1.5">
							{targets.map(([ref, state]) => (
								<span
									key={ref}
									className={cn(
										"rounded bg-[color-mix(in_oklch,var(--foreground)_5%,transparent)] px-1.5 py-1 font-mono text-[9px]",
										state?.available ? "text-success" : "text-muted-foreground",
									)}
								>
									{ref} · {state?.available ? "Available" : "Unavailable"}
								</span>
							))}
						</div>
					)}
					{issues.length > 0 && (
						<div className="mt-1.5 flex flex-col gap-1 rounded-[var(--radius)] bg-[oklch(0.7_0.15_85/0.08)] px-2.5 py-2 font-mono text-[9.5px] text-[oklch(0.72_0.15_85)]">
							{issues.map((issue) => (
								<span key={`${issue.field}:${issue.ref}`}>
									{issue.severity}: {issue.message}
								</span>
							))}
						</div>
					)}
				</>
			) : (
				<div className="px-2.5 pb-1 text-[11px] text-muted-foreground">
					{statusError ?? "Could not load inference details. Run check to try again."}
				</div>
			)}
		</SettingsGroup>
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
		const blockedBy = Array.isArray(row.blockedBy)
			? row.blockedBy.filter((reason): reason is string => typeof reason === "string")
			: [];
		if (blockedBy.length === 0) return [];
		const targetRef = typeof row.targetRef === "string" ? row.targetRef : "candidate";
		return [`${targetRef}: ${blockedBy.join(", ")}`];
	});
}

function RouteDecisionRow({
	label,
	decision,
}: {
	label: string;
	decision: Awaited<ReturnType<typeof api.getInferenceDecision>> | undefined | null;
}) {
	const route = decision?.data;
	const blockedBy = routeBlockedBy(decision?.details);
	const value = route
		? `${route.targetRef} · routing rule: ${route.policyId}`
		: blockedBy.length > 0
			? `Cannot use a destination: ${blockedBy.join(", ")}`
			: (decision?.error ?? "Not checked yet. Run check to see the destination.");
	return (
		<div className="flex items-center gap-2 rounded-[var(--radius)] px-2.5 py-1.5 text-[11px]">
			{route ? (
				<CheckCircle className="size-3.5 shrink-0 text-success" />
			) : (
				<TriangleAlert className="size-3.5 shrink-0 text-[oklch(0.75_0.14_75)]" />
			)}
			<span className="font-medium">{label}</span>
			<span className="truncate font-mono text-[9.5px] text-muted-foreground" title={value}>
				{value}
			</span>
		</div>
	);
}
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
	const accountName = targetName;
	const targetBase = ["inference", "targets", targetName] as const;
	const accountBase = ["inference", "accounts", accountName] as const;
	const workloadBase = ["inference", "workloads", workloadKey] as const;

	const executor = store.aStr([...targetBase, "executor"]);
	const modelId = store.aStr([...targetBase, "models", "default", "model"]);
	const endpoint = store.aStr([...targetBase, "endpoint"]);
	const acpxAgent = store.aStr([...targetBase, "acpx", "agent"]) || "claude";
	const apiKeyRef = store.aStr([...accountBase, "credentialRef"]);
	type RemoteConsent = { readonly endpoint?: string; readonly executor: string };
	const [pendingRemote, setPendingRemote] = useState<RemoteConsent | null>(null);
	const [remoteConsentDismissed, setRemoteConsentDismissed] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const memoryPrivacy = store.aStr(["inference", "taskClasses", "memory_extraction", "privacy"]);

	const kind = backendKind(executor);
	useEffect(() => {
		if (
			!remoteConsentDismissed &&
			pendingRemote === null &&
			targetName === "background" &&
			requiresRemoteMemoryConsent(kind, executor, endpoint, memoryPrivacy)
		) {
			setPendingRemote({ executor, ...(endpoint ? { endpoint } : {}) });
		}
	}, [endpoint, executor, kind, memoryPrivacy, pendingRemote, remoteConsentDismissed, targetName]);
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
	const saveAndCheck = (onFailure?: () => void) => {
		void store.save().then((saved) => {
			if (saved) {
				setSaveError(null);
				onRouteChanged();
			} else onFailure?.();
		});
	};

	const applyTarget = (next: string, remoteConsent = false, remoteEndpoint?: string) => {
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
				store.aSetStr([...targetBase, "account"], accountForFamily(accounts, next) ?? next);
				store.aDel(accountBase);
			} else if (nextKind === "acpx") {
				store.aDel([...targetBase, "account"]);
				store.aDel(accountBase);
			} else {
				const hasKey = !!store.aStr([...accountBase, "credentialRef"]);
				if (next === "openai-compatible" && remoteEndpoint) store.aSetStr([...targetBase, "endpoint"], remoteEndpoint);
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
		saveAndCheck(
			remoteConsent
				? () => {
						void store.reload().then(() => {
							setRemoteConsentDismissed(false);
							setSaveError(
								"Could not save the remote-extraction decision. The persisted privacy gate is still active.",
							);
							setPendingRemote({ executor: next, ...(remoteEndpoint ? { endpoint: remoteEndpoint } : {}) });
						});
					}
				: undefined,
		);
	};

	const writeTarget = (next: string) => {
		const privacy = store.aStr(["inference", "taskClasses", "memory_extraction", "privacy"]);
		const nextKind = backendKind(next);
		const nextEndpoint = next === "openai-compatible" ? endpoint : "";
		if (targetName === "background" && requiresRemoteMemoryConsent(nextKind, next, nextEndpoint, privacy)) {
			setSaveError(null);
			setRemoteConsentDismissed(false);
			setPendingRemote({ executor: next, ...(nextEndpoint ? { endpoint: nextEndpoint } : {}) });
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
		const privacy = store.aStr(["inference", "taskClasses", "memory_extraction", "privacy"]);
		if (targetName === "background" && requiresRemoteMemoryConsent("local", "openai-compatible", v, privacy)) {
			setSaveError(null);
			setRemoteConsentDismissed(false);
			setPendingRemote({ executor: "openai-compatible", endpoint: v });
			return;
		}
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
			<SettingRow
				title={
					<span className="flex items-baseline gap-2">
						{label}
						<span className="text-xs font-normal text-muted-foreground">{tag}</span>
					</span>
				}
			>
				<SettingSelect value={executor} options={backendOptions} onChange={writeTarget} placeholder="— none —" />
			</SettingRow>
			{executor !== "" && kind === "acpx" && (
				<SettingRow title="ACPX agent" desc="The harness ACPX drives.">
					<SettingSelect
						value={acpxAgent}
						options={ACPX_AGENTS.map((a) => ({ value: a, label: a }))}
						onChange={setAcpxAgent}
					/>
				</SettingRow>
			)}
			{executor !== "" && kind !== "acpx" && (
				<SettingRow
					title="Model"
					desc={
						kind === "local" ? "The model id your server exposes." : "From the pi-ai catalog — or type a custom id."
					}
				>
					<div className="settings-control flex flex-col gap-2">
						{modelOptions.length > 0 && <SettingSelect value={modelId} options={modelOptions} onChange={setModel} />}
						<SettingInput value={modelId} placeholder="custom model id" onChange={setModel} />
					</div>
				</SettingRow>
			)}
			{kind === "local" && (
				<SettingRow
					title="Endpoint"
					desc="LM Studio: http://localhost:1234/v1 · Ollama: http://localhost:11434 · llama.cpp: http://localhost:8080/v1"
				>
					<SettingInput value={endpoint} placeholder="http://localhost:1234/v1" onChange={setEndpoint} />
				</SettingRow>
			)}
			{executor === "openai-compatible" && (
				<SettingRow title="API key (secret name)" desc="The Signet secret holding the key. Optional for local servers.">
					<SettingInput value={apiKeyRef} placeholder={secretNameFor(executor)} onChange={setApiKey} />
				</SettingRow>
			)}
			{pendingRemote && (
				<div className="mt-2 rounded-[var(--radius)] border border-[oklch(0.72_0.15_85/0.3)] bg-[oklch(0.72_0.15_85/0.08)] px-3 py-2.5">
					{saveError && <div className="mb-1 text-[11px] text-[oklch(0.72_0.15_25)]">{saveError}</div>}
					<div className="text-[12px] font-semibold">
						Use{" "}
						{pendingRemote.executor === "acpx"
							? `ACPX (${acpxAgent})`
							: pendingRemote.executor === "openai-compatible"
								? "OpenAI-compatible endpoint"
								: (PROVIDER_NAMES[pendingRemote.executor] ?? titleCase(pendingRemote.executor))}{" "}
						for memory extraction?
					</div>
					<div className="mt-1 text-[11.5px] leading-snug text-muted-foreground">
						Selected memory sources and transcript text may be sent to this remote executor to extract durable facts.
					</div>
					<div className="mt-2 flex flex-wrap gap-1.5">
						<Button
							variant="default"
							size="compact"
							type="button"
							onClick={() => {
								const consent = pendingRemote;
								applyTarget(consent.executor, true, consent.endpoint);
								setPendingRemote(null);
							}}
						>
							Use remotely
						</Button>
						<Button
							variant="outline"
							size="compact"
							type="button"
							onClick={() => {
								setRemoteConsentDismissed(true);
								setPendingRemote(null);
							}}
						>
							Keep privacy gate
						</Button>
						<Button
							variant="ghost"
							size="compact"
							type="button"
							onClick={() => {
								setRemoteConsentDismissed(true);
								setPendingRemote(null);
							}}
						>
							Cancel
						</Button>
					</div>
				</div>
			)}
		</>
	);
}
function EmbeddingEditor({ store }: { store: AgentConfigStore }) {
	const embPath = ["embedding"] as const;

	const provider = store.aStr([...embPath, "provider"]) || "native";
	const model = store.aStr([...embPath, "model"]);
	const endpoint = readEmbeddingEndpoint(store, embPath);
	const nonNative = provider !== "native" && provider !== "";

	const apply = (path: readonly string[], value: string) => {
		store.aSetStr(path, value);
		void store.save();
	};

	return (
		<>
			<SettingRow
				title={
					<span className="flex items-baseline gap-2">
						Embeddings<span className="text-xs font-normal text-muted-foreground">vectors</span>
					</span>
				}
			>
				<SettingSelect
					value={provider}
					options={[
						{ value: "native", label: "native (built-in nomic)" },
						{ value: "ollama", label: "ollama" },
						{ value: "openai", label: "openai" },
						{ value: "llama-cpp", label: "llama.cpp" },
					]}
					onChange={(v) => apply([...embPath, "provider"], v || "native")}
				/>
			</SettingRow>
			<SettingRow title="Model" desc="Changing provider or model re-embeds your entire memory database.">
				<SettingInput value={model} placeholder="nomic-embed-text" onChange={(v) => apply([...embPath, "model"], v)} />
			</SettingRow>
			{nonNative && (
				<SettingRow title="Endpoint" desc="Base URL of the embedding server.">
					<SettingInput
						value={endpoint}
						placeholder="http://localhost:11434"
						onChange={(v) => {
							writeEmbeddingEndpoint(store, embPath, v);
							void store.save();
						}}
					/>
				</SettingRow>
			)}
		</>
	);
}

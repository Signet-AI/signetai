import { Dialog } from "radix-ui";
import { useEffect, useRef, useState } from "react";
import { api, getJSONResult, type Memory } from "@/lib/api";
import { useAgentConfig } from "@/lib/agent-config";
import { useAsync } from "@/lib/use-async";
import { allowRemoteMemoryExtraction, ensureInferenceRoute } from "@/lib/inference-route-config";
import { providerKeySecretName } from "@/lib/inference-keys";
import { PROVIDER_NAMES } from "@/lib/providers";
import { createOAuthNavigation, safeOAuthHref } from "@/lib/oauth-navigation";
import { getDesktopBridge } from "@/lib/desktop";
import { useConnectController } from "@/components/settings/connect-controller";
import { ConnectSourceDialog, type SourceKind } from "@/components/sources/connect-source-dialog";
import "./onboarding.css";

interface Harness {
	id: string;
	name: string;
	exists: boolean;
}
const DIRECT_AGENTS = new Set(["claude-code", "codex", "hermes-agent"]);
const STEPS = ["Welcome", "Agents", "Connection", "Sources", "First memory", "Ready"];

export function OnboardingModal() {
	const [open, setOpen] = useState(() => window.location.hash === "#setup");
	useEffect(() => {
		const changed = () => {
			if (window.location.hash === "#setup") setOpen(true);
		};
		window.addEventListener("hashchange", changed);
		return () => window.removeEventListener("hashchange", changed);
	}, []);
	return open ? (
		<OnboardingFlow
			onClose={() => {
				setOpen(false);
				history.replaceState(null, "", "#home");
			}}
		/>
	) : null;
}

function OnboardingFlow({ onClose }: { onClose: () => void }) {
	const store = useAgentConfig();
	const status = useAsync(() => api.getStatus());
	const catalog = useAsync(() => api.getInferenceCatalog());
	const harnesses = useAsync(() => getJSONResult<{ harnesses: Harness[] }>("/api/harnesses"));
	const [step, setStep] = useState(0);
	const [selected, setSelected] = useState<string[]>([]);
	const [provider, setProvider] = useState("");
	const [model, setModel] = useState("");
	const [account, setAccount] = useState("");
	const [endpoint, setEndpoint] = useState("http://127.0.0.1:1234/v1");
	const [key, setKey] = useState("");
	const [prompt, setPrompt] = useState("");
	const [connected, setConnected] = useState(false);
	const [verified, setVerified] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [memory, setMemory] = useState("I prefer short answers with concrete examples.");
	const [memoryId, setMemoryId] = useState<string | null>(null);
	const [recalled, setRecalled] = useState<Memory | null>(null);
	const [sourceKind, setSourceKind] = useState<SourceKind | null>(null);
	const [sourceBusy, setSourceBusy] = useState(false);
	const sources = useAsync(() => api.getSources(), { intervalMs: 5000 });
	const imports = useAsync(() => api.getSourceImports(), { intervalMs: 5000 });
	const loaded = useRef(false);
	const memoryKey = useRef(crypto.randomUUID());
	const request = useRef<AbortController | null>(null);
	const storageKey = status.data ? `signet:onboarding:${status.data.agentsDir}:${status.data.agentId}` : null;
	const navigation = useRef(
		createOAuthNavigation({
			bridge: getDesktopBridge(),
			popup: () => window.open("about:blank", "signet-oauth", "width=640,height=760"),
			reportError: setError,
			clearError: () => setError(null),
		}),
	).current;
	const persistAccount = async (credential?: string) => {
		const base = ["inference", "accounts", account || provider];
		store.aSetStr([...base, "kind"], credential ? "api" : "subscription_session");
		store.aSetStr([...base, "providerFamily"], provider);
		if (credential) store.aSetStr([...base, "credentialRef"], credential);
		else store.aDel([...base, "credentialRef"]);
		if (!(await store.save()))
			throw new Error("Sign-in was saved, but account settings could not be saved. Try again.");
		setConnected(true);
		await catalog.refresh();
	};
	const controller = useConnectController({
		providerId: provider,
		supportsOAuth: true,
		supportsApiKey: true,
		onNavigate: navigation.navigate,
		onConnected: () => persistAccount(),
	});
	const phase = controller.phase;
	const local = provider === "openai-compatible";
	const oauth = catalog.data?.oauthProviders.find((p) => p.id === provider);
	const providerName = local ? "Local model" : (PROVIDER_NAMES[provider] ?? provider);

	useEffect(
		() => () => {
			request.current?.abort();
			navigation.dispose();
		},
		[navigation],
	);
	useEffect(() => {
		if (phase.kind !== "oauth-running") navigation.close();
	}, [phase.kind, navigation]);
	useEffect(() => {
		if (!storageKey || !store.ready || !catalog.data || loaded.current) return;
		loaded.current = true;
		const ref = store.aStr(["inference", "workloads", "memoryExtraction", "target"]) || "background/default";
		const [targetId, modelId] = ref.split("/");
		const base = ["inference", "targets", targetId ?? "background"];
		const configuredProvider = store.aStr([...base, "executor"]);
		if (configuredProvider === "openai-compatible" || catalog.data.providers.includes(configuredProvider)) {
			setProvider(configuredProvider);
			const accountId = store.aStr([...base, "account"]) || configuredProvider;
			setAccount(accountId);
			setModel(store.aStr([...base, "models", modelId ?? "default", "model"]));
			setEndpoint(store.aStr([...base, "endpoint"]) || "http://127.0.0.1:1234/v1");
			setConnected(
				Boolean(store.aStr(["inference", "accounts", accountId, "credentialRef"])) ||
					catalog.data.oauthProviders.some((p) => p.id === configuredProvider && p.connected),
			);
		}
		const configured = store.agent.harnesses;
		if (Array.isArray(configured)) setSelected(configured.filter((x): x is string => typeof x === "string"));
		try {
			const saved = JSON.parse(localStorage.getItem(storageKey) ?? "null");
			if (saved && Number.isInteger(saved.step) && saved.step >= 0 && saved.step < STEPS.length) {
				// Recheck connection after reopening; a UI checkpoint is not runtime readiness.
				setStep(Math.min(saved.step, 2));
				if (typeof saved.memory === "string") setMemory(saved.memory.slice(0, 240));
				if (typeof saved.memoryId === "string") setMemoryId(saved.memoryId);
				if (typeof saved.memoryKey === "string") memoryKey.current = saved.memoryKey;
			}
		} catch {
			/* A missing UI checkpoint never changes the workspace. */
		}
	}, [storageKey, store.ready, store.agent, store.aStr, catalog.data]);
	useEffect(() => {
		if (!storageKey || !loaded.current) return;
		try {
			localStorage.setItem(storageKey, JSON.stringify({ step, memory, memoryId, memoryKey: memoryKey.current }));
		} catch {
			/* Onboarding also works when browser storage is unavailable. */
		}
	}, [storageKey, step, memory, memoryId]);

	const perform = async (work: (signal: AbortSignal) => Promise<void>) => {
		if (busy) return;
		const abort = new AbortController();
		request.current = abort;
		setBusy(true);
		setError(null);
		try {
			await work(AbortSignal.any([abort.signal, AbortSignal.timeout(60_000)]));
		} catch (error) {
			if (!abort.signal.aborted) setError(error instanceof Error ? error.message : "Could not finish. Please retry.");
		} finally {
			if (!abort.signal.aborted) setBusy(false);
			request.current = null;
		}
	};
	const chooseProvider = (id: string) => {
		controller.reset();
		setProvider(id);
		setAccount(id);
		setVerified(false);
		setError(null);
		setConnected(catalog.data?.oauthProviders.some((p) => p.id === id && p.connected) ?? false);
		setModel(catalog.data?.recommendedModels?.[id] ?? "");
		setKey("");
	};
	const configureModel = async () => {
		if (!model.trim()) throw new Error("Choose a model before testing.");
		if (local) {
			const url = new URL(endpoint);
			if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Use an http(s) model endpoint.");
			if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
				throw new Error("Use a loopback address for local processing. Remote gateways can be configured in Settings.");
		}
		const ref = store.aStr(["inference", "workloads", "memoryExtraction", "target"]) || "background/default";
		const [targetId, modelId] = ref.split("/");
		if (!targetId || !modelId) throw new Error("The memory route is invalid. Repair it in Settings before continuing.");
		const target = ["inference", "targets", targetId];
		store.aSetStr([...target, "executor"], provider);
		store.aDel([...target, "acpx"]);
		store.aSetStr([...target, "models", modelId, "model"], model.trim());
		if (local) {
			store.aSetStr([...target, "endpoint"], endpoint);
			store.aDel([...target, "account"]);
		} else {
			store.aSetStr([...target, "account"], account || provider);
			store.aDel([...target, "endpoint"]);
		}
		store.aSetStr(["inference", "workloads", "memoryExtraction", "target"], ref);
		store.aUpdate(ensureInferenceRoute);
		if (!local) store.aUpdate(allowRemoteMemoryExtraction);
		if (!(await store.save()))
			throw new Error("Could not save the model settings. Your previous connection test is no longer valid.");
	};
	const advance = () => {
		if (step === 0) {
			setStep(1);
			return;
		}
		if (step === 1) {
			void perform(async (signal) => {
				for (const id of selected.filter((id) => DIRECT_AGENTS.has(id))) {
					const result = await getJSONResult<{ success: boolean }>(`/api/harnesses/${encodeURIComponent(id)}/connect`, {
						method: "POST",
						signal,
					});
					if (!result.data?.success) throw new Error(result.error ?? `Could not connect ${id}. Retry to repair it.`);
				}
				store.aUpdate((draft) => {
					draft.harnesses = selected;
				});
				if (!(await store.save()))
					throw new Error("Integrations were installed, but the selection could not be saved. Retry to finish.");
				setStep(2);
			});
			return;
		}
		if (step === 2) {
			if (verified) {
				setStep(3);
				return;
			}
			if (!local && !connected) {
				if (oauth) {
					if (!navigation.open()) setError("Allow the sign-in popup, then try again.");
					else controller.startOAuth();
				} else
					void perform(async (signal) => {
						const name = providerKeySecretName(provider);
						const result = await api.putSecret(name, key.trim(), signal);
						if (!result.ok) throw new Error(result.error ?? "Could not save the key.");
						setKey("");
						await persistAccount(name);
					});
				return;
			}
			void perform(async (signal) => {
				if (oauth && !store.aStr(["inference", "accounts", account || provider, "providerFamily"]))
					await persistAccount();
				signal.throwIfAborted();
				await configureModel();
				signal.throwIfAborted();
				const probe = await api.executeInferenceProbe(
					{
						operation: "memory_extraction",
						prompt: "Respond with exactly OK.",
						maxTokens: 8,
						timeoutMs: 15_000,
						refresh: true,
					},
					signal,
				);
				signal.throwIfAborted();
				if (!probe?.text.trim() || !probe.attempts.some((a) => a.ok))
					throw new Error("The model did not answer. Check the connection and try again.");
				store.aSetBool(["memory", "pipelineV2", "enabled"], true);
				store.aSetBool(["memory", "pipelineV2", "paused"], true);
				if (!(await store.save()))
					throw new Error("The test passed, but memory settings could not be saved. Retry to finish.");
				signal.throwIfAborted();
				const result = await getJSONResult<{ success: boolean; mode: string }>("/api/pipeline/resume", {
					method: "POST",
					signal,
				});
				if (!result.data?.success || result.data.mode !== "controlled-write")
					throw new Error(
						result.error ??
							"Memory is still paused, frozen, or in shadow mode. Review its controls in Settings before retrying.",
					);
				setVerified(true);
			});
			return;
		}
		if (step === 3) {
			setSourceKind(null);
			setStep(4);
			return;
		}
		if (step === 4) {
			if (recalled) {
				setStep(5);
				return;
			}
			void perform(async (signal) => {
				const agentId = status.data?.agentId;
				if (!agentId) throw new Error("Could not resolve the active agent. Reopen setup.");
				if (!memoryId) {
					const result = await getJSONResult<{ id: string }>("/api/memory/remember", {
						method: "POST",
						signal,
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							content: memory.trim(),
							agentId,
							who: "user",
							sourceType: "manual",
							tags: ["onboarding"],
							visibility: "private",
							idempotencyKey: memoryKey.current,
						}),
					});
					if (!result.data?.id) throw new Error(result.error ?? "Your memory could not be saved. Retry safely.");
					setMemoryId(result.data.id);
				} else {
					const query = new URLSearchParams({ q: memory, agentId, limit: "20" });
					const result = await getJSONResult<{ results: Memory[] }>(`/memory/search?${query}`, { signal });
					const match = result.data?.results.find((row) => row.id === memoryId);
					if (!match)
						throw new Error(
							result.error ??
								"Your memory was saved but has not appeared in recall yet. Try again shortly, or inspect it in Memory.",
						);
					setRecalled(match);
				}
			});
			return;
		}
		onClose();
	};
	const blocked = busy || sourceBusy || phase.kind === "oauth-running" || phase.kind === "saving";
	const close = () => {
		if (!busy && !sourceBusy) {
			controller.cancelOAuth();
			onClose();
		}
	};
	const heading = (over: string, title: string, description: string) => (
		<>
			<div className="eyebrow">{over}</div>
			<Dialog.Title asChild>
				<h1>{title}</h1>
			</Dialog.Title>
			<Dialog.Description asChild>
				<p>{description}</p>
			</Dialog.Description>
		</>
	);
	let label = [
		"Get started",
		selected.length ? "Connect agents" : "Continue",
		"Continue",
		"Continue",
		memoryId ? (recalled ? "Continue" : "Recall it") : "Remember this",
		"Open Signet",
	][step];
	if (step === 2 && !verified)
		label = !provider
			? "Choose a connection"
			: local || connected
				? "Test and enable memory"
				: oauth
					? `Sign in with ${providerName}`
					: "Save API key";

	return (
		<Dialog.Root
			open
			onOpenChange={(open) => {
				if (!open) close();
			}}
		>
			<Dialog.Portal>
				<Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-[2px]" />
				<Dialog.Content
					className="onboarding"
					onEscapeKeyDown={(e) => {
						if (busy || sourceBusy) e.preventDefault();
					}}
					onInteractOutside={(e) => e.preventDefault()}
				>
					<section className="modal" style={{ zIndex: 51 }}>
						<header className="top">
							<div className="wordmark">
								<span aria-hidden="true">⠿</span>signet
							</div>
							<button
								type="button"
								className="close"
								aria-label="Close onboarding"
								onClick={close}
								disabled={busy || sourceBusy}
							>
								×
							</button>
						</header>
						<div className="body">
							{!store.ready || !status.data || !catalog.data ? (
								<>
									{heading(
										"Getting ready",
										"Opening your workspace…",
										"Loading your settings and available connections.",
									)}
									<div role="alert">
										{store.error ??
											(status.loading || catalog.loading
												? ""
												: "Could not load the daemon or provider catalog. Retry when Signet is available.")}
									</div>
									<button
										type="button"
										className="muted-link"
										onClick={() => {
											void store.reload();
											void status.refresh();
											void catalog.refresh();
										}}
									>
										Retry
									</button>
								</>
							) : (
								<div className="scene" key={step}>
									{step === 0 && (
										<>
											<div className="hero" aria-hidden="true">
												<div className="app-icon claude">✳︎</div>
												<span className="thread" />
												<div className="memory-node">⠿</div>
												<span className="thread" />
												<div className="app-icon codex">⌘</div>
											</div>
											{heading(
												"A familiar starting point",
												"Your agents should remember you.",
												"Keep your preferences, decisions, and context with you — even when the conversation or the agent changes.",
											)}
											<div className="memory-note">Remember once. Pick up anywhere.</div>
										</>
									)}
									{step === 1 && (
										<>
											{heading(
												"01 / Your agents",
												"Where do you work?",
												"Choose the agents to connect on the machine running Signet. Your existing instructions stay yours.",
											)}
											<div className="choices">
												{harnesses.data?.data?.harnesses
													.filter((h) => DIRECT_AGENTS.has(h.id))
													.map((h) => (
														<button
															type="button"
															key={h.id}
															className={`choice ${selected.includes(h.id) ? "selected" : ""}`}
															aria-pressed={selected.includes(h.id)}
															disabled={busy}
															onClick={() =>
																setSelected((ids) =>
																	ids.includes(h.id) ? ids.filter((id) => id !== h.id) : [...ids, h.id],
																)
															}
														>
															<span className="app-icon">
																{h.id === "claude-code" ? "✳︎" : h.id === "codex" ? "⌘" : "↗"}
															</span>
															<span>
																<strong>{h.name}</strong>
																<small>{h.exists ? "Detected on this machine" : "Install Signet integration"}</small>
															</span>
															<span className="tick">{selected.includes(h.id) ? "✓" : ""}</span>
														</button>
													))}
											</div>
											{harnesses.data?.error && (
												<div role="alert">
													{harnesses.data.error}
													<button type="button" onClick={() => void harnesses.refresh()}>
														Retry
													</button>
												</div>
											)}
											<p className="fixture">
												Other agents remain available through the CLI. No selection? You can connect one later.
											</p>
										</>
									)}
									{step === 2 && (
										<>
											{heading(
												"02 / Your connection",
												"Give memory a little intelligence.",
												"Choose what helps Signet organize memory. Use an existing subscription or a model on your machine.",
											)}
											{!provider ? (
												<div className="choices">
													{["openai-codex", "anthropic", "openai-compatible"]
														.filter((id) => id === "openai-compatible" || catalog.data?.providers.includes(id))
														.map((id) => (
															<button type="button" className="choice" key={id} onClick={() => chooseProvider(id)}>
																<span className="app-icon">
																	{id === "openai-compatible" ? "⌂" : id === "anthropic" ? "✳︎" : "◎"}
																</span>
																<span>
																	<strong>{id === "openai-compatible" ? "Local model" : PROVIDER_NAMES[id]}</strong>
																	<small>
																		{id === "openai-compatible"
																			? "Process on your own machine"
																			: "Connect your account"}
																	</small>
																</span>
															</button>
														))}
													<select aria-label="Other provider" value="" onChange={(e) => chooseProvider(e.target.value)}>
														<option value="">Another provider…</option>
														{catalog.data.providers.map((id) => (
															<option key={id} value={id}>
																{PROVIDER_NAMES[id] ?? id}
															</option>
														))}
													</select>
												</div>
											) : (
												<div className="auth-card">
													<strong>{providerName}</strong>
													<div className="status">
														{verified
															? "Connection checked. Automatic memory started."
															: connected
																? "Sign-in saved. Test the model before enabling memory."
																: local
																	? "Your model server runs on the same machine as Signet."
																	: "Relevant text will be sent to this provider to organize memory. Original evidence stays in your workspace."}
													</div>
													{!local && !oauth && !connected && (
														<input
															className="memory-input"
															type="password"
															aria-label="Provider API key"
															value={key}
															onChange={(e) => setKey(e.target.value)}
															autoComplete="off"
														/>
													)}
													{(local || connected) && !verified && (
														<details open={local}>
															<summary className="muted-link">{model ? `Model: ${model}` : "Choose a model"}</summary>
															{local ? (
																<>
																	<input
																		className="memory-input"
																		aria-label="Model endpoint"
																		value={endpoint}
																		onChange={(e) => setEndpoint(e.target.value)}
																	/>
																	<input
																		className="memory-input"
																		aria-label="Model name"
																		value={model}
																		placeholder="Model name from your server"
																		onChange={(e) => setModel(e.target.value)}
																	/>
																</>
															) : (
																<select
																	aria-label="Memory model"
																	value={model}
																	onChange={(e) => setModel(e.target.value)}
																>
																	<option value="">Choose a model…</option>
																	{catalog.data.models[provider]?.map((m) => (
																		<option key={m.id} value={m.id}>
																			{m.name}
																		</option>
																	))}
																</select>
															)}
														</details>
													)}
													{phase.kind === "oauth-running" && (
														<div className="status" role="status">
															{phase.progress ?? "Finish signing in in your browser."}
															{safeOAuthHref(phase.url) && (
																<a href={safeOAuthHref(phase.url) ?? undefined} target="_blank" rel="noreferrer">
																	{" "}
																	Open sign-in page
																</a>
															)}
															{phase.deviceCode && (
																<>
																	<p>{phase.deviceCode.userCode}</p>
																	<a
																		href={safeOAuthHref(phase.deviceCode.verificationUri) ?? undefined}
																		target="_blank"
																		rel="noreferrer"
																	>
																		Open verification page
																	</a>
																</>
															)}
															{phase.prompt && (
																<div>
																	<label htmlFor="onboarding-response">{phase.prompt.message}</label>
																	{phase.prompt.kind === "select" ? (
																		<div className="choices">
																			{phase.prompt.options?.map((o) => (
																				<button
																					type="button"
																					className="choice"
																					key={o.id}
																					onClick={() => void controller.answerPrompt(o.id)}
																				>
																					{o.label}
																				</button>
																			))}
																		</div>
																	) : (
																		<>
																			<input
																				id="onboarding-response"
																				className="memory-input"
																				value={prompt}
																				onChange={(e) => setPrompt(e.target.value)}
																				autoComplete="off"
																			/>
																			<button
																				type="button"
																				className="muted-link"
																				onClick={() => {
																					void controller.answerPrompt(prompt);
																					setPrompt("");
																				}}
																			>
																				Send response
																			</button>
																		</>
																	)}
																</div>
															)}
															<button type="button" className="muted-link" onClick={controller.cancelOAuth}>
																Cancel sign-in
															</button>
														</div>
													)}
													{phase.kind === "error" && (
														<div className="failure" role="alert">
															{phase.message}
														</div>
													)}
													<button
														type="button"
														className="muted-link"
														disabled={blocked}
														onClick={() => chooseProvider("")}
													>
														Choose another connection
													</button>
													{!verified && (connected || local) && (
														<p className="fixture">
															The test sends a short prompt. Enabling memory allows background processing; provider
															charges may apply.
														</p>
													)}
												</div>
											)}
										</>
									)}
									{step === 3 && (
										<>
											{heading(
												"03 / Bring your context",
												"You’re not starting from zero.",
												"Bring the notes and conversations you want your agents to remember. You can add more sources anytime.",
											)}
											{sourceKind ? (
												<ConnectSourceDialog
													open
													embedded
													initialKind={sourceKind}
													onBusyChange={setSourceBusy}
													onClose={() => setSourceKind(null)}
													onConnected={() => {
														void sources.refresh();
														void imports.refresh();
													}}
												/>
											) : (
												<div className="choices">
													{[
														{ id: "obsidian", name: "Obsidian", description: "Connect a vault of notes" },
														{
															id: "transcripts",
															name: "Agent transcripts",
															description: "Bulk import conversation exports",
														},
														{
															id: "files",
															name: "Files and documents",
															description: "Bring your existing reference material",
														},
													].map((item) => (
														<button
															type="button"
															key={item.id}
															className="choice"
															onClick={() => {
																if (item.id === "obsidian" || item.id === "transcripts" || item.id === "files")
																	setSourceKind(item.id);
															}}
														>
															<span className="app-icon">
																{item.id === "obsidian" ? "◇" : item.id === "transcripts" ? "≋" : "▤"}
															</span>
															<span>
																<strong>{item.name}</strong>
																<small>{item.description}</small>
															</span>
														</button>
													))}
												</div>
											)}
											<div role="status" className="fixture">
												{sources.data
													? sources.data.sources.map((source) => (
															<div key={source.id}>
																{source.name}: {source.indexJob?.status ?? (source.enabled ? "registered" : "disabled")}
																{source.indexJob?.error && ` — ${source.indexJob.error}`}
																{(source.health?.failures?.total ?? 0) > 0 &&
																	` · ${source.health?.failures?.total} failures`}
															</div>
														))
													: "Source status is unavailable. Check Sources before retrying an import."}
												{imports.data?.error && <div>{imports.data.error}</div>}
												{imports.data?.data?.imports.map((job) => (
													<div key={job.id}>
														Transcript import: {job.state} · {job.imported ?? 0} imported · {job.rejected ?? 0} rejected
													</div>
												))}
											</div>
											<p className="fixture">
												Imports can continue in the background. Inspect progress, errors, or remove a source in Sources.
											</p>
										</>
									)}
									{step === 4 && (
										<>
											{heading(
												"04 / A first memory",
												"Try a little continuity.",
												"Tell Signet something useful. Then retrieve it through your workspace’s memory search.",
											)}
											<div className="chat">
												<div className="chat-label">{memoryId ? "A fresh recall" : "Something worth remembering"}</div>
												{!memoryId ? (
													<>
														<input
															className="memory-input"
															aria-label="Your first memory"
															value={memory}
															maxLength={240}
															onChange={(e) => setMemory(e.target.value)}
														/>
														<p className="fixture">
															This saves a real, private memory for {status.data.agentId}. You can inspect or delete it
															in Memory.
														</p>
													</>
												) : (
													<>
														<div className="status">Your memory was saved.</div>
														{recalled && (
															<>
																<div className="bubble">{recalled.content}</div>
																<div className="fixture">
																	Retrieved from the memory you saved. Your next agent conversation is a separate
																	integration check.
																</div>
															</>
														)}
													</>
												)}
											</div>
										</>
									)}
									{step === 5 && (
										<>
											<div className="ready-art">
												<span>✓</span>
											</div>
											{heading(
												"Ready for your next conversation",
												"Start somewhere familiar.",
												"Open a new conversation in your agent and ask it to recall your preference.",
											)}
											<div className="receipt">
												✓{" "}
												{selected.length
													? `${selected.length} agent integrations selected`
													: "Connect an agent when you’re ready"}
											</div>
											<div className="receipt">✓ {providerName} answered the connection test</div>
											<div className="receipt">✓ Your first memory was saved and recalled</div>
											<p className="fixture">
												Source imports may still be processing. Sources has their current status.
											</p>
										</>
									)}
								</div>
							)}
							{(error || store.error) && (
								<div className="failure" role="alert">
									{error ?? store.error}
								</div>
							)}
						</div>
						<footer className="footer">
							<div className="footer-left">
								<button
									type="button"
									className="back"
									style={{ visibility: step ? "visible" : "hidden" }}
									disabled={blocked}
									onClick={() => {
										setError(null);
										setStep((n) => n - 1);
									}}
								>
									Back
								</button>
								<div className="dots" role="img" aria-label={`Step ${step + 1} of ${STEPS.length}`}>
									{STEPS.map((s, i) => (
										<span key={s} className={`dot ${step === i ? "active" : ""}`} />
									))}
								</div>
							</div>
							<button
								type="button"
								className="primary"
								disabled={
									blocked ||
									!store.ready ||
									!status.data ||
									!catalog.data ||
									(step === 2 && (!provider || (!local && !oauth && !connected && !key.trim()))) ||
									(step === 4 && !memory.trim())
								}
								onClick={advance}
							>
								{busy ? "Working…" : label}
								<span aria-hidden="true">→</span>
							</button>
						</footer>
					</section>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

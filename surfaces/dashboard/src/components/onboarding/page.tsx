import { routeBlockedBy } from "@/lib/inference-errors";
import { EmbeddingStep, embeddingDraft, type EmbeddingDraft } from "./embedding-step";
import { writeEmbeddingEndpoint } from "@/lib/embedding-config";
import { IdentityStep, identityDraft, identityContent, type IdentityDraft } from "./identity-step";
import {
	IDENTITY_FILES,
	IDENTITY_PRESETS,
	type IdentityPresetName,
} from "../../../../../platform/core/src/identity-spec";
import { Monitor, FileText as Files, MessageCircle as MessagesSquare } from "@/components/mingcute-icons";
import { SignetMark, sourceLogo } from "@/components/icons";
import { ConnectorLogo } from "@/components/connector-logo";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useEffect, useRef, useState } from "react";
import { api, getJSONResult, onboardingPreview, type Memory } from "@/lib/api";
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

const STEPS = [
	"Welcome",
	"How it works",
	"Identity",
	"Harnesses",
	"Connection",
	"Sources",
	"Search",
	"First memory",
	"Summary",
];

function MemoryArtwork({ stage }: { stage: number }) {
	return (
		<div className="memory-artwork" data-stage={stage} aria-hidden="true">
			<div className="hero">
				<div className="memory-plane plane-back" />
				<div className="memory-plane plane-middle" />
				<div className="memory-plane plane-front" />
				<span className="memory-signal" />
			</div>
			{stage > 0 && (
				<span className="artwork-caption">
					{
						[
							"",
							"One memory. Across your agents.",
							"A little intelligence. Lasting context.",
							"Your work, connected.",
							"Find meaning. Not just words.",
							"Memory that grows with you.",
							"Save it once. Recall it later.",
							"A more memorable you.",
						][stage]
					}
				</span>
			)}
		</div>
	);
}

export function OnboardingPage({
	onClose,
	onCompleteChange,
}: {
	onClose: () => void;
	onCompleteChange?: (complete: boolean) => void;
}) {
	const store = useAgentConfig();
	const status = useAsync(() => api.getStatus(), { key: "status" });
	const catalog = useAsync(() => api.getInferenceCatalog(), { key: "inference-catalog" });
	const harnesses = useAsync(() => api.getHarnesses(), { key: "harnesses" });
	const [step, setStep] = useState(0);
	useEffect(() => {
		onCompleteChange?.(step === STEPS.length - 1);
	}, [step, onCompleteChange]);
	const identityFiles = useAsync(() => api.getConfigFiles());
	const [identity, setIdentity] = useState<IdentityDraft | null>(null);
	const [embedding, setEmbedding] = useState<EmbeddingDraft | null>(null);
	const [embeddingSaved, setEmbeddingSaved] = useState(false);
	const [embeddingStatus, setEmbeddingStatus] = useState<string | null>(null);
	useEffect(() => {
		if (store.ready && !embedding) setEmbedding(embeddingDraft(store));
	}, [store, embedding]);
	const [selected, setSelected] = useState<string[]>([]);
	const [provider, setProvider] = useState("");
	const [model, setModel] = useState("");
	const [account, setAccount] = useState("");
	const [endpoint, setEndpoint] = useState("http://127.0.0.1:1234/v1");
	const [key, setKey] = useState("");
	const [prompt, setPrompt] = useState("");
	const [connected, setConnected] = useState(false);
	const [verified, setVerified] = useState(false);
	const [dreamingEnabled, setDreamingEnabled] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [memory, setMemory] = useState("");
	const [memoryId, setMemoryId] = useState<string | null>(null);
	const [recalled, setRecalled] = useState<Memory | null>(null);
	const [sourceKind, setSourceKind] = useState<SourceKind | null>(null);
	const [sourceBusy, setSourceBusy] = useState(false);
	const sources = useAsync(() => api.getSources(), { key: "sources", intervalMs: 5000 });
	const imports = useAsync(() => api.getSourceImports(), { key: "source-imports", intervalMs: 5000 });
	const loaded = useRef(false);
	const memoryKey = useRef(crypto.randomUUID());
	const request = useRef<AbortController | null>(null);
	const storageKey =
		!onboardingPreview && status.data ? `signet:onboarding:${status.data.agentsDir}:${status.data.agentId}` : null;
	useEffect(() => {
		if (!store.ready || !identityFiles.data || identity) return;
		const configuredPreset = store.aStr(["identity", "preset"], "minimal");
		const preset: IdentityPresetName = Object.hasOwn(IDENTITY_PRESETS, configuredPreset)
			? (configuredPreset as IdentityPresetName)
			: "minimal";
		const draft = identityDraft(
			store.aStr(["agent", "name"]),
			preset,
			store.aStr(["capabilities", "identity", "mode"], "managed") !== "off",
			identityFiles.data,
		);
		const configured = store.agent.identity as
			| { startup?: { load?: { path: string }[] }; special?: { path: string }[] }
			| undefined;
		if (configured?.startup?.load)
			draft.selected = [...configured.startup.load, ...(configured.special ?? [])].map((entry) => entry.path);
		setIdentity(draft);
	}, [store.ready, identityFiles.data, identity, store.aStr, store.agent]);
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
		setDreamingEnabled(store.aBool(["memory", "dreaming", "enabled"], true));
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
			const restored =
				typeof saved?.step === "string"
					? STEPS.indexOf(saved.step)
					: Number.isInteger(saved?.step)
						? [0, 2, 3, 4, 5, 6, 1, 7, 8][saved.step]
						: -1;
			if (restored >= 0 && restored < STEPS.length) {
				setStep(Math.min(restored, 4));
				if (typeof saved.memory === "string") setMemory(saved.memory.slice(0, 240));
				if (typeof saved.memoryId === "string") setMemoryId(saved.memoryId);
				if (typeof saved.memoryKey === "string") memoryKey.current = saved.memoryKey;
			}
		} catch {}
	}, [storageKey, store.ready, store.agent, store.aBool, store.aStr, catalog.data]);
	useEffect(() => {
		if (!storageKey || !loaded.current) return;
		try {
			localStorage.setItem(
				storageKey,
				JSON.stringify({ step: STEPS[step], memory, memoryId, memoryKey: memoryKey.current }),
			);
		} catch {}
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
	const chooseDreaming = (enabled: boolean) => {
		setDreamingEnabled(enabled);
		store.aSetBool(["memory", "dreaming", "enabled"], enabled);
		void store.save().then((saved) => {
			if (!saved) setError("Could not save the Dreaming preference. Retry before leaving setup.");
		});
	};
	const deferConnection = async () => {
		controller.cancelOAuth();
		navigation.close();
		store.aSetBool(["memory", "dreaming", "enabled"], dreamingEnabled);
		if (!(await store.save())) {
			setError("Could not save the Dreaming preference. Retry before leaving setup.");
			return;
		}
		setError(null);
		setStep(5);
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
		store.aSetBool(["memory", "dreaming", "enabled"], dreamingEnabled);
		store.aUpdate(ensureInferenceRoute);
		if (!local) store.aUpdate(allowRemoteMemoryExtraction);
		if (!(await store.save()))
			throw new Error("Could not save the model settings. Your previous connection test is no longer valid.");
	};
	const signIn = () => {
		setConnected(false);
		setError(null);
		setVerified(false);
		navigation.open();
		controller.startOAuth();
	};
	const saveEmbedding = async (signal: AbortSignal) => {
		if (!embedding) throw new Error("Search settings are still loading.");
		if (embedding.provider !== "none") {
			if (
				!embedding.model.trim() ||
				!Number.isInteger(embedding.dimensions) ||
				embedding.dimensions < 1 ||
				embedding.dimensions > 65536
			)
				throw new Error("Enter a model and a vector size between 1 and 65,536.");
			if (embedding.provider !== "native") {
				const endpoint = new URL(embedding.endpoint);
				if (!["http:", "https:"].includes(endpoint.protocol)) throw new Error("Use an http(s) server address.");
			}
		}
		if (embedding.provider === "openai" && embedding.key.trim()) {
			const result = await api.putSecret("OPENAI_EMBEDDING_API_KEY", embedding.key.trim(), signal);
			if (!result.ok) throw new Error(result.error ?? "Could not store the embedding key.");
			store.aSetStr(["embedding", "api_key"], "$secret:OPENAI_EMBEDDING_API_KEY");
			setEmbedding((draft) => (draft ? { ...draft, key: "" } : draft));
		}
		signal.throwIfAborted();
		store.aSetStr(["embedding", "provider"], embedding.provider);
		if (embedding.provider !== "none") {
			store.aSetStr(["embedding", "model"], embedding.model.trim());
			store.aSetNum(["embedding", "dimensions"], embedding.dimensions);
			if (embedding.provider !== "native") writeEmbeddingEndpoint(store, ["embedding"], embedding.endpoint.trim());
		}
		if (!(await store.save())) throw new Error("Could not save search settings. Retry to finish.");
		signal.throwIfAborted();
		setEmbeddingSaved(true);
	};
	const checkEmbedding = () =>
		void perform(async (signal) => {
			await saveEmbedding(signal);
			const result = await getJSONResult<{
				provider: string;
				model: string;
				available: boolean;
				error?: string;
				index?: { staging?: unknown };
			}>("/api/embeddings/status", { signal });
			if (!result.data) {
				setEmbeddingStatus(`Settings saved. Availability check: ${result.error ?? "could not reach the daemon"}`);
				return;
			}
			const status = result.data;
			setEmbeddingStatus(
				status.provider !== embedding?.provider || status.model !== embedding?.model || status.index?.staging
					? "Settings saved. The search index is transitioning; the previous model may still be in use."
					: status.available && !status.error
						? "The embedding provider is available. Indexing may continue in the background."
						: `Settings saved. ${status.error ?? "The embedding provider is not ready yet."}`,
			);
		});
	const advance = () => {
		if (step === 0) {
			setStep(1);
			return;
		}
		if (step === 2) {
			if (!identity?.name.trim()) return;
			void perform(async (signal) => {
				if (identity.managed) {
					for (const file of identity.selected.filter((path) => path !== "MEMORY.md")) {
						signal.throwIfAborted();
						if (
							!Object.values(IDENTITY_FILES).some((entry) => entry.path === file) &&
							identity.contents[file] === undefined
						)
							continue;
						const content = identityContent(identity, file);
						if (identityFiles.data?.find((entry) => entry.name === file)?.content === content) continue;
						const result = await api.saveConfigFile(file, content);
						if (!result.ok)
							throw new Error(
								`Could not save ${file}: ${result.error ?? "save failed"}. Earlier files may have been saved; retry to finish.`,
							);
					}
				}
				signal.throwIfAborted();
				store.aUpdate((draft) => {
					const agent =
						typeof draft.agent === "object" && draft.agent !== null ? (draft.agent as Record<string, unknown>) : {};
					draft.agent = { ...agent, name: identity.name.trim() };
				});
				store.aSetStr(["capabilities", "identity", "mode"], identity.managed ? "managed" : "off");
				if (identity.managed) {
					const preset = IDENTITY_PRESETS[identity.preset];
					const known = Object.values(IDENTITY_PRESETS).flatMap((entry) => [...entry.startup, ...entry.special]);
					const existing = store.agent.identity as
						| { startup?: { load?: { path: string }[] }; special?: { path: string }[] }
						| undefined;
					const prior =
						identity.preset === "custom" ? [...(existing?.startup?.load ?? []), ...(existing?.special ?? [])] : [];
					const specs = identity.selected.map((path) =>
						structuredClone(
							[...prior, ...preset.startup, ...preset.special, ...known].find((entry) => entry.path === path) ?? {
								path,
							},
						),
					);
					store.aUpdate((draft) => {
						draft.identity = {
							...existing,
							preset: identity.preset,
							startup: { ...existing?.startup, load: specs.filter((entry) => !("kind" in entry)) },
							special: specs.filter((entry) => "kind" in entry),
						};
					});
				}
				if (!(await store.save()))
					throw new Error("Identity files were saved, but agent settings could not be saved. Retry to finish.");
				setStep(3);
			});
			return;
		}
		if (step === 3) {
			void perform(async (signal) => {
				for (const id of selected) {
					const result = await api.connectHarness(id, signal);
					if (!result.data?.success) throw new Error(result.error ?? `Could not connect ${id}. Retry to repair it.`);
				}
				store.aUpdate((draft) => {
					draft.harnesses = selected;
				});
				if (!(await store.save()))
					throw new Error("Integrations were installed, but the selection could not be saved. Retry to finish.");
				setStep(4);
			});
			return;
		}
		if (step === 4) {
			if (verified) {
				setStep(5);
				return;
			}
			if (!local && !connected) {
				if (oauth) {
					signIn();
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
				if (probe.error) {
					const reasons = routeBlockedBy(probe.details);
					throw new Error(reasons.length ? `${probe.error}: ${reasons.join("; ")}` : probe.error);
				}
				if (!probe.data?.text.trim() || !probe.data.attempts.some((a) => a.ok))
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
				store.aSetBool(["memory", "pipelineV2", "paused"], false);
				setVerified(true);
			});
			return;
		}
		if (step === 5) {
			setSourceKind(null);
			setStep(6);
			return;
		}
		if (step === 6) {
			void perform(async (signal) => {
				await saveEmbedding(signal);
				setStep(7);
			});
			return;
		}
		if (step === 1) {
			setStep(2);
			return;
		}
		if (step === 7) {
			if (recalled) {
				setStep(8);
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
					const query = new URLSearchParams({ q: memory.trim(), agentId, limit: "20" });
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
	const blocked = busy || sourceBusy || store.saving || phase.kind === "oauth-running" || phase.kind === "saving";
	const heading = (over: string, title: string, description: string) => (
		<div className="step-intro">
			<div className="eyebrow">{over}</div>
			<h1>{title}</h1>
			<p>{description}</p>
			{step !== 0 && step !== 2 && <MemoryArtwork stage={[0, 5, 0, 1, 2, 3, 4, 6, 7][step]} />}
		</div>
	);
	let label = [
		"Get started",
		"Continue",
		"Save identity",
		selected.length ? "Connect agents" : "Continue",
		"Continue",
		"Continue",
		"Save search settings",
		memoryId ? (recalled ? "Continue" : "Recall it") : "Remember this",
		"Open Signet",
	][step];
	if (step === 4 && !verified)
		label = !provider
			? "Choose a connection"
			: local || connected
				? "Test and enable memory"
				: oauth
					? `Sign in with ${providerName}`
					: "Save API key";

	return (
		<section className="onboarding" aria-label="Set up Signet">
			<div className="onboarding-page">
				<header className="top">
					<div className="wordmark">
						<SignetMark width={26} height={28} />
						Signet
					</div>
					<ol className="step-trail" aria-label="Setup progress">
						{STEPS.map((name, index) => (
							<li key={name} aria-current={index === step ? "step" : undefined} data-complete={index < step}>
								<span className="step-number">{index < step ? "✓" : String(index + 1).padStart(2, "0")}</span>
								<span>{name}</span>
							</li>
						))}
					</ol>
				</header>
				<div className="body">
					{!store.ready || !status.data || !catalog.data ? (
						<>
							{heading("Getting ready", "Opening your workspace…", "Loading your settings and available connections.")}
							<div className="failure" role="alert">
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
						<div className="scene" data-step={step} key={step}>
							{step === 0 && (
								<>
									<div className="welcome-copy">
										{heading(
											`01 / ${String(STEPS.length).padStart(2, "0")}`,
											"Your agents should remember you.",
											"Keep your preferences, decisions, and context with you — even when the conversation or the agent changes.",
										)}
										<div className="memory-note">
											A more
											<br />
											memorable you.
										</div>
									</div>
									<MemoryArtwork stage={0} />
								</>
							)}
							{step === 2 && (
								<>
									{heading(
										"03 / Your agent",
										"Create your first agent.",
										"Your default agent’s memory and identity live in Signet, across connected tools. Identity files are added to their system prompts to set your agent’s rules, behavior, and what it knows about you.",
									)}
									{identity ? (
										<IdentityStep value={identity} onChange={setIdentity} disabled={blocked} />
									) : (
										<p role="status">Loading identity files…</p>
									)}
									{identityFiles.error && (
										<div className="failure" role="alert">
											{identityFiles.error}
											<button type="button" className="muted-link" onClick={() => void identityFiles.refresh()}>
												Retry
											</button>
										</div>
									)}
								</>
							)}
							{step === 3 && (
								<>
									{heading(
										"04 / Your harnesses",
										"Where do you work?",
										"Choose the agents to connect on the machine running Signet. Your existing instructions stay yours.",
									)}
									<div className="choices agent-choices">
										{harnesses.data?.data?.harnesses.map((h) => (
											<button
												type="button"
												key={h.id}
												className={`choice ${selected.includes(h.id) ? "selected" : ""}`}
												aria-pressed={selected.includes(h.id)}
												disabled={busy}
												onClick={() =>
													setSelected((ids) => (ids.includes(h.id) ? ids.filter((id) => id !== h.id) : [...ids, h.id]))
												}
											>
												<span className="app-icon">
													<ConnectorLogo icon={h.icon} />
												</span>
												<span>
													<strong>{h.name}</strong>
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
									<p className="fixture">Select the tools you use. You can connect more later.</p>
								</>
							)}
							{step === 4 && (
								<>
									{heading(
										"05 / Your connection",
										"How should memory run?",
										"Connect an AI provider to organize your memories. Use your subscription, an API key, or a local model.",
									)}
									{!provider ? (
										<div className="choices connection-choices">
											{["openai-codex", "anthropic", "openai-compatible"]
												.filter((id) => id === "openai-compatible" || catalog.data?.providers.includes(id))
												.map((id) => (
													<button type="button" className="choice" key={id} onClick={() => chooseProvider(id)}>
														<span className="app-icon">
															{id === "openai-compatible" ? (
																<Monitor size={24} />
															) : (
																<img src={`/logos/${id === "anthropic" ? "claude" : "openai"}.svg`} alt="" />
															)}
														</span>
														<span>
															<strong>{id === "openai-compatible" ? "Local model" : PROVIDER_NAMES[id]}</strong>
															<small>
																{id === "openai-compatible"
																	? "Use Ollama, LM Studio, or another local server"
																	: "Sign in with your subscription"}
															</small>
														</span>
													</button>
												))}
											<div className="other-provider">
												<label htmlFor="onboarding-provider">Use another provider</label>
												<Select value="" onValueChange={chooseProvider}>
													<SelectTrigger id="onboarding-provider" aria-label="Other provider" className="w-full">
														<SelectValue placeholder="Choose a provider…" />
													</SelectTrigger>
													<SelectContent
														position="popper"
														align="start"
														className="z-[60] max-h-64 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
													>
														{catalog.data.providers.map((id) => (
															<SelectItem key={id} value={id}>
																{PROVIDER_NAMES[id] ?? id}
															</SelectItem>
														))}
													</SelectContent>
												</Select>
											</div>
										</div>
									) : (
										<div className="auth-card">
											<div className="connection-heading">
												{local ? (
													<Monitor size={24} />
												) : ["openai-codex", "openai", "anthropic"].includes(provider) ? (
													<img
														src={`/logos/${provider === "anthropic" ? "claude" : "openai"}.svg`}
														alt=""
														width={24}
														height={24}
													/>
												) : null}
												<strong>{providerName}</strong>
												<button
													type="button"
													className="muted-link change-connection"
													disabled={blocked}
													onClick={() => chooseProvider("")}
												>
													Change
												</button>
											</div>
											{!local && oauth && !connected && phase.kind !== "oauth-running" && (
												<div className="connection-instruction">
													<strong>Sign in to connect your account.</strong>
													<p>We’ll open your browser. After signing in, return here to choose a model.</p>
												</div>
											)}
											<div className="status">
												{verified
													? "Connection checked. Automatic memory started."
													: connected
														? "Saved credentials found. Test them, or sign in again below."
														: local
															? "Your model server runs on the same machine as Signet."
															: "Relevant text will be sent to this provider to organize memory. Original evidence stays in your workspace."}
											</div>
											{oauth && connected && !blocked && (
												<button type="button" className="muted-link" onClick={signIn}>
													Sign in again
												</button>
											)}
											{!local && !oauth && connected && !blocked && (
												<button
													type="button"
													className="muted-link"
													onClick={() => {
														setConnected(false);
														setVerified(false);
													}}
												>
													Replace API key
												</button>
											)}
											{!local && !oauth && !connected && (
												<div className="connection-field">
													<label htmlFor="onboarding-api-key">API key</label>
													<input
														id="onboarding-api-key"
														className="memory-input"
														type="password"
														aria-label="Provider API key"
														value={key}
														onChange={(e) => setKey(e.target.value)}
														autoComplete="off"
													/>
												</div>
											)}
											{(local || connected) && !verified && (
												<div className="model-field">
													<label htmlFor={local ? "onboarding-endpoint" : "onboarding-memory-model"}>
														{local ? "Server address" : "Memory model"}
													</label>
													{local ? (
														<>
															<input
																className="memory-input"
																id="onboarding-endpoint"
																aria-label="Model endpoint"
																value={endpoint}
																onChange={(e) => setEndpoint(e.target.value)}
															/>
															<label htmlFor="onboarding-model">Model name</label>
															<input
																className="memory-input"
																id="onboarding-model"
																aria-label="Model name"
																value={model}
																placeholder="Model name from your server"
																onChange={(e) => setModel(e.target.value)}
															/>
														</>
													) : (
														<Select value={model} onValueChange={setModel}>
															<SelectTrigger id="onboarding-memory-model" aria-label="Memory model" className="w-full">
																<SelectValue placeholder="Choose a model…" />
															</SelectTrigger>
															<SelectContent
																position="popper"
																align="start"
																className="z-[60] max-h-64 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
															>
																{catalog.data.models[provider]?.map((m) => (
																	<SelectItem key={m.id} value={m.id}>
																		{m.name}
																	</SelectItem>
																))}
															</SelectContent>
														</Select>
													)}
												</div>
											)}
											{phase.kind === "oauth-running" && (
												<div className="status" role="status">
													{phase.progress ??
														(phase.prompt
															? ""
															: phase.url || phase.deviceCode
																? "Finish signing in in your browser."
																: "Opening sign-in…")}
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

											{!verified && (connected || local) && (
												<p className="fixture">
													The test sends a short prompt. Enabling memory allows background processing; provider charges
													may apply.
												</p>
											)}
										</div>
									)}
								</>
							)}
							{step === 4 && (
								<div className="dreaming-choice">
									<div>
										<strong>Dreaming</strong>
										<p id="dreaming-provider-status">
											{dreamingEnabled
												? verified
													? "On. Your connection is ready."
													: "Organizes memory in the background. Starts after your connection passes its test."
												: "Off. You can enable it later in Settings."}
										</p>
									</div>
									<Switch
										checked={dreamingEnabled}
										disabled={busy || store.saving}
										onCheckedChange={chooseDreaming}
										aria-label="Enable Dreaming?"
										aria-describedby="dreaming-provider-status"
									/>
								</div>
							)}
							{step === 5 && (
								<>
									{heading(
										"06 / Bring your context",
										sourceKind ? "Bring your context." : "You’re not starting from zero.",
										sourceKind
											? "Connect your source. Add more anytime."
											: "Bring the notes and conversations you want your agents to remember.",
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
														{item.id === "transcripts" ? (
															<MessagesSquare size={22} />
														) : item.id === "files" ? (
															<Files size={22} />
														) : (
															sourceLogo(item.id, { width: 24, height: 24 })
														)}
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
											? sources.data.sources.slice(-2).map((source) => (
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
							{step === 6 && (
								<>
									{heading(
										"07 / Search by meaning",
										"Find it, even in different words.",
										"Embeddings help Signet find related memories by meaning, not just matching words. They power search and recall; they don’t write or change your memories.",
									)}
									{embedding && (
										<EmbeddingStep
											value={embedding}
											onChange={(draft) => {
												setEmbedding(draft);
												setEmbeddingSaved(false);
												setEmbeddingStatus(null);
											}}
											disabled={blocked}
											hasKey={Boolean(store.aStr(["embedding", "api_key"]))}
										/>
									)}
									{embedding?.provider !== "none" && (
										<button
											type="button"
											className="muted-link"
											disabled={blocked || !embedding}
											onClick={checkEmbedding}
										>
											Save and check availability
										</button>
									)}
									{embeddingStatus && (
										<p className="fixture" role="status">
											{embeddingStatus}
										</p>
									)}
								</>
							)}
							{step === 1 && (
								<>
									{heading(
										"02 / Memory in the background",
										"Your context keeps growing.",
										"Signet keeps memory and identity with your agent as you move between tools. Here’s what happens as you work.",
									)}
									<div className="setup-details">
										<div>
											<strong>Capture your context</strong>
											<p>
												Supported integrations capture conversations and provide memory tools. Connected sources bring
												in your notes and documents. What happens automatically depends on the tool you connect.
											</p>
										</div>
										<div>
											<strong>Recall what matters</strong>
											<p>
												Connected tools can receive relevant memories and your identity instructions. You can inspect
												remembered context and where it came from in Memory.
											</p>
										</div>
										<div>
											<strong>Let Dreaming maintain it</strong>
											<p>
												Dreaming works through evidence, connects related knowledge, and revisits contradictions.
												Changes remain traceable to their sources; the original evidence stays intact.
											</p>
											<span className="setup-state">You’ll choose whether to enable Dreaming during setup.</span>
										</div>
									</div>
								</>
							)}
							{step === 7 && (
								<>
									{heading(
										"08 / A first memory",
										"What should your agents know about you?",
										"A preference, a project, or how you like to work. Start with one thing you’d rather not explain again.",
									)}
									<div className="chat">
										{!memoryId ? (
											<>
												<input
													className="memory-input first-memory"
													placeholder="What’s one thing worth remembering?"
													aria-label="Your first memory"
													value={memory}
													maxLength={240}
													onChange={(e) => setMemory(e.target.value)}
												/>
												<div className="memory-examples">
													{[
														["How I like answers", "I prefer short answers with concrete examples."],
														["How I work", "Explain the tradeoffs before recommending an approach."],
													].map(([label, value]) => (
														<button
															type="button"
															key={label}
															onClick={() => {
																setMemory(value ?? "");
																document.querySelector<HTMLInputElement>('[aria-label="Your first memory"]')?.focus();
															}}
														>
															{label}
														</button>
													))}
												</div>
												<p className="fixture">
													This saves a real, private memory for {status.data.agentId}. You can inspect or delete it in
													Memory.
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
							{step === 8 && (
								<>
									{heading(
										"Ready for your next conversation",
										"Your setup, at a glance.",
										"Your memory and identity stay in Signet, ready to carry into your next conversation.",
									)}
									<dl className="setup-summary">
										<div>
											<dt>Your agent</dt>
											<dd>
												{identity?.name || store.aStr(["agent", "name"])}
												<small>
													{identity?.managed ? "Identity managed in Signet" : "Identity managed in your tools"}
												</small>
											</dd>
										</div>
										<div>
											<dt>Connected tools</dt>
											<dd>
												{selected.length
													? selected
															.map((id) => harnesses.data?.data?.harnesses.find((h) => h.id === id)?.name ?? id)
															.join(", ")
													: "None connected yet"}
											</dd>
										</div>
										<div>
											<dt>Background memory</dt>
											<dd>
												{verified ? `${providerName} · connection tested` : "Connection setup deferred"}
												<small>
													{dreamingEnabled
														? verified
															? "Dreaming enabled"
															: "Dreaming requested; connection still needed"
														: "Dreaming turned off"}
												</small>
											</dd>
										</div>
										<div>
											<dt>Search</dt>
											<dd>
												{embeddingSaved
													? embedding?.provider === "none"
														? "Keyword search"
														: `${embedding?.provider === "native" ? "Built-in local model" : embedding?.provider} · ${embedding?.model}`
													: "Existing settings kept"}
												<small>
													{embedding?.provider === "none" && embeddingSaved
														? "Search by meaning is turned off"
														: (embeddingStatus ?? "Provider readiness has not been checked in this walkthrough")}
												</small>
											</dd>
										</div>
										<div>
											<dt>Sources</dt>
											<dd>
												{sources.data
													? `${sources.data.sources.filter((source) => source.enabled).length} enabled · ${sources.data.sources.length} registered`
													: "Status unavailable"}
												<small>Imports can continue in the background. See Sources on Home for progress.</small>
											</dd>
										</div>
										<div>
											<dt>First memory</dt>
											<dd>
												Saved and recalled<small>{recalled?.content}</small>
											</dd>
										</div>
									</dl>
									<p className="fixture">
										You can change these choices in Settings. Start a new session in a connected tool and ask what it
										remembers about you.
									</p>
								</>
							)}
						</div>
					)}
					{store.ready && status.data && catalog.data && (error || store.error) && (
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
								if (step === 5 && sourceKind) setSourceKind(null);
								else setStep((n) => n - 1);
							}}
						>
							Back
						</button>
						<span className="step-count">
							Step {step + 1} of {STEPS.length}
						</span>
					</div>
					{step === 6 && (
						<button
							type="button"
							className="back"
							disabled={blocked}
							onClick={() => {
								setError(null);
								setStep(7);
							}}
						>
							Keep current settings
						</button>
					)}
					{step === 4 && !verified && (
						<button
							type="button"
							className="back"
							disabled={busy || store.saving || phase.kind === "saving"}
							onClick={() => void deferConnection()}
						>
							Set up later
						</button>
					)}
					<button
						type="button"
						className="primary"
						disabled={
							blocked ||
							!store.ready ||
							!status.data ||
							!catalog.data ||
							(step === 2 &&
								(!identity?.name.trim() ||
									(identity.managed &&
										!identity.selected.some(
											(path) => !Object.values(IDENTITY_FILES).find((file) => file.path === path)?.context,
										)))) ||
							(step === 4 && (!provider || (!local && !oauth && !connected && !key.trim()))) ||
							(step === 6 && !embedding) ||
							(step === 7 && !memory.trim())
						}
						onClick={advance}
					>
						{busy ? "Working…" : label}
						<span aria-hidden="true">→</span>
					</button>
				</footer>
			</div>
		</section>
	);
}

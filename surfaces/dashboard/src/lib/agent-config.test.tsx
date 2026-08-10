/**
 * Regression test for the OAuth disconnect purge bug: a mutation followed by
 * an immediate save() in the same tick used to serialize the PRE-mutation
 * config, so the daemon-side OAuth secret was deleted but the
 * `inference.accounts.<provider>` entry survived in agent.yaml. The dashboard
 * kept reporting the provider as connected ("credentials are never removed").
 *
 * The store keeps a ref (agentRef.current) that save() serializes; it was only
 * refreshed during React renders, which have not committed by the time the
 * disconnect handler calls save(). mutate() must write through to the ref
 * synchronously.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { useEffect, useRef } from "react";
import { type Root, createRoot } from "react-dom/client";
import { type AgentConfigStore, isDreamingEnabled, useAgentConfig } from "./agent-config";
import { writeEmbeddingEndpoint } from "./embedding-config";

const INITIAL_CONFIG = `inference:
  defaultPolicy: background
  accounts:
    openai-codex:
      kind: subscription_session
      providerFamily: openai-codex
    minimax:
      kind: api
      providerFamily: minimax
      credentialRef: SIGNET_KEY_MINIMAX
  targets:
    background:
      executor: openai-compatible
      endpoint: http://127.0.0.1:1234/v1
embedding:
  provider: ollama
  baseUrl: http://127.0.0.1:11434
memory:
  pipelineV2:
    mutationsFrozen: true
    maintenanceMode: execute
x-custom-operator-key:
  nested: keep-me
`;

let capturedSaveBody: string | null = null;

function requireStore(store: AgentConfigStore | null): AgentConfigStore {
	if (!store) throw new Error("store not initialized");
	return store;
}

function requireSaveBody(body: string | null): string {
	if (body === null) throw new Error("no config save captured");
	return body;
}

function Harness({ onStore }: { readonly onStore: (store: AgentConfigStore) => void }) {
	const store = useAgentConfig();
	const sent = useRef(false);
	useEffect(() => {
		if (!sent.current && store.ready) {
			sent.current = true;
			onStore(store);
		}
	}, [store, onStore]);
	return null;
}

async function mountHarness(): Promise<{
	readonly store: AgentConfigStore;
	readonly unmount: () => Promise<void>;
}> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root: Root = createRoot(container);
	let store: AgentConfigStore | null = null;
	await act(async () => {
		root.render(<Harness onStore={(s) => (store = s)} />);
	});
	// Let the reload effect fetch + setAgent land.
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	return {
		store: requireStore(store),
		unmount: async () => {
			await act(async () => {
				root.unmount();
			});
			container.remove();
		},
	};
}

beforeAll(() => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	const window = new Window();
	for (const key of Object.getOwnPropertyNames(window)) {
		if (!(key in globalThis)) {
			// happy-dom v20 ships no GlobalRegistrator; mirror the window's
			// browser globals so react-dom/client and the api client work.
			(globalThis as Record<string, unknown>)[key] = (window as unknown as Record<string, unknown>)[key];
		}
	}
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (url.endsWith("/api/config") && (init?.method ?? "GET") === "GET") {
			return new Response(JSON.stringify({ files: [{ name: "agent.yaml", content: INITIAL_CONFIG }] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}
		if (url.endsWith("/api/config") && init?.method === "POST") {
			capturedSaveBody = JSON.parse(String(init.body)).content as string;
			return new Response(JSON.stringify({ success: true }), { status: 200 });
		}
		return new Response("not found", { status: 404 });
	}) as typeof fetch;
});

afterAll(() => {
	globalThis.fetch = undefined as unknown as typeof fetch;
});

describe("agent config store", () => {
	test("dreaming follows the daemon's pipeline gate contract", () => {
		expect(isDreamingEnabled({ memory: { pipelineV2: { enabled: true } } })).toBe(true);
		expect(isDreamingEnabled({ memory: { pipelineV2: { paused: false, mutationsFrozen: false } } })).toBe(true);
		expect(isDreamingEnabled({ memory: { pipelineV2: { paused: true } } })).toBe(false);
		expect(isDreamingEnabled({ memory: { pipelineV2: { mutationsFrozen: true } } })).toBe(false);
		expect(isDreamingEnabled({ memory: { dreaming: {} } })).toBe(true);
	});

	test("mutations are visible to an immediate save in the same tick (disconnect purge regression)", async () => {
		capturedSaveBody = null;
		const harness = await mountHarness();
		expect(harness.store.ready).toBe(true);

		// Exactly what handleDisconnect does: delete the account entry, then
		// persist — no render in between.
		await act(async () => {
			harness.store.aDel(["inference", "accounts", "openai-codex"]);
			await harness.store.save();
		});

		const body = requireSaveBody(capturedSaveBody);
		expect(body).not.toContain("openai-codex");
		expect(body).toContain("inference:");
		expect(body).toContain("minimax");
		await harness.unmount();
	});

	test("sequential mutations in one tick all land in the saved config (connect wiring regression)", async () => {
		capturedSaveBody = null;
		const harness = await mountHarness();
		expect(harness.store.ready).toBe(true);

		// Exactly what linkOAuthAccount does: kind + providerFamily + drop the
		// credentialRef, then persist without a render in between.
		await act(async () => {
			const base = ["inference", "accounts", "anthropic"] as const;
			harness.store.aSetStr([...base, "kind"], "subscription_session");
			harness.store.aSetStr([...base, "providerFamily"], "anthropic");
			harness.store.aDel([...base, "credentialRef"]);
			await harness.store.save();
		});

		const body = requireSaveBody(capturedSaveBody);
		expect(body).toContain("anthropic");
		expect(body).toContain("kind: subscription_session");
		expect(body).toContain("providerFamily: anthropic");
		await harness.unmount();
	});

	test("save round-trips unknown keys and operator edits instead of dropping them (#1164)", async () => {
		capturedSaveBody = null;
		const harness = await mountHarness();
		expect(harness.store.ready).toBe(true);

		// Saving without touching the settings must preserve everything the
		// operator configured outside the dashboard (mutationsFrozen, custom
		// executors, unknown top-level keys) — a full-model rewrite would drop
		// them silently.
		await act(async () => {
			await harness.store.save();
		});

		const body = requireSaveBody(capturedSaveBody);
		expect(body).toContain("mutationsFrozen: true");
		expect(body).toContain("maintenanceMode: execute");
		expect(body).toContain("executor: openai-compatible");
		expect(body).toContain("x-custom-operator-key:");
		expect(body).toContain("nested: keep-me");
		await harness.unmount();
	});

	test("saves embedding endpoints as base_url and removes the dashboard alias (#1264)", async () => {
		capturedSaveBody = null;
		const harness = await mountHarness();

		await act(async () => {
			writeEmbeddingEndpoint(harness.store, ["embedding"], "http://192.168.1.10:11434");
			await harness.store.save();
		});

		const body = requireSaveBody(capturedSaveBody);
		expect(body).toContain("base_url: http://192.168.1.10:11434");
		expect(body).not.toContain("baseUrl:");
		expect(body).not.toContain("127.0.0.1:11434");
		await harness.unmount();
	});
});

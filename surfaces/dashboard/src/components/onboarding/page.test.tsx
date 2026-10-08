import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
let createRoot: typeof import("react-dom/client").createRoot;
let OnboardingPage: typeof import("./page").OnboardingPage;

const dom = new Window({ url: "http://localhost/#setup" });
const originalFetch = globalThis.fetch;
const originalEvent = globalThis.Event;
const originalCustomEvent = globalThis.CustomEvent;
let config = "name: Example\nharnesses: []\noperator_setting: preserved\n";
let saveFails = false;
let savedOAuth = false;
let probeError: string | null = null;
const calls: string[] = [];
let identityFiles: Record<string, string> = {};
let importFiles: Array<{ id: string; name: string }> = [];
const pausedIn = (content: string): boolean => /paused: true/.test(content);
if (!process.env.SIGNET_MODAL_TEST_CHILD) {
	test("onboarding browser fixture", () => {
		const result = spawnSync(process.execPath, ["test", import.meta.filename], {
			env: { ...process.env, SIGNET_MODAL_TEST_CHILD: "1" },
			encoding: "utf8",
			timeout: 20_000,
		});
		expect(result.status, result.stdout + result.stderr).toBe(0);
	}, 25_000);
} else {
	beforeAll(async () => {
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
		Reflect.set(globalThis, "Event", dom.Event);
		Reflect.set(globalThis, "CustomEvent", dom.CustomEvent);
		for (const key of Object.getOwnPropertyNames(dom))
			if (!(key in globalThis)) Reflect.set(globalThis, key, Reflect.get(dom, key));
		({ createRoot } = await import("react-dom/client"));
		({ OnboardingPage } = await import("./page"));
		globalThis.fetch = async (input, init) => {
			const path = String(input);
			calls.push(`${init?.method ?? "GET"} ${path}`);
			if (path === "/api/config") {
				if (init?.method === "POST") {
					if (saveFails) return Response.json({ error: "disk full" }, { status: 500 });
					const body = JSON.parse(String(init.body));
					if (body.file === "agent.yaml" && pausedIn(body.content) !== pausedIn(config))
						return Response.json(
							{ error: "memory.pipelineV2.paused changes only through pause or resume" },
							{ status: 409 },
						);
					if (body.file === "agent.yaml") config = body.content;
					else identityFiles[body.file] = body.content;
					return Response.json({ success: true });
				}
				return Response.json({
					files: [
						{ name: "agent.yaml", content: config },
						...Object.entries(identityFiles).map(([name, content]) => ({ name, content })),
					],
				});
			}
			if (path === "/api/status")
				return Response.json({ agentId: "alice", agentsDir: "/fixture", pipelineV2: { enabled: false, paused: true } });
			if (path === "/api/harnesses")
				return Response.json({ harnesses: [{ id: "codex", name: "Codex", exists: true }] });
			if (path === "/api/inference/catalog")
				return Response.json({
					providers: savedOAuth ? ["openai-codex"] : [],
					models: {},
					oauthProviders: savedOAuth ? [{ id: "openai-codex", connected: true }] : [],
					acpxAgents: [],
				});
			if (path === "/api/inference/oauth/login/openai-codex") {
				return new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(
								new TextEncoder().encode('data: {"type":"auth","url":"https://example.com/sign-in"}\n\n'),
							);
							init?.signal?.addEventListener("abort", () => controller.close(), { once: true });
						},
					}),
					{ headers: { "Content-Type": "text/event-stream" } },
				);
			}
			if (path === "/api/sources") return Response.json({ sources: [] });
			if (path === "/api/sources/obsidian") return Response.json({ id: "notes", success: true });
			if (path.startsWith("/api/sources/imports?")) {
				expect(path).toContain("agentId=alice");
				const body = JSON.parse(String(init?.body));
				importFiles = body.files;
				return Response.json({ id: "import-job", files: importFiles });
			}
			if (path.startsWith("/api/sources/imports/import-job/files/")) {
				if (init?.method === "PATCH") expect(init.body instanceof ArrayBuffer).toBe(true);
				expect(path).toContain("agentId=alice");
				return Response.json({ success: true });
			}
			if (path.startsWith("/api/sources/imports/import-job?")) {
				expect(path).toContain("agentId=alice");
				return Response.json({
					job: { id: "import-job" },
					files: importFiles.map((file) => ({
						...file,
						state: "uploading",
						upload_offset: 0,
						upload_generation: 1,
						upload_digest: "",
					})),
				});
			}
			if (path.startsWith("/api/sources/imports/import-job/start")) return Response.json({ changed: true });
			if (path.startsWith("/api/sources/import")) return Response.json({ imports: [] });
			if (path === "/api/inference/execute") {
				if (probeError)
					return Response.json(
						{
							error: "No eligible target",
							details: { trace: { candidates: [{ targetRef: "background/default", blockedBy: [probeError] }] } },
						},
						{ status: 502 },
					);
				return Response.json({ text: "OK", decision: { targetRef: "background/default" }, attempts: [{ ok: true }] });
			}
			if (path === "/api/pipeline/pause" || path === "/api/pipeline/resume") {
				const paused = path === "/api/pipeline/pause";
				config = /paused: (true|false)/.test(config)
					? config.replace(/paused: (true|false)/, `paused: ${paused}`)
					: config.replace(/( *)pipelineV2:\n( *)/, `$1pipelineV2:\n$2paused: ${paused}\n$2`);
				return Response.json({ success: true, paused, mode: "controlled-write" });
			}
			if (path === "/api/agents") return Response.json({ agents: [{ id: "alice", name: "alice" }] });
			if (path === "/api/memory/remember") {
				const body = JSON.parse(String(init?.body));
				expect(body.agentId).toBe("alice");
				expect(body.visibility).toBe("private");
				expect(body.idempotencyKey).toBeTruthy();
				return Response.json({ id: "first-memory" });
			}
			if (path.startsWith("/memory/search?")) {
				expect(path).toContain("agentId=alice");
				return Response.json({ results: [{ id: "first-memory", content: "Retrieved evidence" }] });
			}
			throw new Error(`Unexpected fixture request ${path}`);
		};
	});
	afterAll(() => {
		globalThis.fetch = originalFetch;
		globalThis.Event = originalEvent;
		globalThis.CustomEvent = originalCustomEvent;
		dom.close();
	});

	async function mount(files: Record<string, string> = {}) {
		identityFiles = { ...files };
		window.location.hash = "#setup";
		localStorage.clear();
		calls.length = 0;
		const element = document.createElement("div");
		document.body.append(element);
		const root = createRoot(element);
		await act(async () => {
			root.render(<OnboardingPage onClose={() => {}} />);
		});
		return {
			async click(text: string) {
				const button = [...document.querySelectorAll("button")].find((b) =>
					b.textContent?.trim().replace(/→$/, "").trim().includes(text),
				);
				if (!button) throw new Error(`Missing ${text}: ${document.body.textContent}`);
				await act(async () => button.click());
			},
			async input(label: string, value: string) {
				const input =
					document.querySelector(`input[aria-label="${label}"]`) ??
					[...document.querySelectorAll("label")].find((entry) => entry.textContent?.trim() === label)?.control;
				if (!(input instanceof HTMLInputElement)) throw new Error(`Missing input ${label}`);
				await act(async () => {
					const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
					setter?.call(input, value);
					input.dispatchEvent(new Event("input", { bubbles: true }));
					input.dispatchEvent(new Event("change", { bubbles: true }));
				});
			},
			async close() {
				await act(async () => root.unmount());
				element.remove();
			},
		};
	}

	test("identity setup preserves user-owned files, scope, and unrelated config", async () => {
		config = "agent:\n  name: Existing\noperator_setting: preserved\nharnesses: []\n";
		const originals = {
			"AGENTS.md": "My existing instructions",
			"SOUL.md": "My existing persona",
			"MEMORY.md": "Generated memory",
		};
		const view = await mount(originals);
		try {
			await view.click("Get started");
			await view.click("Continue");
			await view.input("Agent name", "New display name");
			await view.click("Save identity");
			expect(config).toContain("name: New display name");
			expect(config).toContain("operator_setting: preserved");
			expect(identityFiles["AGENTS.md"]).toBe(originals["AGENTS.md"]);
			expect(identityFiles["SOUL.md"]).toBe(originals["SOUL.md"]);
			expect(identityFiles["MEMORY.md"]).toBe(originals["MEMORY.md"]);
			expect(calls).not.toContain("POST /api/agents");
		} finally {
			await view.close();
		}
	});

	test("identity setup drops a retired DREAMING.md entry without touching the file", async () => {
		config =
			"agent:\n  name: Existing\nharnesses: []\nidentity:\n  preset: minimal\n  startup:\n    load:\n      - path: AGENTS.md\n        role: operating_instructions\n  special:\n    - path: DREAMING.md\n      kind: dreaming\n      role: dreaming_prompt\n";
		const originals = { "AGENTS.md": "My existing instructions", "DREAMING.md": "Old dreaming prompt" };
		const view = await mount(originals);
		try {
			await view.click("Get started");
			await view.click("Continue");
			await view.click("Save identity");
			expect(config).toContain("path: AGENTS.md");
			expect(config).not.toContain("DREAMING.md");
			expect(config).not.toContain("kind: dreaming");
			expect(identityFiles["DREAMING.md"]).toBe(originals["DREAMING.md"]);
		} finally {
			await view.close();
		}
	});

	test("failed identity writes keep setup incomplete and can be retried", async () => {
		config = "agent:\n  name: Existing\nharnesses: []\n";
		const view = await mount();
		try {
			await view.click("Get started");
			await view.click("Continue");
			await view.input("Agent name", "New display name");
			await view.input("Your name optional", "Fixture User");
			saveFails = true;
			await view.click("Save identity");
			expect(config).toContain("name: Existing");
			expect(identityFiles["AGENTS.md"]).toBeUndefined();
			expect(document.body.textContent).toContain("Could not save AGENTS.md");
			saveFails = false;
			await view.click("Save identity");
			expect(identityFiles["AGENTS.md"]).toContain("You are New display name");
			expect(identityFiles["AGENTS.md"]).toContain("- Name: Fixture User");
			expect(identityFiles["AGENTS.md"]).not.toContain("SIGNET:START");
			expect(config).toContain("name: New display name");
		} finally {
			saveFails = false;
			await view.close();
		}
	});

	test("saved OAuth still allows signing in again when popups are blocked", async () => {
		config = "name: Example\nharnesses: []\noperator_setting: preserved\n";
		savedOAuth = true;
		const open = window.open;
		window.open = () => null;
		const view = await mount();
		try {
			await view.click("Get started");
			await view.click("Continue");
			await view.input("Agent name", "Fixture Agent");
			await view.click("Save identity");
			await view.click("Continue");
			await view.click("ChatGPT / Codex");
			expect(document.body.textContent).toContain("Saved credentials found");
			await view.click("Sign in again");
			expect(calls).toContain("POST /api/inference/oauth/login/openai-codex");
			expect(document.querySelector('a[href="https://example.com/sign-in"]')).not.toBeNull();
			expect(calls).not.toContain("POST /api/inference/execute");
			await view.click("Set up later");
			expect(document.body.textContent).toContain("Bring your context");
		} finally {
			await view.close();
			savedOAuth = false;
			window.open = open;
		}
	});

	test("keeps Dreaming enabled but provider-unavailable when connection setup is deferred", async () => {
		config = "name: Example\nharnesses: []\noperator_setting: preserved\n";
		const view = await mount();
		try {
			await view.click("Get started");
			await view.click("Continue");
			await view.input("Agent name", "Fixture Agent");
			await view.click("Save identity");
			await view.click("Continue");
			const dreaming = document.querySelector('[role="switch"][aria-label="Enable Dreaming?"]');
			expect(dreaming?.getAttribute("aria-checked")).toBe("true");
			expect(dreaming?.getAttribute("aria-describedby")).toBe("dreaming-provider-status");
			expect(document.body.textContent).toContain("Starts after your connection passes its test");
			await view.click("Set up later");
			expect(config).toContain("dreaming:\n    enabled: true");
			expect(calls).not.toContain("POST /api/inference/execute");
			expect(calls).not.toContain("POST /api/pipeline/resume");
			await view.click("Continue");
			await view.click("Keep current settings");
			expect(document.querySelector<HTMLInputElement>('[aria-label="Your first memory"]')?.value).toBe("");
			expect(
				Array.from(document.querySelectorAll("button")).find((button) => button.textContent?.includes("Remember this"))
					?.disabled,
			).toBe(true);
			await view.click("How I like answers");
			await view.click("Remember this");
			await view.click("Recall it");
			await view.click("Continue");
			expect(document.body.textContent).toContain("Connection setup deferred");
			expect(document.body.textContent).not.toContain("answered the connection test");
		} finally {
			await view.close();
		}
	});

	test("retries a failed Dreaming preference save when setup is deferred", async () => {
		config = "name: Example\nharnesses: []\noperator_setting: preserved\n";
		const view = await mount();
		try {
			await view.click("Get started");
			await view.click("Continue");
			await view.input("Agent name", "Fixture Agent");
			await view.click("Save identity");
			await view.click("Continue");
			const dreaming = document.querySelector('[role="switch"][aria-label="Enable Dreaming?"]');
			if (!(dreaming instanceof HTMLButtonElement)) throw new Error("Missing Dreaming preference");
			const preferenceSavesBeforeToggle = calls.filter((call) => call === "POST /api/config").length;
			saveFails = true;
			await act(async () => dreaming.click());
			expect(document.body.textContent).toContain("Could not save the Dreaming preference");
			expect(calls.filter((call) => call === "POST /api/config")).toHaveLength(preferenceSavesBeforeToggle + 1);
			saveFails = false;
			await view.click("Set up later");
			expect(config).toMatch(/dreaming:\s*\n\s+enabled: false/);
			expect(calls.filter((call) => call === "POST /api/config")).toHaveLength(preferenceSavesBeforeToggle + 2);
		} finally {
			saveFails = false;
			await view.close();
		}
	});

	test("lets users opt out while deferring provider setup", async () => {
		config = "name: Example\nharnesses: []\noperator_setting: preserved\n";
		const view = await mount();
		try {
			await view.click("Get started");
			await view.click("Continue");
			await view.input("Agent name", "Fixture Agent");
			await view.click("Save identity");
			await view.click("Continue");
			const dreaming = document.querySelector('[role="switch"][aria-label="Enable Dreaming?"]');
			if (!(dreaming instanceof HTMLButtonElement)) throw new Error("Missing Dreaming preference");
			await act(async () => dreaming.click());
			expect(dreaming.getAttribute("aria-checked")).toBe("false");
			await view.click("Set up later");
			expect(config).toMatch(/dreaming:\s*\n\s+enabled: false/);
			expect(calls).not.toContain("POST /api/inference/execute");
			expect(calls).not.toContain("POST /api/pipeline/resume");
		} finally {
			await view.close();
		}
	});

	test("preserves the Dreaming opt-out when a provider passes setup", async () => {
		config = "name: Example\nharnesses: []\noperator_setting: preserved\n";
		const view = await mount();
		try {
			await view.click("Get started");
			await view.click("Continue");
			await view.input("Agent name", "Fixture Agent");
			await view.click("Save identity");
			await view.click("Continue");
			await view.click("Local model");
			await view.input("Model name", "fixture-model");
			const dreaming = document.querySelector('[role="switch"][aria-label="Enable Dreaming?"]');
			if (!(dreaming instanceof HTMLButtonElement)) throw new Error("Missing Dreaming preference");
			await act(async () => dreaming.click());
			await view.click("Test and enable memory");
			expect(calls).toContain("POST /api/inference/execute");
			expect(calls).toContain("POST /api/pipeline/resume");
			expect(config).toMatch(/dreaming:\s*\n\s+enabled: false/);
		} finally {
			await view.close();
		}
	});

	test("embedding saves preserve other settings and failures keep setup incomplete", async () => {
		config =
			"name: Example\nharnesses: []\noperator_setting: preserved\nembedding:\n  provider: native\n  model: nomic-embed-text-v1.5\n  dimensions: 768\n  idleTtlMs: 12345\n";
		const view = await mount();
		try {
			await view.click("Get started");
			await view.click("Continue");
			await view.input("Agent name", "Fixture Agent");
			await view.click("Save identity");
			await view.click("Continue");
			await view.click("Set up later");
			await view.click("Continue");
			saveFails = true;
			await view.click("Save search settings");
			expect(document.body.textContent).toContain("Could not save search settings");
			expect(document.body.textContent).toContain("Find it, even in different words");
			saveFails = false;
			await view.click("Save search settings");
			expect(config).toContain("operator_setting: preserved");
			expect(config).toContain("idleTtlMs: 12345");
			expect(config).toContain("dimensions: 768");
			expect(config).not.toContain("memory:\n  embeddings:");
			expect(document.body.textContent).toContain("What should your agents know about you");
		} finally {
			saveFails = false;
			await view.close();
		}
	});

	test("later setup saves keep the pipeline resumed and recall ignores surrounding whitespace", async () => {
		config = "name: Example\nharnesses: []\n";
		const view = await mount();
		try {
			await view.click("Get started");
			await view.click("Continue");
			await view.input("Agent name", "Fixture Agent");
			await view.click("Save identity");
			await view.click("Continue");
			await view.click("Local model");
			await view.input("Model name", "fixture-model");
			await view.click("Test and enable memory");
			expect(config).toContain("paused: false");
			await view.click("Continue");
			await view.click("Continue");
			await view.click("Save search settings");
			expect(config).toContain("paused: false");
			await view.input("Your first memory", "I prefer short answers. ");
			await view.click("Remember this");
			await view.click("Recall it");
			const query = new URLSearchParams({ q: "I prefer short answers.", agentId: "alice", limit: "20" });
			expect(calls).toContain(`GET /memory/search?${query}`);
		} finally {
			await view.close();
		}
	});

	test("shows the daemon's connection failure and does not enable memory", async () => {
		config = "name: Example\nharnesses: []\n";
		const view = await mount();
		try {
			await view.click("Get started");
			await view.click("Continue");
			await view.input("Agent name", "Fixture Agent");
			await view.click("Save identity");
			await view.click("Continue");
			await view.click("Local model");
			await view.input("Model name", "fixture-model");
			probeError = "Native keyring helper deadline exceeded";
			await view.click("Test and enable memory");
			expect(document.body.textContent).toContain(probeError);
			expect(calls).not.toContain("POST /api/pipeline/resume");
		} finally {
			probeError = null;
			await view.close();
		}
	});

	test("the page requires a successful save and probe, exposes sources, and recalls scoped evidence", async () => {
		config = "name: Example\nharnesses: []\noperator_setting: preserved\n";
		const view = await mount();
		try {
			await view.click("Get started");
			await view.click("Continue");
			await view.input("Agent name", "Fixture Agent");
			await view.click("Save identity");
			await view.click("Continue");
			await view.click("Local model");
			await view.input("Model name", "fixture-model");
			saveFails = true;
			await view.click("Test and enable memory");
			expect(calls).not.toContain("POST /api/pipeline/resume");
			saveFails = false;
			await view.click("Test and enable memory");
			expect(document.body.textContent).not.toContain("Choose a model before testing");
			expect(calls).toContain("POST /api/inference/execute");
			expect(calls).toContain("POST /api/pipeline/resume");
			expect(config).toContain("operator_setting: preserved");
			expect(config).toMatch(/dreaming:\s*\n\s+enabled: true/);
			await view.click("Continue");
			expect(document.body.textContent).toContain("Bring your context");
			expect(document.body.textContent).toContain("Obsidian");
			expect(document.body.textContent).toContain("Bulk import conversation exports");
			await view.click("ObsidianConnect a vault");
			await view.input("Vault path", "/fixture/notes");
			await view.click("Connect & index");
			expect(calls).toContain("POST /api/sources/obsidian");
			const next = [...document.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Continue"));
			expect(next?.disabled).toBe(false);
			await view.click("Agent transcriptsBulk import");
			const files = document.querySelector('input[type="file"]');
			const target = document.querySelector('button[aria-label="Target agent"]');
			if (!(files instanceof HTMLInputElement) || !(target instanceof HTMLButtonElement))
				throw new Error("Missing transcript controls");
			expect(files.accept).toBe(".jsonl");
			await act(async () => {
				const transfer = new DataTransfer();
				transfer.items.add(new dom.File(["{}\n"], "conversation.jsonl"));
				files.files = transfer.files;
				files.dispatchEvent(new Event("change", { bubbles: true }));
				target.click();
			});
			await act(async () => {
				const option = document.querySelector('[role="option"]');
				if (!(option instanceof HTMLElement)) throw new Error("Missing agent option");
				option.click();
			});
			await view.click("Import & index");
			expect(calls).toContain("POST /api/sources/imports/import-job/start?agentId=alice");
			await view.click("Continue");
			await view.click("Keep current settings");
			await view.click("How I like answers");
			await view.click("Remember this");
			await view.click("Recall it");
			expect(document.body.textContent).toContain("Retrieved evidence");
		} finally {
			saveFails = false;
			await view.close();
		}
	});
}

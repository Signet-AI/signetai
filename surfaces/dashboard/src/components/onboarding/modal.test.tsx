import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
let createRoot: typeof import("react-dom/client").createRoot;
let OnboardingModal: typeof import("./modal").OnboardingModal;

const dom = new Window({ url: "http://localhost/#setup" });
const originalFetch = globalThis.fetch;
const originalEvent = globalThis.Event;
const originalCustomEvent = globalThis.CustomEvent;
let config = "name: Example\nharnesses: []\noperator_setting: preserved\n";
let saveFails = false;
const calls: string[] = [];
// Radix detects the DOM at module load. Other suites import it for SSR;
// run this browser fixture in its own process so test order cannot hide the modal.
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
		({ OnboardingModal } = await import("./modal"));
		globalThis.fetch = async (input, init) => {
			const path = String(input);
			calls.push(`${init?.method ?? "GET"} ${path}`);
			if (path === "/api/config") {
				if (init?.method === "POST") {
					if (saveFails) return Response.json({ error: "disk full" }, { status: 500 });
					config = JSON.parse(String(init.body)).content;
					return Response.json({ success: true });
				}
				return Response.json({ files: [{ name: "agent.yaml", content: config }] });
			}
			if (path === "/api/status")
				return Response.json({ agentId: "alice", agentsDir: "/fixture", pipelineV2: { enabled: false, paused: true } });
			if (path === "/api/harnesses")
				return Response.json({ harnesses: [{ id: "codex", name: "Codex", exists: true }] });
			if (path === "/api/inference/catalog")
				return Response.json({ providers: [], models: {}, oauthProviders: [], acpxAgents: [] });
			if (path === "/api/sources") return Response.json({ sources: [] });
			if (path === "/api/sources/obsidian") return Response.json({ id: "notes", success: true });
			if (path.startsWith("/api/sources/imports?")) {
				expect(path).toContain("agentId=alice");
				const body = JSON.parse(String(init?.body));
				return Response.json({ id: "import-job", files: body.files });
			}
			if (path.startsWith("/api/sources/imports/import-job/files/")) {
				expect(init?.body instanceof dom.File).toBe(true);
				expect(path).toContain("agentId=alice");
				return Response.json({ success: true });
			}
			if (path.startsWith("/api/sources/imports/import-job/start")) return Response.json({ changed: true });
			if (path.startsWith("/api/sources/import")) return Response.json({ imports: [] });
			if (path === "/api/inference/execute")
				return Response.json({ text: "OK", decision: { targetRef: "background/default" }, attempts: [{ ok: true }] });
			if (path === "/api/pipeline/resume") return Response.json({ success: true, mode: "controlled-write" });
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

	async function mount() {
		window.location.hash = "#setup";
		localStorage.clear();
		calls.length = 0;
		const element = document.createElement("div");
		document.body.append(element);
		const root = createRoot(element);
		await act(async () => {
			root.render(<OnboardingModal />);
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
				const input = document.querySelector(`input[aria-label="${label}"]`);
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

	test("the modal requires a successful save and probe, exposes sources, and recalls scoped evidence", async () => {
		const view = await mount();
		try {
			expect(document.querySelector('[role="dialog"]')).not.toBeNull();
			await view.click("Get started");
			await view.click("Continue");
			await view.click("Local modelProcess on your own machine");
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
			const target = document.querySelector('select[aria-label="Target agent"]');
			if (!(files instanceof HTMLInputElement) || !(target instanceof HTMLSelectElement))
				throw new Error("Missing transcript controls");
			expect(files.accept).toBe(".jsonl");
			await act(async () => {
				const transfer = new DataTransfer();
				transfer.items.add(new dom.File(["{}\n"], "conversation.jsonl"));
				files.files = transfer.files;
				files.dispatchEvent(new Event("change", { bubbles: true }));
				target.value = "alice";
				target.dispatchEvent(new Event("change", { bubbles: true }));
			});
			await view.click("Import & index");
			expect(calls).toContain("POST /api/sources/imports/import-job/start");
			await view.click("Continue");
			await view.click("Remember this");
			await view.click("Recall it");
			expect(document.body.textContent).toContain("Retrieved evidence");
		} finally {
			saveFails = false;
			await view.close();
		}
	});
}

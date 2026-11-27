import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";

if (!process.env.SIGNET_PERSONAL_COPY_CHILD) {
	test("personal memory selection browser fixture", () => {
		const result = spawnSync(process.execPath, ["test", import.meta.filename], {
			env: { ...process.env, SIGNET_PERSONAL_COPY_CHILD: "1" },
			encoding: "utf8",
			timeout: 20_000,
		});
		expect(result.status, result.stdout + result.stderr).toBe(0);
	}, 25_000);
} else {
	const dom = new Window({ url: "http://localhost/" });
	const originalFetch = globalThis.fetch;
	const posts: FormData[] = [];
	let createRoot: typeof import("react-dom/client").createRoot;
	let PersonalMemoryCopy: typeof import("./personal-copy").PersonalMemoryCopy;
	beforeAll(async () => {
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
		for (const key of Object.getOwnPropertyNames(dom))
			if (!(key in globalThis)) Reflect.set(globalThis, key, Reflect.get(dom, key));
		({ createRoot } = await import("react-dom/client"));
		({ PersonalMemoryCopy } = await import("./personal-copy"));
		globalThis.fetch = async (input, init) => {
			const path = String(input);
			if (path === "/api/auth/whoami") return Response.json({ mode: "local", effectiveAccess: true });
			if (path === "/api/classifications") return Response.json([]);
			if (path.startsWith("/api/sources/import?")) {
				expect(path).toContain("agentId=personal-alice");
				if (!(init?.body instanceof FormData)) throw new Error("Missing import form");
				posts.push(init.body);
				return Response.json(
					{ imported: 1, failed: 0, files: [{ status: "imported", sourceId: "copied-evidence" }] },
					{ status: 201 },
				);
			}
			throw new Error(`Unexpected request ${path}`);
		};
	});
	afterAll(() => {
		globalThis.fetch = originalFetch;
		dom.close();
	});
	test("preview is local and upload contains only explicitly selected evidence", async () => {
		const element = document.createElement("div");
		document.body.append(element);
		const root = createRoot(element);
		const click = async (text: string) => {
			const button = [...element.querySelectorAll("button")].find((item) => item.textContent?.trim() === text);
			expect(button).toBeDefined();
			await act(async () => button?.click());
		};
		try {
			await act(async () => root.render(<PersonalMemoryCopy agentId="personal-alice" />));
			const input = element.querySelector('input[type="file"]');
			expect(input).not.toBeNull();
			const exportText = [
				{ id: "one", agent_id: "local-agent", content: "Share only this", who: "Alice" },
				{ id: "two", agent_id: "local-agent", content: "Never share this" },
			]
				.map((row) => JSON.stringify(row))
				.join("\n");
			Object.defineProperty(input, "files", { configurable: true, value: [new File([exportText], "memories.jsonl")] });
			await act(async () => {
				input?.dispatchEvent(new dom.Event("change", { bubbles: true }));
			});
			expect(posts).toHaveLength(0);
			const check = element.querySelector('input[type="checkbox"]');
			expect(check).not.toBeNull();
			await act(async () => check?.dispatchEvent(new dom.MouseEvent("click", { bubbles: true })));
			await click("Preview selected copy");
			expect(posts).toHaveLength(0);
			expect(element.textContent).toContain("Dry run");
			expect(element.textContent).toContain("Share only this");
			await click("Copy selected memories");
			expect(posts).toHaveLength(1);
			const file = posts[0]?.get("files");
			if (!(file instanceof File)) throw new Error("No evidence file");
			const evidence = await file.text();
			expect(evidence).toContain('"who":"Alice"');
			expect(evidence).toContain('"id":"one"');
			expect(evidence).not.toContain("Never share this");
			expect(element.textContent).toContain("Evidence copied");
			expect(exportText).toContain("Never share this");
		} finally {
			await act(async () => root.unmount());
			element.remove();
		}
	});
}

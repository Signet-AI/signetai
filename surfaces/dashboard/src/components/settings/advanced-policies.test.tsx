import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { installDashboardDomGlobals } from "@/test/dom-globals";

if (!process.env.SIGNET_ADVANCED_POLICIES_CHILD) {
	test("Dreaming pass policy editor browser fixture", () => {
		const result = spawnSync(process.execPath, ["test", import.meta.filename], {
			env: { ...process.env, SIGNET_ADVANCED_POLICIES_CHILD: "1" },
			encoding: "utf8",
			timeout: 20_000,
		});
		expect(result.status, result.stdout + result.stderr).toBe(0);
	}, 25_000);
} else {
	let restore = () => {};
	let root: Root | undefined;
	let container: HTMLDivElement | undefined;
	const originalFetch = globalThis.fetch;
	let config = "";
	let dreamStatusAvailable = true;
	const defaultPolicies = {
		hygiene: "Default hygiene policy.\n",
		content: "Default content policy.\n",
		combined: "Default combined policy.\n",
	};

	beforeAll(() => {
		restore = installDashboardDomGlobals(new Window({ url: "http://localhost/#settings/advanced" }));
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			const method = init?.method ?? "GET";
			if (url.endsWith("/api/config") && method === "GET")
				return Response.json({ files: [{ name: "agent.yaml", content: config }] });
			if (url.endsWith("/api/config") && method === "POST") {
				config = JSON.parse(String(init?.body)).content as string;
				return Response.json({ success: true });
			}
			if (url.endsWith("/api/dream/status") && method === "GET")
				return dreamStatusAvailable
					? Response.json({ config: { policies: defaultPolicies, defaultPolicies } })
					: new Response("unavailable", { status: 503 });
			return new Response("not found", { status: 404 });
		}) as typeof fetch;
	});
	beforeEach(() => {
		dreamStatusAvailable = true;
		config = "memory:\n  dreaming:\n    enabled: true\n";
	});
	afterAll(() => {
		globalThis.fetch = originalFetch;
		restore();
	});

	const settle = async () => {
		for (let i = 0; i < 5; i += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
	};
	const mount = async () => {
		const { createRoot } = await import("react-dom/client");
		const { AdvancedSection } = await import("./advanced");
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		await act(async () => root?.render(<AdvancedSection />));
		await settle();
	};
	const unmount = async () => {
		await act(async () => root?.unmount());
		container?.remove();
	};
	const editor = (label: string) => {
		const element = document.querySelector(`textarea[aria-label="${label}"]`);
		if (!(element instanceof window.HTMLTextAreaElement)) throw new Error(`Missing ${label} editor`);
		return element;
	};
	const button = (label: string, text: string) => {
		const found = [...(editor(label).parentElement?.querySelectorAll("button") ?? [])].find(
			(element) => element.textContent === text,
		);
		if (!(found instanceof window.HTMLButtonElement)) throw new Error(`Missing ${text} button`);
		return found;
	};
	const type = async (label: string, value: string) => {
		await act(async () => {
			const element = editor(label);
			Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set?.call(element, value);
			element.dispatchEvent(new window.Event("input", { bubbles: true }));
		});
	};

	test("a Dreaming pass policy is saved to agent.yaml and reset to the default", async () => {
		await mount();
		try {
			expect(editor("Hygiene pass policy").value).toBe(defaultPolicies.hygiene);
			expect(editor("Combined pass policy").value).toBe(defaultPolicies.combined);
			expect(editor("Content pass policy").value).toBe(defaultPolicies.content);
			expect(button("Content pass policy", "Save").disabled).toBe(true);
			expect(button("Content pass policy", "Reset to default").disabled).toBe(true);

			await type("Content pass policy", "File only decisions.\n");
			await act(async () => button("Content pass policy", "Save").click());
			await settle();
			expect(config).toMatch(/policies:\n\s+content: \|\n\s+File only decisions\./);
			expect(config).not.toContain("hygiene:");
			expect(editor("Content pass policy").value).toBe("File only decisions.\n");

			await act(async () => button("Content pass policy", "Reset to default").click());
			await settle();
			expect(config).not.toContain("File only decisions.");
			expect(editor("Content pass policy").value).toBe(defaultPolicies.content);
		} finally {
			await unmount();
		}
	});

	test("saving the default text or a blank policy leaves the pass on the default", async () => {
		config = "memory:\n  dreaming:\n    enabled: true\n    policies:\n      hygiene: Keep everything.\n";
		await mount();
		try {
			expect(editor("Hygiene pass policy").value).toBe("Keep everything.");
			await type("Hygiene pass policy", "   ");
			await act(async () => button("Hygiene pass policy", "Save").click());
			await settle();
			expect(config).not.toContain("Keep everything.");
			expect(editor("Hygiene pass policy").value).toBe(defaultPolicies.hygiene);
		} finally {
			await unmount();
		}
	});

	test.each(["42", "{ toString: bad }"])(
		"a non-text policy value shows the default it falls back to: %s",
		async (value) => {
			config = `memory:\n  dreaming:\n    enabled: true\n    policies:\n      content: ${value}\n`;
			await mount();
			try {
				expect(editor("Content pass policy").value).toBe(defaultPolicies.content);
				expect(document.body.textContent).toContain("file claims. Using the default.");
				expect(button("Content pass policy", "Reset to default").disabled).toBe(false);
				await act(async () => button("Content pass policy", "Reset to default").click());
				await settle();
				expect(config).not.toContain("content:");
			} finally {
				await unmount();
			}
		},
	);

	test("pass policies are not editable until the daemon supplies the defaults", async () => {
		dreamStatusAvailable = false;
		await mount();
		try {
			expect(document.querySelector("textarea")).toBeNull();
			expect(document.body.textContent).toContain("Could not load the default pass policies");
		} finally {
			await unmount();
		}
	});
}

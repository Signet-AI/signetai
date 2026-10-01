import { expect, test } from "bun:test";
import { onboardingPreviewFetch } from "./onboarding-preview";

test("onboarding preview contains writes and rejects unsupported operations instead of forwarding them", async () => {
	const original = globalThis.fetch;
	let requests = 0;
	globalThis.fetch = (() => {
		requests++;
		throw new Error("Real request attempted");
	}) as typeof fetch;
	try {
		const write = await onboardingPreviewFetch("/api/memory/remember", {
			method: "POST",
			body: JSON.stringify({ content: "Preview only", agentId: "onboarding-preview" }),
		});
		expect((await write.json()).id).toBe("preview-memory");
		const recall = await onboardingPreviewFetch("/memory/search?q=Preview");
		expect((await recall.json()).results[0].content).toBe("Preview only");
		expect((await onboardingPreviewFetch("/api/workspace/migrate", { method: "POST" })).status).toBe(501);
		expect(requests).toBe(0);
	} finally {
		globalThis.fetch = original;
	}
});

import { expect, spyOn, test } from "bun:test";
import { getJSONResult } from "../../../surfaces/dashboard/src/lib/api";
import { OrgDaemon } from "./daemon";
import { Fixture } from "./fixture";
import { request, success, text } from "./http";

test("dashboard accepts a real completed daemon job with a nullable error", async () => {
	const daemon = await OrgDaemon.create();
	const originalFetch = globalThis.fetch;
	let restore: (() => void) | undefined;
	try {
		const fixture = await Fixture.create(daemon, "personal", false);
		const admission = success(
			await request(daemon.origin, "/api/org/keys/revoke", fixture.admin, "POST", { ids: [fixture.user("bob").keyId] }),
			"revoke fixture key",
		);
		const path = `/api/org/jobs/${encodeURIComponent(text(admission.jobId))}`;
		const job = success(await request(daemon.origin, path, fixture.admin), "read durable job");
		expect(job.status).toBe("complete");
		expect(job.error).toBeNull();
		const browserFetch = Object.assign(
			(input: RequestInfo | URL, init?: RequestInit) =>
				originalFetch(typeof input === "string" && input.startsWith("/") ? new URL(input, daemon.origin) : input, init),
			originalFetch,
		);
		const spy = spyOn(globalThis, "fetch").mockImplementation(browserFetch);
		restore = () => spy.mockRestore();
		const headers: Record<string, string> = {};
		if (fixture.admin.cookie) headers.cookie = fixture.admin.cookie;
		if (fixture.admin.bearer) headers.authorization = `Bearer ${fixture.admin.bearer}`;
		const result = await getJSONResult<typeof job>(path, { headers });
		expect(result.error).toBeNull();
		expect(result.data).toEqual(job);
	} finally {
		restore?.();
		await daemon.dispose();
	}
}, 120_000);

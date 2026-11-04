import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { get } from "node:http";
import test from "node:test";
import { startViewer } from "../viewer/server.mjs";

async function fixture(t, events = []) {
	const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "coord-viewer-"));
	writeFileSync(join(dir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
	writeFileSync(
		join(dir, "prepared.json"),
		JSON.stringify({
			runId: "viewer-fixture",
			caseId: "fixture",
			phase: "prepared",
			secretsDir: "private-mount-location",
			daemonUrl: "private-backend-address",
		}),
	);
	writeFileSync(join(dir, "prompts.json"), JSON.stringify({ A: "Input A", B: "Input B" }));
	writeFileSync(
		join(dir, "case.public.json"),
		JSON.stringify({ host: "test-host", jobSeed: "not-public", token: "not-public" }),
	);
	const viewer = await startViewer(dir);
	t.after(async () => {
		await viewer.close();
		rmSync(dir, { recursive: true, force: true });
	});
	return viewer;
}

test("viewer exposes exact review inputs and a whitelisted preparation state, not arbitrary run files", async (t) => {
	const v = await fixture(t);
	const status = await (await fetch(`${v.url}status`)).json();
	assert.equal(status.phase, "prepared");
	assert.equal(JSON.stringify(status).includes("private-"), false);
	const inputs = await (await fetch(`${v.url}inputs`)).json();
	assert.deepEqual(inputs.prompts, { A: "Input A", B: "Input B" });
	assert.deepEqual(inputs.case, { host: "test-host" });
	assert.equal(await (await fetch(`${v.url}grade`)).json(), null);
	assert.equal((await fetch(`${v.url}prepared.json`)).status, 404);
	assert.equal((await fetch(`${v.url}../_gold/gold.json`)).status, 404);
	const forbidden = await new Promise((resolve, reject) => {
		get(v.url, { headers: { host: "untrusted.invalid" } }, (r) => {
			r.resume();
			resolve(r.statusCode);
		}).once("error", reject);
	});
	assert.equal(forbidden, 403);
	assert.equal((await fetch(`${v.url}inputs`, { method: "POST" })).status, 405);
});

test("viewer reports oversized records, resumes with safe JSON and closes live streams", async (t) => {
	const v = await fixture(t, [
		{ src: "fixture", type: "oversized", text: "x".repeat(150000) },
		{
			src: "fixture",
			type: "visible",
			text: "<img src=x onerror=alert(1)> Unicode: 🐜",
			jobSeed: "hidden-seed",
			token: "hidden-token",
		},
	]);
	const response = await fetch(`${v.url}events`, { signal: AbortSignal.timeout(3000) });
	assert.equal(response.headers.get("content-type"), "text/event-stream");
	assert.ok(response.headers.get("content-security-policy").includes("frame-ancestors 'none'"));
	const reader = response.body.getReader();
	let body = "";
	while (!body.includes('"type":"visible"')) {
		const next = await reader.read();
		assert.equal(next.done, false);
		body += new TextDecoder().decode(next.value);
	}
	assert.ok(body.includes('"type":"oversized_event"'));
	assert.ok(body.includes("Unicode: 🐜"));
	assert.equal(body.includes("hidden-seed"), false);
	assert.equal(body.includes("hidden-token"), false);
	await reader.cancel();
	await v.close();
});

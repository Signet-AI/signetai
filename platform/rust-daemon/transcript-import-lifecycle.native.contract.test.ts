import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

const root = process.cwd();
// biome-ignore lint/suspicious/noUndeclaredEnvVars: test-only binary override
const bin = process.env.SIGNET_RUST_DAEMON_BIN ?? join(root, "platform/rust-daemon/target/debug/signet-daemon");
const children: Bun.Subprocess[] = [];
const workspaces: string[] = [];
let assertions = 0;
function check<T>(value: T, expected: T): void {
	assertions++;
	expect(value).toEqual(expected);
}
function h(agent: string, workspace?: string): Record<string, string> {
	return {
		"content-type": "application/json",
		"x-signet-agent": agent,
		...(workspace ? { "x-signet-workspace": workspace } : {}),
	};
}
// biome-ignore lint/suspicious/noExplicitAny: dynamic HTTP contract payloads
async function json(response: Response): Promise<any> {
	return response.json();
}
async function start(path: string, agent: string) {
	const port = 30000 + Math.floor(Math.random() * 20000);
	const env = { ...process.env };
	delete env.SIGNET_API_KEY;
	delete env.SIGNET_TOKEN;
	const child = Bun.spawn([bin], {
		cwd: root,
		env: { ...env, SIGNET_PATH: path, SIGNET_BIND: "127.0.0.1", SIGNET_PORT: String(port), SIGNET_AGENT_ID: agent },
		stdout: "ignore",
		stderr: "pipe",
	});
	children.push(child);
	const origin = `http://127.0.0.1:${port}`;
	const stderr = new Response(child.stderr).text();
	for (let i = 0; i < 240; i++) {
		try {
			if ((await fetch(`${origin}/health/ready`)).ok) return { child, origin, stderr };
		} catch {}
		await Bun.sleep(25);
	}
	throw new Error(`readiness timeout: ${await stderr}`);
}
async function stop(child: Bun.Subprocess) {
	child.kill("SIGTERM");
	await Promise.race([child.exited, Bun.sleep(2000)]);
}
afterEach(async () => {
	for (const child of children.splice(0)) await stop(child);
	for (const path of workspaces.splice(0)) rmSync(path, { recursive: true, force: true });
});

test("fresh native durable transcript import staging lifecycle", async () => {
	assertions = 0;
	const path = mkdtempSync("/mnt/work/hermes-scratch/native-import-");
	workspaces.push(path);
	const agent = `agent-${randomUUID()}`,
		otherAgent = `agent-${randomUUID()}`,
		workspace = `workspace-${randomUUID()}`;
	let daemon = await start(path, agent);
	const headers = h(agent, workspace),
		otherHeaders = h(otherAgent, `workspace-${randomUUID()}`);
	const name = `transcript-${randomUUID()}.jsonl`,
		content = `{"id":"${randomUUID()}"}\n{"id":"${randomUUID()}"}\n`;
	const created = await fetch(`${daemon.origin}/api/sources/imports`, {
		method: "POST",
		headers,
		body: JSON.stringify({ schemaId: "signet-export", duplicateMode: "skip", files: [{ name }] }),
	});
	check(created.status, 201);
	const job = await json(created);
	check(typeof job.id, "string");
	check(job.jobId, job.id);
	check(job.agentId, agent);
	check(job.state, "staging");
	check(job.files.length, 1);
	check(job.files[0].name, name);
	const listed = await json(await fetch(`${daemon.origin}/api/sources/imports`, { headers }));
	check(Array.isArray(listed.imports), true);
	check(listed.imports.length, 0);
	const got = await json(await fetch(`${daemon.origin}/api/sources/imports/${job.id}`, { headers }));
	check(got.files, job.files);
	check(typeof got.createdAt, "string");
	check(typeof got.updatedAt, "string");
	check((await fetch(`${daemon.origin}/api/sources/imports/${job.id}`, { headers: otherHeaders })).status, 404);
	const file = job.files[0].id;
	const begin = await fetch(`${daemon.origin}/api/sources/imports/${job.id}/files/${file}`, {
		method: "PUT",
		headers: { ...headers, "upload-generation": "0", "upload-length": String(Buffer.byteLength(content)) },
		body: "",
	});
	check(begin.status, 200);
	const split = content.slice(0, Math.floor(content.length / 2)),
		rest = content.slice(Math.floor(content.length / 2));
	const append = await fetch(`${daemon.origin}/api/sources/imports/${job.id}/files/${file}`, {
		method: "PATCH",
		headers: {
			...headers,
			"upload-generation": "0",
			"upload-offset": "0",
			"upload-length": String(Buffer.byteLength(content)),
			"upload-checksum": createHash("sha256").update(split).digest("hex"),
		},
		body: split,
	});
	check(append.status, 200);
	check(
		(
			await fetch(`${daemon.origin}/api/sources/imports/${job.id}/files/${file}`, {
				method: "PATCH",
				headers: {
					...headers,
					"upload-generation": "0",
					"upload-offset": String(Buffer.byteLength(split)),
					"upload-checksum": createHash("sha256").update(rest).digest("hex"),
				},
				body: rest,
			})
		).status,
		200,
	);
	check(
		(
			await fetch(`${daemon.origin}/api/sources/imports/${job.id}/files/${file}`, {
				method: "PATCH",
				headers: { ...headers, "upload-generation": "0", "upload-offset": "0" },
				body: rest,
			})
		).status,
		400,
	);
	const finalized = await fetch(`${daemon.origin}/api/sources/imports/${job.id}/files/${file}/finalize`, {
		method: "POST",
		headers: { ...headers, "upload-generation": "0" },
	});
	check(finalized.status, 200);
	const exact = await (
		await fetch(`${daemon.origin}/api/sources/imports/${job.id}/files/${file}/content`, { headers })
	).text();
	check(exact, content);
	check(
		(
			await fetch(`${daemon.origin}/api/sources/imports/${job.id}/files/${file}/finalize`, {
				method: "POST",
				headers: { ...headers, "upload-generation": "0" },
			})
		).status,
		200,
	);
	check(
		(
			await fetch(`${daemon.origin}/api/sources/imports/${job.id}/files/${file}`, {
				method: "PUT",
				headers: { ...headers, "upload-generation": "9", "upload-length": "0" },
			})
		).status,
		400,
	);
	check(
		(
			await fetch(`${daemon.origin}/api/sources/imports/${job.id}/files/${file}/reset`, {
				method: "POST",
				headers: { ...headers, "upload-generation": "0" },
			})
		).status,
		200,
	);
	check(
		(
			await fetch(`${daemon.origin}/api/sources/imports/${job.id}/files/${file}/reset`, {
				method: "POST",
				headers: { ...headers, "upload-generation": "1" },
			})
		).status,
		200,
	);
	await stop(daemon.child);
	children.splice(children.indexOf(daemon.child), 1);
	daemon = await start(path, agent);
	check((await fetch(`${daemon.origin}/api/sources/imports/${job.id}`, { headers })).status, 200);
	for (const control of ["start", "pause", "resume", "retry", "cancel"])
		check(
			(await fetch(`${daemon.origin}/api/sources/imports/${job.id}/${control}`, { method: "POST", headers })).status,
			501,
		);
	for (const bad of ["not-json", JSON.stringify({ files: [] }), JSON.stringify({ files: [{ name: "x".repeat(513) }] })])
		check(
			(await fetch(`${daemon.origin}/api/sources/imports`, { method: "POST", headers, body: bad })).status >= 400,
			true,
		);
	check(
		(await fetch(`${daemon.origin}/api/sources/imports/${job.id}/files/${file}/content`, { headers: otherHeaders }))
			.status,
		404,
	);
	console.log(`native contract assertions=${assertions}`);
});

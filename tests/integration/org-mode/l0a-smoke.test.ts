import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { runMigrations } from "../../../platform/core/src/migrations";

function cookieToken(response: Response): string {
	return (
		response.headers
			.getSetCookie()
			.find((cookie) => cookie.startsWith("signet_session="))
			?.split(";")[0]
			?.slice("signet_session=".length) ?? ""
	);
}
const sessionSchema = z.object({ accessToken: z.string(), user: z.object({ id: z.string() }) });
async function freePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("No TCP port assigned");
	const port = address.port;
	await new Promise<void>((done, fail) => server.close((error) => (error ? fail(error) : done())));
	return port;
}
test("real team daemon claims, provisions a connector, writes attributed evidence, and revokes on the next request", async () => {
	const root = await mkdtemp(join(tmpdir(), "signet-org-l0a-smoke-"));
	const home = join(root, "home"),
		workspace = join(root, "workspace");
	await mkdir(home);
	await mkdir(join(workspace, "data"), { recursive: true });
	await writeFile(join(workspace, "workspace-layout.json"), JSON.stringify({ version: 2 }));
	await writeFile(
		join(workspace, "agent.yaml"),
		"configVersion: 9\nauth:\n  mode: team\nmemory:\n  embedding:\n    provider: none\n  pipelineV2:\n    enabled: false\n    shadowMode: false\n    dreaming:\n      enabled: false\n",
	);
	const db = new Database(join(workspace, "data", "signet.db"));
	runMigrations(db);
	db.prepare(
		"INSERT INTO daily_reflections (id,agent_id,date,summary,question,created_at) VALUES ('smoke-reflection','default','2026-11-25','Fixture','What did you learn?',?)",
	).run(new Date().toISOString());
	db.close();
	const port = await freePort();
	const base = `http://127.0.0.1:${port}`;
	const cwd = resolve(import.meta.dir, "../../../platform/daemon");
	const env = {
		...process.env,
		HOME: home,
		SIGNET_PATH: workspace,
		SIGNET_WORKSPACE: workspace,
		SIGNET_PORT: String(port),
		SIGNET_HOST: "127.0.0.1",
		SIGNET_BIND: "127.0.0.1",
		SIGNET_TELEMETRY_OPTOUT: "1",
		HERMES_HOME: join(home, ".hermes"),
		CODEX_HOME: join(home, ".codex"),
	};
	const child = Bun.spawn(["setsid", process.execPath, "src/daemon.ts"], { cwd, env, stdout: "pipe", stderr: "pipe" });
	let output = "";
	let errors = "";
	const consume = async (stream: ReadableStream<Uint8Array>, append: (text: string) => void) => {
		for await (const chunk of stream) append(new TextDecoder().decode(chunk));
	};
	const stdout = consume(child.stdout, (text) => {
		output = (output + text).slice(-200_000);
	});
	const stderr = consume(child.stderr, (text) => {
		errors = (errors + text).slice(-200_000);
	});
	let admin = "";
	async function request(path: string, method = "GET", body?: unknown, token = admin): Promise<Response> {
		return fetch(`${base}${path}`, {
			method,
			headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
			...(body ? { body: JSON.stringify(body) } : {}),
			signal: AbortSignal.timeout(30_000),
		});
	}
	try {
		let ready = false;
		const deadline = Date.now() + 60_000;
		while (Date.now() < deadline) {
			if (child.exitCode !== null) throw new Error(`Daemon exited ${child.exitCode}: ${errors}`);
			try {
				const response = await request("/health");
				if (response.ok) {
					const health = z.object({ pid: z.number(), agentsDir: z.string() }).parse(await response.json());
					expect(health.pid).toBe(child.pid);
					expect(health.agentsDir).toBe(workspace);
					ready = true;
					break;
				}
			} catch (error) {
				if (error instanceof z.ZodError) throw error;
			}
			await Bun.sleep(100);
		}
		if (!ready) throw new Error(`Daemon not ready: ${errors}`);
		while (!output.includes("Setup token:") && Date.now() < deadline) await Bun.sleep(100);
		const setup = output.match(/Setup token: ([A-Za-z0-9_-]+)/)?.[1];
		if (!setup) throw new Error("Setup token was not printed");
		const claim = await request(
			"/api/org/claim",
			"POST",
			{
				setupToken: setup,
				organizationName: "Smoke Org",
				admin: { username: "admin", displayName: "Admin", password: "disposable test password" },
			},
			"",
		);
		if (claim.status !== 200) throw new Error(`Claim returned ${claim.status}: ${await claim.text()}`);
		admin = cookieToken(claim);
		expect(admin.length).toBeGreaterThan(0);
		const invitation = await request("/api/org/invites", "POST", {
			email: "alice@example.test",
			role: "member",
			groupIds: [],
		});
		expect(invitation.status).toBe(201);
		const invite = z.object({ inviteUrl: z.string() }).parse(await invitation.json());
		const accepted = await request(
			"/api/auth/invites/accept",
			"POST",
			{
				token: new URL(invite.inviteUrl).pathname.split("/").pop(),
				username: "alice",
				displayName: "Alice",
				password: "disposable test password",
			},
			"",
		);
		expect(accepted.status).toBe(200);
		const alice = sessionSchema.parse({ ...(await accepted.json()), accessToken: cookieToken(accepted) });
		const started = await request(
			"/api/auth/device/start",
			"POST",
			{ client: "cli", deviceName: "Smoke laptop", platform: "linux" },
			"",
		);
		expect(started.status).toBe(200);
		const flow = z.object({ deviceCode: z.string(), userCode: z.string() }).parse(await started.json());
		expect(
			(
				await request(
					"/api/auth/device/approve",
					"POST",
					{ userCode: flow.userCode, decision: "approve" },
					alice.accessToken,
				)
			).status,
		).toBe(200);
		const polled = await request("/api/auth/device/token", "POST", { deviceCode: flow.deviceCode }, "");
		expect(polled.status).toBe(200);
		const cli = z.object({ accessToken: z.string(), deviceId: z.string() }).parse(await polled.json());
		const issued = await request(
			"/api/auth/connector-keys",
			"POST",
			{ harness: "hermes-agent", deviceId: cli.deviceId },
			cli.accessToken,
		);
		expect(issued.status).toBe(201);
		const key = z.object({ secret: z.string(), key: z.object({ agentId: z.string() }) }).parse(await issued.json());
		const rejectedBinding = await request(
			"/api/memory/remember",
			"POST",
			{ content: "forbidden smoke binding", agentId: "default" },
			key.secret,
		);
		expect(rejectedBinding.status).toBe(403);
		await rejectedBinding.text();
		const rejectedActor = await fetch(`${base}/api/memory/remember`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${key.secret}`,
				"x-signet-actor": "forged-user",
			},
			body: JSON.stringify({ content: "forbidden smoke actor", agentId: key.key.agentId }),
			signal: AbortSignal.timeout(30_000),
		});
		expect(rejectedActor.status).toBe(403);
		await rejectedActor.text();
		const saved = await request(
			"/api/memory/remember",
			"POST",
			{ content: "The smoke project uses a deterministic fixture.", agentId: key.key.agentId },
			key.secret,
		);
		if (saved.status !== 200) throw new Error(`Memory write returned ${saved.status}: ${await saved.text()}`);
		const memory = z.object({ id: z.string() }).parse(await saved.json());
		const csrf = accepted.headers
			.getSetCookie()
			.find((value) => value.startsWith("signet_csrf="))
			?.split(";")[0]
			?.slice("signet_csrf=".length);
		if (!csrf) throw new Error("Invite acceptance omitted CSRF cookie");
		const cookieHook = await fetch(`${base}/api/hooks/remember`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				cookie: accepted.headers
					.getSetCookie()
					.map((value) => value.split(";")[0])
					.join("; "),
				"x-signet-csrf": csrf,
			},
			body: JSON.stringify({ harness: "hermes-agent", content: "The cookie hook preserves principal attribution." }),
			signal: AbortSignal.timeout(30_000),
		});
		if (cookieHook.status !== 200)
			throw new Error(`Hook remember returned ${cookieHook.status}: ${await cookieHook.text()}`);
		expect(cookieHook.status).toBe(200);
		const hookMemory = z.object({ id: z.string() }).parse(await cookieHook.json());

		const textBypass = await fetch(`${base}/api/memory/remember`, {
			method: "POST",
			headers: { "content-type": "text/plain", authorization: `Bearer ${key.secret}` },
			body: JSON.stringify({ content: "forbidden smoke text", agentId: "default" }),
		});
		expect(textBypass.status).toBe(415);
		await textBypass.text();
		const reflected = await request(
			"/api/reflections/smoke-reflection/answer",
			"POST",
			{ answer: "The reflected answer belongs to Alice." },
			alice.accessToken,
		);
		if (reflected.status !== 200) throw new Error(`Reflection failed ${reflected.status}: ${await reflected.text()}`);
		const reflection = z.object({ memoryId: z.string() }).parse(await reflected.json());
		const compacted = await request(
			"/api/hooks/compaction-complete",
			"POST",
			{
				harness: "hermes-agent",
				summary: "Alice built deterministic fixtures and checked their durable attribution.",
				sessionKey: "smoke-compaction",
				runtimePath: "plugin",
			},
			key.secret,
		);
		if (compacted.status !== 200) throw new Error(`Compaction failed ${compacted.status}: ${await compacted.text()}`);
		await compacted.text();
		const observer = new Database(join(workspace, "data", "signet.db"), { readonly: true });
		try {
			const copy = observer.prepare("VACUUM INTO ?");
			copy.run(join(root, "before-purge.db"));
			copy.finalize();
		} finally {
			observer.close();
		}
		const beforePurge = new Database(join(root, "before-purge.db"), { readonly: true });
		try {
			for (const id of [memory.id, hookMemory.id, reflection.memoryId])
				expect(beforePurge.query("SELECT author_user_id,agent_id FROM memories WHERE id=?").get(id)).toEqual({
					author_user_id: alice.user.id,
					agent_id: key.key.agentId,
				});
			expect(
				beforePurge.query("SELECT author_user_id FROM session_summaries WHERE session_key='smoke-compaction'").get(),
			).toEqual({ author_user_id: alice.user.id });
			expect(
				beforePurge
					.query(
						"SELECT COUNT(*) AS n FROM memory_artifacts WHERE session_key='smoke-compaction' AND author_user_id IS NULL",
					)
					.get(),
			).toEqual({ n: 0 });
		} finally {
			beforePurge.close();
		}
		const uploadPath = join(root, "cli-upload.jsonl");
		const uploadBytes = new TextEncoder().encode(
			JSON.stringify({
				id: "cli-smoke",
				source: "signet",
				harness: "hermes-agent",
				agent_id: key.key.agentId,
				session_key: "cli-smoke-upload",
				project: null,
				timestamp: new Date().toISOString(),
				message_count: 1,
				messages: [{ role: "user", content: "u".repeat(1024 * 1024 + 17) }],
			}) + "\n",
		);
		await writeFile(uploadPath, uploadBytes);
		const uploadCreated = await request(
			`/api/sources/imports?agentId=${key.key.agentId}`,
			"POST",
			{ files: [{ name: "cli-upload.jsonl" }] },
			key.secret,
		);
		expect(uploadCreated.status).toBe(201);
		const upload = z
			.object({ jobId: z.string(), files: z.array(z.object({ id: z.string() })) })
			.parse(await uploadCreated.json());
		const uploadFile = upload.files[0];
		if (!uploadFile) throw new Error("Upload file slot missing");
		const uploader = Bun.spawn(
			[
				process.execPath,
				resolve(cwd, "../../surfaces/cli/src/cli.ts"),
				"sources",
				"imports",
				"upload",
				upload.jobId,
				uploadFile.id,
				uploadPath,
				"--agent",
				key.key.agentId,
			],
			{
				cwd,
				env: { ...env, SIGNET_DAEMON_URL: base, SIGNET_API_KEY: key.secret, SIGNET_TOKEN: "" },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [uploadExit, uploadOut, uploadErr] = await Promise.all([
			uploader.exited,
			new Response(uploader.stdout).text(),
			new Response(uploader.stderr).text(),
		]);
		if (uploadExit !== 0) throw new Error(`CLI upload exited ${uploadExit}: ${uploadOut} ${uploadErr}`);
		expect(uploadExit).toBe(0);
		const uploadStatus = await request(
			`/api/sources/imports/${upload.jobId}?agentId=${key.key.agentId}`,
			"GET",
			undefined,
			key.secret,
		);
		expect(uploadStatus.status).toBe(200);
		const uploaded = z
			.object({
				files: z.array(
					z.object({
						id: z.string(),
						upload_offset: z.number(),
						upload_size: z.number().nullable(),
						upload_digest: z.string(),
						state: z.string(),
					}),
				),
			})
			.parse(await uploadStatus.json())
			.files.find((file) => file.id === uploadFile.id);
		expect(uploaded?.upload_offset).toBe(uploadBytes.byteLength);
		expect(uploaded?.upload_size).toBe(uploadBytes.byteLength);
		expect(uploaded?.upload_digest.length).toBe(64);
		expect(uploaded?.state).not.toBe("staging");
		console.log(
			JSON.stringify({
				probe: "cli-chunk-upload",
				exit: uploadExit,
				bytes: uploadBytes.byteLength,
				chunks: Math.ceil(uploadBytes.byteLength / (1024 * 1024)),
				offset: uploaded?.upload_offset,
				state: uploaded?.state,
			}),
		);
		const deactivated = await request(`/api/org/users/${alice.user.id}/deactivate`, "POST", {
			mode: "keep",
			dryRun: false,
		});
		expect(deactivated.status).toBe(202);
		const next = await request("/api/auth/connector-keys", "GET", undefined, key.secret);
		expect(next.status).toBe(401);
		await next.text();
		const purged = await request(`/api/org/users/${alice.user.id}/deactivate`, "POST", {
			mode: "purge",
			dryRun: false,
		});
		expect(purged.status).toBe(202);
		const purge = z.object({ jobId: z.string() }).parse(await purged.json());
		let purgeStatus: unknown;
		const purgeDeadline = Date.now() + 30000;
		do {
			const response = await request(`/api/org/jobs/${purge.jobId}`);
			purgeStatus = await response.json();
			if (z.object({ status: z.string() }).parse(purgeStatus).status !== "running") break;
			await Bun.sleep(50);
		} while (Date.now() < purgeDeadline);
		const finalPurge = z
			.object({ status: z.string(), progress_json: z.string(), error: z.string().nullable() })
			.parse(purgeStatus);
		if (finalPurge.status !== "complete") throw new Error(`Purge incomplete: ${JSON.stringify(finalPurge)}`);
		const progress = z
			.object({ residual: z.record(z.string(), z.number()), removed: z.record(z.string(), z.number()) })
			.parse(JSON.parse(finalPurge.progress_json));
		const residual = progress.residual;
		expect(progress.removed.session_summaries).toBeGreaterThan(0);
		expect(Object.values(residual).every((n) => n === 0)).toBe(true);

		console.log(
			JSON.stringify({
				probe: "l0a",
				claim: claim.status,
				invite: invitation.status,
				device: polled.status,
				connector: issued.status,
				memory: saved.status,
				hookRemember: cookieHook.status,
				deactivate: deactivated.status,
				nextRequest: next.status,
				textBypass: textBypass.status,
				reflection: reflected.status,
				compaction: compacted.status,
				purge: finalPurge.status,
				residual,
			}),
		);
		const auditedRead = await request("/api/auth/sessions");
		expect(auditedRead.status).toBe(200);
		await auditedRead.text();
		const children = (await readFile(`/proc/${child.pid}/task/${child.pid}/children`, "utf8"))
			.trim()
			.split(/\s+/)
			.filter(Boolean)
			.map(Number);
		const ownerPids: number[] = [];
		for (const pid of children) {
			if ((await readFile(`/proc/${pid}/cmdline`, "utf8")).includes("db-owner-worker")) ownerPids.push(pid);
		}
		expect(ownerPids.length).toBeGreaterThan(0);
		const shutdownAt = Date.now();
		process.kill(child.pid, "SIGTERM");
		await Promise.race([
			child.exited,
			Bun.sleep(25_000).then(() => {
				throw new Error(
					`Daemon did not shut down: ${errors.slice(-5000)} ${output
						.split("\n")
						.filter((line) => /shut|stopp|exit|clos|flush|error|warn/i.test(line) && !/token|setup/i.test(line))
						.slice(-20)
						.join("\n")}`,
				);
			}),
		]);
		await Promise.all([stdout, stderr]);
		expect(output.includes("Shutdown cleanup timed out")).toBe(false);
		expect(output.includes("HTTP server drain timed out")).toBe(false);
		expect(output.includes("Audit maintenance failed")).toBe(false);
		if (output.includes("Shutdown cleanup failed"))
			console.error(
				output
					.split("\n")
					.filter((line) => /error|failed|locked|retryable/i.test(line) && !/token|setup/i.test(line))
					.slice(-15)
					.join("\n"),
			);
		expect(output.includes("Shutdown cleanup failed")).toBe(false);
		expect(child.exitCode).toBe(0);
		for (const pid of [child.pid, ...ownerPids]) {
			expect(() => process.kill(pid, 0)).toThrow();
		}
		console.log(
			JSON.stringify({ shutdownMs: Date.now() - shutdownAt, daemonGone: true, ownersGone: ownerPids.length }),
		);
		const snapshot = new Database(join(workspace, "data", "signet.db"), { readonly: true });
		try {
			expect(
				snapshot
					.query(
						"SELECT COUNT(*) AS n FROM audit_events WHERE action = 'content.read' AND target_id = '/api/auth/sessions'",
					)
					.get(),
			).toEqual({ n: 1 });
			expect(snapshot.query("SELECT COUNT(*) AS n FROM memories WHERE content LIKE 'forbidden smoke%'").get()).toEqual({
				n: 0,
			});
			expect(snapshot.query("SELECT COUNT(*) AS n FROM memories WHERE author_user_id=?").get(alice.user.id)).toEqual({
				n: 0,
			});
		} finally {
			snapshot.close();
		}
	} finally {
		if (child.exitCode === null) {
			process.kill(-child.pid, "SIGTERM");
			await Promise.race([child.exited, Bun.sleep(5000)]);
			if (child.exitCode === null) {
				process.kill(-child.pid, "SIGKILL");
				await child.exited;
			}
		}
		await Promise.all([stdout, stderr]);
		await rm(root, { recursive: true, force: true });
	}
}, 120_000);

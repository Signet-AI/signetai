import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceSocketPath } from "../../../platform/core/src/local-endpoint";
import { OrgDaemon, repo } from "./daemon";
import { Fixture, device } from "./fixture";
import { record, request, success, until } from "./http";

function socketRequest(
	socketPath: string,
	path: string,
	method = "GET",
	body?: object,
): Promise<{ status: number; body: unknown }> {
	return new Promise((resolve, reject) => {
		const req = httpRequest({ socketPath, path, method, headers: { "content-type": "application/json" } }, (res) => {
			let text = "";
			res.setEncoding("utf8");
			res.on("data", (chunk: string) => {
				text += chunk;
			});
			res.on("end", () => {
				try {
					resolve({
						status: res.statusCode ?? 0,
						body: res.headers["content-type"]?.includes("application/json") && text ? JSON.parse(text) : text,
					});
				} catch (error) {
					reject(error);
				}
			});
			res.on("error", reject);
		});
		const deadline = setTimeout(() => req.destroy(new Error("Socket request deadline")), 10000);
		req.once("close", () => clearTimeout(deadline));
		req.on("error", reject);
		req.end(body ? JSON.stringify(body) : undefined);
	});
}

test("claimed org host operations authenticate over socket, never forged TCP headers", async () => {
	const daemon = await OrgDaemon.create();
	const runtime = await mkdtemp(join(tmpdir(), ""));
	try {
		const fixture = await Fixture.create(daemon, "personal", false);
		const admin = await device(daemon, fixture.admin, "socket-proof");
		daemon.env.XDG_RUNTIME_DIR = runtime;
		await daemon.restart();
		const health = record((await request(daemon.origin, "/health")).body);
		expect(record(health.localEndpoint).status).toBe("available");
		const socket = workspaceSocketPath(daemon.workspace, daemon.env);
		const cli = async (args: readonly string[], expectedCode = 0) => {
			const env = { ...daemon.env };
			delete env.SIGNET_DAEMON_ENTRYPOINT;
			const child = Bun.spawn([process.execPath, join(repo, "surfaces/cli/src/cli.ts"), "--local", ...args], {
				cwd: repo,
				env,
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, code] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			expect(code, `${stderr}\n${stdout}`).toBe(expectedCode);
			return expectedCode === 0 ? stdout : stderr;
		};
		expect(record(JSON.parse(await cli(["daemon", "status", "--json"]))).transport).toBe("socket");
		await cli(["git", "status"]);
		await cli(["graphiq", "status"]);
		const listed = record(JSON.parse(await cli(["org", "remote-features", "list", "--json"])));
		expect(Array.isArray(listed.features)).toBe(true);
		expect(
			Array.isArray(listed.features) && listed.features.every((feature: unknown) => record(feature).allowed === false),
		).toBe(true);
		const local = await socketRequest(socket, "/api/git/config");
		expect(local.status).toBe(200);
		for (const credential of [{}, admin.credential]) {
			const forged = await request(daemon.origin, "/api/git/config", credential, "GET", undefined, {
				"x-signet-principal": "local",
				"x-signet-local": "true",
				"x-signet-local-origin": "true",
			});
			expect(forged.status).toBe(credential === admin.credential ? 403 : 401);
		}
		const missingAgent = await socketRequest(socket, "/api/memory/remember", "POST", {
			content: "No implicit default",
		});
		expect(missingAgent.status).toBe(403);
		expect(record(missingAgent.body).reason).toBe("agent_required");
		const carol = fixture.user("carol");
		const remembered = success(
			await request(daemon.origin, "/api/memory/remember", carol.session, "POST", {
				agentId: carol.agentId,
				content: "socket classified proof",
			}),
			"remember",
		);
		const memoryId = String(remembered.id ?? record(remembered.memory).id);
		expect((await socketRequest(socket, `/api/memory/${memoryId}?agent_id=${carol.agentId}`)).status).toBe(200);
		const localWrite = await socketRequest(socket, "/api/memory/remember", "POST", {
			agentId: carol.agentId,
			content: "explicit local writer proof",
		});
		expect(localWrite.status >= 200 && localWrite.status < 300).toBe(true);
		const localRecord = record(localWrite.body);
		const localId = String(localRecord.id ?? record(localRecord.memory).id);
		const localReadback = await socketRequest(socket, `/api/memory/${localId}?agent_id=${carol.agentId}`);
		expect(localReadback.status).toBe(200);
		expect(JSON.stringify(localReadback.body)).toContain("explicit local writer proof");
		await fixture.classify("memory", memoryId, carol.agentId);
		const hidden = await socketRequest(socket, `/api/memory/${memoryId}?agent_id=${carol.agentId}`);
		const absent = await socketRequest(socket, `/api/memory/missing?agent_id=${carol.agentId}`);
		expect(hidden.status).toBe(404);
		expect(hidden.body).toEqual(absent.body);
		const remoteBefore = await request(daemon.origin, "/api/git/config", admin.credential);
		expect(remoteBefore.status).toBe(403);
		const toggle = "/api/org/remote-features/git.sync";
		expect((await request(daemon.origin, toggle, admin.credential, "POST", { allow: true })).status).toBe(403);
		await cli(["org", "remote-features", "allow", "git.sync", "--json"]);
		expect((await request(daemon.origin, "/api/git/config", admin.credential)).status).toBe(200);
		expect((await socketRequest(socket, toggle, "POST", { allow: true })).status).toBe(200);
		expect((await request(daemon.origin, "/api/git/config", admin.credential)).status).toBe(200);
		expect((await socketRequest(socket, "/api/org/remote-features/config.apply", "POST", { allow: true })).status).toBe(
			200,
		);
		expect(
			(
				await request(daemon.origin, "/api/config", admin.credential, "POST", {
					file: "agent.yaml",
					content: "auth:\n  mode: local\n",
				})
			).status,
		).toBe(400);
		expect(
			(
				await request(daemon.origin, "/api/config", admin.credential, "POST", {
					section: "instructions",
					value: "host opt-in instructions",
				})
			).status,
		).toBe(200);
		const settings = success(
			await request(daemon.origin, "/api/org/operator/settings", admin.credential),
			"settings readback",
		);
		expect(settings.instructions).toBe("host opt-in instructions");
		expect((await request(daemon.origin, "/api/git/config", carol.session)).status).toBe(403);
		const key = success(
			await request(daemon.origin, "/api/auth/api-keys", admin.credential, "POST", {
				name: "host-ceiling",
				permissions: ["recall"],
				expiresAt: new Date(Date.now() + 300_000).toISOString(),
			}),
			"low permission key",
		);
		expect((await request(daemon.origin, "/api/git/config", { bearer: String(key.secret) })).status).toBe(403);
		if (!Array.isArray(listed.features)) throw new Error("Missing feature list");
		for (const feature of listed.features) {
			const name: unknown = record(feature).name;
			if (typeof name !== "string") throw new Error("Invalid feature name");
			expect(
				(await socketRequest(socket, `/api/org/remote-features/${encodeURIComponent(name)}`, "POST", { allow: true }))
					.status,
			).toBe(200);
		}
		const allAllowed = success(
			await request(daemon.origin, "/api/org/remote-features", admin.credential),
			"all feature policy readback",
		);
		expect(
			Array.isArray(allAllowed.features) &&
				allAllowed.features.every((feature: unknown) => record(feature).allowed === true),
		).toBe(true);
		expect((await socketRequest(socket, "/api/org/remote-features/never-remote", "POST", { allow: true })).status).toBe(
			400,
		);
		success(
			await request(daemon.origin, "/api/secrets/OPX_SOCKET", admin.credential, "POST", { value: "fixture" }),
			"create socket exec fixture",
		);
		expect(
			(
				await request(daemon.origin, "/api/secrets/exec", admin.credential, "POST", {
					command: `cp ${daemon.workspace}/data/signet.db ${daemon.root}/pwned-marker`,
					secrets: { OPX: "OPX_SOCKET" },
				})
			).status,
		).toBe(403);
		expect(await Bun.file(join(daemon.root, "pwned-marker")).exists()).toBe(false);
		const hostMarker = join(daemon.root, "socket-host-marker");
		const execution = await socketRequest(socket, "/api/secrets/exec", "POST", {
			command: `touch ${hostMarker}`,
			secrets: { OPX: "OPX_SOCKET" },
		});
		expect(execution.status).toBe(202);
		const jobId = record(execution.body).id;
		if (typeof jobId !== "string") throw new Error("Missing local execution job");
		await until(async () => {
			const status = await socketRequest(socket, `/api/secrets/exec/${encodeURIComponent(jobId)}`);
			expect(status.status).toBe(200);
			const job = record(status.body);
			if (job.status !== "completed") return false;
			expect(record(job.result).code).toBe(0);
			return true;
		}, "socket host command completion");
		expect(await Bun.file(hostMarker).exists()).toBe(true);
		const audit = success(
			await request(daemon.origin, "/api/org/audit?action=local.request", admin.credential),
			"audit",
		);
		expect(JSON.stringify(audit)).toContain("GET /api/graphiq/status");
		expect(JSON.stringify(audit)).toContain(`local:${process.getuid?.()}:`);
		await daemon.restart();
		expect((await request(daemon.origin, "/api/git/config", admin.credential)).status).toBe(200);
		await cli(["org", "remote-features", "deny", "git.sync", "--json"]);
		expect((await request(daemon.origin, "/api/git/config", admin.credential)).status).toBe(403);
		expect((await socketRequest(socket, toggle, "POST", { allow: false })).status).toBe(200);
		expect((await request(daemon.origin, "/api/git/config", admin.credential)).status).toBe(403);
		expect((await socketRequest(socket, "/api/git/config")).status).toBe(200);
	} catch (error) {
		throw new Error(`${daemon.stderr}\n${daemon.stdout}`, { cause: error });
	} finally {
		await daemon.dispose();
		await rm(runtime, { recursive: true, force: true });
	}
}, 60_000);

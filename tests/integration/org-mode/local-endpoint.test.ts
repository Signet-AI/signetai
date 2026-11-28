import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceSocketPath } from "../../../platform/core/src/local-endpoint";
import { OrgDaemon } from "./daemon";
import { Fixture, device } from "./fixture";
import { record, request, success } from "./http";

export function socketRequest(
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
			res.on("end", () =>
				resolve({
					status: res.statusCode ?? 0,
					body: res.headers["content-type"]?.includes("application/json") && text ? JSON.parse(text) : text,
				}),
			);
		});
		req.setTimeout(10000, () => req.destroy(new Error("Socket request deadline")));
		req.on("error", reject);
		req.end(body ? JSON.stringify(body) : undefined);
	});
}

test("claimed org host operations authenticate over socket, never forged TCP headers", async () => {
	const daemon = await OrgDaemon.create();
	const runtime = await mkdtemp(join(tmpdir(), "s"));
	try {
		const fixture = await Fixture.create(daemon, "personal", false);
		const admin = await device(daemon, fixture.admin, "socket-proof");
		daemon.env.XDG_RUNTIME_DIR = runtime;
		await daemon.restart();
		const health = record((await request(daemon.origin, "/health")).body);
		expect(record(health.localEndpoint).status).toBe("available");
		const socket = workspaceSocketPath(daemon.workspace, daemon.env);
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
		await fixture.classify("memory", memoryId, carol.agentId);
		const hidden = await socketRequest(socket, `/api/memory/${memoryId}?agent_id=${carol.agentId}`);
		const absent = await socketRequest(socket, `/api/memory/missing?agent_id=${carol.agentId}`);
		expect(hidden.status).toBe(404);
		expect(hidden.body).toEqual(absent.body);
		const audit = success(await request(daemon.origin, "/api/org/audit", admin.credential), "audit");
		expect(JSON.stringify(audit)).toContain(`local:${process.getuid?.()}:`);
		await daemon.restart();
		expect((await socketRequest(socket, "/api/git/config")).status).toBe(200);
	} catch (error) {
		throw new Error(`${daemon.stderr}\n${daemon.stdout}`, { cause: error });
	} finally {
		await daemon.dispose();
		await rm(runtime, { recursive: true, force: true });
	}
}, 60_000);

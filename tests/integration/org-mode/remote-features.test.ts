import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { HOST_FEATURES, NEVER_REMOTE_ROUTES, type HostFeature } from "../../../platform/daemon/src/host-features";
import { sourceBody } from "./host-gap-cases";
import { HostFixture, fixtureAnswer, rows } from "./host-fixture";
import { record, success, text, type Credential, type Reply } from "./http";

interface FeatureCase {
	name: HostFeature;
	path: string;
	method?: string;
	body?: object;
	verify(reply: Reply): Promise<void>;
}

test("all twelve remote host features enforce the complete operator-controlled lifecycle", async () => {
	const host = await HostFixture.create();
	let connectorId: string | undefined;
	try {
		const admin = host.identity.user("audra");
		const member = host.identity.user("bob");
		const issued = success(
			await host.tcp("/api/auth/api-keys", admin.session, "POST", {
				name: "host-feature-ceiling",
				permissions: ["recall"],
				expiresAt: new Date(Date.now() + 300_000).toISOString(),
			}),
			"low-permission admin key",
		);
		const low: Credential = { bearer: text(issued.secret) };
		await mkdir(join(host.daemon.home, ".codex"), { recursive: true });
		await writeFile(join(host.daemon.home, ".codex/config.toml"), 'model = "host-fixture"\n');
		const connectorRoot = join(host.daemon.root, "remote-connector");
		await mkdir(connectorRoot);
		connectorId = text(
			success(
				await host.local("/api/connectors", "POST", { provider: "filesystem", settings: { rootPath: connectorRoot } }),
				"remote connector fixture",
			).id,
		);
		const readback = (reply: Reply) => {
			expect(reply.status, JSON.stringify(reply.body)).toBe(200);
			return record(reply.body);
		};
		const featureCases: FeatureCase[] = [
			{
				name: "sources.filesystem",
				path: "/api/connectors",
				verify: async (reply) => {
					const value = readback(reply);
					expect(rows(value.connectors).some((row) => row.id === connectorId)).toBe(true);
				},
			},
			{
				name: "git.sync",
				path: "/api/git/config",
				verify: async (reply) => {
					const value = readback(reply);
					expect(value.remote).toBe("origin");
					expect(value.branch).toBe("main");
				},
			},
			{
				name: "plugins.manage",
				path: "/api/plugins",
				verify: async (reply) => {
					expect(rows(readback(reply).plugins).some((row) => row.id === "signet.secrets" && row.enabled === true)).toBe(
						true,
					);
				},
			},
			{
				name: "secrets.providers",
				path: "/api/secrets/bitwarden/status",
				verify: async (reply) => {
					const value = readback(reply);
					expect(value.configured).toBe(false);
					expect(value.connected).toBe(false);
				},
			},
			{
				name: "skills.manage",
				path: "/api/skills",
				verify: async (reply) => {
					expect(reply.status).toBe(200);
					expect(JSON.stringify(reply.body)).toContain("host-fixture");
				},
			},
			{
				name: "graphiq.manage",
				path: "/api/graphiq/status",
				verify: async (reply) => {
					const value = readback(reply);
					expect(value.installed).toBe(true);
					expect(value.activeProject).toBe(null);
				},
			},
			{
				name: "daemon.update",
				path: "/api/update/config",
				verify: async (reply) => {
					const value = readback(reply);
					expect(value.updateInProgress).toBe(false);
					expect(typeof value.minInterval).toBe("number");
				},
			},
			{
				name: "inference.local",
				path: "/api/inference/execute",
				method: "POST",
				body: { agentId: admin.agentId, prompt: "Host fixture remote prompt." },
				verify: async (reply) => {
					expect(reply.status, JSON.stringify(reply.body)).toBe(200);
					expect(record(reply.body).text).toBe(fixtureAnswer);
				},
			},
			{
				name: "harness.repair",
				path: "/api/harnesses/codex/repair",
				method: "POST",
				body: {},
				verify: async (reply) => {
					expect(reply.status, JSON.stringify(reply.body)).toBe(200);
					expect(record(reply.body).success).toBe(true);
					expect(await readFile(join(host.daemon.home, ".codex/config.toml"), "utf8")).toContain("signet");
				},
			},
			{
				name: "config.apply",
				path: "/api/config",
				method: "POST",
				body: { section: "instructions", value: "Host fixture remote instructions." },
				verify: async (reply) => {
					expect(reply.status, JSON.stringify(reply.body)).toBe(200);
					expect(record((await host.tcp("/api/org/operator/settings", admin.session)).body).instructions).toBe(
						"Host fixture remote instructions.",
					);
				},
			},
		];
		for (const kind of ["github", "discord"] as const)
			featureCases.push({
				name: `sources.${kind}`,
				path: `/api/sources/${kind}`,
				method: "POST",
				body: { ...(await sourceBody(host, kind)), agentId: admin.agentId },
				async verify(reply) {
					expect(reply.status, JSON.stringify(reply.body)).toBe(202);
					const source = record(record(reply.body).source);
					expect(source.kind).toBe(kind);
					expect(source.agentId).toBe(admin.agentId);
					const readback = success(
						await host.tcp(`/api/sources?agentId=${admin.agentId}`, admin.session),
						"remote source readback",
					);
					expect(rows(readback.sources).some((row) => row.id === source.id)).toBe(true);
				},
			});
		expect(featureCases.map((entry) => entry.name).sort()).toEqual([...HOST_FEATURES].sort());
		const invoke = (entry: FeatureCase, credential = admin.session) => {
			const body =
				entry.body && Object.hasOwn(entry.body, "agentId")
					? { ...entry.body, agentId: credential === member.session ? member.agentId : admin.agentId }
					: entry.body;
			return host.tcp(entry.path, credential, entry.method ?? "GET", body);
		};
		const ceiling = async (entry: FeatureCase, credential: Credential) => {
			const reply = await invoke(entry, credential);
			expect(reply.status, entry.name).toBe(403);
			expect(record(reply.body).reason, `${entry.name} is denied by the host permission ceiling`).toBe(
				"host_operation_local_only",
			);
		};
		const policy = async (feature: HostFeature, allow: boolean) => {
			const response = await host.local(`/api/org/remote-features/${feature}`, "POST", { allow });
			expect(response.status, JSON.stringify(response.body)).toBe(200);
			const current = success(await host.tcp("/api/org/remote-features", admin.session), "policy readback");
			expect(rows(current.features).find((row) => row.name === feature)?.allowed).toBe(allow);
		};
		for (const entry of featureCases) {
			expect((await invoke(entry)).status, `${entry.name} default denial`).toBe(403);
			for (const credential of [admin.session, member.session, low])
				expect(
					(await host.tcp(`/api/org/remote-features/${entry.name}`, credential, "POST", { allow: true })).status,
				).toBe(403);
			await policy(entry.name, true);
			await entry.verify(await invoke(entry));
			for (const credential of [member.session, low]) await ceiling(entry, credential);
		}
		for (const signature of NEVER_REMOTE_ROUTES) {
			const [method, pattern] = signature.split(" ");
			assert(method && pattern);
			const path = pattern.replace(":jobId", "fixture-job").replace(":name", "HOST_MODEL");
			const body = {
				agentId: admin.agentId,
				harness: "claude-code",
				sessionKey: "never-remote-fixture",
				transcriptPath: join(host.daemon.root, "never-remote.jsonl"),
				paths: [join(host.daemon.root, "never-remote.jsonl")],
				command: "false",
				secrets: { HOST_MODEL: "HOST_MODEL" },
			};
			const invokeNeverRemote = async () => {
				if (path !== "/api/sources/import")
					return host.tcp(path, admin.session, method, method === "GET" ? undefined : body);
				const form = new FormData();
				form.append("paths", join(host.daemon.root, "never-remote.jsonl"));
				const response = await fetch(`${host.daemon.origin}${path}`, {
					method,
					headers: { authorization: `Bearer ${text(admin.session.bearer)}`, "x-signet-agent-id": admin.agentId },
					body: form,
				});
				return { status: response.status, body: await response.json() };
			};
			const before = await invokeNeverRemote();
			expect(before.status, signature).toBe(403);
			expect(record(before.body).reason, signature).toBe("host_operation_local_only");
			expect(
				(await host.local(`/api/org/remote-features/${encodeURIComponent(signature)}`, "POST", { allow: true })).status,
			).toBe(400);
			expect((await invokeNeverRemote()).status).toBe(403);
		}
		expect((await host.local("/api/org/remote-features/never-remote", "POST", { allow: true })).status).toBe(400);
		await host.daemon.restart();
		for (const entry of featureCases) {
			await entry.verify(await invoke(entry));
			for (const credential of [member.session, low]) await ceiling(entry, credential);
			await policy(entry.name, false);
			expect((await invoke(entry)).status, `${entry.name} denied again`).toBe(403);
		}
		await host.daemon.restart();
		for (const entry of featureCases)
			expect((await invoke(entry)).status, `${entry.name} denial persists after restart`).toBe(403);
		const audit = await host.tcp("/api/org/audit?action=host.remote_request&limit=100", admin.session);
		expect(audit.status).toBe(200);
		for (const entry of featureCases)
			expect(JSON.stringify(audit.body), `${entry.name} audit visibility`).toContain(entry.name);
		console.info("REMOTE_FEATURE_LIFECYCLES_PROVEN", JSON.stringify(featureCases.map((entry) => entry.name).sort()));
	} finally {
		try {
			if (connectorId) success(await host.local(`/api/connectors/${connectorId}`, "DELETE"), "remote connector undo");
		} finally {
			await host.dispose();
		}
	}
}, 60_000);
